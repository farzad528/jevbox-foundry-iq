import { createHash } from "node:crypto";
import { z } from "zod";
import type { KnowledgeDatabase } from "../foundry/database";
import type { FoundryConfig } from "../foundry/config";
import type { createEntraAccess } from "../foundry/access";
import { createKnowledgeLifecycle } from "../foundry/lifecycle";
import {
  assertSourceAccess, evidenceSchema, type Evidence, type UserIdentity,
} from "../../shared/evidence";
import { wikiRevisionSchema, validateWikiPublication, type WikiRevision } from "./provenance";
import { HttpError } from "../errors";

type WikiRow = { payload: WikiRevision; state: WikiRevision["state"] };
export function createWikiRepository(
  store: KnowledgeDatabase,
  config: FoundryConfig,
  access: ReturnType<typeof createEntraAccess>,
) {
  const lifecycle = createKnowledgeLifecycle(store);
  const evidence = async () => new Map((await store.all<{ index_key: string; payload: Evidence }>(
    "SELECT index_key,payload FROM knowledge_evidence WHERE workspace_id=? AND current AND retrievable",
    config.workspaceId,
  )).map((row) => [row.index_key, evidenceSchema.parse(row.payload)]));
  const latest = async (id: string, revision?: number) => {
    const row = await store.one<WikiRow>(
      `SELECT payload,state FROM knowledge_wiki_revisions WHERE workspace_id=? AND page_id=? ${revision ? "AND revision=?" : ""} ORDER BY revision DESC LIMIT 1`,
      config.workspaceId, id, ...(revision ? [revision] : []),
    );
    if (!row) throw new HttpError(404, "Knowledge page unavailable");
    return wikiRevisionSchema.parse({ ...row.payload, state: row.state });
  };
  const assertDependencies = async (identity: UserIdentity, page: WikiRevision) => {
    const states = await lifecycle.sources(config.workspaceId);
    assertSourceAccess(identity, config.workspaceId, page.claims.flatMap((claim) => claim.evidence.map((unit) => unit.locator)), states);
    const sync = await store.one<{ state: string }>("SELECT state FROM knowledge_source_state WHERE document_id=?", page.pageId);
    if (page.state === "published" && sync && sync.state !== "verified") throw new HttpError(409, "Knowledge publication/permissions are still synchronizing");
  };
  const read = async (identity: UserIdentity, id: string, revision?: number) => {
    const resource = await access.require(identity, id, false, true);
    if (resource.knowledge_acl_pending) throw new HttpError(409, "Knowledge location permissions are still synchronizing");
    const page = await latest(id, revision);
    await assertDependencies(identity, page);
    return page;
  };
  const save = async (page: WikiRevision) => {
    const parsed = wikiRevisionSchema.parse(page);
    await store.run(
      "INSERT INTO knowledge_wiki_revisions(workspace_id,page_id,revision,state,raw_source_ids,payload) VALUES(?,?,?,?,?,?::jsonb)",
      config.workspaceId, page.pageId, page.revision, page.state,
      [...new Set(page.claims.flatMap((claim) => claim.evidence.map((item) => item.locator.documentId)))], JSON.stringify(parsed),
    );
    return parsed;
  };
  return {
    evidence, latest, read,
    async rebindSourceAcl(documentId: string) {
      const originals = await evidence();
      const rows = await store.all<WikiRow & { page_id: string; revision: number }>(
        "SELECT page_id,revision,payload,state FROM knowledge_wiki_revisions WHERE workspace_id=? AND ?=ANY(raw_source_ids) AND state IN ('draft','reviewed','published')",
        config.workspaceId, documentId,
      );
      for (const row of rows) {
        const page = wikiRevisionSchema.parse({ ...row.payload, state: row.state });
        if (!page.claims.every((claim) => claim.evidence.every((dependency) => {
          const original = originals.get(dependency.evidenceId);
          return original?.contentKind === "raw" && original.sourceRevision === dependency.locator.sourceRevision;
        }))) continue;
        const rebound = wikiRevisionSchema.parse({ ...page, claims: page.claims.map((claim) => ({
          ...claim, evidence: claim.evidence.map((dependency) => {
            const original = originals.get(dependency.evidenceId)!;
            if (original.contentKind !== "raw") throw new HttpError(409, "Original ACL binding is unavailable");
            return { evidenceId: dependency.evidenceId, locator: original.locator };
          }),
        })) });
        await store.run("UPDATE knowledge_wiki_revisions SET payload=?::jsonb WHERE page_id=? AND revision=?",
          JSON.stringify(rebound), row.page_id, row.revision);
      }
    },
    async list(identity: UserIdentity) {
      const ids = await store.all<{ page_id: string }>("SELECT page_id FROM knowledge_wiki_locations WHERE page_id IN (SELECT id FROM resources WHERE org_id=? AND NOT knowledge_deleted)", config.workspaceId);
      const pages: WikiRevision[] = [];
      for (const { page_id } of ids) {
        if (!(await access.readers(page_id)).includes(identity.objectId)) continue;
        if ((await access.resource(page_id)).knowledge_acl_pending) continue;
        const page = await latest(page_id);
        const states = await lifecycle.sources(config.workspaceId);
        const readable = page.claims.every((claim) => claim.evidence.every((unit) => {
          const source = states.get(unit.locator.documentId);
          return source?.state === "verified" && source.sourceRevision === unit.locator.sourceRevision &&
            source.aclRevision === unit.locator.aclRevision && source.readers.includes(identity.objectId);
        }));
        if (readable) {
          const own = states.get(page_id);
          if (page.state !== "published" || !own || own.state === "verified") pages.push(page);
        }
      }
      return pages;
    },
    async history(identity: UserIdentity, id: string) {
      await read(identity, id);
      const rows = await store.all<{ revision: number }>("SELECT revision FROM knowledge_wiki_revisions WHERE workspace_id=? AND page_id=? ORDER BY revision DESC", config.workspaceId, id);
      const revisions: WikiRevision[] = [];
      for (const row of rows) {
        const page = await latest(id, row.revision);
        const states = await lifecycle.sources(config.workspaceId);
        const valid = page.claims.every((claim) => claim.evidence.every((unit) => {
          const state = states.get(unit.locator.documentId);
          return state?.state === "verified" && state.readers.includes(identity.objectId) &&
            state.sourceRevision === unit.locator.sourceRevision && state.aclRevision === unit.locator.aclRevision;
        }));
        if (valid) revisions.push(page);
      }
      return revisions;
    },
    async navigation(identity: UserIdentity, id: string) {
      const page = await read(identity, id);
      const pages = await this.list(identity);
      return {
        related: pages.filter((candidate) => page.relatedPageIds.includes(candidate.pageId)).map(({ pageId, title }) => ({ pageId, title })),
        backlinks: pages.filter((candidate) => candidate.relatedPageIds.includes(id)).map(({ pageId, title }) => ({ pageId, title })),
      };
    },
    async insertDraft(identity: UserIdentity, draft: WikiRevision, parentId: string | null) {
      return store.transaction(async () => {
        const existing = await store.one("SELECT page_id FROM knowledge_wiki_locations WHERE page_id=?", draft.pageId);
        if (existing) {
          await access.require(identity, draft.pageId, true, true);
          await store.one("SELECT id FROM resources WHERE id=? FOR UPDATE", draft.pageId);
          const previous = await latest(draft.pageId);
          if (draft.authorOid !== identity.objectId || draft.workspaceId !== config.workspaceId ||
              draft.state !== "draft" || draft.revision !== previous.revision + 1)
            throw new HttpError(409, "Regeneration must create the next reviewable revision");
          assertSourceAccess(identity, config.workspaceId, draft.claims.flatMap((claim) => claim.evidence.map((unit) => unit.locator)), await lifecycle.sources(config.workspaceId));
          return save(draft);
        }
        if (parentId) await access.require(identity, parentId, true, true);
        access.checkIdentity(identity);
        if (draft.workspaceId !== config.workspaceId || draft.authorOid !== identity.objectId || draft.state !== "draft" || draft.revision !== 1)
          throw new HttpError(409, "Invalid new draft identity");
        assertSourceAccess(identity, config.workspaceId, draft.claims.flatMap((claim) => claim.evidence.map((item) => item.locator)), await lifecycle.sources(config.workspaceId));
        await store.run(
          "INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,mime,access,created,status) VALUES(?,?,?,?,'document',?,'application/x-jevbox-wiki','restricted',?,'ready')",
          draft.pageId, config.workspaceId, identity.objectId, parentId, draft.title, new Date().toISOString(),
        );
        await store.run("INSERT INTO knowledge_wiki_locations(page_id) VALUES(?)", draft.pageId);
        return save(draft);
      });
    },
    async edit(identity: UserIdentity, id: string, input: unknown) {
      const edit = z.strictObject({
        revision: z.number().int().positive(),
        title: z.string().trim().min(1).max(500),
        claims: wikiRevisionSchema.shape.claims,
        relatedPageIds: wikiRevisionSchema.shape.relatedPageIds,
      }).parse(input);
      return store.transaction(async () => {
        await access.require(identity, id, true, true);
        await store.one("SELECT id FROM resources WHERE id=? FOR UPDATE", id);
        const previous = await read(identity, id);
        if (previous.revision !== edit.revision) throw new HttpError(409, "This page changed; reload before editing");
        const originals = await evidence();
        for (const claim of edit.claims)
          for (const dependency of claim.evidence) {
            const unit = originals.get(dependency.evidenceId);
            if (unit?.contentKind !== "raw" || JSON.stringify(unit.locator) !== JSON.stringify(dependency.locator))
              throw new HttpError(409, "Claims require current original-source evidence");
          }
        for (const linked of edit.relatedPageIds) {
          if (linked === id) throw new HttpError(409, "A page cannot link to itself");
          await read(identity, linked);
        }
        const page = wikiRevisionSchema.parse({ ...previous, ...edit, revision: previous.revision + 1,
          state: "draft", reviewerOid: null, authorOid: identity.objectId });
        assertSourceAccess(identity, config.workspaceId, page.claims.flatMap((claim) => claim.evidence.map((unit) => unit.locator)), await lifecycle.sources(config.workspaceId));
        return save(page);
      });
    },
    async review(identity: UserIdentity, id: string, revision: number) {
      return store.transaction(async () => {
        await access.require(identity, id, true, true);
        await store.one("SELECT id FROM resources WHERE id=? FOR UPDATE", id);
        const draft = await read(identity, id);
        if (draft.revision !== revision || draft.state !== "draft") throw new HttpError(409, "Only the current unchanged draft can be reviewed");
        const reviewed = wikiRevisionSchema.parse({ ...draft, state: "reviewed", reviewerOid: identity.objectId });
        await store.run("UPDATE knowledge_wiki_revisions SET state='reviewed',payload=?::jsonb WHERE page_id=? AND revision=?", JSON.stringify(reviewed), id, revision);
        return reviewed;
      });
    },
    async publish(identity: UserIdentity, sessionId: string, id: string, revision: number) {
      return store.transaction(async () => {
        await access.require(identity, id, true, true);
        await store.one("SELECT id FROM resources WHERE id=? FOR UPDATE", id);
        await store.all("SELECT document_id FROM knowledge_source_state WHERE workspace_id=? ORDER BY document_id FOR UPDATE", config.workspaceId);
        const draft = await read(identity, id);
        if (draft.revision !== revision) throw new HttpError(409, "Review the latest revision before publication");
        const originals = await evidence();
        const published = validateWikiPublication({
          draft, identity, roster: config.roster, locationReaders: await access.readers(id),
          sources: await lifecycle.sources(config.workspaceId),
          evidence: new Map([...originals].flatMap(([key, unit]) => unit.contentKind === "raw"
            ? [[key, { evidenceId: key, locator: unit.locator }] as const] : [])),
        });
        const previous = (await lifecycle.sources(config.workspaceId)).get(id);
        const aclRevision = (previous?.aclRevision ?? 0) + 1;
        const outbox = await lifecycle.transition({
          documentId: id, workspaceId: config.workspaceId, tenantId: config.tenantId,
          sourceRevision: revision, aclRevision, readers: published.userIds, state: "pending",
        }, "publish");
        await store.run("UPDATE knowledge_outbox SET session_id=? WHERE id=?", sessionId, outbox.id);
        await store.run("UPDATE knowledge_evidence SET current=false,retrievable=false WHERE artifact_id=?", id);
        const folders = (await access.bounds(id)).slice(1).map((row) => row.id);
        for (const claim of published.claims) {
          const unit = evidenceSchema.parse({
            schemaVersion: 1, indexKey: createHash("sha256").update(JSON.stringify([config.workspaceId, id, revision, claim.id])).digest("hex"),
            artifactId: id, workspaceId: config.workspaceId, contentKind: "wiki", title: published.title,
            text: claim.text, folderIds: folders, fileType: "wiki", sourceRevision: revision, aclRevision,
            userIds: published.userIds, current: true, retrievable: true, wikiRevision: revision,
            reviewStatus: "published", dependencies: published.dependencies, supportingEvidence: claim.evidence,
            sourceDates: [...new Map(published.dependencies.flatMap((dependency) => originals.get(dependency.evidenceId)?.sourceDates ?? [])
              .map((date) => [date.documentId, date])).values()],
          });
          await store.run(
            "INSERT INTO knowledge_evidence(index_key,workspace_id,artifact_id,content_kind,source_revision,acl_revision,raw_source_ids,payload) VALUES(?,?,?,'wiki',?,?,?,?::jsonb) ON CONFLICT(index_key) DO UPDATE SET payload=EXCLUDED.payload,acl_revision=EXCLUDED.acl_revision,current=false,retrievable=false",
            unit.indexKey, config.workspaceId, id, revision, aclRevision,
            [...new Set(published.dependencies.map((dependency) => dependency.locator.documentId))], JSON.stringify(unit),
          );
        }
        const { dependencies: _dependencies, userIds: _userIds, ...pageFields } = published;
        const page = wikiRevisionSchema.parse(pageFields);
        await store.run("UPDATE knowledge_wiki_revisions SET state='published',payload=?::jsonb WHERE page_id=? AND revision=?", JSON.stringify(page), id, revision);
        await store.run("UPDATE knowledge_wiki_locations SET published_revision=?,updated=now() WHERE page_id=?", revision, id);
        return { id: outbox.id, pageId: id, state: "pending", message: "Publication is pending native indexing and two-user ACL verification." };
      });
    },
  };
}
