import { z } from "zod";
import { sourceVersionSchema } from "./evidence";

const name = z.string().regex(/^[a-zA-Z0-9._:/-]{1,200}$/);
const tokens = z.number().int().nonnegative().safe();
export const reportedUsageSchema = z.strictObject({
  accountingId: name,
  origin: z.enum(["provider", "native-rest", "native-mcp"]),
  scope: z.enum(["invocation", "summary"]),
  input: tokens.optional(),
  output: tokens.optional(),
  cacheRead: tokens.optional(),
  cacheWrite: tokens.optional(),
  reasoning: tokens.optional(),
  other: tokens.optional(),
});
export type ReportedUsage = z.infer<typeof reportedUsageSchema>;
export const runStageSchema = z.enum([
  "authorization", "planning", "retrieval", "tool", "evidence",
  "model", "citations", "publication", "indexing", "acl-sync",
]);
export type RunStage = z.infer<typeof runStageSchema>;
export const runEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: name,
  runId: name,
  sequence: z.number().int().nonnegative().safe(),
  timestamp: z.iso.datetime(),
  kind: z.enum([
    "run-started", "step-started", "step-completed", "step-failed",
    "service-activity", "run-completed", "run-failed", "run-cancelled",
  ]),
  origin: z.enum(["application", "native-rest", "native-mcp", "provider"]),
  stepId: name.optional(),
  stage: runStageSchema.optional(),
  provider: name.optional(),
  model: name.optional(),
  correlationId: name.optional(),
  elapsedMs: z.number().nonnegative().finite().optional(),
  usageExpected: z.boolean().optional(),
  measurementKind: z.enum(["application-step", "model-step-with-tools"]).optional(),
  usage: reportedUsageSchema.optional(),
  errorCode: z.enum([
    "authentication-required", "access-changed", "provider-error",
    "invalid-response", "cancelled", "interrupted", "index-partial",
  ]).optional(),
});
export type RunEvent = z.infer<typeof runEventSchema>;
export const runSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: name,
  dependencies: z.array(sourceVersionSchema).max(256),
  events: z.array(runEventSchema).max(2048),
}).superRefine((run, context) => {
  const ids = new Set<string>();
  for (const [index, event] of run.events.entries()) {
    if (event.runId !== run.id || event.sequence !== index || ids.has(event.id))
      context.addIssue({ code: "custom", message: "Invalid run event ordering or identity" });
    ids.add(event.id);
  }
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export function runMetrics(run: RunSnapshot) {
  runSnapshotSchema.parse(run);
  const start = run.events.find((event) => event.kind === "run-started");
  const end = run.events.findLast((event) =>
    ["run-completed", "run-failed", "run-cancelled"].includes(event.kind));
  const usage = new Map<string, ReportedUsage>();
  const unreported = new Set<string>();
  for (const event of run.events) {
    if (event.kind === "step-started" && event.usageExpected)
      unreported.add(event.stepId ?? event.id);
    if (event.kind === "step-completed" && event.usage)
      unreported.delete(event.stepId ?? event.id);
    if (event.kind === "step-completed" && event.usageExpected && !event.usage)
      unreported.add(event.stepId ?? event.id);
    const report = event.usage;
    if (!report || report.scope !== "invocation") continue;
    const previous = usage.get(report.accountingId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(report))
      throw new Error("Conflicting usage for one provider invocation");
    usage.set(report.accountingId, report);
  }
  const sum = (field: "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "other") => {
    const reports = [...usage.values()];
    const known = reports.flatMap((report) => report[field] === undefined ? [] : [report[field]]);
    return {
      value: known.length ? known.reduce((a, b) => a + b, 0) : null,
      partial: known.length > 0 && (known.length !== reports.length || unreported.size > 0),
    };
  };
  return {
    wallClockMs: start && end ? end.elapsedMs ?? null : null,
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    reasoning: sum("reasoning"),
    other: sum("other"),
  };
}
