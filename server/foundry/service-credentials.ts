import { ConfidentialClientApplication } from "@azure/msal-node";
import type { RuntimeConfig } from "./runtime-config";
import { HttpError } from "../errors";

function scopedCredential(config: RuntimeConfig, clientId: string, secretName: string, scope: string, env: NodeJS.ProcessEnv) {
  const secret = env[secretName];
  if (!secret) throw new Error(`${secretName} is required; keys/ambient elevated identities are not supported`);
  const client = new ConfidentialClientApplication({
    auth: { clientId, clientSecret: secret, authority: `https://login.microsoftonline.com/${config.knowledge.tenantId}` },
    system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
  });
  return async () => {
    if (!config.approvals.cloudCalls) throw new HttpError(503, "Cloud calls remain approval-gated");
    const result = await client.acquireTokenByClientCredential({ scopes: [scope] });
    if (!result?.accessToken || !result.expiresOn) throw new HttpError(503, "Scoped service credential unavailable");
    return { token: result.accessToken, expiresAt: result.expiresOn.getTime() };
  };
}
export function createServiceCredential(config: RuntimeConfig, role: "reader" | "writer" | "project", env: NodeJS.ProcessEnv = process.env) {
  const [clientId, secretName, scope] = role === "reader"
    ? [config.readerClientId, "FOUNDRY_READER_SECRET", "https://search.azure.com/.default"]
    : role === "writer" ? [config.writerClientId, "FOUNDRY_WRITER_SECRET", "https://search.azure.com/.default"]
    : [config.projectClientId, "FOUNDRY_PROJECT_SECRET", "https://ai.azure.com/.default"];
  return scopedCredential(config, clientId, secretName, scope, env);
}
export function createDefinitionReadbackCredential(config: RuntimeConfig, clientId: string, env: NodeJS.ProcessEnv = process.env) {
  return scopedCredential(config, clientId, "FOUNDRY_DEFINITION_READER_SECRET", "https://search.azure.com/.default", env);
}
export function createServiceCredentials(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env) {
  return {
    reader: createServiceCredential(config, "reader", env),
    writer: createServiceCredential(config, "writer", env),
    project: createServiceCredential(config, "project", env),
  };
}
