# Conservative CSV import

The app profiles all parsed rows and sends column names plus bounded examples (up to 40 distinct examples per column) to the configured model. Existing CRM records and chat history are not included in this request. The model returns only a strict column map and stage translations, not generated CRM rows or arbitrary table actions.

The shared `public/csv-import.js` module applies the mapping to every source row. It preserves clear values, leaves ambiguous cells blank and lists unresolved cells in the confirmation preview. Dates without an unambiguous complete year/month/day, unclear amounts, and unsupported stages are not guessed. Unrelated columns are reported as ignored. Completely unusable rows are reported as skipped. CSV structure errors, duplicate headers, and size limits still produce actionable errors.

An unknown amount is stored as null and displayed blank. A real numeric zero remains zero. Blank account/stage values are allowed in imported rows; an unnamed display label is not written as a fabricated company. Reports exclude unknown amounts from averages and value filters. Imports append only after confirmation, preserve existing records, and support undo.

One successful AI mapping uses the existing chat allowance. An unavailable client-side usage/health lookup does not bypass AI: the server checks authorization and quota on the mapping request. If AI fails or the allowance is exhausted, the import pauses with its CSV retained in the current tab. Retry AI mapping explicitly, or choose Review basic mapping (not AI). Only that explicit choice uses conservative header aliases; no partial basic import preview is silently substituted. No model or usage configuration is changed by this release.

Column meaning is separate from individual-cell validity. A recognizable sales-status column can map to Stage even when some cells have ambiguous labels. Known stage cells are retained; unclear labels remain blank. The same policy applies to estimated amounts, responsible representatives, and anticipated close dates under differently worded headers.

## Coordinated Xano update

Before deploying the app, allow null on `deal.value`, without rewriting existing records. Publish the matching validation helper and CRM GET/PUT mappings together:

- Validation accepts empty account/stage strings, but retains other field, ID, date and ownership rules.
- `value` must be an explicit key. Null is unknown; numeric values retain their existing range constraints. Use `is_null`, not loose equality, so numeric zero passes.
- Both write paths and both response mappings preserve null instead of using a `?? 0.0` fallback.
- Transaction locking, stale-version checks, user filters, authentication and usage endpoints are unchanged.

The local `xano/API-CONTRACT.md` documents the revised storage shape. This app release does not enable broader production readiness or resolve deferred full-workspace recovery checks.

## Verification and rollback

Run `node --test test/*.test.js`. Coverage includes sparse CSVs, semantic mappings, ambiguous cells, zero versus null, quota behavior, confirm/append/undo, stale responses, failed-save recovery and JSON/Xano-adapter persistence. Offline browser checks use `node scripts/start-local-qa.js --offline`; they do not prove a live model's interpretation or live database persistence.

The fixture `test/fixtures/csv-tolerant-import.csv` contains only synthetic data. Review its four proposed additions before saving. An actual model may choose more conservative mappings than the fixture model.

After the coordinated deployment, verify an unknown amount remains blank after saving and reloading, and a genuine zero remains zero. Do not roll back only the application to a version that rejects blank/null records after such records have been saved. Prefer a forward fix; any data conversion needs explicit review and must not silently replace unknown amounts with zero or invent company/stage values. Retain the nullable column when reverting code unless a reviewed migration proves no null records remain.
