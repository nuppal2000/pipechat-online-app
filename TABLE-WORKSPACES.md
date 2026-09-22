# AI Table Workspaces

New accounts start with an empty pending workspace. Sales, Recruiting, Real
Estate and Other identify the workflow; Other requires a description. Only
the AI build method is enabled in this release. The other three methods are
visible but unavailable until implemented.

AI proposes a validated schema, never sample records. The user reviews and
confirms an empty table before adding rows. Generation uses the existing model,
usage reservation and chat allowance. Invalid model output does not charge a
successful message. No paid AI call is part of the automated tests.

Existing accounts retain the legacy sales columns and custom fields. This
release does not backfill or convert existing accounts.

## Storage and Safety

- `tableSchema` describes typed fields and semantic roles. Field IDs are stable.
- `null` means legacy; `pending` means setup; `ready` means a tailored table.
- Primary text field is required and cannot be deleted. Other columns can be
  removed with confirmation and restored using the existing undo action.
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

## Verification and Deployment

Run `node --test test/*.test.js` (not unconstrained `node --test`). Use the
offline QA runner for browser tests; it simulates Xano and AI locally.

Deploy the backward-compatible Xano helper and GET/PUT routes first. Deploy
the app code next. Publish the signup initializer last, after the new app is
live. Preserve auth guards, logging restrictions, model, quota and readiness
settings. Live persistence tests must use approved disposable users only.

This feature does not complete the separately deferred full workspace restore
or historical-log security work, and does not expand production readiness.
