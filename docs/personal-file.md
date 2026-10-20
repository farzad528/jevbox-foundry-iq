# Personal local File-KS demo

This is a separate single-user profile. It preserves the guarded shared Foundry
profile and does not establish its two-user native ACL/MCP acceptance.

## Start the actual workspace

Requires Node.js 24.6+. Open `start-personal.cmd` on Windows, or run:

```sh
npm run start:personal
```

Open **http://localhost:4388**. The existing shared setup remains at port 4387.
Startup does not sign in, contact Azure, upload files, provision resources or
generate model answers. Missing dependencies are restored from the pinned lockfile.

1. Click **Connect local files** or **Choose folder**.
2. Review actual names, relative paths and sizes. The actual Jevbox WebGL
   **3D** view shows selected originals immediately, labeled not indexed.
3. Click **Save selected snapshot locally**. This stores an immutable private
   local copy, not an Azure upload. The initial app policy is 40 files,
   8 MiB/file and 32 MiB/batch; native content detection still decides admission.
4. Open documents from the tree or 3D view. **Finder** switches the library view.
5. Open **Connection & approvals** for the next required stage. Until real
   ingestion, KB verification and paid-session approval, chat remains visibly
   disabled. There are no canned answers or silent provider fallbacks.

The first approved live corpus is six fictional Cedar originals and a labeled
image-only OCR probe, selected together from a separate prepared demo folder.
Personal desktop content needs a new exact data-scope approval.

## Operator preparation and chat-only approvals

Keep real configuration and evidence outside source control. Set
`PERSONAL_FILE_CONFIG` to an owner-protected `.runtime.local.json` matching
`personalConfigSchema` in `shared/personal-file.ts`. It contains the already
selected tenant/operator/subscription, exact Search/project IDs/endpoints,
existing deployments/versions, embedding dimensions and verified inherited-CMK
baseline. No keys, secrets, access tokens or generic activation flag are accepted.
Pin `cmkBaselineSource` to the exact existing source used for read-only encryption
comparison, even for an observed null key: disabled CMK enforcement alone does
not prove that optional service-level encryption is absent.

`PERSONAL_FILE_DATA_DIR` defaults to the ignored `.data/personal-file`.
`PERSONAL_FILE_PORT` defaults to 4388. Restart after changing configuration;
do not switch shared Azure CLI login/default subscription. CLI authentication
explicitly selects the configured subscription and verifies tenant/user claims.
It does not pass CLI's mutually exclusive subscription and tenant flags together.
No `DefaultAzureCredential`, managed-identity user substitution or key fallback.

Run scoped, read-only metadata preparation explicitly:

```sh
npm run personal:operator -- preflight
```

This reads only the exact selected resources/deployments and narrowly scoped role
evidence. It proves no capacity, paid inference, OCR or remaining budget. Review
current retail pricing, existing idle Search charges, CU-meter uncertainty,
cross-region processing, GlobalStandard residency and the available balance of
the original total ceiling before proposing spending.

The operator then creates one pending stage proposal using an owner-protected
bounds JSON matching `boundsSchema`. It specifies application request count,
question count, context/output bounds, incremental allowance, remaining budget,
current price evidence and disclosure acknowledgment:

```sh
npm run personal:operator -- plan ingest "<private-bounds.json>"
```

Review the generated exact targets, corpus, modes, managed identity, costs,
deadline, failure retention and private executable envelope **in chat**. Only
after the user's specific approval:

```sh
npm run personal:operator -- approve "<pending-operation-id>" "<human-approval-reference>"
```

The matching app control can now run only that operation. This command is not
permission to execute it before consent. There is no browser approval endpoint.

