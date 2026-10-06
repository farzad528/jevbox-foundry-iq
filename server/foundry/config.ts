import { z } from "zod";

export const searchApiVersion = "2026-08-01-preview";
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{1,127}$/);
const azureEndpoint = (suffix: string) => z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname.endsWith(suffix) &&
    !url.username && !url.password && !url.port && url.pathname === "/" &&
    !url.search && !url.hash;
}, "Use the exact approved Azure HTTPS endpoint");
export const projectEndpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname.endsWith(".services.ai.azure.com") &&
    /^\/api\/projects\/[a-zA-Z0-9_.-]+\/?$/.test(url.pathname) &&
    !url.username && !url.password && !url.port && !url.search && !url.hash;
}, "Use the exact approved Foundry project endpoint");

export const foundryConfigSchema = z.strictObject({
  tenantId: z.uuid(),
  roster: z.array(z.uuid()).length(2).refine((ids) => ids[0] !== ids[1]),
  workspaceId: z.string().min(1).max(200),
  searchEndpoint: azureEndpoint(".search.windows.net"),
  indexName: name,
  knowledgeSourceName: name,
  knowledgeBaseName: name,
  modelEndpoint: azureEndpoint(".openai.azure.com"),
  projectEndpoint: projectEndpointSchema,
  answerDeployment: name,
  embeddingDeployment: name,
  embeddingDimensions: z.number().int().positive().max(4096),
});
export type FoundryConfig = z.infer<typeof foundryConfigSchema>;

export function assertLegacyProfile(env: NodeJS.ProcessEnv = process.env) {
  const profile = env.JEVBOX_PROFILE ?? "legacy";
  if (profile === "legacy") return;
  if (profile !== "foundry-iq") throw new Error("Unknown JEVBOX_PROFILE");
  throw new Error(
    "Foundry IQ activation is blocked pending the native two-user ACL/MCP spike and Entra runtime integration. Legacy sign-in/retrieval will not substitute.",
  );
}
