import { z } from "zod";

export const personalApiVersion = "2026-08-01-preview";
const guid = z.string().uuid().transform((value) => value.toLowerCase());
const name = z.string().regex(/^[a-z][a-z0-9-]{1,100}[a-z0-9]$/);
const endpoint = (suffix: string) => z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname.endsWith(suffix) &&
    !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === "/";
}).transform((value) => value.replace(/\/$/, ""));
const model = z.strictObject({
  endpoint: z.union([endpoint(".openai.azure.com"), endpoint(".services.ai.azure.com")]),
  deployment: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  model: z.string().min(1).max(100), version: z.string().min(1).max(100),
});
export const personalConfigSchema = z.strictObject({
  tenantId: guid, subscriptionId: guid, ownerOid: guid,
  searchEndpoint: endpoint(".search.windows.net"),
  searchResourceId: z.string().regex(/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft.Search\/searchServices\/[^/]+$/i),
  projectResourceId: z.string().regex(/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft.CognitiveServices\/accounts\/[^/]+\/projects\/[^/]+$/i),
  projectEndpoint: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".services.ai.azure.com") &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^\/api\/projects\/[a-zA-Z0-9._-]+$/.test(url.pathname);
  }),
  cuEndpoint: endpoint(".services.ai.azure.com"),
  sourceName: name, kbName: name,
  cmkBaselineSource: name.nullable().default(null),
  embedding: model.extend({ model: z.literal("text-embedding-3-small"), dimensions: z.number().int().min(1).max(1536) }),
  chat: model.extend({ model: z.literal("gpt-5.4-mini") }),
  inheritedEncryption: z.strictObject({
    isServiceLevelKey: z.literal(true), keyVaultUri: z.string().url(),
    keyVaultKeyName: z.string().min(1), keyVaultKeyVersion: z.string().min(1),
    accessCredentials: z.null().optional(), identity: z.null().optional(),
  }).nullable(),
}).superRefine((value, context) => {
  for (const field of ["searchResourceId", "projectResourceId"] as const)
    if (value[field].split("/")[2]?.toLowerCase() !== value.subscriptionId)
      context.addIssue({ code: "custom", path: [field], message: "Resource must belong to the selected subscription" });
  if (new URL(value.searchEndpoint).hostname.split(".")[0] !== value.searchResourceId.split("/").at(-1)?.toLowerCase())
    context.addIssue({ code: "custom", path: ["searchEndpoint"], message: "Search resource and endpoint disagree" });
  const account = value.projectResourceId.split("/").at(-3)?.toLowerCase();
  if (value.inheritedEncryption && !value.cmkBaselineSource)
    context.addIssue({ code: "custom", path: ["cmkBaselineSource"], message: "Pin inherited encryption to an exact existing source's read-only metadata" });
  for (const selected of [value.cuEndpoint, value.projectEndpoint, value.embedding.endpoint, value.chat.endpoint])
    if (new URL(selected).hostname.split(".")[0] !== account)
      context.addIssue({ code: "custom", message: "CU/project/model endpoints must belong to the selected Foundry account" });
  if (new URL(value.projectEndpoint).pathname.split("/").at(-1)?.toLowerCase() !== value.projectResourceId.split("/").at(-1)?.toLowerCase())
    context.addIssue({ code: "custom", path: ["projectEndpoint"], message: "Project endpoint/resource mismatch" });
});
export type PersonalConfig = z.infer<typeof personalConfigSchema>;
export const stageSchema = z.enum(["ingest", "kb", "chat", "inspect"]);
export type PersonalStage = z.infer<typeof stageSchema>;
export const boundsSchema = z.strictObject({
  maxRequests: z.number().int().min(1).max(150),
  questions: z.number().int().min(1).max(10),
  maxContextCharacters: z.number().int().min(1000).max(40000),
  maxOutputTokens: z.number().int().min(128).max(2048),
  incrementalAllowanceUsd: z.number().positive().max(100),
  remainingBudgetUsd: z.number().positive().max(100),
  pricingEvidence: z.string().min(10).max(4000),
  disclosuresAccepted: z.literal(true),
}).refine((value) => value.incrementalAllowanceUsd <= value.remainingBudgetUsd, "Allowance exceeds remaining ceiling");
export type PersonalBounds = z.infer<typeof boundsSchema>;
export type PersonalDocument = {
  id: string; path: string; mime: string; size: number;
  state: "local" | "sending" | "indexed" | "uncertain" | "failed";
  nativeFileId: string | null; error: string | null;
};
export type PersonalCitation = { id: string; documentId: string; path: string; fileId: string; chunkId: string; excerpt: string };
export type PersonalAnswer = { question: string; answer: string; citations: PersonalCitation[] };
export type PersonalSnapshot = {
  id: string; state: string; created: string; error: string | null;
  indexName: string | null; sourceEtag: string | null; kbEtag: string | null;
  documents: PersonalDocument[];
};
export type PersonalOperation = {
  id: string; stage: PersonalStage; state: string; expiresAt: string;
  questionsUsed: number; questionLimit: number;
};
export type PersonalState = {
  configured: boolean; blocker: string | null; snapshot: PersonalSnapshot | null;
  operations: PersonalOperation[]; answers: PersonalAnswer[];
  targets: { source: string; kb: string } | null;
};
