import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { createSpikeAuth } from "../server/foundry/spike-auth";
import type { EntraAuthConfig } from "../server/foundry/entra-auth";

// Module instrumentation runs in bounded child processes; no files or external transports are used.
const execute = promisify(execFile);
const spikeUrl = new URL("../server/foundry/spike-auth.ts", import.meta.url)
  .href;
const entraUrl = new URL("../server/foundry/entra-auth.ts", import.meta.url)
  .href;
async function instrument(script: string) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--import=tsx",
      "--experimental-test-module-mocks",
      "--no-warnings",
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
     import { mock } from "node:test";
     const spikeUrl = ${JSON.stringify(spikeUrl)};
     const entraUrl = ${JSON.stringify(entraUrl)};
     ${script}`,
    ],
    { timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true },
  );
  return JSON.parse(stdout);
}

const config: EntraAuthConfig = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  roster: [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ],
  clientId: "44444444-4444-4444-8444-444444444444",
  clientSecret: "offline-spike-client-secret-not-valid",
  redirectUri: "http://127.0.0.1:39871/api/entra/callback",
  encryptionKey: "b2".repeat(32),
  cookieSecure: false,
  consentActivated: true,
};
const approval = () => ({
  signIn: true,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const status = (expected: number) => (error: unknown) => {
  assert.equal((error as { status?: number }).status, expected);
  assert.ok(!String(error).includes(config.clientSecret));
  return true;
};

describe("OFFLINE disposable spike-auth reuse; no real Entra sign-in or verification", () => {
  test("approval refusal precedes config access, database/MSAL construction and transport", async () => {
    const counts = await instrument(String.raw`
      const counts = { database: 0, msal: 0, network: 0, config: 0, logging: 0 };
      for (const method of ["log", "info", "warn", "error"])
        mock.method(console, method, () => { counts.logging++; });
      globalThis.fetch = async () => { counts.network++; throw new Error("No network allowed"); };
      mock.module("@electric-sql/pglite", { namedExports: {
        PGlite: class { constructor() { counts.database++; throw new Error("Unexpected database construction"); } },
      } });
      mock.module("@azure/msal-node", { namedExports: {
        ConfidentialClientApplication: class { constructor() { counts.msal++; throw new Error("Unexpected MSAL construction"); } },
      } });
      const { createSpikeAuth } = await import(spikeUrl);
      const now = Date.now();
      mock.method(Date, "now", () => now);
      const future = new Date(now + 60_000).toISOString();
      const config = new Proxy({}, {
        ownKeys() { counts.config++; return []; },
        get() { counts.config++; return undefined; },
      });
      for (const approval of [
        undefined, null, {}, { signIn: false, expiresAt: future },
        { signIn: "true", expiresAt: future }, { signIn: 1, expiresAt: future },
        { signIn: true }, { signIn: true, expiresAt: 123 },
        { signIn: true, expiresAt: "not-a-date" }, { signIn: true, expiresAt: "" },
        { signIn: true, expiresAt: new Date(now - 1).toISOString() },
        { signIn: true, expiresAt: new Date(now).toISOString() },
        { signIn: true, expiresAt: new Date(now + 7_200_001).toISOString() },
      ]) assert.throws(() => createSpikeAuth(config, approval), /explicit approval.*within two hours/);
      assert.deepEqual(counts, { database: 0, msal: 0, network: 0, config: 0, logging: 0 });
      assert.throws(() => createSpikeAuth({}, { signIn: true, expiresAt: future }), /Invalid Entra/);
      process.stdout.write(JSON.stringify(counts));
    `);
    assert.deepEqual(counts, {
      database: 0,
      msal: 0,
      network: 0,
      config: 0,
      logging: 0,
    });
  });

  test("question-mark SQL is lexically bound and concurrent/nested transactions are ALS-pinned", async () => {
    const result = await instrument(String.raw`
      const counts = { constructed: 0, closed: 0, transactions: 0, network: 0, logging: 0 };
      let store, authConfig;
      let failSchema = false;
      let failClose = false;
      const marker = {};
      const queries = [];
      const migrations = [];
      for (const method of ["log", "info", "warn", "error"])
        mock.method(console, method, () => { counts.logging++; });
      globalThis.fetch = async () => { counts.network++; throw new Error("No network allowed"); };
      mock.module(entraUrl, { namedExports: {
        createEntraAuth(config, suppliedStore) { authConfig = config; store = suppliedStore; return marker; },
      } });
      mock.module("@electric-sql/pglite", { namedExports: {
        PGlite: class {
          constructor(...args) { assert.equal(args.length, 0); counts.constructed++; }
          async exec(sql) {
            migrations.push(sql);
            if (failSchema) throw new Error("Synthetic private storage failure");
          }
          async query(sql, values) {
            queries.push({ owner: "root", sql, values });
            return { rows: [{ owner: "root" }], affectedRows: 2 };
          }
          async transaction(fn) {
            const owner = "tx-" + ++counts.transactions;
            return fn({ query: async (sql, values) => {
              queries.push({ owner, sql, values });
              return { rows: [{ owner }], affectedRows: 2 };
            } });
          }
          async close() {
            counts.closed++;
            if (failClose) throw new Error("Synthetic private close failure");
          }
        },
      } });
      const { createSpikeAuth } = await import(spikeUrl);
      const now = Date.now();
      mock.method(Date, "now", () => now);
      const config = Object.freeze({ consentActivated: true });
      const spike = createSpikeAuth(config, {
        signIn: true, expiresAt: new Date(now + 7_200_000).toISOString(),
      });
      assert.equal(spike.auth, marker);
      assert.equal(counts.constructed, 0);
      const sql = "SELECT ? AS a, '?' AS b, 'can''t ?' AS c, \"a\"\"?\" AS d, E'it\\'s ?' AS e, $$?$$ AS f, $tag$?$tag$ AS g,\r\n-- ?\r\n/* ? /* ? */ ? */ ? AS h";
      await store.one(sql, "first", "second");
      assert.equal(queries[0].sql, sql.replace("? AS a", "$1 AS a").replace("? AS h", "$2 AS h"));
      assert.deepEqual(queries[0].values, ["first", "second"]);
      assert.equal(counts.constructed, 1);
      assert.equal(migrations.length, 1);
      assert.deepEqual([...migrations[0].matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]),
        ["fiq_entra_requests", "fiq_entra_sessions"]);
      const operators = "SELECT doc ?| array['?'], doc ?& array['?'], doc @? '$.a ? (@ > 1)', ?";
      await store.one(operators, "value");
      assert.equal(queries.at(-1).sql, operators.slice(0, -1) + "$1");
      await store.one("SELECT foo$1, $δ$?$δ$, ?", "value");
      assert.equal(queries.at(-1).sql, "SELECT foo$1, $δ$?$δ$, $1");
      assert.deepEqual(await store.run("UPDATE example SET value = ?", "value"), { changes: 2 });
      const before = queries.length;
      for (const sql of ["SELECT 'unterminated", 'SELECT "unterminated', "SELECT $$unterminated",
        "SELECT $tag$unterminated", "SELECT /* unterminated", "SELECT $1", "SELECT ?"])
        await assert.rejects(store.one(sql), /Invalid spike authentication SQL parameters/);
      await assert.rejects(store.one("SELECT '?'", "unused"), /Invalid spike authentication SQL parameters/);
      assert.equal(queries.length, before);

      let entered, release;
      const started = new Promise((resolve) => { entered = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const first = store.transaction(async () => {
        const outer = await store.one("SELECT ?", "A");
        entered();
        await gate;
        const inner = await store.transaction(() => store.one("SELECT ?", "A nested"));
        assert.equal(inner.owner, outer.owner);
        return outer.owner;
      });
      await started;
      const second = await store.transaction(async () => {
        const outer = await store.one("SELECT ?", "B");
        const inner = await store.transaction(() => store.one("SELECT ?", "B nested"));
        assert.equal(inner.owner, outer.owner);
        return outer.owner;
      });
      release();
      assert.notEqual(await first, second);
      assert.equal(counts.transactions, 2);

      let enteredClose, releaseClose;
      const closingStarted = new Promise((resolve) => { enteredClose = resolve; });
      const closeGate = new Promise((resolve) => { releaseClose = resolve; });
      const held = store.transaction(async () => {
        await store.one("SELECT ?", "held");
        enteredClose();
        await closeGate;
      });
      await closingStarted;
      const closed = spike.close();
      assert.equal(spike.close(), closed);
      assert.equal(authConfig.consentActivated, false);
      assert.equal(config.consentActivated, true);
      assert.equal(counts.closed, 0);
      await assert.rejects(store.one("SELECT ?", "late"), /store is closed/);
      releaseClose();
      await held;
      await closed;
      assert.equal(counts.closed, 1);
      await assert.rejects(store.transaction(async () => {}), /store is closed/);
      assert.equal(counts.constructed, 1);

      const unused = createSpikeAuth({ consentActivated: true }, {
        signIn: true, expiresAt: new Date(now + 60_000).toISOString(),
      });
      await unused.close();
      assert.equal(counts.constructed, 1);
      failSchema = true;
      const failed = createSpikeAuth({ consentActivated: true }, {
        signIn: true, expiresAt: new Date(now + 60_000).toISOString(),
      });
      await assert.rejects(store.one("SELECT ?", "value"));
      await failed.close();
      assert.equal(counts.constructed, 2);
      assert.equal(counts.closed, 2);
      failSchema = false;
      failClose = true;
      const failedClose = createSpikeAuth({ consentActivated: true }, {
        signIn: true, expiresAt: new Date(now + 60_000).toISOString(),
      });
      await store.one("SELECT ?", "value");
      const failure = failedClose.close();
      assert.equal(failedClose.close(), failure);
      await assert.rejects(failure, (error) => {
        assert.equal(error.message, "Spike authentication store could not be discarded");
        return true;
      });
      assert.equal(authConfig.consentActivated, false);
      await assert.rejects(store.one("SELECT ?", "late"), /store is closed/);
      assert.equal(counts.constructed, 3);
      assert.equal(counts.closed, 3);
      assert.equal(counts.network, 0);
      assert.equal(counts.logging, 0);
      process.stdout.write(JSON.stringify(counts));
    `);
    assert.deepEqual(result, {
      constructed: 3,
      closed: 3,
      transactions: 3,
      network: 0,
      logging: 0,
    });
  });

  test("real auth reuses only migration027 in memory, refuses absent users and is disabled safely on close", async (t) => {
    let network = 0;
    t.mock.method(globalThis, "fetch", async () => {
      network++;
      throw new Error("External transport is forbidden by this offline test");
    });
    const spike = createSpikeAuth(config, approval());
    t.after(() => spike.close());
    assert.equal(typeof spike.auth.router, "function");
    await Promise.all([
      assert.rejects(
        spike.auth.identityForSession("a".repeat(64)),
        status(401),
      ),
      assert.rejects(
        spike.auth.credentialForSession("b".repeat(64)),
        status(401),
      ),
    ]);
    await assert.rejects(spike.auth.credentialsForRoster(), status(401));
    const closing = spike.close();
    assert.equal(spike.close(), closing);
    await closing;
    await assert.rejects(
      spike.auth.identityForSession("a".repeat(64)),
      status(403),
    );
    await assert.rejects(
      spike.auth.credentialForSession("b".repeat(64)),
      status(403),
    );
    await assert.rejects(spike.auth.credentialsForRoster(), status(401));
    assert.equal(config.consentActivated, true);
    assert.equal(network, 0);
  });
});
