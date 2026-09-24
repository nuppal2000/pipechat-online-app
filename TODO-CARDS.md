# To Do Cards

Cards use fixed To Do, In Progress and Done lanes. Their status, To Do text, notes and due date are independent of CRM cells. Linked cards display their record's current primary value; deleting that record removes its cards after the existing deletion preview warning.

The New To Do card dialog starts with the linked-record selector and its Custom title option, without a separate search box. Record IDs distinguish duplicate names. Choosing Custom title creates a standalone task with no CRM record. A custom title is required and limited to 500 characters. All additions use the existing proposal and confirmation flow.

Standalone cards survive CRM edits and unrelated record deletions. Reset PipeChat clears all cards, including standalone tasks. AI can edit or delete existing standalone cards by their card ID without touching CRM rows. Custom-title creation is currently through the Add To Do card dialog.

Chat uses `add_todo` for one linked card and `add_todos` for a batch of up to 200 cards. Every item has its own linked record, status, To Do text, notes and date. All items appear in one preview and save together only after confirmation. Cancel writes nothing; Undo removes the batch together. Missing or ambiguous links and invalid dates retain the entire request for clarification, with no partial save. Relative dates use the current date supplied to the model.

The active view is context, not a permission boundary. Explicit CRM edits requested from To Do automatically open Pipeline for the normal preview and confirmation. Card-only requests open To Do and cannot edit CRM cells. Ambiguous requests require clarification. These changes use the existing versioned storage without another migration.

Apply `db/migrations/008-custom-todo-titles.sql` after migration 007 and before deploying this feature. It replaces validation/pruning/reset functions but does not rewrite saved cards, CRM rows, workspace versions or usage counters. Existing linked cards retain the six-key format. Standalone cards use `recordId: null` and add `customTitle`; other card fields stay unchanged. Authenticated, owner-scoped RPCs, optimistic concurrency and card-only writes remain in force.

Tests cover strict input validation, SQL persistence, stale writes, ownership, rollback, linked deletion, standalone retention, undo and confirmed reset. Manual browser QA uses only localhost synthetic records; no paid AI calls are required.
