import { z } from "zod";
export const approvalIdentitiesSchema = z.object({
  queryPrincipalId: z.uuid(), ingestionPrincipalId: z.uuid(), projectModelPrincipalId: z.uuid(),
  userAObjectId: z.uuid(), userBObjectId: z.uuid(),
}).superRefine((ids, context) => {
  if (ids.queryPrincipalId === ids.ingestionPrincipalId || ids.projectModelPrincipalId === ids.ingestionPrincipalId)
    context.addIssue({ code: "custom", message: "Query/model and ingestion principals must be distinct" });
  if (ids.userAObjectId === ids.userBObjectId)
    context.addIssue({ code: "custom", message: "The native ACL demonstration requires two distinct real users" });
});
export const pinnedRoleIds = {
  searchReader: "1407120a-92aa-4202-b7e9-c0e197c71c8f",
  searchWriter: "8ebe5a00-799e-43f5-93ac-243d3dce84a7",
  searchModel: "a97b65f3-24c7-4388-baec-2e87135dc908",
  projectUser: "53ca6127-db72-4b80-b1b0-d745d6d5456d",
  agentConsumer: "eed3b665-ab3a-47b6-8f48-c9382fb1dad6",
} as const;
