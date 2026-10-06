import { useEffect, useState } from "react";
import { api, type Resource } from "../lib/api";
import type { Evidence } from "../../shared/evidence";
import type { WikiRevision } from "../../server/wiki/provenance";
import { Markdown } from "./common";
import { Button } from "./coss/button";

export function WikiEditor({ pageId, onEvidence, onSaved, onError, onNavigate, onShare }: {
  pageId: string; onEvidence: (key: string) => Promise<void>;
  onSaved: () => Promise<void>; onError: (error: unknown) => void; onNavigate: (id: string) => void;
  onShare: (resource: Resource) => void;
}) {
  const [page, setPage] = useState<WikiRevision | null>(null);
  const [history, setHistory] = useState<WikiRevision[]>([]);
  const [originals, setOriginals] = useState<Evidence[]>([]);
  const [links, setLinks] = useState<{ related: { pageId: string; title: string }[]; backlinks: { pageId: string; title: string }[] }>({ related: [], backlinks: [] });
  const [comparison, setComparison] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [notice, setNotice] = useState("");
  const [topics, setTopics] = useState<WikiRevision[]>([]);
  const [resource, setResource] = useState<Resource | null>(null);
  const load = async () => {
    const [page, history, originals, links, resource] = await Promise.all([
      api<WikiRevision>(`/foundry/wiki/${pageId}`), api<WikiRevision[]>(`/foundry/wiki/${pageId}/history`),
      api<Evidence[]>("/foundry/evidence"), api<{ related: { pageId: string; title: string }[]; backlinks: { pageId: string; title: string }[] }>(`/foundry/wiki/${pageId}/links`),
      api<Resource>(`/foundry/wiki/${pageId}/resource`),
    ]);
    setPage(page); setHistory(history); setOriginals(originals); setLinks(links); setDirty(false); setReviewed(false);
    setTopics(await api<WikiRevision[]>("/foundry/wiki"));
    setResource(resource);
  };
  useEffect(() => { setPage(null); void load().catch(onError); }, [pageId]);
  if (!page) return <p className="p-6">Loading authorized knowledge revision…</p>;
  const action = async (path: string, body: unknown, method = "POST") => {
    try {
      await api(path, { method, body: JSON.stringify(body) });
      if (path.endsWith("/publish")) setNotice("Publication is pending native index/ACL verification; it is not yet retrievable.");
      else await load();
      await onSaved();
    } catch (error) { onError(error); }
  };
  const compared = history.find((item) => item.revision === comparison);
  return <section className="min-w-0 flex-1 space-y-5 overflow-auto p-6">
    <div className="flex items-center gap-3"><h1 className="text-xl font-semibold">Knowledge editor</h1><span>{page.state} · revision {page.revision}</span></div>
    {resource?.canShare && <Button variant="secondary" onClick={() => onShare(resource)}>Share knowledge page</Button>}
    {!resource?.canWrite && <p>This page is read-only for your current role.</p>}
    {notice && <p role="status">{notice}</p>}
    <label className="block">Title<input className="mt-1 w-full rounded border bg-background p-2" disabled={!resource?.canWrite} value={page.title} onChange={(event) => { setPage({ ...page, title: event.target.value }); setDirty(true); setReviewed(false); }} /></label>
    <p className="text-sm text-muted-foreground">Draft text is untrusted data, not executable agent policy. Every claim retains original source/revision evidence. Edits create a new draft and clear review.</p>
    {page.claims.map((claim, index) => <article key={claim.id} className="space-y-3 rounded border p-4">
      <label className="block">Claim {index + 1}<textarea className="mt-1 min-h-24 w-full rounded border bg-background p-2" disabled={!resource?.canWrite} value={claim.text} onChange={(event) => {
        setPage({ ...page, claims: page.claims.map((current) => current.id === claim.id ? { ...current, text: event.target.value } : current) }); setDirty(true); setReviewed(false);
      }} /></label>
      <Markdown>{claim.text}</Markdown>
      <div className="flex flex-wrap gap-2">{claim.evidence.map((dependency) => <button key={dependency.evidenceId} className="chat-source-chip" onClick={() => { void onEvidence(dependency.evidenceId); }}>
        {dependency.locator.sectionPath.join(" / ")}<small>source r{dependency.locator.sourceRevision} · {dependency.locator.page === null ? "original page unavailable" : `p. ${dependency.locator.page}`}</small>
      </button>)}</div>
      <label className="block text-sm">Add/replace supporting original
        <select className="ml-2 max-w-full rounded border bg-background p-2" disabled={!resource?.canWrite} defaultValue="" onChange={(event) => {
          const unit = originals.find((unit) => unit.indexKey === event.target.value);
          if (unit?.contentKind !== "raw") return;
          setPage({ ...page, claims: page.claims.map((current) => current.id === claim.id ? { ...current, evidence: [{ evidenceId: unit.indexKey, locator: unit.locator }] } : current) });
          setDirty(true); setReviewed(false);
        }}><option value="">Select current evidence</option>{originals.map((unit) => <option key={unit.indexKey} value={unit.indexKey}>{unit.title} · {unit.contentKind === "raw" ? unit.locator.sectionPath.join(" / ") : ""}</option>)}</select>
      </label>
    </article>)}
    <Button disabled={!dirty || !resource?.canWrite} onClick={() => { void action(`/foundry/wiki/${pageId}`, { revision: page.revision, title: page.title, claims: page.claims, relatedPageIds: page.relatedPageIds }, "PATCH"); }}>Save new draft revision</Button>
    <label className="flex items-center gap-2"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} disabled={!resource?.canWrite || dirty || page.state !== "draft"} />I verified every claim against the original sources.</label>
    <div className="flex gap-3"><Button disabled={!resource?.canWrite || dirty || !reviewed || page.state !== "draft"} onClick={() => { void action(`/foundry/wiki/${pageId}/review`, { revision: page.revision, acknowledged: true }); }}>Record human review</Button>
      <Button disabled={!resource?.canWrite || dirty || page.state !== "reviewed"} onClick={() => { void action(`/foundry/wiki/${pageId}/publish`, { revision: page.revision }); }}>Publish reviewed revision</Button></div>
    <section className="space-y-2 border-t pt-4"><h2 className="font-semibold">Revision comparison</h2>
      <select aria-label="Compare revision" className="rounded border bg-background p-2" value={comparison ?? ""} onChange={(event) => setComparison(event.target.value ? Number(event.target.value) : null)}>
        <option value="">Choose an authorized revision</option>{history.map((item) => <option key={item.revision} value={item.revision}>Revision {item.revision} · {item.state}</option>)}</select>
      {compared && <div className="grid grid-cols-2 gap-4"><div><strong>Revision {compared.revision}</strong>{compared.claims.map((claim) => <p key={claim.id} className="my-2 whitespace-pre-wrap">{claim.text}</p>)}</div><div><strong>Current draft</strong>{page.claims.map((claim) => <p key={claim.id} className="my-2 whitespace-pre-wrap">{claim.text}</p>)}</div></div>}
    </section>
    <section className="border-t pt-4"><h2 className="font-semibold">Related topics / backlinks</h2>
      <div>{links.related.map((page) => <Button key={page.pageId} variant="ghost" onClick={() => onNavigate(page.pageId)}>{page.title}</Button>)}</div>
      <div>{links.backlinks.map((page) => <Button key={page.pageId} variant="ghost" onClick={() => onNavigate(page.pageId)}>{page.title}</Button>)}</div>
      {topics.filter((topic) => topic.pageId !== pageId).map((topic) => <label key={topic.pageId} className="mr-3 inline-flex items-center gap-2"><input type="checkbox" disabled={!resource?.canWrite} checked={page.relatedPageIds.includes(topic.pageId)} onChange={(event) => {
        setPage({ ...page, relatedPageIds: event.target.checked ? [...page.relatedPageIds, topic.pageId] : page.relatedPageIds.filter((id) => id !== topic.pageId) });
        setDirty(true); setReviewed(false);
      }} />{topic.title}</label>)}
    </section>
  </section>;
}
