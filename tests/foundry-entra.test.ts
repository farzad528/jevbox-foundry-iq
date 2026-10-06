import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createDecipheriv, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { describe, test, type TestContext } from "node:test";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import {
  ConfidentialClientApplication,
  TokenCacheContext,
  type AccountInfo,
  type AuthenticationResult,
  type AuthorizationCodeRequest,
  type AuthorizationUrlRequest,
  type Configuration,
  type SilentFlowRequest,
} from "@azure/msal-node";
import express, { type Request } from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createEntraAuth,
  type EntraAuthConfig,
  type EntraAuthDependencies,
  type EntraMsalClient,
  type EntraStore,
} from "../server/foundry/entra-auth";
import { delegatedHeader } from "../server/foundry/credentials";

// Entirely synthetic identities, local signing keys, in-memory PostgreSQL, and loopback HTTP.
// These tests exercise validation logic; they are NOT real Entra consent/sign-in/verification.
const tenantId = "11111111-1111-4111-8111-111111111111";
const users = {
  A: "22222222-2222-4222-8222-222222222222",
  B: "33333333-3333-4333-8333-333333333333",
};
const otherTenant = "44444444-4444-4444-8444-444444444444";
const otherOid = "55555555-5555-4555-8555-555555555555";
const clientId = "66666666-6666-4666-8666-666666666666";
const authority = `https://login.microsoftonline.com/${tenantId}`;
const clientSecret = "offline-client-secret-not-valid";
const encryptionKey = "a1".repeat(32);
const searchScope = "https://search.azure.com/.default";
const keys = await generateKeyPair("RS256");
const wrongKeys = await generateKeyPair("RS256");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const request = (session?: string, extra: Record<string, string> = {}) =>
  ({
    headers: { ...extra, ...(session ? { cookie: session } : {}) },
  }) as Request;

function account(user: keyof typeof users): AccountInfo {
  return {
    tenantId,
    localAccountId: users[user],
    homeAccountId: `${users[user]}.${tenantId}`,
    environment: "login.windows.net",
    username: `ignored-${user}@example.invalid`,
  };
}
async function idToken(
  user: keyof typeof users,
  nonce: string,
  overrides: Record<string, unknown> = {},
  wrongKey = false,
) {
  return new SignJWT({
    tid: tenantId,
    oid: users[user],
    sub: users[user],
    nonce,
    iss: `${authority}/v2.0`,
    aud: clientId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "offline-key" })
    .sign(wrongKey ? wrongKeys.privateKey : keys.privateKey);
}
async function accessToken(
  user: keyof typeof users,
  overrides: Record<string, unknown> = {},
) {
  return new SignJWT({
    tid: tenantId,
    oid: users[user],
    scp: "user_impersonation",
    ver: "1.0",
    iss: `https://sts.windows.net/${tenantId}/`,
    aud: "https://search.azure.com",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "offline-key" })
    .sign(keys.privateKey);
}
function authResult(
  user: keyof typeof users,
  id: string,
  access: string,
): AuthenticationResult {
  return {
    authority,
    uniqueId: users[user],
    tenantId,
    scopes: ["user_impersonation"],
    account: account(user),
    idToken: id,
    idTokenClaims: {},
    accessToken: access,
    fromCache: false,
    expiresOn: new Date(Date.now() + 3600_000),
    tokenType: "Bearer",
    correlationId: "offline-correlation",
  };
}

class OfflineMsal {
  configurations: Configuration[] = [];
  urls: AuthorizationUrlRequest[] = [];
  codes: AuthorizationCodeRequest[] = [];
  silent: SilentFlowRequest[] = [];
  cacheReads: string[][] = [];
  idOverrides: Record<string, unknown> = {};
  accessOverrides: Record<string, unknown> = {};
  wrongSignature = false;
  wrongAccount = false;
  mixedCache = false;
  failure?: "url" | "code" | "silent" | "accounts";
  onSilent?: (input: SilentFlowRequest) => Promise<void>;
  urlOverride?: string;
  private counter = 0;
  readonly create = (configuration: Configuration): EntraMsalClient => {
    this.configurations.push(configuration);
    const plugin = configuration.cache!.cachePlugin!;
    let state: {
      accounts: AccountInfo[];
      idToken?: string;
      accessToken?: string;
      refreshToken?: string;
    } = { accounts: [] };
    const tokenCache = {
      serialize: () => JSON.stringify(state),
      deserialize: (serialized: string) => {
        state = JSON.parse(serialized);
      },
    };
    const withCache = async <T>(
      changed: boolean,
      fn: () => Promise<T>,
    ): Promise<T> => {
      const context = new TokenCacheContext(tokenCache, false);
      await plugin.beforeCacheAccess(context);
      const result = await fn();
      context.hasChanged = changed;
      await plugin.afterCacheAccess(context);
      return result;
    };
    const fail = (method: typeof this.failure) => {
      if (this.failure === method)
        throw new Error(
          `UPSTREAM SECRET ${clientSecret} offline-refresh-token private-auth-code`,
        );
    };
    return {
      getAuthCodeUrl: async (input) => {
        this.urls.push(input);
        fail("url");
        if (this.urlOverride) return this.urlOverride;
        const url = new URL(`${authority}/oauth2/v2.0/authorize`);
        for (const [key, value] of Object.entries({
          client_id: clientId,
          response_type: "code",
          response_mode: "query",
          redirect_uri: input.redirectUri,
          state: input.state,
          nonce: input.nonce,
          code_challenge: input.codeChallenge,
          code_challenge_method: input.codeChallengeMethod,
          scope: input.scopes.join(" "),
        }))
          url.searchParams.set(key, String(value));
        return url.href;
      },
      acquireTokenByCode: async (input) => {
        this.codes.push(input);
        fail("code");
        return withCache(true, async () => {
          const user = input.code.endsWith("B") ? "B" : "A";
          const id = await idToken(
            user,
            input.nonce!,
            this.idOverrides,
            this.wrongSignature,
          );
          const access = await accessToken(user);
          const result = authResult(user, id, access);
          if (this.wrongAccount)
            result.account = account(user === "A" ? "B" : "A");
          state = {
            accounts: this.mixedCache
              ? [account("A"), account("B")]
              : [result.account!],
            idToken: id,
            accessToken: access,
            refreshToken: `offline-refresh-token-${user}`,
          };
          return result;
        });
      },
      acquireTokenSilent: async (input) => {
        this.silent.push(input);
        fail("silent");
        return withCache(true, async () => {
          await this.onSilent?.(input);
          const user = input.account.localAccountId === users.A ? "A" : "B";
          assert.equal(state.accounts.length, 1);
          assert.equal(
            state.accounts[0].localAccountId,
            input.account.localAccountId,
          );
          assert.ok(
            state.refreshToken?.startsWith(`offline-refresh-token-${user}`),
          );
          const access = await accessToken(user, this.accessOverrides);
          state.accessToken = access;
          state.refreshToken = `offline-refresh-token-${user}-${++this.counter}`;
          const result = authResult(user, state.idToken!, access);
          if (this.wrongAccount)
            result.account = account(user === "A" ? "B" : "A");
          return result;
        });
      },
      getTokenCache: () => ({
        getAllAccounts: () =>
          withCache(false, async () => {
            fail("accounts");
            this.cacheReads.push(
              state.accounts.map((value) => value.localAccountId),
            );
            return state.accounts;
          }),
      }),
    };
  };
}

