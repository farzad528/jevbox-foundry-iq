import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { evidenceSchema, type Evidence, type SourceState } from "../../shared/evidence";
import { runtimeConfigSchema, nativeBinding, nativeProofSchema } from "./runtime-config";
import { searchApiVersion } from "./config";
import { delegatedHeader, serviceHeader, type DelegatedCredential, type ServiceCredential } from "./credentials";
import { createIqClient, iqRetrieveRequest, normalizeRestEvidence, normalizeMcpEvidence, normalizeNativeCitations } from "./iq-client";
import { createNativeAgentClient } from "./native-agent";
import { createFoundryModels } from "./model-client";
import { indexDocument } from "./search-index";
import { HttpError } from "../errors";
import { readFile } from "node:fs/promises";

const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) &&
    !!url.port && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
}, "Use an exact approved HTTP loopback origin with a port");
export const spikeConfigSchema = z.strictObject({
  runtime: runtimeConfigSchema,
  origin,
  approval: z.strictObject({
    approvedBy: z.string().min(1).max(160),
    signIn: z.literal(true), nativeQueries: z.literal(true), modelProbes: z.literal(true),
    syntheticOnly: z.literal(true), expiresAt: z.iso.datetime(),
  }),
  maxRequests: z.number().int().min(1).max(100),
  waitForExpiredSource: z.boolean(),
  evidence: z.array(evidenceSchema).min(3).max(128),
  publicKey: z.string(), privateRawKey: z.string(), privateWikiKey: z.string(),
  definitionReadback: z.strictObject({
    approved: z.literal(true), clientId: z.uuid(), role: z.literal("Reader"),
  }).nullable().default(null),
  wrongTenant: z.strictObject({
    approved: z.literal(true), tenantId: z.uuid(), roster: z.array(z.uuid()).length(2),
    expectedOid: z.uuid(), clientId: z.uuid(), origin,
  }).nullable(),
}).superRefine((config, context) => {
  const k = config.runtime.knowledge;
  if (config.runtime.nativeProof || !config.runtime.approvals.entraConsent || !config.runtime.approvals.cloudCalls)
    context.addIssue({ code: "custom", message: "Preactivation requires separately approved consent/calls and a null main-app proof" });
  const until = Date.parse(config.approval.expiresAt) - Date.now();
  if (until < 60000 || until > 2 * 3600000)
    context.addIssue({ code: "custom", message: "Approval must expire within two hours" });
  const byKey = new Map(config.evidence.map((unit) => [unit.indexKey, unit]));
  const publicUnit = byKey.get(config.publicKey), privateUnit = byKey.get(config.privateRawKey), wiki = byKey.get(config.privateWikiKey);
  if (byKey.size !== config.evidence.length || config.evidence.some((unit) => unit.workspaceId !== k.workspaceId ||
      !unit.current || !unit.retrievable || unit.userIds.some((oid) => !k.roster.includes(oid))) ||
      publicUnit?.contentKind !== "raw" || !k.roster.every((oid) => publicUnit.userIds.includes(oid)) ||
      privateUnit?.contentKind !== "raw" || privateUnit.userIds.join() !== k.roster[0] ||
      wiki?.contentKind !== "wiki" || wiki.userIds.join() !== k.roster[0] ||
      !wiki.dependencies.some((dependency) => dependency.evidenceId === config.privateRawKey))
    context.addIssue({ code: "custom", message: "Supply exact current public/raw-private/derived-private synthetic evidence" });
  if (config.evidence.reduce((sum, unit) => sum + unit.text.length, 0) > 150000 ||
      config.evidence.some((unit) => unit.contentKind === "wiki" && unit.dependencies.some((dependency) => {
        const source = byKey.get(dependency.evidenceId);
        return source?.contentKind !== "raw" || JSON.stringify(source.locator) !== JSON.stringify(dependency.locator) ||
          unit.userIds.some((oid) => !source.userIds.includes(oid));
      }))) context.addIssue({ code: "custom", message: "Synthetic corpus must be bounded and every wiki original fully bound" });
  if (config.wrongTenant && (config.wrongTenant.tenantId === k.tenantId ||
      config.wrongTenant.origin === config.origin || !config.wrongTenant.roster.includes(config.wrongTenant.expectedOid) ||
      new Set(config.wrongTenant.roster).size !== 2))
    context.addIssue({ code: "custom", message: "Adverse sign-in must use its separately approved exact foreign tenant/user/origin" });
  const definitionClientId = config.definitionReadback?.clientId.toLowerCase();
  if (definitionClientId && [config.runtime.entraClientId, config.runtime.readerClientId,
      config.runtime.writerClientId, config.runtime.projectClientId].some((id) =>
        id.toLowerCase() === definitionClientId))
    context.addIssue({ code: "custom", message: "Definition readback must use its separately approved operator identity" });
});
export type SpikeConfig = z.infer<typeof spikeConfigSchema>;
export type SpikeObservation = { check: string; status: "passed" | "failed" | "unverified"; code?: string };
export type SpikePorts = {
  execution: "live" | "offline";
  credentials(): Promise<DelegatedCredential[]>;
  wrongTenantCredential?(): Promise<DelegatedCredential | undefined>;
  reader(): Promise<ServiceCredential>;
  definitions?(): Promise<ServiceCredential>;
  project(): Promise<ServiceCredential>;
  fetcher: typeof fetch;
  questions: { public: string; private: string };
};
const liveExecutionReceipt = Symbol("live-execution-completed");
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export function runLiveNativeSpike(input: unknown, ports: Omit<SpikePorts, "execution" | "fetcher">, signal: AbortSignal) {
  return runNativeSpike(input, { ...ports, execution: "live", fetcher: nativeFetch }, signal);
}
export function spikeReport(config: SpikeConfig, observations: SpikeObservation[], execution: SpikePorts["execution"],
  receipt?: typeof liveExecutionReceipt) {
  const passed = (name: string) => observations.some((item) => item.check === name && item.status === "passed");
  const checks = {
    restTwoUserAcl: ["rest-public-A", "rest-public-B", "rest-private-A", "rest-denied-B", "rest-wiki-A", "rest-wiki-denied-B"].every(passed),
    restAdverseTokens: ["rest-missing", "rest-invalid", "rest-expired", "rest-wrong-tenant"].every(passed),
    mcpTwoUserAcl: ["mcp-public-A", "mcp-public-B", "mcp-private-A", "mcp-denied-B", "agent-A", "agent-B"].every(passed),
    mcpAdverseTokens: ["mcp-missing", "mcp-invalid", "mcp-expired", "mcp-wrong-tenant"].every(passed),
    mcpOriginalLocators: passed("agent-A") && passed("mcp-private-A"),
    hybridLowExtractive: passed("definitions") && passed("planning") && passed("unchanged-originals"),
    projectModelDeployments: passed("project-models"),
  };
  const complete = receipt === liveExecutionReceipt && execution === "live" &&
    Date.now() < Date.parse(config.approval.expiresAt) && Object.values(checks).every(Boolean) &&
    observations.every((item) => item.status === "passed");
  return { schemaVersion: 1, execution, status: complete ? "verified" : "partial", mutation: "none",
    observations, definitionReadback: config.definitionReadback, nativeProof: complete ? nativeProofSchema.parse({
      binding: nativeBinding(config.runtime), verifiedAt: new Date().toISOString(), tenantId: config.runtime.knowledge.tenantId,
      roster: config.runtime.knowledge.roster, knowledgeBaseName: config.runtime.knowledge.knowledgeBaseName,
      projectEndpoint: config.runtime.knowledge.projectEndpoint, checks,
    }) : null };
}
export async function runNativeSpike(input: unknown, ports: SpikePorts, signal: AbortSignal) {
  if (ports.execution === "live" && ports.fetcher !== nativeFetch)
    throw new Error("Injected transports cannot issue live native proof");
  const config = spikeConfigSchema.parse(input), k = config.runtime.knowledge;
  if (JSON.stringify(ports.questions) !== JSON.stringify(await fixedSpikeQuestions(config)))
    throw new Error("Only the fixed separately approved synthetic questions may execute");
  const lookup = new Map(config.evidence.map((unit) => [unit.indexKey, unit]));
  const states = new Map<string, SourceState>();
  for (const unit of config.evidence) {
    const id = unit.contentKind === "raw" ? unit.locator.documentId : unit.artifactId;
    states.set(id, { documentId: id, tenantId: k.tenantId, workspaceId: k.workspaceId,
      sourceRevision: unit.sourceRevision, aclRevision: unit.aclRevision,
      readers: unit.userIds, state: "verified" });
  }
  const observations: SpikeObservation[] = [];
  const toolSchemas: { name: string; queryType: string | null; unsupportedRequiredInputs: boolean }[] = [];
  const check = async (name: string, fn: () => Promise<void>) => {
    try { signal.throwIfAborted(); await fn(); observations.push({ check: name, status: "passed" }); }
    catch (error) { observations.push({ check: name, status: "failed",
      code: error instanceof HttpError && error.status === 401 ? "authentication-required" : "native-contract-or-service-failure" }); }
  };
  let requests = 0;
  const guarded: typeof fetch = async (target, options) => {
    const url = new URL(String(target)), search = k.searchEndpoint.replace(/\/$/, "");
    const allowed = ["/indexes/" + k.indexName, "/knowledgesources/" + k.knowledgeSourceName, "/knowledgebases/" + k.knowledgeBaseName];
    if (Date.now() >= Date.parse(config.approval.expiresAt) || ++requests > config.maxRequests ||
        (url.origin !== search && !String(target).startsWith(k.projectEndpoint.replace(/\/$/, "") + "/openai/v1/")) ||
        (url.origin === search && !allowed.some((path) => url.pathname === path || url.pathname.startsWith(path + "/"))) ||
        !["GET", "POST"].includes(options?.method ?? "GET")) throw new Error("Approved request boundary exceeded");
    if (url.origin === search && (url.pathname.endsWith("/docs/index") || url.searchParams.get("api-version") !== searchApiVersion))
      throw new Error("Provisioning/writes/API substitution are forbidden");
    const received = await ports.fetcher(target, { ...options, redirect: "error",
      signal: AbortSignal.any([signal, options?.signal ?? signal, AbortSignal.timeout(90000)]) });
    let bytes = 0;
    const response = received.body ? new Response(received.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 4_000_000) throw new Error("Native response exceeds approved bounded size");
        controller.enqueue(chunk);
      },
    })), { status: received.status, statusText: received.statusText, headers: received.headers }) : received;
    if (url.pathname.endsWith("/retrieve") && response.status === 200) {
      const payload = z.object({ activity: z.array(z.record(z.string(), z.unknown())) }).parse(await response.clone().json());
      if (payload.activity.some((item) => item.error || item.status === "failed")) throw new Error("Native activity contains an error");
      hybrid ||= payload.activity.some((item) => {
        const args = z.object({ search: z.string().min(1), vectorQueries: z.array(z.unknown()).min(1) }).safeParse(item.searchIndexArguments);
        return args.success;
      });
    }
    return response;
  };
  let hybrid = false;
  const [a, b] = await ports.credentials();
  if (!a || !b || a.identity.tenantId !== k.tenantId || b.identity.tenantId !== k.tenantId ||
      a.identity.objectId !== k.roster[0] || b.identity.objectId !== k.roster[1]) throw new HttpError(401, "Two exact authenticated users required");
  const originalToken = delegatedHeader(a);
  const get = async (path: string) => {
    const credential = ports.definitions;
    if (!config.definitionReadback || !credential) throw new Error("Separately approved definition readback unavailable");
    const response = await guarded(`${k.searchEndpoint.replace(/\/$/, "")}/${path}?api-version=${searchApiVersion}`,
      { headers: { Authorization: serviceHeader(await credential()) } });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error("Exact readback unavailable"); }
    return response.json() as Promise<unknown>;
  };
  if (!config.definitionReadback || !ports.definitions)
    observations.push({ check: "definitions", status: "unverified", code: "approved-definition-readback-unavailable" });
  else await check("definitions", async () => {
    const index = z.object({ name: z.string(), permissionFilterOption: z.literal("enabled"),
      fields: z.array(z.object({ name: z.string(), type: z.string(), filterable: z.boolean().optional(),
        permissionFilter: z.string().optional(), dimensions: z.number().optional(), vectorSearchProfile: z.string().optional() })),
      vectorSearch: z.object({
        profiles: z.array(z.object({ name: z.string(), vectorizer: z.string() })),
        vectorizers: z.array(z.object({ name: z.string(), kind: z.literal("azureOpenAI"),
          azureOpenAIParameters: z.object({ resourceUri: z.string(), deploymentId: z.string(), modelName: z.string() }) })),
      }),
      semantic: z.object({ defaultConfiguration: z.string() }),
    }).parse(await get(`indexes/${k.indexName}`));
    const acl = index.fields.filter((field) => field.permissionFilter);
    if (index.name !== k.indexName || acl.length !== 1 || acl[0].name !== "userIds" ||
        acl[0].permissionFilter !== "userIds" || acl[0].type !== "Collection(Edm.String)" || !acl[0].filterable ||
        !index.fields.some((field) => field.name === "contentVector" && field.dimensions === k.embeddingDimensions &&
          index.vectorSearch.profiles.some((profile) => profile.name === field.vectorSearchProfile &&
            index.vectorSearch.vectorizers.some((vectorizer) => vectorizer.name === profile.vectorizer &&
              vectorizer.azureOpenAIParameters.resourceUri.replace(/\/$/, "") === k.modelEndpoint.replace(/\/$/, "") &&
              vectorizer.azureOpenAIParameters.deploymentId === k.embeddingDeployment &&
              vectorizer.azureOpenAIParameters.modelName === k.embeddingModelName))))
      throw new Error("Native ACL/hybrid index mismatch");
    const source = z.object({ name: z.string(), kind: z.literal("searchIndex"),
      searchIndexParameters: z.object({ searchIndexName: z.string(), baseFilter: z.string(),
        searchFields: z.array(z.object({ name: z.string() })) }) }).parse(await get(`knowledgesources/${k.knowledgeSourceName}`));
    const kb = z.object({ name: z.string(), outputMode: z.literal("extractiveData"),
      retrievalReasoningEffort: z.object({ kind: z.literal("low") }),
      knowledgeSources: z.array(z.object({ name: z.string() })).length(1),
      models: z.array(z.object({ kind: z.literal("azureOpenAI"), azureOpenAIParameters: z.object({
        resourceUri: z.string(), deploymentId: z.string(), modelName: z.string(),
      }) })).length(1),
    }).parse(await get(`knowledgebases/${k.knowledgeBaseName}`));
    const expectedFilter = `current eq true and retrievable eq true and workspaceId eq '${k.workspaceId.replaceAll("'", "''")}'`;
    if (source.name !== k.knowledgeSourceName || source.searchIndexParameters.searchIndexName !== k.indexName ||
        source.searchIndexParameters.baseFilter !== expectedFilter || !source.searchIndexParameters.searchFields.some((field) => field.name === "content") ||
        kb.name !== k.knowledgeBaseName || kb.knowledgeSources[0].name !== k.knowledgeSourceName ||
        kb.models[0].azureOpenAIParameters.resourceUri.replace(/\/$/, "") !== k.modelEndpoint.replace(/\/$/, "") ||
        kb.models[0].azureOpenAIParameters.deploymentId !== k.planningDeployment ||
        kb.models[0].azureOpenAIParameters.modelName !== k.planningModelName)
      throw new Error("Exact source/KB/low-extractive binding mismatch");
  });
  const originals = async () => {
    const current = (await ports.credentials())[0];
    if (current.identity.tenantId !== k.tenantId || current.identity.objectId !== k.roster[0]) throw new Error("Original readback identity changed");
    const selected = "id,workspaceId,artifactId,contentKind,title,content,terms,evidenceLocator,sourceRevision,aclRevision,wikiRevision,current,retrievable,userIds";
    const response = await guarded(`${k.searchEndpoint.replace(/\/$/, "")}/indexes/${k.indexName}/docs/search?api-version=${searchApiVersion}`, {
      method: "POST", headers: { Authorization: serviceHeader(await ports.reader()),
        "x-ms-query-source-authorization": delegatedHeader(current), "Content-Type": "application/json" },
      body: JSON.stringify({ search: "*", filter: config.evidence.map((unit) => `id eq '${unit.indexKey.replaceAll("'", "''")}'`).join(" or "),
        select: selected,
        top: config.evidence.length }),
    });
    if (response.status !== 200) throw new Error("Original readback unavailable");
    const docs = z.object({ value: z.array(z.record(z.string(), z.unknown())) }).parse(await response.json()).value;
    if (docs.length !== lookup.size || new Set(docs.map((doc) => doc.id)).size !== docs.length) throw new Error("Original identity coverage unavailable");
    for (const unit of config.evidence) {
      const actual = docs.find((doc) => doc.id === unit.indexKey);
      const expected = indexDocument(unit, Array(k.embeddingDimensions).fill(0), k.embeddingDimensions);
      if (!actual || selected.split(",").some((key) => !(key in actual) ||
        JSON.stringify(actual[key]) !== JSON.stringify(expected[key as keyof typeof expected])))
        throw new Error("Original indexed content/locators differ");
    }
    return JSON.stringify(docs.sort((x, y) => String(x.id).localeCompare(String(y.id))));
  };
  let before: string | undefined;
  await check("originals-before", async () => { before = await originals(); });
  const iq = createIqClient(k, ports.reader, guarded);
  const raw = lookup.get(config.privateRawKey)!;
  const scope = { workspaceId: k.workspaceId, documentIds: [], folderIds: [], fileTypes: [] };
  let planning = false;
  const retrieve = async (user: DelegatedCredential, question: string, contentKind: "raw" | "wiki", documentIds: string[], required?: string) => {
    const { envelope } = await iq.retrieve({ question, user, scope: { ...scope, contentKind, documentIds }, signal });
    planning ||= envelope.activity.some((entry) => entry.type === "modelQueryPlanning");
    const units = normalizeRestEvidence(envelope, lookup, user, k.workspaceId, states);
    if (required && !units.some((item) => item.evidence.indexKey === required)) throw new Error("Expected original evidence unavailable");
    return units;
  };
  for (const [user, label] of [[a, "A"], [b, "B"]] as const) {
    await check(`rest-public-${label}`, async () => {
      const unit = lookup.get(config.publicKey)!;
      if (unit.contentKind !== "raw") throw new Error("Invalid public evidence");
      await retrieve(user, ports.questions.public, "raw", [unit.locator.documentId], unit.indexKey);
    });
    await check(label === "A" ? "rest-private-A" : "rest-denied-B", async () => {
      if (raw.contentKind !== "raw") throw new Error("Invalid private evidence");
      const units = await retrieve(user, ports.questions.private, "raw", [raw.locator.documentId], label === "A" ? raw.indexKey : undefined);
      if (label === "B" && units.length) throw new Error("Native denied query returned protected evidence");
    });
    await check(label === "A" ? "rest-wiki-A" : "rest-wiki-denied-B", async () => {
      await retrieve(user, ports.questions.private, "wiki", [], label === "A" ? config.privateWikiKey : undefined);
    });
  }
  await check("planning", async () => { if (!planning || !hybrid) throw new Error("Actual planning/hybrid activity unavailable"); });
  const mcp = async (question: string, token: string | undefined) => {
    const client = new Client({ name: "jevbox-native-spike", version: "1.0.0" });
    let denied = false;
    const observe: typeof fetch = async (url, options) => {
      const response = await guarded(url, options);
      denied ||= [401, 403].includes(response.status);
      return response;
    };
    const transport = new StreamableHTTPClientTransport(new URL(
      `${k.searchEndpoint.replace(/\/$/, "")}/knowledgebases/${k.knowledgeBaseName}/mcp?api-version=${searchApiVersion}`),
    { fetch: observe, requestInit: { headers: { Authorization: serviceHeader(await ports.reader()),
      ...(token ? { "x-ms-query-source-authorization": token } : {}) } } });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const tool = tools.find((item) => item.name === "knowledge_base_retrieve");
      const observed = z.object({ properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).optional() }).parse(tool?.inputSchema);
      const query = z.object({ type: z.string() }).safeParse(observed.properties.query);
      const unsupportedRequiredInputs = !!observed.required?.some((key) => key !== "query");
      toolSchemas.push({ name: "knowledge_base_retrieve", queryType: query.success ? query.data.type : null, unsupportedRequiredInputs });
      if (!query.success || query.data.type !== "string" || unsupportedRequiredInputs) throw new Error("Unsupported observed native tool schema");
      return { denied, output: await client.callTool({ name: "knowledge_base_retrieve", arguments: { query: question } }) };
    } catch (error) { if (denied) return { denied: true, output: null }; throw error; }
    finally { await client.close(); }
  };
  for (const [user, label] of [[a, "A"], [b, "B"]] as const) {
    for (const [question, required, name] of [
      [ports.questions.public, config.publicKey, `mcp-public-${label}`],
      [ports.questions.private, label === "A" ? config.privateRawKey : undefined, label === "A" ? "mcp-private-A" : "mcp-denied-B"],
    ] as const) await check(name, async () => {
      const result = await mcp(question, delegatedHeader(user));
      if (result.denied) throw new Error("Valid user denied");
      const units = normalizeMcpEvidence(result.output, lookup, user, k.workspaceId, states);
      if (required && !units.some((item) => item.evidence.indexKey === required)) throw new Error("Native MCP expected original unavailable");
    });
    await check(`agent-${label}`, async () => {
      const agent = createNativeAgentClient({ config: k, projectEndpoint: k.projectEndpoint, agentName: config.runtime.agentName,
        projectCredential: ports.project, fetcher: guarded, maxOutputTokens: 512 });
      const result = await agent.invoke(ports.questions.private, user, signal);
      const units = result.toolCalls.flatMap((call) => {
        if (call.error) throw new Error("Actual native tool failed");
        return normalizeMcpEvidence(typeof call.output === "string" ? JSON.parse(call.output) : call.output, lookup, user, k.workspaceId, states);
      });
      const answer = result.messages.flatMap((message) => z.array(z.object({ type: z.literal("output_text"), text: z.string() }))
        .parse(message.content).map((part) => part.text)).join("");
      const cited = normalizeNativeCitations(answer, units);
      if (label === "A" && !cited.evidence.some((unit) => unit.indexKey === config.privateRawKey || unit.indexKey === config.privateWikiKey))
        throw new Error("Configured agent did not cite actual private native evidence");
      if (label === "B" && answer !== "I don't know") throw new Error("Unsupported private agent answer did not abstain");
    });
  }
  await check("project-models", async () => {
    const models = createFoundryModels(k, ports.project, guarded, { maxOutputTokens: 512 });
    await models.embed(["Synthetic Cedar native verifier."], signal);
    const answer = await models.answer(ports.questions.public, [lookup.get(config.publicKey)!], async () => {}, signal);
    if (!answer.evidenceIds.includes(config.publicKey)) throw new Error("Project answer/citation probe unsupported");
  });
  const adverse = async (name: string, token?: string) => {
    await check(`rest-${name}`, async () => {
      const response = await guarded(`${k.searchEndpoint.replace(/\/$/, "")}/knowledgebases/${k.knowledgeBaseName}/retrieve?api-version=${searchApiVersion}`,
        { method: "POST", headers: { Authorization: serviceHeader(await ports.reader()), "Content-Type": "application/json",
          ...(token ? { "x-ms-query-source-authorization": token } : {}) },
        body: JSON.stringify(iqRetrieveRequest(k, ports.questions.private, scope)) });
      await response.body?.cancel();
      if (![401, 403].includes(response.status)) throw new Error("Native adverse credential did not explicitly deny");
    });
    await check(`mcp-${name}`, async () => {
      const result = await mcp(ports.questions.private, token);
      if (!result.denied || result.output !== null) throw new Error("Native MCP adverse credential did not explicitly deny");
    });
  };
  await adverse("missing");
  await adverse("invalid", "invalid-native-spike-credential");
  const foreign = await ports.wrongTenantCredential?.();
  if (foreign && config.wrongTenant && foreign.identity.tenantId === config.wrongTenant.tenantId &&
      foreign.identity.objectId === config.wrongTenant.expectedOid) await adverse("wrong-tenant", delegatedHeader(foreign));
  else for (const surface of ["rest", "mcp"]) observations.push({ check: `${surface}-wrong-tenant`, status: "unverified", code: "approved-adverse-session-unavailable" });
  if (config.waitForExpiredSource && a.expiresAt + 1000 < Date.parse(config.approval.expiresAt)) {
    await delay(Math.max(0, a.expiresAt + 1000 - Date.now()), undefined, { signal });
    await adverse("expired", originalToken);
  } else for (const surface of ["rest", "mcp"]) observations.push({ check: `${surface}-expired`, status: "unverified", code: "real-expiration-not-observed-within-approved-deadline" });
  await check("unchanged-originals", async () => {
    if (!before || before !== await originals()) throw new Error("Original evidence changed during verification");
  });
  return { ...spikeReport(config, observations, ports.execution, ports.execution === "live" ? liveExecutionReceipt : undefined),
    observedRequests: requests, toolSchemas };
}

