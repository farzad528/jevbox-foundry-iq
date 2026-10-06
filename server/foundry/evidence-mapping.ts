import { createHash } from "node:crypto";
import { evidenceSchema, type Evidence } from "../../shared/evidence";
import { flatten, type ParsedDocument } from "../indexing";

export function rawEvidenceFromParsed(input: {
  documentId: string;
  workspaceId: string;
  title: string;
  fileType: string;
  folderIds: string[];
  sourceRevision: number;
  aclRevision: number;
  userIds: string[];
  parsed: ParsedDocument;
  uploadedAt?: string;
}): Evidence[] {
  const { parsed, documentId, sourceRevision, aclRevision, uploadedAt, ...metadata } = input;
  return flatten(parsed.nodes).flatMap((node) =>
    (node.passages ?? []).map((passage) => {
      const blocks = new Map(parsed.blocks.map((block) => [block.id, block]));
      const textOnly = parsed.source === "text";
      const locator = {
        documentId, sourceRevision, aclRevision,
        nodeId: node.id,
        passageId: passage.id,
        sectionPath: findPath(parsed.nodes, node.id),
        page: textOnly ? null : passage.page,
        endPage: textOnly ? null : passage.endPage,
        blocks: passage.blockIds.map((id) => {
          const block = blocks.get(id);
          if (!block) throw new Error("Parsed evidence references a missing original block");
          return {
            id,
            page: textOnly ? null : block.page,
            geometry: !textOnly && block.boundingBox && block.pageWidth && block.pageHeight
              ? { ...block.boundingBox, pageWidth: block.pageWidth, pageHeight: block.pageHeight }
              : null,
          };
        }),
      };
      return evidenceSchema.parse({
        schemaVersion: 1,
        indexKey: createHash("sha256").update(JSON.stringify([
          metadata.workspaceId, documentId, sourceRevision, node.id, passage.id,
        ])).digest("hex"),
        artifactId: documentId,
        contentKind: "raw",
        ...metadata,
        sourceRevision, aclRevision, locator,
        ...(uploadedAt ? { sourceDates: [{ documentId, uploadedAt, folderIds: metadata.folderIds, fileType: metadata.fileType }] } : {}),
        text: passage.content,
        current: true,
        retrievable: true,
      });
    }),
  );
}

function findPath(nodes: ParsedDocument["nodes"], target: string, parents: string[] = []): string[] {
  for (const node of nodes) {
    const path = [...parents, node.title];
    if (node.id === target) return path;
    const nested = findPath(node.children, target, path);
    if (nested.length) return nested;
  }
  return [];
}
