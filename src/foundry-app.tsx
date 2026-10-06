import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Resource } from "./lib/api";
import type { Evidence, SourceLocator, UserIdentity } from "../shared/evidence";
import type { RunSnapshot } from "../shared/observability";
import type { WikiRevision } from "../server/wiki/provenance";
import { FileSystem, type FileSystemItem } from "./components/extend/file-system";
import { DocumentView } from "./components/document";
import { RunConsoleDock } from "./components/run-console";
import { Markdown } from "./components/common";
import { Button } from "./components/coss/button";
import { useTheme } from "./components/theme";
import { WikiEditor } from "./components/wiki-editor";
import { EntraSharing } from "./components/entra-sharing";
import { searchFiltersSchema, type SearchFilters } from "../shared/search-filters";

type Profile = { profile: "foundry-iq"; activated: boolean; blockers: string[] };
type Me = { identity: UserIdentity; workspaceId: string; workspaceName: string; projectEndpoint: string; modelDeployment: string; vendorProcessingApproved: boolean; roster: string[] };
type DriveResource = Resource & { syncState: string; sourceRevision?: number; aclRevision?: number; knowledge_parse_state: string; knowledge_filing_state: string };
export type FoundryRun = {
  id: string; state: string; kind: string; errorCode?: string;
  evidenceMode?: "raw" | "combined" | "native-kb";
  run: RunSnapshot | null; result: { answer?: string; evidence?: Evidence[]; pageId?: string } | null;
};
const request = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export default function FoundryApp({ profile }: { profile: Profile }) {
  const [me, setMe] = useState<Me | null>(null);
  const [resources, setResources] = useState<DriveResource[]>([]);
  const [pages, setPages] = useState<WikiRevision[]>([]);
  const [runs, setRuns] = useState<FoundryRun[]>([]);
  const [tab, setTab] = useState("library");
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [createdAfter, setCreatedAfter] = useState("");
  const [createdBefore, setCreatedBefore] = useState("");
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [fileTypes, setFileTypes] = useState<NonNullable<SearchFilters["fileTypes"]>>([]);
  const [evidenceMode, setEvidenceMode] = useState<"raw" | "combined">("combined");
  const [wikiId, setWikiId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; locator?: SourceLocator; originals?: { name: string; locator: SourceLocator }[] } | null>(null);
  const refreshVersion = useRef(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sharing, setSharing] = useState<Resource | null>(null);
  const [stalePages, setStalePages] = useState<{ pageId: string; documentIds: string[] }[]>([]);
  const [pending, setPending] = useState<{ id: string; parse: string; filing: string; nativeSync: string }[]>([]);
  const { dark, toggle } = useTheme();
  const clear = useCallback(() => { refreshVersion.current++; setResources([]); setPages([]); setRuns([]); setFocus(null); setWikiId(null); setSharing(null); setStalePages([]); setPending([]); setSelected([]); setFolderIds([]); setQuestion(""); }, []);
  const fail = useCallback((error: unknown) => { clear(); setError(error instanceof Error ? error.message : "Current authorization could not be verified"); }, [clear]);
  const refresh = useCallback(async () => {
    if (!me) return;
    const version = ++refreshVersion.current;
    try {
      const [nextResources, nextPages, nextRuns, nextStale, status] = await Promise.all([
        api<DriveResource[]>("/resources", { notify: false }),
        api<WikiRevision[]>("/foundry/wiki", { notify: false }),
        api<FoundryRun[]>("/foundry/requests", { notify: false }),
        api<{ pageId: string; documentIds: string[] }[]>("/foundry/wiki-stale", { notify: false }),
        api<{ ownerOnlyPending: typeof pending }>("/foundry/status", { notify: false }),
      ]);
      if (version !== refreshVersion.current) return;
      setResources(nextResources); setPages(nextPages); setRuns(nextRuns); setError("");
      setStalePages(nextStale);
      setPending(status.ownerOnlyPending);
      setFocus((previous) => previous && nextResources.some((row) => row.id === previous.id && row.syncState === "verified" &&
        (!previous.locator || (row.sourceRevision === previous.locator.sourceRevision && row.aclRevision === previous.locator.aclRevision))) ? previous : null);
      setSelected((previous) => previous.filter((id) => nextResources.some((row) => row.id === id)));
      setFolderIds((previous) => previous.filter((id) => nextResources.some((row) => row.id === id)));
      setWikiId((previous) => nextPages.some((page) => page.pageId === previous) ? previous : null);
    } catch (error) { if (version === refreshVersion.current) fail(error); }
  }, [me, fail]);
  useEffect(() => {
    if (profile.activated) void api<Me>("/foundry/me", { notify: false }).then(setMe).catch(fail);
    const expired = () => { setMe(null); clear(); };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, [profile.activated, clear, fail]);
  useEffect(() => {
    if (!me) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [me, refresh]);
  const mutate = async (path: string, method: string, body?: unknown) => {
    setError("");
    try { const result = await api<unknown>(path, request(method, body)); await refresh(); return result; }
    catch (error) { fail(error); return undefined; }
  };
  const original = async (key: string) => {
    try {
      const citation = await api<{ originals: { name: string; locator: SourceLocator }[] }>(`/foundry/citations/${key}`);
      if (!citation.originals.length) throw new Error("Original source locator unavailable");
      const locator = citation.originals[0].locator;
      setFocus({ id: locator.documentId, locator, originals: citation.originals });
    } catch (error) { fail(error); }
  };
  const ask = async (kind: string) => {
    if (!me || !question.trim()) return;
    await mutate(`/foundry/requests/${kind}`, "POST", { question,
      scope: { workspaceId: me.workspaceId, documentIds: kind === "native-agent" ? [] : selected,
        folderIds: kind === "native-agent" ? [] : folderIds, fileTypes: kind === "native-agent" ? [] : fileTypes,
        ...(kind === "answer" && evidenceMode === "raw" ? { contentKind: "raw" } : {}),
        ...(kind !== "native-agent" && createdAfter ? { createdAfter } : {}),
        ...(kind !== "native-agent" && createdBefore ? { createdBefore } : {}) }, parentId: null });
    setQuestion("");
  };
  const items: FileSystemItem[] = resources.map((row) => row.kind === "folder"
    ? { kind: "folder", path: row.id, parentPath: row.parent_id ?? "", name: row.name, pinned: row.pinned, access: row.access }
    : { kind: "file", path: row.id, key: row.id, parentPath: row.parent_id ?? "", name: row.name, contentType: row.mime,
      access: row.access, size: row.size, metadata: { status: row.syncState === "verified" ? "ready" : "processing" } });
  const setup = (
    <section className="mx-auto max-w-3xl space-y-5 p-8">
      <h1 className="text-2xl font-semibold">Jevbox + Foundry IQ</h1>
      <p>Entra-native document drive, source-cited Q&amp;A and human-reviewed knowledge. This fork is not an official Microsoft or Extend product.</p>
      {!profile.activated ? <><h2 className="font-semibold">Activation blocked</h2>
        <ul className="list-disc space-y-2 pl-5">{profile.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        <p>No legacy login, API-key/MCP gateway, JEV answer retrieval, Azure calls, uploads or vendor processing are enabled in this profile.</p>
        <p>Offline startup and UI are available. Real Entra sign-in, native two-user permissions and billable services remain separately approval-gated.</p></>
        : <><p>Project: <code>{me?.projectEndpoint}</code></p><p>Answer/wiki deployment: <code>{me?.modelDeployment}</code></p>
          <p>Parsing, JEV organization, embeddings and verified native indexing are separate stages.</p>
          <p>Native MCP has no REST activity envelope. Missing usage is unavailable, not zero.</p>
          <p>ACL changes remain pending until native positive/denied queries verify both users. Previously delivered data cannot be recalled.</p></>}
      {!me && profile.activated && <Button render={<a href="/api/entra/login" />}>Sign in with Entra</Button>}
      {me && <table className="w-full text-sm"><thead><tr><th>Source</th><th>Parse</th><th>JEV filing</th><th>Native synchronization</th></tr></thead>
        <tbody>{resources.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.knowledge_parse_state}</td><td>{row.knowledge_filing_state}</td><td>{row.syncState}</td></tr>)}</tbody></table>}
    </section>
  );
  if (!profile.activated || !me) return <div className="min-h-screen bg-background text-foreground">{error && <p role="alert" className="p-4 text-destructive">{error}</p>}{setup}</div>;
  const activeRuns = runs.map((run) => run.run).filter((run): run is RunSnapshot => !!run);
  return (
    <><div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col gap-3 border-r p-4">
        <strong>Jevbox + Foundry IQ</strong>
        {["library", "chat", "knowledge", "native-agent", "setup"].map((name) => <Button key={name} variant={tab === name ? "secondary" : "ghost"} onClick={() => { setTab(name); setFocus(null); }}>{name === "knowledge" ? "Knowledge / Wiki" : name.replace("-", " ")}</Button>)}
        <p className="mt-auto break-all text-xs">Entra OID: {me.identity.objectId}</p>
        <Button variant="ghost" onClick={toggle}>{dark ? "Light" : "Dark"} theme</Button>
        <Button variant="ghost" onClick={() => { void mutate("/entra/logout", "POST").then(() => { setMe(null); clear(); }); }}>Sign out</Button>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {error && <p role="alert" className="bg-destructive/10 p-3 text-destructive">{error}</p>}
        {notice && <p role="status" className="border-b p-3">{notice}</p>}
        <RunConsoleDock runs={activeRuns}>
          <div className="flex h-full min-h-0">
            <div className="min-w-0 flex-1 overflow-auto">
              {tab === "setup" ? setup : tab === "library" ? <>
                <div className="flex items-center gap-3 border-b p-3">
                  <label className="cursor-pointer rounded border px-3 py-2">Upload synthetic source
                    <input className="sr-only" type="file" accept=".txt,.md,.json,.pdf" onChange={(event) => {
                      const file = event.target.files?.[0]; if (!file) return;
                      const form = new FormData(); form.append("file", file); if (path) form.append("parentId", path);
                      void api("/foundry/documents", { method: "POST", body: form }).then(() => { setNotice("Parsing and native indexing are pending; this is not retrieval readiness."); void refresh(); }).catch(fail);
                      event.target.value = "";
                    }} />
                  </label>
                  <Button onClick={() => {
                    const name = window.prompt("Folder name"); if (name) void mutate("/foundry/folders", "POST", { name, parentId: path || null, access: "restricted" });
                  }}>New folder</Button>
                </div>
                {pending.length > 0 && <div role="status" className="border-b p-3 text-sm">Owner-only processing status (titles/content are blocked): {pending.map((item) => <p key={item.id}>{item.id} · parse {item.parse} · filing {item.filing} · native {item.nativeSync}</p>)}</div>}
                <FileSystem items={items} path={path} onPathChange={setPath} title="Synthetic knowledge drive"
                  onFileOpen={(file) => setFocus({ id: file.key ?? file.path })}
                  onShare={(item) => setSharing(resources.find((row) => row.id === (item.kind === "file" ? item.key ?? item.path : item.path)) ?? null)}
                  canShare={(item) => resources.some((row) => row.id === (item.kind === "file" ? item.key ?? item.path : item.path) && row.canShare)}
                  getFileUrl={(file) => `/api/documents/${file.key ?? file.path}/content`}
                  loadDocumentStructure={async (file) => {
                    const resource = await api<Resource>(`/resources/${file.key ?? file.path}`, { notify: false });
                    return resource.parsed ? { sections: resource.parsed.nodes, blocks: resource.parsed.blocks ?? [] } : null;
                  }}
                  onPin={(folder, pinned) => { void mutate(`/foundry/resources/${folder.path}`, "PATCH", { pinned }); }}
                  canPin={(folder) => resources.some((row) => row.id === folder.path && row.canWrite)}
                  onMove={(item, parentId) => { void mutate(`/foundry/resources/${item.kind === "file" ? item.key ?? item.path : item.path}`, "PATCH", { parentId }); }}
                  getMoveDestinations={() => [{ id: null, label: "Root" }, ...resources.filter((row) => row.kind === "folder" && row.canWrite).map((row) => ({ id: row.id, label: row.name }))]}
                />
              </> : tab === "knowledge" ? <div className="flex h-full">
                <nav className="w-56 shrink-0 space-y-2 border-r p-3">{pages.map((page) => <button key={page.pageId} className="block w-full rounded p-2 text-left hover:bg-muted" onClick={() => setWikiId(page.pageId)}>{page.title}<small className="block">{page.state} · revision {page.revision}</small></button>)}
                  {stalePages.map((page) => <div key={page.pageId} className="rounded border p-2"><p>Stale page: original sources changed. Old text/citations are unavailable.</p><Button variant="ghost" onClick={() => { void mutate("/foundry/requests/wiki-draft", "POST", {
                    question: "Regenerate a source-backed knowledge page from the current selected originals.", regeneratePageId: page.pageId,
                    scope: { workspaceId: me.workspaceId, documentIds: page.documentIds, folderIds: [], fileTypes: [] }, parentId: null,
                  }); }}>Generate new revision</Button></div>)}
                  {!pages.length && <p>No authorized current pages. Generate a draft from chat; stale or synchronizing dependencies are hidden.</p>}</nav>
                {wikiId ? <WikiEditor key={wikiId} pageId={wikiId} onNavigate={setWikiId} onEvidence={original} onSaved={refresh} onError={fail} onShare={setSharing} /> : <p className="p-6">Choose a page to edit, inspect original evidence, review, compare revisions or publish.</p>}
              </div> : <section className="mx-auto max-w-3xl space-y-5 p-6">
                <h1 className="text-xl font-semibold">{tab === "native-agent" ? "Native Foundry agent consumer" : "Source-cited chat"}</h1>
                <p className="text-sm text-muted-foreground">{tab === "native-agent" ? "The agent calls the same KB through native knowledge_base_retrieve. No duplicate REST query or fabricated native trace." : "IQ extracts hybrid evidence; the configured Foundry Project model authors one answer. Generated knowledge stays draft until human review."}</p>
                {runs.filter((run) => run.kind === (tab === "native-agent" ? "native-agent" : "answer")).map((run) => <article key={run.id} className="rounded-lg border p-4">
                  <small>{run.state}{run.errorCode ? ` · ${run.errorCode}` : ""} · {run.kind === "native-agent" ? "Native agent: shared KB (no REST scopes)" : run.evidenceMode === "raw" ? "Raw sources" : "Raw + reviewed knowledge"}</small>
                  {run.result?.answer && <div onClick={(event) => {
                    const target = event.target instanceof Element ? event.target.closest("a") : null;
                    const href = target?.getAttribute("href"); if (!href?.startsWith("#fiq-evidence-")) return;
                    event.preventDefault(); void original(href.slice(14));
                  }}><Markdown>{run.result.answer.replace(/\[([A-Za-z0-9_-]+)\]/g, (marker, key: string) => run.result?.evidence?.some((unit) => unit.indexKey === key) ? `[source](#fiq-evidence-${key})` : marker)}</Markdown></div>}
                  <div className="mt-3 flex flex-wrap gap-2">{run.result?.evidence?.map((unit) => <button className="chat-source-chip" key={unit.indexKey} onClick={() => { void original(unit.indexKey); }}>{unit.title}<small>{unit.contentKind === "wiki" ? "curated → originals" : unit.locator.page === null ? "section (no original page)" : `p. ${unit.locator.page}`}</small></button>)}</div>
                  {["queued", "working"].includes(run.state) && <Button variant="ghost" onClick={() => { void mutate(`/foundry/requests/${run.id}`, "DELETE"); }}>Cancel</Button>}
                </article>)}
                {tab !== "native-agent" && <fieldset className="rounded border p-3"><legend>Optional document / upload-date scope</legend>
                  <label className="mb-3 block">Chat evidence mode<select className="ml-2 rounded border bg-background p-2" value={evidenceMode} onChange={(event) => setEvidenceMode(event.target.value === "raw" ? "raw" : "combined")}>
                    <option value="combined">Raw + reviewed knowledge</option><option value="raw">Raw sources</option>
                  </select></label>
                  <label className="mr-3">Uploaded after (UTC)<input type="date" value={createdAfter} onChange={(event) => setCreatedAfter(event.target.value)} /></label>
                  <label>Uploaded before, inclusive (UTC)<input type="date" value={createdBefore} onChange={(event) => setCreatedBefore(event.target.value)} /></label>
                  {resources.filter((row) => row.kind === "document" && row.syncState === "verified").map((row) => <label key={row.id} className="mr-4 inline-flex items-center gap-2">
                  <input type="checkbox" checked={selected.includes(row.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.id].slice(0, 8) : current.filter((id) => id !== row.id))} />{row.name}</label>)}
                  <div className="mt-3"><strong>Folder descendants</strong>{resources.filter((row) => row.kind === "folder").map((row) => <label key={row.id} className="ml-3 inline-flex items-center gap-2">
                    <input type="checkbox" checked={folderIds.includes(row.id)} onChange={(event) => setFolderIds((current) => event.target.checked ? [...current, row.id].slice(0, 8) : current.filter((id) => id !== row.id))} />{row.name}</label>)}</div>
                  <div className="mt-3"><strong>Original file types</strong>{searchFiltersSchema.shape.fileTypes.unwrap().element.options.map((type) => <label key={type} className="ml-3 inline-flex items-center gap-2">
                    <input type="checkbox" checked={fileTypes.includes(type)} onChange={(event) => setFileTypes((current) => event.target.checked ? [...current, type] : current.filter((value) => value !== type))} />{type}</label>)}</div>
                  <p className="mt-2 text-xs">Every original dependency of a curated result must match this scope. Dates are application upload dates, not file creation dates.</p>
                </fieldset>}
                <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void ask(tab === "native-agent" ? "native-agent" : "answer"); }}>
                  <label className="block" htmlFor="foundry-question">Question / draft topic</label>
                  <textarea id="foundry-question" className="min-h-24 w-full rounded border bg-background p-3" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={4000} required />
                  <Button type="submit">Ask {tab === "native-agent" ? "native agent" : "IQ + Foundry"}</Button>
                  {tab !== "native-agent" && <Button type="button" variant="secondary" onClick={() => { void ask("wiki-draft").then(() => { setNotice("Draft generation queued. Human review and publication are still required."); }); }}>Generate wiki draft</Button>}
                </form>
              </section>}
            </div>
            {focus && <aside className="w-[42%] min-w-80 border-l">
              {focus.originals && focus.originals.length > 1 && <label className="block border-b p-3">Cited originals
                <select aria-label="Choose cited original" value={`${focus.locator?.documentId}:${focus.locator?.passageId}`} onChange={(event) => {
                  const original = focus.originals?.find((item) => `${item.locator.documentId}:${item.locator.passageId}` === event.target.value);
                  if (original) setFocus({ ...focus, id: original.locator.documentId, locator: original.locator });
                }}>{focus.originals.map((item) => <option key={`${item.locator.documentId}:${item.locator.passageId}`} value={`${item.locator.documentId}:${item.locator.passageId}`}>{item.name} · {item.locator.sectionPath.join(" / ")}</option>)}</select>
              </label>}
              {resources.find((row) => row.id === focus.id)?.canWrite && <label className="block cursor-pointer border-b p-3">Replace synthetic source
                <input className="sr-only" type="file" accept=".txt,.md,.markdown,.json,.pdf" onChange={(event) => {
                  const file = event.target.files?.[0]; if (!file) return;
                  const form = new FormData(); form.append("file", file);
                  void api(`/foundry/documents/${focus.id}`, { method: "PUT", body: form })
                    .then(() => { setNotice("Replacement is pending. Old derived knowledge is stale until regenerated and reviewed."); void refresh(); }).catch(fail);
                  event.target.value = "";
                }} />
              </label>}
              <DocumentView key={`${focus.id}:${focus.locator?.sourceRevision ?? ""}`}
              documentId={focus.id} initialNode={focus.locator?.nodeId} focusBlockIds={focus.locator?.blocks.map((block) => block.id)}
              focusPage={focus.locator?.page ?? undefined} initialTab="parsed" embedded userId={me.identity.objectId}
              onNavigate={() => {}} onBack={() => setFocus(null)} onShare={() => setNotice("Sharing uses direct configured Entra OIDs and verified native ACL synchronization.")}
              onChange={() => { void refresh(); }} /></aside>}
          </div>
        </RunConsoleDock>
      </main>
    </div>
    {sharing && <EntraSharing resource={sharing} roster={me.roster} onClose={() => setSharing(null)} onError={fail} onPending={async () => { setNotice("Permission changes are pending native raw/wiki verification."); await refresh(); }} />}</>
  );
}