export async function fixedSpikeQuestions(config: SpikeConfig) {
  const pack = z.object({
    datasetId: z.literal("cedar-synthetic-v2"),
    documents: z.array(z.object({ fileName: z.string(), lines: z.array(z.string()).optional() })),
    questions: z.array(z.object({ id: z.string(), question: z.string() })),
  }).parse(JSON.parse(await readFile(new URL("../../tests/fixtures/customer-evaluation.json", import.meta.url), "utf8")));
  const publicUnit = config.evidence.find((unit) => unit.indexKey === config.publicKey)!;
  const privateUnit = config.evidence.find((unit) => unit.indexKey === config.privateRawKey)!;
  if (publicUnit.contentKind !== "raw" || privateUnit.contentKind !== "raw" ||
      publicUnit.locator.page !== null || privateUnit.locator.page !== null ||
      !publicUnit.locator.sectionPath.includes("Preview scope") || !privateUnit.locator.sectionPath.includes("Pilot offer") ||
      !publicUnit.text.includes("The Cedar limited preview starts on 16 November 2026 and is capped at 200 projects.") ||
      !privateUnit.text.includes("The fictional customer Orion Lantern has a proposed pilot fee of USD 12,000."))
    throw new Error("Fixed synthetic original/section binding unavailable");
  const publicQuestion = pack.questions.find((question) => question.id === "preview-scope");
  const privateQuestion = pack.questions.find((question) => question.id === "restricted-authorized");
  if (!publicQuestion || !privateQuestion) throw new Error("Fixed approved questions unavailable");
  return { public: publicQuestion.question, private: privateQuestion.question };
}
