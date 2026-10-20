import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalConfigSchema, type PersonalConfig, type PersonalBounds } from "../shared/personal-file";
import { PersonalStore, digest } from "../server/personal-file/store";
import { assertDefinition, sourceDefinition, kbDefinition, createNativeClient, type NativeTransport } from "../server/personal-file/native";
import { createPersonalWorkflow } from "../server/personal-file/workflow";
import { personalEnvironment } from "../scripts/launch-personal";
import { personalDrive } from "../src/lib/personal-drive";
import { readPersonalPreflight } from "../server/personal-file/preflight";

export const personalTestConfig: PersonalConfig = personalConfigSchema.parse({
  tenantId: "10000000-0000-4000-8000-000000000001", subscriptionId: "10000000-0000-4000-8000-000000000002", ownerOid: "10000000-0000-4000-8000-000000000003",
  searchEndpoint: "https://offline.search.windows.net",
  searchResourceId: "/subscriptions/10000000-0000-4000-8000-000000000002/resourceGroups/offline/providers/Microsoft.Search/searchServices/offline",
  projectResourceId: "/subscriptions/10000000-0000-4000-8000-000000000002/resourceGroups/offline/providers/Microsoft.CognitiveServices/accounts/offline/projects/offline",
  projectEndpoint: "https://offline.services.ai.azure.com/api/projects/offline", cuEndpoint: "https://offline.services.ai.azure.com",
  sourceName: "offline-source", kbName: "offline-kb",
  embedding: { endpoint: "https://offline.openai.azure.com", deployment: "embedding", model: "text-embedding-3-small", version: "1", dimensions: 1536 },
  chat: { endpoint: "https://offline.openai.azure.com", deployment: "chat", model: "gpt-5.4-mini", version: "2026-03-17" },
  inheritedEncryption: null,
  cmkBaselineSource: "offline-baseline",
});
export const personalTestBounds: PersonalBounds = {
  maxRequests: 150, questions: 10, maxContextCharacters: 20000, maxOutputTokens: 1024,
  incrementalAllowanceUsd: 1, remainingBudgetUsd: 10, pricingEvidence: "OFFLINE synthetic price evidence, not an Azure approval", disclosuresAccepted: true,
};
export function syntheticPersonalTransport(config: PersonalConfig) {
  let source = false, kb = false;
  const files: Record<string, unknown>[] = [], requests: { url: string; method: string; body: string }[] = [];
  const transport: NativeTransport = async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer OFFLINE");
    assert.equal(new Headers(init.headers).has("api-key"), false);
    const method = init.method ?? "GET", path = decodeURIComponent(new URL(url).pathname), body = typeof init.body === "string" ? init.body : "";
    requests.push({ url, method, body });
    const response = (value: unknown, status = 200, etag?: string) => new Response(JSON.stringify(value), {
      status, headers: { "Content-Type": "application/json", "request-id": "OFFLINE-request", ...(etag ? { etag } : {}) },
    });
    if (path.includes("/deployments/")) {
      const selected = path.endsWith("/chat") ? config.chat : config.embedding;
      return response({ properties: { provisioningState: "Succeeded", model: { name: selected.model, version: selected.version } } });
    }
    if (path.endsWith("/files") && method === "POST") {
      assert(init.body instanceof Uint8Array);
      const multipart = Buffer.from(init.body).toString();
      const metadata = JSON.parse(multipart.split("Content-Type: application/json\r\n\r\n")[1].split("\r\n--")[0]) as { fileName: string; metadata: Record<string, string> };
      const content = Buffer.from(init.body).subarray(Buffer.from(init.body).indexOf(Buffer.from('filename="upload"')));
      const bytes = content.subarray(content.indexOf(Buffer.from("\r\n\r\n")) + 4);
      const size = bytes.indexOf(Buffer.from("\r\n--"));
      const file = { fileId: `native-${files.length}`, fileName: metadata.fileName, fileSizeBytes: size, metadata: metadata.metadata };
      files.push(file); return response(file);
    }
    if (path.endsWith("/files")) return response({ value: files });
    if (path.endsWith("/retrieve")) return response({
      response: [{ content: [{ type: "text", text: JSON.stringify([{ ref_id: "0", content: "Cedar evidence" }]) }] }],
      references: [{ type: "file", id: "0", sourceData: { snippet_parent_id: "native-1", uid: "chunk-1", snippet: "Cedar evidence" } }], activity: [],
    });
    if (path.includes("/openai/v1/")) return response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ answer: "Cedar evidence [0]", citationIds: ["0"] }) } }] });
    if (path.endsWith("/docs/search")) return response({ value: [{ uid: "chunk-probe", snippet_parent_id: "native-0", snippet: "CUOCR34298637" }] });
    if (path.endsWith("/stats")) return response({ documentCount: 7, storageSize: 1024, vectorIndexSize: 512 });
    if (path.startsWith("/indexes(")) return response({ name: "observed-index", fields: [
      { name: "uid", type: "Edm.String", key: true, retrievable: true }, { name: "snippet", type: "Edm.String", retrievable: true },
      { name: "snippet_parent_id", type: "Edm.String", retrievable: true, filterable: false },
      { name: "vector", type: "Collection(Edm.Single)", dimensions: 1536 },
    ] });
    if (path.startsWith("/knowledgesources(")) {
      if (method === "PUT") { assert.equal(new Headers(init.headers).get("If-None-Match"), "*"); assert.equal(source, false); source = true; }
      return source ? response({ ...sourceDefinition(config), "@odata.context": `${config.searchEndpoint}/$metadata#knowledgesources/$entity`,
        fileParameters: { ...sourceDefinition(config).fileParameters,
          ingestionParameters: { ...sourceDefinition(config).fileParameters.ingestionParameters, ingestionPermissionOptions: [] },
          createdResources: { index: "observed-index" } } }, method === "PUT" ? 201 : 200, "source-v1") : response({}, 404);
    }
    if (path.startsWith("/knowledgebases(")) {
      if (method === "PUT") { assert.equal(kb, false); kb = true; }
      return kb ? response({ ...kbDefinition(config), "@odata.context": `${config.searchEndpoint}/$metadata#knowledgebases/$entity` }, method === "PUT" ? 201 : 200, "kb-v1") : response({}, 404);
    }
    throw new Error(`Unexpected synthetic route: ${path}`);
  };
  return { transport, requests, files };
}
function localStore() {
  const directory = mkdtempSync(join(tmpdir(), "jevbox-personal-test-"));
  const store = new PersonalStore(directory);
  store.recordPreflight(personalTestConfig, { kind: "OFFLINE synthetic preflight, no Azure proof" });
  store.select(["cu-mi-probe.pdf", "cedar-launch-plan.md", "cedar-architecture.md", "cedar-commercial-brief.md",
    "cedar-operations-runbook.md", "cedar-release-approval-notes.pdf", "cedar-untrusted-content.md"]
    .map((path) => ({ path: `Cedar/${path}`, mime: path.endsWith(".pdf") ? "application/pdf" : "text/markdown", body: Buffer.from("OFFLINE fixture bytes") })));
  return { directory, store, close() { store.close(); rmSync(directory, { recursive: true }); } };
}
test("personal launch pins profile/loopback separately, rejects invalid Node/ports", () => {
  const env = personalEnvironment({ PORT: "4387", HOST: "0.0.0.0", JEVBOX_PROFILE: "legacy" }, "24.6.0");
  assert.equal(env.PORT, "4388"); assert.equal(env.HOST, "127.0.0.1"); assert.equal(env.JEVBOX_PROFILE, "personal-file");
  assert.throws(() => personalEnvironment({ PERSONAL_FILE_PORT: "4387" })); assert.throws(() => personalEnvironment({}, "22.0.0"));
});
test("native source/KB CMK inheritance is explicit; overrides and other definition drift fail", () => {
  const encryption = { isServiceLevelKey: true as const, keyVaultUri: "https://offline.vault.azure.net", keyVaultKeyName: "offline", keyVaultKeyVersion: "v1" };
  const config = { ...personalTestConfig, inheritedEncryption: encryption };
  assert.doesNotThrow(() => personalConfigSchema.parse({ ...config, inheritedEncryption: { ...encryption, accessCredentials: null, identity: null } }));
  assert.throws(() => personalConfigSchema.parse({ ...config, inheritedEncryption: { ...encryption, identity: { applicationId: "OFFLINE-override" } } }));
  for (const desired of [sourceDefinition(config), kbDefinition(config)]) {
    assert.doesNotThrow(() => assertDefinition({ ...desired, "@odata.etag": "v1", encryptionKey: encryption, description: null }, desired, config));
    const entity = "kind" in desired ? "knowledgesources" : "knowledgebases";
    assert.doesNotThrow(() => assertDefinition({ ...desired, encryptionKey: encryption,
      "@odata.context": `${config.searchEndpoint}/$metadata#${entity}/$entity` }, desired, config));
    assert.throws(() => assertDefinition({ ...desired, encryptionKey: encryption,
      "@odata.context": `${config.searchEndpoint}/$metadata#indexes/$entity` }, desired, config), /metadata context/);
    assert.throws(() => assertDefinition({ ...desired, encryptionKey: { ...encryption, isServiceLevelKey: false } }, desired, config));
    assert.throws(() => assertDefinition({ ...desired, encryptionKey: { ...encryption, keyVaultKeyVersion: "v2" } }, desired, config));
    assert.throws(() => assertDefinition({ ...desired, encryptionKey: encryption, unexpected: true }, desired, config));
  }
  const desired = sourceDefinition(personalTestConfig);
  const observed = { ...desired, "@odata.context": `${personalTestConfig.searchEndpoint}/$metadata#knowledgesources/$entity`,
    fileParameters: { ...desired.fileParameters, ingestionParameters: { ...desired.fileParameters.ingestionParameters, ingestionPermissionOptions: [] } } };
  assert.doesNotThrow(() => assertDefinition(observed, desired, personalTestConfig));
  assert.throws(() => assertDefinition({ ...observed, "@odata.context": "https://other.search.windows.net/$metadata#knowledgesources/$entity" }, desired, personalTestConfig), /metadata context/);
  assert.throws(() => assertDefinition({ ...observed, fileParameters: { ...observed.fileParameters,
    ingestionParameters: { ...observed.fileParameters.ingestionParameters, ingestionPermissionOptions: ["userIds"] } } }, desired, personalTestConfig), /differs/);
});
test("unapproved/expired/config-drift plans make zero native requests; active lease survives another connection", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    const { store } = testStore, plan = store.makePlan("ingest", personalTestConfig, personalTestBounds);
    const run = createPersonalWorkflow(store, personalTestConfig, async () => "OFFLINE", fake.transport);
    await assert.rejects(run(plan.id, "ingest"), /approval/i); assert.equal(fake.requests.length, 0);
    store.approve(plan.id, "OFFLINE explicit test approval");
    store.acquire(plan.id, personalTestConfig);
    const second = new PersonalStore(testStore.directory);
    try { assert.throws(() => second.acquire(plan.id, personalTestConfig), /in progress/); } finally { second.close(); }
    store.release(plan, false);
    const next = store.makePlan("chat", personalTestConfig, personalTestBounds); store.approve(next.id, "OFFLINE");
    assert.throws(() => store.acquire(next.id, { ...personalTestConfig, kbName: "different-kb" }), /preflight/);
    const expired = store.makePlan("chat", personalTestConfig, personalTestBounds);
    const raw = store.db.prepare("SELECT plan FROM operations WHERE id=?").get(expired.id)!;
    store.db.prepare("UPDATE operations SET plan=? WHERE id=?").run(String(raw.plan).replace(expired.expiresAt, "2000-01-01T00:00:00.000Z"), expired.id);
    assert.throws(() => store.approve(expired.id, "OFFLINE"), /integrity/);
  } finally { testStore.close(); }
});
test("OFFLINE injected full native workflow preserves native identities, citations and question allowance", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    const { store } = testStore, run = createPersonalWorkflow(store, personalTestConfig, async () => "OFFLINE", fake.transport);
    for (const stage of ["ingest", "kb", "chat", "inspect"] as const) {
      const plan = store.makePlan(stage, personalTestConfig, personalTestBounds); store.approve(plan.id, "OFFLINE explicit test approval");
      await run(plan.id, stage, stage === "chat" ? "What does the source say?" : undefined);
    }
    assert.equal(store.snapshot()!.state, "ready");
    assert.equal(store.snapshot()!.documents.filter((file) => file.state === "indexed").length, 7);
    assert.equal(fake.requests.filter((request) => request.method === "PUT").length, 2);
    assert.equal(fake.requests.filter((request) => request.url.includes("/files?") && request.method === "POST").length, 7);
    assert.equal(fake.requests.filter((request) => request.url.includes("/retrieve?")).length, 1);
    assert.equal(fake.requests.filter((request) => request.url.includes("/chat/completions")).length, 1);
    assert.equal(store.answers()[0].citations[0].fileId, "native-1");
    assert.equal(store.operations().find((operation) => operation.stage === "chat")!.questionsUsed, 1);
    const chat = store.operations().find((operation) => operation.stage === "chat")!;
    for (let index = 1; index < 10; index++) await run(chat.id, "chat", "An explicitly synthetic follow-up");
    const requestCount = fake.requests.length;
    await assert.rejects(run(chat.id, "chat", "Eleventh question"), /remaining allowance/);
    assert.equal(fake.requests.length, requestCount); assert.equal(store.operations().find((operation) => operation.id === chat.id)!.questionsUsed, 10);
    const drive = personalDrive(store.snapshot()!.documents);
    assert(drive.items.every((item) => item.path.startsWith("Cedar/")));
    assert(fake.requests.filter((request) => request.url.includes("/docs/search")).every((request) => !request.body.includes('"filter"')),
      "non-filterable parent never causes invented filter syntax");
  } finally { testStore.close(); }
});
test("app-owned continuation uses original ACK/journals and never re-creates the source", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    let injectMismatch = true;
    const transport: NativeTransport = async (url, init) => {
      const response = await fake.transport(url, init);
      if (injectMismatch && response.ok && init.method === "GET" && /knowledgesources\('offline-source'\)\?/.test(url)) {
        return new Response(JSON.stringify({ ...await response.json(), unexpected: true }), { status: 200, headers: response.headers });
      }
      return response;
    };
    const { store } = testStore, run = createPersonalWorkflow(store, personalTestConfig, async () => "OFFLINE", transport);
    const first = store.makePlan("ingest", personalTestConfig, personalTestBounds); store.approve(first.id, "OFFLINE");
    await assert.rejects(run(first.id, "ingest"), /differs/); assert.equal(store.snapshot()!.state, "partial");
    assert.equal(fake.files.length, 0);
    injectMismatch = false;
    const continuation = store.makePlan("ingest", personalTestConfig, personalTestBounds); assert.equal(continuation.mode, "continue");
    store.approve(continuation.id, "OFFLINE new explicit continuation approval"); await run(continuation.id, "ingest");
    assert.equal(store.snapshot()!.state, "indexed");
    assert.equal(fake.requests.filter((request) => request.method === "PUT").length, 1);
    assert.equal(fake.files.length, 7);
  } finally { testStore.close(); }
});
test("missing original creation journals and stale metadata block without native calls", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    const { store } = testStore; store.setSnapshot("partial", "OFFLINE injected missing original provenance");
    const plan = store.makePlan("ingest", personalTestConfig, personalTestBounds); store.approve(plan.id, "OFFLINE");
    await assert.rejects(createPersonalWorkflow(store, personalTestConfig, async () => "OFFLINE", fake.transport)(plan.id, "ingest"), /provenance is missing/);
    assert.equal(fake.requests.length, 0);
    store.db.prepare("UPDATE preflight SET observed='2000-01-01T00:00:00.000Z'").run();
    assert.throws(() => store.makePlan("chat", personalTestConfig, personalTestBounds), /Fresh exact-resource/);
  } finally { testStore.close(); }
});
test("read-only preflight stays on exact metadata/assignee boundaries and rejects child-only grants", async () => {
  const roleNames = ["Search Service Contributor", "Search Index Data Contributor", "Search Index Data Reader", "Cognitive Services User", "Cognitive Services OpenAI User"];
  const mi = "10000000-0000-4000-8000-000000000004", account = personalTestConfig.projectResourceId.split("/projects/")[0];
  const paths: string[] = []; let childOnly = false, customOnly = false;
  const transport: NativeTransport = async (url, init) => {
    assert.equal(init.method ?? "GET", "GET"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer OFFLINE");
    const parsed = new URL(url); paths.push(parsed.pathname);
    let body: unknown;
    if (parsed.pathname === personalTestConfig.searchResourceId) body = { identity: { principalId: mi }, properties: { provisioningState: "Succeeded", encryptionWithCmk: { enforcement: "Disabled" } }, sku: { name: "S2" } };
    else if (parsed.pathname === account) body = { kind: "AIServices" };
    else if (parsed.pathname === personalTestConfig.projectResourceId) body = { properties: { endpoints: { AIProjectEndpoint: personalTestConfig.projectEndpoint } } };
    else if (parsed.pathname.includes("/deployments/")) {
      const selected = parsed.pathname.endsWith("/chat") ? personalTestConfig.chat : personalTestConfig.embedding;
      body = { properties: { provisioningState: "Succeeded", model: { name: selected.model, version: selected.version } }, sku: { name: "GlobalStandard", capacity: 50 } };
    } else if (parsed.pathname.endsWith("/roleAssignments")) {
      assert(parsed.searchParams.get("$filter")!.includes("principalId eq"));
      const search = parsed.pathname.startsWith(personalTestConfig.searchResourceId), offset = search ? 0 : 3;
      body = { value: roleNames.slice(offset, search ? 3 : 5).map((_role, index) => ({
        properties: { principalId: search ? personalTestConfig.ownerOid : mi, scope: `${search ? personalTestConfig.searchResourceId : account}${childOnly ? "/projects/child" : ""}`,
          roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/20000000-0000-4000-8000-00000000000${offset + index}` },
      })) };
    }     else if (parsed.pathname.includes("/roleDefinitions/")) body = { properties: { roleName: roleNames[Number(parsed.pathname.at(-1))], type: customOnly ? "CustomRole" : "BuiltInRole" } };
    else if (parsed.pathname.includes("/knowledgesources(")) body = { encryptionKey: null };
    else throw new Error(`Unexpected metadata route ${parsed.pathname}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const evidence = await readPersonalPreflight(personalTestConfig, async () => "OFFLINE", transport);
  assert.equal(evidence.deployments.length, 2);
  assert(paths.every((path) => !/listKeys|retrieve|docs\/search|chat\/completions/i.test(path)));
  childOnly = true;
  await assert.rejects(readPersonalPreflight(personalTestConfig, async () => "OFFLINE", transport), /Unverified unconditional roles/);
  childOnly = false; customOnly = true;
  await assert.rejects(readPersonalPreflight(personalTestConfig, async () => "OFFLINE", transport), /Unverified unconditional roles/);
  customOnly = false;
  await assert.rejects(readPersonalPreflight({ ...personalTestConfig, cmkBaselineSource: null }, async () => "OFFLINE", transport), /does not prove/);
});
test("stale approvals, frozen indexed configuration and authentication-time expiry reject before dispatch", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    const { store } = testStore;
    const pending = store.makePlan("ingest", personalTestConfig, personalTestBounds);
    store.recordPreflight(personalTestConfig, { kind: "OFFLINE changed evidence" });
    assert.throws(() => store.approve(pending.id, "OFFLINE"), /Metadata context changed/);
    const approved = store.makePlan("chat", personalTestConfig, personalTestBounds); store.approve(approved.id, "OFFLINE");
    store.recordPreflight(personalTestConfig, { kind: "OFFLINE another changed evidence" });
    assert.equal(store.operations().find((operation) => operation.id === approved.id)!.state, "approval-stale");
    store.db.prepare("UPDATE snapshots SET config_digest=?").run(digest(personalTestConfig));
    const changed = { ...personalTestConfig, chat: { ...personalTestConfig.chat, version: "OFFLINE-different" } };
    store.recordPreflight(changed, { kind: "OFFLINE changed model metadata" });
    assert.throws(() => store.makePlan("chat", changed, personalTestBounds), /explicit migration/);
    const deadlinePlan = { ...pending };
    await assert.rejects(createNativeClient(personalTestConfig, store, deadlinePlan, async () => {
      deadlinePlan.expiresAt = "2000-01-01T00:00:00.000Z"; return "OFFLINE";
    }, fake.transport).source(), /deadline reached during authentication/);
    assert.equal(fake.requests.length, 0);
  } finally { testStore.close(); }
});
test("known native content rejection is failed, not a successful or replayable upload", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    const { store } = testStore, plan = store.makePlan("ingest", personalTestConfig, personalTestBounds); store.approve(plan.id, "OFFLINE");
    const run = createPersonalWorkflow(store, personalTestConfig, async () => "OFFLINE", async (url, init) =>
      url.includes("/files?") && init.method === "POST" ? new Response("OFFLINE unsupported content", { status: 415 }) : fake.transport(url, init));
    await assert.rejects(run(plan.id, "ingest"), /415/);
    assert.equal(store.snapshot()!.documents.filter((file) => file.state === "failed").length, 1);
    assert.equal(store.snapshot()!.state, "partial");
  } finally { testStore.close(); }
});
test("model drift stops before mutation; incomplete index statistics retain partial state", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    const { store } = testStore, plan = store.makePlan("ingest", personalTestConfig, personalTestBounds); store.approve(plan.id, "OFFLINE");
    const run = createPersonalWorkflow(store, personalTestConfig, async () => "OFFLINE", async (url, init) => {
      const result = await fake.transport(url, init);
      if (url.includes("/deployments/embedding")) return new Response(JSON.stringify({
        properties: { provisioningState: "Succeeded", model: { name: "text-embedding-3-small", version: "OFFLINE-drift" } },
      }), { status: 200 });
      return result;
    });
    await assert.rejects(run(plan.id, "ingest"), /deployment\/model\/version changed/);
    assert.equal(store.snapshot()!.state, "local");
    assert(fake.requests.every((request) => request.method === "GET"));
    assert.equal(fake.files.length, 0);
    const next = store.makePlan("ingest", personalTestConfig, personalTestBounds); store.approve(next.id, "OFFLINE new approval");
    await assert.rejects(createPersonalWorkflow(store, personalTestConfig, async () => "OFFLINE", async (url, init) =>
      url.includes("/stats?") ? new Response(JSON.stringify({ documentCount: 0, storageSize: 0 }), { status: 200 }) : fake.transport(url, init))
      (next.id, "ingest"), /statistics do not yet confirm/);
    assert.equal(store.snapshot()!.state, "partial"); assert.equal(fake.files.length, 7);
  } finally { testStore.close(); }
});
test("uncertain upload is retained and never replayed, including after recovery", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    const { store } = testStore, plan = store.makePlan("ingest", personalTestConfig, personalTestBounds); store.approve(plan.id, "OFFLINE");
    let posts = 0;
    const run = createPersonalWorkflow(store, personalTestConfig, async () => "OFFLINE", async (url, init) => {
      if (url.includes("/files?") && init.method === "POST") { posts++; throw new Error("OFFLINE unknown timeout"); }
      return fake.transport(url, init);
    });
    await assert.rejects(run(plan.id, "ingest"), /uncertain/);
    assert.equal(store.snapshot()!.state, "partial"); assert.equal(store.snapshot()!.documents.filter((file) => file.state === "uncertain").length, 1);
    const next = store.makePlan("ingest", personalTestConfig, personalTestBounds); store.approve(next.id, "OFFLINE fresh review");
    await assert.rejects(run(next.id, "ingest"), /cannot be replayed/); assert.equal(posts, 1);
  } finally { testStore.close(); }
});
test("request bound persists across clients and budget reservations never reset silently", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    const { store } = testStore, plan = store.makePlan("inspect", personalTestConfig, { ...personalTestBounds, maxRequests: 1 }); store.approve(plan.id, "OFFLINE");
    await assert.rejects(createNativeClient(personalTestConfig, store, plan, async () => "OFFLINE", fake.transport).source());
    await assert.rejects(createNativeClient(personalTestConfig, store, plan, async () => "OFFLINE", fake.transport).source(), /bound/);
    assert.equal(fake.requests.length, 1);
    const excess = store.makePlan("chat", personalTestConfig, { ...personalTestBounds, incrementalAllowanceUsd: 10 });
    assert.throws(() => store.approve(excess.id, "OFFLINE"), /remaining-budget/);
  } finally { testStore.close(); }
});
test("context cap measures the actual serialized answer request, including escaped question/schema overhead", async () => {
  const testStore = localStore(), fake = syntheticPersonalTransport(personalTestConfig);
  try {
    const { store } = testStore, run = createPersonalWorkflow(store, personalTestConfig, async () => "OFFLINE", fake.transport);
    for (const stage of ["ingest", "kb"] as const) {
      const plan = store.makePlan(stage, personalTestConfig, personalTestBounds); store.approve(plan.id, "OFFLINE"); await run(plan.id, stage);
    }
    const chat = store.makePlan("chat", personalTestConfig, personalTestBounds); store.approve(chat.id, "OFFLINE");
    await assert.rejects(run(chat.id, "chat", `Q${"\0".repeat(3500)}`), /Serialized answer context exceeds/);
    assert.equal(fake.requests.filter((request) => request.url.includes("/retrieve?")).length, 1);
    assert.equal(fake.requests.filter((request) => request.url.includes("/chat/completions")).length, 0);
    assert.equal(store.operations().find((operation) => operation.id === chat.id)!.questionsUsed, 1);
  } finally { testStore.close(); }
});
