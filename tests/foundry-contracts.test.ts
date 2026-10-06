import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import {
  evidenceSchema, intersectReaders, assertEvidenceAccess, type Evidence,
} from "../shared/evidence";
import { DelegatedCredential } from "../server/foundry/credentials";
import {
  createIqClient, normalizeMcpEvidence, normalizeRestEvidence, scopeFilter,
} from "../server/foundry/iq-client";
import { indexDocument, verifyIndexResults } from "../server/foundry/search-index";
import { buildNativeArtifacts } from "../server/foundry/setup-artifacts";
import { assertLegacyProfile } from "../server/foundry/config";
import { expandRawDependencies, validateWikiPublication, editWikiClaim, type WikiRevision } from "../server/wiki/provenance";
import { createFoundryModels } from "../server/foundry/model-client";
import {
  evaluation, fixtureEvidence, fixtureSources, fixtureWorkspace,
  testOids, testTenantId, testConfig, readerIds,
} from "./foundry-fixtures";

const identity = (reader: "A" | "B") => ({ tenantId: testTenantId, objectId: testOids[reader] });
const keys = await generateKeyPair("RS256");
async function credential(reader: "A" | "B" = "A", overrides: Record<string, unknown> = {}) {
  const token = await new SignJWT({ tid: testTenantId, oid: testOids[reader], scp: "user_impersonation", ...overrides })
    .setProtectedHeader({ alg: "RS256" }).setIssuedAt()
    .setIssuer(`https://login.microsoftonline.com/${testTenantId}/v2.0`)
    .setAudience("https://search.azure.com").setExpirationTime(typeof overrides.exp === "number" ? overrides.exp : "5m").sign(keys.privateKey);
  return DelegatedCredential.verify({
    token, tenantId: testTenantId, roster: Object.values(testOids),
    audience: "https://search.azure.com",
    issuer: `https://login.microsoftonline.com/${testTenantId}/v2.0`,
    delegatedScope: "user_impersonation", sessionIdentity: identity(reader),
    key: async () => keys.publicKey,
  });
}
const raw = fixtureEvidence.find((unit) => unit.contentKind === "raw" && unit.locator.sectionPath.includes("Preview scope"))!;
const original = (unit: Evidence) => {
  if (unit.contentKind !== "raw") throw new Error("Expected raw fixture");
  return { evidenceId: unit.indexKey, locator: unit.locator };
};

test("synthetic pack binds claims to actual parsed passages without invented pages", () => {
  assert.equal(evaluation.liveVerificationStatus, "not-run");
  assert.equal(evaluation.cloudUploadsApproved, false);
  for (const unit of fixtureEvidence) {
    assert.equal(unit.contentKind, "raw");
    if (unit.contentKind !== "raw") continue;
    assert.equal(unit.locator.page, null);
    assert.equal(unit.locator.endPage, null);
    assert.ok(unit.locator.blocks.every((block) => block.geometry === null && block.page === null));
  }
  for (const scenario of evaluation.wikiScenarios) {
    for (const claim of scenario.claims) {
      const match = fixtureEvidence.find((unit) => unit.contentKind === "raw" &&
        unit.artifactId === claim.sourceId && unit.locator.sectionPath.includes(claim.section) &&
        unit.text.includes(claim.supportingQuote));
      assert.ok(match, `Actual passage for ${scenario.id}/${claim.section}`);
    }
    assert.deepEqual(
      intersectReaders(Object.values(testOids), readerIds(scenario.ownReaders),
        ...scenario.rawDependencyIds.map((id) => fixtureSources.get(id)!.readers)),
      readerIds(scenario.expectedEffectiveReaders),
    );
  }
});

test("native evidence rejects broad ACL values and invalid geometry", () => {
  assert.equal(evidenceSchema.safeParse({ ...raw, userIds: ["all"] }).success, false);
  assert.equal(evidenceSchema.safeParse({ ...raw, userIds: ["a@example.test"] }).success, false);
  assert.equal(evidenceSchema.safeParse({ ...raw, sourceRevision: 2 }).success, false);
  if (raw.contentKind !== "raw") return;
  assert.equal(evidenceSchema.safeParse({ ...raw, locator: {
    ...raw.locator, blocks: [{ id: "block", page: null, geometry: {
      pageWidth: 100, pageHeight: 100, left: 0, top: 0, right: 110, bottom: 20,
    } }],
  } }).success, false);
});

