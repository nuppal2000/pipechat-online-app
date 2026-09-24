# Column and Dashboard Customization

## Column Layout And Types

- Chat supports `move_record` (for example, "Move Uppal Co to row 2" or "Move row 4 to row 1") and `move_field` ("Move Owner to column 2"). Both preview before saving and support Undo. Row IDs, cell values, history, linked cards and allowance accounting are unchanged by confirmation. No new database migration is needed; the existing record position and column-order storage are used.
- Row positions are one-based in the current visible, sorted view by default. Hidden records keep their slots. Confirmation clears sorting to reveal the manual order. An explicitly requested full-table move uses saved order and shows all rows afterward. Changed views, revisions or sessions invalidate old move previews. Duplicate names require selection; missing or invalid positions need clarification.
- `sort_table` applies the existing typed ascending/descending sort to the current view without saving a new row order. Clearing sorting returns to saved order. The model receives full records, visible row IDs, sort/filter context, displayed field order and an explicit supported-action list.
- AI uses validated, allowlisted actions, not arbitrary database commands. Unsupported requests receive a conversational explanation; multi-action requests are handled one confirmed step at a time. Normal chat styling is used for failures. Unreadable responses (including HTTP 200) fail closed; uncertain saves retain the existing reload/recovery warning. No automatic paid retries are made.

- Drag a column header onto another header to move the entire column. Alt+Left/Right on a focused header also moves it. The first displayed column becomes the effective primary column, including when the previous first column is moved away. Stable field IDs, values, types and semantic roles such as owner/status stay attached to their original fields. Add-record labels, inspector names, linked-card titles and primary-based charts follow the new first column. Order survives reload and supports Undo.
- All records clears the pipeline's search, AI filter and owner scope without changing saved records or dashboard report definitions.
- Ask chat to convert a text column to a calendar/date field. Complete month-name dates and year-first dates are converted to YYYY-MM-DD, with blanks kept blank. Ambiguous numeric dates, missing years and invalid dates require clarification; nothing is silently discarded. The primary field must remain text/choice.
- Ask chat to convert a dropdown to plain text to retain its selections as text. Both conversions use the normal preview, confirmation, save and Undo flow. Incompatible date/owner/status roles and KPI definitions are explained in the preview.
- Apply migrations through 011 before deploying the current UI. Manual column moves do not use AI credits. AI conversion requests use the existing chat allowance.

## Bulk Actions and Suggestions

- Chat uses `add_record` for one new row and `add_records` for a batch. Every requested row appears in one preview, then saves atomically after confirmation. Cancel writes nothing; Undo removes the confirmed additions together. Old singular actions carrying a records array remain compatible instead of requiring a missing single-record object.
- Creation uses the current column IDs and labels, including custom fields. Company/account/deal/client/business name aliases can resolve a single equivalent column such as Deal / Account Name; exact labels take precedence. Distinct plausible columns, conflicting values, missing primary values, invalid choices/dates and unrecognized supplied details trigger a clarification that retains the complete request. Values are never invented or silently dropped to complete a batch.
- New-record previews are invalidated when the workspace changes. No migration is required; the existing versioned save RPC preserves the full batch and per-user isolation. Automated/browser tests use simulated AI; a paid live model call is a separate check.

- Chat can propose `delete_records` for all records matching a condition, including blank or whitespace-only client names. Conditions apply to the full saved table, not just a selected row or a filtered view. The preview lists every match and warns about associated To Do cards; nothing is deleted until confirmation. Stale previews are rejected, and Undo restores records and linked cards together. Ambiguous single-record requests still require clarification.
- When a workflow concept recurs and has no equivalent field, chat can return `propose_field`. The panel shows Proposed new field, the reason and a blank text column for review. It does not add or populate anything automatically, interrupt an existing proposal, or repeatedly suggest a declined field unless the user revisits it.
- The X on the Undo notification dismisses the notice without reverting the saved change. A subsequent change displays a fresh Undo notification.

## Existing Controls

- Right-click a table header (or focus it and press Shift+F10) and select Rename column. Confirm the preview. Only the label changes; stable field IDs, roles, values, records and history remain unchanged.
- Ask chat to turn a column into a dropdown. Without options, it asks which options to use. A request to use existing distinct values is also valid, but it must be explicit. Up to 30 distinct options are supported, with 80 characters per option.
- Conversion matches existing values case-insensitively with normalized whitespace/accents. Matches use the canonical option spelling. Nonblank unmatched values are listed by record ID in the preview and become blank only on confirmation. Other columns stay unchanged. Manual dropdowns, filtering, sorting and CSV mapping use the resulting type.
- Numeric/date fields can become dropdowns. A converted follow-up date loses its date role. Invalid report filters and incompatible KPI overrides are removed; the preview lists removed overrides. Undo restores the previous schema, values and KPI definitions.
- Ask chat to edit a top dashboard KPI, such as changing Total Score to Average Score. The model proposes a definition, never a numeric result. Preview, confirm and undo work as for table edits. Settings persist across reloads and sessions.
- KPI measures are count, sum and average. Blank numbers are excluded, zeroes included. Conditions are ANDed: equality/inequality, blank/nonblank, numeric/date comparisons, dates before today or older than a specified number of days. Empty dates never count as stale. The chatbot must clarify the meaning of stale and relevant date/status fields rather than inventing a policy.
- Cards calculate from the current visible table rows and current date; chart-specific selections remain separate. A KPI change does not change rows or the chart definition. Existing saved overrides are supplied to the model for subsequent refinements.

No authentication, quota, signup, provider or model settings change. AI actions use the normal metered endpoint; manual rename remains available at the chat cap. See `SUPABASE-DEPLOYMENT.md` for migration order and rollback constraints.

## Text, Sorting and KPI Lifecycle

- Text cells expand and wrap on click or keyboard focus, including single-line long notes. They collapse on blur. Editing still uses normal save, undo and failed-draft recovery; simply reading a note does not save anything.
- Dropdowns whose complete option set represents recognized timing labels or dates sort by time instead of alphabetically. Today, Tomorrow, Next week and Next month are supported, as are Yesterday, Overdue, This week/month, In N days/weeks/months, and complete supported dates. Next week starts Monday; Next month starts on the first. This week/month begin at today for forward-looking sorting. Blank or unscheduled choices stay last in either direction. Ordinary or mixed non-temporal dropdowns remain alphabetical, with stable ties.
- Import CSV, Add field and Add record controls appear only on Pipeline. Existing chat, dashboard, activity and shared-view behavior remains available.
- Ask chat to add a dashboard KPI to append a card without replacing another. Ask to delete a named dashboard KPI to remove only that card. Both require preview confirmation and support undo. Default-card deletions are stored separately so generated defaults do not return on reload; no rows or fields are deleted. Up to 120 visible cards are supported. A new card needs a distinct title and valid existing field references.
- Example: `Add dashboard KPI called Total number of follow-ups` counts records with a populated follow-up field. The assistant should clarify when multiple columns or meanings are plausible. `Delete dashboard KPI Total number of follow-ups` removes that card only.
