import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { loadRuntimeConfig, activationBlockers, type RuntimeConfig } from "./runtime-config";
import { createFoundryDatabase, type KnowledgeDatabase } from "./database";
import { createEntraAuth } from "./entra-auth";
import { createServiceCredentials } from "./service-credentials";
import { createIqClient } from "./iq-client";
import { createFoundryModels } from "./model-client";
import { createSearchWriter } from "./search-index";
import { createNativeAgentClient } from "./native-agent";
import { createKnowledgeEngine, type KnowledgeAuth } from "./engine";
import { createDocumentParser } from "../providers";
import { getDecisionConnection } from "../decision-provider";
import { HttpError } from "../errors";
import type { ParsedDocument } from "../indexing";
import type { KnowledgeResource } from "./access";
import { SourceUnavailableError } from "../../shared/evidence";
import { fileMime } from "../../shared/file-types";

const resourceName = z.string().trim().min(1).max(160).refine((name) => !/[\x00-\x1f/\\]/.test(name) && ![".", ".."].includes(name));
const sourceMime = (file: Express.Multer.File) => {
  const mime = fileMime(resourceName.parse(file.originalname));
  if (!["text/plain", "text/markdown", "application/pdf", "application/json"].includes(mime))
    throw new HttpError(400, "The PoC accepts text, Markdown, JSON or PDF");
  return mime;
};
export async function createFoundryApp(options: { origin: string; databaseUrl?: string; workers?: boolean }) {
  const config = await loadRuntimeConfig();
  const blockers = activationBlockers(config);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.get("Origin") !== options.origin || req.get("X-Jevbox-Request") !== "1"))
      return next(new HttpError(403, "A same-origin application request is required"));
    next();
  });
  app.get("/health/live", (_req, res) => res.json({ ok: true, profile: "foundry-iq" }));
  app.get("/api/profile", (_req, res) => res.json({ profile: "foundry-iq", activated: blockers.length === 0, blockers }));
  if (!config || blockers.length) {
    app.get("/health/ready", (_req, res) => res.status(503).json({ ok: false, profile: "foundry-iq", blockers }));
    app.use("/api", (_req, res) => res.status(503).json({
      code: "foundry-activation-blocked", error: "Foundry activation is pending approval and native verification. Legacy paths are disabled.",
    }));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(error instanceof HttpError ? error.status : 500).json({
        error: error instanceof HttpError ? error.message : "Foundry setup request failed",
      });
    });
    return { app, activated: false, closeStreams() {}, async close() {} };
  }
  const encryptionKey = process.env.ENCRYPTION_KEY;
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl || !encryptionKey) throw new Error("An isolated DATABASE_URL and ENCRYPTION_KEY are required");
  const store = await createFoundryDatabase(databaseUrl, config.databaseSchema, encryptionKey);
  let boss: PgBoss | undefined;
  try {
    const auth = createEntraAuth({
      tenantId: config.knowledge.tenantId, roster: config.knowledge.roster,
      clientId: config.entraClientId, clientSecret: process.env.ENTRA_CLIENT_SECRET ?? "",
      redirectUri: `${options.origin}/api/entra/callback`, encryptionKey,
      cookieSecure: new URL(options.origin).protocol === "https:", consentActivated: config.approvals.entraConsent,
    }, store);
    const credentials = createServiceCredentials(config);
    const parser = createDocumentParser({ ...store, files: {
      async read(_kind: "document", id: string) {
        const row = await store.one<{ body: Buffer }>(
          "SELECT o.body FROM knowledge_originals o JOIN knowledge_source_state s ON o.document_id=s.document_id AND o.source_revision=s.source_revision WHERE o.document_id=?", id,
        );
        return row ? { body: Buffer.from(row.body) } : undefined;
      },
    } });
    await store.transaction(async () => {
      await store.run("INSERT INTO orgs(id,name,settings) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET settings=EXCLUDED.settings",
        config.knowledge.workspaceId, config.workspaceName,
        store.encrypt(JSON.stringify(config.approvals.vendorProcessing ? { extendKey: process.env.EXTEND_API_KEY } : {})));
      for (const oid of config.knowledge.roster) {
        await store.run("INSERT INTO users(id,name,email,email_verified) VALUES(?,?,?,true) ON CONFLICT(id) DO NOTHING", oid, `Entra ${oid.slice(0, 8)}`, `${oid}@${config.knowledge.tenantId}.invalid`);
        await store.run("INSERT INTO members(org_id,user_id,role) VALUES(?,?,'member') ON CONFLICT DO NOTHING", config.knowledge.workspaceId, oid);
      }
    });
    boss = new PgBoss({ connectionString: databaseUrl, schema: `${config.databaseSchema}_native_jobs`,
      application_name: "jevbox-native-jobs", max: 3 });
    boss.on("error", () => console.error("Native background queue unavailable"));
    await boss.start();
    for (const queue of ["knowledge-sync", "knowledge-request"]) await boss.createQueue(queue, {
      retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 300, heartbeatSeconds: 30,
    });
    const queue = boss;
    const enqueue = async (kind: "sync" | "request", id: string) => {
      const result = await queue.send(kind === "sync" ? "knowledge-sync" : "knowledge-request", { id },
        { singletonKey: id, db: { executeSql: store.executeSql } });
      if (!result) throw new HttpError(503, "Durable native work could not be queued");
    };
    const engine = createKnowledgeEngine({
      store, config, auth, enqueue,
      iq: createIqClient(config.knowledge, credentials.reader),
      models: createFoundryModels(config.knowledge, credentials.project),
      writer: createSearchWriter(config.knowledge, credentials.writer),
      agent: createNativeAgentClient({ config: config.knowledge, projectEndpoint: config.knowledge.projectEndpoint,
        agentName: config.agentName, projectCredential: credentials.project }),
      readerCredential: credentials.reader,
      decision: config.approvals.vendorProcessing ? getDecisionConnection({ jevKey: process.env.JEV_API_KEY }) : undefined,
      async parse(resource, signal, check) {
        if (!resource.mime.startsWith("text/") && resource.mime !== "application/json" && !config.approvals.vendorProcessing) {
          await store.run("UPDATE resources SET knowledge_parse_state='approval-required' WHERE id=?", resource.id);
          throw new HttpError(409, "External Extend parsing is not approved; rich documents remain blocked");
        }
        if (!resource.mime.startsWith("text/") && resource.mime !== "application/json" && !process.env.EXTEND_API_KEY) {
          await store.run("UPDATE resources SET knowledge_parse_state='credentials-required' WHERE id=?", resource.id);
          throw new HttpError(409, "Extend credentials are required for approved rich-document parsing");
        }
        return parser(resource, { signal, check, checkpoint: async (sql, ...values) => {
          await store.transaction(async () => { await check(); await store.run(sql, ...values); });
        } });
      },
    });
    if (options.workers !== false) {
      await queue.work<{ id: string }>("knowledge-sync", { includeMetadata: true }, async (jobs) => {
        for (const job of jobs) await engine.sync(job.data.id, job.signal);
      });
      await queue.work<{ id: string }>("knowledge-request", { includeMetadata: true }, async (jobs) => {
        for (const job of jobs) await engine.executeRequest(job.data.id, job.signal);
      });
      for (const row of await store.all<{ id: string }>("SELECT id FROM knowledge_outbox WHERE state IN ('pending','failed') OR (state='working' AND lease_until<now())"))
        await enqueue("sync", row.id);
      for (const row of await store.all<{ id: string }>("SELECT id FROM knowledge_requests WHERE state='queued' OR (state='working' AND lease_until<now())"))
        await enqueue("request", row.id);
    }
    mountFoundryRoutes(app, { config, store, auth, engine, enqueue });
    return { app, activated: true, closeStreams() {}, async close() { await queue.stop({ graceful: true, timeout: 30000 }); await store.close(); } };
  } catch (error) {
    await boss?.stop({ graceful: false });
    await store.close();
    throw error;
  }
}

