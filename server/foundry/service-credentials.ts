import { ConfidentialClientApplication } from "@azure/msal-node";
import type { RuntimeConfig } from "./runtime-config";
import { HttpError } from "../errors";

export function createServiceCredentials(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env) {
  const provider = (clientId: string, secretName: string, scope: string) => {
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
  };
  return {
    reader: provider(config.readerClientId, "FOUNDRY_READER_SECRET", "https://search.azure.com/.default"),
    writer: provider(config.writerClientId, "FOUNDRY_WRITER_SECRET", "https://search.azure.com/.default"),
    project: provider(config.projectClientId, "FOUNDRY_PROJECT_SECRET", "https://ai.azure.com/.default"),
  };
}
