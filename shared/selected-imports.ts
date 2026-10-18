import { z } from "zod";
import { fileMime } from "./file-types";

export const importLimits = { files: 40, fileBytes: 8 * 1024 * 1024, batchBytes: 32 * 1024 * 1024 };
export const importName = z.string().trim().min(1).max(160)
  .refine((name) => !/[\x00-\x1f/\\]/.test(name) && !name.startsWith("."));
export const relativeImportPath = z.string().min(1).max(1024).refine((path) => {
  const parts = path.split("/");
  return parts.length >= 2 && parts.length <= 16 && !/^[A-Za-z]:$/.test(parts[0]) &&
    parts.every((part) => importName.safeParse(part).success);
}, "Use a relative folder path without hidden files, traversal or absolute paths");
export function importMime(name: string) {
  const mime = fileMime(name);
  return /\.(txt|md|markdown|json|pdf)$/i.test(name) ? mime : null;
}
export type ImportResult = { key: string; id?: string; state: "pending" | "unchanged" | "failed"; error?: string };
export type ImportConnection = {
  id: string; rootId: string; provider: "local" | "google"; label: string;
  items: { id: string; name?: string; state: string; parse: string; revision: number }[];
};
export type ImportStatus = {
  knowledgeBaseName: string;
  selectedDataApproved: boolean; googleAvailable: boolean; googleBlocker: string | null;
  richDocumentsAvailable: boolean; connections: ImportConnection[];
  selection: { id: string; name: string; mimeType: string }[] | null;
};
export type ImportReceipt = { connectionId: string; results: ImportResult[] };
export function verifiedImportItems(connection: ImportConnection) {
  return connection.items.filter((item) => item.state === "verified" && !!item.name);
}
