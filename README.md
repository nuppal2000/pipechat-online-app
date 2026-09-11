# PipeChat Online App

This folder is the deployable app version of the PipeChat prototype. It packages the CRM UI, backend API, OpenAI chatbot bridge, saved CRM data, and the 1000-message usage cap behind one server.

## What is included

- `public/index.html` - PipeChat CRM app UI.
- `server.js` - backend API for login, per-user CRM data, AI chat, static hosting, and usage limits.
- `data/` - local saved CRM data and chat usage files, created automatically.
- `db/supabase-schema.sql` - cloud database schema for the production version.
- `render.yaml` - starter deploy config for Render with a persistent disk.

## Run locally

```powershell
$env:OPENAI_API_KEY="paste_your_full_api_key_here"
cd "C:\Users\nuppa\Documents\Codex\2026-06-12\files-mentioned-by-the-user-uiux\pipechat-online-app"
& "C:\Users\nuppa\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" .\server.js
```

Open:

```text
http://127.0.0.1:8787/
```

## Deploy path

The fastest deploy target for this package is Render or Railway because this version is a normal Node web server.

1. Create a new web service.
2. Set the app root to `pipechat-online-app`.
3. Set the start command to `npm start`.
4. Add environment variables:
   - `OPENAI_API_KEY`
   - `PIPECHAT_MODEL=gpt-4.1-mini`
   - `PIPECHAT_FREE_CHAT_LIMIT=1000`
   - `PIPECHAT_DATA_DIR` pointing to a persistent disk path
5. Add a persistent disk for `PIPECHAT_DATA_DIR`.

## Production database/auth next step

The current package is deployable with a persistent server disk. For a multi-user production app, use `db/supabase-schema.sql` in Supabase and then replace the JSON-file storage in `server.js` with Supabase queries.

Recommended production stack:

- Hosting: Render, Railway, or Vercel plus serverless API routes
- Database: Supabase Postgres
- Auth: Supabase Auth
- Payments: Stripe
- AI: OpenAI API from the backend only

The app already has the right product boundaries for paid usage: when free AI messages are exhausted, the chatbot locks while the CRM table remains manually editable.

## Accounts and CRM isolation

PipeChat now requires sign-in before showing the CRM. The local/Render MVP stores accounts, sessions, each user's CRM rows, and each user's chatbot usage under `PIPECHAT_DATA_DIR`.

Each signed-in user gets a separate CRM dataset. One user cannot load or edit another user's CRM through the app APIs.
