import assert from "node:assert/strict";
import { test } from "node:test";
import { runMetrics, runSnapshotSchema, type RunEvent } from "../shared/observability";
import { createRunRecorder } from "../server/run-observability";

const event = (sequence: number, timestamp: string, kind: RunEvent["kind"], extra: Partial<RunEvent> = {}): RunEvent => ({
  schemaVersion: 1, id: `event-${sequence}`, runId: "run", sequence, timestamp,
  kind, origin: "application", ...extra,
});
test("console run latency is wall clock, missing usage is unavailable and duplicate summaries do not count", () => {
  const run = runSnapshotSchema.parse({
    schemaVersion: 1, id: "run", dependencies: [],
    events: [
      event(0, "2026-10-06T01:00:00.000Z", "run-started"),
      event(1, "2026-10-06T01:00:00.100Z", "step-completed", { stage: "model", elapsedMs: 900,
        usage: { accountingId: "call-a", origin: "provider", scope: "invocation", input: 100, output: 10, cacheRead: 30 } }),
      event(2, "2026-10-06T01:00:00.100Z", "step-completed", { stage: "model", elapsedMs: 900,
        usage: { accountingId: "call-b", origin: "provider", scope: "invocation", input: 20 } }),
      event(3, "2026-10-06T01:00:01.000Z", "run-completed",
        { elapsedMs: 1000, usage: { accountingId: "summary", origin: "provider", scope: "summary", input: 120, output: 10 } }),
    ],
  });
  const metrics = runMetrics(run);
  assert.equal(metrics.wallClockMs, 1000);
  assert.deepEqual(metrics.input, { value: 120, partial: false });
  assert.deepEqual(metrics.output, { value: 10, partial: true });
  assert.deepEqual(metrics.cacheRead, { value: 30, partial: true });
  assert.deepEqual(metrics.cacheWrite, { value: null, partial: false });
});
test("monotonic duration survives wall-clock reversal and unreported model usage remains partial", async () => {
    let tick = 100;
    let date = new Date("2026-10-06T01:00:01Z");
    const run = createRunRecorder("clock", async () => {}, () => date, () => tick);
    await run.start();
    await run.nativeActivities([{ id: 1, type: "modelQueryPlanning", inputTokens: 20 }]);
    const model = await run.begin("model");
    tick = 350;
    date = new Date("2026-10-06T01:00:00Z");
    await run.end(model, "model");
    await run.finish();
    assert.equal(runMetrics(run.snapshot()).wallClockMs, 250);
    assert.deepEqual(runMetrics(run.snapshot()).input, { value: 20, partial: true });
    const failure = createRunRecorder("failure", async () => {});
    await failure.start();
    const controller = new AbortController();
    controller.abort(new Error("retrieval failed"));
    assert.equal(failure.failedSnapshot(false).events.at(-1)?.kind, "run-failed");
    const cancel = createRunRecorder("cancel", async () => {});
    await cancel.start();
    assert.equal(cancel.failedSnapshot(true).events.at(-1)?.kind, "run-cancelled");
});
test("a started model invocation with no reported completion remains partial after provider failure", async () => {
  const run = createRunRecorder("missing-usage", async () => {});
  await run.start();
  await run.nativeActivities([{ id: 1, type: "modelQueryPlanning", inputTokens: 12 }]);
  await run.begin("model");
  assert.deepEqual(runMetrics(run.failedSnapshot(false)).input, { value: 12, partial: true });
});
test("event contract rejects credentials, private reasoning and duplicate reconnect IDs", () => {
  const base = event(0, "2026-10-06T01:00:00.000Z", "run-started");
  assert.equal(runSnapshotSchema.safeParse({ schemaVersion: 1, id: "run", dependencies: [],
    events: [{ ...base, accessToken: "secret" }] }).success, false);
  assert.equal(runSnapshotSchema.safeParse({ schemaVersion: 1, id: "run", dependencies: [],
    events: [{ ...base, chainOfThought: "private" }] }).success, false);
  assert.equal(runSnapshotSchema.safeParse({ schemaVersion: 1, id: "run", dependencies: [],
    events: [base, { ...base, sequence: 1 }] }).success, false);
});
test("recorder persists ordered immutable snapshots and surfaces persistence failure", async () => {
  const saved: number[] = [];
  const run = createRunRecorder("run", async (snapshot) => { saved.push(snapshot.events.length); });
  await run.start();
  const one = await run.begin("retrieval");
  const two = await run.begin("model");
  await run.end(one, "retrieval");
  await run.end(two, "model");
  await run.finish();
  assert.deepEqual(saved, [1, 2, 3, 4, 5, 6]);
  assert.throws(() => runMetrics({ ...run.snapshot(), events: [run.snapshot().events[1]] }));
  const failed = createRunRecorder("other", async () => { throw new Error("database unavailable"); });
  await assert.rejects(() => failed.start(), /database unavailable/);
});
