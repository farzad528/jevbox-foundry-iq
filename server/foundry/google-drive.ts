import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../errors";
import { importLimits, importMime, importName } from "../../shared/selected-imports";

const scope = "https://www.googleapis.com/auth/drive.file";
const fileId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const metadata = z.object({
  id: fileId, name: importName, mimeType: z.string(),
  version: z.string().regex(/^\d+$/), trashed: z.boolean().optional(),
  size: z.string().regex(/^\d+$/).optional(),
  capabilities: z.object({ canDownload: z.boolean() }),
});
type Metadata = z.infer<typeof metadata>;
type Pending = {
  sessionId: string; expires: number; verifier: string; connectionId?: string;
  token?: string; files?: Metadata[]; busy?: boolean;
};
const lifetime = 10 * 60_000;

export function createGoogleDrive(input: {
  origin: string; clientId: string; clientSecret: string;
  fetcher?: typeof fetch; now?: () => number;
}) {
  const pending = new Map<string, Pending>();
  const now = input.now ?? Date.now;
  const fetcher = input.fetcher ?? fetch;
  const redirect = `${input.origin}/api/foundry/google/callback`;
  const clean = () => { for (const [key, value] of pending) if (value.expires <= now()) pending.delete(key); };
  const call = async (url: string, options: RequestInit = {}) => {
    try {
      const response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(response.status === 401 || response.status === 403 ? 409 : 502,
          "Google access is unavailable. Select the files again; no source permissions were changed.");
      }
      return response;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "Google request failed. Select the files again.");
    }
  };
  const bytes = async (response: Response, limit: number) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (!response.body) throw new HttpError(502, "Google returned no file content");
      const reader = response.body.getReader();
      try { while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new HttpError(413, "Selected Google file exceeds the import size limit");
        chunks.push(value);
      } } finally { await reader.cancel(); reader.releaseLock(); }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "Google content download was interrupted");
    }
  };
  const json = async (response: Response) => {
    try { return JSON.parse((await bytes(response, 64 * 1024)).toString("utf8")) as unknown; }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "Google returned an invalid response");
    }
  };
  const describe = async (id: string, token: string) => {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId.parse(id)}`);
    url.searchParams.set("fields", "id,name,mimeType,version,size,trashed,capabilities(canDownload)");
    url.searchParams.set("supportsAllDrives", "true");
    const file = metadata.safeParse(await json(await call(url.href, { headers: { Authorization: `Bearer ${token}` } })));
    if (!file.success || file.data.id !== id || file.data.trashed || !file.data.capabilities.canDownload)
      throw new HttpError(409, "Selected Google file cannot be downloaded");
    return file.data;
  };
  const selection = (sessionId: string) => {
    clean();
    return [...pending.values()].find((value) => value.sessionId === sessionId && value.token && value.files);
  };
  return {
    start(sessionId: string, connectionId?: string) {
      clean();
      for (const [key, value] of pending) if (value.sessionId === sessionId) {
        if (value.busy) throw new HttpError(409, "A Google import is already running");
        pending.delete(key);
      }
      if (pending.size >= 100) throw new HttpError(503, "Too many pending Google selections");
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      pending.set(state, { sessionId, expires: now() + lifetime, verifier, connectionId });
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: input.clientId, redirect_uri: redirect, response_type: "code", scope,
        state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", access_type: "online", include_granted_scopes: "false",
        prompt: "consent", trigger_onepick: "true", allow_multiple: "true",
        allow_folder_selection: "false",
        mimetypes: "text/plain,text/markdown,application/json,application/pdf,application/vnd.google-apps.document",
      }).toString();
      return url.href;
    },
    async callback(sessionId: string, query: unknown) {
      clean();
      const data = z.object({ state: z.string(), code: z.string().min(1).max(4096),
        picked_file_ids: z.string().min(1).max(8192) }).safeParse(query);
      if (!data.success) throw new HttpError(400, "Google selection was cancelled or incomplete; choose files again");
      const value = pending.get(data.data.state);
      pending.delete(data.data.state);
      if (!value || value.sessionId !== sessionId || !value.verifier || value.token)
        throw new HttpError(403, "Google selection expired or belongs to another session");
      const ids = z.array(fileId).min(1).max(importLimits.files).parse(data.data.picked_file_ids.split(","));
      if (new Set(ids).size !== ids.length) throw new HttpError(400, "Duplicate Google selections");
      const exchanged = z.object({ access_token: z.string().min(1).max(8192), token_type: z.literal("Bearer"),
        expires_in: z.number().positive(), scope: z.string() }).safeParse(await json(await call("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret,
          code: data.data.code, code_verifier: value.verifier, grant_type: "authorization_code", redirect_uri: redirect }),
      })));
      if (!exchanged.success || exchanged.data.scope.trim() !== scope)
        throw new HttpError(403, "Google did not return the exact selected-file authorization");
      const token = exchanged.data.access_token;
      const files: Metadata[] = [];
      for (const id of ids) files.push(await describe(id, token));
      pending.set(data.data.state, { ...value, verifier: "", token, files,
        expires: Math.min(value.expires, now() + Math.min(exchanged.data.expires_in * 1000, lifetime)) });
    },
    selected(sessionId: string) {
      return selection(sessionId)?.files?.map(({ id, name, mimeType }) => ({ id, name, mimeType })) ?? null;
    },
    async consume<T>(sessionId: string, fn: (files: Metadata[], connectionId: string | undefined,
      download: (file: Metadata) => Promise<{ body: Buffer; name: string; mime: string; origin: Record<string, string> }>) => Promise<T>) {
      const value = selection(sessionId);
      if (!value?.files || !value.token) throw new HttpError(409, "Select Google files again; authorization is not stored across restarts");
      if (value.busy) throw new HttpError(409, "A Google import is already running");
      value.busy = true;
      const token = value.token;
      try {
        return await fn(value.files, value.connectionId, async (file) => {
          if (value.expires <= now()) throw new HttpError(409, "Google selection expired; choose files again");
          const isDoc = file.mimeType === "application/vnd.google-apps.document";
          const name = importName.parse(isDoc ? `${file.name.slice(0, 155)}.txt` : file.name);
          const mime = isDoc ? "text/plain" : importMime(name);
          if (!mime || (!isDoc && mime !== file.mimeType && !(mime === "text/markdown" && file.mimeType === "text/plain")))
            throw new HttpError(400, "Import text, Markdown, JSON, PDF or a Google Doc; folders/shortcuts are not expanded");
          if (Number(file.size ?? 0) > importLimits.fileBytes) throw new HttpError(413, "Selected Google file exceeds 8 MiB");
          const url = new URL(`https://www.googleapis.com/drive/v3/files/${file.id}${isDoc ? "/export" : ""}`);
          if (isDoc) url.searchParams.set("mimeType", "text/plain");
          else { url.searchParams.set("alt", "media"); url.searchParams.set("supportsAllDrives", "true"); }
          const before = await describe(file.id, token);
          if (before.version !== file.version) throw new HttpError(409, "Google source changed after selection; select it again");
          const body = await bytes(await call(url.href, { headers: { Authorization: `Bearer ${token}` } }), importLimits.fileBytes);
          const after = await describe(file.id, token);
          if (after.version !== file.version) throw new HttpError(409, "Google source changed during download; select it again");
          return { body, name, mime, origin: { provider: "google", fileId: file.id, version: file.version,
            url: `https://drive.google.com/file/d/${file.id}/view`, representation: isDoc ? "Google Doc plain-text export (no original page geometry)" : "Original file bytes" } };
        });
      } finally {
        for (const [key, row] of pending) if (row === value) pending.delete(key);
      }
    },
  };
}
