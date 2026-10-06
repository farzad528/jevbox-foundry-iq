import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright";
import { createFoundryApp } from "../server/foundry/app";
import { rawEvidenceFromParsed } from "../server/foundry/evidence-mapping";
import { buildIndex } from "../server/indexing";
import { testConfig, testOids } from "./foundry-fixtures";
import { runSnapshotSchema } from "../shared/observability";
import { wikiRevisionSchema } from "../server/wiki/provenance";

test("OFFLINE browser: real blocked startup and explicitly synthetic active-UI interactions; no Azure", async () => {
  const previous = process.env.FOUNDRY_CONFIG_FILE;
  delete process.env.FOUNDRY_CONFIG_FILE;
  const runtime = await createFoundryApp({ origin: "http://localhost:4310" });
  await build({ logLevel: "error" });
  runtime.app.use(express.static(resolve("dist"), { index: false }));
  runtime.app.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: resolve("dist") }));
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    const landing = await page.goto(origin);
    assert(landing); assert.equal(landing.status(), 200);
    assert.match(await landing.text(), /id="root"/);
    await page.getByRole("heading", { name: "Activation blocked" }).waitFor();
    assert(await page.getByText("Native two-user REST/MCP contract spike is unverified.", { exact: true }).isVisible());
    assert.equal(await page.getByRole("button", { name: "Ask IQ + Foundry" }).count(), 0);

    const documentId = "50000000-0000-4000-8000-000000000001";
    const folderId = "50000000-0000-4000-8000-000000000002";
    const pageId = "50000000-0000-4000-8000-000000000003";
    const runId = "50000000-0000-4000-8000-000000000004";
    const parsed = buildIndex([{ content: "# Release\n\nSynthetic launch is October 15." }], "text");
    const evidence = rawEvidenceFromParsed({ documentId, workspaceId: testConfig.workspaceId, title: "Synthetic launch.md",
      fileType: "text/markdown", folderIds: [folderId], sourceRevision: 1, aclRevision: 1,
      userIds: [testOids.A], uploadedAt: "2026-10-01T00:00:00.000Z", parsed })[0];
    assert(evidence.contentKind === "raw");
    const resource = { id: documentId, owner_id: testOids.A, parent_id: null, kind: "document", name: evidence.title,
      mime: "text/markdown", access: "restricted", size: 100, created: "2026-10-01", status: "ready", parsed,
      pinned: false, pages: 0, canWrite: true, canShare: true, syncState: "verified", sourceRevision: 1, aclRevision: 1,
      knowledge_parse_state: "ready", knowledge_filing_state: "approval-required" };
    const wiki = wikiRevisionSchema.parse({ pageId, workspaceId: testConfig.workspaceId, revision: 1,
      title: "Synthetic reviewed context", state: "draft", kind: "decision", authorOid: testOids.A, reviewerOid: null,
      claims: [{ id: "c1", text: "Synthetic launch is October 15.", evidence: [{ evidenceId: evidence.indexKey, locator: evidence.locator }] }], relatedPageIds: [] });
    const run = runSnapshotSchema.parse({ schemaVersion: 1, id: runId, dependencies: [],
      events: [
        { schemaVersion: 1, id: "synthetic-start", runId, sequence: 0, timestamp: "2026-10-01T00:00:00.000Z", kind: "run-started", origin: "application" },
        { schemaVersion: 1, id: "synthetic-end", runId, sequence: 1, timestamp: "2026-10-01T00:00:00.010Z", kind: "run-completed", origin: "application", elapsedMs: 10 },
      ] });
    let revoked = false;
    let readOnly = false;
    const submitted: { question: string; scope: { folderIds: string[]; fileTypes: string[]; createdBefore?: string; contentKind?: string } }[] = [];
    const nativeSubmitted: typeof submitted = [];
    await page.route(`${origin}/api/**`, async (route) => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const answer = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/api/profile") return answer({ profile: "foundry-iq", activated: true, blockers: [] });
      if (path === "/api/foundry/me") return answer({ identity: { tenantId: testConfig.tenantId, objectId: testOids.A },
        workspaceId: testConfig.workspaceId, workspaceName: "OFFLINE synthetic UI", projectEndpoint: testConfig.projectEndpoint,
        modelDeployment: "offline", vendorProcessingApproved: false, roster: testConfig.roster });
      if (path === "/api/resources") return answer(revoked ? [] : [resource, { ...resource, id: folderId, kind: "folder", name: "Synthetic folder", parent_id: null }]);
      if (path === `/api/resources/${documentId}`) return answer(revoked ? { error: "Current access unavailable" } : resource, revoked ? 409 : 200);
      if (path === "/api/foundry/status") return answer({ ownerOnlyPending: [] });
      if (path === "/api/foundry/wiki-stale") return answer([]);
      if (path === "/api/foundry/evidence") return answer(revoked ? [] : [evidence]);
      if (path === "/api/foundry/wiki") return answer(revoked ? [] : [wiki]);
      if (path.endsWith("/history")) return answer(revoked ? [] : [wiki]);
      if (path.endsWith("/links")) return answer({ related: [], backlinks: [] });
      if (path === `/api/foundry/wiki/${pageId}/resource`) return answer({ ...resource, id: pageId, name: wiki.title,
        canWrite: !readOnly, canShare: !readOnly });
      if (path === `/api/foundry/wiki/${pageId}`) return answer(revoked ? { error: "Source access changed" } : wiki, revoked ? 409 : 200);
      if (path === "/api/foundry/requests") return answer(revoked ? [] : [{
        id: runId, kind: "answer", state: "completed", run,
        evidenceMode: submitted.at(-1)?.scope.contentKind === "raw" ? "raw" : "combined",
        result: { answer: `Synthetic launch is October 15 [${evidence.indexKey}]`, evidence: [evidence] },
      }]);
      if (path === "/api/foundry/requests/answer") {
        submitted.push(request.postDataJSON()); return answer({ id: runId }, 202);
      }
      if (path === "/api/foundry/requests/native-agent") {
        nativeSubmitted.push(request.postDataJSON()); return answer({ id: runId }, 202);
      }
      if (path.startsWith("/api/foundry/citations/")) return answer({ originals: [{ name: resource.name, locator: evidence.locator }] });
      return answer({ error: "Unsupported offline UI fixture operation" }, 410);
    });
    await page.reload();
    await page.getByRole("button", { name: "chat", exact: true }).click();
    const consoleRegion = page.getByRole("region", { name: "Authorized run observability" });
    await consoleRegion.waitFor();
    assert(await consoleRegion.getByText("run-completed", { exact: false }).isVisible());
    const collapse = page.getByRole("button", { name: "Collapse execution console" });
    await collapse.focus(); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Expand execution console" }).waitFor();
    assert.equal(await consoleRegion.count(), 0);
    await page.getByRole("button", { name: "Expand execution console" }).click();
    const handle = page.getByRole("separator", { name: "Resize observability console" });
    const height = (await consoleRegion.boundingBox())!.height;
    await handle.focus(); await page.keyboard.press("ArrowUp");
    await page.waitForFunction((oldHeight) =>
      document.querySelector('[aria-label="Authorized run observability"]')!.getBoundingClientRect().height !== oldHeight, height);
    await page.getByRole("button", { name: "Metrics", exact: true }).click();
    assert(await page.getByText("Measured run latency: 10 ms", { exact: true }).isVisible());
    assert(await page.getByText("Reported input: unavailable · output: unavailable", { exact: true }).isVisible());
    await page.getByLabel("Synthetic folder", { exact: true }).check();
    await page.getByLabel("text", { exact: true }).check();
    await page.getByLabel("Uploaded before, inclusive (UTC)").fill("2026-10-06");
    await page.getByLabel("Question / draft topic").fill("When is launch?");
    await page.getByRole("button", { name: "Ask IQ + Foundry" }).click();
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#foundry-question")?.value === "");
    assert.deepEqual(submitted[0].scope.folderIds, [folderId]);
    assert.deepEqual(submitted[0].scope.fileTypes, ["text"]);
    assert.equal(submitted[0].scope.createdBefore, "2026-10-06");
    assert.equal(submitted[0].scope.contentKind, undefined);
    await page.getByLabel("Chat evidence mode").selectOption("raw");
    await page.getByLabel("Question / draft topic").fill("When is launch?");
    await page.getByRole("button", { name: "Ask IQ + Foundry" }).click();
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#foundry-question")?.value === "");
    assert.equal(submitted[1].scope.contentKind, "raw");
    assert.deepEqual({ ...submitted[1].scope, contentKind: undefined }, { ...submitted[0].scope, contentKind: undefined });
    assert(await page.getByText("completed · Raw sources", { exact: true }).isVisible());
    await page.getByRole("button", { name: "native agent", exact: true }).click();
    assert.equal(await page.getByLabel("Chat evidence mode").count(), 0);
    await page.getByLabel("Question / draft topic").fill("When is launch?");
    await page.getByRole("button", { name: "Ask native agent", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#foundry-question")?.value === "");
    assert.equal(nativeSubmitted[0].scope.contentKind, undefined);
    assert.deepEqual(nativeSubmitted[0].scope.folderIds, []);
    assert.deepEqual(nativeSubmitted[0].scope.fileTypes, []);
    await page.getByRole("button", { name: "chat", exact: true }).click();
    await page.getByRole("link", { name: "source", exact: true }).click();
    await page.getByText("Replace synthetic source", { exact: true }).waitFor();
    assert.equal(await page.locator("aside").count(), 2);
    await page.getByRole("button", { name: "Knowledge / Wiki" }).click();
    await page.getByRole("button", { name: "Synthetic reviewed context" }).click();
    await page.getByRole("heading", { name: "Knowledge editor" }).waitFor();
    assert(await page.getByRole("button", { name: "Record human review" }).isDisabled());
    assert(await page.getByRole("button", { name: "Publish reviewed revision" }).isDisabled());
    await page.getByLabel("I verified every claim against the original sources.").check();
    assert(await page.getByRole("button", { name: "Record human review" }).isEnabled());
    readOnly = true;
    await page.reload();
    await page.getByRole("button", { name: "Knowledge / Wiki" }).click();
    await page.getByRole("button", { name: "Synthetic reviewed context" }).click();
    await page.getByText("This page is read-only for your current role.", { exact: true }).waitFor();
    assert(await page.getByLabel("Title", { exact: true }).isDisabled());
    assert(await page.getByRole("textbox", { name: /^Claim 1/ }).isDisabled());
    assert(await page.getByLabel(/Add\/replace supporting original/).isDisabled());
    assert(await page.getByLabel("I verified every claim against the original sources.").isDisabled());
    assert(await page.getByLabel("Compare revision").isEnabled());
    assert.equal(await page.getByRole("button", { name: "Share knowledge page" }).count(), 0);
    revoked = true;
    await page.getByRole("heading", { name: "Knowledge editor" }).waitFor({ state: "hidden", timeout: 7000 });
    await page.getByRole("button", { name: "chat", exact: true }).click();
    assert.equal(await page.getByRole("link", { name: "source", exact: true }).count(), 0);
    assert.equal(await page.getByText("Synthetic launch is October 15.", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("option", { name: /Run 1/ }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await runtime.close();
    if (previous === undefined) delete process.env.FOUNDRY_CONFIG_FILE; else process.env.FOUNDRY_CONFIG_FILE = previous;
  }
});
