import { z } from "zod";
import { type PersonalConfig, type PersonalStage } from "../../shared/personal-file";
import { HttpError } from "../errors";
import { createNativeClient, NativeHttpError, type Credential, type NativeTransport } from "./native";
import { sourceDefinition } from "./native";
import { canonical, type PersonalStore } from "./store";

export function createPersonalWorkflow(store: PersonalStore, config: PersonalConfig, credential: Credential, transport?: NativeTransport) {
  return async (id: string, stage: PersonalStage, question?: string) => {
    if (store.plan(id).stage !== stage) throw new HttpError(403, "Operation stage does not match the requested action");
    const plan = store.acquire(id, config), client = createNativeClient(config, store, plan, credential, transport);
    const initialState = store.snapshot()!.state;
    let success = false;
    const snapshot = () => store.snapshot()!;
    const bindSource = async () => {
      const source = await client.source();
      if (snapshot().sourceEtag !== source.etag || snapshot().indexName !== source.index)
        throw new HttpError(409, "Source/index binding changed; generate a new reviewed plan");
      return source;
    };
    const inventory = async (onlyIndexed = false) => {
      const actual = await client.inventory(), expected = snapshot().documents.filter((document) => !onlyIndexed || document.state === "indexed");
      if (actual.length !== expected.length || expected.some((document) => {
        const matches = actual.filter((file) => file.fileId === document.nativeFileId);
        const file = matches[0], metadata = file?.metadata;
        return matches.length !== 1 || file.fileName !== document.path || file.fileSizeBytes !== document.size || file.errorMessage ||
          !metadata || typeof metadata !== "object" || !("jevboxDocumentId" in metadata) || metadata.jevboxDocumentId !== document.id ||
          !("jevboxSnapshot" in metadata) || metadata.jevboxSnapshot !== plan.snapshotId;
      })) throw new HttpError(409, "Native file inventory no longer equals the approved immutable snapshot");
    };
    const ready = async () => {
      if (snapshot().state !== "ready") throw new HttpError(409, "A complete verified KB is required");
      await client.verifyModels();
      await bindSource(); await inventory();
      const kb = await client.kb();
      if (kb.etag !== snapshot().kbEtag) throw new HttpError(409, "KB version changed");
    };
    try {
      if (stage === "ingest") {
        if (snapshot().documents.some((file) => file.state === "sending" || file.state === "uncertain" || file.state === "failed"))
          throw new HttpError(409, "An uncertain/failed attempt cannot be replayed; original journals require owner reconciliation");
        if (plan.mode === "create" && (snapshot().state !== "local" || snapshot().documents.some((file) => file.state !== "local")))
          throw new HttpError(409, "This is not a never-attempted snapshot");
        const probe = snapshot().documents.find((file) => file.path.split("/").at(-1) === "cu-mi-probe.pdf");
        if (!probe || snapshot().documents.length !== 7) throw new HttpError(409, "The first demo requires six reviewed Cedar originals plus the disclosed OCR probe");
        let source;
        if (plan.mode === "continue") {
          const original = store.db.prepare("SELECT j.body,o.plan FROM journal j JOIN operations o ON o.id=j.operation_id WHERE o.snapshot_id=? AND j.event='source-created' ORDER BY j.sequence LIMIT 1").get(plan.snapshotId);
          if (!original) throw new HttpError(409, "Original creation provenance is missing; do not reconstruct it");
          const ack = z.object({ requestId: z.string().min(1), etag: z.string().min(1), definition: z.unknown() }).parse(JSON.parse(String(original.body)));
          const originalPlan = store.plan(z.object({ id: z.string() }).parse(JSON.parse(String(original.plan))).id);
          if (canonical(ack.definition) !== canonical(sourceDefinition(config)) ||
              canonical(originalPlan.manifest) !== canonical(plan.manifest) || originalPlan.config.ownerOid !== config.ownerOid ||
              originalPlan.config.tenantId !== config.tenantId || originalPlan.config.searchEndpoint !== config.searchEndpoint)
            throw new HttpError(409, "Continuation differs from authoritative original source/corpus ownership");
          for (const file of snapshot().documents) {
            const attempts = store.db.prepare("SELECT j.event,j.body FROM journal j JOIN operations o ON o.id=j.operation_id WHERE o.snapshot_id=? AND j.event IN ('upload-intent','upload-confirmed')").all(plan.snapshotId)
              .filter((row) => z.object({ documentId: z.string() }).parse(JSON.parse(String(row.body))).documentId === file.id);
            if (file.state === "local" && attempts.length || file.state === "indexed" &&
                (attempts.filter((row) => row.event === "upload-intent").length !== 1 || attempts.filter((row) => row.event === "upload-confirmed").length !== 1))
              throw new HttpError(409, "Original upload journal does not prove this ordinal is never attempted or completely acknowledged");
          }
          await client.verifyModels();
          source = await client.source();
          if (source.etag !== ack.etag) throw new HttpError(409, "Original source version changed; no continuation");
        } else {
          await client.verifyModels();
          source = await client.createSource();
        }
        store.setSnapshot("ingesting");
        store.db.prepare("UPDATE snapshots SET index_name=?,source_etag=?,config_digest=? WHERE id=?").run(source.index, source.etag, plan.configDigest, plan.snapshotId);
        await inventory(true);
        const definition = await client.schema(source.index);
        store.journal(plan, "index-schema", definition);
        if (!definition.fields.some((field) => field.type === "Collection(Edm.Single)" && field.dimensions === config.embedding.dimensions))
          throw new HttpError(502, "Generated index vector dimensions do not match the approved embedding deployment");
        const documents = [probe, ...snapshot().documents.filter((file) => file.id !== probe.id)];
        for (const document of documents) {
          const fileId = document.state === "indexed" ? document.nativeFileId! : await client.upload(document.id, source.etag);
          if (document.state !== "indexed") store.setDocument(document.id, "indexed", fileId);
          if (document.id === probe.id) {
            const evidence = await client.inspect(source.index, fileId);
            if (!evidence.values.some((value) => typeof value.snippet === "string" && value.snippet.includes("CUOCR34298637") && value.snippet_parent_id === fileId))
              throw new HttpError(502, "Raster-only OCR marker is not verified against the actual uploaded native file");
            store.journal(plan, "main-ocr-verified", { documentId: probe.id, fileId, index: source.index });
          }
        }
        await bindSource(); await inventory();
        const statistics = await client.statistics(source.index);
        store.journal(plan, "index-statistics", statistics);
        if (statistics.documentCount < snapshot().documents.length)
          throw new HttpError(502, "Index statistics do not yet confirm the nonempty originals; partial state retained without automatic retry");
        await client.verifyModels();
        store.setSnapshot("indexed");
      } else if (stage === "kb") {
        if (snapshot().state !== "indexed") throw new HttpError(409, "Complete verified ingestion is required before KB creation");
        await client.verifyModels();
        await bindSource(); await inventory();
        const kb = await client.createKb();
        await client.verifyModels();
        store.db.prepare("UPDATE snapshots SET kb_etag=?,state='ready',error=NULL WHERE id=?").run(kb.etag, plan.snapshotId);
      } else if (stage === "chat") {
        const text = z.string().trim().min(1).max(4000).parse(question);
        await ready();
        const citations = await client.retrieve(text);
        const answer = await client.answer(text, citations);
        await ready();
        store.answer(answer);
      } else {
        await bindSource(); await inventory();
        const result = await client.inspect(snapshot().indexName!);
        store.journal(plan, "inspection-verified", result);
      }
      success = true;
    } catch (error) {
      for (const file of snapshot().documents)
        if (file.state === "sending") {
          const rejected = error instanceof NativeHttpError && [400, 401, 403, 404, 413, 415].includes(error.nativeStatus);
          store.setDocument(file.id, rejected ? "failed" : "uncertain", null, rejected ? `Native rejection (${error.nativeStatus}); no retry` : "Upload outcome unverified; no replay");
        }
      const message = error instanceof HttpError ? error.message : "Native response contract or persistence verification failed; operation retained without retry";
      store.journal(plan, "stopped", { message });
      if (stage !== "chat" && stage !== "inspect") {
        const writeIntent = store.db.prepare("SELECT 1 FROM journal WHERE operation_id=? AND event='dispatch' AND json_extract(body,'$.method')='PUT' LIMIT 1").get(plan.id);
        store.setSnapshot(writeIntent || snapshot().state === "ingesting" ? "partial" : initialState, message);
      }
      throw new HttpError(error instanceof HttpError ? error.status : 502, message);
    } finally { store.release(plan, success); }
  };
}
