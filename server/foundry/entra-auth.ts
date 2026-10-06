import {
  ConfidentialClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type AuthorizationCodeRequest,
  type AuthorizationUrlRequest,
  type Configuration,
  type ICachePlugin,
  type INetworkModule,
  type NetworkRequestOptions,
  type SilentFlowRequest,
} from "@azure/msal-node";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import { userIdentitySchema, type UserIdentity } from "../../shared/evidence";
import { HttpError } from "../errors";
import { DelegatedCredential } from "./credentials";

export interface EntraAuthConfig {
  tenantId: string;
  roster: string[];
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: string;
  cookieSecure: boolean;
  consentActivated: boolean;
  /** Defaults to the selected tenant's public-cloud signing keys; no other origin is allowed. */
  jwksUri?: string;
}

/** The adapter must pin a PostgreSQL connection for transaction() and translate ? parameters. */
export interface EntraStore {
  one<T>(sql: string, ...values: unknown[]): Promise<T | undefined>;
  run(sql: string, ...values: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** Bounded injectable surface, not a token-verification bypass. Each call must return a fresh client. */
export interface EntraMsalClient {
  getAuthCodeUrl(request: AuthorizationUrlRequest): Promise<string>;
  acquireTokenByCode(
    request: AuthorizationCodeRequest,
  ): Promise<AuthenticationResult | null>;
  acquireTokenSilent(
    request: SilentFlowRequest,
  ): Promise<AuthenticationResult | null>;
  getTokenCache(): { getAllAccounts(): Promise<AccountInfo[]> };
}

export interface EntraAuthDependencies {
  createMsalClient?: (configuration: Configuration) => EntraMsalClient;
  /** Offline tests can supply a local signing key; jwtVerify still validates every token. */
  jwks?: JWTVerifyGetKey;
  fetch?: typeof fetch;
}

const requestLifetime = 5 * 60_000;
const sessionLifetime = 8 * 60 * 60_000;
const stateCookie = "fiq_entra_state";
const sessionCookie = "fiq_entra_session";
const opaque = /^[A-Za-z0-9_-]{43}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maxCacheBytes = 1024 * 1024;
const searchScope = "https://search.azure.com/.default";
const searchAudience = "https://search.azure.com";
const configSchema = z.object({
  tenantId: z.uuid().transform((value) => value.toLowerCase()),
  roster: z
    .array(z.uuid().transform((value) => value.toLowerCase()))
    .length(2)
    .refine((values) => new Set(values).size === 2),
  clientId: z.uuid().transform((value) => value.toLowerCase()),
  clientSecret: z.string().min(1).max(4096),
  redirectUri: z.url(),
  encryptionKey: z.string().regex(/^[a-fA-F0-9]{64}$/),
  cookieSecure: z.boolean(),
  consentActivated: z.boolean(),
  jwksUri: z.url().optional(),
});

type RequestRow = {
  id: string;
  browser_hash: string;
  encrypted_request: string;
  created_at: number | string;
  expires_at: number | string;
};
type SessionRow = {
  id: string;
  tenant_id: string;
  object_id: string;
  encrypted_cache: string;
  created_at: number | string;
  expires_at: number | string;
};
const pendingSchema = z.strictObject({
  verifier: z.string().regex(opaque),
  nonce: z.string().regex(opaque),
});
const cacheSchema = z.strictObject({
  homeAccountId: z.string().min(1).max(1024),
  cache: z.string().min(1).max(maxCacheBytes),
});

class EntraError extends HttpError {}
const unauthorized = () =>
  new EntraError(
    401,
    "A current Entra user session is required; sign in again",
  );
const forbidden = () =>
  new EntraError(403, "User is outside the approved Entra tenant roster");
const storageError = () =>
  new EntraError(503, "Entra session storage is unavailable");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const equal = (left: string, right: string) =>
  timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );

function cookie(req: Request, name: string) {
  const matches = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw unauthorized();
  const value = matches[0].slice(name.length + 1);
  if (!opaque.test(value)) throw unauthorized();
  return value;
}

function validLifetime(
  row: { created_at: number | string; expires_at: number | string },
  bound: number,
) {
  const created = Number(row.created_at);
  const expires = Number(row.expires_at);
  const now = Date.now();
  return (
    Number.isSafeInteger(created) &&
    Number.isSafeInteger(expires) &&
    created > 0 &&
    created <= now + 30_000 &&
    expires > now &&
    expires > created &&
    expires - created <= bound
  );
}

/**
 * Local-only auth-code/PKCE integration. Mount router at /api/entra; do not log callback
 * query strings or cookies. Nothing is contacted while consentActivated is false.
 * This module authenticates Entra identity only; application authorization belongs to the runtime.
 */
export function createEntraAuth(
  config: EntraAuthConfig,
  store: EntraStore,
  dependencies: EntraAuthDependencies = {},
): {
  router: Router;
  authenticate(
    req: Request,
  ): Promise<{ identity: UserIdentity; sessionId: string }>;
  credential(req: Request): Promise<DelegatedCredential>;
  /** Internal workers carry this non-bearer database hash, never a browser cookie or token. */
  identityForSession(sessionId: string): Promise<UserIdentity>;
  credentialForSession(sessionId: string): Promise<DelegatedCredential>;
  /** Internal ACL probes require both users, in configured roster order; never serialize the result. */
  credentialsForRoster(): Promise<DelegatedCredential[]>;
} {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success)
    throw new Error("Invalid Entra authentication configuration");
  const settings = parsed.data;
  const redirect = new URL(settings.redirectUri);
  const authority = `https://login.microsoftonline.com/${settings.tenantId}`;
  const issuer = `${authority}/v2.0`;
  const jwksUri = `${authority}/discovery/v2.0/keys`;
  if (
    !["http:", "https:"].includes(redirect.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.pathname !== "/api/entra/callback" ||
    (redirect.protocol === "https:" && !settings.cookieSecure) ||
    (settings.jwksUri !== undefined && settings.jwksUri !== jwksUri)
  )
    throw new Error(
      "Entra requires an exact localhost backend callback and tenant JWKS",
    );
  const key = Buffer.from(settings.encryptionKey, "hex");
  const transport = dependencies.fetch ?? globalThis.fetch;
  const router = Router();

  function activated() {
    if (config.consentActivated !== true)
      throw new EntraError(
        403,
        "Entra consent is not activated; authentication is disabled",
      );
  }

  function backendOrigin(req: Request) {
    if (
      req.protocol !== redirect.protocol.slice(0, -1) ||
      req.get("host")?.toLowerCase() !== redirect.host
    )
      throw new EntraError(
        403,
        "Entra authentication requires the configured backend origin",
      );
  }

  const cookieOptions = (path: string) => ({
    httpOnly: true,
    sameSite: "lax" as const,
    secure: settings.cookieSecure,
    path,
  });
  function clearCookies(res: Response) {
    res.clearCookie(stateCookie, cookieOptions("/api/entra"));
    res.clearCookie(sessionCookie, cookieOptions("/"));
  }

  function aad(kind: string, row: RequestRow | SessionRow) {
    const binding =
      "browser_hash" in row
        ? row.browser_hash
        : `${row.tenant_id}:${row.object_id}`;
    return `${kind}:${settings.clientId}:${settings.tenantId}:${row.id}:${binding}:${Number(row.created_at)}:${Number(row.expires_at)}`;
  }
  function encrypt(value: string, binding: string) {
    if (Buffer.byteLength(value) > maxCacheBytes) throw unauthorized();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(binding));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
  }
  function decrypt(value: string, binding: string): unknown {
    try {
      if (typeof value !== "string" || value.length > 2 * maxCacheBytes)
        throw unauthorized();
      const parts = value.split(".");
      if (
        parts.length !== 4 ||
        parts[0] !== "v1" ||
        !parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/.test(part))
      )
        throw unauthorized();
      const iv = Buffer.from(parts[1], "base64url");
      const tag = Buffer.from(parts[2], "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw unauthorized();
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(binding));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parts[3], "base64url")),
        decipher.final(),
      ]);
      if (plaintext.length > maxCacheBytes) throw unauthorized();
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw unauthorized();
    }
  }

  async function one<T>(sql: string, ...values: unknown[]) {
    activated();
    try {
      return await store.one<T>(sql, ...values);
    } catch {
      throw storageError();
    }
  }
  async function run(sql: string, ...values: unknown[]) {
    activated();
    try {
      return await store.run(sql, ...values);
    } catch {
      throw storageError();
    }
  }
  async function transaction<T>(fn: () => Promise<T>) {
    activated();
    try {
      return await store.transaction(fn);
    } catch (error) {
      if (error instanceof EntraError) throw error;
      throw storageError();
    }
  }

  async function microsoftFetch(url: string, init: RequestInit = {}) {
    activated();
    const endpoint = new URL(url);
    if (
      endpoint.origin !== "https://login.microsoftonline.com" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      !endpoint.pathname.startsWith(`/${settings.tenantId}/`)
    )
      throw new EntraError(
        401,
        "Entra returned an unapproved authentication endpoint",
      );
    const response = await transport(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw unauthorized();
    return response;
  }
  async function boundedBody(response: globalThis.Response) {
    if (Number(response.headers.get("content-length")) > maxCacheBytes)
      throw unauthorized();
    const reader = response.body?.getReader();
    if (!reader) throw unauthorized();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.length;
        if (length > maxCacheBytes) throw unauthorized();
        chunks.push(result.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      await reader.cancel();
    }
  }
  const network: INetworkModule = {
    async sendGetRequestAsync<T>(url: string, options?: NetworkRequestOptions) {
      activated();
      const response = await microsoftFetch(url, { headers: options?.headers });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: JSON.parse(await boundedBody(response)) as T,
      };
    },
    async sendPostRequestAsync<T>(
      url: string,
      options?: NetworkRequestOptions,
    ) {
      activated();
      if (new URL(url).pathname !== `/${settings.tenantId}/oauth2/v2.0/token`)
        throw unauthorized();
      const response = await microsoftFetch(url, {
        method: "POST",
        headers: options?.headers,
        body: options?.body,
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: JSON.parse(await boundedBody(response)) as T,
      };
    },
  };
  let remoteKeys: JWTVerifyGetKey | undefined;
  const jwks: JWTVerifyGetKey = async (header, token) => {
    activated();
    if (dependencies.jwks) return dependencies.jwks(header, token);
    remoteKeys ??= createRemoteJWKSet(new URL(jwksUri), {
      timeoutDuration: 10_000,
      [customFetch]: async (url, init) => {
        const response = await microsoftFetch(String(url), init);
        return new globalThis.Response(await boundedBody(response), {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    return remoteKeys(header, token);
  };

  function msal(initialCache?: string) {
    activated();
    let serialized = initialCache;
    const cachePlugin: ICachePlugin = {
      async beforeCacheAccess(context) {
        activated();
        if (serialized !== undefined)
          context.tokenCache.deserialize(serialized);
      },
      async afterCacheAccess(context) {
        activated();
        if (context.cacheHasChanged) {
          const next = context.tokenCache.serialize();
          if (Buffer.byteLength(next) > maxCacheBytes) throw unauthorized();
          serialized = next;
        }
      },
    };
    let client: EntraMsalClient;
    try {
      const configuration: Configuration = {
        auth: {
          clientId: settings.clientId,
          clientSecret: settings.clientSecret,
          authority,
          knownAuthorities: ["login.microsoftonline.com"],
        },
        cache: { cachePlugin },
        system: {
          networkClient: network,
          disableInternalRetries: true,
          loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
        },
      };
      client =
        dependencies.createMsalClient?.(configuration) ??
        new ConfidentialClientApplication(configuration);
    } catch {
      throw unauthorized();
    }
    return {
      client,
      serialized() {
        if (!serialized) throw unauthorized();
        return serialized;
      },
    };
  }
  async function acquire<T>(fn: () => Promise<T>) {
    activated();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof EntraError) throw error;
      throw new EntraError(
        401,
        "Entra token acquisition failed; sign in again",
      );
    }
  }

  function approved(tenantId: unknown, objectId: unknown) {
    const result = userIdentitySchema.safeParse({ tenantId, objectId });
    if (
      !result.success ||
      result.data.tenantId !== settings.tenantId ||
      !settings.roster.includes(result.data.objectId)
    )
      throw forbidden();
    return result.data;
  }
  function accountMatches(
    account: AccountInfo | null | undefined,
    identity: UserIdentity,
    homeId?: string,
  ) {
    if (
      !account ||
      typeof account.tenantId !== "string" ||
      typeof account.localAccountId !== "string" ||
      account.tenantId.toLowerCase() !== identity.tenantId ||
      account.localAccountId.toLowerCase() !== identity.objectId ||
      typeof account.homeAccountId !== "string" ||
      !account.homeAccountId ||
      (homeId !== undefined && account.homeAccountId !== homeId)
    )
      throw unauthorized();
  }
  async function idIdentity(
    result: AuthenticationResult | null,
    nonce: string,
  ) {
    if (!result?.idToken || result.idToken.length > 16000) throw unauthorized();
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(result.idToken, jwks, {
        algorithms: ["RS256"],
        issuer,
        audience: settings.clientId,
        requiredClaims: ["exp", "iat", "sub", "tid", "oid", "nonce"],
      }));
    } catch {
      throw new EntraError(
        401,
        "Entra ID token verification failed; sign in again",
      );
    }
    if (typeof claims.nonce !== "string" || !equal(claims.nonce, nonce))
      throw unauthorized();
    const identity = approved(claims.tid, claims.oid);
    accountMatches(result.account, identity);
    return identity;
  }
  async function delegated(token: string, identity: UserIdentity) {
    activated();
    try {
      if (typeof token !== "string" || !token || token.length > 16000)
        throw unauthorized();
      // Search can issue v1 resource tokens even when the auth-code endpoint is v2.
      // The untrusted version only selects between two exact tenant issuers; verify signs/binds it.
      const version = decodeJwt(token).ver;
      if (version !== "1.0" && version !== "2.0") throw unauthorized();
      return await DelegatedCredential.verify({
        token,
        sessionIdentity: identity,
        tenantId: settings.tenantId,
        roster: settings.roster,
        audience: searchAudience,
        issuer:
          version === "1.0"
            ? `https://sts.windows.net/${settings.tenantId}/`
            : issuer,
        delegatedScope: "user_impersonation",
        key: jwks,
      });
    } catch {
      throw new EntraError(
        401,
        "Entra delegated Search credential verification failed; sign in again",
      );
    }
  }

  function sessionIdFromRequest(req: Request) {
    activated();
    const bearer = cookie(req, sessionCookie);
    if (!bearer) throw unauthorized();
    return hash(bearer);
  }
  function validateSessionId(sessionId: string) {
    activated();
    if (typeof sessionId !== "string" || !hashPattern.test(sessionId))
      throw unauthorized();
  }
  async function session(sessionId: string, lock = false) {
    validateSessionId(sessionId);
    const row = await one<SessionRow>(
      `SELECT id, tenant_id, object_id, encrypted_cache, created_at, expires_at
       FROM fiq_entra_sessions WHERE id = ?${lock ? " FOR UPDATE" : ""}`,
      sessionId,
    );
    if (
      !row ||
      row.id !== sessionId ||
      !hashPattern.test(row.id) ||
      !validLifetime(row, sessionLifetime)
    )
      throw unauthorized();
    const identity = approved(row.tenant_id, row.object_id);
    const cached = cacheSchema.safeParse(
      decrypt(row.encrypted_cache, aad("session", row)),
    );
    if (!cached.success) throw unauthorized();
    return { identity, sessionId, row, cached: cached.data };
  }
  async function identityForSession(sessionId: string) {
    const { identity } = await session(sessionId);
    return identity;
  }
  async function authenticate(req: Request) {
    const sessionId = sessionIdFromRequest(req);
    const identity = await identityForSession(sessionId);
    return { identity, sessionId };
  }
  async function credential(req: Request) {
    return credentialForSession(sessionIdFromRequest(req));
  }
  async function credentialForSession(sessionId: string) {
    validateSessionId(sessionId);
    // Serialize refresh/cache writes across processes without sharing a global per-user cache.
    return transaction(async () => {
      const { identity, row, cached } = await session(sessionId, true);
      const scoped = msal(cached.cache);
      const accounts = await acquire(() =>
        scoped.client.getTokenCache().getAllAccounts(),
      );
      if (!Array.isArray(accounts) || accounts.length !== 1)
        throw unauthorized();
      accountMatches(accounts[0], identity, cached.homeAccountId);
      const result = await acquire(() =>
        scoped.client.acquireTokenSilent({
          account: accounts[0],
          scopes: [searchScope],
          authority,
        }),
      );
      if (!result) throw unauthorized();
      // A refresh response without an ID token can have account=null. The selected
      // cached account and the independently verified delegated JWT still bind the user.
      if (result.account)
        accountMatches(result.account, identity, cached.homeAccountId);
      const verified = await delegated(result.accessToken, identity);
      if (!validLifetime(row, sessionLifetime)) throw unauthorized();
      const encrypted = encrypt(
        JSON.stringify({
          homeAccountId: cached.homeAccountId,
          cache: scoped.serialized(),
        }),
        aad("session", row),
      );
      const saved = await run(
        `UPDATE fiq_entra_sessions SET encrypted_cache = ? WHERE id = ? AND expires_at > ?`,
        encrypted,
        row.id,
        Date.now(),
      );
      if (saved.changes !== 1) throw unauthorized();
      return verified;
    });
  }
  async function credentialsForRoster() {
    try {
      activated();
      const sessions: string[] = [];
      // Resolve both users before acquiring any token; an actor alone cannot finalize an ACL sync.
      for (const objectId of settings.roster) {
        const now = Date.now();
        const row = await one<{ id: string }>(
          `SELECT id FROM fiq_entra_sessions
           WHERE tenant_id = ? AND object_id = ? AND expires_at > ? AND created_at <= ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          settings.tenantId,
          objectId,
          now,
          now + 30_000,
        );
        if (!row) throw unauthorized();
        sessions.push(row.id);
      }
      const credentials: DelegatedCredential[] = [];
      for (const sessionId of sessions)
        credentials.push(await credentialForSession(sessionId));
      // The first session may have expired or been revoked while the second user refreshed.
      for (let i = 0; i < sessions.length; i++) {
        const identity = await identityForSession(sessions[i]);
        if (
          identity.objectId !== settings.roster[i] ||
          credentials[i].identity.tenantId !== settings.tenantId ||
          credentials[i].identity.objectId !== settings.roster[i] ||
          credentials[i].expiresAt <= Date.now() + 30_000
        )
          throw unauthorized();
      }
      return credentials;
    } catch (error) {
      if (error instanceof EntraError && error.status === 503) throw error;
      throw new EntraError(
        401,
        "Native ACL synchronization remains pending: activate Entra consent and sign in both approved roster users with delegated Azure Search access",
      );
    }
  }

  router.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  function route(fn: (req: Request, res: Response) => Promise<void>) {
    return async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (error) {
        const safe = error instanceof EntraError ? error : storageError();
        res.status(safe.status).json({ error: safe.message });
      }
    };
  }
  router.get(
    "/login",
    route(async (req, res) => {
      activated();
      backendOrigin(req);
      const state = random();
      const browser = random();
      const verifier = random();
      const nonce = random();
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const created = Date.now();
      const row: RequestRow = {
        id: hash(state),
        browser_hash: hash(browser),
        encrypted_request: "",
        created_at: created,
        expires_at: created + requestLifetime,
      };
      row.encrypted_request = encrypt(
        JSON.stringify({ verifier, nonce }),
        aad("request", row),
      );
      const scoped = msal();
      // .default requests the app's preconfigured delegated Search user_impersonation consent.
      const url = await acquire(() =>
        scoped.client.getAuthCodeUrl({
          scopes: [searchScope, "openid", "profile", "offline_access"],
          authority,
          redirectUri: redirect.href,
          state,
          nonce,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          responseMode: "query",
          prompt: "select_account",
        }),
      );
      if (typeof url !== "string" || !URL.canParse(url)) throw unauthorized();
      const destination = new URL(url);
      if (
        destination.origin !== "https://login.microsoftonline.com" ||
        destination.username ||
        destination.password ||
        destination.hash ||
        destination.pathname !==
          `/${settings.tenantId}/oauth2/v2.0/authorize` ||
        destination.searchParams.get("redirect_uri") !== redirect.href ||
        destination.searchParams.get("state") !== state ||
        destination.searchParams.get("nonce") !== nonce ||
        destination.searchParams.get("code_challenge") !== challenge ||
        destination.searchParams.get("code_challenge_method") !== "S256" ||
        destination.searchParams.get("response_type") !== "code"
      )
        throw unauthorized();
      await run(
        "DELETE FROM fiq_entra_requests WHERE expires_at <= ?",
        Date.now(),
      );
      await run(
        "DELETE FROM fiq_entra_sessions WHERE expires_at <= ?",
        Date.now(),
      );
      await run(
        `INSERT INTO fiq_entra_requests(id, browser_hash, encrypted_request, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
        row.id,
        row.browser_hash,
        row.encrypted_request,
        row.created_at,
        row.expires_at,
      );
      res.cookie(stateCookie, browser, {
        ...cookieOptions("/api/entra"),
        maxAge: requestLifetime,
      });
      res.redirect(302, url);
    }),
  );
  router.get(
    "/callback",
    route(async (req, res) => {
      activated();
      backendOrigin(req);
      const browser = cookie(req, stateCookie);
      const state = req.query.state;
      if (!browser || typeof state !== "string" || !opaque.test(state))
        throw unauthorized();
      res.clearCookie(stateCookie, cookieOptions("/api/entra"));
      // DELETE ... RETURNING consumes state exactly once, including denied/error callbacks.
      const row = await one<RequestRow>(
        `DELETE FROM fiq_entra_requests WHERE id = ? AND browser_hash = ?
       RETURNING id, browser_hash, encrypted_request, created_at, expires_at`,
        hash(state),
        hash(browser),
      );
      if (
        !row ||
        row.id !== hash(state) ||
        row.browser_hash !== hash(browser) ||
        !validLifetime(row, requestLifetime)
      )
        throw unauthorized();
      const pending = pendingSchema.safeParse(
        decrypt(row.encrypted_request, aad("request", row)),
      );
      if (!pending.success) throw unauthorized();
      if (req.query.error !== undefined)
        throw new EntraError(401, "Entra sign-in was not completed");
      const code = req.query.code;
      if (
        typeof code !== "string" ||
        !code ||
        code.length > 16000 ||
        /[\r\n]/.test(code)
      )
        throw unauthorized();
      const scoped = msal();
      const result = await acquire(() =>
        scoped.client.acquireTokenByCode({
          code,
          codeVerifier: pending.data.verifier,
          nonce: pending.data.nonce,
          state,
          scopes: [searchScope],
          authority,
          redirectUri: redirect.href,
        }),
      );
      const identity = await idIdentity(result, pending.data.nonce);
      if (!result) throw unauthorized();
      const accounts = await acquire(() =>
        scoped.client.getTokenCache().getAllAccounts(),
      );
      if (!Array.isArray(accounts) || accounts.length !== 1)
        throw unauthorized();
      accountMatches(accounts[0], identity, result.account?.homeAccountId);
      const bearer = random();
      const created = Date.now();
      const sessionRow: SessionRow = {
        id: hash(bearer),
        tenant_id: identity.tenantId,
        object_id: identity.objectId,
        encrypted_cache: "",
        created_at: created,
        expires_at: created + sessionLifetime,
      };
      sessionRow.encrypted_cache = encrypt(
        JSON.stringify({
          homeAccountId: accounts[0].homeAccountId,
          cache: scoped.serialized(),
        }),
        aad("session", sessionRow),
      );
      const previous = cookie(req, sessionCookie);
      await transaction(async () => {
        if (previous)
          await run(
            "DELETE FROM fiq_entra_sessions WHERE id = ?",
            hash(previous),
          );
        await run(
          `INSERT INTO fiq_entra_sessions(id, tenant_id, object_id, encrypted_cache, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
          sessionRow.id,
          sessionRow.tenant_id,
          sessionRow.object_id,
          sessionRow.encrypted_cache,
          sessionRow.created_at,
          sessionRow.expires_at,
        );
      });
      res.cookie(sessionCookie, bearer, {
        ...cookieOptions("/"),
        maxAge: sessionLifetime,
      });
      res.redirect(303, `${redirect.origin}/`);
    }),
  );
  router.get(
    "/session",
    route(async (req, res) => {
      res.json(await authenticate(req));
    }),
  );
  router.post(
    "/logout",
    route(async (req, res) => {
      activated();
      backendOrigin(req);
      if (req.get("origin") !== redirect.origin)
        throw new EntraError(
          403,
          "Entra logout requires the configured backend origin",
        );
      const bearer = cookie(req, sessionCookie);
      if (bearer)
        await run("DELETE FROM fiq_entra_sessions WHERE id = ?", hash(bearer));
      clearCookies(res);
      res.status(204).end();
    }),
  );
  return {
    router,
    authenticate,
    credential,
    identityForSession,
    credentialForSession,
    credentialsForRoster,
  };
}
