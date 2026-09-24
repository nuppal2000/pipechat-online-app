# AI Table Workspaces

New accounts start with an empty pending workspace. Sales, Recruiting, Real
Estate and Other identify the workflow; Other requires a description. Users can
build with AI or attach an Excel/CSV file or accessible Google Sheets link.
The from-scratch and default-table choices are no longer shown.

AI proposes a validated schema, never sample records. The user reviews and
confirms an empty table before adding rows. Generation uses the existing model,
usage reservation and chat allowance. Invalid model output does not charge a
successful message. No paid AI call is part of the automated tests.

Existing accounts retain the legacy sales columns and custom fields. No account
is converted automatically. Confirming deletion of a legacy built-in column
converts only that user's table to equivalent configurable field definitions;
the surviving columns, values and stable IDs are preserved.

## Storage and Safety

- `tableSchema` describes typed fields and semantic roles. Field IDs are stable.
- `null` means legacy; `pending` means setup; `ready` means a tailored table.
- Initial AI setup requires a primary text field. Once columns are explicitly
  ordered, the first displayed field is the effective primary, retaining its
  actual type and values. Deleting this first field requires choosing another
  existing text field (preserving its values) or creating a new, blank text field.
  Both choices remove the old primary column and its values only after preview
  confirmation. Undo restores the previous fields and values.
- User-created chat columns remain text fields; numeric, currency, choice and
  date types can be produced during AI setup.
- Schemas and records save atomically with the existing version check.
- Supabase stores schema metadata and JSONB record values in private tables.
  The authenticated save RPC applies validation and the transition guard while
  holding the workspace lock. Shared Node validators live in `lib/backend-contract.js`.
- Old clients cannot discard a pending/ready schema. Existing table types cannot
  be changed silently. AI setup creates zero rows; confirmed spreadsheet setup
  can atomically create a populated table matching the uploaded document.
- Signup initializes pending metadata only for newly created users.

## Contextual Workflows

Manual editing, AI edit proposals, semantic CSV imports, search, filters,
activity, sharing previews and undo use the active field definitions. Unknown
CSV values stay blank. Shared output includes only explicitly selected fields.

Dashboard totals and averages use numeric/currency fields; grouping choices
come from the current columns. Owner and record comparisons follow semantic
roles. Adding or removing fields rebuilds choices and clears invalid report
references. Blank numbers are not treated as zero in averages.

## Field Controls

Add field beside Add record proposes a blank text column through the same
preview flow as chat. Every header has a trash button. It first asks Yes/No;
Yes creates a proposal, and a separate confirmation applies it. Chat can propose
deletion of any column; an unspecified primary replacement opens the same picker.
These manual controls do not consume AI usage and remain available at the cap.

Replacing the primary updates the Add button and primary-based chart grouping.
Old primary-name selections are cleared rather than applied to unrelated values.
Clicking a header toggles ascending/descending sorting by its text, numeric or
date type. Blanks stay last and ties remain stable. Sorting is view-only.

## Verification and Deployment

Run `npm test` (not unconstrained `node --test`). The suite covers shared field
logic, browser flows, backend adapters and embedded PostgreSQL. The approved
Supabase browser QA runner uses real disposable storage and simulated AI.

Follow `SUPABASE-DEPLOYMENT.md` for matching SQL migration/application versions.
Preserve authentication, model, quota, signup restrictions and readiness settings.
Live persistence tests must use approved disposable users only. This cleanup
does not enable public signup or change the existing rollout boundary.
