import { z } from "zod";
import { HttpError } from "../errors";
import {
  evidenceSchema, assertEvidenceAccess,
  type Evidence, type SourceState,
} from "../../shared/evidence";
import { foundryConfigSchema, searchApiVersion, type FoundryConfig } from "./config";
import { delegatedHeader, serviceHeader, type DelegatedCredential, type ServiceCredential } from "./credentials";
import { searchFiltersSchema, searchDateBounds, matchesSearchFilters } from "../../shared/search-filters";

const text = z.object({ type: z.literal("text"), text: z.string().max(2_000_000) });
const chunkSchema = z.object({
  ref_id: z.string().min(1),
  content: z.string().min(1),
  title: z.string().optional(),
  terms: z.string().optional(),
});
const referenceSchema = z.object({
  type: z.literal("searchIndex"),
  id: z.string(),
  activitySource: z.number().int().nonnegative(),
  docKey: z.string().min(1),
  sourceData: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const nativeActivitySchema = z.object({
  id: z.number().int().nonnegative(),
  type: z.string().min(1).max(100),
  elapsedMs: z.number().nonnegative().finite().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type NativeActivity = z.infer<typeof nativeActivitySchema>;
export const iqResponseSchema = z.object({
  response: z.array(z.object({ role: z.string(), content: z.array(text) })),
  references: z.array(referenceSchema),
  activity: z.array(nativeActivitySchema),
});
export type IqResponse = z.infer<typeof iqResponseSchema>;
export const retrievalScopeSchema = z.strictObject({
  workspaceId: z.string().min(1).max(200),
  documentIds: z.array(z.string().min(1).max(200)).max(8).default([]),
  folderIds: z.array(z.string().min(1).max(200)).max(8).default([]),
  fileTypes: searchFiltersSchema.shape.fileTypes.default([]),
  contentKind: z.enum(["raw", "wiki"]).optional(),
  createdAfter: searchFiltersSchema.shape.createdAfter,
  createdBefore: searchFiltersSchema.shape.createdBefore,
}).refine((scope) => searchFiltersSchema.safeParse({
  createdAfter: scope.createdAfter, createdBefore: scope.createdBefore,
}).success, "Invalid upload date range");
export type RetrievalScope = z.infer<typeof retrievalScopeSchema>;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export function scopeFilter(input: RetrievalScope) {
  const scope = retrievalScopeSchema.parse(input);
  const conditions = [`workspaceId eq ${quote(scope.workspaceId)}`];
  const rawConditions: string[] = [];
  if (scope.documentIds.length)
    rawConditions.push(`(${scope.documentIds.map((id) => `r/documentId eq ${quote(id)}`).join(" or ")})`);
  const dates = searchDateBounds({ createdAfter: scope.createdAfter, createdBefore: scope.createdBefore });
  if (dates.after) rawConditions.push(`r/uploadedAt ge ${dates.after}`);
  if (dates.before) rawConditions.push(`r/uploadedAt le ${dates.before}`);
  if (scope.folderIds.length)
    rawConditions.push(`r/folderIds/any(f: ${scope.folderIds.map((id) => `f eq ${quote(id)}`).join(" or ")})`);
  if (scope.fileTypes.length)
    rawConditions.push(`r/fileTypes/any(t: ${scope.fileTypes.map((type) => `t eq ${quote(type)}`).join(" or ")})`);
  if (rawConditions.length) {
    conditions.push("rawSourceRefs/any()");
    conditions.push(`rawSourceRefs/all(r: ${rawConditions.join(" and ")})`);
  }
  if (scope.contentKind) conditions.push(`contentKind eq ${quote(scope.contentKind)}`);
  return conditions.join(" and ");
}
export function assertEvidenceScope(input: RetrievalScope, unit: Evidence, originals: ReadonlyMap<string, Evidence>) {
  const scope = retrievalScopeSchema.parse(input);
  const raw = unit.contentKind === "raw" ? [unit] : unit.dependencies.map((dependency) => originals.get(dependency.evidenceId));
  if ((scope.contentKind && scope.contentKind !== unit.contentKind) || !raw.length || raw.some((source) => {
    if (!source || source.contentKind !== "raw") return true;
    const metadata = source.sourceDates?.find((date) => date.documentId === source.locator.documentId);
    return (scope.documentIds.length && !scope.documentIds.includes(source.locator.documentId)) ||
      (scope.folderIds.length && !scope.folderIds.some((id) => source.folderIds.includes(id))) ||
      !matchesSearchFilters({ created: metadata?.uploadedAt ?? "", mime: source.fileType, access: "restricted" }, {
        createdAfter: scope.createdAfter, createdBefore: scope.createdBefore, fileTypes: scope.fileTypes,
      });
  })) throw new HttpError(502, "Native evidence violates the authoritative all-source query scope");
}

export function createIqClient(
  input: FoundryConfig,
  serviceCredential: () => Promise<ServiceCredential>,
  fetcher: typeof fetch = fetch,
) {
  const config = foundryConfigSchema.parse(input);
  return {
    async retrieve(input: {
      question: string;
      user: DelegatedCredential;
      scope: RetrievalScope;
      signal: AbortSignal;
    }) {
      const userToken = delegatedHeader(input.user);
      if (input.user.identity.tenantId !== config.tenantId ||
          !config.roster.includes(input.user.identity.objectId) ||
          input.scope.workspaceId !== config.workspaceId)
        throw new HttpError(403, "Retrieval is outside the approved user/workspace boundary");
      const question = z.string().trim().min(1).max(4000).parse(input.question);
      const authorization = serviceHeader(await serviceCredential());
      input.signal.throwIfAborted();
      const started = performance.now();
      const response = await fetcher(
        `${config.searchEndpoint.replace(/\/$/, "")}/knowledgebases/${config.knowledgeBaseName}/retrieve?api-version=${searchApiVersion}`,
        {
          method: "POST", redirect: "error",
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(60000)]),
          headers: {
            Authorization: authorization,
            "x-ms-query-source-authorization": userToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: [{ type: "text", text: question }] }],
            outputMode: "extractiveData",
            retrievalReasoningEffort: { kind: "low" },
            includeActivity: true,
            knowledgeSourceParams: [{
              kind: "searchIndex",
              knowledgeSourceName: config.knowledgeSourceName,
              includeReferences: true, includeReferenceSourceData: true,
              filterAddOn: scopeFilter(input.scope),
            }],
          }),
        },
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new HttpError(response.status === 401 || response.status === 403 ? 401 : 502,
          `Native IQ retrieval failed (${response.status}); no fallback was attempted`);
      }
      const parsed = iqResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new HttpError(502, "Native IQ returned an invalid contract");
      if (parsed.data.activity.some((activity) => activity.type === "modelAnswerSynthesis"))
        throw new HttpError(502, "IQ answer synthesis violates the extractive-only contract");
      return { envelope: parsed.data, durationMs: performance.now() - started };
    },
  };
}

