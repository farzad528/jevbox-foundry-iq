import { readFile } from "node:fs/promises";
import { z } from "zod";
import { foundryConfigSchema, searchApiVersion } from "./config";

export const nativeBindingSchema = z.strictObject({
  apiVersion: z.literal(searchApiVersion),
  knowledge: foundryConfigSchema,
  agentName: z.string(),
  entraClientId: z.uuid(),
  readerClientId: z.uuid(),
  writerClientId: z.uuid(),
  projectClientId: z.uuid(),
});
export function nativeBinding(config: {
  knowledge: z.infer<typeof foundryConfigSchema>; agentName: string;
  entraClientId: string; readerClientId: string; writerClientId: string; projectClientId: string;
}) {
  return nativeBindingSchema.parse({ apiVersion: searchApiVersion, knowledge: config.knowledge,
    agentName: config.agentName, entraClientId: config.entraClientId, readerClientId: config.readerClientId,
    writerClientId: config.writerClientId, projectClientId: config.projectClientId });
}
export const nativeProofSchema = z.strictObject({
  binding: nativeBindingSchema,
  verifiedAt: z.iso.datetime(),
  tenantId: z.uuid(),
  roster: z.array(z.uuid()).length(2),
  knowledgeBaseName: z.string(),
  projectEndpoint: z.string(),
  checks: z.strictObject({
    restTwoUserAcl: z.literal(true),
    restAdverseTokens: z.literal(true),
    mcpTwoUserAcl: z.literal(true),
    mcpAdverseTokens: z.literal(true),
    mcpOriginalLocators: z.literal(true),
    hybridLowExtractive: z.literal(true),
    projectModelDeployments: z.literal(true),
  }),
});
export const runtimeConfigSchema = z.strictObject({
  knowledge: foundryConfigSchema,
  databaseSchema: z.string().regex(/^fiq_[a-z0-9_]{1,40}$/),
  workspaceName: z.string().min(1).max(160),
  agentName: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  entraClientId: z.uuid(),
  readerClientId: z.uuid(),
  writerClientId: z.uuid(),
  projectClientId: z.uuid(),
  approvals: z.strictObject({
    entraConsent: z.boolean(),
    cloudCalls: z.boolean(),
    syntheticUploads: z.boolean(),
    vendorProcessing: z.boolean(),
  }),
  nativeProof: nativeProofSchema.nullable(),
}).superRefine((config, context) => {
  if (config.readerClientId === config.writerClientId || config.projectClientId === config.writerClientId)
    context.addIssue({ code: "custom", message: "Ingestion identity must be separate from query/model identities" });
  const proof = config.nativeProof;
  if (proof && (JSON.stringify(nativeBinding(config)) !== JSON.stringify(nativeBindingSchema.parse(proof.binding)) ||
    proof.tenantId !== config.knowledge.tenantId ||
    proof.knowledgeBaseName !== config.knowledge.knowledgeBaseName ||
    proof.projectEndpoint !== config.knowledge.projectEndpoint ||
    [...proof.roster].sort().join() !== [...config.knowledge.roster].sort().join()))
    context.addIssue({ code: "custom", message: "Native proof does not match this exact environment" });
});
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export function activationBlockers(config: RuntimeConfig | null) {
  if (!config) return ["No approved Foundry runtime configuration is selected.", "Azure/Entra and billable operations are not approved.", "Native two-user REST/MCP contract spike is unverified."];
  const blockers = [];
  if (!config.approvals.entraConsent) blockers.push("Entra sign-in/consent is not approved.");
  if (!config.approvals.cloudCalls) blockers.push("Paid Search/model calls are not approved.");
  if (!config.approvals.syntheticUploads) blockers.push("Synthetic source indexing is not approved.");
  if (!config.nativeProof) blockers.push("Native two-user REST/MCP contract spike is unverified.");
  else if (Date.now() - Date.parse(config.nativeProof.verifiedAt) > 7 * 86400000 ||
           Date.parse(config.nativeProof.verifiedAt) > Date.now())
    blockers.push("Native proof must be renewed for the selected environment.");
  return blockers;
}
export async function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  return env.FOUNDRY_CONFIG_FILE
    ? runtimeConfigSchema.parse(JSON.parse(await readFile(env.FOUNDRY_CONFIG_FILE, "utf8")))
    : null;
}
