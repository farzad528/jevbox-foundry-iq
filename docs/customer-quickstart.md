# Local Jevbox + Foundry IQ customer journey

The intended outcome is a customer selecting documents, browsing them in Jevbox's 3D drive,
asking Foundry IQ a question, and checking the original evidence. There is one
retrieval engine: the existing Foundry IQ knowledge base over the application-owned
native-ACL Search index. These imports do not create File/Blob knowledge sources,
a Google-native IQ connector, a second retrieval service or an authorization gateway.

## Launch

1. Download/clone this fork and install Node.js 24.6+ if it is not already present.
2. On Windows open `start-foundry.cmd`. On macOS/Linux run
   `node scripts/launch-foundry.ts`. Alternatively use `pnpm start:foundry`.
3. Open **http://localhost:4387** and keep the launch terminal open. Ctrl+C stops
   the application. Missing pinned dependencies are installed in the checkout,
   not globally. The launcher forces loopback binding and the Foundry profile;
   an existing, conflicting `APP_ORIGIN` must be corrected explicitly.

Downloading a repository is not permission to process data or incur cloud charges.
There is no hosted application, automatic Azure provisioning or background source
sync. A web link cannot execute local software without a download/run step.

## Connect the Foundry environment once

Use the [existing operator setup](foundry-iq.md) for the isolated PostgreSQL
database, private runtime configuration, Entra identities/consent, models and
native Search objects. `FOUNDRY_CONFIG_FILE` and secrets stay in ignored private
files/environment variables. Keep actual endpoints, identities and proof out of
repository examples.

The launch screen shows **Connect local files** and **Connect Google Drive**
alongside the prerequisites and blockers. Before activation/sign-in, these buttons
explain the required setup; they do not select files, connect accounts or simulate
an import. The application never constructs
database/cloud clients when activation is blocked. The native proof requirement
and adverse-token checks are unchanged; launching/import UI cannot override them.
If a required native check remains unverified, the live journey remains blocked.
Both configured users must also have current sessions for per-source native ACL
verification; an accepted import is not a ready-to-query document.

Selected customer data requires additional explicit operator approval in the
private runtime JSON:

```json
"imports": {
  "selectedDataApproved": false,
  "googleDriveApproved": false
}
```

Only set these true after approval for the exact data/Google connection and
processing destination. Existing `syntheticUploads` approval is not customer-data
consent. The user must also review and confirm each import in the UI.

## Connect local files or a folder

Open **Connect data** and click **Connect local files** for individual files, or
**Choose local folder** to retain a folder hierarchy. Check the individual files to import.
Nothing is preselected. Review the selection and authorize processing, then click
**Ingest selected local files into Foundry IQ**. The configured knowledge-base
destination is displayed before ingestion. Each receipt reports pending, unchanged or failed.
Unsupported/hidden files are shown but cannot be selected.

Text (`.txt`), Markdown (`.md`, `.markdown`) and JSON decode locally. PDF requires
the already-supported, separately approved Extend parser and credentials; it is
never simulated or replaced with another extraction service. No JEV credential
is required for these manually placed imports: their pinned root/placement is
preserved. Existing optional JEV organization is not a retrieval dependency.

The first version accepts 40 files per selection, 8 MiB per file and 32 MiB total.
Only relative folder paths are retained, never absolute workstation paths.
Folder hierarchy is preserved under a private pinned import root. Individual-file
selections use a private **Local files** collection and relative paths such as
`Local files/notes.md`; duplicate relative paths are refused. Refresh a collection
using the same selection method/root; choose a new import for a different root.

## Select Google Drive files

The operator must configure an approved Google Cloud OAuth **web application**
client, enable the Drive and Google Picker APIs, and register the exact redirect:
`http://localhost:4387/api/foundry/google/callback` (adjust only for an explicitly
selected local port). Put `GOOGLE_DRIVE_CLIENT_ID` and
`GOOGLE_DRIVE_CLIENT_SECRET` in private environment configuration, never in the
runtime example or browser. No API/developer key is used by the redirect picker.
Google consent-screen/test-user/publishing requirements are the operator's
responsibility; this application does not create Google projects or credentials.

