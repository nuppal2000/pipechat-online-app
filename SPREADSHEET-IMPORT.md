# Spreadsheet Import

## Two distinct workflows

- Onboarding offers AI setup or spreadsheet setup only. Spreadsheet setup preserves the selected worksheet's headers, column order, row order and displayed cell text. It does not use AI or consume a chat allowance. A preview and explicit confirmation precede the atomic save.
- Import CSV in an existing workspace also accepts Excel and Google Sheets. It passes the selected data through the existing AI mapping, proposed changes, confirmation, append and undo workflow. It never replaces the existing table. Existing AI quota and explicit basic-mapping fallback behavior remain unchanged.

## Supported inputs

Upload `.xlsx`, `.xls` or UTF-8 `.csv`, or paste an accessible HTTPS Google Sheets document/published-sheet link. A workbook worksheet selector chooses one sheet per import. For a Google Sheets link, the `gid` in the link selects the tab; without it Google exports the default tab. Private sheets can be downloaded as Excel/CSV and uploaded, with no sharing-permission change. Google OAuth and `.gsheet` shortcut files are not supported.

Limits: 5 MB per file/download, 2,000 data rows, 100 columns, 12,000 characters per cell and the existing 12 MB CRM snapshot limit. Blank interior rows are retained; trailing empty rows are omitted. The first row is the header. Headerless files should receive a header row before import.

Onboarding preserves duplicate, blank and reserved-looking header labels using separate internal field IDs. The selected primary column stays text. Unambiguous plain numbers may become numeric fields only when their text round-trips exactly; leading zeroes, formatted currency, formatted dates and mixed columns remain text to avoid conversion losses. Dashboard totals are available for numeric fields; text columns remain available for grouping and counts. Ambiguous duplicate labels in chat must be identified by field ID.

This is a values snapshot, not a workbook clone or live synchronization. Fonts, cell colors, merged layouts, formulas and macros do not become CRM behavior. Saved formula results are copied; missing results and merged cells produce an error rather than a guessed value. Recalculate and save the workbook, or export a plain worksheet, before retrying. Excel has already rounded any precision it did not save; the importer cannot recover it.

Existing-table AI mapping still requires unique nonblank source headers, as the existing mapper references columns by name. Its normalization rules are intentionally different from literal onboarding.

## Security and dependencies

Excel parsing runs in a local browser worker with a 20-second deadline. Workbooks and formula code are never executed. Previews and cells are escaped. The pinned parser is [SheetJS CE 0.20.3](https://docs.sheetjs.com/docs/getting-started/installation/standalone/), vendored with its license; no runtime CDN is required.

Google downloads require an authenticated PipeChat session and the existing CSRF checks. The server reconstructs a CSV export URL from an allowlisted Google Sheets link, follows only bounded Google export redirects, and sends no browser cookies, Supabase tokens or OpenAI credentials to Google. Downloads have time/byte/concurrency/rate limits. Raw document contents and URLs are not added to operational logs. [Google's spreadsheet documentation](https://developers.google.com/chart/interactive/docs/spreadsheets) describes public access and worksheet IDs.

Migration 003 retains authenticated owner isolation, optimistic concurrency, atomic writes and chat accounting. It does not reset or import any existing account automatically.
