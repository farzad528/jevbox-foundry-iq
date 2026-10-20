import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { createPersonalApp } from "../server/personal-file/app";

test("real local HTTP: owner cookie, CSRF/host rejection, immutable selection, restart and no Azure access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jevbox-personal-http-"));
  let id = "";
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const host = express(), server = host.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address(); assert(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const runtime = await createPersonalApp({ origin, directory, config: null,
        transport: async () => { assert.fail("Unexpected Azure request"); } });
      host.use(runtime.app);
      runtime.app.get("/", (_req, res) => res.send("Public local workspace entry"));
      try {
        assert.equal((await fetch(`${origin}/api/personal/state`)).status, 401);
        const session = await fetch(`${origin}/api/personal/session`), cookie = session.headers.get("set-cookie")!.split(";")[0];
        const { csrf } = await session.json() as { csrf: string };
        const incomingNavigation = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", Cookie: cookie };
        const navigationStatus = (url: string) => new Promise<number | undefined>((resolveStatus, reject) => {
          const request = httpRequest(url, { headers: incomingNavigation }, (response) => { response.resume(); resolveStatus(response.statusCode); });
          request.once("error", reject); request.end();
        });
        assert.equal(await navigationStatus(origin), 200);
        assert.equal(await navigationStatus(`${origin}/api/personal/state`), 403);
        assert.equal(await navigationStatus(`${origin}/api/personal/session`), 403);
        const state = await fetch(`${origin}/api/personal/state`, { headers: { Cookie: cookie } });
        assert.equal(state.status, 200);
        if (iteration) {
          assert.equal((await state.json()).snapshot.id, id);
          assert.equal(runtime.store.snapshot()!.documents[0].state, "local");
        } else {
          const select = () => {
            const form = new FormData(); form.append("paths", JSON.stringify(["Test/policy.md"]));
            form.append("files", new Blob(["# Local original"], { type: "text/markdown" }), "policy.md"); return form;
          };
          assert.equal((await fetch(`${origin}/api/personal/select`, { method: "POST", body: select(), headers: { Cookie: cookie, Origin: origin } })).status, 403);
          const saved = await fetch(`${origin}/api/personal/select`, { method: "POST", body: select(), headers: { Cookie: cookie, Origin: origin, "X-Jevbox-CSRF": csrf } });
          assert.equal(saved.status, 201); id = (await saved.json()).id;
          assert.equal((await fetch(`${origin}/api/personal/select`, { method: "POST", body: select(), headers: { Cookie: cookie, Origin: origin, "X-Jevbox-CSRF": csrf } })).status, 409);
          const spoofedHost = await new Promise<number | undefined>((resolveStatus, reject) => {
            const request = httpRequest(`${origin}/api/personal/state`, { headers: { Cookie: cookie, Host: "attacker.invalid" } },
              (response) => { response.resume(); resolveStatus(response.statusCode); });
            request.once("error", reject); request.end();
          });
          assert.equal(spoofedHost, 403);
          const original = await fetch(`${origin}/api/personal/originals/${runtime.store.snapshot()!.documents[0].id}`, { headers: { Cookie: cookie } });
          assert.equal(await original.text(), "# Local original"); assert.match(original.headers.get("content-security-policy")!, /sandbox/);
          assert.equal((await fetch(`${origin}/api/personal/execute/unapproved`, { method: "POST", body: '{"stage":"ingest"}',
            headers: { Cookie: cookie, Origin: origin, "X-Jevbox-CSRF": csrf, "Content-Type": "application/json" } })).status, 409);
        }
        await assert.rejects(createPersonalApp({ origin, directory, config: null }), /already open/);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await runtime.close();
      }
    }
  } finally { rmSync(directory, { recursive: true }); }
});
