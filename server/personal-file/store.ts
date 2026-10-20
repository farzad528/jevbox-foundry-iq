import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { HttpError } from "../errors";
import { boundsSchema, type PersonalAnswer, type PersonalBounds, type PersonalConfig, type PersonalDocument, type PersonalSnapshot, type PersonalStage } from "../../shared/personal-file";

export function protectDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Private data directory must not be a link");
  if (process.platform !== "win32") { chmodSync(directory, 0o700); return; }
  const sid = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error("Private directory owner unavailable");
  execFileSync("icacls", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
  const script = `$a=Get-Acl -LiteralPath '${directory.replaceAll("'", "''")}'; if(@($a.Access | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne '${sid}'}).Count -gt 0){exit 1}`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "ignore", windowsHide: true });
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export type Plan = {
  id: string; stage: PersonalStage; snapshotId: string; config: PersonalConfig; configDigest: string;
  manifest: { id: string; path: string; hash: string; size: number }[];
  mode: "create" | "continue";
  preflightDigest: string;
  bounds: PersonalBounds; expiresAt: string; payloadDigest: string;
};
export class PersonalStore {
  readonly db: DatabaseSync;
  constructor(directory: string, options: { recoverInterrupted?: boolean } = {}) {
    protectDirectory(resolve(directory));
    this.db = new DatabaseSync(join(resolve(directory), "catalog.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, created TEXT NOT NULL, state TEXT NOT NULL, error TEXT,
        index_name TEXT, source_etag TEXT, kb_etag TEXT, config_digest TEXT);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
        path TEXT NOT NULL, mime TEXT NOT NULL, body BLOB NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, file_id TEXT, error TEXT,
        UNIQUE(snapshot_id,path));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
        stage TEXT NOT NULL, plan TEXT NOT NULL, state TEXT NOT NULL, approval_reference TEXT, questions_used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES operations(id),
        event TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS answers(id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_id TEXT NOT NULL REFERENCES snapshots(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget(id INTEGER PRIMARY KEY CHECK(id=1), available REAL NOT NULL, reserved REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS preflight(id INTEGER PRIMARY KEY CHECK(id=1), config_digest TEXT NOT NULL, observed TEXT NOT NULL, evidence TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(id INTEGER PRIMARY KEY CHECK(id=1), operation_id TEXT NOT NULL);`);
    if (options.recoverInterrupted) this.db.exec(`UPDATE documents SET state='uncertain', error='Interrupted upload; no automatic replay' WHERE state='sending';
      UPDATE operations SET state='uncertain' WHERE state='running' AND stage<>'chat';
      UPDATE operations SET state='approved' WHERE state='running' AND stage='chat';
      UPDATE snapshots SET state='partial',error='Interrupted native operation; retained journals must be reconciled without replay'
        WHERE state='ingesting' AND EXISTS(SELECT 1 FROM operations WHERE snapshot_id=snapshots.id AND state='uncertain');
      DELETE FROM leases;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  snapshot(): PersonalSnapshot | null {
    const row = this.db.prepare("SELECT * FROM snapshots ORDER BY rowid DESC LIMIT 1").get();
    if (!row) return null;
    const docs = this.db.prepare("SELECT id,path,mime,length(body) AS size,state,file_id,error FROM documents WHERE snapshot_id=? ORDER BY path").all(String(row.id));
    return { id: String(row.id), created: String(row.created), state: String(row.state), error: row.error === null ? null : String(row.error),
      indexName: row.index_name === null ? null : String(row.index_name), sourceEtag: row.source_etag === null ? null : String(row.source_etag),
      kbEtag: row.kb_etag === null ? null : String(row.kb_etag),
      documents: docs.map((doc) => ({ id: String(doc.id), path: String(doc.path), mime: String(doc.mime), size: Number(doc.size),
        state: z.enum(["local", "sending", "indexed", "uncertain", "failed"]).parse(doc.state),
        nativeFileId: doc.file_id === null ? null : String(doc.file_id), error: doc.error === null ? null : String(doc.error) })) };
  }
  select(files: { path: string; mime: string; body: Buffer }[]) {
    return this.transaction(() => {
      if (this.snapshot()) throw new HttpError(409, "An immutable snapshot already exists. Use a separate private data directory for another reviewed collection.");
      const id = randomUUID();
      this.db.prepare("INSERT INTO snapshots(id,created,state) VALUES(?,?,'local')").run(id, new Date().toISOString());
      for (const file of files) this.db.prepare("INSERT INTO documents(id,snapshot_id,path,mime,body,hash,state) VALUES(?,?,?,?,?,?,'local')")
        .run(randomUUID(), id, file.path, file.mime, file.body, createHash("sha256").update(file.body).digest("hex"));
      return this.snapshot()!;
    });
  }
  body(id: string) {
    const row = this.db.prepare("SELECT body FROM documents WHERE id=?").get(id);
    if (!row || !(row.body instanceof Uint8Array)) throw new HttpError(404, "Original unavailable");
    return Buffer.from(row.body);
  }
  manifest(snapshotId: string) {
    return this.db.prepare("SELECT id,path,hash,length(body) AS size FROM documents WHERE snapshot_id=? ORDER BY path").all(snapshotId)
      .map((row) => ({ id: String(row.id), path: String(row.path), hash: String(row.hash), size: Number(row.size) }));
  }
  makePlan(stage: PersonalStage, config: PersonalConfig, input: PersonalBounds) {
    const snapshot = this.snapshot(); if (!snapshot) throw new HttpError(409, "Select a local snapshot first");
    const bounds = boundsSchema.parse(input);
    const preflight = this.requirePreflight(config);
    this.requireSnapshotConfig(stage, config);
    const partial = { id: randomUUID(), stage, mode: snapshot.state === "partial" ? "continue" as const : "create" as const,
      snapshotId: snapshot.id, config, configDigest: digest(config), preflightDigest: digest(JSON.parse(String(preflight.evidence))),
      manifest: this.manifest(snapshot.id), bounds, expiresAt: new Date(Date.parse(String(preflight.observed)) + 30 * 60_000).toISOString() };
    const plan: Plan = { ...partial, payloadDigest: digest(partial) };
    this.db.prepare("INSERT INTO operations(id,snapshot_id,stage,plan,state) VALUES(?,?,?,?,'pending')").run(plan.id, snapshot.id, stage, JSON.stringify(plan));
    return plan;
  }
  plan(id: string): Plan {
    const row = this.db.prepare("SELECT plan FROM operations WHERE id=?").get(id);
    if (!row) throw new HttpError(404, "Operation unavailable");
    const plan = JSON.parse(String(row.plan)) as Plan;
    const { payloadDigest, ...payload } = plan;
    if (digest(payload) !== payloadDigest) throw new HttpError(409, "Operation integrity failed");
    return plan;
  }
  approve(id: string, reference: string) {
    if (!reference.trim() || reference.length > 1000) throw new Error("An explicit human approval reference is required");
    const plan = this.plan(id);
    const preflight = this.requirePreflight(plan.config);
    if (digest(JSON.parse(String(preflight.evidence))) !== plan.preflightDigest)
      throw new Error("Metadata context changed; generate a fresh proposal");
    if (Date.parse(plan.expiresAt) <= Date.now()) throw new Error("Operation expired; generate a fresh proposal");
    this.transaction(() => {
      if (this.db.prepare("SELECT state FROM operations WHERE id=?").get(id)?.state !== "pending") throw new Error("Operation is not awaiting approval");
      this.db.prepare("INSERT OR IGNORE INTO budget(id,available,reserved) VALUES(1,?,0)").run(plan.bounds.remainingBudgetUsd);
      const budget = this.db.prepare("SELECT available,reserved FROM budget WHERE id=1").get()!;
      if (plan.bounds.incrementalAllowanceUsd > Math.min(Number(budget.available) - Number(budget.reserved), plan.bounds.remainingBudgetUsd))
        throw new Error("Allowance exceeds the retained remaining-budget reservations; do not reset the ceiling");
      this.db.prepare("UPDATE budget SET reserved=reserved+? WHERE id=1").run(plan.bounds.incrementalAllowanceUsd);
      this.db.prepare("UPDATE operations SET state='approved',approval_reference=? WHERE id=?").run(reference, id);
    });
  }
  acquire(id: string, config: PersonalConfig) {
    return this.transaction(() => {
      const plan = this.plan(id), snapshot = this.snapshot();
      const preflight = this.requirePreflight(config);
      this.requireSnapshotConfig(plan.stage, config);
      if (Date.parse(plan.expiresAt) <= Date.now() || digest(config) !== plan.configDigest ||
          digest(JSON.parse(String(preflight.evidence))) !== plan.preflightDigest || snapshot?.id !== plan.snapshotId || digest(this.manifest(snapshot.id)) !== digest(plan.manifest))
        throw new HttpError(409, "Approval expired or selected payload/configuration changed");
      if (this.db.prepare("SELECT id FROM leases").get()) throw new HttpError(409, "Another operation is in progress; do not replay it");
      const row = this.db.prepare("SELECT state,questions_used FROM operations WHERE id=?").get(id);
      if (row?.state !== "approved" || (plan.stage === "chat" && Number(row.questions_used) >= plan.bounds.questions))
        throw new HttpError(403, "A current concrete approval with remaining allowance is required");
      this.db.prepare("INSERT INTO leases(id,operation_id) VALUES(1,?)").run(id);
      this.db.prepare("UPDATE operations SET state='running',questions_used=questions_used+? WHERE id=?").run(plan.stage === "chat" ? 1 : 0, id);
      return plan;
    });
  }
  recordPreflight(config: PersonalConfig, evidence: unknown) {
    this.db.prepare("INSERT INTO preflight(id,config_digest,observed,evidence) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET config_digest=excluded.config_digest,observed=excluded.observed,evidence=excluded.evidence")
      .run(digest(config), new Date().toISOString(), JSON.stringify(evidence));
  }
  requirePreflight(config: PersonalConfig) {
    const row = this.db.prepare("SELECT * FROM preflight WHERE id=1").get();
    if (!row || row.config_digest !== digest(config) || Date.parse(String(row.observed)) + 30 * 60_000 <= Date.now())
      throw new HttpError(409, "Fresh exact-resource read-only preflight is required before planning/approval/execution");
    return row;
  }
  private requireSnapshotConfig(stage: PersonalStage, config: PersonalConfig) {
    const row = this.db.prepare("SELECT config_digest FROM snapshots ORDER BY rowid DESC LIMIT 1").get();
    if (stage !== "ingest" && row?.config_digest && row.config_digest !== digest(config))
      throw new HttpError(409, "Indexed snapshot configuration changed; an explicit migration is required, not a new chat allowance");
  }
  release(plan: Plan, success: boolean) {
    this.transaction(() => {
      this.db.prepare("UPDATE operations SET state=? WHERE id=?").run(plan.stage === "chat" ? "approved" : success ? "completed" : "uncertain", plan.id);
      this.db.prepare("DELETE FROM leases WHERE operation_id=?").run(plan.id);
    });
  }
  journal(plan: Plan, event: string, body: unknown) {
    this.db.prepare("INSERT INTO journal(operation_id,event,body,created) VALUES(?,?,?,?)").run(plan.id, event, JSON.stringify(body), new Date().toISOString());
  }
  setSnapshot(state: string, error: string | null = null) {
    this.db.prepare("UPDATE snapshots SET state=?,error=? WHERE id=?").run(state, error, this.snapshot()!.id);
  }
  setDocument(id: string, state: PersonalDocument["state"], fileId: string | null = null, error: string | null = null) {
    this.db.prepare("UPDATE documents SET state=?,file_id=?,error=? WHERE id=?").run(state, fileId, error, id);
  }
  operations() {
    return this.db.prepare("SELECT id,stage,state,plan,questions_used FROM operations ORDER BY rowid DESC").all().map((row) => {
      const plan = this.plan(String(row.id));
      const preflight = this.db.prepare("SELECT config_digest,observed,evidence FROM preflight WHERE id=1").get();
      const stale = Date.parse(plan.expiresAt) <= Date.now() || !preflight || preflight.config_digest !== plan.configDigest ||
        Date.parse(String(preflight.observed)) + 30 * 60_000 <= Date.now() || digest(JSON.parse(String(preflight.evidence))) !== plan.preflightDigest;
      return { id: plan.id, stage: plan.stage, state: row.state === "approved" && stale ? "approval-stale" : String(row.state), expiresAt: plan.expiresAt,
        questionsUsed: Number(row.questions_used), questionLimit: plan.bounds.questions };
    });
  }
  answers(): PersonalAnswer[] { return this.db.prepare("SELECT body FROM answers ORDER BY id").all().map((row) => JSON.parse(String(row.body)) as PersonalAnswer); }
  answer(value: PersonalAnswer) { this.db.prepare("INSERT INTO answers(snapshot_id,body) VALUES(?,?)").run(this.snapshot()!.id, JSON.stringify(value)); }
  close() { this.db.close(); }
}
