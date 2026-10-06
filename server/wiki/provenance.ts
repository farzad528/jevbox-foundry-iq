import { z } from "zod";
import {
  evidenceDependencySchema, intersectReaders, assertSourceAccess,
  type EvidenceDependency, type SourceState, type UserIdentity,
} from "../../shared/evidence";

export const wikiRevisionSchema = z.strictObject({
  pageId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  title: z.string().min(1).max(500),
  kind: z.enum(["topic", "decision", "runbook"]),
  state: z.enum(["draft", "reviewed", "published", "stale"]),
  authorOid: z.uuid(),
  reviewerOid: z.uuid().nullable(),
  claims: z.array(z.strictObject({
    id: z.string().min(1).max(200),
    text: z.string().min(1).max(10000),
    evidence: z.array(evidenceDependencySchema).min(1).max(32),
  })).min(1).max(128).refine((claims) => new Set(claims.map((claim) => claim.id)).size === claims.length, "Claim IDs must be unique"),
  relatedPageIds: z.array(z.string().min(1).max(200)).max(32),
});
export type WikiRevision = z.infer<typeof wikiRevisionSchema>;
export type WikiDependencyNode =
  | { kind: "raw"; dependency: EvidenceDependency }
  | { kind: "wiki"; dependencies: string[] };

export function expandRawDependencies(
  roots: string[],
  nodes: ReadonlyMap<string, WikiDependencyNode>,
  limit = 256,
) {
  const output = new Map<string, EvidenceDependency>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (depth > 32 || visited.size + visiting.size >= limit)
      throw new Error("Wiki dependency traversal exceeds its bound");
    if (visiting.has(id)) throw new Error("Wiki dependency cycle");
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error("Unresolved wiki dependency");
    visiting.add(id);
    if (node.kind === "raw") {
      evidenceDependencySchema.parse(node.dependency);
      output.set(node.dependency.evidenceId, node.dependency);
    } else {
      if (!node.dependencies.length) throw new Error("Wiki has no raw-source dependencies");
      for (const child of node.dependencies) walk(child, depth + 1);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const root of roots) walk(root, 0);
  return [...output.values()];
}

export function validateWikiPublication(input: {
  draft: WikiRevision;
  identity: UserIdentity;
  roster: string[];
  locationReaders: string[];
  sources: ReadonlyMap<string, SourceState>;
  evidence: ReadonlyMap<string, EvidenceDependency>;
}) {
  const draft = wikiRevisionSchema.parse(input.draft);
  if (draft.state !== "reviewed" || draft.reviewerOid !== input.identity.objectId)
    throw new Error("Human review is required before publication");
  const dependencies = [...new Map(draft.claims.flatMap((claim) => claim.evidence)
    .map((dependency) => [dependency.evidenceId, dependency])).values()];
  for (const dependency of dependencies) {
    const original = input.evidence.get(dependency.evidenceId);
    if (!original || JSON.stringify(original.locator) !== JSON.stringify(dependency.locator))
      throw new Error("Claim evidence does not resolve to its original revision");
  }
  assertSourceAccess(input.identity, draft.workspaceId,
    dependencies.map((dependency) => dependency.locator), input.sources);
  const userIds = intersectReaders(input.roster, input.locationReaders,
    ...dependencies.map((dependency) => input.sources.get(dependency.locator.documentId)!.readers));
  if (!userIds.includes(input.identity.objectId))
    throw new Error("Reviewer cannot read the complete derived page");
  return { ...draft, state: "published" as const, dependencies, userIds };
}

export function editWikiClaim(draft: WikiRevision, claimId: string, text: string, evidence: EvidenceDependency[]) {
  if (!draft.claims.some((claim) => claim.id === claimId))
    throw new Error("Unknown wiki claim");
  return wikiRevisionSchema.parse({
    ...draft, revision: draft.revision + 1, state: "draft", reviewerOid: null,
    claims: draft.claims.map((claim) => claim.id === claimId ? { ...claim, text, evidence } : claim),
  });
}
