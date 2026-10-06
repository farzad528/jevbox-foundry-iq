import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { PDFDocument } from "pdf-lib";
import { createKnowledgeLifecycle } from "../server/foundry/lifecycle";
import { evaluation, fixtureEvidence, fixtureSources, fixtureWorkspace } from "./foundry-fixtures";

async function database() {
  const db = new PGlite();
  await db.exec("CREATE TABLE orgs(id text primary key); CREATE TABLE resources(id text primary key); CREATE TABLE chat_turns(id text primary key);");
  await db.exec(await readFile(new URL("../server/migrations/025-run-observability.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../server/migrations/026-foundry-knowledge.sql", import.meta.url), "utf8"));
  await db.query("INSERT INTO orgs(id) VALUES($1)", [fixtureWorkspace]);
  for (const source of evaluation.documents)
    await db.query("INSERT INTO resources(id) VALUES($1)", [source.id]);
  let queryable: PGlite | Transaction = db;
  let inTransaction = false;
  const parameterize = (sql: string) => {
    let sequence = 0;
    return sql.replace(/'[^']*'|\?/g, (match) => match === "?" ? `$${++sequence}` : match);
  };
  const store = {
    async all<T = Record<string, unknown>>(sql: string, ...values: unknown[]) {
      return (await queryable.query<T>(parameterize(sql), values)).rows;
    },
    async one<T = Record<string, unknown>>(sql: string, ...values: unknown[]) {
      return (await queryable.query<T>(parameterize(sql), values)).rows[0];
    },
    async run(sql: string, ...values: unknown[]) {
      return { changes: (await queryable.query(parameterize(sql), values)).affectedRows ?? 0 };
    },
    async transaction<T>(fn: () => T | Promise<T>) {
      if (inTransaction) return fn();
      return db.transaction(async (tx) => {
        inTransaction = true;
        queryable = tx;
        try { return await fn(); }
        finally { inTransaction = false; queryable = db; }
      });
    },
  };
  return { db, store, lifecycle: createKnowledgeLifecycle(store) };
}

test("additive PostgreSQL migrations constrain observability and native lifecycle states", async () => {
  const { db } = await database();
  try {
    await assert.rejects(() => db.query("INSERT INTO chat_turns(id,observability) VALUES('run','[]')"));
    await assert.rejects(() => db.query("INSERT INTO knowledge_source_state(document_id,workspace_id,tenant_id,source_revision,acl_revision,generation,readers,state) VALUES($1,$2,'tenant',0,1,1,'[]','verified')",
      [evaluation.documents[0].id, fixtureWorkspace]));
  } finally { await db.close(); }
});

test("outbox persists per-item failures, blocks reads and fences obsolete retries", async () => {
  const { db, store, lifecycle } = await database();
  try {
    const source = fixtureSources.get(evaluation.documents[0].id)!;
    const initial = await lifecycle.transition(source, "publish");
    assert.equal((await lifecycle.sources(fixtureWorkspace)).get(source.documentId)?.state, "pending");
    const attempt = await lifecycle.claim(initial.id);
    await assert.rejects(() => lifecycle.claim(initial.id), /already claimed/);
    let deniedChecks = 0;
    await assert.rejects(() => lifecycle.publish(attempt, ["a", "b"], async () => ({
      value: [
        { key: "a", status: true, statusCode: 200 },
        { key: "b", status: false, statusCode: 503, errorMessage: "Private upstream payload must not persist" },
      ],
    }), async () => { deniedChecks++; }), /remains pending/);
    assert.equal(deniedChecks, 0);
    assert.equal((await lifecycle.sources(fixtureWorkspace)).get(source.documentId)?.state, "failed");
    const saved = await store.one<{ state: string; item_results: unknown }>("SELECT state,item_results FROM knowledge_outbox WHERE id=?", initial.id);
    assert.equal(saved?.state, "failed");
    assert.deepEqual(saved?.item_results, [
      { key: "a", status: true, statusCode: 200 }, { key: "b", status: false, statusCode: 503 },
    ]);
    const retry = await lifecycle.claim(initial.id);
    const change = await lifecycle.transition({ ...source, aclRevision: 2 }, "acl-sync");
    let writes = 0;
    await assert.rejects(() => lifecycle.publish(retry, ["a"], async () => { writes++; return {}; }, async () => {}), /Obsolete/);
    assert.equal(writes, 0);
    const current = await lifecycle.claim(change.id);
    await lifecycle.publish(current, ["a"], async () => ({ value: [{ key: "a", status: true, statusCode: 200 }] }),
      async () => { deniedChecks++; });
    assert.equal(deniedChecks, 1);
    assert.equal((await lifecycle.sources(fixtureWorkspace)).get(source.documentId)?.state, "verified");
  } finally { await db.close(); }
});

test("native denial failure stays blocked; source revision invalidates dependent wiki", async () => {
  const { db, store, lifecycle } = await database();
  try {
    const source = fixtureSources.get(evaluation.documents[0].id)!;
    const first = await lifecycle.transition(source, "publish");
    const attempt = await lifecycle.claim(first.id);
    await assert.rejects(() => lifecycle.publish(attempt, ["a"], async () => ({
      value: [{ key: "a", status: true, statusCode: 200 }],
    }), async () => { throw new Error("Native denial not observed"); }), /not observed/);
    assert.equal((await lifecycle.sources(fixtureWorkspace)).get(source.documentId)?.state, "failed");
    await store.run("INSERT INTO knowledge_wiki_revisions(workspace_id,page_id,revision,state,raw_source_ids,payload) VALUES(?,'page',1,'published',?,'{}')",
      fixtureWorkspace, [source.documentId]);
    const changed = await lifecycle.transition({ ...source, sourceRevision: 2 }, "source-change");
    const wiki = await store.one<{ state: string }>("SELECT state FROM knowledge_wiki_revisions WHERE page_id='page'");
    assert.equal(wiki?.state, "stale");
    const deletion = await lifecycle.transition({ ...source, sourceRevision: 3 }, "delete");
    await assert.rejects(() => lifecycle.claim(changed.id), /Obsolete/);
    const deletionAttempt = await lifecycle.claim(deletion.id);
    await lifecycle.publish(deletionAttempt, ["a"], async () => ({ value: [{ key: "a", status: true, statusCode: 200 }] }), async () => {});
    assert.equal((await lifecycle.sources(fixtureWorkspace)).get(source.documentId)?.state, "deleted");
  } finally { await db.close(); }
});

test("synthetic assets are original bytes; PDF generation spec is never indexed as parsed evidence", async () => {
  for (const source of evaluation.documents) {
    const bytes = await readFile(new URL(`./fixtures/foundry-documents/${source.fileName}`, import.meta.url));
    if (source.lines) assert.equal(bytes.toString("utf8").trimEnd(), source.lines.join("\n").trimEnd());
    else {
      const pdf = await PDFDocument.load(bytes);
      assert.equal(pdf.getPageCount(), 2);
      assert.equal(source.nativeParsingVerified, false);
      assert.equal(fixtureEvidence.some((unit) => unit.artifactId === source.id), false);
    }
  }
});
