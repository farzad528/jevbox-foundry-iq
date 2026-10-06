# Jevbox + Foundry IQ PoC

This fork preserves Jevbox's MIT and third-party notices. It is not an official
Microsoft or Extend product. Reviewed upstream:
`29a2ec68fc7b0eb74b3ba1527bf009d40f9fe3bb`.

## Delivery and verification boundary

The guarded local implementation is wired. **The real-Azure PoC is not
live-verified or activated.** Code approval does not approve Azure/Entra changes,
consent, uploads, paid calls, external Parse/JEV processing or resource deletion.

| Surface | Implemented | Verification |
| --- | --- | --- |
| Native profile dispatch | Separate app, auth, routes and worker; no Better Auth/SpiceDB/JEV Q&A fallback | Real blocked local startup and HTTP checks |
| Entra sign-in | MSAL auth-code/PKCE, exact tenant/OID roster, opaque sessions, encrypted user-bound cache, worker refresh and logout | Offline signed-JWT/JWKS tests, including real MSAL APIs with synthetic transport; not real consent |
| Search lifecycle | SQL outbox, generations/leases, per-item results, source replacement/deletion, derived ACL intersection and two-user native verification callback | Complete additive migrations, real router/engine operations and standalone PostgreSQL/pg-boss; Azure transports/auth remain synthetic |
| IQ answers | Hybrid low-effort/extractive requests, strict scopes, one project-model answer, original locators and saved-run fences | Offline transport contract and HTTP/fault tests; actual hybrid/native ACL behavior unverified |
| Wiki | Draft/edit/review/publish, revisions, stale invalidation, related/backlinks, claim-specific originals, full-page dependencies and sharing | Actual repository/routes with PGlite; native publication simulated only in test transports |
| Native agent | Project-managed-identity connection artifacts, required user token, actual MCP-payload normalization, alias ambiguity rejection | Offline consumer tests; no real agent/tool invocation |
| Finder/source/console UI | Existing Finder/3D and DocumentView reused; review editor; source panel on right; default-open bottom console | Real headless Chromium on production assets; active API transports explicitly mocked |
| PostgreSQL + pg-boss | Isolated native schema adapter, real pg-boss queues, shared app/worker startup recovery | PostgreSQL 16.15 opt-in runner passed **8/8 twice**, then again in the combined check; one parent harness + seven scenarios, zero skipped; not activated full-app HTTP startup |
| Extend, JEV and evaluation | Explicit provider integration and conservative upstream filing/pin/manual-placement helpers | Real vendor processing and raw-versus-curated measurements **not run** |

PGlite tests alone do not prove pg-boss operation. The separate opt-in runner
now exercises the extracted production queue runtime and actual engine on
standalone PostgreSQL with synthetic auth/providers. Seeded lease recovery is
not OS-kill/power-loss proof or an operational deployment. Browser mock responses
do not prove backend or Azure authorization.

## Local startup

Use Node 24.6+ and pnpm **12.8.1**. The lockfile requires pnpm 12.

```powershell
npx --yes --package=pnpm@12.8.1 pnpm install --frozen-lockfile
npx --yes --package=pnpm@12.8.1 pnpm dev:foundry
```

Open `http://localhost:4310`. With no `FOUNDRY_CONFIG_FILE`, this starts the
actual Express/Vite application without opening a database or constructing
cloud clients. `/health/live` and `/api/profile` work; readiness and protected/
legacy APIs return blocked responses. The setup screen explains the missing
approval/native proof. `worker:foundry` exits visibly when activation is blocked.

`JEVBOX_PROFILE=legacy` retains upstream behavior and service requirements
separately. In the native profile, old password/OAuth/API-key, anonymous-link,
local MCP gateway and JEV retrieval endpoints are unavailable. This is a
deliberate profile boundary, not a permission-provider fallback.

### After separately approved setup and live proof

