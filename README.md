# PipeChat Online App

This folder is the deployable app version of the PipeChat prototype. It packages the CRM UI, backend API, OpenAI chatbot bridge, saved CRM data, and the 1000-message usage cap behind one server.

## Current backend work

The app supports Supabase PostgreSQL, Xano and local JSON storage. Follow [SUPABASE-DEPLOYMENT.md](SUPABASE-DEPLOYMENT.md) for the controlled Supabase rollout and rollback checklist. Use Node 22 or newer and `npm ci` before running the checks. The older deployment notes below describe earlier JSON/Xano prototype stages, not authorization to reset or switch the live service.

Current workflow onboarding, dynamic schemas/field controls and contextual dashboards are documented in [TABLE-WORKSPACES.md](TABLE-WORKSPACES.md), [CUSTOM-FIELDS.md](CUSTOM-FIELDS.md) and [DASHBOARD-REPORTS.md](DASHBOARD-REPORTS.md). They remain part of this app during the backend migration.

## Product-v2 prototype update

Implements the five current-prototype items in `PipeChat_Updated_Product_Changes_Implementation_Guide_v2.docx`. The supplied UI image informs the light three-pane layout: conversation, CRM table, and proposed changes. Its recruiting/demo screens are visual references, not separate implemented products.

- Real model responses use a strict action schema. Multi-field changes, new deals, CSV appends, and deletion have a review/confirm step before saving.
- Ambiguous company references preserve the requested changes while the user selects a matching record. Follow-up messages receive conversation history, the pending clarification/action, and the current report specification.
- Bulk filters calculate their actual affected records locally. Previews show before/after values and reject stale confirmations.
- Bar, line, stage-distribution, and KPI views use Chart.js and deterministic table calculations. Reports support count, sum and average, fixed groupings, a single filter, and a close-date range. Monthly lines zero-fill missing months.
- Sharing is a **local read-only preview**, with recipient, message and public-field selection. Export creates a plain HTML snapshot, not a secured or live link. Nothing is emailed. Private notes, next steps and history are never exported. Team access is a labelled concept only.

Existing sign-in, per-user saved CRM data, manual edits, add/delete, append-only CSV import, quick undo and chat limits remain. Manual editing is available after the AI allowance runs out. Imports use AI to map unfamiliar column names when a model and allowance are available; recognized headers also work without AI. CSV values are validated, not invented by the model.

### Files to keep together

- `public/index.html`: semantic page structure; serves at `/`.
- `public/pipechat.css`: responsive visual design.
- `public/pipechat.js`: UI, chat context, manual edits, previews, imports and persistence.
- `public/pipeline-core.js`: shared validation, target resolution, change planning, deterministic reports and public-field projection.
- `public/icons.js` and `public/vendor/`: local Lucide, Chart.js and PapaParse assets with licenses; no CDN requests are needed.
- `server.js`: auth, persistence routing, OpenAI action schema, and usage enforcement. Saves use version checks to avoid silently overwriting another open window.
- `lib/xano-backend.js`: optional server-side Xano adapter. JSON storage remains the default.
- `scripts/check-xano.js` and `xano/`: connection check, workspace setup guide and required endpoint specification.

When updating GitHub, upload these files and directories together, along with `package.json` and the tests. Uploading only the HTML will not update this version. Do not upload `data`, `.env`, API keys, or the test runtime directories.

### Verification

```powershell
npm run check
npm test
```

The automated tests use Node's built-in test runner and test-only OpenAI/Xano stubs. They verify ambiguity handling, preview/confirm safety, bulk counts, calculated reports, public-field exports, independent user datasets, validation, saved empty tables, stale-write rejection, and manual saves after the chat cap. Xano adapter checks also cover private cookies, token revocation, usage reservations and failure handling. These tests do not establish the correctness of a real Xano workspace; live acceptance checks are required before switching.

