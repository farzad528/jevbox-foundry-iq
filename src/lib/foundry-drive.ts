import type { Resource } from "./api";
import type { FileSystemItem } from "../components/extend/file-system";

export type FoundryDriveResource = Resource & {
  syncState: string; sourceRevision?: number; aclRevision?: number;
  knowledge_parse_state: string; knowledge_filing_state: string;
};

export function foundryDrive(resources: readonly FoundryDriveResource[]) {
  const byId = new Map(resources.map((row) => [row.id, row]));
  const paths = new Map<string, string>();
  const visiting = new Set<string>();
  const pathFor = (row: FoundryDriveResource): string => {
    const cached = paths.get(row.id);
    if (cached) return cached;
    if (visiting.has(row.id)) throw new Error("The current library contains a folder cycle.");
    visiting.add(row.id);
    const parent = row.parent_id ? byId.get(row.parent_id) : null;
    if (row.parent_id && parent?.kind !== "folder")
      throw new Error("The current library hierarchy is not fully authorized.");
    // Finder/3D scopes use hierarchical paths; native resource IDs are not path prefixes.
    const path = `${parent ? pathFor(parent) : ""}${row.id}${row.kind === "folder" ? "/" : ""}`;
    visiting.delete(row.id); paths.set(row.id, path);
    return path;
  };
  const byPath = new Map<string, FoundryDriveResource>();
  const items: FileSystemItem[] = resources.map((row) => {
    const path = pathFor(row), parentPath = row.parent_id ? paths.get(row.parent_id)! : "";
    byPath.set(path, row);
    return row.kind === "folder"
      ? { kind: "folder", path, parentPath, name: row.name, pinned: row.pinned, access: row.access }
      : { kind: "file", path, parentPath, key: row.id, name: row.name, contentType: row.mime,
        access: row.access, size: row.size, metadata: { Index: row.syncState === "verified" ? "ready" : "processing" } };
  });
  return { paths, byPath, items };
}
