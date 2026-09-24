# PipeChat Online App

PipeChat combines configurable CRM tables, an AI assistant, reviewed changes,
contextual dashboards and per-user storage. The hosted app uses Supabase
PostgreSQL and Supabase Auth. Local JSON mode remains available for development;
there is no automatic fallback between providers.

## Current Features

- Empty-workspace onboarding with AI table design or Excel/CSV/accessible Google Sheets setup.
- Dynamic fields, primary-field replacement, header renaming, dropdown conversion and typed sorting.
- Manual editing, expandable notes, AI proposals, confirmation, undo and failed-edit draft recovery.
- Append-only semantic imports, owner/account comparisons and configurable dashboard KPIs.
- Authenticated per-user data and transactional usage accounting. Manual editing remains available at the chat cap.
- Read-only sharing previews and HTML exports, not secure live collaboration links.

Conversation history is saved privately per user, with bounded AI context and
rolling older-message summaries. See [Chat history](CHAT-HISTORY.md). Undo remains
a page-session feature. Billing, team access and public email signup/recovery remain separate work.
The current hosted rollout permits existing approved accounts only.

## Files

- `public/`: current UI, shared field validation, deterministic reports and locally bundled assets.
- `server.js`: HTTP routes, authentication, AI requests, storage routing and quota enforcement.
- `lib/backend-contract.js`: provider-neutral error, CRM snapshot and usage validators; no network calls.
- `lib/supabase-backend.js`: Supabase authentication, cookies and database RPC adapter.
- `db/migrations/`: ordered PostgreSQL migrations. Do not replay setup or restore over an existing project.
- `scripts/check-supabase.js`: read-only backend handshake check.
- `test/`: offline regression tests, mock providers and embedded PostgreSQL checks.

The obsolete Xano adapter, generated helpers and Xano-only QA scripts/tests have
been removed. They remain available in Git history. This code cleanup does not
delete any external workspace, rotate credentials or migrate data.

## Run Locally

Use Node 22 or newer. From this app directory:

```powershell
npm ci
npm run check
npm test
$env:PIPECHAT_STORAGE_PROVIDER = "json"
$env:PIPECHAT_HOST = "127.0.0.1"
$env:PIPECHAT_MODEL = "gpt-5.2"
npm start
```

Open http://127.0.0.1:8787/. Local JSON data is stored under `PIPECHAT_DATA_DIR`
(default `data/`). Real AI calls require `OPENAI_API_KEY` in the server process;
never place it in browser code or Git. `.env.example` is documentation, not an
automatically loaded environment file. Supabase-backed local testing is described
in `SUPABASE-MIGRATION.md` and requires an explicitly approved test account.

## Deploy and Verify

Follow [SUPABASE-DEPLOYMENT.md](SUPABASE-DEPLOYMENT.md) for the existing Render
service. Deploy the complete app, not just its HTML. Keep Supabase configuration,
secure cookies, exact HTTPS origin, signup restrictions, model and usage settings.
Do not upload `.env`, data directories, credentials, backup archives or local QA output.

`npm test` uses mocked HTTP/AI responses and embedded PostgreSQL. It does not make
paid model requests or prove live provider behavior. Hosted checks need separate
approval and disposable users. `/api/ready` and `/api/monitor-status` are status-only
health endpoints; anonymous CRM requests must remain unauthorized.

## Feature Guides

- [Table workspaces](TABLE-WORKSPACES.md)
- [Custom fields](CUSTOM-FIELDS.md)
- [Column and KPI customization](WORKSPACE-CUSTOMIZATION.md)
- [Dashboard comparisons](DASHBOARD-REPORTS.md)
- [CSV mapping](CSV-IMPORT.md)
- [Spreadsheet onboarding/import](SPREADSHEET-IMPORT.md)
