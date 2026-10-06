import { readFile } from "node:fs/promises";
import { z } from "zod";
import { approvalIdentitiesSchema } from "../server/foundry/approval-validation";
const path = process.argv[2];
if (!path) throw new Error("Supply an explicitly ignored private approval file. This command never deploys.");
const schema = z.object({
  status: z.literal("approved"),
  identities: approvalIdentitiesSchema,
  approval: z.object({
    azureMutationsApproved: z.literal(true), entraMutationsApproved: z.literal(true),
    roleAssignmentsApproved: z.literal(true), billableQueriesApproved: z.literal(true),
  }),
});
const checked = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
if (!checked.success) {
  console.error("Approval/identity validation failed. Resolve the private approval manifest; no operation was performed.");
  process.exitCode = 1;
} else console.log("Private approval and distinct identities validated offline. This is not live verification or deployment.");
