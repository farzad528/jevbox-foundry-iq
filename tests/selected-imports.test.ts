import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoogleDrive } from "../server/foundry/google-drive";
import { relativeImportPath, verifiedImportItems, type ImportConnection } from "../shared/selected-imports";
import { foundryDrive, type FoundryDriveResource } from "../src/lib/foundry-drive";
import { layoutSpatialTree } from "../src/lib/spatial-tree";

const scope = "https://www.googleapis.com/auth/drive.file";
function fixture() {
  const calls: { url: string; method: string; headers: Headers; body?: string }[] = [];
  let clock = 1_000_000;
  let version = "7";
  let downloading = false;
  let denied = false;
  let changed = false;
  let tokenScope = scope;
  let media: Uint8Array<ArrayBuffer> | string = "Synthetic source text";
  const fetcher: typeof fetch = async (url, options) => {
    const target = new URL(String(url));
    calls.push({ url: target.href, method: options?.method ?? "GET", headers: new Headers(options?.headers), body: options?.body?.toString() });
    assert.equal(options?.redirect, "error");
    assert(options?.signal);
    if (target.href === "https://oauth2.googleapis.com/token") {
      assert.equal(options?.method, "POST");
      return Response.json({ access_token: "synthetic-google-only", token_type: "Bearer", expires_in: 3600, scope: tokenScope });
    }
    assert.equal(target.origin, "https://www.googleapis.com", "No unimplemented external traffic allowed");
    assert.equal(target.pathname.replace("/export", ""), "/drive/v3/files/synthetic_doc");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer synthetic-google-only");
    if (target.pathname.endsWith("/export")) {
      downloading = true;
      if (denied) return Response.json({ error: "PRIVATE PROVIDER DETAILS" }, { status: 403 });
      assert.equal(target.searchParams.get("mimeType"), "text/plain");
      return new Response(media);
    }
    if (changed && downloading) version = "8";
    return Response.json({ id: "synthetic_doc", name: "Synthetic policy", mimeType: "application/vnd.google-apps.document",
      version, capabilities: { canDownload: true }, trashed: false });
  };
  const google = createGoogleDrive({ origin: "http://localhost:4387", clientId: "synthetic-client",
    clientSecret: "synthetic-not-a-credential", fetcher, now: () => clock });
  const select = async (session = "session-a") => {
    const url = new URL(google.start(session));
    await google.callback(session, { state: url.searchParams.get("state"), code: "synthetic-code", picked_file_ids: "synthetic_doc" });
    return url;
  };
  return { google, calls, select, advance: () => { clock += 600_001; }, deny: () => { denied = true; },
    changeDuringDownload: () => { changed = true; }, broadScope: () => { tokenScope += " https://www.googleapis.com/auth/drive"; },
    tooLarge: () => { media = new Uint8Array(8 * 1024 * 1024 + 1); } };
}
test("selected local paths reject traversal, hidden/credential paths and absolute paths", () => {
  for (const path of ["C:\\Users\\file.txt", "C:/Users/file.txt", "/tmp/file.txt", "root/../file.txt", "root/.env", "root/.git/config", "root/a\\b.md", "root//file.txt"])
    assert.equal(relativeImportPath.safeParse(path).success, false, path);
  assert.equal(relativeImportPath.safeParse("Cedar/Operations/policy.md").success, true);
  assert.equal(relativeImportPath.safeParse("Local files/notes.md").success, true);
});
test("3D readiness needs native verification and an authorized title, not parse readiness", () => {
  const connection: ImportConnection = { id: "connection", rootId: "root", provider: "local", label: "Local files", items: [
    { id: "ready", name: "notes.md", state: "verified", parse: "ready", revision: 1 },
    { id: "pending", state: "pending", parse: "ready", revision: 1 },
    { id: "failed", state: "failed", parse: "ready", revision: 1 },
    { id: "acl-pending", state: "verified", parse: "ready", revision: 1 },
  ] };
  assert.deepEqual(verifiedImportItems(connection).map((item) => item.id), ["ready"]);
});
const driveRow = (id: string, parent_id: string | null, kind: "folder" | "document"): FoundryDriveResource => ({
  id, parent_id, kind, name: "Same display name", owner_id: "owner", pinned: false, description: "", access: "restricted",
  status: "ready", mime: "text/plain", size: 1, pages: 0, created: "2026-10-01", canWrite: true, canShare: true,
  syncState: "verified", knowledge_parse_state: "ready", knowledge_filing_state: "ready",
});
test("native IDs adapt to nested Finder/3D paths without mixing collections or losing mutation identities", () => {
  const rows = [driveRow("doc", "nested", "document"), driveRow("nested", "root", "folder"),
    driveRow("root", null, "folder"), driveRow("other", null, "folder"), driveRow("outside", "other", "document")];
  const drive = foundryDrive(rows);
  assert.equal(drive.paths.get("doc"), "root/nested/doc");
  assert.equal(drive.paths.get("nested"), "root/nested/");
  assert.equal(drive.byPath.get("root/nested/")?.id, "nested");
  assert.equal(drive.byPath.get("root/nested/doc")?.id, "doc");
  const file = drive.items.find((item) => item.kind === "file" && item.key === "doc");
  assert(file?.kind === "file");
  assert.equal(file.key, "doc");
  assert.equal(file.parentPath, "root/nested/");
  assert.deepEqual(layoutSpatialTree(drive.items, "root/").map((node) => node.path), ["root/", "root/nested/", "root/nested/doc"]);
});
test("incomplete or cyclic authorized hierarchies fail explicitly instead of drawing misleading 3D collections", () => {
  assert.throws(() => foundryDrive([driveRow("doc", "missing", "document")]), /fully authorized/);
  assert.throws(() => foundryDrive([driveRow("a", "b", "folder"), driveRow("b", "a", "folder")]), /cycle/);
});
test("OFFLINE Google redirect picker uses exact per-file scope, PKCE and session-bound single-use selection", async () => {
  const f = fixture();
  const url = new URL(f.google.start("session-a"));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), scope);
  assert.equal(url.searchParams.get("access_type"), "online");
  assert.equal(url.searchParams.get("trigger_onepick"), "true");
  assert.equal(url.searchParams.get("allow_folder_selection"), "false");
  assert.equal(url.searchParams.get("include_granted_scopes"), "false");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:4387/api/foundry/google/callback");
  await assert.rejects(() => f.google.callback("session-b", {
    state: url.searchParams.get("state"), code: "synthetic-code", picked_file_ids: "synthetic_doc",
  }), /another session/);
  assert.equal(f.calls.length, 0);
  const next = await f.select();
  await assert.rejects(() => f.google.callback("session-a", {
    state: next.searchParams.get("state"), code: "synthetic-code", picked_file_ids: "synthetic_doc",
  }), /expired|another session/);
  const count = f.calls.length;
  assert(!JSON.stringify(f.google.selected("session-a")).includes("synthetic-google-only"));
  assert.equal(f.google.selected("session-b"), null);
  // A replay invalidates the pending selection rather than making another token request.
  assert.equal(f.calls.length, count);
});
test("OFFLINE Google imports only selected file, exports honest text locators, checks versions and forgets token", async () => {
  const f = fixture();
  await f.select();
  assert.equal(f.calls.length, 2, "Callback exchanges authorization and reads selected metadata, never content");
  const imported = await f.google.consume("session-a", async (files, connection, download) => {
    assert.equal(connection, undefined);
    assert.equal(files.length, 1);
    return download(files[0]);
  });
  assert.equal(imported.body.toString(), "Synthetic source text");
  assert.equal(imported.name, "Synthetic policy.txt");
  assert.equal(imported.origin.version, "7");
  assert.match(imported.origin.representation, /no original page geometry/);
  assert.equal(imported.origin.url, "https://drive.google.com/file/d/synthetic_doc/view");
  assert(f.calls.every((call) => !call.url.includes("synthetic-google-only")));
  assert(f.calls.every((call) => !new URL(call.url).searchParams.has("q")));
  assert.equal(f.google.selected("session-a"), null);
  await assert.rejects(() => f.google.consume("session-a", async () => null), /Select Google files again/);
});
test("OFFLINE Google refuses expiry, broadened scopes, changed sources, denied downloads and oversized streams", async (t) => {
  await t.test("expiry touches no provider", async () => {
    const f = fixture();
    const url = new URL(f.google.start("session-a")); f.advance();
    await assert.rejects(() => f.google.callback("session-a", {
      state: url.searchParams.get("state"), code: "synthetic", picked_file_ids: "synthetic_doc",
    }), /expired/);
    assert.equal(f.calls.length, 0);
  });
  await t.test("broader token is not accepted", async () => {
    const f = fixture(); f.broadScope();
    await assert.rejects(() => f.select(), /exact selected-file/);
    assert.equal(f.calls.length, 1);
  });
  await t.test("download changes are not imported", async () => {
    const f = fixture(); await f.select(); f.changeDuringDownload();
    await assert.rejects(() => f.google.consume("session-a", async (files, _id, download) => download(files[0])), /changed during download/);
  });
  await t.test("denials are sanitized and do not become successes", async () => {
    const f = fixture(); await f.select(); f.deny();
    await assert.rejects(() => f.google.consume("session-a", async (files, _id, download) => download(files[0])),
      (error: Error) => /unavailable/.test(error.message) && !error.message.includes("PRIVATE"));
    assert.equal(f.google.selected("session-a"), null);
  });
  await t.test("stream limit enforced without Content-Length", async () => {
    const f = fixture(); await f.select(); f.tooLarge();
    await assert.rejects(() => f.google.consume("session-a", async (files, _id, download) => download(files[0])), /size limit/);
  });
});
test("local launcher selects only loopback Foundry mode, refuses incompatible origins and does not execute on import", async () => {
  const { launchEnvironment } = await import("../scripts/launch-foundry.ts");
  const env = launchEnvironment({ JEVBOX_PROFILE: "legacy", HOST: "0.0.0.0" }, "24.19.0");
  assert.equal(env.JEVBOX_PROFILE, "foundry-iq");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.APP_ORIGIN, "http://localhost:4387");
  assert.throws(() => launchEnvironment({}, "24.5.0"), /24.6/);
  assert.throws(() => launchEnvironment({ APP_ORIGIN: "https://example.invalid" }), /requires APP_ORIGIN/);
  assert.throws(() => launchEnvironment({ PORT: "0" }), /PORT/);
});
