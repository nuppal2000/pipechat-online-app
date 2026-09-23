# Custom CRM Fields

Ask `Add field called Contact`, or use Add field on Pipeline, then review and
confirm the proposal. No custom column is added automatically. Existing and
subsequent rows start with blank values. Manual edits remain available at the
chat cap; undo restores both field definitions and values.

Stable field IDs, not display labels, identify stored values. Custom labels must
not collide with existing fields or reserved names. Chat-created fields begin as
text; AI setup also supports numbers, currency, dates and choices. Header renaming,
deletion, primary replacement and dropdown conversion use the current table schema.
See `WORKSPACE-CUSTOMIZATION.md` and `TABLE-WORKSPACES.md` for those flows and limits.

## Storage

Supabase stores typed record values in private JSONB data keyed by stable field
IDs, with table/custom-field definitions in workspace metadata. Adding a UI
column does not add a PostgreSQL column. The authenticated save RPC validates
definitions and rows, locks the workspace, checks its version and saves the full
snapshot atomically. Empty tables retain their configured fields.

`lib/backend-contract.js` validates safe snapshot projections and quota results
without network calls. `lib/supabase-backend.js` performs authenticated RPC calls.
No generated provider-specific helper is required. JSON mode uses the same shared
field definitions for local development only and is never a hosted fallback.

## Verification

Run `npm run check` and `npm test`. Coverage includes validation, blank defaults,
preview/cancel/confirm, undo, empty-table schemas, manual editing at the cap,
failed-draft recovery, escaping, PostgreSQL persistence and per-user isolation.
Apply any new SQL migration before deploying code that needs its validation;
follow `SUPABASE-DEPLOYMENT.md`. Do not roll back to code that strips saved metadata.
