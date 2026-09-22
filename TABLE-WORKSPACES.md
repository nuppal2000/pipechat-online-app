# AI Table Workspaces

New accounts start with an empty pending workspace. Sales, Recruiting, Real
Estate and Other identify the workflow; Other requires a description. Only
the AI build method is enabled in this release. The other three methods are
visible but unavailable until implemented.

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
- A primary text field is always required. Deleting it requires choosing another
  existing text field (preserving its values) or creating a new, blank text field.
  Both choices remove the old primary column and its values only after preview
  confirmation. Undo restores the previous fields and values.
- User-created chat columns remain text fields; numeric, currency, choice and
  date types can be produced during AI setup.
- Schemas and records save atomically with the existing version check.
- Xano uses the existing private `crm_state.custom_data` JSON column for schema
  and typed cells. No new public database exposure or security setting is needed.
- The helper has write-validation, read-projection and transition modes; none
  perform database writes themselves. The CRM PUT transaction applies the
  transition guard while holding the existing per-user state lock.
- Old clients cannot discard a pending/ready schema. Existing table types cannot
  be changed silently. A pending workspace must first save zero rows.
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

Run `node --test test/*.test.js` (not unconstrained `node --test`). Use the
offline QA runner for browser tests; it simulates Xano and AI locally.

Deploy the backward-compatible Xano helper and GET/PUT routes first. Deploy
the app code next. Publish the signup initializer last, after the new app is
live. Preserve auth guards, logging restrictions, model, quota and readiness
settings. Live persistence tests must use approved disposable users only.

For field controls on an already deployed table-workspaces release, only the
backward-compatible `custom_fields` helper needs updating before the app. Keep
the published signup and CRM route transaction/projection fixes unchanged.

This feature does not complete the separately deferred full workspace restore
or historical-log security work, and does not expand production readiness.
