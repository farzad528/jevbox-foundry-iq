import type { FileSystemEntry } from "../components/extend/file-system";
import type { PersonalDocument } from "../../shared/personal-file";

export function personalDrive(documents: readonly PersonalDocument[]) {
  const items: FileSystemEntry[] = [], folders = new Map<string, FileSystemEntry>(), byId = new Map<string, string>();
  for (const document of documents) {
    const parts = document.path.split("/");
    let parentPath = "";
    for (const name of parts.slice(0, -1)) {
      const path = `${parentPath}${name}/`;
      if (!folders.has(path)) folders.set(path, { kind: "folder", path, parentPath, name });
      parentPath = path;
    }
    byId.set(document.id, document.path);
    items.push({ kind: "file", path: document.path, key: document.id, name: parts.at(-1)!, parentPath,
      size: document.size, contentType: document.mime, access: "restricted",
      metadata: { State: document.state === "indexed" ? "Indexed" : document.state === "local" ? "Selected locally - not indexed" : document.state } });
  }
  return { items: [...folders.values(), ...items], folders: [...folders.values()], byId };
}
