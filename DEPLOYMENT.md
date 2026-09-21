# PipeChat Deployment

## Runtime And Tests

Use Node.js 20 or later. There are no npm runtime dependencies.

```sh
npm run check
npm test
npm start
```

Open `http://127.0.0.1:8787/`. Set environment variables in the shell or hosting
dashboard before starting; the server does not automatically load `.env`.
`.env.example` contains names and empty credential values, not real keys.

Keep `server.js`, `lib/`, `public/`, `scripts/check-xano.js` and `package.json`
together. `public/` includes local vendor assets and licenses. Updating only HTML
is insufficient. The server serves `public/index.html`; root `index.html` is a
legacy artifact. `db/supabase-schema.sql` is an unused earlier reference.

`npm test` uses synthetic providers and makes no live OpenAI or Xano calls.
The opt-in `test-xano-*` scripts target a live workspace and require their own
consent prompts. Do not run them in a production build.

## Initial Render Code Update

This repository is the app root. Leave Root Directory blank. Build with
`npm install` and start with `npm start`.

Retain the existing JSON data and persistent disk during the code update:

```text
PIPECHAT_STORAGE_PROVIDER=json
PIPECHAT_DATA_DIR=/var/data/pipechat
PIPECHAT_FREE_CHAT_LIMIT=1000
PIPECHAT_MODEL=gpt-5.5
PIPECHAT_PUBLIC_ORIGIN=https://pipechat-online-app.onrender.com
PIPECHAT_COOKIE_SECURE=true
```

Keep `OPENAI_API_KEY` private in Render. Never commit keys, `.env`, data folders,
logs, tokens or customer exports. Do not delete the existing disk as part of a
code deployment. `render.yaml` is a provisioning template, not evidence of the
currently deployed configuration.

After deployment, `/api/health` should report `prototypeVersion: product-v2` and
`storageProvider: json`. Verify secure cookies, non-cacheable APIs, persistence
and sanitized monitoring before switching storage. The health-check path can be
set to `/api/health` after the app update is verified.

## Xano Is A Separate Cutover

The adapter is included but JSON remains the default. Xano mode requires
`PIPECHAT_STORAGE_PROVIDER=xano`, `XANO_API_BASE_URL` and `XANO_SERVER_KEY`.
Use an HTTPS application API group URL, not a workspace or metadata URL.
The private server key must never enter browser code. Startup refuses an
incomplete backend contract; do not bypass this check to deploy.

Real-workspace tests, browser workflows, backup/recovery review and explicit
cutover approval remain required. Existing JSON credentials and records are not
automatically migrated. Switching providers is not a migration; switching back
after Xano writes requires reconciliation.

Xano provides auth, per-user snapshots, version-checked saves, token revocation
and atomic usage reservations. Outages never fall back to local JSON.
Xano owns its per-user chat allowances; `PIPECHAT_FREE_CHAT_LIMIT` is JSON-only.
Manual editing remains available after chat allowance exhaustion.

## Product And Security Boundaries

The current UI includes manual CRUD, append-only CSV import, AI previews requiring
confirmation, session-local undo, calculated reports and HTML sharing snapshots.
Sharing does not send invitations or create secure live links. Chat context is
page-local. Billing, email verification, password recovery and team permissions
are not implemented.

JSON mode is a single-process prototype. Xano saves whole-CRM snapshots capped
at 2,000 deals. These tests do not establish unlimited scale or production readiness.

API responses are non-cacheable. Browser writes require same-origin JSON. Cookies
are HttpOnly and SameSite=Lax; HTTPS deployments must enable Secure. The request
monitor emits a closed schema without bodies, credentials, raw URLs or CRM data.
The CSP restricts frames, objects and base URLs, not all script execution.
