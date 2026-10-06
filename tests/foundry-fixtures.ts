import evaluation from "./fixtures/customer-evaluation.json";
import { buildIndex } from "../server/indexing";
import { rawEvidenceFromParsed } from "../server/foundry/evidence-mapping";
import type { SourceState } from "../shared/evidence";

// Offline UUID fixtures are not real, authenticated Entra users.
export const testOids = {
  A: "11111111-1111-4111-8111-111111111111",
  B: "22222222-2222-4222-8222-222222222222",
};
export const testTenantId = "33333333-3333-4333-8333-333333333333";
export const fixtureWorkspace = "synthetic-workspace";
export const testConfig = {
  tenantId: testTenantId,
  roster: [testOids.A, testOids.B],
  workspaceId: fixtureWorkspace,
  searchEndpoint: "https://synthetic-unit-test.search.windows.net",
  indexName: "synthetic-evidence",
  knowledgeSourceName: "synthetic-source",
  knowledgeBaseName: "synthetic-kb",
  modelEndpoint: "https://synthetic-unit-test.openai.azure.com",
  projectEndpoint: "https://synthetic-unit-test.services.ai.azure.com/api/projects/synthetic",
  answerDeployment: "unselected-chat",
  embeddingDeployment: "unselected-embedding",
  embeddingDimensions: 3,
};
export const readerIds = (labels: string[]) => labels.map((label) => {
  if (label !== "A" && label !== "B") throw new Error("Unknown synthetic reader label");
  return testOids[label];
});
export const fixtureEvidence = evaluation.documents.flatMap((document) => document.lines ? rawEvidenceFromParsed({
  documentId: document.id,
  workspaceId: fixtureWorkspace,
  title: document.title,
  fileType: "text/markdown",
  folderIds: [document.suggestedFolder],
  sourceRevision: document.sourceRevision,
  aclRevision: 1,
  userIds: readerIds(document.readers),
  parsed: buildIndex([{ content: document.lines.join("\n") }], "text"),
}) : []);
export const fixtureSources = new Map<string, SourceState>(evaluation.documents.map((document) => [
  document.id, {
    documentId: document.id, workspaceId: fixtureWorkspace, tenantId: testTenantId,
    sourceRevision: document.sourceRevision, aclRevision: 1,
    state: document.lines ? "verified" : "pending", readers: readerIds(document.readers),
  },
]));
export { evaluation };