test("pending, revoked, stale and wrong-workspace evidence all fail closed", () => {
  assertEvidenceAccess(raw, identity("B"), fixtureWorkspace, fixtureSources);
  for (const change of [
    { state: "pending" as const }, { state: "failed" as const }, { state: "deleted" as const },
    { readers: [testOids.A] }, { sourceRevision: 2 }, { aclRevision: 2 },
  ]) {
    const sources = new Map(fixtureSources);
    sources.set(raw.artifactId, { ...sources.get(raw.artifactId)!, ...change });
    assert.throws(() => assertEvidenceAccess(raw, identity("B"), fixtureWorkspace, sources));
  }
  assert.throws(() => assertEvidenceAccess(raw, identity("A"), "other-workspace", fixtureSources));
  assert.throws(() => assertEvidenceAccess(raw, { ...identity("A"), tenantId: testOids.B }, fixtureWorkspace, fixtureSources));
});

test("delegated credentials are signature/session/scope bound and never serialized", async () => {
  const user = await credential();
  assert.throws(() => JSON.stringify(user), /never be serialized/);
  await assert.rejects(() => credential("A", { oid: testOids.B }), /does not match/);
  await assert.rejects(() => credential("A", { tid: testOids.B }), /does not match/);
  await assert.rejects(() => credential("A", { scp: "" }), /does not match/);
  await assert.rejects(() => credential("A", { exp: 1 }), /verification failed/);
});

test("REST client supplies two different identities with low/extractive and no fallback", async () => {
  let calls = 0;
  const user = await credential();
  const envelope = {
    response: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify([
      { ref_id: "0", content: raw.text, title: raw.title },
    ]) }] }],
    references: [{ type: "searchIndex", id: "0", activitySource: 1, docKey: raw.indexKey }],
    activity: [{ type: "modelQueryPlanning", id: 0, elapsedMs: 20, inputTokens: 30, outputTokens: 4 }],
  };
  const client = createIqClient(testConfig, async () => ({ token: "synthetic-service-reader", expiresAt: Date.now() + 300000 }),
    async (url, init) => {
      calls++;
      assert.match(String(url), /2026-08-01-preview/);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer synthetic-service-reader");
      assert.ok(headers.get("x-ms-query-source-authorization"));
      assert.equal(headers.get("x-ms-enable-elevated-read"), null);
      assert.equal(headers.get("api-key"), null);
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.retrievalReasoningEffort, { kind: "low" });
      assert.equal(body.outputMode, "extractiveData");
      assert.match(body.knowledgeSourceParams[0].filterAddOn, /workspaceId/);
      return Response.json(envelope);
    });
  const result = await client.retrieve({ question: "When is preview?", user,
    scope: { workspaceId: fixtureWorkspace, documentIds: [], folderIds: [], fileTypes: [] },
    signal: new AbortController().signal });
  assert.equal(calls, 1);
  const lookup = new Map(fixtureEvidence.map((unit) => [unit.indexKey, unit]));
  assert.equal(normalizeRestEvidence(result.envelope, lookup, user, fixtureWorkspace, fixtureSources)[0].evidence.indexKey, raw.indexKey);
  assert.throws(() => normalizeRestEvidence({ ...result.envelope,
    references: [{ ...result.envelope.references[0], docKey: "unknown" }],
  }, lookup, user, fixtureWorkspace, fixtureSources), /authoritative evidence/);
});

test("native MCP accepts only returned locators, not title matches or invented REST arrays", async () => {
  const user = await credential();
  const lookup = new Map(fixtureEvidence.map((unit) => [unit.indexKey, unit]));
  const chunk = { ref_id: "0", content: raw.text, title: raw.title, terms: JSON.stringify({ schemaVersion: 1, indexKey: raw.indexKey }) };
  const result = { content: [{ type: "text", text: JSON.stringify([chunk]) }] };
  assert.equal(normalizeMcpEvidence(result, lookup, user, fixtureWorkspace, fixtureSources).length, 1);
  assert.throws(() => normalizeMcpEvidence({ content: [{ type: "text", text: JSON.stringify([
    { ref_id: "0", title: raw.title, content: raw.text },
  ]) }] }, lookup, user, fixtureWorkspace, fixtureSources), /title-only/);
  assert.throws(() => normalizeMcpEvidence({ ...result, isError: true }, lookup, user, fixtureWorkspace, fixtureSources), /failed/);
});

test("trusted filter builder escapes strings and scopes all transitive raw dependencies", () => {
  const filter = scopeFilter({ workspaceId: "w' or true", documentIds: ["doc'1"],
    folderIds: ["f"], fileTypes: [], contentKind: "raw" });
  assert.match(filter, /w'' or true/);
  assert.match(filter, /rawSourceRefs\/all/);
  assert.match(filter, /rawSourceRefs\/any\(\)/);
  assert.match(filter, /doc''1/);
});

