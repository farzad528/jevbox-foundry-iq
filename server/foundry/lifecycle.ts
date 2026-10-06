import { randomUUID } from "node:crypto";
import type { Store } from "../db";
import { sourceStateSchema, type SourceState } from "../../shared/evidence";
import { indexResultsSchema, verifyIndexResults } from "./search-index";

type KnowledgeStore = Pick<Store, "one" | "all" | "run" | "transaction">;
type StateRow = {
  document_id: string; workspace_id: string; tenant_id: string; source_revision: number;
  acl_revision: number; generation: number; readers: string[]; state: SourceState["state"];
};
type OutboxRow = {
  id: string; document_id: string; generation: number;
  state: string; attempt_id: string | null; operation: string;
  lease_until?: string | Date | null;
};

export function createKnowledgeLifecycle(store: KnowledgeStore) {
  const lockState = (id: string) => store.one<StateRow>(
    "SELECT * FROM knowledge_source_state WHERE document_id=? FOR UPDATE", id,
  );
  return {
    async sources(workspaceId: string) {
      const rows = await store.all<StateRow>(
        "SELECT * FROM knowledge_source_state WHERE workspace_id=?", workspaceId,
      );
      return new Map(rows.map((row) => [row.document_id, sourceStateSchema.parse({
        documentId: row.document_id, workspaceId: row.workspace_id, tenantId: row.tenant_id,
        sourceRevision: row.source_revision, aclRevision: row.acl_revision,
        readers: row.readers, state: row.state,
      })]));
    },
    async transition(input: SourceState, operation: "publish" | "acl-sync" | "delete" | "source-change") {
      const source = sourceStateSchema.parse(input);
      return store.transaction(async () => {
        const previous = await lockState(source.documentId);
        if (previous && (previous.workspace_id !== source.workspaceId || previous.tenant_id !== source.tenantId ||
            source.sourceRevision < previous.source_revision ||
            source.aclRevision < previous.acl_revision ||
            (source.sourceRevision === previous.source_revision && source.aclRevision === previous.acl_revision)))
          throw new Error("Source transition must advance an authoritative revision");
        const generation = (previous?.generation ?? 0) + 1;
        await store.run(
          `INSERT INTO knowledge_source_state(document_id,workspace_id,tenant_id,source_revision,acl_revision,generation,readers,state)
           VALUES(?,?,?,?,?,?,?::jsonb,'pending')
           ON CONFLICT(document_id) DO UPDATE SET source_revision=EXCLUDED.source_revision,acl_revision=EXCLUDED.acl_revision,
           generation=EXCLUDED.generation,readers=EXCLUDED.readers,state='pending',updated=now()`,
          source.documentId, source.workspaceId, source.tenantId, source.sourceRevision, source.aclRevision,
          generation, JSON.stringify(source.readers),
        );
        await store.run(
          "UPDATE knowledge_evidence SET current=false,retrievable=false WHERE workspace_id=? AND ?=ANY(raw_source_ids)",
          source.workspaceId, source.documentId,
        );
        if (operation !== "acl-sync")
          await store.run(
            "UPDATE knowledge_wiki_revisions SET state='stale' WHERE workspace_id=? AND ?=ANY(raw_source_ids) AND state IN ('draft','reviewed','published')",
            source.workspaceId, source.documentId,
          );
        await store.run(
          "UPDATE knowledge_outbox SET state='obsolete',attempt_id=NULL,updated=now() WHERE document_id=? AND state<>'verified'",
          source.documentId,
        );
        const id = randomUUID();
        await store.run(
          "INSERT INTO knowledge_outbox(id,document_id,generation,operation) VALUES(?,?,?,?)",
          id, source.documentId, generation, operation,
        );
        return { id, generation };
      });
    },
    async claim(id: string) {
      return store.transaction(async () => {
        const initial = await store.one<OutboxRow>("SELECT document_id FROM knowledge_outbox WHERE id=?", id);
        if (!initial) throw new Error("Unknown knowledge outbox item");
        const source = await lockState(initial.document_id);
        const item = await store.one<OutboxRow>("SELECT * FROM knowledge_outbox WHERE id=? FOR UPDATE", id);
        if (!item) throw new Error("Unknown knowledge outbox item");
        if (!source || source.generation !== item.generation || item.state === "obsolete")
          throw new Error("Obsolete indexing attempt");
        if (item.state === "working" && item.lease_until && new Date(item.lease_until).getTime() < Date.now())
          item.state = "failed";
        if (!["pending", "failed"].includes(item.state))
          throw new Error("Outbox item is already claimed or verified");
        const attemptId = randomUUID();
        await store.run(
          "UPDATE knowledge_outbox SET state='working',attempt_id=?,error_code=NULL,updated=now() WHERE id=?",
          attemptId, id,
        );
        await store.run("UPDATE knowledge_source_state SET state='syncing',updated=now() WHERE document_id=?", source.document_id);
        return { id, attemptId, generation: source.generation, documentId: source.document_id };
      });
    },
    async publish(
      attempt: { id: string; attemptId: string; generation: number; documentId: string },
      keys: string[],
      write: () => Promise<unknown>,
      verifyNative: () => Promise<void>,
    ) {
      let failed: unknown;
      await store.transaction(async () => {
        // Serialize source transitions and native writes; an obsolete writer cannot overwrite a newer ACL.
        const source = await lockState(attempt.documentId);
        const current = await store.one<OutboxRow>("SELECT * FROM knowledge_outbox WHERE id=? FOR UPDATE", attempt.id);
        if (!source || source.generation !== attempt.generation ||
            current?.attempt_id !== attempt.attemptId || current.state !== "working")
          throw new Error("Obsolete indexing attempt cannot publish");
        let payload: unknown;
        try {
          payload = await write();
          const results = verifyIndexResults(payload, keys);
          await store.run("UPDATE knowledge_outbox SET item_results=?::jsonb WHERE id=?",
            JSON.stringify(results.map(({ key, status, statusCode }) => ({ key, status, statusCode }))), attempt.id);
          await verifyNative();
        } catch (error) {
          failed = error;
          const parsed = indexResultsSchema.safeParse(payload);
          await store.run(
            "UPDATE knowledge_outbox SET state='failed',error_code='native-sync-failed',item_results=COALESCE(?::jsonb,item_results),attempt_id=NULL,updated=now() WHERE id=?",
            parsed.success ? JSON.stringify(parsed.data.value.map(({ key, status, statusCode }) => ({ key, status, statusCode }))) : null,
            attempt.id,
          );
          await store.run("UPDATE knowledge_source_state SET state='failed',updated=now() WHERE document_id=?", attempt.documentId);
          return;
        }
        await store.run(
          "UPDATE knowledge_outbox SET state='verified',attempt_id=NULL,updated=now() WHERE id=? AND attempt_id=?",
          attempt.id, attempt.attemptId,
        );
        await store.run(
          "UPDATE knowledge_source_state SET state=?,updated=now() WHERE document_id=? AND generation=?",
          current.operation === "delete" ? "deleted" : "verified", attempt.documentId, attempt.generation,
        );
      });
      if (failed !== undefined) throw failed;
    },
    async fail(attempt: { id: string; attemptId: string; documentId: string; generation: number }) {
      await store.transaction(async () => {
        const source = await lockState(attempt.documentId);
        if (!source || source.generation !== attempt.generation) return;
        const result = await store.run(
          "UPDATE knowledge_outbox SET state='failed',error_code='native-sync-failed',attempt_id=NULL,updated=now() WHERE id=? AND attempt_id=?",
          attempt.id, attempt.attemptId,
        );
        if (result.changes)
          await store.run("UPDATE knowledge_source_state SET state='failed',updated=now() WHERE document_id=?", attempt.documentId);
      });
    },
  };
}
