import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { chromium } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createPersonalApp } from "../server/personal-file/app";
import type { PersonalState } from "../shared/personal-file";

test("OFFLINE built browser: real picker, local persistence/WebGL/originals; explicitly synthetic paid-chat UI", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jevbox-personal-browser-"));
  const corpus = join(directory, "Synthetic drive"), data = join(directory, "private");
  mkdirSync(join(corpus, "Operations"), { recursive: true });
  writeFileSync(join(corpus, "Operations", "policy.md"), "# OFFLINE synthetic policy\n\nRestore target is 30 minutes.");
  writeFileSync(join(corpus, "overview.txt"), "OFFLINE overview.");
  const host = express(), server = host.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const runtime = await createPersonalApp({ origin, directory: data, config: null,
    transport: async () => { throw new Error("No Azure transport is permitted in this browser test"); } });
  host.use(runtime.app); runtime.app.use(express.static(resolve("dist"), { index: false }));
  runtime.app.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: resolve("dist") }));
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1550, height: 1000 } });
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === "blob:" || url.protocol === "data:") return route.continue();
    external.push(url.origin); return route.abort();
  });
  try {
    const response = await page.goto(origin); assert.equal(response!.status(), 200);
    await page.getByRole("heading", { name: "Your document drive" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Activation blocked" }).count(), 0);
    assert(await page.getByRole("heading", { name: "Ask Foundry IQ" }).isVisible());
    assert(await page.getByRole("button", { name: "Ask with sources" }).isDisabled());
    const fileChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Connect local files", exact: true }).click();
    assert(await fileChooser);
    await page.getByLabel("Choose personal folder", { exact: true }).setInputFiles(corpus);
    await page.getByRole("heading", { name: "Review selected snapshot" }).waitFor();
    await page.locator("canvas").first().waitFor();
    assert((await page.locator("canvas").first().evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).startsWith("data:image/png"));
    assert(await page.getByText(/Selected locally - not indexed/).first().isVisible());
    await page.getByRole("button", { name: "Save selected snapshot locally" }).click();
    await page.getByText("Local - not indexed", { exact: true }).first().waitFor();
    const stateResponse = await page.request.get(`${origin}/api/personal/state`);
    const saved = await stateResponse.json() as PersonalState;
    assert.equal(saved.snapshot!.documents.length, 2);
    assert(saved.snapshot!.documents.some((document) => document.path === "Synthetic drive/Operations/policy.md"));
    assert.equal(saved.configured, false); assert.equal(saved.operations.length, 0);
    await page.getByRole("button", { name: "policy.md", exact: false }).first().click();
    await page.locator('[aria-label="Original source"]').waitFor();
    assert(await page.getByText("Restore target is 30 minutes.", { exact: false }).isVisible());
    await page.getByRole("button", { name: "Close original", exact: true }).click();
    await page.getByRole("button", { name: "Azure provenance", exact: true }).click();
    assert(await page.getByText("No index has been created by selecting local files.", { exact: false }).isVisible());
    await page.getByRole("button", { name: "Close provenance", exact: true }).click();

    const document = saved.snapshot!.documents.find((entry) => entry.path.endsWith("policy.md"))!;
    const active: PersonalState = { ...saved, configured: true, blocker: "OFFLINE UI fixture only",
      snapshot: { ...saved.snapshot!, state: "ready", documents: saved.snapshot!.documents.map((entry) => ({ ...entry, state: "indexed", nativeFileId: `OFFLINE-${entry.id}` })) },
      operations: [{ id: "OFFLINE-session", stage: "chat", state: "approved", expiresAt: new Date(Date.now() + 60000).toISOString(), questionsUsed: 0, questionLimit: 10 }] };
    await page.route(`${origin}/api/personal/state`, (route) => route.fulfill({ json: active }));
    await page.route(`${origin}/api/personal/execute/OFFLINE-session`, async (route) => {
      assert.equal(route.request().postDataJSON().question, "What is the restore target?");
      active.operations[0].questionsUsed++;
      active.answers.push({ question: "What is the restore target?", answer: "OFFLINE UI fixture: 30 minutes [0]", citations: [{
        id: "0", documentId: document.id, path: document.path, fileId: `OFFLINE-${document.id}`, chunkId: "OFFLINE-chunk", excerpt: "Restore target is 30 minutes.",
      }] });
      await route.fulfill({ json: { ok: true } });
    });
    await page.getByRole("button", { name: "Ask with sources" }).waitFor();
    await page.getByLabel("Your question", { exact: true }).fill("What is the restore target?");
    await page.getByRole("button", { name: "Ask with sources" }).click();
    await page.getByText("OFFLINE UI fixture: 30 minutes [0]", { exact: true }).waitFor();
    await page.getByRole("button", { name: `[0] ${document.path}`, exact: true }).click();
    await page.locator('[aria-label="Original source"]').waitFor();
    assert(await page.locator('[aria-label="Original source"]').isVisible());
    assert(await page.locator(".personal-tree button.selected").getByText("policy.md", { exact: false }).isVisible());
    assert.equal(runtime.store.answers().length, 0, "Synthetic frontend chat is never represented as native backend evidence");
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.equal(runtime.store.snapshot()!.id, saved.snapshot!.id);
  } finally {
    await browser.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await runtime.close(); rmSync(directory, { recursive: true });
  }
});
