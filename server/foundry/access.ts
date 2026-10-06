import type { KnowledgeDatabase } from "./database";
import type { FoundryConfig } from "./config";
import type { Resource } from "../db";
import { intersectReaders, userIdentitySchema, type UserIdentity } from "../../shared/evidence";
import { HttpError } from "../errors";

export type KnowledgeResource = Resource & {
  knowledge_deleted: boolean;
  knowledge_manual: boolean;
  knowledge_acl_pending: boolean;
  knowledge_parse_state: string;
  knowledge_filing_state: string;
};
export function createEntraAccess(store: KnowledgeDatabase, config: FoundryConfig) {
  const checkIdentity = (identity: UserIdentity) => {
    userIdentitySchema.parse(identity);
    if (identity.tenantId !== config.tenantId || !config.roster.includes(identity.objectId))
      throw new HttpError(403, "Outside the approved workspace roster");
  };
  const resource = async (id: string) => {
    const row = await store.one<KnowledgeResource>("SELECT * FROM resources WHERE id=? AND org_id=? AND NOT knowledge_deleted", id, config.workspaceId);
    if (!row) throw new HttpError(404, "Resource unavailable");
    return row;
  };
  const bounds = async (id: string) => {
    const visited = new Set<string>();
    const result: KnowledgeResource[] = [];
    let target: string | null = id;
    while (target) {
      if (visited.has(target) || result.length >= 32) throw new HttpError(409, "Invalid resource ancestry");
      visited.add(target);
      const row = await resource(target);
      result.push(row);
      target = row.parent_id;
    }
    return result;
  };
  const localReaders = async (row: KnowledgeResource) => {
    if (row.access === "link" || row.access === "organization") throw new HttpError(409, "Legacy/public sharing is disabled");
    if (row.access === "inherit") return config.roster;
    const grants = await store.all<{ user_id: string }>("SELECT user_id FROM grants WHERE resource_id=?", row.id);
    return [...new Set([row.owner_id, ...grants.map((grant) => grant.user_id)])].filter((oid) => config.roster.includes(oid));
  };
  const readers = async (id: string) => intersectReaders(config.roster, ...await Promise.all((await bounds(id)).map(localReaders)));
  const canWrite = async (identity: UserIdentity, id: string) => {
    checkIdentity(identity);
    if (!(await readers(id)).includes(identity.objectId)) return false;
    for (const bound of await bounds(id)) {
      if (bound.owner_id === identity.objectId ||
        await store.one("SELECT 1 FROM grants WHERE resource_id=? AND user_id=? AND role='editor'", bound.id, identity.objectId))
        return true;
      if (bound.access !== "inherit") break;
    }
    return false;
  };
  const requireAccess = async (identity: UserIdentity, id: string, write = false, allowPending = false) => {
    checkIdentity(identity);
    const row = await resource(id);
    if (!(await readers(id)).includes(identity.objectId)) throw new HttpError(404, "Resource unavailable");
    if (write && !await canWrite(identity, id)) throw new HttpError(403, "Editor access is required");
    if (!allowPending && row.knowledge_acl_pending)
      throw new HttpError(409, "Location permissions are still synchronizing");
    if (!allowPending && row.kind === "document") {
      const state = await store.one<{ state: string }>("SELECT state FROM knowledge_source_state WHERE document_id=?", id);
      if (state?.state !== "verified") throw new HttpError(409, "Source reads are blocked until native synchronization is verified");
    }
    return row;
  };
  return { checkIdentity, resource, bounds, readers, canWrite, require: requireAccess,
    async visible(identity: UserIdentity) {
      checkIdentity(identity);
      const all = await store.all<KnowledgeResource>("SELECT * FROM resources WHERE org_id=? AND NOT knowledge_deleted ORDER BY created", config.workspaceId);
      const visible = [];
      for (const row of all) {
        if (!(await readers(row.id)).includes(identity.objectId) || row.knowledge_acl_pending) continue;
        if (row.kind === "document") {
          const state = await store.one<{ state: string }>("SELECT state FROM knowledge_source_state WHERE document_id=?", row.id);
          if (state?.state !== "verified") continue;
        }
        visible.push(row);
      }
      return visible;
    },
    async pending(identity: UserIdentity) {
      checkIdentity(identity);
      const rows = await store.all<KnowledgeResource>("SELECT * FROM resources WHERE org_id=? AND owner_id=? AND NOT knowledge_deleted", config.workspaceId, identity.objectId);
      const statuses = [];
      for (const row of rows) {
        if (!(await readers(row.id)).includes(identity.objectId)) continue;
        const state = await store.one<{ state: string }>("SELECT state FROM knowledge_source_state WHERE document_id=?", row.id);
        if (row.knowledge_acl_pending || (row.kind === "document" && state?.state !== "verified"))
          statuses.push({ id: row.id, parse: row.knowledge_parse_state, filing: row.knowledge_filing_state, nativeSync: state?.state ?? "pending" });
      }
      return statuses;
    },
  };
}