Copy `infra\azure\runtime.example.json` to an ignored
`infra\azure\poc.runtime.local.json`. Null placeholders intentionally fail
validation: fill only the approved exact environment, two real user OIDs,
separate service application IDs, model deployments and embedding dimensions.
Do not reuse a legacy database schema or another tenant's native schema.

Set these privately, outside tracked examples:

| Variable | Purpose |
| --- | --- |
| `FOUNDRY_CONFIG_FILE` | Absolute path to ignored private runtime JSON |
| `DATABASE_URL` | Local PostgreSQL; application creates isolated `fiq_...` schema and separate native queue schema |
| `ENCRYPTION_KEY` | Stable 64-hex-character AES-GCM key; preserve securely for encrypted sessions/settings |
| `ENTRA_CLIENT_SECRET` | Approved confidential app for backend auth-code/PKCE and delegated Search consent |
| `FOUNDRY_READER_SECRET` | Separate Search reader service application |
| `FOUNDRY_WRITER_SECRET` | Search ingestion application; never used for queries |
| `FOUNDRY_PROJECT_SECRET` | Project model/answer/wiki/embedding application |
| `APP_ORIGIN`, `PORT` | Exact loopback origin/port; redirect defaults to `/api/entra/callback` |
| `EXTEND_API_KEY`, `JEV_API_KEY` | Optional, only with explicit vendor-processing approval |

No Search key or ambient elevated identity is accepted. Secrets are not runtime
JSON fields. Only necessary user-bound MSAL cache/state is encrypted in the
session tables; jobs carry non-bearer session hashes, never bearer tokens.

The runtime requires explicit `entraConsent`, `cloudCalls` and
`syntheticUploads` approval plus a matching, recent `nativeProof`. Its fields
are defined in `server\foundry\runtime-config.ts`; do not set verification
booleans because offline tests passed. The bounded verifier produces the proof;
it remains an operator-reviewed attestation, not a signed service certificate.
Configuration/proof changes require review.

The early native spike must precede activation. The bounded operator command
below reuses the real MSAL/native clients in a separate loopback server. The
main app never unlocks sign-in by bypassing its proof gate. Provisioning,
fixture ingestion, role repairs and vendor processing are not performed by
the verifier or the offline artifact commands.

### Bounded preactivation operator

Copy `infra\azure\spike.example.json` to an ignored `poc.spike.local.json`.
Fill its `runtime` with the exact approved runtime configuration, keeping
`nativeProof: null`. This is a separate, time-bounded approval: sign-in, the fixed
Cedar synthetic queries, native MCP/agent calls and two project-model probes.
All approval switches must be true and the deadline must be one minute to two
hours away; `maxRequests` bounds outbound verifier HTTP requests (maximum 100).
Model/agent probes cap generated output at 512 tokens and selected corpus text
at 150,000 characters. Server-side native-agent tool work is not a separate
client HTTP count; retain explicit billable-call/cost approval for that work.
No uploads are performed. Use only the already separately approved/ingested
synthetic corpus; absent data is a failed/unverified observation, not a seed job.

`evidence` is the authoritative current evidence manifest for the selected
indexed synthetic passages, including all transitive raw dependencies. Bind
`publicKey` to Launch Plan / Preview scope, `privateRawKey` to Commercial Brief /
Pilot offer and `privateWikiKey` to the published restricted derived claim.
Original text, revision, ACL, locator and indexed metadata are read back and
compared before/after. A-only sources and derived pages must remain A-only.
The questions are the pack's fixed `preview-scope` and `restricted-authorized`
questions, not user/model-generated shell or tool arguments.

Set the existing `ENTRA_CLIENT_SECRET`, `FOUNDRY_READER_SECRET` and
`FOUNDRY_PROJECT_SECRET` privately. The ingestion secret is not used.
Completing definition readback additionally requires `definitionReadback:
{ approved: true, clientId: <separate operator application UUID>, role: "Reader" }`
and private `FOUNDRY_DEFINITION_READER_SECRET`. Obtain separate concrete
identity/credential/role approval first; grant the documented read-only
**Reader** role on only the exact selected Search service. Search Index Data
Reader is intentionally insufficient to view definitions. The operator identity
must differ from every application query, ingestion, model and sign-in identity.
These are configuration inputs, not automatic app registration or role grants.

