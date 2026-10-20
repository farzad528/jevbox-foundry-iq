import { z } from "zod";
import { personalApiVersion, type PersonalConfig } from "../../shared/personal-file";
import { HttpError } from "../errors";
import { responseRequestId, type Credential, type NativeTransport } from "./native";
import { canonical } from "./store";

const record = z.record(z.string(), z.unknown());
export async function readPersonalPreflight(config: PersonalConfig, credential: Credential, transport: NativeTransport = fetch) {
  const observations: { path: string; status: number; requestId: string | null }[] = [];
  const get = async (path: string, version: string) => {
    const response = await transport(`https://management.azure.com${path}?api-version=${version}`, {
      redirect: "error", signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${await credential("arm")}` },
    });
    observations.push({ path, status: response.status, requestId: responseRequestId(response) });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(403, `Exact metadata read failed (${response.status}) for ${path}; no fallback or grants`); }
    return record.parse(await response.json());
  };
  const search = await get(config.searchResourceId, "2025-05-01");
  const identity = z.object({ principalId: z.string().uuid() }).parse(search.identity);
  const searchProperties = z.object({ provisioningState: z.literal("succeeded").or(z.literal("Succeeded")) }).passthrough().parse(search.properties);
  const accountId = config.projectResourceId.slice(0, config.projectResourceId.lastIndexOf("/projects/"));
  const account = await get(accountId, "2025-06-01");
  const project = await get(config.projectResourceId, "2025-06-01");
  const projectProperties = z.object({ endpoints: record }).parse(project.properties);
  if (!Object.values(projectProperties.endpoints).some((value) => typeof value === "string" && value.replace(/\/$/, "") === config.projectEndpoint))
    throw new HttpError(409, "Project inference base endpoint is not present in the actual selected project metadata");
  const deployments = [];
  for (const selected of [config.embedding, config.chat]) {
    const deployment = await get(`${accountId}/deployments/${encodeURIComponent(selected.deployment)}`, "2025-06-01");
    const properties = z.object({ provisioningState: z.literal("Succeeded"), model: z.object({ name: z.string(), version: z.string() }) }).passthrough().parse(deployment.properties);
    if (properties.model.name !== selected.model || properties.model.version !== selected.version)
      throw new HttpError(409, "Selected model/version differs from current deployment metadata");
    deployments.push({ deployment: selected.deployment, model: properties.model, sku: deployment.sku,
      versionUpgradeOption: properties.versionUpgradeOption ?? "not-reported" });
  }
  const roleEvidence: { scope: string; principalId: string; roles: string[] }[] = [];
  for (const [scope, principalId, required] of [
    [config.searchResourceId, config.ownerOid, ["Search Service Contributor", "Search Index Data Contributor", "Search Index Data Reader"]],
    [accountId, identity.principalId, ["Cognitive Services User", "Cognitive Services OpenAI User"]],
  ] as const) {
    const filter = encodeURIComponent(`principalId eq '${principalId}'`);
    const roleResponse = await get(`${scope}/providers/Microsoft.Authorization/roleAssignments`, `2022-04-01&$filter=${filter}`);
    if (roleResponse.nextLink) throw new HttpError(409, "Scoped role evidence requires more pages; owner must resolve the narrow proof without inventory widening");
    const assignments = z.array(z.object({ properties: z.object({
      principalId: z.string(), scope: z.string(), roleDefinitionId: z.string(), condition: z.string().nullable().optional(),
    }) })).parse(roleResponse.value);
    const roles: string[] = [];
    for (const assignment of assignments) {
      if (assignment.properties.principalId.toLowerCase() !== principalId.toLowerCase() || assignment.properties.condition) continue;
      const assignmentScope = assignment.properties.scope.toLowerCase(), targetScope = scope.toLowerCase();
      if (assignmentScope !== targetScope && !targetScope.startsWith(`${assignmentScope}/`)) continue;
      const rolePath = assignment.properties.roleDefinitionId;
      if (!/^\/(?:subscriptions\/[a-f0-9-]+\/)?providers\/Microsoft.Authorization\/roleDefinitions\/[a-f0-9-]+$/i.test(rolePath))
        throw new HttpError(409, "Unexpected role-definition boundary");
      const role = await get(rolePath, "2022-04-01");
      const definition = z.object({ roleName: z.string(), type: z.string() }).parse(role.properties);
      if (definition.type === "BuiltInRole") roles.push(definition.roleName);
    }
    const missing = required.filter((role) => !roles.includes(role));
    if (missing.length) throw new HttpError(403, `Unverified unconditional roles: ${missing.join(", ")} at ${scope}; no grants were attempted`);
    roleEvidence.push({ scope, principalId, roles });
  }
  if (config.cmkBaselineSource) {
    const response = await transport(`${config.searchEndpoint}/knowledgesources('${config.cmkBaselineSource}')?api-version=${personalApiVersion}`, {
      redirect: "error", signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${await credential("search")}` },
    });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(403, `Exact inherited-encryption metadata read failed (${response.status}); no mutation`); }
    const actual = record.parse(await response.json());
    if (canonical(actual.encryptionKey ?? null) !== canonical(config.inheritedEncryption))
      throw new HttpError(409, "Current inherited encryption differs from its selected private baseline");
    observations.push({ path: `exact-source:${config.cmkBaselineSource}`, status: response.status, requestId: responseRequestId(response) });
  } else {
    throw new HttpError(409, "Service CMK enforcement does not prove encryption absence; pin an exact existing-source read-only encryption baseline");
  }
  return {
    kind: "read-only-metadata", observations, search: { location: search.location, sku: search.sku, systemIdentity: identity.principalId,
      status: searchProperties.provisioningState, replicaCount: searchProperties.replicaCount ?? "not-reported",
      partitionCount: searchProperties.partitionCount ?? "not-reported" }, account: { location: account.location, kind: account.kind }, deployments, roleEvidence,
    caveats: ["No paid inference/CU/capacity proof", "No current price, remaining-budget or CU-meter proof", "GlobalStandard is not US-only inference", "Existing Search baseline continues while idle"],
  };
}
