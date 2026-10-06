import { z } from "zod";

export const entraObjectIdSchema = z.uuid().transform((id) => id.toLowerCase());
const id = z.string().min(1).max(200);
const revision = z.number().int().positive().safe();
const readers = z.array(entraObjectIdSchema).max(2).refine(
  (values) => new Set(values).size === values.length,
  "Duplicate reader object IDs",
);
export const sourceVersionSchema = z.strictObject({
  documentId: id,
  sourceRevision: revision,
  aclRevision: revision,
});
export const sourceLocatorSchema = sourceVersionSchema.extend({
  nodeId: id,
  passageId: id,
  sectionPath: z.array(z.string().max(300)).max(32),
  page: z.number().int().positive().nullable(),
  endPage: z.number().int().positive().nullable(),
  blocks: z.array(z.strictObject({
    id,
    page: z.number().int().positive().nullable(),
    geometry: z.strictObject({
      pageWidth: z.number().positive().finite(),
      pageHeight: z.number().positive().finite(),
      left: z.number().nonnegative().finite(),
      top: z.number().nonnegative().finite(),
      right: z.number().positive().finite(),
      bottom: z.number().positive().finite(),
    }).refine(
      (box) => box.right > box.left && box.bottom > box.top &&
        box.right <= box.pageWidth && box.bottom <= box.pageHeight,
      "Geometry must be within the original page",
    ).nullable(),
  })).max(256),
}).superRefine((locator, context) => {
  if ((locator.page === null) !== (locator.endPage === null) ||
      (locator.page !== null && locator.endPage! < locator.page))
    context.addIssue({ code: "custom", message: "Invalid original page range" });
  if (locator.blocks.some((block) =>
    (block.geometry !== null && block.page === null) ||
    (block.page !== null && (locator.page === null ||
      block.page < locator.page || block.page > locator.endPage!))))
    context.addIssue({ code: "custom", message: "Block page is outside the original range" });
});
export const evidenceDependencySchema = z.strictObject({
  evidenceId: id,
  locator: sourceLocatorSchema,
});
const common = {
  schemaVersion: z.literal(1),
  indexKey: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/),
  artifactId: id,
  workspaceId: id,
  title: z.string().min(1).max(500),
  text: z.string().min(1).max(50000),
  folderIds: z.array(id).max(32),
  fileType: z.string().min(1).max(100),
  sourceRevision: revision,
  aclRevision: revision,
  userIds: readers,
  current: z.boolean(),
  retrievable: z.boolean(),
  sourceDates: z.array(z.strictObject({
    documentId: id, uploadedAt: z.iso.datetime(),
    folderIds: z.array(id).max(32).optional(),
    fileType: z.string().min(1).max(100).optional(),
  })).max(256).optional(),
};
export const evidenceSchema = z.discriminatedUnion("contentKind", [
  z.strictObject({
    ...common,
    contentKind: z.literal("raw"),
    locator: sourceLocatorSchema,
  }).refine((unit) =>
    unit.artifactId === unit.locator.documentId &&
    unit.sourceRevision === unit.locator.sourceRevision &&
    unit.aclRevision === unit.locator.aclRevision,
  "Raw evidence and original locator versions must match"),
  z.strictObject({
    ...common,
    contentKind: z.literal("wiki"),
    wikiRevision: revision,
    reviewStatus: z.enum(["draft", "reviewed", "published", "stale"]),
    dependencies: z.array(evidenceDependencySchema).min(1).max(256),
    supportingEvidence: z.array(evidenceDependencySchema).min(1).max(32),
  }).refine((unit) =>
    !unit.retrievable || (unit.current && unit.reviewStatus === "published"),
  "Only current published wiki evidence is retrievable").refine((unit) =>
    unit.supportingEvidence.every((support) => unit.dependencies.some((dependency) =>
      dependency.evidenceId === support.evidenceId && JSON.stringify(dependency.locator) === JSON.stringify(support.locator))),
  "Claim support must belong to the full transitive dependency set"),
]);
export type Evidence = z.infer<typeof evidenceSchema>;
export type SourceVersion = z.infer<typeof sourceVersionSchema>;
export type SourceLocator = z.infer<typeof sourceLocatorSchema>;
export type EvidenceDependency = z.infer<typeof evidenceDependencySchema>;

export const sourceStateSchema = sourceVersionSchema.extend({
  tenantId: entraObjectIdSchema,
  workspaceId: id,
  readers,
  state: z.enum(["pending", "syncing", "verified", "failed", "deleted"]),
});
export type SourceState = z.infer<typeof sourceStateSchema>;
export const userIdentitySchema = z.strictObject({
  tenantId: entraObjectIdSchema,
  objectId: entraObjectIdSchema,
});
export type UserIdentity = z.infer<typeof userIdentitySchema>;
export class SourceUnavailableError extends Error {}

export function intersectReaders(roster: string[], ...bounds: string[][]) {
  const authorized = readers.parse(roster);
  if (!bounds.length) throw new Error("At least one explicit reader bound is required");
  const sets = bounds.map((bound) => new Set(readers.parse(bound)));
  return authorized.filter((oid) => sets.every((set) => set.has(oid))).sort();
}

export function assertSourceAccess(
  identity: UserIdentity,
  workspaceId: string,
  dependencies: SourceVersion[],
  states: ReadonlyMap<string, SourceState>,
) {
  const oid = userIdentitySchema.parse(identity).objectId;
  for (const dependency of dependencies) {
    const state = states.get(dependency.documentId);
    if (!state || state.tenantId !== identity.tenantId || state.workspaceId !== workspaceId || state.state !== "verified" ||
        state.sourceRevision !== dependency.sourceRevision ||
        state.aclRevision !== dependency.aclRevision || !state.readers.includes(oid))
      throw new SourceUnavailableError("Source unavailable: access, revision or synchronization changed");
  }
}

export function evidenceDependencies(evidence: Evidence): SourceVersion[] {
  const locators = evidence.contentKind === "raw"
    ? [evidence.locator]
    : evidence.dependencies.map((dependency) => dependency.locator);
  return locators.map(({ documentId, sourceRevision, aclRevision }) => ({ documentId, sourceRevision, aclRevision }));
}

export function assertEvidenceAccess(
  evidence: Evidence,
  identity: UserIdentity,
  workspaceId: string,
  states: ReadonlyMap<string, SourceState>,
) {
  evidenceSchema.parse(evidence);
  if (evidence.workspaceId !== workspaceId || !evidence.current || !evidence.retrievable ||
      !evidence.userIds.includes(userIdentitySchema.parse(identity).objectId))
    throw new SourceUnavailableError("Evidence is not currently available to this user");
  assertSourceAccess(identity, workspaceId, evidenceDependencies(evidence), states);
  if (evidence.contentKind === "wiki")
    assertSourceAccess(identity, workspaceId, [{ documentId: evidence.artifactId,
      sourceRevision: evidence.wikiRevision, aclRevision: evidence.aclRevision }], states);
}
