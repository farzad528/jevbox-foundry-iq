import { PgBoss } from "pg-boss";
import type { createFoundryDatabase } from "./database";
import type { createKnowledgeEngine } from "./engine";
import { HttpError } from "../errors";

export async function createNativeQueueRuntime(input: {
  databaseUrl: string;
  databaseSchema: string;
  store: Awaited<ReturnType<typeof createFoundryDatabase>>;
}) {
  const queue = new PgBoss({
    connectionString: input.databaseUrl, schema: `${input.databaseSchema}_native_jobs`,
    application_name: "jevbox-native-jobs", max: 3,
  });
  queue.on("error", () => console.error("Native background queue unavailable"));
  try {
    await queue.start();
    for (const name of ["knowledge-sync", "knowledge-request"]) await queue.createQueue(name, {
      retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 300, heartbeatSeconds: 30,
    });
  } catch (error) {
    await queue.stop({ graceful: false });
    throw error;
  }
  const enqueue = async (kind: "sync" | "request", id: string) => {
    const result = await queue.send(kind === "sync" ? "knowledge-sync" : "knowledge-request", { id },
      { singletonKey: id, db: { executeSql: input.store.executeSql } });
    if (!result) throw new HttpError(503, "Durable native work could not be queued");
  };
  return {
    queue, enqueue,
    async startWorkers(engine: Pick<ReturnType<typeof createKnowledgeEngine>, "sync" | "executeRequest">) {
      await queue.work<{ id: string }>("knowledge-sync", { includeMetadata: true }, async (jobs) => {
        for (const job of jobs) await engine.sync(job.data.id, job.signal);
      });
      await queue.work<{ id: string }>("knowledge-request", { includeMetadata: true }, async (jobs) => {
        for (const job of jobs) await engine.executeRequest(job.data.id, job.signal);
      });
      for (const row of await input.store.all<{ id: string }>("SELECT id FROM knowledge_outbox WHERE state IN ('pending','failed') OR (state='working' AND lease_until<now())"))
        await enqueue("sync", row.id);
      for (const row of await input.store.all<{ id: string }>("SELECT id FROM knowledge_requests WHERE state='queued' OR (state='working' AND lease_until<now())"))
        await enqueue("request", row.id);
    },
    stop: (graceful = true) => queue.stop({ graceful, timeout: 30000 }),
  };
}