```powershell
New-Item -ItemType Directory -Force .\.data | Out-Null
node --import tsx scripts\foundry-native-spike.ts .\infra\azure\poc.spike.local.json .\.data\foundry-spike-private
```

The output directory must be new. On Windows its inherited ACL is removed and
access is granted only to the current user's SID; Unix uses owner-only modes.
The command opens the exact configured loopback origin (example port 4388).
Use **separate browser profiles** to sign in both real roster users. Submit the
authenticated, origin/nonce-protected verifier form once both sessions exist.
PKCE/session caches live only in an encrypted disposable PGlite auth store,
not the application database. Tokens never enter configuration, reports,
console output, jobs or HTTP responses.

The three exact index/source/KB definition GETs alone use the approved operator
definition credential, without a user-source header. All original document
readback, REST and MCP queries retain the unchanged Search Index Data Reader
credential plus actual user-source token; model calls retain the project
credential. No definition credential reaches queries, tools or models.
The verifier inspects those definitions and the actual native tool
schema, checks low/extractive requests plus returned hybrid/planning activity,
A/B positive/negative raw and derived access, original extracts and actual
agent tool/citation payloads. Missing/corrupt source credentials must receive
native 401/403. Unknown tool inputs or missing native payloads stay unverified.
Without approved definition input, or if its GETs are denied, the report stays
partial with no proof. There is no query-reader, writer, admin, key or ambient
CLI credential fallback; the verifier never widens any principal's privileges.

To observe **real expiration**, set `waitForExpiredSource: true` and approve a
deadline beyond the actual captured Search token expiry. It waits without
fabricating a signed expired JWT; expiry beyond the two-hour bound stays
unverified. Actual wrong-tenant testing requires a separately approved
`wrongTenant` auth configuration (`tenantId`, bounded two-OID `roster`,
`expectedOid`, `clientId`, distinct loopback `origin`, `approved: true`) and
private `ENTRA_ADVERSE_CLIENT_SECRET`. Only its exact expected user's signed
credential is captured for negative requests; it never becomes an application
reader. Without that session, wrong-tenant native behavior stays unverified.

The private `report.native-proof.local.json` contains redacted observations,
observed tool-input shape and a `nativeProof` **only** after all live checks pass.
Partial, offline, refusal, unsupported schema or missing adverse-token evidence
always leaves proof null and returns a nonzero exit. Review the genuine report
before copying its proof into the private runtime; the verifier never edits or
activates the main configuration. Proof binds the API version, full Search/
knowledge/model configuration, exact agent and every configured client identity.
Any target/deployment/dimension/identity drift requires a new proof.
Live issuance uses a captured, non-injectable native transport. Synthetic
transports cannot be relabeled live; offline observations never issue proof.
The operator server/auth store closes after verification or its deadline.

Development `dev:foundry` embeds native consumers. Do not simultaneously run a
second worker merely for startup. For a production-mode local check, build,
set `NODE_ENV=production` and `JEVBOX_PROFILE=foundry-iq`, then run `pnpm dev`
with a separate `pnpm worker:foundry`. The web entrypoint serves the built SPA
from an explicit `dist` root, including worktrees under hidden parent folders.
This is local startup, not a hosted deployment.

## Approval and infrastructure artifacts

`infra\azure\approval.example.json` contains neutral placeholders only. Keep the
completed approval in an ignored `*.approval.local.json`. Resolve exact tenant,
subscription, group, region, names, owners, models/versions, capacity/dimensions,
network reachability, cost/call limits, identities/consent, synthetic corpus,
retention and cleanup ownership before any operation.

```powershell
node --import tsx scripts\foundry-validate-approval.ts infra\azure\poc.approval.local.json
node --import tsx scripts\foundry-artifacts.ts <verified-private-setup-config> <new-private-output-directory>
```

