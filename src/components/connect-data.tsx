import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { Button } from "./coss/button";
import { importLimits, importMime, relativeImportPath, verifiedImportItems,
  type ImportReceipt, type ImportResult, type ImportStatus } from "../../shared/selected-imports";

export function ImportedOrigin({ documentId, onError }: { documentId: string; onError: (error: unknown) => void }) {
  const [origin, setOrigin] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let active = true;
    setOrigin(null);
    void api<Record<string, string> | null>(`/foundry/origins/${documentId}`, { notify: false })
      .then((value) => { if (active) setOrigin(value); }).catch((error: unknown) => { if (active) { setOrigin(null); onError(error); } });
    return () => { active = false; };
  }, [documentId, onError]);
  return origin && <div className="border-b p-3 text-sm">
    <p>Imported snapshot: {origin.representation}</p>
    {origin.path && <p>{origin.path}</p>}
    {origin.version && <p>Google source version: {origin.version}</p>}
    {origin.url && /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(origin.url) &&
      <a className="underline" href={origin.url} target="_blank" rel="noopener noreferrer">Open original in Google Drive</a>}
  </div>;
}

export function ConnectData({ onImported, onError, onNavigate, onOpen3D }: {
  onImported: () => Promise<void>; onError: (error: unknown) => void; onNavigate: (tab: string) => void;
  onOpen3D: (rootId: string, documentIds: string[]) => Promise<void>;
}) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [files, setFiles] = useState<{ file: File; path: string }[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [connectionId, setConnectionId] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [awaiting, setAwaiting] = useState<{ connectionId: string; ids: string[]; failed: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const opening3D = useRef(false);
  const statusVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++statusVersion.current;
    try {
      const next = await api<ImportStatus>("/foundry/connections", { notify: false });
      if (version === statusVersion.current) setStatus(next);
    } catch (error) { if (version === statusVersion.current) throw error; }
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        await load();
      } catch (error) { if (active) {
        setStatus(null); setFiles([]); setSelected([]); setConfirmed(false); setResults([]); setAwaiting(null); onError(error);
      } }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; statusVersion.current++; clearInterval(timer); };
  }, [load, onError]);
  useEffect(() => {
    if (busy || !awaiting || awaiting.failed || !awaiting.ids.length || opening3D.current) return;
    const connection = status?.connections.find((item) => item.id === awaiting.connectionId);
    if (!connection || !awaiting.ids.every((id) => verifiedImportItems(connection).some((item) => item.id === id))) return;
    opening3D.current = true;
    setAwaiting(null);
    void onOpen3D(connection.rootId, awaiting.ids).catch(onError).finally(() => { opening3D.current = false; });
  }, [awaiting, status, busy, onOpen3D, onError]);
  const issue = ({ file, path }: { file: File; path: string }) => !relativeImportPath.safeParse(path).success ? "Hidden or invalid path"
    : !importMime(file.name) ? "Unsupported file type"
    : file.size > importLimits.fileBytes ? "Larger than 8 MiB"
    : importMime(file.name) === "application/pdf" && !status?.richDocumentsAvailable ? "PDF needs approved Extend parsing" : null;
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setResults([]); setAwaiting(null);
    try { await fn(); await load(); await onImported(); }
    catch (error) { setStatus(null); setFiles([]); setSelected([]); setResults([]); setAwaiting(null); onError(error); }
    finally { setBusy(false); setConfirmed(false); }
  };
  const startGoogle = (id?: string) => { void perform(async () => {
    const { url } = await api<{ url: string }>("/foundry/google/start", {
      method: "POST", body: JSON.stringify(id ? { connectionId: id } : {}),
    });
    const target = new URL(url);
    if (target.origin !== "https://accounts.google.com") throw new Error("Invalid Google authorization destination");
    window.location.assign(url);
  }); };
  const chooseLocal = (input: HTMLInputElement, folder: boolean) => {
    setFiles(Array.from(input.files ?? []).map((file) => ({ file, path: folder ? file.webkitRelativePath : `Local files/${file.name}` })));
    setSelected([]); setConfirmed(false); setResults([]); setAwaiting(null); input.value = "";
  };
  const receipt = (value: ImportReceipt) => {
    statusVersion.current++;
    setStatus(null);
    setResults(value.results);
    setAwaiting({ connectionId: value.connectionId, ids: value.results.flatMap((item) => item.id ? [item.id] : []),
      failed: value.results.filter((item) => item.state === "failed").length });
  };
  const bytes = selected.reduce((sum, index) => sum + files[index].file.size, 0);
  const ready = status?.connections.some((connection) => verifiedImportItems(connection).length > 0);
  return <section className="mx-auto max-w-4xl space-y-6 p-6">
    <header className="space-y-2"><h1 className="text-2xl font-semibold">Connect your data. Ask Foundry IQ.</h1>
      <p>Connect local files or Google Drive, ingest the selection into Foundry IQ, then explore the verified collection in Jevbox’s 3D library.</p>
      <p className="text-sm text-muted-foreground">Selected snapshots, not a background sync. Refresh requires selecting the source again. Unselected/deleted files are not automatically removed, and Google sharing changes are not monitored or mirrored into Entra.</p>
    </header>
    {!status ? <p role="status">Checking connection readiness...</p> : <>
      <p className="rounded border p-3">Destination: Foundry IQ knowledge base <strong>{status.knowledgeBaseName}</strong>. Both sources use the same permission-aware index; connecting does not create a second retrieval service.</p>
      <ol className="flex flex-wrap gap-4 text-sm" aria-label="Import workflow"><li>1 · Connect and review</li><li>2 · Ingest and verify native access</li><li>3 · Open imported data in 3D</li></ol>
      {!status.selectedDataApproved && <p role="alert" className="rounded border p-4">Customer-data imports are locked. An operator must explicitly approve selected-data processing in the private runtime configuration. Earlier synthetic-data approval is not sufficient.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Local files</h2>
          <p className="text-sm">Your browser supplies only files you select. Folder paths are retained; no filesystem watcher or whole-disk access.</p>
          <Button disabled={busy || !status.selectedDataApproved} onClick={() => fileInput.current?.click()}>Connect local files</Button>
          <Button variant="secondary" disabled={busy || !status.selectedDataApproved} onClick={() => folderInput.current?.click()}>Choose local folder</Button>
          <input ref={fileInput} className="sr-only" aria-label="Choose local files" type="file" multiple accept=".txt,.md,.markdown,.json,.pdf"
            disabled={busy || !status.selectedDataApproved} onChange={(event) => chooseLocal(event.target, false)} />
          <input ref={folderInput} className="sr-only" aria-label="Choose local folder" type="file" multiple disabled={busy || !status.selectedDataApproved}
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(event) => chooseLocal(event.target, true)} />
          <p className="text-xs">Text, Markdown and JSON need no external parser. PDF requires separately approved Extend credentials. Up to 40 files, 8 MiB per file and 32 MiB per selection; hidden files are excluded.</p>
          {connectionId && <p role="status">Refreshing an existing local collection: select its same files or folder. <button className="underline" onClick={() => setConnectionId(undefined)}>Use a new import instead</button></p>}
        </section>
        <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Google Drive</h2>
          <p className="text-sm">Google’s picker grants access to selected files only (<code>drive.file</code>), not your entire drive. Select files inside folders; folders and shortcuts are not recursively imported.</p>
          <Button disabled={busy || !status.selectedDataApproved || !status.googleAvailable} onClick={() => startGoogle()}>Connect Google Drive</Button>
          {status.googleBlocker && <p className="text-sm">{status.googleBlocker}</p>}
          <p className="text-xs">Google Docs are imported as plain-text snapshots: no invented page numbers. OAuth tokens stay in server memory for at most 10 minutes, never in jobs, chat or browser storage. Reauthorize after refresh/restart.</p>
        </section>
      </div>
      {!!files.length && <fieldset className="space-y-3 rounded-lg border p-4"><legend>Review local selection</legend>
        <p>No files are selected automatically. Choose only documents you are authorized to send to the configured Azure services.</p>
        <div className="max-h-64 overflow-auto">{files.map((entry, index) => {
          const blocked = issue(entry);
          return <label key={`${entry.path}-${index}`} className="block py-1">
            <input type="checkbox" disabled={busy || !!blocked} checked={selected.includes(index)} onChange={(event) => {
              setSelected((current) => event.target.checked ? [...current, index] : current.filter((value) => value !== index)); setConfirmed(false);
            }} /> {entry.path} <small>{blocked ?? `${entry.file.size} bytes`}</small>
          </label>;
        })}</div>
        <p>{selected.length} selected · {bytes} bytes. {selected.length > importLimits.files || bytes > importLimits.batchBytes ? "Reduce the selection to the limits above." : ""}</p>
      </fieldset>}
      {!!status.selection?.length && <section className="space-y-2 rounded-lg border p-4"><h2 className="font-semibold">Review Google selection</h2>
        {status.selection.map((file) => <p key={file.id}>{file.name} <small>{file.mimeType}</small></p>)}
        <p>These files have not been imported. Confirm below to download/process this selection. Unsupported types fail visibly.</p>
      </section>}
      {(selected.length > 0 || !!status.selection?.length) && <div className="space-y-3">
        <label className="block"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /> I authorize processing this selection in the configured Foundry environment. Imports start private to my Entra identity.</label>
        {selected.length > 0 && <Button disabled={busy || !confirmed || !status.selectedDataApproved || selected.length > importLimits.files || bytes > importLimits.batchBytes}
          onClick={() => { void perform(async () => {
            const form = new FormData();
            for (const index of selected) form.append("files", files[index].file, files[index].file.name);
            form.append("manifest", JSON.stringify({ paths: selected.map((index) => files[index].path), ...(connectionId ? { connectionId } : {}) }));
            receipt(await api<ImportReceipt>("/foundry/imports/local", { method: "POST", body: form }));
            setFiles([]); setSelected([]); setConnectionId(undefined);
          }); }}>Ingest selected local files into Foundry IQ</Button>}
        {!!status.selection?.length && <Button disabled={busy || !confirmed || !status.selectedDataApproved} onClick={() => { void perform(async () => {
          receipt(await api<ImportReceipt>("/foundry/imports/google", { method: "POST", body: JSON.stringify({ confirm: true }) }));
        }); }}>Ingest selected Google files into Foundry IQ</Button>}
      </div>}
      {!!results.length && <section role="status" className="rounded border p-4"><h2 className="font-semibold">Import receipts—not retrieval readiness</h2>
        {results.map((result, index) => <p key={result.key}>Item {index + 1}{result.id ? ` · ${result.id}` : ""}: {result.state}{result.error ? ` · ${result.error}` : ""}</p>)}
        {awaiting && <p>{awaiting.failed ? "Some selected files failed. Inspect the receipts; only verified files can be viewed." : "Waiting for native indexing and permission verification. Your imported collection will open in 3D when every accepted file is ready."}</p>}
      </section>}
      <section className="space-y-3"><h2 className="font-semibold">Connected snapshots</h2>
        {!status.connections.length && <p>No data imported yet.</p>}
        {status.connections.map((connection) => <article key={connection.id} className="space-y-2 rounded-lg border p-4">
          <h3 className="font-semibold">{connection.label} · {connection.provider === "local" ? "Local files" : "Google Drive"}</h3>
          <p>{verifiedImportItems(connection).length} / {connection.items.length} files verified in Foundry IQ · {connection.items.filter((item) => item.state === "failed").length} failed</p>
          <Button variant="secondary" disabled={busy || !status.selectedDataApproved} onClick={() => {
            if (connection.provider === "google") startGoogle(connection.id);
            else { setConnectionId(connection.id); setFiles([]); setSelected([]); setConfirmed(false); setAwaiting(null); }
          }}>{connection.provider === "local" ? "Refresh: choose local files or folder again" : "Refresh: choose Google files again"}</Button>
          <Button disabled={busy || !verifiedImportItems(connection).length} onClick={() => {
            setAwaiting(null);
            void onOpen3D(connection.rootId, verifiedImportItems(connection).map((item) => item.id)).catch(onError);
          }}>View verified files in 3D</Button>
          {connection.items.map((item) => <p key={item.id} className="break-all text-sm">{item.name ?? item.id} · revision {item.revision} · parse {item.parse} · native {item.state}</p>)}
          <p className="text-xs">Pending titles/content remain hidden until native permission checks succeed for both configured users. Refresh retries failed native synchronization; healthy unchanged imports do not queue work.</p>
        </article>)}
      </section>
      <div className="flex gap-3"><Button disabled={!ready} onClick={() => onNavigate("library")}>Open document library</Button>
        <Button disabled={!ready} onClick={() => onNavigate("chat")}>Ask a source-cited question</Button></div>
    </>}
  </section>;
}
