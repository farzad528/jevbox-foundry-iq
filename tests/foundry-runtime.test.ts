import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import express from "express";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import { createFoundryApp, mountFoundryRoutes } from "../server/foundry/app";
import { createKnowledgeEngine, type KnowledgeAuth } from "../server/foundry/engine";
import { createIqClient, assertEvidenceScope, scopeFilter, retrievalScopeSchema } from "../server/foundry/iq-client";
import { createFoundryModels } from "../server/foundry/model-client";
import { createSearchWriter, indexDocument } from "../server/foundry/search-index";
import { createNativeAgentClient } from "../server/foundry/native-agent";
import { DelegatedCredential } from "../server/foundry/credentials";
import { runtimeConfigSchema } from "../server/foundry/runtime-config";
import { createEntraAccess } from "../server/foundry/access";
import { HttpError } from "../server/errors";
import { testConfig, testOids, evaluation } from "./foundry-fixtures";
import { evidenceSchema, type Evidence } from "../shared/evidence";
import { runSnapshotSchema } from "../shared/observability";

async function postgres() {
  const db = new PGlite();
  const directory = new URL("../server/migrations/", import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => /^\d+-.*\.sql$/.test(name)).sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  let queryable: PGlite | Transaction = db;
  let nested = false;
  const sql = (text: string) => {
    let i = 0;
    return text.replace(/'[^']*'|\?/g, (match) => match === "?" ? `$${++i}` : match);
  };
  const all = async <T = Record<string, unknown>>(text: string, ...args: unknown[]) => (await queryable.query<T>(sql(text), args)).rows;
  const store = {
    all,
    one: async <T = Record<string, unknown>>(text: string, ...args: unknown[]) => (await all<T>(text, ...args))[0],
    run: async (text: string, ...args: unknown[]) => ({ changes: (await queryable.query(sql(text), args)).affectedRows ?? 0 }),
    async transaction<T>(fn: () => T | Promise<T>) {
      if (nested) return fn();
      return db.transaction(async (tx) => {
        nested = true; queryable = tx;
        try { return await fn(); } finally { nested = false; queryable = db; }
      });
    },
  };
  await store.run("INSERT INTO orgs(id,name) VALUES(?,'Offline synthetic workspace')", testConfig.workspaceId);
  for (const oid of testConfig.roster)
    await store.run("INSERT INTO users(id,name,email) VALUES(?,?,?)", oid, `Synthetic ${oid}`, `${oid}@synthetic.invalid`);
  return { db, store };
}
async function localServer(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
test("OFFLINE runnable blocked profile has no database/cloud dependency and never exposes legacy paths", async () => {
  const before = process.env.FOUNDRY_CONFIG_FILE;
  delete process.env.FOUNDRY_CONFIG_FILE;
  const runtime = await createFoundryApp({ origin: "http://localhost:4310" });
  const server = await localServer(runtime.app);
  try {
    const profile = await (await fetch(`${server.origin}/api/profile`)).json();
    assert.equal(profile.activated, false);
    assert.equal((await fetch(`${server.origin}/health/ready`)).status, 503);
    for (const path of ["/api/auth/sign-in", "/api/resources", "/api/mcp", "/api/entra/login", "/api/foundry/requests"])
      assert.equal((await fetch(server.origin + path)).status, 503);
    assert.equal((await fetch(server.origin + "/api/auth/sign-in", { method: "POST" })).status, 403);
  } finally {
    await server.close(); await runtime.close();
    if (before === undefined) delete process.env.FOUNDRY_CONFIG_FILE; else process.env.FOUNDRY_CONFIG_FILE = before;
  }
});

test("OFFLINE HTTP router + full PostgreSQL migrations + durable IQ/wiki/ACL/native-agent flow (not live Azure)", async (t) => {
  const { db, store } = await postgres();
  const keys = await generateKeyPair("RS256");
  const credentials = new Map<string, DelegatedCredential>();
  const tokens = new Map<string, string>();
  const sessionIds = new Map(testConfig.roster.map((oid, index) => [oid, String(index + 1).repeat(64)]));
  for (const oid of testConfig.roster) {
    const token = await new SignJWT({ tid: testConfig.tenantId, oid, scp: "user_impersonation" })
      .setProtectedHeader({ alg: "RS256" }).setIssuer("https://offline.synthetic.invalid/issuer")
      .setAudience("https://search.azure.com").setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
    tokens.set(token, oid);
    credentials.set(oid, await DelegatedCredential.verify({ token, sessionIdentity: { tenantId: testConfig.tenantId, objectId: oid },
      tenantId: testConfig.tenantId, audience: "https://search.azure.com", issuer: "https://offline.synthetic.invalid/issuer",
      delegatedScope: "user_impersonation", roster: testConfig.roster, key: async () => keys.publicKey }));
  }
  const config = runtimeConfigSchema.parse({
    knowledge: testConfig, databaseSchema: "fiq_offline", workspaceName: "Offline synthetic", agentName: "offline-agent",
    entraClientId: randomUUID(), readerClientId: randomUUID(), writerClientId: randomUUID(), projectClientId: randomUUID(),
    approvals: { entraConsent: true, cloudCalls: true, syntheticUploads: true, vendorProcessing: false },
    nativeProof: { verifiedAt: new Date().toISOString(), tenantId: testConfig.tenantId, roster: testConfig.roster,
      knowledgeBaseName: testConfig.knowledgeBaseName, projectEndpoint: testConfig.projectEndpoint,
      checks: { restTwoUserAcl: true, restAdverseTokens: true, mcpTwoUserAcl: true, mcpAdverseTokens: true,
        mcpOriginalLocators: true, hybridLowExtractive: true, projectModelDeployments: true } },
  });
  // Only the isolated router harness uses this synthetic attestation; createFoundryApp remains blocked.
  const auth: KnowledgeAuth & { router: express.Router } = {
    router: express.Router(),
    async authenticate(req) {
      const objectId = req.get("X-Offline-User") ?? "";
      if (!testConfig.roster.includes(objectId)) throw new HttpError(401, "Offline fixture identity required");
      return { identity: { tenantId: testConfig.tenantId, objectId }, sessionId: sessionIds.get(objectId)! };
    },
    async credential(req) { return credentials.get((await this.authenticate(req)).identity.objectId)!; },
    async identityForSession(sessionId) {
      const oid = [...sessionIds].find(([, id]) => id === sessionId)?.[0];
      if (!oid) throw new HttpError(401, "Offline session unavailable");
      return { tenantId: testConfig.tenantId, objectId: oid };
    },
    async credentialForSession(sessionId) { return credentials.get((await this.identityForSession(sessionId)).objectId)!; },
    async credentialsForRoster() { return (bothUsers ? testConfig.roster : testConfig.roster.slice(0, 1)).map((oid) => credentials.get(oid)!); },
  };
  const nativeIndex = new Map<string, { id: string; artifactId: string; userIds: string[]; contentKind: string;
    rawSourceRefs: { documentId: string; uploadedAt: string | null; folderIds: string[]; fileTypes: string[] }[] }>();
  const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  let invalidModel = false;
  let failIndex = false;
  let afterModel: (() => Promise<void>) | undefined;
  let retrieveFailure = false;
  let duplicateMcpRef = false;
  let bothUsers = true;
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetcher: typeof fetch = async (url, options) => {
    const address = String(url);
    if (!address.startsWith(testConfig.searchEndpoint) && !address.startsWith(testConfig.projectEndpoint))
      throw new Error("Offline fixture refused an unexpected network target");
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    const headers = new Headers(options?.headers);
    calls.push({ url: address, body, authorization: headers.get("Authorization") });
    if (address.includes("/docs/index")) {
      const { value } = z.object({ value: z.array(z.object({
        id: z.string(), "@search.action": z.string(), artifactId: z.string().optional(), contentKind: z.string().optional(),
        userIds: z.array(z.string()).optional(),
        rawSourceRefs: z.array(z.object({ documentId: z.string(), uploadedAt: z.string().nullable(),
          folderIds: z.array(z.string()), fileTypes: z.array(z.string()) })).optional(),
      })) }).parse(body);
      return response({ value: value.map((item) => {
        if (!failIndex) {
          if (item["@search.action"] === "delete") nativeIndex.delete(item.id);
          else nativeIndex.set(item.id, { id: item.id, artifactId: item.artifactId!, contentKind: item.contentKind!,
            userIds: item.userIds ?? [], rawSourceRefs: item.rawSourceRefs ?? [] });
        }
        return { key: item.id, status: !failIndex, statusCode: failIndex ? 503 : 200, errorMessage: failIndex ? "PRIVATE PROVIDER PAYLOAD" : null };
      }) });
    }
    if (address.includes("/docs/search")) {
      const oid = tokens.get(headers.get("x-ms-query-source-authorization") ?? "");
      assert(oid);
      const wanted = [...String(body.filter).matchAll(/id eq '([^']+)'/g)].map((match) => match[1]);
      const artifact = String(body.filter).match(/artifactId eq '([^']+)'/)?.[1];
      return response({ value: [...nativeIndex.values()].filter((unit) =>
        (artifact ? unit.artifactId === artifact : wanted.includes(unit.id)) && unit.userIds.includes(oid)).map(({ id }) => ({ id })) });
    }
    const available = (await store.all<{ payload: Evidence }>("SELECT payload FROM knowledge_evidence WHERE current AND retrievable")).map((row) => row.payload);
    if (address.includes("/retrieve")) {
      if (retrieveFailure) return response({ error: "PRIVATE FAILURE" }, 503);
      const oid = tokens.get(headers.get("x-ms-query-source-authorization") ?? "");
      const params = z.array(z.object({ filterAddOn: z.string() })).parse(body.knowledgeSourceParams);
      const filter = params[0].filterAddOn;
      const docs = [...filter.matchAll(/r\/documentId eq '([^']+)'/g)].map((match) => match[1]);
      const folders = [...filter.matchAll(/f eq '([^']+)'/g)].map((match) => match[1]);
      const types = [...filter.matchAll(/t eq '([^']+)'/g)].map((match) => match[1]);
      const after = filter.match(/r\/uploadedAt ge ([\dT:.\-Z]+)/)?.[1];
      const before = filter.match(/r\/uploadedAt le ([\dT:.\-Z]+)/)?.[1];
      if (docs.length || folders.length || types.length || after || before) {
        assert(filter.includes("rawSourceRefs/any()"));
        assert(filter.includes("rawSourceRefs/all(r: "));
        assert(!filter.includes("rawDocumentIds/any"));
      }
      const authorized = available.filter((unit) => {
        const indexed = nativeIndex.get(unit.indexKey);
        return indexed?.userIds.includes(oid ?? "") &&
          (!filter.includes("rawSourceRefs/any()") || indexed.rawSourceRefs.length > 0) &&
          indexed.rawSourceRefs.every((source) => (!docs.length || docs.includes(source.documentId)) &&
            (!folders.length || folders.some((id) => source.folderIds.includes(id))) &&
            (!types.length || types.some((type) => source.fileTypes.includes(type))) &&
            (!after || (source.uploadedAt !== null && Date.parse(source.uploadedAt) >= Date.parse(after))) &&
            (!before || (source.uploadedAt !== null && Date.parse(source.uploadedAt) <= Date.parse(before)))) &&
          (!filter.includes("contentKind eq 'raw'") || indexed.contentKind === "raw");
      });
      return response({ response: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify(authorized.map((unit, index) => ({ ref_id: String(index), content: unit.text }))) }] }],
        references: authorized.map((unit, index) => ({ type: "searchIndex", id: String(index), activitySource: 0, docKey: unit.indexKey })),
        activity: [{ id: 0, type: "modelQueryPlanning", inputTokens: 10, outputTokens: 2 }] });
    }
    if (address.endsWith("/embeddings")) {
      const input = z.array(z.string()).parse(body.input);
      return response({ data: input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })), usage: { prompt_tokens: input.length * 10 } });
    }
    if (address.endsWith("/responses")) {
      assert.equal(headers.get("Authorization"), "Bearer offline-project");
      const structured = z.object({ search_auth_token: z.string() }).parse(body.structured_inputs);
      const oid = tokens.get(structured.search_auth_token);
      const unit = available.find((unit) => unit.userIds.includes(oid ?? ""));
      assert(unit);
      const toolCall = (evidence: Evidence, id: string) => ({ type: "mcp_call", id, name: "knowledge_base_retrieve",
        output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify([{ ref_id: "0", title: evidence.title,
          content: evidence.text, terms: JSON.stringify({ schemaVersion: 1, indexKey: evidence.indexKey }) }]) }] }) });
      return response({ id: "offline-response", status: "completed", output: [
        toolCall(unit, "offline-tool"),
        ...(duplicateMcpRef ? [toolCall(available.find((source) => source.indexKey !== unit.indexKey)!, "offline-tool-2")] : []),
        { type: "message", content: [{ type: "output_text", text: "Supported source [0]" }] },
      ], usage: { input_tokens: 15, output_tokens: 5 } });
    }
    if (address.endsWith("/chat/completions")) {
      assert.equal(body.model, testConfig.answerDeployment);
      const messages = z.array(z.object({ role: z.string(), content: z.string() })).parse(body.messages);
      const supplied = z.object({ evidence: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(messages[1].content));
      const id = supplied.evidence[0].id;
      const drafting = messages[0].content.includes("reviewable topic");
      if (afterModel) await afterModel();
      const result = drafting ? { title: "Release decision", kind: "decision", claims: [{ id: "claim-1", text: "Release date is October 15.", evidenceIds: [id] }] }
        : { answer: invalidModel ? "Unsupported [unknown]" : `Release date is October 15 [${id}]`, evidenceIds: [id] };
      return response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 30, completion_tokens: 8 } });
    }
    throw new Error("Offline fixture refused an unimplemented provider operation");
  };
  const queued: { kind: "sync" | "request"; id: string }[] = [];
  const service = (name: string) => async () => ({ token: `offline-${name}`, expiresAt: Date.now() + 3600000 });
  const engine = createKnowledgeEngine({
    store, config, auth, enqueue: async (kind, id) => { queued.push({ kind, id }); },
    iq: createIqClient(testConfig, service("reader"), fetcher),
    models: createFoundryModels(testConfig, service("project"), fetcher),
    writer: createSearchWriter(testConfig, service("writer"), fetcher),
    agent: createNativeAgentClient({ config: testConfig, projectEndpoint: testConfig.projectEndpoint,
      agentName: "offline-agent", projectCredential: service("project"), fetcher }),
    readerCredential: service("reader"), fetcher,
    parse: async (resource) => {
      const { buildIndex } = await import("../server/indexing");
      const source = await store.one<{ body: Buffer }>("SELECT body FROM knowledge_originals WHERE document_id=? ORDER BY source_revision DESC LIMIT 1", resource.id);
      assert(source);
      return buildIndex([{ content: Buffer.from(source.body).toString("utf8") }], "text");
    },
  });
  const app = express();
  app.use(express.json());
  mountFoundryRoutes(app, { store, config, auth, engine, enqueue: async (kind, id) => { queued.push({ kind, id }); } });
  const server = await localServer(app);
  const http = (path: string, options: RequestInit = {}, oid = testOids.A) => {
    const headers = new Headers({ "X-Offline-User": oid, "Content-Type": "application/json", ...options.headers });
    if (options.body instanceof FormData) headers.delete("Content-Type");
    return fetch(server.origin + "/api" + path, { ...options, headers });
  };
  const post = (path: string, body: unknown) => http(path, { method: "POST", body: JSON.stringify(body) });
  const scope = { workspaceId: testConfig.workspaceId, documentIds: [], folderIds: [], fileTypes: [] };
  const processQueue = async (kind: "request" | "sync") => {
    const jobs = queued.filter((item) => item.kind === kind);
    for (const job of jobs) {
      queued.splice(queued.indexOf(job), 1);
      if (kind === "sync") await engine.sync(job.id, new AbortController().signal);
      else await engine.executeRequest(job.id, new AbortController().signal);
    }
  };
  let documentId: string;
  let answerId: string;
  let wikiId: string;
  let runbookId: string;
  try {
    await t.test("actual migrations and router enforce owner-only pending status, list and original preview", async () => {
      const form = new FormData();
      form.append("file", new Blob(["Release date is October 15."]), "synthetic-release.md");
      const upload = await http("/foundry/documents", { method: "POST", body: form, headers: { "Content-Type": "" } });
      assert.equal(upload.status, 202);
      documentId = (await upload.json()).id;
      assert.deepEqual(await (await http("/resources")).json(), []);
      const status = await (await http("/foundry/status")).json();
      assert.equal(status.ownerOnlyPending[0].id, documentId);
      assert(!JSON.stringify(status.ownerOnlyPending).includes("synthetic-release"));
      await processQueue("sync");
      assert.equal((await http(`/resources/${documentId}`)).status, 200);
      assert.equal((await http(`/resources/${documentId}`, {}, testOids.B)).status, 404);
      assert.deepEqual(await (await http("/resources", {}, testOids.B)).json(), []);
    });
    await t.test("IQ drives one project-bound answer with authorized original locators and measured events", async () => {
      const started = await post("/foundry/requests/answer", { question: "When is release?", scope });
      assert.equal(started.status, 202); answerId = (await started.json()).id;
      const before = calls.filter((call) => call.url.endsWith("/chat/completions")).length;
      await processQueue("request");
      const result = await (await http(`/foundry/requests/${answerId}`)).json();
      assert.equal(result.state, "completed");
      assert.equal(calls.filter((call) => call.url.endsWith("/chat/completions")).length, before + 1);
      const unit = evidenceSchema.parse(result.result.evidence[0]);
      assert.equal(unit.contentKind, "raw");
      assert(unit.contentKind === "raw" && unit.locator.page === null);
      assert.equal((await http(`/foundry/citations/${unit.indexKey}`)).status, 200);
      const run = runSnapshotSchema.parse(result.run);
      assert(run.events.some((event) => event.origin === "native-rest"));
      assert(run.events.at(-1)?.elapsedMs !== undefined);
      assert(!JSON.stringify(await store.all("SELECT input,result,observability FROM knowledge_requests")).includes("eyJ"));
      assert(calls.filter((call) => call.url.includes("/openai/")).every((call) => call.url.startsWith(testConfig.projectEndpoint)));
    });
    await t.test("wiki generation, edit, human review, pending publication, source intersection and history are real repository/router operations", async () => {
      const navigation = evaluation.lifecycleScenarios.find((scenario) => scenario.id === "curated-claim-original-navigation")!;
      const runbook = evaluation.documents.find((document) => document.id === navigation.expectedSourceId)!;
      const form = new FormData(); form.append("file", new Blob([runbook.lines!.join("\n")]), runbook.fileName);
      runbookId = (await (await http("/foundry/documents", { method: "POST", body: form })).json()).id;
      await processQueue("sync");
      const started = await post("/foundry/requests/wiki-draft", { question: "Draft a release decision.", scope });
      const draftRun = (await started.json()).id;
      await processQueue("request");
      wikiId = (await (await http(`/foundry/requests/${draftRun}`)).json()).result.pageId;
      const page = await (await http(`/foundry/wiki/${wikiId}`)).json();
      const restore = [...(await engine.lookup()).values()].find((unit) => unit.contentKind === "raw" &&
        unit.artifactId === runbookId && unit.locator.sectionPath.includes(navigation.expectedSection!))!;
      assert(restore?.contentKind === "raw");
      const edit = await http(`/foundry/wiki/${wikiId}`, { method: "PATCH", body: JSON.stringify({
        revision: 1, title: "Human reviewed release", claims: [
          { ...page.claims[0], text: "Human edit: release is October 15." },
          { id: "restore", text: "Restore drill targets are 30 minutes RTO and 5 minutes RPO, not customer guarantees.",
            evidence: [{ evidenceId: restore.indexKey, locator: restore.locator }] },
        ], relatedPageIds: [],
      }) });
      assert.equal(edit.status, 200);
      assert.equal((await edit.json()).state, "draft");
      assert.equal((await post(`/foundry/wiki/${wikiId}/review`, { revision: 2, acknowledged: false })).status, 400);
      assert.equal((await post(`/foundry/wiki/${wikiId}/review`, { revision: 2, acknowledged: true })).status, 200);
      assert.equal((await post(`/foundry/wiki/${wikiId}/publish`, { revision: 2 })).status, 202);
      assert.equal((await http(`/foundry/wiki/${wikiId}`)).status, 409);
      await processQueue("sync");
      assert.equal((await http(`/foundry/wiki/${wikiId}`)).status, 200);
      assert.deepEqual(await (await http("/foundry/wiki", {}, testOids.B)).json(), []);
      assert.equal((await (await http(`/foundry/wiki/${wikiId}/history`)).json()).length, 2);
      const claim = [...(await engine.lookup()).values()].find((unit) => unit.contentKind === "wiki" &&
        unit.artifactId === wikiId && unit.text.startsWith("Restore drill"))!;
      assert(claim?.contentKind === "wiki");
      assert.equal(new Set(claim.dependencies.map((dep) => dep.locator.documentId)).size, 2);
      const citation = await (await http(`/foundry/citations/${claim.indexKey}`)).json();
      assert.equal(citation.originals[0].locator.documentId, runbookId);
      assert(citation.originals[0].locator.sectionPath.includes(navigation.expectedSection!));
    });
    await t.test("actual scoped request and native transport fixture preserve all-source subset and no-match UTC date semantics", async () => {
      const scoped = await post("/foundry/requests/answer", { question: "When is release?", scope: { ...scope, documentIds: [documentId] } });
      const id = (await scoped.json()).id;
      await processQueue("request");
      const result = await (await http(`/foundry/requests/${id}`)).json();
      assert(result.result.evidence.every((unit: Evidence) => unit.contentKind === "raw" && unit.artifactId === documentId));
      const noMatch = await post("/foundry/requests/answer", { question: "When is release?", scope: { ...scope, createdAfter: "2999-01-01", createdBefore: "2999-01-02", fileTypes: ["text"] } });
      const noMatchId = (await noMatch.json()).id;
      const models = calls.filter((call) => call.url.endsWith("/chat/completions")).length;
      await processQueue("request");
      assert.deepEqual((await (await http(`/foundry/requests/${noMatchId}`)).json()).result, { answer: "I don't know", evidence: [] });
      assert.equal(calls.filter((call) => call.url.endsWith("/chat/completions")).length, models);
    });
    await t.test("nested subtree deletion fences all folders, pending sources and unpublished wiki locations without breaking unrelated listing", async () => {
      const root = (await (await post("/foundry/folders", { name: "Delete root", parentId: null, access: "restricted" })).json()).id;
      const child = (await (await post("/foundry/folders", { name: "Delete child", parentId: root, access: "inherit" })).json()).id;
      const sibling = (await (await post("/foundry/folders", { name: "Unrelated sibling", parentId: null, access: "restricted" })).json()).id;
      const form = new FormData(); form.append("file", new Blob(["Never indexed"]), "pending.md"); form.append("parentId", child);
      const source = (await (await http("/foundry/documents", { method: "POST", body: form })).json()).id;
      const pageId = randomUUID();
      const draft = await engine.wiki.latest(wikiId);
      await engine.wiki.insertDraft({ tenantId: testConfig.tenantId, objectId: testOids.A },
        { ...draft, pageId, revision: 1, state: "draft", reviewerOid: null }, child);
      const deleted = await http(`/resources/${root}`, { method: "DELETE" });
      assert.equal(deleted.status, 202);
      const rows = await store.all<{ id: string; knowledge_deleted: boolean }>("SELECT id,knowledge_deleted FROM resources WHERE id=ANY(?::text[])", [root, child, source, pageId]);
      assert.equal(rows.length, 4); assert(rows.every((row) => row.knowledge_deleted));
      const list = await http("/resources"); assert.equal(list.status, 200);
      assert((await list.json()).some((row: { id: string }) => row.id === sibling));
      assert.equal((await http(`/foundry/wiki/${pageId}`)).status, 404);
      await processQueue("sync");
      assert.equal((await engine.lifecycle.sources(testConfig.workspaceId)).get(source)?.state, "deleted");
      assert.equal((await http("/resources")).status, 200);
    });
    await t.test("ACL transition fences lists, preview and saved runs; native synchronization uses both actual fixture credentials", async () => {
      assert.equal((await http(`/foundry/resources/${documentId}`, { method: "PATCH", body: JSON.stringify({ grants: [{ objectId: testOids.B, role: "viewer" }] }) })).status, 202);
      assert(!(await (await http("/resources")).json()).some((row: { id: string }) => row.id === documentId));
      assert.equal((await http(`/documents/${documentId}/content`)).status, 409);
      assert.equal((await http(`/foundry/requests/${answerId}`)).status, 409);
      assert(!(await (await http("/foundry/requests")).json()).some((row: { id: string }) => row.id === answerId));
      await processQueue("sync");
      assert.equal((await http(`/resources/${documentId}`, {}, testOids.B)).status, 200);
      assert.equal((await (await http(`/foundry/wiki/${wikiId}/history`)).json()).length, 2);
      assert.equal(nativeIndex.size > 0, true);
      assert(calls.filter((call) => call.url.includes("/docs/index")).every((call) => call.authorization === "Bearer offline-writer"));
      assert(calls.filter((call) => call.url.includes("/docs/search")).every((call) => call.authorization === "Bearer offline-reader"));
    });
    await t.test("native agent returns actual MCP payload locators without a duplicate REST retrieval", async () => {
      const before = calls.filter((call) => call.url.includes("/retrieve")).length;
      const started = await post("/foundry/requests/native-agent", { question: "When is release?", scope });
      const id = (await started.json()).id;
      await processQueue("request");
      const result = await (await http(`/foundry/requests/${id}`)).json();
      assert.equal(result.state, "completed");
      assert.equal(result.result.activity, null);
      assert(!result.result.answer.includes("[0]"));
      assert.equal(result.result.evidence.length, 1);
      assert.equal(calls.filter((call) => call.url.includes("/retrieve")).length, before);
    });
    await t.test("ambiguous aliases across two native MCP calls fail without guessing source identity", async () => {
      duplicateMcpRef = true;
      const started = await post("/foundry/requests/native-agent", { question: "When is release?", scope });
      const id = (await started.json()).id;
      queued.splice(queued.findIndex((job) => job.id === id), 1);
      await assert.rejects(() => engine.executeRequest(id, new AbortController().signal));
      duplicateMcpRef = false;
      assert.equal((await (await http(`/foundry/requests/${id}`)).json()).state, "failed");
    });
    await t.test("provider/retrieval failure is failed, not cancelled; user cancellation is a separate terminal event", async () => {
      retrieveFailure = true;
      const started = await post("/foundry/requests/answer", { question: "When is release?", scope });
      const id = (await started.json()).id;
      queued.splice(queued.findIndex((job) => job.id === id), 1);
      await assert.rejects(() => engine.executeRequest(id, new AbortController().signal));
      const failed = await (await http(`/foundry/requests/${id}`)).json();
      assert.equal(failed.state, "failed"); assert.equal(failed.run.events.at(-1).kind, "run-failed");
      retrieveFailure = false;
      const cancelStarted = await post("/foundry/requests/answer", { question: "When is release?", scope });
      const cancelId = (await cancelStarted.json()).id;
      queued.splice(queued.findIndex((job) => job.id === cancelId), 1);
      afterModel = async () => { await engine.cancel({ tenantId: testConfig.tenantId, objectId: testOids.A }, cancelId); };
      await assert.rejects(() => engine.executeRequest(cancelId, new AbortController().signal));
      afterModel = undefined;
      const cancelled = await (await http(`/foundry/requests/${cancelId}`)).json();
      assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.run.events.at(-1).kind, "run-cancelled");
    });
    await t.test("unsupported generated citation identities do not publish an answer", async () => {
      invalidModel = true;
      const started = await post("/foundry/requests/answer", { question: "When is release?", scope });
      const id = (await started.json()).id;
      queued.splice(queued.findIndex((job) => job.id === id), 1);
      await assert.rejects(() => engine.executeRequest(id, new AbortController().signal));
      invalidModel = false;
      const result = await (await http(`/foundry/requests/${id}`)).json();
      assert.equal(result.state, "failed"); assert.equal(result.result, null);
      const before = calls.length;
      await engine.executeRequest(id, new AbortController().signal);
      assert.equal(calls.length, before, "Failed requests are not silently regenerated by automatic retries");
    });
    await t.test("expired attempts after model start fail interrupted instead of making an ambiguous second paid invocation", async () => {
      const started = await post("/foundry/requests/answer", { question: "When is release?", scope });
      const id = (await started.json()).id;
      queued.splice(queued.findIndex((job) => job.id === id), 1);
      const run = runSnapshotSchema.parse({ schemaVersion: 1, id, dependencies: [], events: [{
        schemaVersion: 1, id: randomUUID(), runId: id, sequence: 0, timestamp: new Date().toISOString(),
        kind: "step-started", origin: "application", stepId: "interrupted-model", stage: "model", usageExpected: true,
      }] });
      await store.run("UPDATE knowledge_requests SET state='working',attempt_id=?,lease_until=now()-interval '1 second',observability=?::jsonb WHERE id=?",
        randomUUID(), JSON.stringify(run), id);
      const before = calls.length;
      await engine.executeRequest(id, new AbortController().signal);
      assert.equal(calls.length, before);
      const recovered = await (await http(`/foundry/requests/${id}`)).json();
      assert.equal(recovered.state, "failed"); assert.equal(recovered.errorCode, "interrupted");
      assert.equal(recovered.run.events.at(-1).elapsedMs, undefined);
    });
    await t.test("source changes invalidate old wiki and partial indexing keeps status failed without private provider payload", async () => {
      const form = new FormData(); form.append("file", new Blob(["Changed source"], { type: "text/plain" }), "changed.txt");
      const changed = await http(`/foundry/documents/${documentId}`, { method: "PUT", body: form, headers: { "Content-Type": "" } });
      assert.equal(changed.status, 202);
      assert.deepEqual(await (await http("/foundry/wiki")).json(), []);
      assert.equal((await http(`/foundry/wiki/${wikiId}`)).status, 409);
      failIndex = true;
      const queuedJob = queued.find((job) => job.kind === "sync")!;
      await assert.rejects(() => engine.sync(queuedJob.id, new AbortController().signal));
      const row = await store.one<{ state: string; item_results: unknown }>("SELECT state,item_results FROM knowledge_outbox WHERE id=?", queuedJob.id);
      assert.equal(row?.state, "failed"); assert(!JSON.stringify(row?.item_results).includes("PRIVATE"));
      assert(!(await (await http("/resources")).json()).some((row: { id: string }) => row.id === documentId));
      failIndex = false;
      bothUsers = false;
      await assert.rejects(() => engine.sync(queuedJob.id, new AbortController().signal), /authentication-required/);
      assert.equal((await engine.lifecycle.sources(testConfig.workspaceId)).get(documentId)?.state, "failed");
      bothUsers = true;
      await engine.sync(queuedJob.id, new AbortController().signal);
      assert.equal((await engine.lifecycle.sources(testConfig.workspaceId)).get(documentId)?.state, "verified");
    });
  } finally { await server.close(); await db.close(); }
});

