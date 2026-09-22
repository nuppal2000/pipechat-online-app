# Chat-created CRM fields

Ask `Add field called Contact`, review the proposed column, then confirm. No
custom column is seeded automatically. Existing rows receive blank cells;
subsequent rows also default to blank. Each user's definitions are independent.
Users can edit cells manually or ask chat to update them. Undo includes schema
and values. Manual editing continues to work when chat allowance is exhausted.

The first release supports 20 custom text columns, names up to 60 characters,
and values up to 12,000 characters. Stable `cf_` IDs, not user labels, identify
stored values. Names cannot duplicate built-in fields or other custom labels.
Numbers, dates, custom-column CSV mapping, schema rename/removal commands and
custom-column chart metrics are not part of this release. Shared views retain
their existing fixed-field allowlist; custom values are not automatically shared.

## Storage contract and deployment order

1. Add nullable JSON `crm_state.custom_data`, sensitive/internal, without changing
   existing records. Null means no custom columns. No per-user SQL columns are
   created. Metadata shape is `{fields: [{id,name,type}], cells: {"1": {cf_id: ""}}}`.
2. Publish `pipechat/custom_fields` using `xano/custom-fields.xs`. It is a pure
   validation helper generated from the app's shared validators. It has no
   database writes, secrets, authentication changes or external API requests.
   Run synthetic write/read/rejection checks in Xano before wiring it in.
3. In PUT `/crm`, keep all existing key/revocation guards, raw version validation,
   built-in validation, user scoping and locked compare-and-swap transaction.
   Validate raw input through `pipechat/custom_fields` in `write` mode before
   acquiring the row lock. Store its metadata result in `custom_data` alongside
   the new version in the existing transaction. If stored fields are nonempty and
   raw input omits `customFields`, return HTTP 409 before any writes.
4. In both GET and PUT snapshots, retain the existing public built-in projection.
   For each public row and each stored definition, use `set` with the definition
   ID and `get` of `cells.<client row id>.<field id>`, defaulting to empty text.
   Return `{deals, customFields, updatedAt}`. This native projection avoids a
   Lambda/network dependency while holding database locks.
5. Deploy the matching Node/browser files. The adapter refuses nonempty custom
   writes when the old Xano read endpoint does not acknowledge `customFields`.

The original guards, login, quotas, model, readiness capability set and raw-log
settings are unchanged. Do not roll back the server to an old version that strips
custom values after users have started using this feature. Preserve the added
JSON column and data; use a forward fix or temporarily disable schema writes.

## Verification

`node --test test/*.test.js` includes validation, blank defaults, preview/cancel/
confirm, undo, empty-table schema, manual edits at quota, failed-save drafts,
XSS escaping, JSON storage and per-user AI schema isolation. Offline browser
checks cover chat creation/edit, native inline edit, reload and mobile scrolling.
Live persistence checks use only approved disposable QA accounts, no AI calls.

Regenerate the pure helper with `node scripts/build-xano-custom-fields.js` when
changing shared custom-field validation, then repeat Xano tests before publishing.
