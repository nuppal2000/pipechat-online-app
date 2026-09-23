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

The reviewed schema starts at `db/migrations/001-supabase.sql`; apply subsequent migrations in order. Apply initial setup only during an approved new-project setup. Do not replay schema creation, backups or restoration into an already verified/populated project as part of deployment. Obsolete provider credentials, if still configured externally, are not read by the app. Their revocation and infrastructure deletion are separate operations; there is no provider fallback.

## Acceptance

For column renaming, dropdown conversion and dashboard KPI customization, apply `db/migrations/004-column-and-kpi-customization.sql` after migration 003 and before deploying the UI. It adds a private KPI validator and replaces the schema/custom-field/save validators without changing public RPCs or grants. No user records are changed by deployment. KPI definitions live inside the versioned per-workspace table schema; conversions and their cell changes save atomically. Existing preview confirmation, undo, account isolation and usage caps remain in force.

Once users save these new definitions, do not roll back to a UI/backend that drops KPI metadata or rejects custom dropdowns. Prefer a forward fix; preserve snapshots and stop writes before any incompatible rollback. Existing open tabs should be refreshed before further editing after deployment.

For spreadsheet onboarding, apply `db/migrations/003-spreadsheet-setup.sql` after migrations 001 and 002, before deploying this UI. It updates validation and the existing atomic save RPC without changing grants or writing any user's records. It permits a pending workspace to become a populated spreadsheet table in one version-checked transaction. Existing configured workspaces cannot change their source mode through an ordinary save. See `SPREADSHEET-IMPORT.md` for snapshot semantics and limits.

For profile settings/reset support, apply `db/migrations/002-reset-workspace.sql` once after migration 001 and before deploying the reset UI. It adds one owner-only, authenticated, version-checked RPC; applying the migration does not delete data. A confirmed reset removes the current workspace's records (including their history), custom fields and table definition, then returns it to pending onboarding. It does not recreate the Auth account, change sessions or memberships, refund chats, or reset the usage limit. Standard saves still cannot return a configured table to onboarding. Reset cannot be undone in the app; historical private backups and previously exported files are unaffected.

Run `npm run check` and `npm test` on the exact release. Confirm `/api/health` reports Supabase and closed signup, `/api/ready` and `/api/monitor-status` return healthy, and anonymous CRM/usage requests are denied. Verify public signup is disabled both at the application boundary and in the provider settings.

Use only approved disposable accounts for hosted smoke tests. Verify private sign-in, existing table/schema read-back, one reversible manual edit, saving, full refresh, and restoration of the original field value. Check the second account cannot see the first account's workspace. Manual edits must not consume chat allowance. Do not run a paid AI request without separate approval. No production debug or QA-simulation flags are required.

The local test suite covers typed custom fields, primary replacement, onboarding, dashboard reports, CSV mapping, atomic saves, quotas, cookie refresh, invalid input and provider isolation. Hosted restoration and reliability evidence is maintained separately; this document contains no private backups, credentials or account records.

## Rollback

Retain a known-good Supabase-compatible release. Stop new writes and preserve current Supabase data before an incompatible rollback. Match application and schema contracts so saved fields/KPIs are not stripped. The retired Xano provider is no longer accepted; configuring it fails startup rather than silently switching to JSON. Git history retains old code, but using an old database would not carry current writes across. External workspaces, disks, credentials and private backups are not removed by this cleanup.
# KPI Lifecycle Update

Apply `db/migrations/005-kpi-lifecycle.sql` after migrations 001-004 and before deploying KPI add/delete controls. It preserves validated `hiddenKpis` metadata for removed default cards, without modifying account data or grants. Reverting the app to a version that strips this metadata can restore deleted default cards on a later save; keep the matching app/schema contract when rolling back.

## Linked To Do Board (Historical Migration 006)

Apply `db/migrations/006-todo-board.sql` after 001-005 and before deploying the board UI. Existing boards start empty; no CRM rows or allowances change. Cards are private workspace metadata, linked by record ID and stable field IDs. Titles, owner/contact, next actions and follow-ups project from the current CRM. Card-only next actions/dates are explicit overrides. The fixed lanes do not edit CRM status fields.

The authenticated `pipechat_write_workspace` RPC atomically saves rows, schema and cards under the existing workspace lock/version check. Direct table access stays denied, and all writes verify the live Supabase session. The older four-argument write RPC preserves valid cards and prunes deleted-record/field links. Reset clears cards but preserves identity and usage. Card deletion leaves the CRM record; record deletion removes its cards, and workspace Undo restores both. No paid AI calls are required for manual operations. Common urgent note phrases prompt for opt-in card creation, never automatic insertion.

Run `npm test` and `npm run check` before deployment. Local tests include forced late rollback, stale saves, revoked sessions, caller isolation and old-client pruning. Backups must include `workspace_metadata.todo_cards` and migration 006 functions/triggers. Keep migration 006 when rolling back only the app; never drop metadata containing user cards. A live read-only smoke test must not manufacture or delete cards in an existing account.

## Independent To Do Cards (Current)

Apply `db/migrations/007-independent-todo.sql` once after 006 and immediately before deploying the matching app. It freezes each card's displayed To Do and due information in private `todo_cards_v2` metadata. Valid calendar dates remain dates; relative or ambiguous due text is retained in Notes without inventing a date. Original v1 card metadata is retained as an archive. CRM cells, history, schema, users and allowances are unchanged by migration.

Cards now contain only a linked record ID, board status, To Do text, Notes and a due date. Only the displayed primary record name follows table edits. No owner, next-action, notes or follow-up cell is bound to a card. Notes appear only in the expanded editor and change preview. Creating, editing, dragging, deleting or undoing a card uses `PUT /api/todo-cards` and the authenticated `pipechat_write_todo` RPC, which cannot write CRM rows or consume chat allowance. Expanded cards expose no CRM cell editors.

Deleting a record warns that all its linked cards will also be removed. The versioned full-workspace save removes them atomically; workspace Undo restores the row and its cards. The new read/write RPCs are `pipechat_read_workspace` and `pipechat_write_workspace_v2`. Legacy five-argument linked-card writes fail with a reload conflict to prevent old tabs from reverting independent tasks. Refresh open tabs after deployment. Backups must retain both card metadata columns and migration 007 functions/triggers. Do not roll back to a linked-card app after independent card edits; prefer a forward fix.
