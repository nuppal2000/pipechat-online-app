# Smart Dashboard

The default chart now groups by the current primary column against the selected numeric Measure, falling back to count when no numeric field exists. Bar charts have a row for every group; there is no default top-N truncation.

## Flexible Chat Reports

New model responses use `show_report` with `smartReport` version 1. The model receives the full authorized table, schema and current report. `public/report-engine.js` validates the declarative specification and calculates values from rows; no model-supplied totals, SQL or executable expressions are accepted.

- Bar, line, stage/doughnut and ad hoc KPI displays; any existing grouping column and optional split series.
- Up to six conditional measures: count, sum, average, min, max, median, distinct count and percentage.
- AND/OR conditions, arbitrary category subsets, numeric/date ranges, text/blank checks and explicit relative-date rules.
- Day, Monday-based week, month, quarter and year date groups; label/value sorting and explicitly requested top/bottom N.
- Full-table scope by default, regardless of pipeline search or My records. Explicitly asking for the current filtered view uses visible scope.

`where` is an OR array of AND condition arrays. Empty means unrestricted. Measure conditions intersect with the base filter. Percentage means numerator-matching rows divided by all base-filtered rows in that group. Missing amounts are excluded, not zero; actual zeroes remain zero. Undated rows are counted as excluded from date groups. Missing numeric series values remain null.

Examples: "Compare total value for Ravi and Sarah excluding Lost deals"; "Show their monthly values as separate lines"; "Now compare averages"; "Show won percentage by representative"; "Compare median scores for candidates A, B and C".

Invalid fields, mixed units, negative stage values, ambiguous targets, unclear business rules and unsupported derived calculations require clarification. The previous valid chart is retained for invalid requests. Deleted fields invalidate reports visibly rather than silently broadening them. Bounds are 24 series and 4,000 points; exceeding them asks for a narrower report, never silently truncates.

Manual controls remain available. With multiple measures, Metric/Measure edit the first measure and retain the other series/conditions. Common owner/primary filters are reflected in selection menus. Chart reports are transient and read-only; existing persistent top KPI cards keep their definitions and pipeline-view scope. Advanced ad hoc KPI reports use the chart region. Persistent card changes still require their existing preview/confirmation workflow.

PDF export captures the chart, all calculated report rows and filter/series descriptions. Browser QA uses synthetic local data and simulated model responses, with no paid calls or live CRM edits.

## Legacy Compatibility

PipeChat can compare total deal value, average known deal value, or deal count for selected owners and selected account names. Reports are read-only: the AI proposes a report specification and PipelineCore calculates the chart and table from the current user's loaded CRM rows. No model-supplied totals are used.

## Requests

- Compare total value of all accounts under Ravi and Sarah.
- Compare values for accounts Alpha, Beta and Gamma.
- Now compare their average deal values.
- Show the deal count for those accounts.

The dashboard also provides searchable Owners and Accounts checkbox menus, an Account grouping option, metric/chart selectors and Reset report. These manual controls do not call the AI or consume chat allowance.

## Report Contract

```json
{
  "metric": "sum",
  "field": "value",
  "groupBy": "owner",
  "chart": "bar",
  "owners": ["Ravi", "Sarah"],
  "accounts": null,
  "filter": null,
  "from": null,
  "to": null
}
```

- `owners` and `accounts`: `null` (or omitted for older clients) means unrestricted; `[]` means no entities. An empty string selects blank owner/account names.
- Names in each list are OR; both lists, the optional single filter, and date bounds intersect (AND). Existing pipeline search/scope filters also apply and remain visible in the dashboard.
- Selection matches normalized exact names, not substrings or comma-separated strings. The model should ask for clarification when a requested partial name is ambiguous.
- `groupBy: "account"` combines deals with the same normalized account name. The Deals column exposes the number of contributing rows.
- `metric` supports `sum`, `average` and `count`. Sum and average exclude unknown amounts; an all-unknown group remains `null`, not zero. Count includes rows with unknown amounts.
- Missing selected entities are reported in the caption; no matching rows means no invented bars or totals. A reset restores the primary-column report, while unrelated pipeline filters are unchanged.
- Conversation refinements receive the complete `currentReport`, including both selection lists. Explicitly new comparisons replace previous entity selections; refinements preserve them.

## Verification

The dashboard-only Download button exports the currently rendered KPI cards, chart (or chart-mode KPI values), filters and complete report summary table to a paginated PDF. Generation happens locally in the browser using pinned pdfmake 0.3.11 and embedded Roboto fonts, loaded only when exporting. No CRM write, AI request or external document upload occurs. The report is a snapshot at click time; a sign-out during generation cancels the download. This exports the current chart, not every possible report or raw CRM record.

Core tests cover subsets, case normalization, duplicate account names, zero/unknown values, filter/date intersections, empty/missing names and invalid selection lists. Workflow tests cover chart datasets, context preservation, read-only behavior, reset, escaping and unknown-value rendering. The server mock validates the strict output schema and forwarded selection context.

For hosted browser QA, use `scripts/Start-SupabaseBrowserQA.ps1` with approved disposable accounts. It uses simulated AI and real test-account storage; credentials must remain private. Pure chart and AI contract tests run offline through `npm test`. See `WORKSPACE-CUSTOMIZATION.md` for persistent KPI add, edit and delete behavior.