Choose **Connect Google Drive**, authorize the selected-file
`https://www.googleapis.com/auth/drive.file` scope in Google's picker, and select
files. Back in Jevbox, review and click **Ingest selected Google files into Foundry IQ**.
Only selected IDs
are read; there is no Drive listing/crawl, Drive-wide scope, write/delete request
or automatic import on callback. The provider's `drive.file` scope itself permits
per-file modification; this connector only uses read/export calls.

Select files *inside* Google folders. Folder recursion, shortcuts, Sheets, Slides
and arbitrary formats are not supported. Text, Markdown, JSON and approved PDFs
are supported; Google Docs use a plain-text export with an explicit export
locator, not invented original page numbers/geometry. Metadata versions are
checked before and after download; changed sources require reselection.

Authorization uses session-bound state and PKCE. Access tokens stay only in
bounded server memory for at most ten minutes; no refresh token is requested or
stored. Tokens are not put in URLs, browser storage, queue payloads, traces or
source records. Restart/expiry requires fresh authorization. Denied downloads and
incompatible responses fail visibly; there is no ambient-account fallback.

Google documentation for this implementation:
[redirect picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker),
[selected-file scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads).
Actual Google consent/download and Azure retrieval remain live acceptance work,
not claims established by synthetic transport tests.

## Wait for ingestion, explore in 3D, ask, and refresh

Imports use the existing durable, session-bound source/ACL outbox and workers.
Parse/native status is visible without disclosing pending titles/content.
After every accepted file in a successful selection has verified native
synchronization, Jevbox rechecks current resource access and automatically opens
that import root in the existing **3D** library. A `202` receipt, completed parsing,
partial indexing or failed item does not trigger automatic navigation. Connections
show verified/total and failed counts. **View verified files in 3D** is an explicit
alternative for partially ready collections; pending/unauthorized documents remain
hidden. Reloading preserves connections and status, not an in-flight auto-open intent.

The spatial view is Jevbox's document/folder visualization, not an IQ retrieval
graph or embedding visualization. The original camera controls, document outlines
and source previews are retained; other library views remain selectable. A browser
without WebGL shows the existing explicit 3D-unavailable message.

**Open document library** and **Ask a source-cited question** become available
when an imported item has verified native synchronization. Import/3D navigation does not
automatically ask questions or incur an extra retrieval/model-generation run.

Imports are private to the importing Entra identity by default. Google ACLs do not
become Entra grants. Use the existing direct-user sharing controls and native ACL
synchronization if sharing is intended. Source snapshots/provenance remain
guarded by the same current source revision and permissions as other originals.

**Refresh** means selecting the folder/files again and confirming. Existing
connection + relative path (local) or Google file ID preserves the document ID;
healthy unchanged bytes do not create another revision or indexing job. Refresh
of a failed item explicitly retries native synchronization under the current
session without inventing a source revision; that retry can incur processing
charges. Changed bytes
retain the old original, create a source revision, block stale local reads and
invalidate dependent wiki knowledge through the existing lifecycle. Renamed local
paths are new items. Unselected, deleted, or newly inaccessible upstream files are
not automatically removed or revoked from the stored snapshot; this is not
continuous synchronization or a promise of current upstream ACL enforcement.

The existing chat **Raw sources / Raw + reviewed knowledge** selector makes
explicit comparisons possible without automatic extra runs. The native agent
remains separately labeled KB-only.

## What is not complete

This is an implemented local launch/import journey, not a one-click provisioned
or live-verified service. Completing a real customer demo still requires approved
Azure/Entra infrastructure and RBAC, a genuine current native proof, approved data
processing and optional Google/vendor credentials/consent. Tests with synthetic
Google/Azure transports do not establish any of those live outcomes.
