# To Do Cards

Cards use fixed To Do, In Progress and Done lanes. Their status, To Do text, notes and due date are independent of CRM cells. Linked cards display their record's current primary value; deleting that record removes its cards after the existing deletion preview warning.

The New To Do card dialog starts with the linked-record selector and its Custom title option, without a separate search box. Record IDs distinguish duplicate names. Choosing Custom title creates a standalone task with no CRM record. A custom title is required and limited to 500 characters. All additions use the existing proposal and confirmation flow.

Standalone cards survive CRM edits and unrelated record deletions. Reset PipeChat clears all cards, including standalone tasks. AI can edit or delete existing standalone cards by their card ID without touching CRM rows. Custom-title creation is currently through the Add To Do card dialog.

Chat uses `add_todo` for one linked card and `add_todos` for a batch of up to 200 cards. Every item has its own linked record, status, To Do text, notes and date. All items appear in one preview and save together only after confirmation. Cancel writes nothing; Undo removes the batch together. Missing or ambiguous links and invalid dates retain the entire request for clarification, with no partial save. Relative dates use the current date supplied to the model.

The active view is context, not a permission boundary. Explicit CRM edits requested from To Do automatically open Pipeline for the normal preview and confirmation. Card-only requests open To Do and cannot edit CRM cells. Ambiguous requests require clarification. These changes use the existing versioned storage without another migration.

`move_todos` takes `todoMoves`, a complete list of card IDs and destination statuses. It supports subsets, whole lanes and mixed source/destination lanes. All targets are validated before one preview and one atomic card-only save. Unknown IDs, duplicate IDs and invalid lanes reject the whole request. Already-correct cards are unchanged; unselected cards, task text, dates, notes and CRM records are preserved. Cancel, stale-preview protection and Undo use the same protections as other card changes.

Multiple-choice clarifications carry explicit option keys and meanings. The server resolves short answers such as `a` or `2` against the saved pending question, including older lettered/numbered menus, before asking the model to continue the original request. Prior answers remain available during multi-step clarification. This does not bypass final confirmation or guess unknown choices. Missing optional task dates and notes stay blank instead of prompting unnecessarily.

Board lanes stretch to the tallest lane and accept drops throughout their area. Dragging near the board edge scrolls long boards. Drops from a stale workspace revision, an active proposal or an unsaved card edit cannot overwrite current data.

Apply `db/migrations/008-custom-todo-titles.sql` after migration 007 and before deploying this feature. It replaces validation/pruning/reset functions but does not rewrite saved cards, CRM rows, workspace versions or usage counters. Existing linked cards retain the six-key format. Standalone cards use `recordId: null` and add `customTitle`; other card fields stay unchanged. Authenticated, owner-scoped RPCs, optimistic concurrency and card-only writes remain in force.

Tests cover strict input validation, SQL persistence, stale writes, ownership, rollback, linked deletion, standalone retention, undo and confirmed reset. Automated mocks exercise contracts and failure paths; model interpretation must also be checked against the connected endpoint using an explicitly approved disposable QA account. Only temporary test additions may be removed after that check.
