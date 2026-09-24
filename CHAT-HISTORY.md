# Private Chat History

Apply `db/migrations/010-conversation-history.sql` before deploying the corresponding app release. This migration is additive and does not edit CRM rows or usage allowances.

Each authenticated user has a private conversation within their workspace. Supabase stores original user/assistant messages, an exact pending clarification or unconfirmed action, and a rolling summary separately. Authenticated functions check a live session and derive workspace/user ownership server-side; there are no direct browser table grants. JSON mode uses a separate per-user file for local testing, never as a hosted fallback.

The browser loads the latest 50 messages and can page backward. Only messages successfully saved after this release are available: earlier browser-only conversations cannot be recovered. Closing during a pending save displays an unsaved-work warning. Failed saves retain messages in the current tab and expose Retry. A concurrent-tab conflict requires review instead of overwriting another tab. Reset Pipechat clears the workspace's archived conversation and memory, without resetting the chat allowance.

## Model Context

The server chooses at most 12 recent messages, a bounded older-message summary, and up to four relevant archived excerpts when the user explicitly refers back. The combined serialized history/memory/retrieval/update payload is capped at 12,000 UTF-8 bytes, not an exact token count. Long excerpts are marked as excerpts. The current user message, CRM table, active clarification/action, report definitions and system instructions are separate from this history budget. Full-table context optimization is not part of this release.

When enough older messages accumulate, a normal model response also returns a replacement summary in `memoryNote`. There is no separate summarization API request or extra chat-allowance charge, but the added input and output still use API tokens. A compare-and-set summary watermark advances only through the historical prefix included in that request. Summary failures retain the previous memory and retry in a later normal request. Summaries are lossy, not a guarantee of perfect recall; original messages remain available.

Memory and archived messages are untrusted context, never executable instructions or authorization. Current CRM data takes precedence. A restored proposal must be re-reviewed and confirmed; changed CRM versions retire stale questions/proposals. Import-file previews and oversized proposal state are not restored automatically. Archived messages remain readable in either case.

## Verification

Run `node --test test/*.test.js`. Conversation-specific tests cover SQL ownership/session checks, revoked sessions, message identity, CAS, paging/search, reset rollback, quota independence, Unicode budgets, bounded model requests, summary updates, local persistence and frontend write serialization. Local SQL concurrency uses queued PGlite calls, not a hosted multi-session stress test. No real OpenAI call is required by these tests.
