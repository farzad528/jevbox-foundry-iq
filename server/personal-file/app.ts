import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { personalConfigSchema, stageSchema, type PersonalConfig, type PersonalState } from "../../shared/personal-file";
import { importLimits, importMime, relativeImportPath } from "../../shared/selected-imports";
import { HttpError } from "../errors";
import { cliCredential, type Credential, type NativeTransport } from "./native";
import { PersonalStore, protectDirectory } from "./store";
import { createPersonalWorkflow } from "./workflow";

export function loadPersonalConfig(file = process.env.PERSONAL_FILE_CONFIG): PersonalConfig | null {
  if (!file) return null;
  if (!file.endsWith(".runtime.local.json")) throw new Error("Use a private .runtime.local.json personal configuration");
  return personalConfigSchema.parse(JSON.parse(readFileSync(resolve(file), "utf8")));
}
function processLock(directory: string) {
  protectDirectory(directory);
  const file = join(directory, "server.lock");
  if (existsSync(file)) {
    const previous = z.object({ pid: z.number().int().positive(), nonce: z.string() }).parse(JSON.parse(readFileSync(file, "utf8")));
    try { process.kill(previous.pid, 0); throw new Error("This private catalog is already open by a running server"); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error; }
    unlinkSync(file);
  }
  const nonce = randomUUID(), fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); } finally { closeSync(fd); }
  return () => {
    const current = JSON.parse(readFileSync(file, "utf8")) as { nonce: string };
    if (current.nonce !== nonce) throw new Error("Private server ownership changed");
    unlinkSync(file);
  };
}
export async function createPersonalApp(options: {
  origin: string; directory?: string; config?: PersonalConfig | null; credential?: Credential; transport?: NativeTransport;
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") throw new Error("Personal mode requires a loopback origin");
  const directory = resolve(options.directory ?? process.env.PERSONAL_FILE_DATA_DIR ?? ".data/personal-file");
  const unlock = processLock(directory);
  let store: PersonalStore;
  try { store = new PersonalStore(directory, { recoverInterrupted: true }); } catch (error) { unlock(); throw error; }
  let config: PersonalConfig | null, blocker: string | null = null;
  try { config = options.config === undefined ? loadPersonalConfig() : options.config ? personalConfigSchema.parse(options.config) : null; }
  catch { config = null; blocker = "Private runtime configuration is invalid; the operator must correct it before cloud operations"; }
  if (!config && !blocker) blocker = "Local selection and 3D work now. Add reviewed private Azure configuration and obtain each live-stage approval in chat before ingestion or Q&A.";
  const app = express(), cookie = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
  const workflow = config ? createPersonalWorkflow(store, config, options.credential ?? cliCredential(config), options.transport) : null;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    if (req.get("host") !== origin.host || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? ""))
      return next(new HttpError(403, "Use the printed loopback origin"));
    const entryNavigation = req.method === "GET" && req.path === "/" &&
      req.get("sec-fetch-mode") === "navigate" && req.get("sec-fetch-dest") === "document";
    if (!entryNavigation && req.get("sec-fetch-site") && !["same-origin", "none"].includes(req.get("sec-fetch-site")!))
      return next(new HttpError(403, "Cross-site local requests are refused"));
    next();
  });
  app.get("/api/profile", (_req, res) => res.json({ profile: "personal-file", activated: false, blockers: blocker ? [blocker] : ["Each live stage requires a concrete chat approval"] }));
  app.get("/health/live", (_req, res) => res.json({ ok: true, profile: "personal-file", cloudActivated: false }));
  app.get("/api/personal/session", (_req, res) => {
    res.cookie("jevbox-personal", cookie, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 8 * 60 * 60 * 1000 });
    res.json({ csrf });
  });
  app.use("/api/personal", (req, _res, next) => {
    const supplied = req.get("Cookie")?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("jevbox-personal="))?.split("=")[1];
    if (!supplied || Buffer.byteLength(supplied) !== Buffer.byteLength(cookie) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(cookie)))
      return next(new HttpError(401, "Reload the personal workspace to establish its local owner session"));
    if (!["GET", "HEAD"].includes(req.method) && (req.get("Origin") !== options.origin || req.get("X-Jevbox-CSRF") !== csrf))
      return next(new HttpError(403, "A same-origin owner request is required"));
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.get("/api/personal/state", (_req, res) => {
    const state: PersonalState = { configured: !!config, blocker, snapshot: store.snapshot(), operations: store.operations(),
      answers: store.answers(), targets: config ? { source: config.sourceName, kb: config.kbName } : null };
    res.json(state);
  });
  const upload = multer({ storage: multer.memoryStorage(), preservePath: true,
    limits: { files: importLimits.files, fileSize: importLimits.fileBytes, fields: 1, fieldSize: 128000, parts: importLimits.files + 1 } });
  app.post("/api/personal/select", upload.array("files", importLimits.files), (req, res) => {
    if (!Array.isArray(req.files) || !req.files.length) throw new HttpError(400, "Choose files first");
    const paths = z.array(relativeImportPath).min(1).max(importLimits.files).parse(JSON.parse(req.body.paths));
    if (paths.length !== req.files.length || new Set(paths.map((path) => path.toLowerCase())).size !== paths.length ||
        req.files.reduce((sum, file) => sum + file.size, 0) > importLimits.batchBytes)
      throw new HttpError(400, "Selection has duplicate paths or exceeds the published file/batch limits");
    const files = req.files.map((file, index) => {
      const mime = importMime(paths[index]);
      if (!mime) throw new HttpError(400, "Unsupported local candidate; native content admission remains authoritative");
      return { path: paths[index], mime, body: file.buffer };
    });
    res.status(201).json(store.select(files));
  });
  app.get("/api/personal/originals/:id", (req, res) => {
    const document = store.snapshot()?.documents.find((file) => file.id === req.params.id);
    if (!document) throw new HttpError(404, "Original unavailable");
    res.set("Content-Security-Policy", "sandbox; default-src 'none'");
    res.type(document.mime).send(store.body(document.id));
  });
  app.get("/api/personal/provenance", (_req, res) => {
    const snapshot = store.snapshot();
    const schema = snapshot ? store.db.prepare("SELECT body,created FROM journal j JOIN operations o ON o.id=j.operation_id WHERE o.snapshot_id=? AND j.event='index-schema' ORDER BY sequence DESC LIMIT 1").get(snapshot.id) : null;
    const statistics = snapshot ? store.db.prepare("SELECT body,created FROM journal j JOIN operations o ON o.id=j.operation_id WHERE o.snapshot_id=? AND j.event='index-statistics' ORDER BY sequence DESC LIMIT 1").get(snapshot.id) : null;
    res.json({ targets: config ? { source: config.sourceName, kb: config.kbName, index: snapshot?.indexName,
      portal: `https://portal.azure.com/#resource${config.searchResourceId.split("/").map(encodeURIComponent).join("/")}/overview` } : null,
      schema: schema ? JSON.parse(String(schema.body)) : null, observedAt: schema?.created ?? null,
      statistics: statistics ? { ...JSON.parse(String(statistics.body)), observedAt: statistics.created } : null,
      verification: snapshot?.state ?? "local", inspection: "Metadata is last verified readback, not a new Azure request. Content inspection needs its separate chat approval." });
  });
  app.post("/api/personal/execute/:id", async (req, res) => {
    if (!workflow) throw new HttpError(409, blocker!);
    const body = z.strictObject({ stage: stageSchema, question: z.string().trim().min(1).max(4000).optional() }).parse(req.body);
    await workflow(String(req.params.id), body.stage, body.question);
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "Only the explicit personal-profile API is available here" }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!(error instanceof HttpError) && !(error instanceof z.ZodError) && !(error instanceof multer.MulterError))
      console.error("Personal request failed; no raw provider response or credentials logged");
    res.status(error instanceof HttpError ? error.status : error instanceof z.ZodError || error instanceof multer.MulterError ? 400 : 500)
      .json({ error: error instanceof HttpError ? error.message : "Request validation or storage failed; inspect the local workflow state" });
  });
  return { app, store, closeStreams() {}, async close() { store.close(); unlock(); } };
}
