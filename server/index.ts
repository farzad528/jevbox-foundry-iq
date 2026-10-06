import { createApp } from "./app";
import { resolve } from "node:path";
import express from "express";
import { queues } from "./jobs";
import { createFoundryApp } from "./foundry/app";
const port = Number(process.env.PORT ?? 4310);
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;
const runtime = process.env.JEVBOX_PROFILE === "foundry-iq" ? await createFoundryApp({
  origin, workers: process.env.NODE_ENV !== "production",
}) : await createApp({
  directory: resolve(process.env.DATA_DIR ?? ".data"),
  origin,
  workers: process.env.NODE_ENV === "production" ? [] : Object.values(queues),
});
if (process.env.NODE_ENV === "production") {
  runtime.app.use(express.static(resolve("dist"), { index: false }));
  runtime.app.get("/{*path}", (_req, res) =>
    res.sendFile("index.html", { root: resolve("dist") }),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    cacheDir: resolve(`node_modules/.vite/jevbox-${port}`),
    server: { middlewareMode: true },
    appType: "spa",
  });
  runtime.app.use(vite.middlewares);
}
const server = runtime.app.listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(`Jevbox is running at ${origin}`),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 40_000);
    timeout.unref();
    void (async () => {
      runtime.closeStreams();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await runtime.close();
      process.exit(0);
    })().catch(() => {
      console.error("Application shutdown failed");
      process.exit(1);
    });
  });
