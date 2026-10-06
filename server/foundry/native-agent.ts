import { z } from "zod";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { searchApiVersion, foundryConfigSchema, projectEndpointSchema, type FoundryConfig } from "./config";
import { delegatedHeader, serviceHeader, type DelegatedCredential, type ServiceCredential } from "./credentials";
import { HttpError } from "../errors";

export async function inspectNativeMcp(
  input: FoundryConfig,
  user: DelegatedCredential,
  readerCredential: ServiceCredential,
) {
  const config = foundryConfigSchema.parse(input);
  if (user.identity.tenantId !== config.tenantId || !config.roster.includes(user.identity.objectId))
    throw new HttpError(403, "Native MCP inspection requires an approved delegated user");
  const client = new Client({ name: "jevbox-native-contract-spike", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${config.searchEndpoint.replace(/\/$/, "")}/knowledgebases/${config.knowledgeBaseName}/mcp?api-version=${searchApiVersion}`),
    { requestInit: { headers: {
      Authorization: serviceHeader(readerCredential),
      "x-ms-query-source-authorization": delegatedHeader(user),
    } } },
  );
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const tool = tools.find((tool) => tool.name === "knowledge_base_retrieve");
    if (!tool) throw new HttpError(502, "Native KB did not expose knowledge_base_retrieve");
    return { name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema };
  } finally { await client.close(); }
}

export function createNativeAgentClient(input: {
  config: FoundryConfig;
  projectEndpoint: string;
  agentName: string;
  projectCredential: () => Promise<ServiceCredential>;
  fetcher?: typeof fetch;
}) {
  const config = foundryConfigSchema.parse(input.config);
  const endpoint = new URL(projectEndpointSchema.parse(input.projectEndpoint));
  if (endpoint.toString().replace(/\/$/, "") !== config.projectEndpoint.replace(/\/$/, ""))
    throw new Error("Native agent must use the configured Foundry project");
  const agentName = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/).parse(input.agentName);
  return {
    async invoke(question: string, user: DelegatedCredential, signal: AbortSignal) {
      if (user.identity.tenantId !== config.tenantId || !config.roster.includes(user.identity.objectId))
        throw new HttpError(403, "Native agent invocation is outside the approved tenant roster");
      const response = await (input.fetcher ?? fetch)(
        `${endpoint.toString().replace(/\/$/, "")}/openai/v1/responses`,
        {
          method: "POST", redirect: "error", signal,
          headers: {
            Authorization: serviceHeader(await input.projectCredential()),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: z.string().trim().min(1).max(4000).parse(question),
            agent_reference: { type: "agent_reference", name: agentName },
            structured_inputs: { search_auth_token: delegatedHeader(user) },
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(502, `Native Foundry agent failed (${response.status})`);
      }
      const payload = z.object({
        id: z.string(),
        status: z.literal("completed"),
        output: z.array(z.record(z.string(), z.unknown())),
        usage: z.object({
          input_tokens: z.number().int().nonnegative().optional(),
          output_tokens: z.number().int().nonnegative().optional(),
        }).optional(),
      }).parse(await response.json());
      const calls = payload.output.filter((item) => item.type === "mcp_call" && item.name === "knowledge_base_retrieve");
      if (!calls.length) throw new HttpError(502, "No actual native knowledge_base_retrieve invocation was returned");
      // Payload-level source validation is separate from model-output correctness.
      return {
        responseId: payload.id,
        toolCalls: calls.map((call) => ({
          id: z.string().parse(call.id), name: "knowledge_base_retrieve" as const,
          output: call.output, error: call.error,
        })),
        messages: payload.output.filter((item) => item.type === "message"),
        usage: payload.usage,
        activity: null,
        references: null,
        payloadFaithfulness: "requires-source-validation" as const,
      };
    },
  };
}