The validator checks approval flags and distinct identities only; it does not
verify quota, prices, model compatibility or deployment. The artifact command
writes local JSON with exclusive file creation. Keep environment-specific
output in a private/ignored location. Neither command calls Azure.

`infra\azure\main.bicep` prepares a **new isolated** Search service, Foundry
account/project, explicit deployments and roles. No hosted app, storage or
database is deployed. It disables local key authentication. The approved local
profile is public-endpoint reachable; it is not a private-network or production
availability template. Compile it offline; do not treat compilation as consent.

| Principal | Role and scope |
| --- | --- |
| Query application and Project MI | Search Index Data Reader on the selected Search service |
| Separate ingestion application | Search Index Data Contributor on that service |
| Search MI | Cognitive Services User on the Foundry account for planning/vectorizer access |
| Separate local project application | Foundry User on the project for project-bound APIs |

Role GUIDs are pinned in Bicep and `approval-validation.ts`. Foundry User includes
project developer/data capabilities; it is **not** an inference-only role.
Native-agent-only consumers can use the narrower Foundry Agent Consumer role.
Provisioning privileges are separate and not granted to runtime query callers.

Application answer/wiki/embedding calls target
`<projectEndpoint>/openai/v1/...` with `https://ai.azure.com/.default`.
The account model endpoint remains the Search planning/vectorizer endpoint.
Planning deployment/model and embedding model names are required in both the
runtime snapshot and setup-artifact input. Readback must match those exact
selections; planning is not implicitly the answer deployment.

## Evidence, scope and permissions

One application-owned index contains raw and published wiki passages. One
`searchIndex` source and one KB use **2026-08-01-preview**, hybrid retrieval,
explicit semantic/vector configuration, low planning and **extractiveData**.
IQ answer synthesis is rejected; there is no keyword/JEV retrieval fallback.

`userIds` is a filterable `Collection(Edm.String)` with `permissionFilter:
userIds`, containing Entra OIDs, not emails. No `all`, group, anonymous or RBAC
scope broadens the bounded direct-user model. Reader sets intersect every
restricted ancestor; inherited editor rights stop at direct/private boundaries.
UI `canWrite` uses that same policy; sharing remains owner-only.

Raw keys preserve Jevbox document/revision/node/passage identity. Text/Markdown
pages and geometry are **null**. Only parser-supplied original geometry is
accepted. Original bytes and parsed revisions are retained separately.

Wiki permissions and document/folder/type/date scope use **every transitive
raw dependency**, never a union or one selected claim. Claim-specific
`supportingEvidence` is separate: clicking the restore claim opens its runbook
section rather than the page's first launch dependency. Multiple actual
supporting originals are selectable in the right panel.

The index's `rawSourceRefs` complex collection retains application upload time,
document ID, folder ancestry and existing MIME categories. Trusted filters use
nonempty `any()` and complex `all(...)`; they do not use unsupported
inequality/AND string-collection lambdas. Dates reuse inclusive UTC whole-day
upload semantics from `shared\search-filters.ts`, not file creation time or wiki
generation time. No-match scopes remain empty. Authoritative local checks also
reject an out-of-scope native result.

Service `Authorization` and actual user's `x-ms-query-source-authorization` are
distinct. Signed delegated tokens bind issuer/audience/scope/tenant/OID/expiry
to the authenticated session. Missing credentials never substitute a worker or
Project MI. Local resource, original download, citation, wiki, history and run
delivery all retain current permission/revision checks.

## Lifecycle and user flows

Upload synthetic TXT/Markdown/JSON/PDF. Filename MIME normalization supports a
browser Markdown file with empty `File.type`; unsupported binaries do not
become successful text extraction. Local text decoding does not require Extend.
Rich parsing needs explicit vendor consent and real credentials.

