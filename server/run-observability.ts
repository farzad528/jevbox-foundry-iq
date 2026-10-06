import { randomUUID } from "node:crypto";
import {
  runEventSchema, runSnapshotSchema,
  type RunEvent, type RunSnapshot, type RunStage, type ReportedUsage,
} from "../shared/observability";
import type { NativeActivity } from "./foundry/iq-client";
import { SourceUnavailableError, type SourceVersion } from "../shared/evidence";
import { HttpError } from "./errors";
import { ZodError } from "zod";

export function runFailureCode(error: unknown): RunEvent["errorCode"] {
  if (error instanceof HttpError && error.status === 401) return "authentication-required";
  if (error instanceof HttpError && [403, 409].includes(error.status)) return "access-changed";
  if (error instanceof SourceUnavailableError) return "access-changed";
  if (error instanceof ZodError || error instanceof SyntaxError) return "invalid-response";
  if (error instanceof Error && error.name === "AbortError") return "interrupted";
  return "provider-error";
}

export function createRunRecorder(
  id: string,
  persist: (snapshot: RunSnapshot) => Promise<void>,
  clock: () => Date = () => new Date(),
  monotonic: () => number = () => performance.now(),
  dependencies: SourceVersion[] = [],
) {
  const events: RunEvent[] = [];
  const started = new Map<string, { tick: number; measurementKind?: RunEvent["measurementKind"]; usageExpected: boolean }>();
  let startTick: number | undefined;
  let chain = Promise.resolve();
  const snapshot = () => runSnapshotSchema.parse({
    schemaVersion: 1, id, dependencies, events: [...events],
  });
  const append = (value: Omit<RunEvent, "schemaVersion" | "id" | "runId" | "sequence" | "timestamp">) => {
    const event = runEventSchema.parse({
      ...value, schemaVersion: 1, id: randomUUID(), runId: id,
      sequence: events.length, timestamp: clock().toISOString(),
    });
    events.push(event);
    const saved = snapshot();
    chain = chain.then(() => persist(saved));
    return chain;
  };
  return {
    snapshot,
    start: () => {
      startTick = monotonic();
      return append({ kind: "run-started", origin: "application" });
    },
    async begin(stage: RunStage, labels: { provider?: string; model?: string; measurementKind?: RunEvent["measurementKind"]; usageExpected?: boolean } = {}) {
      const stepId = randomUUID();
      started.set(stepId, { tick: monotonic(), measurementKind: labels.measurementKind, usageExpected: labels.usageExpected ?? stage === "model" });
      await append({ kind: "step-started", origin: "application", stage, stepId, ...labels,
        usageExpected: labels.usageExpected ?? stage === "model" });
      return stepId;
    },
    async end(stepId: string, stage: RunStage, usage?: ReportedUsage) {
      const start = started.get(stepId);
      if (start === undefined) throw new Error("Unknown or already completed observability step");
      started.delete(stepId);
      await append({ kind: "step-completed", origin: "application", stepId, stage,
        elapsedMs: monotonic() - start.tick, measurementKind: start.measurementKind,
        usageExpected: start.usageExpected, ...(usage ? { usage } : {}) });
    },
    finish: () => append({ kind: "run-completed", origin: "application",
      ...(startTick === undefined ? {} : { elapsedMs: monotonic() - startTick }) }),
    async nativeActivities(activities: NativeActivity[]) {
      for (const activity of activities) {
        const planning = activity.type === "modelQueryPlanning";
        const summary = activity.type === "agenticReasoning";
        const modelUsage = planning || summary || activity.inputTokens !== undefined || activity.outputTokens !== undefined || activity.reasoningTokens !== undefined;
        await append({
          kind: "service-activity", origin: "native-rest",
          stage: planning || summary ? "planning" : "retrieval",
          stepId: `native-${activity.id}`,
          ...(activity.elapsedMs === undefined ? {} : { elapsedMs: activity.elapsedMs }),
          ...(modelUsage ? { usage: {
            accountingId: `${id}:native-${activity.id}`,
            origin: "native-rest", scope: summary ? "summary" : "invocation",
            ...(activity.inputTokens === undefined ? {} : { input: activity.inputTokens }),
            ...(activity.outputTokens === undefined ? {} : { output: activity.outputTokens }),
            ...(activity.reasoningTokens === undefined ? {} : { reasoning: activity.reasoningTokens }),
          } } : {}),
        });
      }
    },
    failedSnapshot(cancelled: boolean, errorCode: RunEvent["errorCode"] = "provider-error") {
      const event = runEventSchema.parse({
        schemaVersion: 1, id: randomUUID(), runId: id, sequence: events.length,
        timestamp: clock().toISOString(), origin: "application",
        kind: cancelled ? "run-cancelled" : "run-failed",
        errorCode: cancelled ? "cancelled" : errorCode,
        ...(startTick === undefined ? {} : { elapsedMs: monotonic() - startTick }),
      });
      events.push(event);
      return snapshot();
    },
  };
}
