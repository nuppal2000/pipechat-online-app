# Spreadsheet Import

## Two distinct workflows

- Onboarding offers AI setup or spreadsheet setup only. Spreadsheet setup preserves headers, column order and row order. One metered AI request classifies column profiles by meaning and distribution; the browser validates every original cell before applying types. A typed preview and explicit confirmation precede the atomic save. No database changes occur during analysis.
- Import CSV in an existing workspace also accepts Excel and Google Sheets. It passes the selected data through the existing AI mapping, proposed changes, confirmation, append and undo workflow. It never replaces the existing table. Existing AI quota and explicit basic-mapping fallback behavior remain unchanged.

## Supported inputs

Upload `.xlsx`, `.xls` or UTF-8 `.csv`, or paste an accessible HTTPS Google Sheets document/published-sheet link. A workbook worksheet selector chooses one sheet per import. For a Google Sheets link, the `gid` in the link selects the tab; without it Google exports the default tab. Private sheets can be downloaded as Excel/CSV and uploaded, with no sharing-permission change. Google OAuth and `.gsheet` shortcut files are not supported.

Limits: 5 MB per file/download, 2,000 data rows, 100 columns, 12,000 characters per cell and the existing 12 MB CRM snapshot limit. Blank interior rows are retained; trailing empty rows are omitted. The first row is the header. Headerless files should receive a header row before import.

Onboarding preserves duplicate, blank and reserved-looking header labels using separate internal field IDs and index-based AI classifications. The primary column stays text. Clear quantities and USD amounts can become numeric/currency fields; complete unambiguous dates become calendar fields in YYYY-MM-DD format. Repeating categories can become dropdowns with options derived from all actual cells (at most 30 options, 80 characters each, distinct/nonblank ratio at most 0.6). Case/spacing collisions, ambiguous dates, leading-zero numbers, unsafe precision, invalid values and unsupported mixed columns stay entirely text rather than losing cells. Blank numeric cells become null, not zero. Dates and formatted amounts retain meaning rather than their original display formatting. The preview explains each type and any fallback. Dashboard measures reflect the resulting schema.

AI receives only bounded column profiles (counts and up to 40 distinct examples per column), not a request to rewrite the spreadsheet. If AI is unavailable or chat allowance is exhausted, users can explicitly retry or choose **Use original text (no AI)**. That choice preserves every original string and is free; there is no silent fallback or automatic paid retry.

## Duplicate review for existing tables

After mapping, imports check the current primary field against saved records and earlier rows in the file. Matches ignore case and extra whitespace; accents and punctuation are not fuzzy-matched, and blank primary cells never match one another. Users choose **Keep duplicates**, **Merge duplicates**, or **Cancel import** before the final preview.

Merge keeps existing records and their values unchanged, and only the first incoming occurrence of each new name. Later matching rows, including conflicting imported values, are skipped. Existing duplicates already in the table are not removed. Keep appends every incoming row. Cancel does not write. An all-matched merge performs no write. Capacity is checked after the choice, and a changed workspace invalidates the preview. The final confirmation, atomic save and undo remain unchanged. These rules apply to uploaded CSV/Excel and accessible Google Sheets alike.

This is a values snapshot, not a workbook clone or live synchronization. Fonts, cell colors, merged layouts, formulas and macros do not become CRM behavior. Saved formula results are copied; missing results and merged cells produce an error rather than a guessed value. Recalculate and save the workbook, or export a plain worksheet, before retrying. Excel has already rounded any precision it did not save; the importer cannot recover it.

Existing-table AI mapping still requires unique nonblank source headers, as the existing mapper references columns by name. Its normalization rules are intentionally different from literal onboarding.

## Security and dependencies

Excel parsing runs in a local browser worker with a 20-second deadline. Workbooks and formula code are never executed. Previews and cells are escaped. The pinned parser is [SheetJS CE 0.20.3](https://docs.sheetjs.com/docs/getting-started/installation/standalone/), vendored with its license; no runtime CDN is required.

Google downloads require an authenticated PipeChat session and the existing CSRF checks. The server reconstructs a CSV export URL from an allowlisted Google Sheets link, follows only bounded Google export redirects, and sends no browser cookies, Supabase tokens or OpenAI credentials to Google. Downloads have time/byte/concurrency/rate limits. Raw document contents and URLs are not added to operational logs. [Google's spreadsheet documentation](https://developers.google.com/chart/interactive/docs/spreadsheets) describes public access and worksheet IDs.

Migration 003 retains authenticated owner isolation, optimistic concurrency, atomic writes and chat accounting. It does not reset or import any existing account automatically.