Parsing, conservative JEV filing, embeddings and verified Search readiness are
distinct work. Missing vendor approval/credentials is visible. Pins/manual
placement are preserved; filing failure does not silently become success.
Source writes use generations, per-item results, a durable outbox and obsolete
attempt fencing. Native allowed/denied checks require both current real users
before completion. Upload or parse success alone is not retrieval readiness.
Failed answer requests require an explicit new request; automatic queue retries
do not silently regenerate them. Recovery after an observed model/native-agent
start fails interrupted rather than guessing whether another paid call is safe.

Direct sharing/moves fence affected metadata and reads pending raw/wiki native
verification. ACL-only updates rebind locator ACL metadata without changing
human claim text/revisions. Source-content changes invalidate draft/reviewed/
published knowledge; regeneration creates a new draft, not an overwrite.
Deleting a subtree fences all descendant folders, pending documents and
unpublished wiki locations while preserving unrelated siblings.

Chat offers validated document, descendant-folder, file-type and upload-date
scope. Its **Chat evidence mode** defaults to Raw + reviewed knowledge; Raw
sources sends `scope.contentKind: raw`. The persisted run displays that mode.
Changing the control does not run a query automatically. Native-agent mode is
separately labeled shared-KB-only and never receives this REST-only filter.
Generate a draft, edit claims/current original support, record explicit
human review and publish. Publication stays pending until native indexing/ACL
verification. Page sharing cannot broaden any raw-source reader bound.
Related topics/backlinks are authorized navigation, not another retrieval engine.

Native agent scope is explicitly the shared KB, not REST-only attached filters.
The generated connection uses ProjectManagedIdentity and exactly
`allowed_tools: ["knowledge_base_retrieve"]`. Required `search_auth_token` comes
from authenticated server state. Actual MCP JSON-text extracts/locators are
validated; unambiguous `[ref_id]` aliases normalize to stable clickable keys,
and conflicting aliases across tool calls fail. Only cited evidence becomes
supporting-source chips. No extra REST query fabricates an agent trace.

The bottom console is default-open, keyboard-resizable and collapsible. It
shows persisted operational events, not private chain-of-thought. Monotonic
terminal duration is distinct from service activity timings; overlapping spans
are not summed. Missing usage is unavailable/partial, not zero. Application
model steps containing tools are labeled accordingly. Provider failure is
failed; only actual user cancellation is cancelled. Current source/ACL changes
also remove protected previews, saved runs, wiki and console caches.

Native indexed ACL enforcement reflects the metadata Search has applied.
Local transition fences do not guarantee instantaneous external revocation or
recall of already delivered content.

## Reproducible offline checks

```powershell
npx --yes --package=pnpm@12.8.1 pnpm install --frozen-lockfile
npx --yes --package=pnpm@12.8.1 pnpm check
node --import tsx --test tests\foundry-contracts.test.ts tests\foundry-entra.test.ts tests\foundry-lifecycle.test.ts tests\foundry-observability.test.ts tests\foundry-runtime.test.ts tests\foundry-proof.test.ts tests\foundry-spike.test.ts tests\foundry-spike-auth.test.ts
node --import tsx --test tests\foundry-browser.test.ts
npx --yes --package=pnpm@12.8.1 pnpm build
& .\tests\fixtures\validate-customer-evaluation.ps1
az bicep build --file infra\azure\main.bicep --stdout
```

The browser test rebuilds production assets and requires the installed
Playwright Chromium binary. Its initial setup page uses real guarded routes;
its active UI phase explicitly intercepts synthetic API responses and blocks
external network requests. Other native tests refuse nonfixture provider
targets. Relevant upstream unit regressions can run without services; full
upstream integration suites require local PostgreSQL/SpiceDB.

The Cedar pack contains five Markdown originals, one physical two-page PDF,
two wiki scenarios, eleven questions and **seventeen lifecycle cases**.
Structural validation is not application verification. The PDF generation
specification is not parsed evidence; Extend geometry remains unverified.
Fixture IDs must be mapped to actual uploaded application IDs for live runs.

### Opt-in real local PostgreSQL

Set `PG_TEST_BIN` to an explicitly obtained/verified PostgreSQL 16 binary
directory containing `initdb`, `pg_ctl` and `postgres`; no installer or download
is run by the test. Use the exact approved local tools path, for example:

```powershell
$env:PG_TEST_BIN='C:\approved-tools\postgres16\bin'
node --import tsx --test tests\foundry-postgres.test.ts
```

Without that variable the runner reports an explicit **UNVERIFIED skip**, not
a successful PostgreSQL check. With it, the parent harness plus seven scenarios
passed (8 reported tests): all 25 additive migrations/idempotent reopening,
current-user SCRAM and wrong-password rejection, pinned transactions and atomic
resource/original/outbox/pg-boss commit/rollback, actual request consumers,
partial indexing/retry, source/ACL obsolete-attempt fencing, startup recovery
and interrupted paid-generation fencing. The final combined native, UI, queue
and related upstream check passed **95/95 with zero skips**.

Each run owns an access-restricted `.data\foundry-postgres\run-<uuid>` directory,
random loopback-only port and exact PostgreSQL PID. Cleanup validates PID/data
path, stops only that cluster, confirms PID exit and listener refusal, and
removes only its resolved run directory. No database URL/password is logged.
Cleanup covers normal setup/test failures, not abrupt harness termination.

Recovery shuts down actual queues and reopens the database adapter, but
deliberately seeds expired leases at `now() - 1 minute`; it does not kill the OS
process or simulate power loss. Only the disposable test `knowledge-sync`
queue uses a 1-second retry delay without backoff. Production retains five
retries, 15-second delay with backoff, 300-second job expiry, 30-second heartbeat,
and three-minute synchronization/five-minute request leases. Synthetic
transport/auth and proof fixtures never activate the application. Activated
full-app HTTP startup and real service behavior remain separate release gates.

## Live release gates and customer demonstration

Only after concrete approval, inspect exact selected resources/model support,
role scopes, keyless/native ACL schema, KB definition and actual MCP tool schema.
Use two real named users to test missing/expired/wrong-user/wrong-tenant tokens
on REST and MCP, including Microsoft's conflicting omitted-token documentation.
Unexpected native permission behavior blocks release.

Then prove real hybrid low/extractive retrieval, project model calls, original
PDF locators/highlighting, genuine JEV filing, human wiki publication, native
agent consumption, unrelated abstention, restrictive folder bounds, per-item
failure/retry and verified revocation. Also exercise the activated full-app
HTTP web/worker startup and actual service recovery; the standalone extracted
queue-runtime checks above do not prove that integration.

Use the same questions/identities for raw-only (`scope.contentKind: raw`) and
raw-plus-approved-curated runs. Record actual factual support, raw-source
coverage, citation validity, reported token categories, retrieval activity and
measured latency. Do not promise curation improves every metric. Measurements
remain empty and `liveVerificationStatus` remains `not-run`.

Show upload/organization, cited Q&A, reviewed knowledge, reuse through native
MCP, A/B differences, pending-to-verified revocation and source-driven staleness.
These are the remaining real-service proof steps, not claims from offline tests.

## First-party contracts

- [Search-index source](https://learn.microsoft.com/azure/search/agentic-knowledge-source-how-to-search-index)
- [REST and native MCP retrieval](https://learn.microsoft.com/azure/search/agentic-retrieval-how-to-retrieve)
- [Native indexed ACL push](https://learn.microsoft.com/azure/search/search-index-access-control-lists-and-rbac-push-api)
- [Native query enforcement/freshness](https://learn.microsoft.com/azure/search/search-query-access-control-rbac-enforcement)
- [Separate query and definition role permissions](https://learn.microsoft.com/azure/search/search-security-rbac)
- [Collection filter restrictions](https://learn.microsoft.com/azure/search/search-query-troubleshoot-collection-filters)
- [Agent connection and structured input](https://learn.microsoft.com/azure/foundry/agents/how-to/foundry-iq-connect)
- [Project OpenAI client endpoint](https://learn.microsoft.com/python/api/azure-ai-projects/azure.ai.projects.aiprojectclient?view=azure-python)