Additional Playwright checks and screenshots are in the workspace's `work/product-v2` directory. Those checks use an isolated mock workspace, not real user CRM data. A live model call still requires a valid `OPENAI_API_KEY` in the server environment.

### Boundaries

This remains a prototype with single-process JSON-file storage by default. An optional Xano adapter is prepared, but workspace provisioning, live endpoint verification and migration are still outstanding. Durable production conversation memory, workflow onboarding, dynamic schemas, advanced dashboards, secure shared links, team permissions, billing and a WeWeb frontend migration are not implemented. Recent conversation context is held in the current page session; refreshing clears the conversation, not saved CRM records. Undo is also session-local.

The previous interface and server were backed up to `work/product-v2/backup` in the parent workspace. Legacy HTML prototypes and the ten UI alternatives were left unchanged. The cloud deployment has not been modified.

## What is included

- `public/index.html` - PipeChat CRM app UI.
- `server.js` - backend API for login, per-user CRM data, AI chat, static hosting, and usage limits.
- `data/` - local saved CRM data and chat usage files, created automatically in JSON mode only.
- `lib/xano-backend.js` and `xano/` - optional Xano adapter and staged setup instructions.
- `db/supabase-schema.sql` - earlier reference schema; not connected to the app.
- `render.yaml` - starter deploy config for Render with a persistent disk.

## Run locally

```powershell
cd "C:\Users\nuppa\Documents\Codex\2026-06-12\files-mentioned-by-the-user-uiux\pipechat-online-app"
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new("", (Read-Host "OpenAI API key" -AsSecureString)).Password
$env:PIPECHAT_MODEL = "gpt-5.5"
$env:PIPECHAT_STORAGE_PROVIDER = "json"
& "C:\Users\nuppa\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" .\server.js
```

Open:

```text
http://127.0.0.1:8787/
```

## Deploy path

This package runs as a normal Node web service. For the existing Render deployment with JSON storage:

1. Create a new web service.
2. Set the app root to `pipechat-online-app`.
3. Set the start command to `npm start`.
4. Add environment variables:
   - `OPENAI_API_KEY`
   - `PIPECHAT_MODEL=gpt-5.5` (or another supported model available to your API project)
   - `PIPECHAT_STORAGE_PROVIDER=json`
   - `PIPECHAT_FREE_CHAT_LIMIT=1000`
   - `PIPECHAT_DATA_DIR` pointing to a persistent disk path
5. Add a persistent disk for `PIPECHAT_DATA_DIR`.

## Xano Integration Status

The app-side adapter is prepared, **not connected to a live Xano workspace**. Existing accounts, saved CRM rows and usage counts have not been migrated. Keep JSON mode and its persistent disk active while preparing Xano.

Follow [the Xano setup guide](xano/SETUP.md) and [endpoint contract](xano/API-CONTRACT.md). Create the workspace and protected endpoints, verify them with two test accounts, and only then enable `PIPECHAT_STORAGE_PROVIDER=xano`. `npm run xano:check` verifies the endpoint handshake, not the underlying security or transaction guarantees.

In Xano mode, the Node server proxies native Xano authentication, per-user CRM snapshots and atomic chat reservations. The browser does not receive the private server key. Xano owns the chat limits; `PIPECHAT_FREE_CHAT_LIMIT` applies only to JSON mode. An unavailable Xano service produces an error instead of switching to local files.

Chat limits still lock only the AI chatbot. Manual CRM editing remains available. Billing, team permissions, live shared views and durable conversation history remain separate work.

## Accounts and CRM isolation

PipeChat requires sign-in before showing the CRM. In default JSON mode, accounts, sessions, each user's CRM rows, and each user's chatbot usage are stored under `PIPECHAT_DATA_DIR`. A properly configured Xano backend stores these separately in Xano using the authenticated user's identity.

Each signed-in user gets a separate CRM dataset. One user cannot load or edit another user's CRM through the app APIs.
