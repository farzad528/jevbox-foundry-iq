import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runtimeConfigSchema, nativeBinding, activationBlockers } from "../server/foundry/runtime-config";
import { testConfig } from "./foundry-fixtures";

test("OFFLINE native proof binds API, full Search/model configuration, exact agent and all client identities", () => {
  const input = { knowledge: testConfig, databaseSchema: "fiq_proof", workspaceName: "Offline",
    agentName: "offline-agent", entraClientId: randomUUID(), readerClientId: randomUUID(),
    writerClientId: randomUUID(), projectClientId: randomUUID(),
    approvals: { entraConsent: true, cloudCalls: true, syntheticUploads: true, vendorProcessing: false } };
  const proof = { binding: nativeBinding(input), verifiedAt: new Date().toISOString(),
    tenantId: testConfig.tenantId, roster: testConfig.roster, knowledgeBaseName: testConfig.knowledgeBaseName,
    projectEndpoint: testConfig.projectEndpoint, checks: { restTwoUserAcl: true, restAdverseTokens: true,
      mcpTwoUserAcl: true, mcpAdverseTokens: true, mcpOriginalLocators: true,
      hybridLowExtractive: true, projectModelDeployments: true } };
  const config = runtimeConfigSchema.parse({ ...input, nativeProof: proof });
  assert.deepEqual(activationBlockers(config), []);
  for (const change of [
    { knowledge: { ...testConfig, searchEndpoint: "https://changed.search.windows.net" } },
    { knowledge: { ...testConfig, indexName: "changed-index" } },
    { knowledge: { ...testConfig, knowledgeSourceName: "changed-source" } },
    { knowledge: { ...testConfig, answerDeployment: "changed-answer" } },
    { knowledge: { ...testConfig, planningDeployment: "changed-planning" } },
    { knowledge: { ...testConfig, planningModelName: "changed-planning-model" } },
    { knowledge: { ...testConfig, embeddingDeployment: "changed-embedding" } },
    { knowledge: { ...testConfig, embeddingModelName: "changed-embedding-model" } },
    { knowledge: { ...testConfig, embeddingDimensions: 9 } },
    { agentName: "changed-agent" }, { entraClientId: randomUUID() }, { readerClientId: randomUUID() },
    { writerClientId: randomUUID() }, { projectClientId: randomUUID() },
  ]) assert.equal(runtimeConfigSchema.safeParse({ ...config, ...change }).success, false);
  assert.equal(runtimeConfigSchema.safeParse({ ...config, nativeProof: { ...proof,
    binding: { ...proof.binding, apiVersion: "2026-04-01" } } }).success, false);
  assert(activationBlockers(runtimeConfigSchema.parse({ ...input, nativeProof: null })).length > 0);
});
