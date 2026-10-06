import { useEffect, useState } from "react";
import { api, type Resource } from "../lib/api";
import { Button } from "./coss/button";
import { Dialog, DialogPopup, DialogTitle } from "./coss/dialog";

export function EntraSharing({ resource, roster, onClose, onPending, onError }: {
  resource: Resource; roster: string[]; onClose: () => void;
  onPending: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [grants, setGrants] = useState<{ objectId: string; role: "viewer" | "editor" }[]>([]);
  const [access, setAccess] = useState<"restricted" | "inherit">(resource.access === "inherit" ? "inherit" : "restricted");
  useEffect(() => { void api<typeof grants>(`/foundry/resources/${resource.id}/grants`).then(setGrants).catch(onError); }, [resource.id]);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogPopup className="space-y-4 p-6">
    <DialogTitle>Direct Entra sharing: {resource.name}</DialogTitle>
    <p>Restricted ancestors remain upper bounds. No groups, directory lookup, public links or cross-tenant access.</p>
    <select aria-label="Access mode" value={access} onChange={(event) => setAccess(event.target.value === "inherit" ? "inherit" : "restricted")} className="rounded border bg-background p-2"><option value="restricted">Direct users</option><option value="inherit">Inherit folder access</option></select>
    {roster.map((oid) => <div key={oid} className="flex items-center gap-3"><label className="flex min-w-0 items-center gap-2"><input type="checkbox" disabled={resource.owner_id === oid || access === "inherit"} checked={resource.owner_id === oid || grants.some((grant) => grant.objectId === oid)} onChange={(event) => {
      setGrants(event.target.checked ? [...grants, { objectId: oid, role: "viewer" }] : grants.filter((grant) => grant.objectId !== oid));
    }} /><span className="break-all text-xs">{oid}{resource.owner_id === oid ? " (owner)" : ""}</span></label>
      {resource.owner_id !== oid && grants.some((grant) => grant.objectId === oid) && <select aria-label={`Role for ${oid}`} value={grants.find((grant) => grant.objectId === oid)?.role} onChange={(event) => setGrants(grants.map((grant) => grant.objectId === oid ? { ...grant, role: event.target.value === "editor" ? "editor" : "viewer" } : grant))} className="rounded border bg-background p-2"><option value="viewer">Viewer</option><option value="editor">Editor</option></select>}</div>)}
    <p className="text-sm">Sharing is pending until raw/wiki ACL writes and native two-user checks verify it. Local source reads are blocked during synchronization; previously delivered data cannot be recalled.</p>
    <Button onClick={() => { void api(`/foundry/resources/${resource.id}`, { method: "PATCH", body: JSON.stringify({ access, grants }) }).then(onPending).then(onClose).catch(onError); }}>Synchronize permissions</Button>
  </DialogPopup></Dialog>;
}
