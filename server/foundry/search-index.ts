import { z } from "zod";
import { evidenceSchema, type Evidence } from "../../shared/evidence";
import { foundryConfigSchema, searchApiVersion, type FoundryConfig } from "./config";
import { serviceHeader, type ServiceCredential } from "./credentials";
import { HttpError } from "../errors";
import { matchesSearchFilters, searchFiltersSchema } from "../../shared/search-filters";

export function indexDocument(input: Evidence, vector: number[], dimensions: number) {
  const evidence = evidenceSchema.parse(input);
  z.array(z.number().finite()).length(dimensions).parse(vector);
  const rawDocumentIds = evidence.contentKind === "raw"
    ? [evidence.locator.documentId]
    : [...new Set(evidence.dependencies.map((dependency) => dependency.locator.documentId))];
  return {
    id: evidence.indexKey,
    workspaceId: evidence.workspaceId,
    artifactId: evidence.artifactId,
    contentKind: evidence.contentKind,
    title: evidence.title,
    content: evidence.text,
    // Native MCP returns semantic fields, not the REST references envelope.
    terms: JSON.stringify({ schemaVersion: 1, indexKey: evidence.indexKey }),
    evidenceLocator: JSON.stringify(evidence.contentKind === "raw"
      ? evidence.locator : { supportingEvidence: evidence.supportingEvidence, dependencies: evidence.dependencies }),
    sourceRevision: evidence.sourceRevision,
    aclRevision: evidence.aclRevision,
    wikiRevision: evidence.contentKind === "wiki" ? evidence.wikiRevision : null,
    current: evidence.current,
    retrievable: evidence.retrievable,
    folderIds: evidence.folderIds,
    rawDocumentIds,
    rawSourceRefs: rawDocumentIds.map((documentId) => {
      const metadata = evidence.sourceDates?.find((date) => date.documentId === documentId);
      const mime = metadata?.fileType ?? (evidence.contentKind === "raw" ? evidence.fileType : "");
      const categories = searchFiltersSchema.shape.fileTypes.unwrap().element.options.filter((type) =>
        matchesSearchFilters({ mime, created: "", access: "restricted" }, { fileTypes: [type] }));
      return {
        documentId, uploadedAt: metadata?.uploadedAt ?? null,
        folderIds: metadata?.folderIds ?? (evidence.contentKind === "raw" ? evidence.folderIds : []),
        fileTypes: categories,
      };
    }),
    fileType: evidence.fileType,
    userIds: evidence.userIds,
    contentVector: vector,
  };
}
export const indexResultsSchema = z.object({
  value: z.array(z.object({
    key: z.string(),
    status: z.boolean(),
    statusCode: z.number().int(),
    errorMessage: z.string().nullable().optional(),
  })),
});
export function verifyIndexResults(payload: unknown, expectedKeys: string[]) {
  const { value } = indexResultsSchema.parse(payload);
  const unique = new Set(value.map((item) => item.key));
  if (unique.size !== value.length || expectedKeys.length !== value.length ||
      expectedKeys.some((key) => !unique.has(key)))
    throw new Error("Indexing results do not cover the exact submitted items");
  const failures = value.filter((item) => !item.status || item.statusCode < 200 || item.statusCode >= 300);
  if (failures.length) throw new HttpError(502, `Native indexing failed for ${failures.length} item(s); synchronization remains pending`);
  return value;
}
export function createSearchWriter(
  input: FoundryConfig,
  ingestionCredential: () => Promise<ServiceCredential>,
  fetcher: typeof fetch = fetch,
) {
  const config = foundryConfigSchema.parse(input);
  const submit = async (items: ({ action: "upload"; evidence: Evidence; vector: number[] } |
      { action: "delete"; indexKey: string })[], signal: AbortSignal) => {
      if (!items.length || items.length > 500) throw new Error("Submit between 1 and 500 indexing items");
      const value = items.map((item) => item.action === "delete"
        ? { "@search.action": "delete", id: item.indexKey }
        : { "@search.action": "upload", ...indexDocument(item.evidence, item.vector, config.embeddingDimensions) });
      if (new Set(value.map((item) => item.id)).size !== value.length)
        throw new Error("Duplicate index key in a publication batch");
      const response = await fetcher(
        `${config.searchEndpoint.replace(/\/$/, "")}/indexes/${config.indexName}/docs/index?api-version=${searchApiVersion}`,
        {
          method: "POST", redirect: "error", signal,
          headers: { Authorization: serviceHeader(await ingestionCredential()), "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(502, `Native indexing request failed (${response.status})`);
      }
      return indexResultsSchema.parse(await response.json());
    };
  return {
    submit,
    async write(items: Parameters<typeof submit>[0], signal: AbortSignal) {
      const response = await submit(items, signal);
      return verifyIndexResults(response, items.map((item) => item.action === "delete" ? item.indexKey : item.evidence.indexKey));
    },
  };
}
