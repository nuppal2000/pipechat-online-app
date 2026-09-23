# To Do Cards

Cards use fixed To Do, In Progress and Done lanes. Their status, To Do text, notes and due date are independent of CRM cells. Linked cards display their record's current primary value; deleting that record removes its cards after the existing deletion preview warning.

The New To Do card dialog has a searchable record selector and a Custom title option. Choosing Custom title creates a standalone task with no CRM record. Search is case-insensitive, keeps record IDs distinct for duplicate names, and retains an explicitly selected record while filtering. A custom title is required and limited to 500 characters. All additions use the existing proposal and confirmation flow.

Standalone cards survive CRM edits and unrelated record deletions. Reset PipeChat clears all cards, including standalone tasks. AI can edit or delete existing standalone cards by their card ID without touching CRM rows. Custom-title creation is currently through the Add To Do card dialog.

Apply `db/migrations/008-custom-todo-titles.sql` after migration 007 and before deploying this feature. It replaces validation/pruning/reset functions but does not rewrite saved cards, CRM rows, workspace versions or usage counters. Existing linked cards retain the six-key format. Standalone cards use `recordId: null` and add `customTitle`; other card fields stay unchanged. Authenticated, owner-scoped RPCs, optimistic concurrency and card-only writes remain in force.

Tests cover strict input validation, SQL persistence, stale writes, ownership, rollback, linked deletion, standalone retention, undo and confirmed reset. Manual browser QA uses only localhost synthetic records; no paid AI calls are required.
