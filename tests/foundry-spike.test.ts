import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { spikeConfigSchema, spikeReport, fixedSpikeQuestions, runNativeSpike } from "../server/foundry/spike";
import { startNativeSpike, scheduleNativeSpikeDeadline } from "../scripts/foundry-native-spike";
import { evidenceSchema } from "../shared/evidence";
import { DelegatedCredential } from "../server/foundry/credentials";
import { buildNativeArtifacts } from "../server/foundry/setup-artifacts";
import { indexDocument } from "../server/foundry/search-index";
import { fixtureEvidence, testConfig, testOids } from "./foundry-fixtures";

function input() {
  const publicUnit = fixtureEvidence.find((unit) => unit.contentKind === "raw" && unit.locator.sectionPath.includes("Preview scope"))!;
  const privateUnit = fixtureEvidence.find((unit) => unit.contentKind === "raw" && unit.locator.sectionPath.includes("Pilot offer"))!;
  assert(publicUnit.contentKind === "raw" && privateUnit.contentKind === "raw");
  const dependency = { evidenceId: privateUnit.indexKey, locator: privateUnit.locator };
  const { locator: _locator, ...common } = privateUnit;
  const wiki = evidenceSchema.parse({ ...common, contentKind: "wiki",
    indexKey: "offline-spike-wiki", artifactId: randomUUID(), wikiRevision: 1, reviewStatus: "published",
    dependencies: [dependency], supportingEvidence: [dependency] });
  return { runtime: { knowledge: testConfig, databaseSchema: "fiq_spike", workspaceName: "Offline",
    agentName: "offline-agent", entraClientId: randomUUID(), readerClientId: randomUUID(),
    writerClientId: randomUUID(), projectClientId: randomUUID(),
    approvals: { entraConsent: true, cloudCalls: true, syntheticUploads: false, vendorProcessing: false }, nativeProof: null },
    origin: "http://localhost:4388", approval: { approvedBy: "Offline fixture, not live approval",
      signIn: true, nativeQueries: true, modelProbes: true, syntheticOnly: true,
      expiresAt: new Date(Date.now() + 300000).toISOString() },
    maxRequests: 80, waitForExpiredSource: false, evidence: [publicUnit, privateUnit, wiki],
    publicKey: publicUnit.indexKey, privateRawKey: privateUnit.indexKey, privateWikiKey: wiki.indexKey,
    definitionReadback: null, wrongTenant: null };
}
async function syntheticCredentials() {
  const keys = await generateKeyPair("RS256");
  const tokens = new Map<string, string>();
  const credentials = await Promise.all(testConfig.roster.map(async (oid) => {
    const token = await new SignJWT({ tid: testConfig.tenantId, oid, scp: "user_impersonation" })
      .setProtectedHeader({ alg: "RS256" }).setIssuer("https://offline.invalid").setAudience("https://search.azure.com")
      .setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
    tokens.set(token, oid);
    return DelegatedCredential.verify({ token, sessionIdentity: { tenantId: testConfig.tenantId, objectId: oid },
      tenantId: testConfig.tenantId, audience: "https://search.azure.com", issuer: "https://offline.invalid",
      delegatedScope: "user_impersonation", roster: testConfig.roster, key: async () => keys.publicKey });
  }));
  return { credentials, tokens };
}
test("OFFLINE preactivation rejects unapproved, expired, broad, unresolved and proof-bearing configuration before clients", async () => {
  const valid = input();
  for (const changed of [
    { approval: { ...valid.approval, signIn: false } },
    { approval: { ...valid.approval, nativeQueries: false } },
    { approval: { ...valid.approval, expiresAt: new Date(Date.now() - 1000).toISOString() } },
    { origin: "http://external.example:4388" },
    { evidence: valid.evidence.map((unit) => unit.contentKind === "wiki" ? { ...unit, userIds: [testOids.A, testOids.B] } : unit) },
    { runtime: { ...valid.runtime, approvals: { ...valid.runtime.approvals, cloudCalls: false } } },
    { definitionReadback: { approved: false, clientId: randomUUID(), role: "Reader" } },
    { definitionReadback: { approved: true, clientId: valid.runtime.readerClientId, role: "Reader" } },
    ...[valid.runtime.entraClientId, valid.runtime.readerClientId, valid.runtime.writerClientId, valid.runtime.projectClientId]
      .map((id) => ({ definitionReadback: { approved: true, clientId: id.toUpperCase(), role: "Reader" } })),
  ]) assert.equal(spikeConfigSchema.safeParse({ ...valid, ...changed }).success, false);
  let touched = false;
  await assert.rejects(() => runNativeSpike({ ...valid, approval: { ...valid.approval, nativeQueries: false } }, {
    execution: "offline", async credentials() { touched = true; return []; },
    async reader() { touched = true; throw new Error("Forbidden"); }, async project() { touched = true; throw new Error("Forbidden"); },
    fetcher: async () => { touched = true; throw new Error("Forbidden"); }, questions: { public: "", private: "" },
  }, new AbortController().signal));
  assert.equal(touched, false);
});
test("OFFLINE fixed source/section bindings are mandatory and partial/offline observations never issue activation-ready proof", async () => {
  const config = spikeConfigSchema.parse(input());
  const questions = await fixedSpikeQuestions(config);
  assert.match(questions.public, /Cedar/); assert.match(questions.private, /Orion Lantern/);
  assert.equal(spikeReport(config, [], "live").nativeProof, null);
  const names = ["rest-public-A", "rest-public-B", "rest-private-A", "rest-denied-B", "rest-wiki-A", "rest-wiki-denied-B",
    "rest-missing", "rest-invalid", "rest-expired", "rest-wrong-tenant", "mcp-public-A", "mcp-public-B", "mcp-private-A",
    "mcp-denied-B", "agent-A", "agent-B", "mcp-missing", "mcp-invalid", "mcp-expired", "mcp-wrong-tenant",
    "definitions", "planning", "unchanged-originals", "project-models"];
  const observations = names.map((check) => ({ check, status: "passed" as const }));
  assert.equal(spikeReport(config, observations, "offline").nativeProof, null);
  assert.equal(spikeReport(config, observations, "live").nativeProof, null, "Hand-authored observations are not a live execution receipt");
  assert.equal(spikeReport(config, observations.filter((item) => item.check !== "mcp-expired"), "live").nativeProof, null);
  await assert.rejects(() => fixedSpikeQuestions({ ...config, evidence: config.evidence.map((unit) =>
    unit.indexKey === config.publicKey ? { ...unit, text: "Unsupported replacement" } : unit) }));
});
test("OFFLINE injected transport cannot be relabeled live and is rejected before any clients or calls", async () => {
  let touched = false;
  await assert.rejects(() => runNativeSpike(input(), {
    execution: "live",
    async credentials() { touched = true; return []; },
    async reader() { touched = true; throw new Error("Forbidden"); },
    async project() { touched = true; throw new Error("Forbidden"); },
    fetcher: async () => { touched = true; throw new Error("Forbidden"); },
    questions: { public: "", private: "" },
  }, new AbortController().signal), /Injected transports/);
  assert.equal(touched, false);
});
test("OFFLINE native refusal/unknown schema is recorded privately and cannot become proof or disclose tokens/provider payloads", async () => {
  const config = spikeConfigSchema.parse(input());
  const { credentials } = await syntheticCredentials();
  let count = 0;
  const report = await runNativeSpike(config, { execution: "offline", credentials: async () => credentials,
    reader: async () => ({ token: "offline-reader", expiresAt: Date.now() + 3600000 }),
    project: async () => ({ token: "offline-project", expiresAt: Date.now() + 3600000 }),
    fetcher: async (target) => {
      assert(String(target).startsWith(testConfig.searchEndpoint) || String(target).startsWith(testConfig.projectEndpoint));
      count++; return new Response("PRIVATE_PROVIDER_FAILURE", { status: 403 });
    }, questions: await fixedSpikeQuestions(config) }, new AbortController().signal);
  assert(count > 0 && count <= config.maxRequests);
  assert.equal(report.nativeProof, null); assert(report.observations.some((item) => item.status === "unverified"));
  assert(!JSON.stringify(report).includes("PRIVATE_PROVIDER_FAILURE"));
  assert(!JSON.stringify(report).includes("offline-reader"));
  assert(!JSON.stringify(report).includes("eyJ"));
});
test("OFFLINE operator refuses invalid approval and missing credentials before private output, authentication or network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevbox-spike-refusal-"));
  const configFile = join(directory, "operator.spike.local.json");
  const output = join(directory, "foundry-spike-private");
  const originalFetch = globalThis.fetch;
  const names = ["ENTRA_CLIENT_SECRET", "FOUNDRY_READER_SECRET", "FOUNDRY_PROJECT_SECRET"];
  const original = names.map((name) => process.env[name]);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected network during refusal"); };
  for (const name of names) delete process.env[name];
  try {
    const valid = input();
    await writeFile(configFile, JSON.stringify({ ...valid, approval: { ...valid.approval, signIn: false } }));
    await assert.rejects(() => startNativeSpike(configFile, output));
    await assert.rejects(() => access(output), { code: "ENOENT" });
    await writeFile(configFile, JSON.stringify(valid));
    await assert.rejects(() => startNativeSpike(configFile, output), /credentials unavailable/);
    await assert.rejects(() => access(output), { code: "ENOENT" });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name]; else process.env[name] = original[index];
    });
    await rm(directory, { recursive: true });
  }
});
test("OFFLINE approval deadline without verification exits nonzero even when exact cleanup succeeds", async (context) => {
  const exitCode = process.exitCode;
  const originalFetch = globalThis.fetch;
  let calls = 0, closed = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Forbidden deadline network"); };
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    scheduleNativeSpikeDeadline(new Date(Date.now() + 1000).toISOString(), async () => { closed++; });
    context.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(process.exitCode, 2);
    assert.equal(closed, 1);
    assert.equal(calls, 0);
  } finally {
    context.mock.timers.reset();
    process.exitCode = exitCode;
    globalThis.fetch = originalFetch;
  }
});
test("OFFLINE successful REST, actual MCP SDK and agent/model payload probes remain non-live and output-bounded", async () => {
  const config = spikeConfigSchema.parse({ ...input(),
    definitionReadback: { approved: true, clientId: randomUUID(), role: "Reader" } });
  const { credentials, tokens } = await syntheticCredentials();
  const artifacts = buildNativeArtifacts({ ...testConfig, agentName: config.runtime.agentName, connectionName: "offline" });
  const questions = await fixedSpikeQuestions(config);
  const byKey = new Map(config.evidence.map((unit) => [unit.indexKey, unit]));
  const chunks = (question: string, oid: string, wiki = false) => {
    const key = question === questions.public ? config.publicKey : wiki ? config.privateWikiKey : config.privateRawKey;
    const unit = byKey.get(key)!;
    return unit.userIds.includes(oid) ? [{
      ref_id: key, content: unit.text, terms: JSON.stringify({ schemaVersion: 1, indexKey: key }),
    }] : [];
  };
  let projectProbes = 0;
  let definitionGets = 0;
  const report = await runNativeSpike(config, {
    execution: "offline", credentials: async () => credentials, questions,
    reader: async () => ({ token: "offline-reader", expiresAt: Date.now() + 3600000 }),
    definitions: async () => ({ token: "offline-definitions", expiresAt: Date.now() + 3600000 }),
    project: async () => ({ token: "offline-project", expiresAt: Date.now() + 3600000 }),
    fetcher: async (target, options) => {
      const url = new URL(String(target));
      const headers = new Headers(options?.headers);
      const body = options?.body ? z.record(z.string(), z.unknown()).parse(JSON.parse(String(options.body))) : {};
      if (url.origin === testConfig.searchEndpoint) {
        if ([`/indexes/${testConfig.indexName}`, `/knowledgesources/${testConfig.knowledgeSourceName}`,
          `/knowledgebases/${testConfig.knowledgeBaseName}`].includes(url.pathname)) {
          assert.equal(options?.method ?? "GET", "GET");
          definitionGets++;
          assert.equal(headers.get("Authorization"), "Bearer offline-definitions");
          assert.equal(headers.get("x-ms-query-source-authorization"), null);
          if (url.pathname.startsWith("/indexes/")) return Response.json(artifacts.index);
          if (url.pathname.startsWith("/knowledgesources/")) return Response.json(artifacts.knowledgeSource);
          return Response.json(artifacts.knowledgeBase);
        }
        assert.equal(headers.get("Authorization"), "Bearer offline-reader");
        const oid = tokens.get(headers.get("x-ms-query-source-authorization") ?? "");
        if (!oid) return new Response(null, { status: 401 });
        if (url.pathname.endsWith("/docs/search")) return Response.json({
          value: config.evidence.map((unit) => indexDocument(unit, [0, 0, 0], 3)),
        });
        if (url.pathname.endsWith("/retrieve")) {
          const messages = z.array(z.object({ content: z.array(z.object({ text: z.string() })) })).parse(body.messages);
          const params = z.array(z.object({ filterAddOn: z.string() })).parse(body.knowledgeSourceParams);
          const question = messages[0].content[0].text;
          const selected = chunks(question, oid, params[0].filterAddOn.includes("contentKind eq 'wiki'"));
          return Response.json({ response: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify(selected) }] }],
            references: selected.map((chunk) => ({ type: "searchIndex", id: chunk.ref_id, activitySource: 1, docKey: chunk.ref_id })),
            activity: [{ id: 0, type: "modelQueryPlanning" }, { id: 1, type: "searchIndex",
              searchIndexArguments: { search: question, vectorQueries: [{ kind: "text", text: question }] } }] });
        }
        assert(url.pathname.endsWith("/mcp"));
        if (options?.method === "GET") return new Response(null, { status: 405 });
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
        if (body.method === "initialize") {
          const params = z.object({ protocolVersion: z.string() }).parse(body.params);
          return reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} },
            serverInfo: { name: "OFFLINE synthetic MCP", version: "1.0.0" } });
        }
        if (body.method === "tools/list") return reply({ tools: [{ name: "knowledge_base_retrieve",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] });
        assert.equal(body.method, "tools/call");
        const params = z.object({ name: z.literal("knowledge_base_retrieve"), arguments: z.object({ query: z.string() }) }).parse(body.params);
        return reply({ content: [{ type: "text", text: JSON.stringify(chunks(params.arguments.query, oid)) }] });
      }
      assert.equal(headers.get("Authorization"), "Bearer offline-project");
      if (url.pathname.endsWith("/responses")) {
        assert.equal(body.max_output_tokens, 512);
        const source = z.object({ search_auth_token: z.string() }).parse(body.structured_inputs);
        const oid = tokens.get(source.search_auth_token)!;
        const selected = chunks(questions.private, oid);
        return Response.json({ id: "offline-response", status: "completed", output: [
          { type: "mcp_call", name: "knowledge_base_retrieve", id: "offline-call",
            output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(selected) }] }) },
          { type: "message", content: [{ type: "output_text",
            text: selected.length ? `Synthetic private answer [${config.privateRawKey}]` : "I don't know" }] },
        ] });
      }
      projectProbes++;
      if (url.pathname.endsWith("/embeddings")) return Response.json({ data: [{ index: 0, embedding: [0, 0, 0] }] });
      assert(url.pathname.endsWith("/chat/completions"));
      assert.equal(body.max_completion_tokens, 512);
      return Response.json({ choices: [{ finish_reason: "stop", message: {
        content: JSON.stringify({ answer: `Synthetic public answer [${config.publicKey}]`, evidenceIds: [config.publicKey] }),
      } }] });
    },
  }, new AbortController().signal);
  assert.deepEqual(report.observations.filter((item) => item.status === "failed"), []);
  assert.equal(report.observations.filter((item) => item.status === "unverified").length, 4);
  assert.equal(projectProbes, 2);
  assert.equal(definitionGets, 3);
  assert(report.toolSchemas.length >= 4);
  assert(report.toolSchemas.every((tool) => tool.queryType === "string" && !tool.unsupportedRequiredInputs));
  assert.equal(report.nativeProof, null);
  assert.equal(report.status, "partial");
});
test("OFFLINE absent/denied definition readback remains partial without widening query identity", async () => {
  const { credentials } = await syntheticCredentials();
  for (const approved of [false, true]) {
    const config = spikeConfigSchema.parse({ ...input(),
      definitionReadback: approved ? { approved: true, clientId: randomUUID(), role: "Reader" } : null });
    let definitions = 0;
    const report = await runNativeSpike(config, {
      execution: "offline", credentials: async () => credentials, questions: await fixedSpikeQuestions(config),
      reader: async () => ({ token: "offline-reader", expiresAt: Date.now() + 3600000 }),
      project: async () => ({ token: "offline-project", expiresAt: Date.now() + 3600000 }),
      definitions: async () => {
        definitions++; assert(approved);
        return { token: "offline-definitions", expiresAt: Date.now() + 3600000 };
      },
      fetcher: async (target, options) => {
        const url = new URL(String(target));
        const headers = new Headers(options?.headers);
        const definition = [`/indexes/${testConfig.indexName}`, `/knowledgesources/${testConfig.knowledgeSourceName}`,
          `/knowledgebases/${testConfig.knowledgeBaseName}`].includes(url.pathname);
        assert.equal(headers.get("Authorization"), definition ? "Bearer offline-definitions" :
          url.origin === testConfig.searchEndpoint ? "Bearer offline-reader" : "Bearer offline-project");
        if (definition) assert.equal(headers.get("x-ms-query-source-authorization"), null);
        return new Response(null, { status: 403 });
      },
    }, new AbortController().signal);
    assert.equal(definitions, approved ? 1 : 0);
    assert.equal(report.observations.find((item) => item.check === "definitions")?.status, approved ? "failed" : "unverified");
    assert.equal(report.nativeProof, null);
    assert.equal(report.status, "partial");
  }
});