test("indexing requires exact dimensions and every per-item outcome", () => {
  assert.deepEqual(indexDocument(raw, [1, 2, 3], 3).userIds, raw.userIds);
  assert.throws(() => indexDocument(raw, [1, 2], 3));
  assert.throws(() => verifyIndexResults({ value: [{ key: "a", status: false, statusCode: 503 }] }, ["a"]), /remains pending/);
  assert.throws(() => verifyIndexResults({ value: [{ key: "a", status: true, statusCode: 200 }] }, ["a", "b"]), /exact submitted/);
});

test("native artifacts are one direct-user hybrid source, no duplicate synthesis or keys", () => {
  const artifacts = buildNativeArtifacts({ ...testConfig,
    planningDeployment: "unselected-planning", planningModelName: "unselected-model",
    embeddingModelName: "unselected-embedding", agentName: "synthetic-agent", connectionName: "synthetic-connection",
  });
  assert.equal(artifacts.index.permissionFilterOption, "enabled");
  assert.equal(artifacts.knowledgeBase.knowledgeSources.length, 1);
  assert.equal(artifacts.knowledgeBase.outputMode, "extractiveData");
  assert.equal(artifacts.agent.definition.structured_inputs.search_auth_token.required, true);
  assert.deepEqual(artifacts.agent.definition.tools[0].allowed_tools, ["knowledge_base_retrieve"]);
  assert.equal(artifacts.connection.properties.authType, "ProjectManagedIdentity");
  assert.equal(JSON.stringify(artifacts).includes("apiKey"), false);
  assert.throws(() => assertLegacyProfile({ JEVBOX_PROFILE: "foundry-iq" }), /activation is blocked/);
});

test("wiki graph rejects cycles and unresolved raw evidence; edits clear review", () => {
  const nodes = new Map([
    ["a", { kind: "wiki" as const, dependencies: ["b"] }],
    ["b", { kind: "wiki" as const, dependencies: ["a"] }],
  ]);
  assert.throws(() => expandRawDependencies(["a"], nodes), /cycle/);
  assert.throws(() => expandRawDependencies(["missing"], nodes), /Unresolved/);
  const draft: WikiRevision = {
    pageId: "page", workspaceId: fixtureWorkspace, revision: 1, title: "Preview",
    kind: "topic", state: "reviewed", authorOid: testOids.A, reviewerOid: testOids.A,
    claims: [{ id: "claim", text: "Preview is capped at 200 projects.", evidence: [original(raw)] }],
    relatedPageIds: [],
  };
  const edited = editWikiClaim(draft, "claim", "A changed claim", [original(raw)]);
  assert.equal(edited.state, "draft");
  assert.equal(edited.reviewerOid, null);
  assert.throws(() => editWikiClaim(draft, "claim", "An unsupported claim", []));
  const published = validateWikiPublication({
    draft, identity: identity("A"), roster: Object.values(testOids),
    locationReaders: Object.values(testOids), sources: fixtureSources,
    evidence: new Map([[raw.indexKey, original(raw)]]),
  });
  assert.equal(published.state, "published");
  assert.throws(() => validateWikiPublication({
    draft: edited, identity: identity("A"), roster: Object.values(testOids),
    locationReaders: Object.values(testOids), sources: fixtureSources,
    evidence: new Map([[raw.indexKey, original(raw)]]),
  }), /Human review/);
});

test("Foundry answers abstain on empty evidence and recheck before delivery", async () => {
  let calls = 0;
  const model = createFoundryModels(testConfig, async () => ({ token: "synthetic", expiresAt: Date.now() + 300000 }),
    async () => {
      calls++;
      return Response.json({ choices: [{ finish_reason: "stop", message: {
        content: JSON.stringify({ answer: `200 projects [${raw.indexKey}]`, evidenceIds: [raw.indexKey] }),
      } }] });
    });
  let rechecks = 0;
  const recheck = async () => { rechecks++; };
  assert.equal((await model.answer("q", [], recheck, new AbortController().signal)).answer, "I don't know");
  assert.equal(calls, 0);
  await model.answer("q", [raw], recheck, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(rechecks, 3);
  await assert.rejects(() => model.answer("q", [raw], async () => {
    if (++rechecks > 4) throw new Error("access changed");
  }, new AbortController().signal), /access changed/);
});