type StoredRequest = {
  id: string;
  browser_hash: string;
  encrypted_request: string;
  created_at: number;
  expires_at: number;
};
type StoredSession = {
  id: string;
  tenant_id: string;
  object_id: string;
  encrypted_cache: string;
  created_at: number;
  expires_at: number;
};
function decrypt(value: string, binding: string) {
  const [, iv, tag, content] = value.split(".");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(encryptionKey, "hex"),
    Buffer.from(iv, "base64url"),
  );
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  cipher.setAAD(Buffer.from(binding));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(content, "base64url")),
      cipher.final(),
    ]).toString("utf8"),
  );
}
function sessionBinding(row: StoredSession) {
  return `session:${clientId}:${tenantId}:${row.id}:${row.tenant_id}:${row.object_id}:${Number(row.created_at)}:${Number(row.expires_at)}`;
}
function cookieHeader(response: Response, name: string) {
  const value = response.headers
    .getSetCookie()
    .find((item) => item.startsWith(`${name}=`));
  assert.ok(value, `Expected ${name} cookie`);
  return value.split(";")[0];
}
function assertStatus(status: number) {
  return (error: unknown) => {
    assert.equal((error as { status?: number }).status, status);
    assert.doesNotMatch(
      String(error),
      /UPSTREAM SECRET|private-auth-code|offline-refresh-token|offline-client-secret/,
    );
    return true;
  };
}
function assertRosterRequired(error: unknown) {
  assertStatus(401)(error);
  assert.match(
    (error as Error).message,
    /Native ACL synchronization remains pending/,
  );
  assert.match(
    (error as Error).message,
    /activate Entra consent and sign in both approved roster users/,
  );
  return true;
}

