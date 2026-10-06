import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { userIdentitySchema, type UserIdentity } from "../../shared/evidence";
import { HttpError } from "../errors";

const tokens = new WeakMap<DelegatedCredential, string>();
export class DelegatedCredential {
  private constructor(
    readonly identity: UserIdentity,
    readonly expiresAt: number,
  ) {}
  toJSON(): never {
    throw new Error("Delegated credentials must never be serialized");
  }
  static async verify(input: {
    token: string;
    sessionIdentity: UserIdentity;
    tenantId: string;
    audience: string;
    issuer: string;
    delegatedScope: string;
    roster: string[];
    key: JWTVerifyGetKey;
  }) {
    if (!input.token || input.token.length > 16000)
      throw new HttpError(401, "A current delegated user credential is required");
    const identity = userIdentitySchema.parse(input.sessionIdentity);
    if (identity.tenantId !== input.tenantId ||
        !input.roster.includes(identity.objectId))
      throw new HttpError(403, "User is outside the approved tenant roster");
    let claims;
    try {
      const result = await jwtVerify(input.token, input.key, {
        audience: input.audience, issuer: input.issuer,
        algorithms: ["RS256"], requiredClaims: ["exp", "iat", "tid", "oid", "scp"],
      });
      claims = result.payload;
    } catch {
      throw new HttpError(401, "User credential verification failed; sign in again");
    }
    if (claims.tid !== identity.tenantId || claims.oid !== identity.objectId ||
        typeof claims.scp !== "string" || !claims.scp.split(" ").includes(input.delegatedScope) ||
        typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() + 30000)
      throw new HttpError(401, "User credential does not match this authenticated session");
    const credential = new DelegatedCredential(identity, claims.exp * 1000);
    tokens.set(credential, input.token);
    return credential;
  }
}

export function delegatedHeader(credential: DelegatedCredential) {
  const token = tokens.get(credential);
  if (!token || credential.expiresAt <= Date.now() + 30000)
    throw new HttpError(401, "User credential expired; sign in again");
  return token;
}
export type ServiceCredential = { token: string; expiresAt: number };

export function serviceHeader(credential: ServiceCredential) {
  if (!credential.token || /[\r\n]/.test(credential.token) ||
      credential.expiresAt <= Date.now() + 30000)
    throw new HttpError(503, "The service reader credential is unavailable");
  return `Bearer ${credential.token}`;
}
