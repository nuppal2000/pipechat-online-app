# Supabase Deployment

## Controlled rollout

This release supports existing approved test accounts only until transactional email setup and signup acceptance are complete. Keep email confirmation enabled, disable **Allow new users to sign up** in the main Supabase project's Authentication settings, and set `PIPECHAT_ALLOW_SIGNUP=false` in Render. The app hides signup and rejects direct signup requests before contacting any backend. Invalid non-`true` values also disable signup. Unset values preserve the older signup behavior, so set the flag explicitly for this rollout.

Existing Supabase email/password accounts can sign in. Xano accounts and data do not automatically migrate. Do not disable email confirmation as a delivery workaround. Email-based account recovery and public self-service registration are not offered by this rollout.

## Render configuration

- Leave Root Directory blank; this repository has the app files at its root.
- Build: `npm ci`; start: `npm start`; Node 22 or newer.
- `PIPECHAT_STORAGE_PROVIDER=supabase`.
- `SUPABASE_URL`: the verified main project's HTTPS URL, never the restore-test project.
- `SUPABASE_PUBLISHABLE_KEY`: its public publishable key; never a service-role key or database password.
- `PIPECHAT_ALLOW_SIGNUP=false`.
- `PIPECHAT_PUBLIC_ORIGIN`: the exact existing HTTPS app origin.
- `PIPECHAT_COOKIE_SECURE=true`; keep production secure-cookie behavior.
- Preserve the existing OpenAI key, model, operational monitoring and health-check path `/api/ready`.
- Per-user usage allowances are enforced in PostgreSQL, not reset from the environment on deployment.

The reviewed schema is in `db/migrations/001-supabase.sql`. Apply it only during an approved new-project setup. Do not replay schema creation, backups or restoration into an already verified/populated project as part of deployment. Xano credentials and its disk may remain configured but are unused when Supabase is selected; there is no provider fallback.

## Acceptance

For column renaming, dropdown conversion and dashboard KPI customization, apply `db/migrations/004-column-and-kpi-customization.sql` after migration 003 and before deploying the UI. It adds a private KPI validator and replaces the schema/custom-field/save validators without changing public RPCs or grants. No user records are changed by deployment. KPI definitions live inside the versioned per-workspace table schema; conversions and their cell changes save atomically. Existing preview confirmation, undo, account isolation and usage caps remain in force.

Once users save these new definitions, do not roll back to a UI/backend that drops KPI metadata or rejects custom dropdowns. Prefer a forward fix; preserve snapshots and stop writes before any incompatible rollback. Existing open tabs should be refreshed before further editing after deployment.

For spreadsheet onboarding, apply `db/migrations/003-spreadsheet-setup.sql` after migrations 001 and 002, before deploying this UI. It updates validation and the existing atomic save RPC without changing grants or writing any user's records. It permits a pending workspace to become a populated spreadsheet table in one version-checked transaction. Existing configured workspaces cannot change their source mode through an ordinary save. See `SPREADSHEET-IMPORT.md` for snapshot semantics and limits.

For profile settings/reset support, apply `db/migrations/002-reset-workspace.sql` once after migration 001 and before deploying the reset UI. It adds one owner-only, authenticated, version-checked RPC; applying the migration does not delete data. A confirmed reset removes the current workspace's records (including their history), custom fields and table definition, then returns it to pending onboarding. It does not recreate the Auth account, change sessions or memberships, refund chats, or reset the usage limit. Standard saves still cannot return a configured table to onboarding. Reset cannot be undone in the app; historical private backups and previously exported files are unaffected.

Run `npm run check` and `npm test` on the exact release. Confirm `/api/health` reports Supabase and closed signup, `/api/ready` and `/api/monitor-status` return healthy, and anonymous CRM/usage requests are denied. Verify public signup is disabled both at the application boundary and in the provider settings.

Use only approved disposable accounts for hosted smoke tests. Verify private sign-in, existing table/schema read-back, one reversible manual edit, saving, full refresh, and restoration of the original field value. Check the second account cannot see the first account's workspace. Manual edits must not consume chat allowance. Do not run a paid AI request without separate approval. No production debug or QA-simulation flags are required.

The local test suite covers typed custom fields, primary replacement, onboarding, dashboard reports, CSV mapping, atomic saves, quotas, cookie refresh, invalid input and provider isolation. Hosted restoration and reliability evidence is maintained separately; this document contains no private backups, credentials or account records.

## Rollback

Retain the previous release and existing Xano environment settings until live acceptance passes. Reverting to Xano does not carry Supabase writes back into Xano. Stop new writes and preserve Supabase data before any rollback; never alternate providers while users edit. Preserve the original Xano workspace/disk and private backups. Retiring credentials or deleting old infrastructure requires a separate decision.