export function normalizeRestEvidence(
  envelope: IqResponse,
  lookup: ReadonlyMap<string, Evidence>,
  user: DelegatedCredential,
  workspaceId: string,
  states: ReadonlyMap<string, SourceState>,
) {
  iqResponseSchema.parse(envelope);
  const references = new Map(envelope.references.map((reference) => [reference.id, reference]));
  if (references.size !== envelope.references.length) throw new Error("Duplicate native reference identity");
  return envelope.response.flatMap((message) => message.content.flatMap((content) => {
    const chunks = z.array(chunkSchema).max(200).parse(JSON.parse(content.text));
    return chunks.map((chunk) => {
      const reference = references.get(chunk.ref_id);
      const evidence = reference && lookup.get(reference.docKey);
      if (!reference || !evidence) throw new Error("Native reference has no authoritative evidence identity");
      evidenceSchema.parse(evidence);
      assertEvidenceAccess(evidence, user.identity, workspaceId, states);
      if (!evidence.text.includes(chunk.content))
        throw new Error("Native extract is not part of the original indexed passage");
      return { referenceId: reference.id, evidence, excerpt: chunk.content };
    });
  }));
}

export function normalizeMcpEvidence(
  input: unknown,
  lookup: ReadonlyMap<string, Evidence>,
  user: DelegatedCredential,
  workspaceId: string,
  states: ReadonlyMap<string, SourceState>,
) {
  const result = z.object({ content: z.array(text), isError: z.boolean().optional() }).parse(input);
  if (result.isError) throw new Error("Native MCP retrieval failed");
  return result.content.flatMap((content) =>
    z.array(chunkSchema).max(200).parse(JSON.parse(content.text)).map((chunk) => {
      if (!chunk.terms) throw new Error("Native MCP source locator unavailable; title-only citations are forbidden");
      const locator = z.object({ schemaVersion: z.literal(1), indexKey: z.string() }).parse(JSON.parse(chunk.terms));
      const evidence = lookup.get(locator.indexKey);
      if (!evidence) throw new Error("Unknown native MCP source locator");
      assertEvidenceAccess(evidence, user.identity, workspaceId, states);
      if (!evidence.text.includes(chunk.content)) throw new Error("MCP extract is not original indexed evidence");
      return { referenceId: chunk.ref_id, evidence, excerpt: chunk.content };
    }),
  );
}

export function normalizeNativeCitations(
  answer: string, retrieved: { referenceId: string; evidence: Evidence }[],
) {
  const mapping = new Map<string, Set<string>>();
  for (const { referenceId, evidence } of retrieved) {
    for (const marker of [referenceId, evidence.indexKey])
      mapping.set(marker, new Set([...(mapping.get(marker) ?? []), evidence.indexKey]));
  }
  const cited = new Set<string>();
  const normalized = answer.replace(/\[([A-Za-z0-9_-]+)\]/g, (_marker, id: string) => {
    const keys = mapping.get(id);
    if (!keys || keys.size !== 1)
      throw new HttpError(502, "Native citation identity is missing or ambiguous across tool calls");
    const key = [...keys][0];
    cited.add(key);
    return `[${key}]`;
  });
  if (answer !== "I don't know" && !cited.size)
    throw new HttpError(502, "Native agent citations cannot be validated against its actual tool payload");
  return { answer: normalized, evidence: [...new Map(retrieved.filter((item) => cited.has(item.evidence.indexKey))
    .map((item) => [item.evidence.indexKey, item.evidence])).values()] };
}
