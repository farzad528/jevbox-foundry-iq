import { createHash, randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";
import { z } from "zod";
import type { KnowledgeDatabase } from "./database";
import type { RuntimeConfig } from "./runtime-config";
import type { KnowledgeAuth, createKnowledgeEngine } from "./engine";
import type { UserIdentity } from "../../shared/evidence";
import { importLimits, importMime, importName, relativeImportPath, type ImportResult, type ImportStatus } from "../../shared/selected-imports";
import { createGoogleDrive } from "./google-drive";
import { HttpError } from "../errors";

type Connection = { id: string; provider: "local" | "google"; label: string; root_id: string };
type Context = { identity: UserIdentity; sessionId: string };
export function mountSelectedImports(app: express.Express, input: {
  config: RuntimeConfig; store: KnowledgeDatabase; auth: KnowledgeAuth;
  engine: ReturnType<typeof createKnowledgeEngine>;
  origin: string; env?: NodeJS.ProcessEnv; googleFetch?: typeof fetch;
}) {
  const { config, store, auth, engine } = input;
  const env = input.env ?? process.env;
  const selectedDataApproved = config.imports?.selectedDataApproved === true;
  const richDocumentsAvailable = config.approvals.vendorProcessing && !!env.EXTEND_API_KEY;
  const googleBlocker = !config.imports?.googleDriveApproved ? "Google selected-file connection is not approved."
    : !env.GOOGLE_DRIVE_CLIENT_ID || !env.GOOGLE_DRIVE_CLIENT_SECRET ? "Configure a Google OAuth client for this exact localhost callback." : null;
  const google = !googleBlocker ? createGoogleDrive({ origin: input.origin, clientId: env.GOOGLE_DRIVE_CLIENT_ID!,
    clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET!, fetcher: input.googleFetch }) : null;
  const approve = () => {
    if (!selectedDataApproved) throw new HttpError(403, "Selected customer-data processing is not approved; synthetic-upload approval does not authorize it.");
  };
  const requireConnection = async (context: Context, id: string, provider?: Connection["provider"]) => {
    const row = await store.one<Connection>(
      "SELECT id,provider,label,root_id FROM knowledge_import_connections WHERE id=? AND workspace_id=? AND owner_oid=?",
      id, config.knowledge.workspaceId, context.identity.objectId);
    if (!row || (provider && row.provider !== provider)) throw new HttpError(404, "Import connection unavailable");
    await engine.access.require(context.identity, row.root_id, true);
    return row;
  };
  const connection = async (context: Context, provider: Connection["provider"], label: string, id?: string) => {
    engine.access.checkIdentity(context.identity);
    if (id) {
      const row = await requireConnection(context, id, provider);
      if (provider === "local" && row.label !== label) throw new HttpError(409, "Refresh must select the same folder name; use a new import for a different folder.");
      return row;
    }
    return store.transaction(async () => {
      const id = randomUUID(), root_id = randomUUID();
      await store.run("INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,access,created,pinned,knowledge_manual) VALUES(?,?,?,NULL,'folder',?,'restricted',?,true,true)",
        root_id, config.knowledge.workspaceId, context.identity.objectId, label, new Date().toISOString());
      await store.run("INSERT INTO knowledge_import_connections(id,workspace_id,owner_oid,provider,label,root_id) VALUES(?,?,?,?,?,?)",
        id, config.knowledge.workspaceId, context.identity.objectId, provider, label, root_id);
      return { id, provider, label, root_id };
    });
  };
  const save = async (context: Context, target: Connection, source: {
    key: string; name: string; mime: string; body: Buffer; folders: string[]; origin: Record<string, string>;
  }): Promise<ImportResult> => {
    approve();
    if (source.mime === "application/pdf" && !richDocumentsAvailable)
      throw new HttpError(409, "PDF parsing requires separately approved Extend credentials; choose text/Markdown/JSON or a Google Doc.");
    // Downloaded bytes must never outlive or substitute for the importing user's session.
    const current = await auth.identityForSession(context.sessionId);
    if (current.objectId !== context.identity.objectId || current.tenantId !== context.identity.tenantId)
      throw new HttpError(401, "Importing session changed; sign in and select files again");
    const hash = createHash("sha256").update(source.body).digest("hex");
    return store.transaction(async () => {
      await store.one("SELECT id FROM knowledge_import_connections WHERE id=? FOR UPDATE", target.id);
      await requireConnection(context, target.id, target.provider);
      const previous = await store.one<{ document_id: string; content_hash: string }>(
        "SELECT document_id,content_hash FROM knowledge_import_items WHERE connection_id=? AND external_key=?", target.id, source.key);
      let id = previous?.document_id;
      let revision = 1;
      if (id) {
        const row = await engine.access.require(context.identity, id, true, true);
        if (row.kind !== "document") throw new HttpError(409, "Imported document identity is unavailable");
        const state = (await engine.lifecycle.sources(config.knowledge.workspaceId)).get(id);
        if (!state) throw new HttpError(409, "Imported source revision is unavailable");
        const original = await store.one<{ body: Buffer }>(
          "SELECT body FROM knowledge_originals WHERE document_id=? AND source_revision=?", id, state.sourceRevision);
        if (!original) throw new HttpError(409, "Imported original revision is unavailable");
        if (row.mime === source.mime && createHash("sha256").update(Buffer.from(original.body)).digest("hex") === hash) {
          if (state.state === "failed") {
            await engine.transition(row, "acl-sync", context.sessionId);
            return { key: source.key, id, state: "pending" };
          }
          return { key: source.key, id, state: "unchanged" };
        }
        revision = state.sourceRevision + 1;
        await store.run("UPDATE resources SET parsed=NULL,parse_run=NULL,parse_requested=false,knowledge_parse_state='pending',mime=?,size=?,status='processing' WHERE id=?",
          source.mime, source.body.length, id);
      } else {
        let parentId = target.root_id;
        for (const name of source.folders) {
          const existing = await store.one<{ id: string }>(
            "SELECT id FROM resources WHERE org_id=? AND owner_id=? AND parent_id=? AND kind='folder' AND name=? AND NOT knowledge_deleted",
            config.knowledge.workspaceId, context.identity.objectId, parentId, name);
          if (existing) {
            await engine.access.require(context.identity, existing.id, true);
            parentId = existing.id;
          } else {
            const folderId = randomUUID();
            await store.run("INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,access,created,knowledge_manual) VALUES(?,?,?,?,'folder',?,'inherit',?,true)",
              folderId, config.knowledge.workspaceId, context.identity.objectId, parentId, name, new Date().toISOString());
            parentId = folderId;
          }
        }
        id = randomUUID();
        await store.run("INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,mime,size,access,created,status,knowledge_manual) VALUES(?,?,?,?,'document',?,?,?,'restricted',?,'processing',true)",
          id, config.knowledge.workspaceId, context.identity.objectId, parentId, source.name, source.mime, source.body.length, new Date().toISOString());
      }
      await store.run("INSERT INTO knowledge_originals(document_id,source_revision,body) VALUES(?,?,?)", id, revision, source.body);
      await store.run("INSERT INTO knowledge_import_revisions(document_id,source_revision,origin) VALUES(?,?,?::jsonb)",
        id, revision, JSON.stringify(source.origin));
      await store.run("INSERT INTO knowledge_import_items(connection_id,external_key,document_id,content_hash) VALUES(?,?,?,?) ON CONFLICT(connection_id,external_key) DO UPDATE SET content_hash=EXCLUDED.content_hash",
        target.id, source.key, id, hash);
      await engine.transition(await engine.access.resource(id), previous ? "source-change" : "publish", context.sessionId);
      return { key: source.key, id, state: "pending" };
    });
  };
  const failure = (key: string, error: unknown): ImportResult => {
    if (!(error instanceof HttpError) && !(error instanceof z.ZodError)) console.error("Selected import item failed");
    return { key, state: "failed", error: error instanceof HttpError ? error.message
      : error instanceof z.ZodError ? "Unsupported source name or metadata" : "Import failed; reselect the item to retry." };
  };
  app.get("/api/foundry/connections", async (req, res) => {
    const context = await auth.authenticate(req);
    await store.transaction(async () => {
    // Keep metadata delivery on one side of source/ACL transitions, as with original previews.
    await store.one("SELECT id FROM orgs WHERE id=? FOR SHARE", config.knowledge.workspaceId);
    await store.all("SELECT document_id FROM knowledge_source_state WHERE workspace_id=? ORDER BY document_id FOR SHARE", config.knowledge.workspaceId);
    const rows = await store.all<Connection>(
      "SELECT id,provider,label,root_id FROM knowledge_import_connections WHERE workspace_id=? AND owner_oid=? ORDER BY created",
      config.knowledge.workspaceId, context.identity.objectId);
    const sources = await engine.lifecycle.sources(config.knowledge.workspaceId);
    const connections: ImportStatus["connections"] = [];
    for (const row of rows) {
      try { await engine.access.require(context.identity, row.root_id, true); }
      catch (error) { if (error instanceof HttpError && [403, 404, 409].includes(error.status)) continue; throw error; }
      const items: ImportStatus["connections"][number]["items"] = [];
      for (const item of await store.all<{ document_id: string }>(
        "SELECT document_id FROM knowledge_import_items WHERE connection_id=?", row.id)) {
        const resource = await engine.access.resource(item.document_id).catch((error: unknown) => {
          if (error instanceof HttpError && error.status === 404) return null;
          throw error;
        });
        if (!resource || !(await engine.access.readers(resource.id)).includes(context.identity.objectId)) continue;
        const state = sources.get(resource.id);
        items.push({ id: resource.id, ...(state?.state === "verified" && !resource.knowledge_acl_pending ? { name: resource.name } : {}),
          state: state?.state ?? "pending", parse: resource.knowledge_parse_state, revision: state?.sourceRevision ?? 1 });
      }
      connections.push({ id: row.id, rootId: row.root_id, provider: row.provider, label: row.label, items });
    }
    const current = await auth.identityForSession(context.sessionId);
    if (current.objectId !== context.identity.objectId || current.tenantId !== context.identity.tenantId)
      throw new HttpError(401, "Importing session changed");
    res.json({ knowledgeBaseName: config.knowledge.knowledgeBaseName, selectedDataApproved,
      googleAvailable: !!google, googleBlocker, richDocumentsAvailable,
      connections, selection: google?.selected(context.sessionId) ?? null } satisfies ImportStatus);
    });
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: importLimits.fileBytes, files: importLimits.files, fields: 2, fieldSize: 64 * 1024, parts: importLimits.files + 2,
  } });
  app.post("/api/foundry/imports/local", async (req, _res, next) => {
    await auth.authenticate(req); approve(); next();
  }, upload.array("files", importLimits.files), async (req, res) => {
    const context = await auth.authenticate(req);
    const files = req.files;
    if (!Array.isArray(files) || !files.length) throw new HttpError(400, "Select at least one source file");
    let manifest: unknown;
    try { manifest = JSON.parse(z.string().parse(req.body.manifest)); }
    catch { throw new HttpError(400, "A valid selected-path manifest is required"); }
    const data = z.strictObject({ paths: z.array(relativeImportPath).min(1).max(importLimits.files),
      connectionId: z.uuid().optional() }).parse(manifest);
    if (data.paths.length !== files.length || new Set(data.paths).size !== files.length)
      throw new HttpError(400, "Each file requires one distinct relative folder path");
    if (files.reduce((sum, file) => sum + file.size, 0) > importLimits.batchBytes)
      throw new HttpError(413, "Import at most 32 MiB per selection");
    const label = importName.parse(data.paths[0].split("/")[0]);
    if (data.paths.some((path) => path.split("/")[0] !== label))
      throw new HttpError(400, "Select files from one folder root");
    const target = await connection(context, "local", label, data.connectionId);
    const results: ImportResult[] = [];
    for (const [index, file] of files.entries()) {
      const key = data.paths[index], parts = key.split("/");
      try {
        const name = importName.parse(parts.at(-1));
        if (file.originalname !== name) throw new HttpError(400, "File name does not match its selected path");
        const mime = importMime(name);
        if (!mime) throw new HttpError(400, "Unsupported file type; choose text, Markdown, JSON or approved PDF");
        results.push(await save(context, target, { key, name, mime, body: file.buffer, folders: parts.slice(1, -1),
          origin: { provider: "local", path: key, representation: "Selected local file snapshot" } }));
      } catch (error) { results.push(failure(key, error)); }
    }
    res.status(202).json({ connectionId: target.id, results });
  });
  app.post("/api/foundry/google/start", async (req, res) => {
    const context = await auth.authenticate(req); approve();
    if (!google) throw new HttpError(409, googleBlocker!);
    const data = z.strictObject({ connectionId: z.uuid().optional() }).parse(req.body);
    if (data.connectionId) await requireConnection(context, data.connectionId, "google");
    res.json({ url: google.start(context.sessionId, data.connectionId) });
  });
  app.get("/api/foundry/google/callback", async (req, res) => {
    const context = await auth.authenticate(req); approve();
    if (!google) throw new HttpError(409, googleBlocker!);
    await google.callback(context.sessionId, req.query);
    await auth.identityForSession(context.sessionId);
    res.set("Referrer-Policy", "no-referrer").redirect("/?connect=google");
  });
  app.post("/api/foundry/imports/google", async (req, res) => {
    const context = await auth.authenticate(req); approve();
    if (!google) throw new HttpError(409, googleBlocker!);
    z.strictObject({ confirm: z.literal(true) }).parse(req.body);
    const result = await google.consume(context.sessionId, async (files, connectionId, download) => {
      const target = await connection(context, "google", "Google Drive", connectionId);
      const results: ImportResult[] = [];
      let total = 0;
      for (const file of files) {
        try {
          if (file.mimeType === "application/pdf" && !richDocumentsAvailable)
            throw new HttpError(409, "PDF parsing requires separately approved Extend credentials");
          const source = await download(file);
          total += source.body.length;
          if (total > importLimits.batchBytes) throw new HttpError(413, "Import at most 32 MiB per selection");
          results.push(await save(context, target, { ...source, key: file.id, folders: [] }));
        } catch (error) { results.push(failure(file.id, error)); }
      }
      return { connectionId: target.id, results };
    });
    res.status(202).json(result);
  });
  app.get("/api/foundry/origins/:id", async (req, res) => {
    const { identity } = await auth.authenticate(req);
    const id = z.uuid().parse(req.params.id);
    await store.transaction(async () => {
      await store.one("SELECT document_id FROM knowledge_source_state WHERE document_id=? FOR UPDATE", id);
      const resource = await engine.access.require(identity, id);
      if (resource.kind !== "document") throw new HttpError(404, "Imported original unavailable");
      const state = (await engine.lifecycle.sources(config.knowledge.workspaceId)).get(id);
      const origin = await store.one<{ origin: Record<string, string> }>(
        "SELECT origin FROM knowledge_import_revisions WHERE document_id=? AND source_revision=?", id, state!.sourceRevision);
      res.json(origin?.origin ?? null);
    });
  });
}