async function harness(
  t: TestContext,
  input: {
    consent?: boolean;
    dependencies?: EntraAuthDependencies;
    secure?: boolean;
  } = {},
) {
  const db = new PGlite();
  await db.exec(
    await readFile(
      new URL("../server/migrations/027-entra-sessions.sql", import.meta.url),
      "utf8",
    ),
  );
  const active = new AsyncLocalStorage<Transaction>();
  const calls: { sql: string; values: unknown[] }[] = [];
  let transactions = 0;
  const parameterize = (sql: string) => {
    assert.doesNotMatch(
      sql,
      /\$\d+/,
      "Auth SQL uses the parent adapter's ? placeholders",
    );
    let sequence = 0;
    return sql.replace(/'[^']*'|\?/g, (match) =>
      match === "?" ? `$${++sequence}` : match,
    );
  };
  const store: EntraStore = {
    async one<T>(sql: string, ...values: unknown[]) {
      calls.push({ sql, values });
      return (
        await (active.getStore() ?? db).query<T>(parameterize(sql), values)
      ).rows[0];
    },
    async run(sql: string, ...values: unknown[]) {
      calls.push({ sql, values });
      return {
        changes:
          (await (active.getStore() ?? db).query(parameterize(sql), values))
            .affectedRows ?? 0,
      };
    },
    async transaction<T>(fn: () => Promise<T>) {
      transactions++;
      return db.transaction((tx) => active.run(tx, fn));
    },
  };
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config: EntraAuthConfig = {
    tenantId,
    roster: Object.values(users),
    clientId,
    clientSecret,
    encryptionKey,
    redirectUri: `${origin}/api/entra/callback`,
    cookieSecure: input.secure ?? false,
    consentActivated: input.consent ?? true,
  };
  const mock = new OfflineMsal();
  const dependencies: EntraAuthDependencies = input.dependencies ?? {
    createMsalClient: mock.create,
    jwks: async () => keys.publicKey,
    fetch: async () => {
      throw new Error("No external transport permitted by this offline test");
    },
  };
  const auth = createEntraAuth(config, store, dependencies);
  app.use("/api/entra", auth.router);
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
  });
  const fetchRoute = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}/api/entra${path}`, { ...init, redirect: "manual" });
  const start = async () => {
    const response = await fetchRoute("/login");
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get("location")!);
    return {
      response,
      url,
      state: url.searchParams.get("state")!,
      cookie: cookieHeader(response, "fiq_entra_state"),
    };
  };
  const finish = async (
    pending: Awaited<ReturnType<typeof start>>,
    code = "offline-code-A",
    previous?: string,
  ) =>
    fetchRoute(`/callback?state=${pending.state}&code=${code}`, {
      headers: {
        cookie: [pending.cookie, previous].filter(Boolean).join("; "),
      },
    });
  const signIn = async (user: "A" | "B" = "A", previous?: string) => {
    const pending = await start();
    const response = await finish(pending, `offline-code-${user}`, previous);
    assert.equal(response.status, 303);
    return {
      pending,
      response,
      cookie: cookieHeader(response, "fiq_entra_session"),
    };
  };
  return {
    db,
    store,
    mock,
    config,
    auth,
    origin,
    calls,
    transactions: () => transactions,
    fetchRoute,
    start,
    finish,
    signIn,
  };
}

describe("OFFLINE synthetic Entra auth-code/PKCE; no real Entra verification", () => {
  test("consent-off rejects before client, transport, JWKS, SQL, or refresh operations", async (t) => {
    const h = await harness(t, { consent: false });
    for (const path of [
      "/login",
      "/callback?state=anything&code=private-auth-code",
      "/session",
    ]) {
      const response = await h.fetchRoute(path);
      assert.equal(response.status, 403);
      assert.match(await response.text(), /consent is not activated/);
    }
    await assert.rejects(h.auth.authenticate(request()), assertStatus(403));
    await assert.rejects(h.auth.credential(request()), assertStatus(403));
    await assert.rejects(
      h.auth.identityForSession("a".repeat(64)),
      assertStatus(403),
    );
    await assert.rejects(
      h.auth.credentialForSession("a".repeat(64)),
      assertStatus(403),
    );
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    assert.equal(h.calls.length, 0);
    assert.equal(h.transactions(), 0);
    assert.equal(h.mock.configurations.length, 0);
    h.config.consentActivated = true;
    const logged = await h.signIn();
    const before = h.calls.length;
    const clients = h.mock.configurations.length;
    h.config.consentActivated = false;
    await assert.rejects(
      h.auth.credential(request(logged.cookie)),
      assertStatus(403),
    );
    const sessionId = hash(logged.cookie.split("=")[1]);
    await assert.rejects(
      h.auth.identityForSession(sessionId),
      assertStatus(403),
    );
    await assert.rejects(
      h.auth.credentialForSession(sessionId),
      assertStatus(403),
    );
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    assert.equal(h.calls.length, before);
    assert.equal(h.mock.configurations.length, clients);
    assert.equal(h.mock.silent.length, 0);
  });

  test("PKCE S256, independent state/nonce, five-minute encrypted request and secure cookie policy", async (t) => {
    const h = await harness(t, { secure: true });
    const pending = await h.start();
    assert.equal(pending.url.origin, "https://login.microsoftonline.com");
    assert.equal(pending.url.pathname, `/${tenantId}/oauth2/v2.0/authorize`);
    assert.equal(
      pending.url.searchParams.get("redirect_uri"),
      h.config.redirectUri,
    );
    assert.match(pending.state, /^[\w-]{43}$/);
    const nonce = pending.url.searchParams.get("nonce")!;
    assert.notEqual(nonce, pending.state);
    assert.notEqual(pending.cookie.split("=")[1], pending.state);
    assert.equal(pending.url.searchParams.get("response_mode"), "query");
    assert.equal(pending.url.searchParams.get("code_challenge_method"), "S256");
    assert.deepEqual(
      new Set(pending.url.searchParams.get("scope")!.split(" ")),
      new Set([searchScope, "openid", "profile", "offline_access"]),
    );
    const setCookie = pending.response.headers.getSetCookie().join("\n");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Path=\/api\/entra/);
    assert.equal(pending.response.headers.get("cache-control"), "no-store");
    const row = (
      await h.db.query<StoredRequest>("SELECT * FROM fiq_entra_requests")
    ).rows[0];
    assert.equal(row.id, hash(pending.state));
    assert.equal(row.browser_hash, hash(pending.cookie.split("=")[1]));
    assert.equal(Number(row.expires_at) - Number(row.created_at), 300_000);
    assert.doesNotMatch(row.encrypted_request, new RegExp(nonce));
    const plaintext = decrypt(
      row.encrypted_request,
      `request:${clientId}:${tenantId}:${row.id}:${row.browser_hash}:${Number(row.created_at)}:${Number(row.expires_at)}`,
    );
    assert.equal(plaintext.nonce, nonce);
    assert.match(plaintext.verifier, /^[\w-]{43}$/);
    assert.equal(
      createHash("sha256").update(plaintext.verifier).digest("base64url"),
      pending.url.searchParams.get("code_challenge"),
    );
    assert.equal(h.mock.configurations[0].auth.authority, authority);
    assert.equal(h.mock.configurations[0].auth.clientSecret, clientSecret);
    assert.equal(h.mock.configurations[0].system?.disableInternalRetries, true);
  });

  test("callback consumes state atomically; exchanged verifier and nonce match; sessions rotate", async (t) => {
    const h = await harness(t);
    const pending = await h.start();
    const first = await h.finish(pending);
    assert.equal(first.status, 303);
    assert.equal(first.headers.get("location"), `${h.origin}/`);
    const sessionCookie = cookieHeader(first, "fiq_entra_session");
    assert.match(
      first.headers.getSetCookie().join("\n"),
      /fiq_entra_state=;.*Expires=/,
    );
    assert.match(
      first.headers.getSetCookie().join("\n"),
      /fiq_entra_session=.*HttpOnly/,
    );
    assert.equal(h.mock.codes[0].nonce, pending.url.searchParams.get("nonce"));
    assert.equal(h.mock.codes[0].state, pending.state);
    assert.equal(h.mock.codes[0].redirectUri, h.config.redirectUri);
    assert.equal(
      createHash("sha256")
        .update(h.mock.codes[0].codeVerifier!)
        .digest("base64url"),
      pending.url.searchParams.get("code_challenge"),
    );
    assert.equal(
      (await h.db.query("SELECT * FROM fiq_entra_requests")).rows.length,
      0,
    );
    const replay = await h.finish(pending);
    assert.equal(replay.status, 401);
    assert.equal(h.mock.codes.length, 1);
    const session = await h.auth.authenticate(request(sessionCookie));
    assert.deepEqual(session.identity, { tenantId, objectId: users.A });
    assert.equal(session.sessionId, hash(sessionCookie.split("=")[1]));
    assert.notEqual(session.sessionId, sessionCookie.split("=")[1]);
    const rotated = await h.signIn("B", sessionCookie);
    await assert.rejects(
      h.auth.authenticate(request(sessionCookie)),
      assertStatus(401),
    );
    assert.equal(
      (await h.auth.authenticate(request(rotated.cookie))).identity.objectId,
      users.B,
    );
    assert.equal(
      (await h.db.query("SELECT * FROM fiq_entra_sessions")).rows.length,
      1,
    );
  });

  test("two concurrent callbacks for a state exchange at most one auth code", async (t) => {
    const h = await harness(t);
    const pending = await h.start();
    const results = await Promise.all([h.finish(pending), h.finish(pending)]);
    assert.deepEqual(results.map((result) => result.status).sort(), [303, 401]);
    assert.equal(h.mock.codes.length, 1);
    assert.equal(
      (await h.db.query("SELECT * FROM fiq_entra_sessions")).rows.length,
      1,
    );
  });

  test("wrong/missing/duplicated state cookie, expired state, and denial do not exchange a code", async (t) => {
    const h = await harness(t);
    const pending = await h.start();
    for (const header of [
      undefined,
      "fiq_entra_state=" + "x".repeat(43),
      `${pending.cookie}; ${pending.cookie}`,
    ]) {
      const response = await h.fetchRoute(
        `/callback?state=${pending.state}&code=private-auth-code`,
        { headers: header ? { cookie: header } : {} },
      );
      assert.equal(response.status, 401);
    }
    const duplicateState = await h.fetchRoute(
      `/callback?state=${pending.state}&state=${pending.state}&code=x`,
      { headers: { cookie: pending.cookie } },
    );
    assert.equal(duplicateState.status, 401);
    const expiredAt = Date.now();
    await h.db.query(
      "UPDATE fiq_entra_requests SET created_at = $1, expires_at = $2",
      [expiredAt - 600_000, expiredAt - 300_000],
    );
    assert.equal((await h.finish(pending)).status, 401);
    const denied = await h.start();
    const response = await h.fetchRoute(
      `/callback?state=${denied.state}&error=access_denied&error_description=private-auth-code`,
      { headers: { cookie: denied.cookie } },
    );
    assert.equal(response.status, 401);
    assert.doesNotMatch(
      await response.text(),
      /private-auth-code|access_denied/,
    );
    assert.equal(
      (await h.db.query("SELECT * FROM fiq_entra_requests")).rows.length,
      0,
    );
    assert.equal(h.mock.codes.length, 0);
  });

  test("ID signature, issuer, audience, nonce, tenant and roster OID are verified (never email)", async (t) => {
    const h = await harness(t);
    const cases: {
      claims?: Record<string, unknown>;
      wrongSignature?: boolean;
      account?: boolean;
      status: number;
    }[] = [
      { claims: { nonce: "wrong-nonce" }, status: 401 },
      {
        claims: {
          iss: `https://login.microsoftonline.com/${otherTenant}/v2.0`,
        },
        status: 401,
      },
      { claims: { aud: otherOid }, status: 401 },
      { claims: { exp: 1 }, status: 401 },
      { claims: { tid: otherTenant }, status: 403 },
      {
        claims: { oid: otherOid, email: "approved@example.invalid" },
        status: 403,
      },
      { wrongSignature: true, status: 401 },
      { account: true, status: 401 },
    ];
    for (const scenario of cases) {
      h.mock.idOverrides = scenario.claims ?? {};
      h.mock.wrongSignature = scenario.wrongSignature ?? false;
      h.mock.wrongAccount = scenario.account ?? false;
      const pending = await h.start();
      const response = await h.finish(pending);
      assert.equal(response.status, scenario.status);
      assert.equal(
        response.headers
          .getSetCookie()
          .some((value) => value.startsWith("fiq_entra_session=")),
        false,
      );
      assert.equal(
        (await h.db.query("SELECT * FROM fiq_entra_sessions")).rows.length,
        0,
      );
    }
  });

  test("cache and verifier are encrypted; SQL, session API and errors never carry tokens", async (t) => {
    const h = await harness(t);
    const signedIn = await h.signIn();
    const row = (
      await h.db.query<StoredSession>("SELECT * FROM fiq_entra_sessions")
    ).rows[0];
    assert.match(row.id, /^[a-f0-9]{64}$/);
    assert.match(row.encrypted_cache, /^v1\./);
    assert.equal(Number(row.expires_at) - Number(row.created_at), 8 * 3600_000);
    const plaintext = decrypt(row.encrypted_cache, sessionBinding(row));
    const cached = JSON.parse(plaintext.cache);
    assert.equal(plaintext.homeAccountId, account("A").homeAccountId);
    assert.ok(cached.idToken);
    assert.ok(cached.accessToken);
    assert.equal(cached.refreshToken, "offline-refresh-token-A");
    const sqlValues = JSON.stringify(h.calls);
    for (const secret of [
      clientSecret,
      cached.idToken,
      cached.accessToken,
      cached.refreshToken,
      h.mock.codes[0].codeVerifier,
      signedIn.cookie.split("=")[1],
    ]) {
      assert.ok(
        secret && !sqlValues.includes(secret),
        "SQL contains only hashes or authenticated ciphertext",
      );
    }
    const response = await h.fetchRoute("/session", {
      headers: { cookie: signedIn.cookie },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      identity: { tenantId, objectId: users.A },
      sessionId: row.id,
    });
    const credential = await h.auth.credential(request(signedIn.cookie));
    assert.equal(credential.identity.objectId, users.A);
    assert.throws(() => JSON.stringify(credential), /never be serialized/);
    assert.ok(delegatedHeader(credential));
    assert.deepEqual(h.mock.silent[0].scopes, [searchScope]);
    assert.equal(h.mock.silent[0].authority, authority);
    assert.ok(h.calls.some((call) => /FOR UPDATE/.test(call.sql)));
  });

  test("missing/expired/wrong-tenant/wrong-OID sessions cannot fall back to Authorization or legacy cookies", async (t) => {
    const h = await harness(t);
    for (const header of [
      "legacy_session=anything",
      "fiq_entra_session=bad",
      `fiq_entra_session=${"x".repeat(43)}; fiq_entra_session=${"x".repeat(43)}`,
    ]) {
      await assert.rejects(
        h.auth.authenticate(request(header)),
        assertStatus(401),
      );
    }
    await assert.rejects(
      h.auth.credential(
        request(undefined, {
          authorization: `Bearer ${await accessToken("A")}`,
        }),
      ),
      assertStatus(401),
    );
    const signedIn = await h.signIn();
    await h.db.query("UPDATE fiq_entra_sessions SET tenant_id = $1", [
      otherTenant,
    ]);
    await assert.rejects(
      h.auth.authenticate(request(signedIn.cookie)),
      assertStatus(403),
    );
    await h.db.query(
      "UPDATE fiq_entra_sessions SET tenant_id = $1, object_id = $2",
      [tenantId, otherOid],
    );
    await assert.rejects(
      h.auth.credential(request(signedIn.cookie)),
      assertStatus(403),
    );
    await h.db.query(
      "UPDATE fiq_entra_sessions SET object_id = $1, created_at = $2, expires_at = $3",
      [users.A, Date.now() - 600_000, Date.now() - 300_000],
    );
    await assert.rejects(
      h.auth.authenticate(request(signedIn.cookie)),
      assertStatus(401),
    );
    await assert.rejects(
      h.auth.credential(request(signedIn.cookie)),
      assertStatus(401),
    );
    assert.equal(h.mock.silent.length, 0);
  });

  test("delegated Search tokens must bind signature, issuer/audience/scope/expiry and exact session identity", async (t) => {
    const h = await harness(t);
    const signedIn = await h.signIn();
    for (const overrides of [
      { tid: otherTenant },
      { oid: users.B },
      { scp: "User.Read" },
      { scp: "" },
      { aud: clientId },
      { iss: `https://sts.windows.net/${otherTenant}/` },
      { exp: Math.floor(Date.now() / 1000) + 10 },
      { exp: 1 },
      { ver: "unsupported" },
      { scp: undefined, roles: ["user_impersonation"] },
    ]) {
      h.mock.accessOverrides = overrides;
      await assert.rejects(
        h.auth.credential(request(signedIn.cookie)),
        assertStatus(401),
      );
    }
    h.mock.accessOverrides = { ver: "2.0", iss: `${authority}/v2.0` };
    assert.equal(
      (await h.auth.credential(request(signedIn.cookie))).identity.objectId,
      users.A,
    );
    h.mock.accessOverrides = {};
    assert.equal(
      (await h.auth.credential(request(signedIn.cookie))).identity.objectId,
      users.A,
    );
    h.mock.wrongAccount = true;
    await assert.rejects(
      h.auth.credential(request(signedIn.cookie)),
      assertStatus(401),
    );
  });

  test("fresh clients and cache plugins isolate users and serialize concurrent same-session refreshes", async (t) => {
    const h = await harness(t);
    const a = await h.signIn("A");
    const b = await h.signIn("B");
    const results = await Promise.all([
      h.auth.credential(request(a.cookie)),
      h.auth.credential(request(b.cookie)),
      h.auth.credential(request(a.cookie)),
    ]);
    assert.deepEqual(
      results.map((value) => value.identity.objectId),
      [users.A, users.B, users.A],
    );
    assert.equal(h.mock.configurations.length, 7);
    assert.equal(
      new Set(
        h.mock.configurations.map(
          (configuration) => configuration.cache!.cachePlugin,
        ),
      ).size,
      7,
    );
    assert.ok(h.mock.cacheReads.every((ids) => ids.length === 1));
    const rows = (
      await h.db.query<StoredSession>("SELECT * FROM fiq_entra_sessions")
    ).rows;
    for (const row of rows) {
      const cache = JSON.parse(
        decrypt(row.encrypted_cache, sessionBinding(row)).cache,
      );
      assert.equal(cache.accounts.length, 1);
      assert.equal(cache.accounts[0].localAccountId, row.object_id);
      assert.ok(
        cache.refreshToken.startsWith(
          row.object_id === users.A
            ? "offline-refresh-token-A"
            : "offline-refresh-token-B",
        ),
      );
    }
    h.mock.mixedCache = true;
    const mixed = await h.start();
    assert.equal((await h.finish(mixed)).status, 401);
  });

  test("durable worker jobs carry only non-bearer IDs and reload isolated encrypted session caches", async (t) => {
    const h = await harness(t);
    const a = await h.signIn("A");
    const b = await h.signIn("B");
    const jobs = await Promise.all(
      [a, b].map(async (signedIn) => ({
        sessionId: (await h.auth.authenticate(request(signedIn.cookie)))
          .sessionId,
      })),
    );
    const serializedJobs = JSON.stringify(jobs);
    for (const signedIn of [a, b])
      assert.ok(!serializedJobs.includes(signedIn.cookie.split("=")[1]));
    assert.ok(jobs.every((job) => /^[a-f0-9]{64}$/.test(job.sessionId)));
    assert.doesNotMatch(serializedJobs, /token|cookie|cache/i);
    // A separate auth service models a worker restart: no Request, browser cookie or user cache is shared.
    const worker = createEntraAuth(h.config, h.store, {
      createMsalClient: h.mock.create,
      jwks: async () => keys.publicKey,
    });
    const before = h.calls.length;
    assert.deepEqual(await worker.identityForSession(jobs[0].sessionId), {
      tenantId,
      objectId: users.A,
    });
    assert.deepEqual(await worker.identityForSession(jobs[1].sessionId), {
      tenantId,
      objectId: users.B,
    });
    assert.equal(h.calls.length - before, 2);
    const credentials = await Promise.all(
      jobs.map((job) => worker.credentialForSession(job.sessionId)),
    );
    assert.deepEqual(
      credentials.map((value) => value.identity.objectId),
      [users.A, users.B],
    );
    assert.ok(credentials.every((value) => value.expiresAt > Date.now()));
    assert.deepEqual(
      h.mock.silent.map((input) => input.scopes),
      [[searchScope], [searchScope]],
    );
    const calls = h.mock.silent.length;
    await h.db.query(
      "UPDATE fiq_entra_sessions SET encrypted_cache = 'v1.invalid.invalid.invalid' WHERE id = $1",
      [jobs[0].sessionId],
    );
    await assert.rejects(
      worker.identityForSession(jobs[0].sessionId),
      assertStatus(401),
    );
    await assert.rejects(
      worker.credentialForSession(jobs[0].sessionId),
      assertStatus(401),
    );
    assert.equal(h.mock.silent.length, calls);
    assert.ok(h.calls.every((call) => !/\$\d+/.test(call.sql)));
  });

  test("worker session APIs reject raw cookies and malformed IDs before SQL and fail closed after revocation", async (t) => {
    const h = await harness(t);
    const logged = await h.signIn();
    const { sessionId } = await h.auth.authenticate(request(logged.cookie));
    const before = h.calls.length;
    const transactions = h.transactions();
    for (const value of [
      logged.cookie,
      logged.cookie.split("=")[1],
      users.A,
      "A".repeat(64),
      "",
      undefined,
      null,
      123,
    ]) {
      await assert.rejects(
        h.auth.identityForSession(value as string),
        assertStatus(401),
      );
      await assert.rejects(
        h.auth.credentialForSession(value as string),
        assertStatus(401),
      );
    }
    assert.equal(h.calls.length, before);
    assert.equal(h.transactions(), transactions);
    assert.equal(h.mock.silent.length, 0);
    await assert.rejects(
      h.auth.identityForSession("f".repeat(64)),
      assertStatus(401),
    );
    await assert.rejects(
      h.auth.credentialForSession("f".repeat(64)),
      assertStatus(401),
    );
    await h.auth.credentialForSession(sessionId);
    const response = await h.fetchRoute("/logout", {
      method: "POST",
      headers: { cookie: logged.cookie, origin: h.origin },
    });
    assert.equal(response.status, 204);
    const refreshes = h.mock.silent.length;
    await assert.rejects(
      h.auth.identityForSession(sessionId),
      assertStatus(401),
    );
    await assert.rejects(
      h.auth.credentialForSession(sessionId),
      assertStatus(401),
    );
    assert.equal(h.mock.silent.length, refreshes);
  });

  test("worker session APIs recheck expiry, tenant and roster instead of substituting project/service identities", async (t) => {
    const h = await harness(t);
    const logged = await h.signIn();
    const { sessionId } = await h.auth.authenticate(request(logged.cookie));
    assert.deepEqual(await h.auth.identityForSession(sessionId), {
      tenantId,
      objectId: users.A,
    });
    const restarted = createEntraAuth(
      {
        ...h.config,
        roster: [users.B, otherOid],
      },
      h.store,
      { createMsalClient: h.mock.create, jwks: async () => keys.publicKey },
    );
    await assert.rejects(
      restarted.identityForSession(sessionId),
      assertStatus(403),
    );
    await assert.rejects(
      restarted.credentialForSession(sessionId),
      assertStatus(403),
    );
    for (const change of [
      { tenant: otherTenant, oid: users.A },
      { tenant: tenantId, oid: otherOid },
    ]) {
      await h.db.query(
        "UPDATE fiq_entra_sessions SET tenant_id = $1, object_id = $2 WHERE id = $3",
        [change.tenant, change.oid, sessionId],
      );
      await assert.rejects(
        h.auth.identityForSession(sessionId),
        assertStatus(403),
      );
      await assert.rejects(
        h.auth.credentialForSession(sessionId),
        assertStatus(403),
      );
    }
    const expiredAt = Date.now();
    await h.db.query(
      "UPDATE fiq_entra_sessions SET tenant_id = $1, object_id = $2, created_at = $3, expires_at = $4 WHERE id = $5",
      [tenantId, users.A, expiredAt - 600_000, expiredAt - 300_000, sessionId],
    );
    await assert.rejects(
      h.auth.identityForSession(sessionId),
      assertStatus(401),
    );
    await assert.rejects(
      h.auth.credentialForSession(sessionId),
      assertStatus(401),
    );
    assert.equal(h.mock.silent.length, 0);
  });

  test("ACL finalization obtains two distinct roster credentials from the latest unexpired sessions only", async (t) => {
    const h = await harness(t);
    const oldA = await h.signIn("A");
    const b = await h.signIn("B");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const latestA = await h.signIn("A");
    const latestAId = hash(latestA.cookie.split("=")[1]);
    const oldAId = hash(oldA.cookie.split("=")[1]);
    const bId = hash(b.cookie.split("=")[1]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const now = Date.now();
    await h.db.query(
      "INSERT INTO fiq_entra_sessions VALUES($1,$2,$3,'v1.synthetic-expired',$4,$5)",
      ["e".repeat(64), tenantId, users.A, now - 2, now - 1],
    );
    const before = h.calls.length;
    const credentials = await h.auth.credentialsForRoster();
    assert.equal(credentials.length, 2);
    assert.deepEqual(
      credentials.map((value) => value.identity),
      [
        { tenantId, objectId: users.A },
        { tenantId, objectId: users.B },
      ],
    );
    assert.ok(
      credentials.every((value) => value.expiresAt > Date.now() + 30_000),
    );
    assert.throws(() => JSON.stringify(credentials), /never be serialized/);
    const locked = h.calls
      .slice(before)
      .filter((call) => /FOR UPDATE/.test(call.sql));
    assert.deepEqual(
      locked.map((call) => call.values[0]),
      [latestAId, bId],
    );
    assert.ok(locked.every((call) => call.values[0] !== oldAId));
    assert.deepEqual(
      h.mock.silent.map((input) => input.account.localAccountId),
      [users.A, users.B],
    );
    assert.ok(
      h.mock.silent.every(
        (input) =>
          input.authority === authority &&
          input.scopes.length === 1 &&
          input.scopes[0] === searchScope,
      ),
    );
    const reversed = createEntraAuth(
      {
        ...h.config,
        roster: [users.B, users.A],
      },
      h.store,
      { createMsalClient: h.mock.create, jwks: async () => keys.publicKey },
    );
    assert.deepEqual(
      (await reversed.credentialsForRoster()).map(
        (value) => value.identity.objectId,
      ),
      [users.B, users.A],
    );
  });

  test("ACL finalization stays pending with an actionable 401 when either roster user is absent, expired or revoked", async (t) => {
    const h = await harness(t);
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    await h.signIn("A");
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    assert.equal(
      h.mock.silent.length,
      0,
      "The allowed actor alone is not sufficient",
    );
    const b = await h.signIn("B");
    const bId = hash(b.cookie.split("=")[1]);
    const expiredAt = Date.now();
    await h.db.query(
      "UPDATE fiq_entra_sessions SET created_at = $1, expires_at = $2 WHERE id = $3",
      [expiredAt - 600_000, expiredAt - 300_000, bId],
    );
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    assert.equal(h.mock.silent.length, 0);
    await h.signIn("B");
    assert.equal((await h.auth.credentialsForRoster()).length, 2);
    await h.db.query("DELETE FROM fiq_entra_sessions WHERE object_id = $1", [
      users.A,
    ]);
    const calls = h.mock.silent.length;
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    assert.equal(h.mock.silent.length, calls);
  });

  test("ACL finalization rejects invalid credentials or a corrupt latest cache without actor/older-session fallback", async (t) => {
    const h = await harness(t);
    await h.signIn("A");
    await h.signIn("B");
    h.mock.accessOverrides = { oid: users.A };
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    assert.deepEqual(
      h.mock.silent.map((input) => input.account.localAccountId),
      [users.A, users.B],
    );
    h.mock.accessOverrides = {};
    h.mock.failure = "silent";
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    h.mock.failure = undefined;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const latestB = await h.signIn("B");
    await h.db.query(
      "UPDATE fiq_entra_sessions SET encrypted_cache = 'v1.invalid.invalid.invalid' WHERE id = $1",
      [hash(latestB.cookie.split("=")[1])],
    );
    const calls = h.mock.silent.length;
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    assert.equal(
      h.mock.silent.length,
      calls + 1,
      "Only A could refresh; the result must still fail",
    );
    const failedStore: EntraStore = {
      ...h.store,
      one: async () => {
        throw new Error(`Database leaked ${clientSecret}`);
      },
    };
    await assert.rejects(
      createEntraAuth(h.config, failedStore).credentialsForRoster(),
      assertStatus(503),
    );
  });

  test("ACL finalization rechecks first-user revocation after the second delegated credential refresh", async (t) => {
    const h = await harness(t);
    const a = await h.signIn("A");
    await h.signIn("B");
    const aId = hash(a.cookie.split("=")[1]);
    h.mock.onSilent = async (input) => {
      if (input.account.localAccountId === users.B)
        await h.store.run("DELETE FROM fiq_entra_sessions WHERE id = ?", aId);
    };
    await assert.rejects(h.auth.credentialsForRoster(), assertRosterRequired);
    assert.deepEqual(
      h.mock.silent.map((input) => input.account.localAccountId),
      [users.A, users.B],
    );
    await assert.rejects(h.auth.identityForSession(aId), assertStatus(401));
  });

  test("GCM binding rejects tampering, ciphertext swaps, identity changes and lifetime extension", async (t) => {
    const h = await harness(t);
    const a = await h.signIn("A");
    await h.signIn("B");
    const rows = (
      await h.db.query<StoredSession>(
        "SELECT * FROM fiq_entra_sessions ORDER BY object_id",
      )
    ).rows;
    await h.db.query(
      "UPDATE fiq_entra_sessions SET encrypted_cache = $1 WHERE id = $2",
      [rows[1].encrypted_cache, rows[0].id],
    );
    await assert.rejects(
      h.auth.authenticate(request(a.cookie)),
      assertStatus(401),
    );
    await h.db.query(
      "UPDATE fiq_entra_sessions SET encrypted_cache = $1, object_id = $2 WHERE id = $3",
      [rows[0].encrypted_cache, users.B, rows[0].id],
    );
    await assert.rejects(
      h.auth.credential(request(a.cookie)),
      assertStatus(401),
    );
    await h.db.query(
      "UPDATE fiq_entra_sessions SET object_id = $1, created_at = created_at + 1, expires_at = expires_at + 1 WHERE id = $2",
      [users.A, rows[0].id],
    );
    await assert.rejects(
      h.auth.authenticate(request(a.cookie)),
      assertStatus(401),
    );
    const pending = await h.start();
    await h.db.query(
      "UPDATE fiq_entra_requests SET encrypted_request = 'v1.invalid.invalid.invalid'",
    );
    assert.equal((await h.finish(pending)).status, 401);
    assert.equal(h.mock.silent.length, 0);
  });

  test("backend origin and callback configuration are exact; redirects cannot escape tenant/backend", async (t) => {
    const h = await harness(t);
    for (const redirectUri of [
      "https://example.invalid/api/entra/callback",
      `${h.origin}/api/entra/callback?returnTo=https://example.invalid`,
      `${h.origin}/api/entra/callback#fragment`,
      `${h.origin}/not-the-callback`,
    ]) {
      assert.throws(
        () => createEntraAuth({ ...h.config, redirectUri }, h.store),
        /exact localhost/,
      );
    }
    assert.throws(
      () =>
        createEntraAuth({ ...h.config, roster: [users.A, users.A] }, h.store),
      /Invalid Entra/,
    );
    assert.throws(
      () =>
        createEntraAuth(
          { ...h.config, jwksUri: "https://example.invalid/keys" },
          h.store,
        ),
      /tenant JWKS/,
    );
    const status = await new Promise<number>((resolve, reject) => {
      const probe = httpRequest(
        `${h.origin}/api/entra/login`,
        { headers: { host: "example.invalid" } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      probe.on("error", reject);
      probe.end();
    });
    assert.equal(status, 403);
    assert.equal(h.mock.configurations.length, 0);
    h.mock.urlOverride = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`;
    assert.equal((await h.fetchRoute("/login")).status, 401);
    assert.equal(h.calls.length, 0);
  });

  test("vendor/storage/JWKS failures are explicit and sanitized, not swallowed or forwarded", async (t) => {
    const h = await harness(t);
    h.mock.failure = "url";
    const urlError = await h.fetchRoute("/login");
    assert.equal(urlError.status, 401);
    assert.doesNotMatch(
      await urlError.text(),
      /UPSTREAM|SECRET|offline-refresh-token|private-auth-code/,
    );
    h.mock.failure = undefined;
    const pending = await h.start();
    h.mock.failure = "code";
    const codeError = await h.finish(pending);
    assert.equal(codeError.status, 401);
    assert.doesNotMatch(
      await codeError.text(),
      /UPSTREAM|SECRET|private-auth-code/,
    );
    h.mock.failure = undefined;
    const signedIn = await h.signIn();
    h.mock.failure = "silent";
    await assert.rejects(
      h.auth.credential(request(signedIn.cookie)),
      assertStatus(401),
    );
    const failedStore = {
      ...h.store,
      one: async () => {
        throw new Error(`Database leaked ${clientSecret}`);
      },
    };
    const auth = createEntraAuth(h.config, failedStore);
    await assert.rejects(
      auth.authenticate(request(signedIn.cookie)),
      assertStatus(503),
    );
    h.mock.failure = undefined;
    const badKeys = createEntraAuth(h.config, h.store, {
      createMsalClient: h.mock.create,
      jwks: async () => {
        throw new Error(`JWKS leaked ${clientSecret}`);
      },
    });
    await assert.rejects(
      badKeys.credential(request(signedIn.cookie)),
      assertStatus(401),
    );
  });

  test("logout is backend-origin protected, deletes session, and clears cookies", async (t) => {
    const h = await harness(t);
    const signedIn = await h.signIn();
    const denied = await h.fetchRoute("/logout", {
      method: "POST",
      headers: { cookie: signedIn.cookie, origin: "https://example.invalid" },
    });
    assert.equal(denied.status, 403);
    const response = await h.fetchRoute("/logout", {
      method: "POST",
      headers: { cookie: signedIn.cookie, origin: h.origin },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.getSetCookie().length, 2);
    await assert.rejects(
      h.auth.authenticate(request(signedIn.cookie)),
      assertStatus(401),
    );
  });

  test("additive migration enforces hashed IDs and maximum request/session lifetime", async (t) => {
    const h = await harness(t);
    const now = Date.now();
    for (const [id, expires] of [
      ["bearer-token", now + 300_000],
      ["a".repeat(64), now + 300_001],
    ]) {
      await assert.rejects(
        h.db.query(
          "INSERT INTO fiq_entra_requests VALUES($1,$2,'v1.fake',$3,$4)",
          [id, "b".repeat(64), now, expires],
        ),
      );
    }
    await assert.rejects(
      h.db.query(
        "INSERT INTO fiq_entra_sessions VALUES($1,$2,$3,'v1.fake',$4,$5)",
        ["a".repeat(64), tenantId, users.A, now, now + 8 * 3600_000 + 1],
      ),
    );
  });

  test("real MSAL 7 API runs auth code and silent acquisition with offline fetch + local JWKS", async (t) => {
    let nonce = "";
    let postedCodeVerifier = "";
    let refreshes = 0;
    let msalErrorCode = "";
    const networkCalls: { url: string; method: string }[] = [];
    const publicKey = {
      ...(await exportJWK(keys.publicKey)),
      kid: "offline-key",
      alg: "RS256",
      use: "sig",
    };
    const offlineFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const endpoint = new URL(url);
      networkCalls.push({ url, method: init?.method ?? "GET" });
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      assert.equal(endpoint.origin, "https://login.microsoftonline.com");
      if (
        endpoint.pathname ===
        `/${tenantId}/v2.0/.well-known/openid-configuration`
      ) {
        return Response.json({
          issuer: `${authority}/v2.0`,
          authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
          token_endpoint: `${authority}/oauth2/v2.0/token`,
          end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
          jwks_uri: `${authority}/discovery/v2.0/keys`,
        });
      }
      if (endpoint.pathname === `/${tenantId}/discovery/v2.0/keys`)
        return Response.json({ keys: [publicKey] });
      if (endpoint.pathname === `/${tenantId}/oauth2/v2.0/token`) {
        assert.equal(init?.method, "POST");
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("client_id"), clientId);
        assert.equal(body.get("client_secret"), clientSecret);
        assert.doesNotMatch(body.get("scope") ?? "", /graph|User\.Read/i);
        if (body.get("grant_type") === "authorization_code") {
          const user = body.get("code")!.endsWith("B") ? "B" : "A";
          postedCodeVerifier = body.get("code_verifier")!;
          return Response.json({
            token_type: "Bearer",
            scope: "https://search.azure.com/user_impersonation openid profile",
            expires_in: 120,
            access_token: await accessToken(user),
            id_token: await idToken(user, nonce),
            refresh_token: `offline-real-msal-refresh-${user}`,
            client_info: Buffer.from(
              JSON.stringify({ uid: users[user], utid: tenantId }),
            ).toString("base64url"),
          });
        }
        assert.equal(body.get("grant_type"), "refresh_token");
        const user = body.get("refresh_token")!.endsWith("B") ? "B" : "A";
        assert.equal(
          body.get("refresh_token"),
          `offline-real-msal-refresh-${user}`,
        );
        refreshes++;
        return Response.json({
          token_type: "Bearer",
          scope: "https://search.azure.com/user_impersonation openid profile",
          expires_in: 3600,
          access_token: await accessToken(user),
          refresh_token: `offline-real-msal-refresh-${user}`,
          client_info: Buffer.from(
            JSON.stringify({ uid: users[user], utid: tenantId }),
          ).toString("base64url"),
        });
      }
      throw new Error(
        "Unexpected external endpoint blocked in offline transport",
      );
    };
    const h = await harness(t, {
      dependencies: {
        fetch: offlineFetch,
        createMsalClient: (configuration) => {
          const client = new ConfidentialClientApplication(configuration);
          return {
            getAuthCodeUrl: (input) => client.getAuthCodeUrl(input),
            acquireTokenByCode: async (input) => {
              try {
                return await client.acquireTokenByCode(input);
              } catch (error) {
                msalErrorCode = String(
                  (error as { errorCode?: string }).errorCode ??
                    "non-msal-error",
                );
                throw error;
              }
            },
            acquireTokenSilent: (input) => client.acquireTokenSilent(input),
            getTokenCache: () => client.getTokenCache(),
          };
        },
      },
    });
    const pending = await h.start();
    nonce = pending.url.searchParams.get("nonce")!;
    const response = await h.finish(pending);
    assert.equal(
      response.status,
      303,
      `${await response.text()} ${msalErrorCode} ${JSON.stringify(networkCalls)}`,
    );
    assert.equal(
      createHash("sha256").update(postedCodeVerifier).digest("base64url"),
      pending.url.searchParams.get("code_challenge"),
    );
    const session = cookieHeader(response, "fiq_entra_session");
    const credential = await h.auth.credential(request(session));
    assert.deepEqual(credential.identity, { tenantId, objectId: users.A });
    assert.equal(refreshes, 1);
    const pendingB = await h.start();
    nonce = pendingB.url.searchParams.get("nonce")!;
    const responseB = await h.finish(pendingB, "offline-code-B");
    assert.equal(responseB.status, 303);
    const sessionB = cookieHeader(responseB, "fiq_entra_session");
    const isolated = await Promise.all([
      h.auth.credential(request(session)),
      h.auth.credential(request(sessionB)),
    ]);
    assert.deepEqual(
      isolated.map((value) => value.identity.objectId),
      [users.A, users.B],
    );
    assert.ok(
      networkCalls.some((call) => call.url.endsWith("/discovery/v2.0/keys")),
    );
    assert.ok(
      networkCalls.every((call) => call.url.startsWith(`${authority}/`)),
    );
    h.config.consentActivated = false;
    const before = networkCalls.length;
    await assert.rejects(
      h.auth.credential(request(session)),
      assertStatus(403),
    );
    assert.equal(networkCalls.length, before);
  });
});
