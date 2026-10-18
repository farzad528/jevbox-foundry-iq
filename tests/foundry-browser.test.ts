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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ImportConnection } from "../shared/selected-imports";

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
  const selectionDirectory = resolve(".data", `customer-import-browser-${randomUUID()}`);
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
    await page.getByRole("button", { name: "Connect local files", exact: true }).click();
    assert(await page.getByText("Nothing has been uploaded or connected.", { exact: false }).isVisible());
    await page.getByRole("button", { name: "Connect Google Drive", exact: true }).click();
    assert(await page.getByText("Google Drive: configure an approved Google OAuth client", { exact: false }).isVisible());
    assert.equal(await page.locator('input[type="file"]').count(), 0, "Blocked setup never selects or uploads files");

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
    const connections: ImportConnection[] = [];
    let receiptFailure = false;
    let denyCollectionReadback = false;
    let googleSelection = false;
    const collectionResources = () => connections.flatMap((connection) => [
      { ...resource, id: connection.rootId, kind: "folder", name: connection.label, parent_id: null },
      ...connection.items.filter((item) => item.state === "verified" && item.name).map((item) =>
        ({ ...resource, id: item.id, name: item.name!, parent_id: connection.rootId })),
    ]);
    const verify = (connection: ImportConnection, index: number, name: string) =>
      Object.assign(connection.items[index], { state: "verified", name });
    const importRequests: { path: string; body: string }[] = [];
    const submitted: { question: string; scope: { folderIds: string[]; fileTypes: string[]; createdBefore?: string; contentKind?: string } }[] = [];
    const nativeSubmitted: typeof submitted = [];
    await page.route(`${origin}/api/**`, async (route) => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const answer = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/api/profile") return answer({ profile: "foundry-iq", activated: true, blockers: [] });
      if (path === "/api/foundry/me") return answer({ identity: { tenantId: testConfig.tenantId, objectId: testOids.A },
        workspaceId: testConfig.workspaceId, workspaceName: "OFFLINE synthetic UI", projectEndpoint: testConfig.projectEndpoint,
        modelDeployment: "offline", vendorProcessingApproved: false, roster: testConfig.roster });
      if (path === "/api/resources") return answer(revoked || denyCollectionReadback ? [] :
        [resource, { ...resource, id: folderId, kind: "folder", name: "Synthetic folder", parent_id: null }, ...collectionResources()]);
      if (path === `/api/resources/${documentId}`) return answer(revoked ? { error: "Current access unavailable" } : resource, revoked ? 409 : 200);
      if (path.startsWith("/api/resources/")) {
        const row = collectionResources().find((item) => path === `/api/resources/${item.id}`);
        return row && !revoked && !denyCollectionReadback ? answer(row) : answer({ error: "Current access unavailable" }, 409);
      }
      if (path === "/api/foundry/status") return answer({ ownerOnlyPending: [] });
      if (path === "/api/foundry/connections") return revoked ? answer({ error: "Current source access unavailable" }, 403) : answer({
        knowledgeBaseName: "OFFLINE selected KB", selectedDataApproved: true, googleAvailable: true, googleBlocker: null, richDocumentsAvailable: false,
        connections,
        selection: googleSelection ? [{ id: "offline_google", name: "OFFLINE selected Google doc", mimeType: "application/vnd.google-apps.document" }] : null,
      });
      if (path === "/api/foundry/imports/local" || path === "/api/foundry/imports/google") {
        importRequests.push({ path, body: request.postDataBuffer()?.toString() ?? "" });
        const google = path.endsWith("/google"), loose = importRequests.at(-1)!.body.includes("Local files/");
        const connection: ImportConnection = { id: randomUUID(), rootId: randomUUID(), provider: google ? "google" : "local",
          label: google ? "Synthetic Google collection" : loose ? "Local files" : "Synthetic selected folder",
          items: Array.from({ length: loose && !receiptFailure ? 2 : 1 }, () => ({ id: randomUUID(), state: "pending", parse: "ready", revision: 1 })) };
        connections.push(connection);
        if (google) googleSelection = false;
        return answer({ connectionId: connection.id, results: [
          ...connection.items.map((item) => ({ key: item.id, id: item.id, state: "pending" })),
          ...(receiptFailure ? [{ key: "failed", state: "failed", error: "Synthetic rejected item" }] : []),
        ] }, 202);
      }
      if (path.startsWith("/api/foundry/origins/")) return answer(null);
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
    await page.getByRole("heading", { name: "Connect your data. Ask Foundry IQ." }).waitFor();
    assert(await page.getByText("OFFLINE selected KB", { exact: true }).isVisible());
    assert(await page.getByRole("button", { name: "Connect local files", exact: true }).isEnabled());
    assert(await page.getByRole("button", { name: "Connect Google Drive", exact: true }).isEnabled());
    assert(await page.getByRole("button", { name: "Ask a source-cited question" }).isDisabled());
    await mkdir(resolve(selectionDirectory, "Operations"), { recursive: true });
    await writeFile(resolve(selectionDirectory, "Operations", "policy.md"), "# Synthetic policy");
    await writeFile(resolve(selectionDirectory, ".env"), "SYNTHETIC_NOT_A_SECRET=example");
    await writeFile(resolve(selectionDirectory, "image.png"), "not an image");
    await page.getByLabel("Choose local folder", { exact: true }).setInputFiles(selectionDirectory);
    const policy = page.getByLabel(/Operations\/policy\.md/);
    assert.equal(await policy.isChecked(), false, "Folder selection never automatically selects content for upload");
    assert(await page.getByLabel(/\/\.env/).isDisabled());
    assert(await page.getByLabel(/\/image\.png/).isDisabled());
    await policy.check();
    assert(await page.getByRole("button", { name: "Ingest selected local files into Foundry IQ" }).isDisabled());
    await page.getByLabel(/I authorize processing this selection/).check();
    await page.getByRole("button", { name: "Ingest selected local files into Foundry IQ" }).click();
    await page.getByRole("heading", { name: "Import receipts—not retrieval readiness" }).waitFor();
    assert.equal(importRequests.length, 1);
    assert(importRequests[0].body.includes("Operations/policy.md"));
    assert(!importRequests[0].body.includes("SYNTHETIC_NOT_A_SECRET"));
    assert.equal(submitted.length, 0, "Import never automatically submits a retrieval");
    assert(await page.getByRole("button", { name: "Ask a source-cited question" }).isDisabled());
    assert.equal(await page.getByText("policy.md · revision 1", { exact: false }).count(), 0);
    assert.equal(await page.getByRole("region", { name: "3D library", exact: true }).count(), 0, "202 never opens 3D");
    const openConnect = () => page.locator("aside").first().getByRole("button", { name: "Connect data", exact: true }).click();
    const assert3D = async (name: string, absent?: string) => {
      const spatial = page.getByRole("region", { name: "3D library", exact: true });
      await spatial.waitFor();
      await spatial.locator("canvas").waitFor();
      assert(await spatial.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width > 0 && canvas.height > 0 &&
        !!canvas.getContext("webgl2")), "The actual Three.js renderer, not a placeholder, created its WebGL canvas");
      const items = spatial.getByRole("list", { name: "Library items", exact: true });
      await items.getByRole("button", { name: `Document: ${name}`, exact: true }).waitFor({ state: "attached" });
      assert.equal(await items.getByRole("button", { name: `Document: ${resource.name}`, exact: true }).count(), 0, "Unrelated originals stay outside the imported collection");
      if (absent) assert.equal(await items.getByRole("button", { name: `Document: ${absent}`, exact: true }).count(), 0);
    };
    verify(connections[0], 0, "policy.md");
    await assert3D("policy.md");
    await openConnect();
    const chooseLoose = async () => {
      await page.getByLabel("Choose local files", { exact: true }).setInputFiles([
        { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Synthetic notes") },
        { name: "pending.md", mimeType: "text/markdown", buffer: Buffer.from("# Synthetic pending") },
      ]);
      assert.equal(await page.getByLabel(/Local files\/notes\.md/).isChecked(), false);
      await page.getByLabel(/Local files\/notes\.md/).check();
      await page.getByLabel(/Local files\/pending\.md/).check();
      await page.getByLabel(/I authorize processing this selection/).check();
      await page.getByRole("button", { name: "Ingest selected local files into Foundry IQ" }).click();
      await page.getByRole("heading", { name: "Import receipts—not retrieval readiness" }).waitFor();
    };
    await chooseLoose();
    assert(importRequests[1].body.includes('Local files/notes.md') && importRequests[1].body.includes('Local files/pending.md'));
    verify(connections[1], 0, "notes.md");
    await page.getByText("1 / 2 files verified in Foundry IQ", { exact: false }).waitFor();
    assert.equal(await page.getByRole("region", { name: "3D library", exact: true }).count(), 0, "Partial indexing does not auto-navigate");
    connections[1].items[1].state = "failed";
    const looseCollection = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Local files · Local files", exact: true }) });
    await looseCollection.getByText("1 / 2 files verified in Foundry IQ · 1 failed", { exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "3D library", exact: true }).count(), 0, "Native failure does not auto-navigate");
    await looseCollection.getByRole("button", { name: "View verified files in 3D" }).click();
    await assert3D("notes.md", "pending.md");
    await openConnect();
    receiptFailure = true;
    await chooseLoose();
    verify(connections[2], 0, "notes.md");
    await page.getByText("Some selected files failed.", { exact: false }).waitFor();
    await page.getByText("notes.md · revision 1", { exact: false }).nth(1).waitFor();
    assert.equal(await page.getByRole("region", { name: "3D library", exact: true }).count(), 0, "A failed receipt prevents auto-open even when every accepted item verifies");
    receiptFailure = false;
    googleSelection = true;
    await page.reload();
    await page.getByRole("heading", { name: "Review Google selection" }).waitFor();
    assert(await page.getByRole("button", { name: "Ingest selected Google files into Foundry IQ" }).isDisabled());
    await page.getByLabel(/I authorize processing this selection/).check();
    await page.getByRole("button", { name: "Ingest selected Google files into Foundry IQ" }).click();
    await page.getByRole("heading", { name: "Import receipts—not retrieval readiness" }).waitFor();
    assert.deepEqual(JSON.parse(importRequests[3].body), { confirm: true });
    assert.equal(submitted.length, 0);
    denyCollectionReadback = true;
    verify(connections[3], 0, "Google policy.txt");
    await page.getByRole("alert").filter({ hasText: "The imported collection is not currently authorized and verified" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "3D library", exact: true }).count(), 0, "Current resource readback is required before 3D handoff");
    denyCollectionReadback = false;
    const googleCollection = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Synthetic Google collection · Google Drive", exact: true }) });
    await googleCollection.getByRole("button", { name: "View verified files in 3D" }).click();
    await assert3D("Google policy.txt");
    await openConnect();
    googleSelection = true;
    await page.reload();
    await page.getByRole("heading", { name: "Review Google selection" }).waitFor();
    await page.getByLabel(/I authorize processing this selection/).check();
    await page.getByRole("button", { name: "Ingest selected Google files into Foundry IQ" }).click();
    await page.getByRole("heading", { name: "Import receipts—not retrieval readiness" }).waitFor();
    verify(connections[4], 0, "Google confirmed.txt");
    await assert3D("Google confirmed.txt");
    assert.equal(submitted.length, 0, "Neither connector adds an automatic retrieval/model call for the 3D handoff");
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
    await page.getByRole("button", { name: "Connect data", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Current source access unavailable" }).waitFor();
    assert.equal(await page.getByText("policy.md · revision 1", { exact: false }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Connected snapshots" }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await runtime.close();
    await rm(selectionDirectory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.FOUNDRY_CONFIG_FILE; else process.env.FOUNDRY_CONFIG_FILE = previous;
  }
});