test("native complex collection filter and authoritative scope enforce ALL raw dependencies and UTC whole days", () => {
  const raw = evidenceSchema.parse({
    schemaVersion: 1, indexKey: "raw", artifactId: "doc", workspaceId: testConfig.workspaceId, contentKind: "raw",
    title: "Synthetic", text: "Evidence", fileType: "text/markdown", sourceRevision: 1, aclRevision: 1,
    userIds: [testOids.A], current: true, retrievable: true, folderIds: ["folder"],
    locator: { documentId: "doc", sourceRevision: 1, aclRevision: 1, nodeId: "n", passageId: "p", sectionPath: [], page: null, endPage: null, blocks: [] },
    sourceDates: [{ documentId: "doc", uploadedAt: "2026-10-06T23:59:59.999Z" }],
  });
  const scope = retrievalScopeSchema.parse({ workspaceId: testConfig.workspaceId, documentIds: ["doc"],
    createdAfter: "2026-10-06", createdBefore: "2026-10-06", folderIds: ["folder"], fileTypes: ["text"] });
  const filter = scopeFilter(scope);
  assert(filter.includes("rawSourceRefs/any()"));
  assert(filter.includes("rawSourceRefs/all(r: (r/documentId eq 'doc')"));
  assert(filter.includes("r/uploadedAt le 2026-10-06T23:59:59.999Z"));
  assert(!filter.includes("rawDocumentIds/any"));
  assertEvidenceScope(scope, raw, new Map());
  assert(raw.contentKind === "raw");
  const outside = evidenceSchema.parse({ ...raw, indexKey: "outside", artifactId: "other", locator: { ...raw.locator, documentId: "other" } });
  assert(outside.contentKind === "raw");
  const { locator: _locator, ...base } = raw;
  const curated = evidenceSchema.parse({ ...base, indexKey: "curated", artifactId: "page", contentKind: "wiki",
    wikiRevision: 1, reviewStatus: "published", dependencies: [
      { evidenceId: raw.indexKey, locator: raw.locator }, { evidenceId: outside.indexKey, locator: outside.locator },
    ], supportingEvidence: [{ evidenceId: raw.indexKey, locator: raw.locator }] });
  assert.throws(() => assertEvidenceScope(scope, curated, new Map([["raw", raw], ["outside", outside]])), /all-source/);
  assert.throws(() => assertEvidenceScope({ ...scope, createdBefore: "2026-10-05" }, raw, new Map()));
  const indexed = indexDocument(raw, [1, 2, 3], 3);
  assert.equal(indexed.rawSourceRefs[0].uploadedAt, "2026-10-06T23:59:59.999Z");
});