export function mountFoundryRoutes(app: express.Express, input: {
  config: RuntimeConfig; store: KnowledgeDatabase; auth: KnowledgeAuth & { router: express.Router };
  engine: ReturnType<typeof createKnowledgeEngine>; enqueue: (kind: "sync" | "request", id: string) => Promise<void>;
}) {
    const { config, store, auth, engine, enqueue } = input;
    app.use("/api/entra", auth.router);
    app.use("/api", (req, _res, next) => {
      const pending = activationBlockers(config);
      if (pending.length) return next(new HttpError(503, pending.join(" ")));
      next();
    });
    app.get("/health/ready", async (_req, res) => {
      await store.one("SELECT 1");
      res.json({ ok: true, profile: "foundry-iq" });
    });
    app.get("/api/foundry/me", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      res.json({ identity, workspaceId: config.knowledge.workspaceId, workspaceName: config.workspaceName,
        projectEndpoint: config.knowledge.projectEndpoint, modelDeployment: config.knowledge.answerDeployment,
        vendorProcessingApproved: config.approvals.vendorProcessing, roster: config.knowledge.roster });
    });
    const describe = async (req: Request, row: KnowledgeResource, includeParsed = false) => {
      const { identity } = await auth.authenticate(req);
      const state = (await engine.lifecycle.sources(config.knowledge.workspaceId)).get(row.id);
      const parsed: ParsedDocument | undefined = state?.state === "verified" && row.parsed ? JSON.parse(row.parsed) : undefined;
      return { ...row, parsed: includeParsed ? parsed : undefined,
        pages: parsed?.pages ?? 0, canWrite: await engine.access.canWrite(identity, row.id),
        canShare: row.owner_id === identity.objectId,
        syncState: state?.state ?? "pending", sourceRevision: state?.sourceRevision, aclRevision: state?.aclRevision,
        filing: { state: row.knowledge_filing_state, error: row.knowledge_filing_state === "failed" ? row.error : null },
      };
    };
    app.get("/api/resources", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const rows = (await engine.access.visible(identity)).filter((row) => row.mime !== "application/x-jevbox-wiki");
      res.json(await Promise.all(rows.map((row) => describe(req, row))));
    });
    app.get("/api/resources/:id", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const row = await engine.access.require(identity, z.uuid().parse(req.params.id));
      if (row.mime === "application/x-jevbox-wiki") throw new HttpError(404, "Use the guarded knowledge page route");
      res.json(await describe(req, row, true));
    });
    app.get("/api/documents/:id/content", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      await store.transaction(async () => {
        await store.one("SELECT document_id FROM knowledge_source_state WHERE document_id=? FOR UPDATE", req.params.id);
        const resource = await engine.access.require(identity, z.uuid().parse(req.params.id));
        const source = (await engine.lifecycle.sources(config.knowledge.workspaceId)).get(resource.id)!;
        const original = await store.one<{ body: Buffer }>("SELECT body FROM knowledge_originals WHERE document_id=? AND source_revision=?", resource.id, source.sourceRevision);
        if (!original) throw new HttpError(404, "Original revision unavailable");
        res.type(resource.mime).set("Content-Disposition", "inline").send(original.body);
      });
    });
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
    app.post("/api/foundry/documents", upload.single("file"), async (req, res) => {
      const { identity, sessionId } = await auth.authenticate(req);
      if (!req.file) throw new HttpError(400, "One synthetic source file is required");
      const mime = sourceMime(req.file);
      const parentId = req.body.parentId ? z.uuid().parse(req.body.parentId) : null;
      const name = resourceName.parse(req.file.originalname);
      const id = randomUUID();
      await store.transaction(async () => {
        if (parentId) await engine.access.require(identity, parentId, true, true);
        await store.run("INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,mime,size,access,created,status) VALUES(?,?,?,?,'document',?,?,?,'restricted',?,'processing')",
          id, config.knowledge.workspaceId, identity.objectId, parentId, name, mime, req.file!.size, new Date().toISOString());
        await store.run("INSERT INTO knowledge_originals(document_id,source_revision,body) VALUES(?,1,?)", id, req.file!.buffer);
        await engine.transition(await engine.access.resource(id), "publish", sessionId);
      });
      res.status(202).json({ id, state: "pending" });
    });
    app.post("/api/foundry/folders", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const data = z.strictObject({ name: resourceName, parentId: z.uuid().nullable(), access: z.enum(["restricted", "inherit"]) }).parse(req.body);
      const id = randomUUID();
      await store.transaction(async () => {
        if (data.parentId) await engine.access.require(identity, data.parentId, true, true);
        await store.run("INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,access,created) VALUES(?,?,?,?,'folder',?,?,?)",
          id, config.knowledge.workspaceId, identity.objectId, data.parentId, data.name, data.access, new Date().toISOString());
      });
      res.status(201).json({ id });
    });
    app.put("/api/foundry/documents/:id", upload.single("file"), async (req, res) => {
      const { identity, sessionId } = await auth.authenticate(req);
      const id = z.uuid().parse(req.params.id);
      if (!req.file)
        throw new HttpError(400, "A supported replacement source file is required");
      const mime = sourceMime(req.file);
      await store.transaction(async () => {
        const row = await engine.access.require(identity, id, true, true);
        const previous = (await engine.lifecycle.sources(config.knowledge.workspaceId)).get(id);
        if (!previous) throw new HttpError(409, "Source revision is unavailable");
        await store.run("UPDATE resources SET parsed=NULL,parse_run=NULL,parse_requested=false,knowledge_parse_state='pending',mime=?,size=?,status='processing' WHERE id=?", mime, req.file!.size, id);
        await store.run("INSERT INTO knowledge_originals(document_id,source_revision,body) VALUES(?,?,?)", id, previous.sourceRevision + 1, req.file!.buffer);
        await engine.transition(row, "source-change", sessionId);
      });
      res.status(202).json({ state: "pending", message: "Original revision retained. Dependent knowledge is stale until regenerated/reviewed." });
    });
    app.get("/api/foundry/resources/:id/grants", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const row = await engine.access.require(identity, z.uuid().parse(req.params.id), true, true);
      if (row.owner_id !== identity.objectId) throw new HttpError(403, "Only the owner inspects direct grants");
      res.json(await store.all<{ objectId: string; role: string }>('SELECT user_id AS "objectId",role FROM grants WHERE resource_id=?', row.id));
    });
    app.patch("/api/foundry/resources/:id", async (req, res) => {
      const { identity, sessionId } = await auth.authenticate(req);
      const data = z.strictObject({
        parentId: z.uuid().nullable().optional(), pinned: z.boolean().optional(),
        access: z.enum(["restricted", "inherit"]).optional(),
        grants: z.array(z.strictObject({ objectId: z.uuid(), role: z.enum(["viewer", "editor"]) })).max(2).optional(),
      }).refine((data) => Object.keys(data).length > 0).parse(req.body);
      const id = z.uuid().parse(req.params.id);
      await store.transaction(async () => {
        await store.one("SELECT id FROM orgs WHERE id=? FOR UPDATE", config.knowledge.workspaceId);
        const row = await engine.access.require(identity, id, true, true);
        if ((data.access || data.grants) && row.owner_id !== identity.objectId) throw new HttpError(403, "Only the owner changes direct sharing");
        if (data.parentId !== undefined) {
          if (data.parentId && (await engine.access.bounds(data.parentId)).some((ancestor) => ancestor.id === id)) throw new HttpError(409, "A move cannot create a cycle");
          if (data.parentId) await engine.access.require(identity, data.parentId, true, true);
          if ((await engine.access.bounds(id)).some((ancestor) => ancestor.pinned)) throw new HttpError(409, "Pinned locations cannot move");
          await store.run("UPDATE resources SET parent_id=?,knowledge_manual=true WHERE id=?", data.parentId, id);
        }
        if (data.pinned !== undefined) {
          if (row.kind !== "folder") throw new HttpError(400, "Only folders can be pinned");
          await store.run("UPDATE resources SET pinned=? WHERE id=?", data.pinned, id);
        }
        if (data.access) await store.run("UPDATE resources SET access=? WHERE id=?", data.access, id);
        if (data.grants) {
          if (data.grants.some((grant) => !config.knowledge.roster.includes(grant.objectId))) throw new HttpError(403, "Sharing is limited to the configured two OIDs");
          await store.run("DELETE FROM grants WHERE resource_id=?", id);
          for (const grant of data.grants) await store.run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", id, grant.objectId, grant.role);
        }
        if (data.parentId !== undefined || data.access || data.grants) await engine.refreshScope(id, sessionId);
      });
      const requiresSync = data.parentId !== undefined || data.access !== undefined || data.grants !== undefined;
      res.status(requiresSync ? 202 : 200).json({ state: requiresSync ? "pending" : "saved",
        message: requiresSync ? "Changes remain pending until native source/wiki ACL verification." : "Folder pin saved." });
    });
    app.post("/api/documents/:id/retry", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      await engine.access.require(identity, z.uuid().parse(req.params.id), true, true);
      const pending = await store.one<{ id: string }>("SELECT id FROM knowledge_outbox WHERE document_id=? AND state='failed' ORDER BY generation DESC LIMIT 1", req.params.id);
      if (!pending) throw new HttpError(409, "No failed current synchronization to retry");
      await enqueue("sync", pending.id);
      res.status(202).json({ state: "pending" });
    });
    app.delete("/api/resources/:id", async (req, res) => {
      const { identity, sessionId } = await auth.authenticate(req);
      const id = z.uuid().parse(req.params.id);
      await store.transaction(async () => {
        await engine.access.require(identity, id, true, true);
        await engine.refreshScope(id, sessionId, true);
        await store.run("UPDATE resources SET knowledge_deleted=true WHERE id=?", id);
      });
      res.status(202).json({ state: "pending-deletion" });
    });
    app.get("/api/foundry/wiki", async (req, res) => res.json(await engine.wiki.list((await auth.authenticate(req)).identity)));
    app.get("/api/foundry/wiki-stale", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const rows = await store.all<{ page_id: string; raw_source_ids: string[] }>("SELECT DISTINCT page_id,raw_source_ids FROM knowledge_wiki_revisions WHERE workspace_id=? AND state='stale'", config.knowledge.workspaceId);
      const sources = await engine.lifecycle.sources(config.knowledge.workspaceId);
      const visible = [];
      for (const row of rows) {
        if (!(await engine.access.readers(row.page_id)).includes(identity.objectId) ||
          !row.raw_source_ids.every((id) => sources.get(id)?.state === "verified" && sources.get(id)?.readers.includes(identity.objectId))) continue;
        visible.push({ pageId: row.page_id, state: "stale", documentIds: row.raw_source_ids });
      }
      res.json(visible);
    });
    app.get("/api/foundry/evidence", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const states = await engine.lifecycle.sources(config.knowledge.workspaceId);
      const units = [...(await engine.lookup()).values()].filter((unit) => unit.contentKind === "raw" &&
        unit.userIds.includes(identity.objectId) && states.get(unit.locator.documentId)?.state === "verified");
      res.json(units);
    });
    app.get("/api/foundry/citations/:key", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const { assertEvidenceAccess } = await import("../../shared/evidence");
      const unit = (await engine.lookup()).get(z.string().regex(/^[a-zA-Z0-9_-]+$/).parse(req.params.key));
      if (!unit) throw new HttpError(404, "Citation unavailable");
      assertEvidenceAccess(unit, identity, config.knowledge.workspaceId, await engine.lifecycle.sources(config.knowledge.workspaceId));
      const dependencies = unit.contentKind === "raw" ? [unit.locator] : unit.supportingEvidence.map((dependency) => dependency.locator);
      const originals = [];
      for (const locator of dependencies) {
        const resource = await engine.access.require(identity, locator.documentId);
        originals.push({ name: resource.name, locator });
      }
      res.json({ evidence: unit, originals });
    });
    app.get("/api/foundry/wiki/:id", async (req, res) => res.json(await engine.wiki.read((await auth.authenticate(req)).identity, z.uuid().parse(req.params.id))));
    app.get("/api/foundry/wiki/:id/resource", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const id = z.uuid().parse(req.params.id);
      const page = await engine.wiki.read(identity, id);
      const resource = await engine.access.require(identity, id, false, true);
      res.json({ ...await describe(req, resource), name: page.title });
    });
    app.get("/api/foundry/wiki/:id/history", async (req, res) => res.json(await engine.wiki.history((await auth.authenticate(req)).identity, z.uuid().parse(req.params.id))));
    app.get("/api/foundry/wiki/:id/links", async (req, res) => res.json(await engine.wiki.navigation((await auth.authenticate(req)).identity, z.uuid().parse(req.params.id))));
    app.patch("/api/foundry/wiki/:id", async (req, res) => res.json(await engine.wiki.edit((await auth.authenticate(req)).identity, z.uuid().parse(req.params.id), req.body)));
    app.post("/api/foundry/wiki/:id/review", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      res.json(await engine.wiki.review(identity, z.uuid().parse(req.params.id), z.strictObject({ revision: z.number().int().positive(), acknowledged: z.literal(true) }).parse(req.body).revision));
    });
    app.post("/api/foundry/wiki/:id/publish", async (req, res) => {
      const { identity, sessionId } = await auth.authenticate(req);
      const result = await engine.wiki.publish(identity, sessionId, z.uuid().parse(req.params.id), z.strictObject({ revision: z.number().int().positive() }).parse(req.body).revision);
      await enqueue("sync", result.id);
      res.status(202).json(result);
    });
    app.post("/api/foundry/requests/:kind", async (req, res) => {
      const { identity, sessionId } = await auth.authenticate(req);
      const kind = z.enum(["answer", "wiki-draft", "native-agent"]).parse(req.params.kind);
      res.status(202).json({ id: await engine.createRequest(identity, sessionId, kind, req.body) });
    });
    app.get("/api/foundry/requests", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const ids = await store.all<{ id: string }>("SELECT id FROM knowledge_requests WHERE workspace_id=? AND user_oid=? ORDER BY created DESC LIMIT 50", config.knowledge.workspaceId, identity.objectId);
      const readable = [];
      for (const { id } of ids) {
        const row = await store.one<{ dependencies: { documentId: string; sourceRevision: number; aclRevision: number }[] }>("SELECT dependencies FROM knowledge_requests WHERE id=?", id);
        const states = await engine.lifecycle.sources(config.knowledge.workspaceId);
        if (row?.dependencies.some((dependency) => {
          const state = states.get(dependency.documentId);
          return state?.state !== "verified" || !state.readers.includes(identity.objectId) ||
            state.sourceRevision !== dependency.sourceRevision || state.aclRevision !== dependency.aclRevision;
        })) continue;
        readable.push(await engine.request(identity, id));
      }
      res.json(readable);
    });
    app.get("/api/foundry/requests/:id", async (req, res) => res.json(await engine.request((await auth.authenticate(req)).identity, z.uuid().parse(req.params.id))));
    app.delete("/api/foundry/requests/:id", async (req, res) => {
      await engine.cancel((await auth.authenticate(req)).identity, z.uuid().parse(req.params.id));
      res.json({ state: "cancelled" });
    });
    app.get("/api/foundry/status", async (req, res) => {
      const { identity } = await auth.authenticate(req);
      const rows = await engine.access.visible(identity);
      const states = await engine.lifecycle.sources(config.knowledge.workspaceId);
      res.json({ sources: rows.filter((row) => row.mime !== "application/x-jevbox-wiki").map((row) => ({
        id: row.id, parse: row.knowledge_parse_state, filing: row.knowledge_filing_state, nativeSync: states.get(row.id)?.state ?? "pending",
      })), ownerOnlyPending: await engine.access.pending(identity), projectEndpoint: config.knowledge.projectEndpoint,
        legacyPaths: "disabled", nativeProof: "operator-provided exact-environment proof; requires actual live evidence" });
    });
    app.use("/api", (_req, res) => res.status(410).json({ code: "legacy-path-disabled",
      error: "Legacy password, OAuth/API-key, JEV retrieval, anonymous links and local MCP gateway are disabled in the Entra profile." }));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid input or incompatible external contract" });
      if (error instanceof SourceUnavailableError) return res.status(409).json({ error: "Source access, revision or synchronization changed; protected data is unavailable." });
      if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
      console.error("Foundry application request failed");
      res.status(500).json({ error: "Foundry operation failed; no legacy fallback was attempted" });
    });
}