The stages are **ingest**, **kb**, **chat** and **inspect**, separately approved.
Ingestion conditionally creates the exact absent main File source and its native
index, uploads the disclosed OCR probe first and verifies its indexed marker
before Cedar uploads. The source owns the index: no duplicate index or
`searchIndex` source. KB uses low-effort planning and extractive output. Chat
performs one IQ retrieve and at most one final project-model answer per question.
Its durable allowance is at most ten questions including proof and follow-ups,
not a new allowance per tab/reload. Limits and reserved allowances do not reset
on errors/restart and are not Azure-enforced billing caps.
The context cap conservatively measures the full serialized answer request,
including escaped input, system instructions and schema overhead. Exceeding it
stops before the answer call; any preceding IQ work still consumes its allowance.
Selected model versions are re-read before and after ingestion, KB setup and
answer generation. Auto-upgrade drift stops further work/delivery; it never
silently moves the frozen snapshot onto another model version.

Unknown upload outcomes stay uncertain and are never automatically repeated.
Only a newly reviewed continuation with authoritative app-owned creation/upload
journals may upload never-attempted ordinals. The earlier standalone canary lacks
those original upload records and remains untouched/unverified; do not rebuild
its journals, recreate it or interpret main-workflow proof as its recovery.
Readback permits only the selected service/entity's OData context and the native
File source's empty permission-options default. Nonempty permission settings,
different contexts, CMK overrides and other nondefault drift still stop the run.
The native schema may return null dimensions on non-vector fields. Vector fields
still require positive integer dimensions and the selected embedding size before
any upload.
Index statistics can lag successful synchronous uploads. A separately approved
receipt-backed continuation can recheck completion while skipping every
acknowledged file; never re-upload files to make a delayed counter advance.

## Cited answers and independent provenance

Partial HTTP 206 retrievals and non-null native response/activity errors stop
before the final answer call. Failed attempts still consume their question and
request allowance; they are never converted to an empty-evidence success.
Successful native response/reference/activity payloads are retained in the
protected local catalog for provenance and contract diagnosis, without request
headers or credentials. They are not public logs or a second retrieval.

Native extractive reference IDs may be strings or nonnegative safe integers.
Each reference's exact `metadata_storage_path` must identify one indexed
original in the frozen manifest, whose path and acknowledged native file ID are
verified against the native inventory before and after chat. Basenames,
case-folded paths, titles and chunk-ID prefixes are not identity fallbacks.
If a parent ID is also returned, it must agree with that original's native ID.
The returned chunk key remains an opaque chunk locator, never an original ID.

The final model's structured `citationIds` are constrained to the retrieved ID
allowlist. The answer must use those IDs verbatim in separate `[ID]` markers;
combined markers, renumbered IDs, missing/undeclared markers and uncited
non-abstention answers remain errors. Parsed generated answers and safe
validation categories are retained only in the protected local catalog, without
request headers or authentication credentials. Rejected outputs are never
published as answers, and diagnostics never authorize another paid attempt.

After native readiness and chat approval, ask questions in **Ask Foundry IQ**.
Numbered source cards identify the actual native file and chunk; clicking one
opens the matching local original and selects it in 3D. Source identity is never
inferred from a title. Unverified native reference shapes stop rather than
fabricate a file/page/trace.

PDF originals use Jevbox's existing local PDFium viewer instead of a browser PDF
plugin in a sandboxed iframe. Original responses retain their restrictive
security policy; the viewer renders document bytes, not executable source
instructions. Opening an original is local and does not repeat ingestion or Q&A.

**Azure provenance** displays the last observed actual source/index/KB lineage
and schema. The index name comes from native `createdResources.index`, not a
guessed suffix. **Open Azure AI Search** opens only service metadata. Use your own
authorized Entra sign-in, then **Search management > Indexes > the exact displayed
index > Search explorer**. Metadata permission and content-query permission differ.
Inspect content only within its bounded approval. Use observed retrievable and
filterable fields; do not edit/delete the native index, fetch keys or grant roles.

Local preview and synthetic tests are not native Azure proof. Until the real
approved upload/OCR/retrieval/citation/Portal journey is recorded, the live demo
remains incomplete. Other authorized operators/readers on the selected shared
Search service may read stored data; personal mode is not per-file native ACLs.
Cleanup always requires a separate exact receipt-backed approval and excludes
reused services, deployments, roles and unrelated data.