test("inherited editor rights stop at private boundaries and are intersected with every ancestor read bound", async () => {
  const { db, store } = await postgres();
  try {
    const parent = randomUUID(), inherited = randomUUID(), privateChild = randomUUID();
    await store.run("INSERT INTO resources(id,org_id,owner_id,kind,name,access,created) VALUES(?,?,?,'folder','Parent','restricted',?)", parent, testConfig.workspaceId, testOids.A, new Date().toISOString());
    await store.run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,'editor')", parent, testOids.B);
    for (const [id, mode] of [[inherited, "inherit"], [privateChild, "restricted"]])
      await store.run("INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,access,created) VALUES(?,?,?,?,'folder','Child',?,?)", id, testConfig.workspaceId, testOids.A, parent, mode, new Date().toISOString());
    await store.run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,'viewer')", privateChild, testOids.B);
    const access = createEntraAccess(store, testConfig);
    const user = { tenantId: testConfig.tenantId, objectId: testOids.B };
    await access.require(user, inherited!, true);
    await assert.rejects(() => access.require(user, privateChild!, true), /Editor/);
    await store.run("UPDATE grants SET role='viewer' WHERE resource_id=?", parent);
    await assert.rejects(() => access.require(user, inherited!, true), /Editor/);
    await store.run("UPDATE grants SET role='editor' WHERE resource_id=?", privateChild);
    await store.run("DELETE FROM grants WHERE resource_id=?", parent);
    await assert.rejects(() => access.require(user, privateChild!, true), /unavailable/);
  } finally { await db.close(); }
});
