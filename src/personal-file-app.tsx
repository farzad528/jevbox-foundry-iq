import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PersonalDocument, PersonalState } from "../shared/personal-file";
import { importLimits, importMime, relativeImportPath } from "../shared/selected-imports";
import { personalDrive } from "./lib/personal-drive";
import { LibrarySpatialView } from "./components/library-spatial-view";
import { FileSystem } from "./components/extend/file-system";
import { PDFViewer } from "./components/extend/pdf-viewer";
import { useTheme } from "./components/theme";
import "./personal-file.css";

type Draft = { file: File; document: PersonalDocument };
type Provenance = {
  targets: { source: string; kb: string; index: string | null; portal: string } | null;
  observedAt: string | null; verification: string; inspection: string;
  schema: { name: string; fields: { name: string; type: string; retrievable?: boolean; filterable?: boolean; dimensions?: number }[] } | null;
  statistics: { documentCount: number; storageSize: number; vectorIndexSize?: number; observedAt: string } | null;
};
export default function PersonalFileApp() {
  const [state, setState] = useState<PersonalState | null>(null), [draft, setDraft] = useState<Draft[]>([]);
  const [csrf, setCsrf] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [review, setReview] = useState(false), [inspector, setInspector] = useState(false), [connection, setConnection] = useState(false);
  const [view, setView] = useState<"3d" | "finder">("3d"), [scope, setScope] = useState(""), [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; url?: string; text?: string } | null>(null);
  const [provenance, setProvenance] = useState<Provenance | null>(null), [question, setQuestion] = useState("");
  const files = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null);
  const previewSequence = useRef(0);
  const draftUrls = useMemo(() => new Map(draft.map((entry) => [entry.document.id, URL.createObjectURL(entry.file)])), [draft]);
  useEffect(() => () => { for (const url of draftUrls.values()) URL.revokeObjectURL(url); }, [draftUrls]);
  const { dark, toggle } = useTheme();
  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`/api/personal/${path}`, { ...init, cache: "no-store",
      headers: { ...init?.headers, ...(init?.method ? { "X-Jevbox-CSRF": csrf } : {}) } });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "Personal request failed");
    return body as T;
  }, [csrf]);
  const refresh = useCallback(async () => { setState(await request<PersonalState>("state")); }, [request]);
  useEffect(() => {
    let active = true;
    void fetch("/api/personal/session").then(async (response) => {
      if (!response.ok) throw new Error("Local owner session unavailable");
      const body = await response.json() as { csrf: string };
      if (active) setCsrf(body.csrf);
    }).catch((error: unknown) => setError(error instanceof Error ? error.message : "Local session failed"));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!csrf) return;
    const update = () => { void refresh().catch((error: unknown) => setError(error instanceof Error ? error.message : "Workspace unavailable")); };
    update(); const timer = setInterval(update, 1500);
    return () => clearInterval(timer);
  }, [csrf, refresh]);
  const documents = draft.length ? draft.map((entry) => entry.document) : state?.snapshot?.documents ?? [];
  const drive = useMemo(() => personalDrive(documents), [documents]);
  const selectFiles = (list: FileList | null) => {
    if (!list) return;
    try {
      if (state?.snapshot) throw new Error("This snapshot is immutable. Use a separate private personal data directory for another collection.");
      const chosen = [...list];
      if (!chosen.length || chosen.length > importLimits.files || chosen.reduce((sum, file) => sum + file.size, 0) > importLimits.batchBytes)
        throw new Error("Choose up to 40 files, at most 8 MiB each and 32 MiB total.");
      const next = chosen.map((file, index) => {
        const path = file.webkitRelativePath || `Local files/${file.name}`, mime = importMime(file.name);
        if (!relativeImportPath.safeParse(path).success || !mime || file.size > importLimits.fileBytes)
          throw new Error(`Cannot admit ${file.name}: use supported visible relative-path text, Markdown, JSON or PDF candidates within the size limit.`);
        return { file, document: { id: `selected-${index}`, path, mime, size: file.size, state: "local" as const, nativeFileId: null, error: null } };
      });
      if (new Set(next.map((entry) => entry.document.path.toLowerCase())).size !== next.length) throw new Error("Duplicate paths are not accepted.");
      setDraft(next); setReview(true); setScope(""); setSelected(null); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Selection failed"); }
  };
  const save = async () => {
    setBusy("Saving originals locally - no cloud upload"); setError("");
    try {
      const body = new FormData();
      body.append("paths", JSON.stringify(draft.map((entry) => entry.document.path)));
      for (const entry of draft) body.append("files", entry.file, entry.file.name);
      await request("select", { method: "POST", body });
      await refresh(); previewSequence.current++; setPreview(null); setDraft([]); setReview(false);
    } catch (error) { setError(error instanceof Error ? error.message : "Local save failed"); }
    finally { setBusy(""); }
  };
  const open = async (id: string) => {
    const document = documents.find((entry) => entry.id === id); if (!document) return;
    const sequence = ++previewSequence.current;
    setSelected(document.path); setScope(document.path.slice(0, document.path.lastIndexOf("/") + 1));
    try {
      const item = draft.find((entry) => entry.document.id === id);
      if (document.mime === "application/pdf") {
        setPreview({ path: document.path, url: item ? draftUrls.get(id)! : `/api/personal/originals/${id}` });
      } else {
        const response = item ? null : await fetch(`/api/personal/originals/${id}`);
        if (response && !response.ok) throw new Error("Original is no longer available");
        const text = item ? await item.file.text() : await response!.text();
        if (sequence === previewSequence.current) setPreview({ path: document.path, text });
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Original unavailable"); }
  };
  const execute = async (stage: "ingest" | "kb" | "chat" | "inspect", text?: string) => {
    const operation = state?.operations.find((entry) => entry.stage === stage && entry.state === "approved" &&
      Date.parse(entry.expiresAt) > Date.now() && (stage !== "chat" || entry.questionsUsed < entry.questionLimit));
    if (!operation) { setError("A fresh concrete approval in chat is required. No cloud operation was sent."); return; }
    setBusy(stage === "chat" ? "Retrieving through Foundry IQ, then generating one cited answer" : `Running approved ${stage} operation`); setError("");
    try {
      await request(`execute/${operation.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage, ...(text ? { question: text } : {}) }) });
      if (stage === "chat") setQuestion("");
    } catch (error) { setError(error instanceof Error ? error.message : "Operation stopped; inspect its retained state"); }
    finally { setBusy(""); await refresh(); }
  };
  const approved = (stage: string) => state?.operations.some((entry) => entry.stage === stage && entry.state === "approved" &&
    Date.parse(entry.expiresAt) > Date.now() && (stage !== "chat" || entry.questionsUsed < entry.questionLimit));
  const chatReady = state?.snapshot?.state === "ready" && approved("chat");
  const showProvenance = async () => {
    setInspector(true);
    try { setProvenance(await request<Provenance>("provenance")); }
    catch (error) { setError(error instanceof Error ? error.message : "Provenance unavailable"); }
  };
  return <div className="personal-workspace">
    <header className="personal-header">
      <div><strong>Jevbox + Foundry IQ</strong><span className="personal-badge">Personal File-KS</span>
        <small>{state?.snapshot?.state ?? "Local workspace"} · {documents.length} originals</small></div>
      <nav><button onClick={() => { setReview(true); files.current?.click(); }}>Connect local files</button>
        <button onClick={() => folder.current?.click()}>Choose folder</button>
        <button onClick={() => setConnection(!connection)}>Connection &amp; approvals</button>
        <button onClick={() => void showProvenance()}>Azure provenance</button>
        <button onClick={toggle}>{dark ? "Light" : "Dark"}</button></nav>
    </header>
    <input hidden type="file" multiple ref={files} aria-label="Choose personal files" accept=".md,.markdown,.txt,.json,.pdf" onChange={(event) => selectFiles(event.target.files)} />
    <input hidden type="file" multiple ref={folder} aria-label="Choose personal folder" {...{ webkitdirectory: "" }} onChange={(event) => selectFiles(event.target.files)} />
    {error && <div role="alert" className="personal-alert">{error}</div>}
    {busy && <div role="status" className="personal-notice">{busy}. Closing this tab does not cancel remote processing.</div>}
    {connection && <section className="personal-drawer">
      <h2>Connection &amp; approvals</h2><p>{state?.blocker ?? "Private Azure targets configured; no live stage is authorized by configuration alone."}</p>
      <p>Review this immutable snapshot locally. The operator prepares exact priced proposals; approve each live stage in this chat. App buttons cannot grant permission.</p>
      <p>Existing shared Search readers/operators may access uploaded data. Standard CU and embeddings can incur charges; GlobalStandard inference is not US-only. No new services, roles or vendor processing.</p>
      <p>Stages: File source + ingestion → KB → bounded chat → independent index-content inspection. Cleanup is separate.</p>
      {state?.operations.map((operation) => <p key={operation.id}>{operation.stage}: {operation.state} · {operation.stage === "chat" ? `${operation.questionsUsed}/${operation.questionLimit} questions consumed · ` : ""}expires {operation.expiresAt}</p>)}
    </section>}
    {review && <section className="personal-drawer">
      <h2>Review selected snapshot</h2>
      <p>Only a local copy is saved here. Native ingestion requires a separately approved exact plan. App limits: 40 files, 8 MiB/file, 32 MiB/batch; native content detection decides final admission.</p>
      <ul>{documents.map((document) => <li key={document.id}>{document.path} · {document.size} bytes · {document.state === "local" ? "Selected locally - not indexed" : document.state}</li>)}</ul>
      {draft.length > 0 && <button disabled={!!busy || !csrf} onClick={() => void save()}>Save selected snapshot locally</button>}
      <button onClick={() => setReview(false)}>Close review</button>
    </section>}
    <div className="personal-body">
      <aside className="personal-tree"><h2>Documents</h2><button onClick={() => setScope("")}>All folders</button>
        {drive.folders.map((entry) => <button key={entry.path} onClick={() => setScope(entry.path)}>▸ {entry.path}</button>)}
        {documents.map((document) => <button key={document.id} className={selected === document.path ? "selected" : ""} onClick={() => void open(document.id)}>
          {document.path.split("/").at(-1)}<small>{document.state === "local" ? "Local - not indexed" : document.state}</small></button>)}
      </aside>
      <main className="personal-library">
        <div className="personal-toolbar"><h1>Your document drive</h1><button aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D</button>
          <button aria-pressed={view === "finder"} onClick={() => setView("finder")}>Finder</button><span>{scope || "All folders"}</span></div>
        <p className="personal-caption">Jevbox spatial document view, not an embedding graph. Local selection is not indexing or Q&amp;A readiness.</p>
        <div className="personal-spatial" data-testid="personal-library">
          {!documents.length ? <div className="personal-empty"><h2>Connect files. Explore in 3D. Ask with sources.</h2>
            <p>Choose local files or a folder to see your originals here immediately. Nothing goes to Azure without its exact approval.</p>
            <button onClick={() => files.current?.click()}>Choose files</button><button onClick={() => folder.current?.click()}>Choose a folder</button></div>
            : view === "3d" ? <LibrarySpatialView items={drive.items} scope={scope} selectedPath={selected}
              onSelect={(entry) => setSelected(entry?.path ?? null)} onOpen={(entry) => entry.kind === "folder" ? setScope(entry.path) : void open(entry.key)}
              loadPreviewImageUrl={async () => null} loadDocumentStructure={async () => null} />
              : <FileSystem items={drive.items} view="icons" path={scope} onPathChange={setScope}
                onFileOpen={(file) => void open(file.key!)} onSelectionChange={(item) => setSelected(item?.path ?? null)}
                getFileUrl={(file) => draftUrls.get(file.key!) ?? `/api/personal/originals/${file.key}`} loadPreviewImageUrl={async () => null} loadDocumentStructure={async () => null} />}
        </div>
        <div className="personal-toolbar"><button disabled={!approved("ingest") || !!busy} onClick={() => void execute("ingest")}>Run approved ingestion</button>
          <button disabled={!approved("kb") || !!busy} onClick={() => void execute("kb")}>Create approved KB</button>
          <small>{state?.snapshot?.error ?? "Live controls unlock only for the matching chat-approved operation."}</small></div>
      </main>
      <aside className="personal-chat"><h2>Ask Foundry IQ</h2>
        <p>Scope: the entire approved snapshot. One extractive retrieval, then one final cited answer.</p>
        {!chatReady && <p role="status">Chat awaits verified ingestion, KB creation and its priced session approval in chat.</p>}
        <div className="personal-conversation">{state?.answers.map((answer, index) => <article key={index}>
          <h3>{answer.question}</h3><p className="personal-answer">{answer.answer}</p>
          {answer.citations.map((citation) => <div className="personal-source" key={`${citation.id}-${citation.chunkId}`}>
            <button onClick={() => void open(citation.documentId)}>[{citation.id}] {citation.path}</button>
            <blockquote>{citation.excerpt}</blockquote><small>File {citation.fileId} · chunk {citation.chunkId}</small>
            <button onClick={() => void showProvenance()}>Show indexed provenance</button>
          </div>)}
        </article>)}</div>
        <form onSubmit={(event) => { event.preventDefault(); void execute("chat", question); }}>
          <label htmlFor="personal-question">Your question</label><textarea id="personal-question" value={question} maxLength={4000} onChange={(event) => setQuestion(event.target.value)} />
          <button disabled={!chatReady || !!busy || !question.trim()}>Ask with sources</button>
        </form>
      </aside>
    </div>
    {inspector && <section className="personal-overlay" aria-label="Azure provenance inspector"><button onClick={() => setInspector(false)}>Close provenance</button>
      <h2>Original → native File source → Search index → KB → citation</h2>
      {provenance?.targets ? <><p>Source: {provenance.targets.source}</p><p>Generated index: {provenance.targets.index ?? "Not yet observed - never inferred from the source name"}</p>
        <p>KB target: {provenance.targets.kb}</p><p>Last schema readback: {provenance.observedAt ?? "Unavailable"}</p>
        <a href={provenance.targets.portal} target="_blank" rel="noreferrer">Open Azure AI Search</a>
        <p>Search management → Indexes → {provenance.targets.index ?? "[pending generated index]"} → Search explorer. Use your own authorized Entra sign-in. Do not edit or delete the generated index.</p>
        <button disabled={!provenance.targets.index} onClick={() => { void navigator.clipboard.writeText(provenance.targets!.index!).catch(() => setError("Clipboard permission unavailable; select the displayed index name manually.")); }}>Copy index name</button>
        {provenance.schema && <button onClick={() => { void navigator.clipboard.writeText(JSON.stringify({
          search: "*", top: 3, select: provenance.schema!.fields.filter((field) => field.retrievable !== false && field.type !== "Collection(Edm.Single)").map((field) => field.name).join(","),
        }, null, 2)).catch(() => setError("Clipboard permission unavailable; use the displayed observed schema for a bounded query.")); }}>Copy inspection query</button>}
        <p>{provenance.statistics ? `${provenance.statistics.documentCount} indexed chunks, ${provenance.statistics.storageSize} storage bytes (observed ${provenance.statistics.observedAt}); ${documents.length} originals. Chunk count is not file count.` : "Index statistics unavailable - not zero."}</p>
        {provenance.schema && <pre>{JSON.stringify(provenance.schema, null, 2)}</pre>}
        <p>{provenance.inspection}</p><button disabled={!approved("inspect") || !!busy} onClick={() => void execute("inspect")}>Run approved content inspection</button>
        </> : <p>Connect the reviewed private Azure configuration first. No index has been created by selecting local files.</p>}
    </section>}
    {preview && <section className="personal-overlay personal-original" aria-label="Original source"><button onClick={() => { previewSequence.current++; setPreview(null); }}>Close original</button>
      <h2>{preview.path}</h2>{preview.url ? <PDFViewer key={preview.url} className="personal-pdf" src={preview.url}
        fileName={preview.path} defaultZoom="fit-width" showUpload={false} showDownload={false} showRotateControls={false} /> : <pre>{preview.text}</pre>}</section>}
    <footer>Personal local demo · No cloud operation on launch · Shared native ACL/MCP activation remains locked · Not an official Microsoft or Extend product</footer>
  </div>;
}
