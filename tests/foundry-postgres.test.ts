import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createPrivatePostgres } from "./foundry-postgres-cluster";
import { createFoundryDatabase } from "../server/foundry/database";
import { createNativeQueueRuntime } from "../server/foundry/queue-runtime";
import { createKnowledgeEngine, type KnowledgeAuth } from "../server/foundry/engine";
import { createIqClient } from "../server/foundry/iq-client";
import { createFoundryModels } from "../server/foundry/model-client";
import { createSearchWriter } from "../server/foundry/search-index";
import { createNativeAgentClient } from "../server/foundry/native-agent";
import { DelegatedCredential } from "../server/foundry/credentials";
import { nativeBinding, runtimeConfigSchema } from "../server/foundry/runtime-config";
import { searchApiVersion } from "../server/foundry/config";
import { buildIndex } from "../server/indexing";
import { runSnapshotSchema } from "../shared/observability";
import { type Evidence } from "../shared/evidence";
import { testConfig, testOids } from "./foundry-fixtures";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually<T>(label: string, read: () => Promise<T | undefined | false>, timeout = 40000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const bin = process.env.PG_TEST_BIN;
test("OPT-IN REAL PostgreSQL + extracted pg-boss queue runtime (NOT full app HTTP startup); SYNTHETIC providers", {
  skip: bin ? false : "UNVERIFIED: PG_TEST_BIN absent; standalone PostgreSQL/pg-boss operations were not exercised",
  timeout: 240000,
}, async (t) => {
  const dispatcher = getGlobalDispatcher();
  const networkBlock = new MockAgent();
  networkBlock.disableNetConnect();
  setGlobalDispatcher(networkBlock);
  t.after(async () => { setGlobalDispatcher(dispatcher); await networkBlock.close(); });
  const scenario = async (name: string, run: () => Promise<void>) => {
    let failure: unknown;
    await t.test(name, async () => {
      try { await run(); } catch (error) { failure = error; throw error; }
    });
    if (failure !== undefined) throw failure;
  };
  const forbiddenHttp = () => { throw new Error("All external HTTP is forbidden in real-PostgreSQL verification"); };
  t.mock.method(globalThis, "fetch", async () => forbiddenHttp());
  for (const transport of [http, https]) {
    t.mock.method(transport, "request", forbiddenHttp);
    t.mock.method(transport, "get", forbiddenHttp);
  }
  const cluster = await createPrivatePostgres(bin!);
  t.after(() => cluster.stop());
  const schema = `fiq_pgtest_${randomBytes(6).toString("hex")}`;
  const encryptionKey = randomBytes(32).toString("hex");
  let store: Awaited<ReturnType<typeof createFoundryDatabase>> | undefined;
  let runtime: Awaited<ReturnType<typeof createNativeQueueRuntime>> | undefined;
  const extraRuntimes: Awaited<ReturnType<typeof createNativeQueueRuntime>>[] = [];
  const releases: (() => void)[] = [];
  const keyPair = await generateKeyPair("RS256");
  const credentials = new Map<string, DelegatedCredential>();
  const tokenOwners = new Map<string, string>();
  const sessionIds = new Map(testConfig.roster.map((oid, index) => [oid, String(index + 1).repeat(64)]));
  for (const oid of testConfig.roster) {
    const token = await new SignJWT({ tid: testConfig.tenantId, oid, scp: "user_impersonation" })
      .setProtectedHeader({ alg: "RS256" }).setIssuer("https://postgres-fixture.invalid/issuer")
      .setAudience("https://search.azure.com").setIssuedAt().setExpirationTime("1h").sign(keyPair.privateKey);
    tokenOwners.set(token, oid);
    credentials.set(oid, await DelegatedCredential.verify({
      token, sessionIdentity: { tenantId: testConfig.tenantId, objectId: oid },
      tenantId: testConfig.tenantId, audience: "https://search.azure.com", issuer: "https://postgres-fixture.invalid/issuer",
      delegatedScope: "user_impersonation", roster: testConfig.roster, key: async () => keyPair.publicKey,
    }));
  }
  const configInput = {
    knowledge: testConfig, databaseSchema: schema, workspaceName: "Private synthetic PostgreSQL verification",
    agentName: "postgres-fixture-agent", entraClientId: randomUUID(), readerClientId: randomUUID(),
    writerClientId: randomUUID(), projectClientId: randomUUID(),
    approvals: { entraConsent: true, cloudCalls: true, syntheticUploads: true, vendorProcessing: true },
  };
  // This in-memory attestation enables only this harness's injected transports, never the dev app.
  const config = runtimeConfigSchema.parse({ ...configInput, nativeProof: {
    binding: nativeBinding(configInput), verifiedAt: new Date().toISOString(), tenantId: testConfig.tenantId,
    roster: testConfig.roster, knowledgeBaseName: testConfig.knowledgeBaseName, projectEndpoint: testConfig.projectEndpoint,
    checks: { restTwoUserAcl: true, restAdverseTokens: true, mcpTwoUserAcl: true, mcpAdverseTokens: true,
      mcpOriginalLocators: true, hybridLowExtractive: true, projectModelDeployments: true },
  } });
  const identity = { tenantId: testConfig.tenantId, objectId: testOids.A };
  const sessionId = sessionIds.get(testOids.A)!;
  const auth: KnowledgeAuth = {
    async authenticate() { return { identity, sessionId }; },
    async credential() { return credentials.get(testOids.A)!; },
    async identityForSession(id) {
      const oid = [...sessionIds].find(([, value]) => value === id)?.[0];
      assert(oid, "Only synthetic sessions are accepted");
      return { tenantId: testConfig.tenantId, objectId: oid };
    },
    async credentialForSession(id) { return credentials.get((await this.identityForSession(id)).objectId)!; },
    async credentialsForRoster() { return testConfig.roster.map((oid) => credentials.get(oid)!); },
  };
  const targets = {
    index: `${testConfig.searchEndpoint}/indexes/${testConfig.indexName}/docs/index?api-version=${searchApiVersion}`,
    search: `${testConfig.searchEndpoint}/indexes/${testConfig.indexName}/docs/search?api-version=${searchApiVersion}`,
    retrieve: `${testConfig.searchEndpoint}/knowledgebases/${testConfig.knowledgeBaseName}/retrieve?api-version=${searchApiVersion}`,
    embeddings: `${testConfig.projectEndpoint}/openai/v1/embeddings`,
    answer: `${testConfig.projectEndpoint}/openai/v1/chat/completions`,
    agent: `${testConfig.projectEndpoint}/openai/v1/responses`,
    vendor: "https://api.typesafe.ai/v1/systemone",
  };
  type Indexed = { id: string; artifactId: string; userIds: string[]; sourceRevision: number; aclRevision: number };
  const nativeIndex = new Map<string, Indexed>();
  const counts = new Map<string, number>();
  let partialFailure = false;
  let modelHold: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  let parseHold: { documentId: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  const fetcher: typeof fetch = async (url, options) => {
    const target = String(url);
    assert(Object.values(targets).includes(target), "Unexpected provider target blocked before any HTTP");
    assert.equal(options?.method, "POST");
    options?.signal?.throwIfAborted();
    counts.set(target, (counts.get(target) ?? 0) + 1);
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    const headers = new Headers(options?.headers);
    const available = async (oid: string) => (await store!.all<{ payload: Evidence }>(
      "SELECT payload FROM knowledge_evidence WHERE current AND retrievable",
    )).map(({ payload }) => payload).filter((unit) => nativeIndex.get(unit.indexKey)?.userIds.includes(oid));
    if (target === targets.index) {
      assert.equal(headers.get("Authorization"), "Bearer synthetic-writer");
      const items = z.array(z.object({
        id: z.string(), "@search.action": z.string(), artifactId: z.string().optional(),
        userIds: z.array(z.string()).optional(), sourceRevision: z.number().optional(), aclRevision: z.number().optional(),
      })).min(1).parse(body.value);
      return response({ value: items.map((item, index) => {
        const ok = !partialFailure || index === 0;
        if (ok) {
          if (item["@search.action"] === "delete") nativeIndex.delete(item.id);
          else nativeIndex.set(item.id, { id: item.id, artifactId: item.artifactId!, userIds: item.userIds!,
            sourceRevision: item.sourceRevision!, aclRevision: item.aclRevision! });
        }
        return { key: item.id, status: ok, statusCode: ok ? 200 : 503,
          errorMessage: ok ? null : "SYNTHETIC PRIVATE PROVIDER DETAILS MUST NOT PERSIST" };
      }) });
    }
    if (target === targets.search || target === targets.retrieve) {
      assert.equal(headers.get("Authorization"), "Bearer synthetic-reader");
      const oid = tokenOwners.get(headers.get("x-ms-query-source-authorization") ?? "");
      assert(oid, "A verified synthetic delegated identity is required");
      if (target === targets.search) {
        const filter = z.string().parse(body.filter);
        const keys = [...filter.matchAll(/id eq '([^']+)'/g)].map((match) => match[1]);
        const artifact = filter.match(/artifactId eq '([^']+)'/)?.[1];
        return response({ value: [...nativeIndex.values()].filter((item) =>
          item.userIds.includes(oid) && (artifact ? item.artifactId === artifact : keys.includes(item.id))).map(({ id }) => ({ id })) });
      }
      const units = await available(oid);
      return response({
        response: [{ role: "assistant", content: [{ type: "text",
          text: JSON.stringify(units.map((unit, index) => ({ ref_id: String(index), content: unit.text }))) }] }],
        references: units.map((unit, index) => ({ type: "searchIndex", id: String(index), activitySource: 0, docKey: unit.indexKey })),
        activity: [{ id: 0, type: "modelQueryPlanning", inputTokens: 7, outputTokens: 2 }],
      });
    }
    if (target === targets.vendor) {
      assert.equal(headers.get("Authorization"), "Bearer synthetic-vendor");
      const menu = z.object({ placement: z.object({ criteria: z.record(z.string(), z.string()) }) }).parse(body.questions).placement.criteria;
      const selected = "here" in menu ? "here" : Object.keys(menu).find((id) => id !== "none")!;
      return response({ answers: { placement: { probabilities: Object.fromEntries(Object.keys(menu).map((id) => [id, id === selected ? 1 : 0])) } } });
    }
    assert.equal(headers.get("Authorization"), "Bearer synthetic-project");
    if (target === targets.embeddings) {
      assert.equal(body.model, testConfig.embeddingDeployment);
      const texts = z.array(z.string()).parse(body.input);
      return response({ data: texts.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })), usage: { prompt_tokens: texts.length * 5 } });
    }
    if (target === targets.agent) {
      const oid = tokenOwners.get(z.object({ search_auth_token: z.string() }).parse(body.structured_inputs).search_auth_token);
      assert(oid);
      const unit = (await available(oid))[0];
      assert(unit);
      return response({ id: "synthetic-native-response", status: "completed", output: [
        { type: "mcp_call", id: "synthetic-tool-call", name: "knowledge_base_retrieve", output: JSON.stringify({
          content: [{ type: "text", text: JSON.stringify([{ ref_id: "0", content: unit.text, title: unit.title,
            terms: JSON.stringify({ schemaVersion: 1, indexKey: unit.indexKey }) }]) }],
        }) },
        { type: "message", content: [{ type: "output_text", text: `Synthetic release evidence [0]` }] },
      ], usage: { input_tokens: 9, output_tokens: 3 } });
    }
    assert.equal(body.model, testConfig.answerDeployment);
    const messages = z.array(z.object({ role: z.string(), content: z.string() })).parse(body.messages);
    const evidence = z.object({ evidence: z.array(z.object({ id: z.string() })).min(1) }).parse(JSON.parse(messages[1].content)).evidence;
    const hold = modelHold;
    modelHold = undefined;
    if (hold) {
      hold.entered.resolve();
      await hold.release.promise;
      options?.signal?.throwIfAborted();
    }
    return response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      answer: `Synthetic release evidence [${evidence[0].id}]`, evidenceIds: [evidence[0].id],
    }) } }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
  };
  const service = (name: string) => async () => ({ token: `synthetic-${name}`, expiresAt: Date.now() + 3600000 });
  const makeEngine = () => createKnowledgeEngine({
    store: store!, config, auth, enqueue: (kind, id) => runtime!.enqueue(kind, id),
    iq: createIqClient(testConfig, service("reader"), fetcher),
    models: createFoundryModels(testConfig, service("project"), fetcher),
    writer: createSearchWriter(testConfig, service("writer"), fetcher),
    agent: createNativeAgentClient({ config: testConfig, projectEndpoint: testConfig.projectEndpoint,
      agentName: config.agentName, projectCredential: service("project"), fetcher }),
    readerCredential: service("reader"), decision: { provider: "typesafe", key: "synthetic-vendor" }, fetcher,
    async parse(resource, signal, check) {
      const hold = parseHold?.documentId === resource.id ? parseHold : undefined;
      if (hold) { parseHold = undefined; hold.entered.resolve(); await hold.release.promise; }
      signal.throwIfAborted(); await check();
      const original = await store!.one<{ body: Buffer }>(
        "SELECT body FROM knowledge_originals WHERE document_id=? ORDER BY source_revision DESC LIMIT 1", resource.id,
      );
      assert(original);
      return buildIndex([{ content: Buffer.from(original.body).toString("utf8") }], "text");
    },
  });
  let engine: ReturnType<typeof makeEngine>;
  const scope = { workspaceId: testConfig.workspaceId, documentIds: [], folderIds: [], fileTypes: [] };
  const document = async (id = randomUUID(), text = "# Release\nSynthetic release date is October 15.", manual = false) => {
    await store!.run(
      "INSERT INTO resources(id,org_id,owner_id,kind,name,mime,size,access,created,status,knowledge_manual) VALUES(?,?,?,'document',?,'text/markdown',?,'restricted',?,'processing',?)",
      id, testConfig.workspaceId, testOids.A, "synthetic-release.md", Buffer.byteLength(text), new Date().toISOString(), manual,
    );
    await store!.run("INSERT INTO knowledge_originals(document_id,source_revision,body) VALUES(?,1,?)", id, Buffer.from(text));
    return id;
  };
  const finished = (id: string, state = "completed") => eventually(`request ${state}`, async () => {
    const row = await store!.one<{ state: string; result: unknown; error_code: string | null; observability: unknown }>(
      "SELECT state,result,error_code,observability FROM knowledge_requests WHERE id=?", id,
    );
    return row?.state === state && row;
  });
  const synchronized = (id: string, state = "verified") => eventually(`outbox ${state}`, async () => {
    const row = await store!.one<{ state: string; attempts: number; item_results: unknown }>("SELECT state,attempts,item_results FROM knowledge_outbox WHERE id=?", id);
    return row?.state === state && row;
  });
  const settled = (id: string, kind: "sync" | "request", state = "completed") => eventually(`pg-boss ${state}`, async () => {
    const jobs = await runtime!.queue.findJobs(kind === "sync" ? "knowledge-sync" : "knowledge-request", { key: id });
    return jobs.find((job) => job.state === state);
  });
  let sourceId!: string;
  try {
    store = await createFoundryDatabase(cluster.url, schema, encryptionKey);
    runtime = await createNativeQueueRuntime({ databaseUrl: cluster.url, databaseSchema: schema, store });
    engine = makeEngine();
    await scenario("standalone PostgreSQL 16 is current-user, loopback-only and SCRAM authenticated; full additive migrations are idempotent", async () => {
      await assert.rejects(fetch("https://forbidden-network.invalid"), /external HTTP is forbidden/);
      assert.throws(() => https.get("https://forbidden-network.invalid"), /external HTTP is forbidden/);
      await assert.rejects(fetcher(targets.answer + "?unexpected=true"), /Unexpected provider target/);
      const server = await store!.one<{ version: number; address: string; account: string; encryption: string; scram: boolean }>(
        "SELECT current_setting('server_version_num')::int AS version,host(inet_server_addr()) AS address,current_user AS account,current_setting('password_encryption') AS encryption,(SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname=current_user) AS scram",
      );
      assert(server);
      assert.equal(Math.floor(server.version / 10000), 16);
      assert.equal(server.address, "127.0.0.1");
      assert.equal(server.account, cluster.username);
      assert.equal(server.encryption, "scram-sha-256");
      assert.equal(server.scram, true);
      assert.equal((await store!.one<{ value: string }>("SELECT current_setting('listen_addresses') AS value"))!.value, "127.0.0.1");
      const bad = new URL(cluster.url); bad.password = "deliberately-wrong-synthetic-password";
      const denied = new Pool({ connectionString: bad.toString(), connectionTimeoutMillis: 3000 });
      try { await assert.rejects(denied.query("SELECT 1"), (error: { code: string }) => error.code === "28P01"); }
      finally { await denied.end(); }
      const versions = (await readdir(new URL("../server/migrations/", import.meta.url)))
        .filter((name) => /^\d+-.*\.sql$/.test(name)).map((name) => Number(name.split("-")[0])).sort((a, b) => a - b);
      assert.deepEqual((await store!.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).map(({ version }) => version), versions);
      const repeated = await createFoundryDatabase(cluster.url, schema, encryptionKey);
      try { assert.equal((await repeated.all("SELECT version FROM schema_migrations")).length, versions.length); }
      finally { await repeated.close(); }
      assert.equal((await store!.one<{ count: number }>("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='resources'"))!.count, 0);
      const queue = await runtime!.queue.getQueue("knowledge-sync");
      assert.equal(queue?.retryLimit, 5); assert.equal(queue.retryDelay, 15); assert.equal(queue.retryBackoff, true);
      // Shorten only this disposable queue's retry timer; production defaults above remain unchanged.
      await runtime!.queue.updateQueue("knowledge-sync", { retryDelay: 1, retryBackoff: false });
      await store!.run("INSERT INTO orgs(id,name) VALUES(?,'Synthetic PostgreSQL workspace')", testConfig.workspaceId);
      for (const oid of testConfig.roster) await store!.run("INSERT INTO users(id,name,email) VALUES(?,?,?)", oid, "Synthetic user", `${oid}@synthetic.invalid`);
      await store!.run("INSERT INTO resources(id,org_id,owner_id,kind,name,description,access,created,status) VALUES(?,?,?,'folder','Synthetic release','Synthetic reusable release category','restricted',?,'ready')",
        randomUUID(), testConfig.workspaceId, testOids.A, new Date().toISOString());
    });
    await scenario("real transaction-pinned adapter atomically commits/rolls back engine source + original + outbox + pg-boss job", async () => {
      const rolledBack = randomUUID();
      let rejectedOutbox!: string;
      await assert.rejects(store!.transaction(async () => {
        await document(rolledBack);
        rejectedOutbox = (await engine.transition(await engine.access.resource(rolledBack), "publish", sessionId)).id;
        const outer = await store!.one<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await store!.transaction(async () => assert.equal((await store!.one<{ pid: number }>("SELECT pg_backend_pid() AS pid"))!.pid, outer!.pid));
        assert.equal((await runtime!.queue.findJobs("knowledge-sync", { key: rejectedOutbox })).length, 0, "Separate queue connection cannot observe uncommitted work");
        throw new Error("Intentional synthetic rollback");
      }), /Intentional synthetic rollback/);
      for (const table of ["resources", "knowledge_originals", "knowledge_source_state"])
        assert.equal((await store!.all(`SELECT * FROM ${table} WHERE ${table === "resources" ? "id" : "document_id"}=?`, rolledBack)).length, 0);
      assert.equal((await runtime!.queue.findJobs("knowledge-sync", { key: rejectedOutbox })).length, 0);
      const hold = gate(); const entered = gate(); releases.push(hold.resolve);
      let leftPid!: number;
      const left = store!.transaction(async () => {
        leftPid = (await store!.one<{ pid: number }>("SELECT pg_backend_pid() AS pid"))!.pid;
        await document(rolledBack); entered.resolve(); await hold.promise;
        throw new Error("Concurrent rollback");
      });
      const rejection = assert.rejects(left, /Concurrent rollback/);
      await entered.promise;
      try {
        await store!.transaction(async () => {
          assert.notEqual((await store!.one<{ pid: number }>("SELECT pg_backend_pid() AS pid"))!.pid, leftPid);
          assert.equal(await store!.one("SELECT id FROM resources WHERE id=?", rolledBack), undefined);
          sourceId = await document();
          await engine.transition(await engine.access.resource(sourceId), "publish", sessionId);
        });
      } finally { hold.resolve(); }
      await rejection;
      const pending = (await store!.one<{ id: string }>("SELECT id FROM knowledge_outbox WHERE document_id=?", sourceId))!;
      const job = (await runtime!.queue.findJobs("knowledge-sync", { key: pending.id }))[0];
      assert.equal(job.state, "created");
      assert.deepEqual(job.data, { id: pending.id });
      assert.equal((await store!.one<{ session_id: string }>("SELECT session_id FROM knowledge_outbox WHERE id=?", pending.id))!.session_id, sessionId);
      assert.equal(nativeIndex.size, 0, "Nothing is consumed until actual workers start");
      await runtime!.startWorkers(engine);
      await synchronized(pending.id); await settled(pending.id, "sync");
      assert((counts.get(targets.vendor) ?? 0) >= 2, "Actual JEV adapter used the exact synthetic vendor transport");
    });
    await scenario("real consumers persist IQ/project-model answers and native-agent original citations without token persistence", async () => {
      for (const kind of ["answer", "native-agent"] as const) {
        const id = await engine.createRequest(identity, sessionId, kind, { question: "When is synthetic release?", scope });
        const row = await finished(id); const job = await settled(id, "request");
        assert.deepEqual(job.data, { id });
        assert.equal((await store!.one<{ session_id: string }>("SELECT session_id FROM knowledge_requests WHERE id=?", id))!.session_id, sessionId);
        const run = runSnapshotSchema.parse(row.observability);
        assert.equal(run.events.at(-1)?.kind, "run-completed");
        const result = z.object({ answer: z.string(), evidence: z.array(z.object({ indexKey: z.string(), contentKind: z.literal("raw") })).min(1) }).parse(row.result);
        assert(result.answer.includes(`[${result.evidence[0].indexKey}]`));
      }
      assert.equal(counts.get(targets.answer), 1);
      assert.equal(counts.get(targets.agent), 1);
      const persisted = JSON.stringify(await store!.all("SELECT input,result,observability FROM knowledge_requests"));
      for (const token of tokenOwners.keys()) assert(!persisted.includes(token));
      assert(!persisted.includes("synthetic-project"));
    });
    await scenario("partial native indexing remains locally blocked and genuine pg-boss retry completes the current generation", async () => {
      partialFailure = true;
      const id = await store!.transaction(async () => {
        const id = await document(randomUUID(), ("Synthetic release evidence. ".repeat(180)), true);
        return (await engine.transition(await engine.access.resource(id), "publish", sessionId)).id;
      });
      const failed = await synchronized(id, "failed");
      const results = z.array(z.object({ status: z.boolean() })).parse(failed.item_results);
      assert(results.some(({ status }) => status) && results.some(({ status }) => !status));
      const item = (await store!.one<{ document_id: string }>("SELECT document_id FROM knowledge_outbox WHERE id=?", id))!;
      assert.equal((await store!.all("SELECT index_key FROM knowledge_evidence WHERE artifact_id=? AND current AND retrievable", item.document_id)).length, 0);
      assert.equal((await engine.access.visible(identity)).some((resource) => resource.id === item.document_id), false);
      const retry = await settled(id, "sync", "retry");
      assert(!JSON.stringify(await store!.all("SELECT item_results,error_code FROM knowledge_outbox")).includes("SYNTHETIC PRIVATE"));
      partialFailure = false;
      const verified = await synchronized(id); const completed = await settled(id, "sync");
      assert(verified.attempts >= 2);
      assert(completed.retryCount > retry.retryCount);
    });
    await scenario("source/ACL generations fence an actually working obsolete attempt before any old native publication", async () => {
      const documentId = randomUUID();
      const hold = { documentId, entered: gate(), release: gate() };
      parseHold = hold; releases.push(hold.release.resolve);
      const old = await store!.transaction(async () => {
        await document(documentId, "# Old\nOld synthetic generation.", true);
        return engine.transition(await engine.access.resource(documentId), "publish", sessionId);
      });
      await hold.entered.promise;
      const attempt = (await store!.one<{ attempt_id: string; generation: number }>("SELECT attempt_id,generation FROM knowledge_outbox WHERE id=?", old.id))!;
      await store!.transaction(async () => {
        await store!.run("INSERT INTO knowledge_originals(document_id,source_revision,body) VALUES(?,2,?)", documentId, Buffer.from("# Current\nNew synthetic generation."));
        await store!.run("UPDATE resources SET parsed=NULL WHERE id=?", documentId);
        await engine.transition(await engine.access.resource(documentId), "source-change", sessionId);
        await store!.run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,'viewer')", documentId, testOids.B);
        await engine.transition(await engine.access.resource(documentId), "acl-sync", sessionId);
      });
      let staleWrite = false;
      await assert.rejects(engine.lifecycle.publish({ id: old.id, documentId, generation: attempt.generation, attemptId: attempt.attempt_id },
        [], async () => { staleWrite = true; return { value: [] }; }, async () => {}), /Obsolete indexing attempt/);
      assert.equal(staleWrite, false);
      assert.equal((await store!.one<{ state: string }>("SELECT state FROM knowledge_outbox WHERE id=?", old.id))!.state, "obsolete");
      hold.release.resolve();
      const current = (await store!.one<{ id: string }>("SELECT id FROM knowledge_outbox WHERE document_id=? ORDER BY generation DESC LIMIT 1", documentId))!;
      await synchronized(current.id); await settled(current.id, "sync");
      const state = (await store!.one<{ source_revision: number; acl_revision: number; generation: number }>("SELECT * FROM knowledge_source_state WHERE document_id=?", documentId))!;
      assert.deepEqual([state.source_revision, state.acl_revision, state.generation], [2, 3, 3]);
      const indexed = [...nativeIndex.values()].filter((unit) => unit.artifactId === documentId);
      assert(indexed.length && indexed.every((unit) => unit.sourceRevision === 2 && unit.aclRevision === 3 && unit.userIds.includes(testOids.B)));
      assert((await engine.access.visible({ ...identity, objectId: testOids.B })).some((resource) => resource.id === documentId));
    });
    await scenario("worker/database shutdown and fresh startup recover pending, failed and expired sync plus queued/safe expired requests", async () => {
      await runtime!.stop(); runtime = undefined;
      const sources: string[] = [];
      const requests: string[] = [];
      await store!.transaction(async () => {
        for (const state of ["pending", "failed", "working"]) {
          const documentId = await document(randomUUID(), `# Recovery\nSynthetic ${state} source.`, true);
          const item = await engine.lifecycle.transition({
            documentId, workspaceId: testConfig.workspaceId, tenantId: testConfig.tenantId,
            sourceRevision: 1, aclRevision: 1, readers: [testOids.A], state: "pending",
          }, "publish");
          await store!.run("UPDATE knowledge_outbox SET state=?,session_id=?,attempt_id=?,lease_until=now()-interval '1 minute' WHERE id=?",
            state, sessionId, state === "working" ? randomUUID() : null, item.id);
          sources.push(item.id);
        }
        for (const state of ["queued", "working"]) {
          const id = randomUUID();
          await store!.run("INSERT INTO knowledge_requests(id,workspace_id,user_oid,session_id,kind,input,state,attempt_id,lease_until) VALUES(?,?,?,?,'answer',?::jsonb,?,?,now()-interval '1 minute')",
            id, testConfig.workspaceId, testOids.A, sessionId, JSON.stringify({ question: "Synthetic recovery?", scope }),
            state, state === "working" ? randomUUID() : null);
          requests.push(id);
        }
      });
      await store!.close();
      store = await createFoundryDatabase(cluster.url, schema, encryptionKey);
      runtime = await createNativeQueueRuntime({ databaseUrl: cluster.url, databaseSchema: schema, store });
      engine = makeEngine();
      await runtime.startWorkers(engine);
      for (const id of sources) { await synchronized(id); await settled(id, "sync"); }
      for (const id of requests) { await finished(id); await settled(id, "request"); }
    });
    await scenario("expired observed model generation fails interrupted on startup recovery; old worker cannot publish or repeat a paid call", async () => {
      const hold = { entered: gate(), release: gate() };
      modelHold = hold; releases.push(hold.release.resolve);
      const before = counts.get(targets.answer) ?? 0;
      const id = await engine.createRequest(identity, sessionId, "answer", { question: "Synthetic interrupted model?", scope });
      await hold.entered.promise;
      const snapshot = runSnapshotSchema.parse((await store!.one<{ observability: unknown }>("SELECT observability FROM knowledge_requests WHERE id=?", id))!.observability);
      assert(snapshot.events.some((event) => event.kind === "step-started" && event.stage === "model" && event.usageExpected));
      // Fault injection advances the durable lease while the original synthetic model call is in flight.
      await store!.run("UPDATE knowledge_requests SET lease_until=now()-interval '1 minute' WHERE id=?", id);
      const previous = runtime!;
      extraRuntimes.push(previous);
      runtime = await createNativeQueueRuntime({ databaseUrl: cluster.url, databaseSchema: schema, store: store! });
      const recoveryEngine = makeEngine();
      await runtime.startWorkers(recoveryEngine);
      const failed = await finished(id, "failed");
      assert.equal(failed.error_code, "interrupted"); assert.equal(failed.result, null);
      assert.equal(runSnapshotSchema.parse(failed.observability).events.at(-1)?.kind, "run-failed");
      assert.equal(counts.get(targets.answer), before + 1);
      hold.release.resolve();
      await previous.stop();
      extraRuntimes.splice(extraRuntimes.indexOf(previous), 1);
      await runtime.enqueue("request", id);
      await settled(id, "request");
      assert.equal(counts.get(targets.answer), before + 1, "Queue redelivery must not invoke the model again");
      assert.equal((await store!.one<{ result: unknown }>("SELECT result FROM knowledge_requests WHERE id=?", id))!.result, null);
      const persistedJobs = JSON.stringify(await store!.all(`SELECT data,output FROM "${schema}_native_jobs".job`));
      for (const token of tokenOwners.keys()) assert(!persistedJobs.includes(token));
      assert(!persistedJobs.includes("synthetic-project"));
    });
    t.diagnostic("Verified extracted production queue runtime + actual engine on standalone PostgreSQL 16; NOT full app HTTP startup, cloud proof or app activation. Exact-target synthetic provider transports only.");
  } finally {
    for (const release of releases) release();
    try {
      for (const other of extraRuntimes) await other.stop();
      await runtime?.stop();
    } finally {
      try { await store?.close(); }
      finally {
        await cluster.stop();
        await assert.rejects(stat(cluster.directory), { code: "ENOENT" });
        t.diagnostic(`Owned PostgreSQL PID ${cluster.pid} exited after exact-data-path shutdown; listener closed; exclusively owned per-run directory removed.`);
      }
    }
  }
});
