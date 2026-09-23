# PipeChat Supabase SQL Contract

## Local Verification

Run from the app root:

```powershell
node --test test/supabase-sql.test.js
```

The harness executes `db/tests/mock-supabase.sql`, the complete migration, and
`db/tests/security.sql` in a new in-memory PGlite PostgreSQL instance. No network,
project credentials, services, persistent database, or deployment is used.
PGlite is the exact `@electric-sql/pglite` development dependency managed by the
main project. `mock-supabase.sql` is test-only, never a hosted migration.

Only `db/migrations/001-supabase.sql` is the new installation artifact. Apply it
once as the trusted migration/database owner, in a fresh project, after review.
It deliberately fails on an existing `pipechat` schema rather than replacing
data. It neither imports Xano data nor modifies `db/supabase-schema.sql`. Existing
auth users are not backfilled: create application users after installation.

## Public RPCs

All functions return a single JSONB object. Parameter names are significant for
PostgREST. All CRM writes include all four parameters, including a nullable
initial version. Never parse and reformat the returned version token.

| Function | Parameters | Result |
| --- | --- | --- |
| `pipechat_health` | none | `{ok:true,contract:"pipechat-supabase-v1",database:"ok",schemaVersion:1}` |
| `pipechat_read_crm` | none | `{deals,customFields,tableSchema,updatedAt}` |
| `pipechat_write_crm` | `p_deals jsonb`, `p_custom_fields jsonb`, `p_table_schema jsonb`, `p_expected_updated_at text` | Same complete CRM snapshot |
| `pipechat_read_usage` | none | `{used,limit,reserved,remaining,paymentRequired,updatedAt}` |
| `pipechat_reserve_usage` | `p_request_id uuid` | `{reservationId,usage}` |
| `pipechat_finish_usage` | `p_reservation_id uuid`, `p_outcome text` (`commit` or `release`) | Usage object |

Signup atomically provisions one empty workspace, owner membership, pending
schema, no custom fields or records, initial CRM `updatedAt:null`, and a personal
usage counter with limit 1000. Signup metadata cannot set ownership or limits.
Pending-to-ready setup must write an empty table first. Null legacy schemas are
not accepted in this fresh-install contract. Explicit validated `legacy:true`
ready schemas remain supported. Writes retain array ordering, safe integer IDs,
typed values, blanks, history, activity, and health. Data is stored as one SQL row
per record, not one aggregate CRM blob. Schema/custom metadata is separate.

Each write locks the workspace before comparing its exact version and applies
records, schema, custom fields, and the next version atomically. Invalid rows
roll back the entire write. Reads acquire a shared workspace lock for a coherent
snapshot. Shared members observe the same workspace and CAS version; usage
remains per user. Membership and quota management are trusted-admin SQL only.

## Errors And Bounds

| SQLSTATE | Meaning |
| --- | --- |
| `PT400` | Invalid payload, schema/transition, cell, row ID, history, outcome, or size |
| `PT401` | Missing, malformed, foreign, or revoked session; missing required account/membership |
| `PT402` | Exhausted quota; `DETAIL` is the usage object itself as JSON text, with no identifiers |
| `PT409` | Stale CRM token, unknown/foreign reservation, completed reserve retry, conflicting finalize, or expired commit |

PostgREST exposes SQL `DETAIL` as `error.details`; adapters can `JSON.parse` it
for `PT402`. It is not nested under `usage`. Native PostgreSQL parameter decoding
errors occur before a function can run (for example invalid UUID syntax,
JSON containing a NUL, or invalid JSON). These are native 400-class errors, not
`PT400`. A role without EXECUTE gets `42501`, not `PT401`.

SQL enforces a 16 MiB UTF-8 serialized JSON limit on the raw CRM snapshot and
again on the canonical result, including unknown input properties. PostgreSQL
JSONB serialization includes whitespace, making this slightly more conservative
than the adapter's compact-JSON 16 MiB limit. Output expansion cannot leave a
snapshot too large for the adapter to read. Rejection never truncates data.

Existing core limits are enforced: 2,000 records, 30 schema fields, 20 custom
text fields, 30 options, 60-character labels, 80-character option labels,
2,000-character descriptions, 12,000-character text cells, and absolute numeric
values at most one trillion. Label and text lengths count UTF-16 code units to
match JavaScript, including supplementary Unicode characters. Row IDs must be
positive safe integers, with no duplicates. Unknown `f_`/`cf_` fields are rejected;
unrelated keys are discarded rather than persisted or returned.

Additional defensive history bounds (the old core had no explicit bounds):
10,000 entries per record, 32,768 UTF-16 units per history entry, and 12,000 units
each for activity/health. This accommodates a generated change message containing
both old and new 12,000-character cells plus actor and field metadata. These caps
are new rejection boundaries, not trimming rules. The total snapshot limit also
applies. Callers should surface `PT400` without retrying the unchanged payload.

## Quota Semantics

Every usage RPC locks the user's counter, then lazily expires reservations whose
fixed five-minute deadline has passed. Active duplicate request IDs return the
same reservation without extending its expiry or taking another slot. The
idempotency key is `(user_id, request_id)`; reservation IDs are separate UUIDs.
Completed and expired request IDs remain tombstones and cannot reserve again.
Do not purge them while exact lifetime request idempotency is required.

Commit consumes one reserved slot exactly once. Release consumes no allowance.
A matching finalize retry returns current usage without changing counters or
timestamps. An opposite outcome returns `PT409`; committed usage cannot be
refunded by release. Expired commit returns `PT409`; expired release is a harmless
success. Unknown and other users' reservations share the same safe error.
CRM editing does not depend on the chat quota.

An error rolls back all changes made by that call, including its lazy expiry
sweep. The absolute deadline still prevents charging or revival; the next
successful read/reserve/release persists the sweep. No worker or cron is needed
for correct displayed usage. Changing `quota_limit` is an admin operation:

```sql
-- Trusted admin connection only, not an exposed RPC or browser operation.
update pipechat.usage_counters
set quota_limit = 1000, updated_at = clock_timestamp()
where user_id = '<auth-user-uuid>'::uuid;
```

Changing the table's `quota_limit` default controls future signups. Lowering an
existing limit below used plus reserved gives zero remaining; an already-valid
reservation can still commit. Counter totals stay within JS safe integer range.

## Security And Remaining Checks

All public RPCs are SECURITY DEFINER with `search_path=pg_catalog`; referenced
tables, auth functions, and helpers are schema-qualified. EXECUTE is revoked
from PUBLIC and all API roles before narrow grants: health to anon/authenticated,
five data RPCs to authenticated only. No service-role credential is required or
granted access. Private helpers and tables have no API grants. Policy-free RLS
also denies direct table access if someone later accidentally grants table ACLs.
The migration owner must remain trusted and API roles must not inherit it.

Every authenticated data RPC checks both `auth.uid()` and JWT `session_id`
against a matching `(id,user_id)` in `auth.sessions`. This implements Supabase's
[documented sign-out revocation pattern](https://supabase.com/docs/guides/auth/sessions#how-to-ensure-an-access-token-jwt-cannot-be-used-after-a-user-signs-out).
Token signature, expiry, and role verification remain Supabase Auth/PostgREST's
responsibility; arbitrary SQL clients that can forge request GUCs are not an
authentication boundary. Session maximum-lifetime/inactivity settings are not
proactive session deletion. Health is intentionally anonymous, performs a real
version-table read, and never returns user or CRM data.

PGlite runs genuine PostgreSQL SQL, constraints, roles, RLS, triggers, functions,
transactions, and error codes. It does not provide independent concurrent
database connections or a live Auth/PostgREST HTTP boundary. No native psql,
postgres, or Docker executable was available on PATH during local verification.
Expiry tests advance test-owned timestamps while preserving the five-minute
invariant; they do not wait five real minutes.

Before deployment approval, verify these checks on a disposable local
multi-connection PostgreSQL environment or an explicitly approved test project:

1. Two concurrent writes with the same workspace token: exactly one success,
   one `PT409`, with no mixed rows/metadata or torn reader snapshot.
2. Concurrent reserve calls for a final quota slot: one success and one `PT402`;
   identical concurrent request IDs return one reservation and occupy one slot.
3. Concurrent commit/commit, commit/release, expiry/commit, and expired-key retry:
   no double charge, refund, revival, or counter/ledger mismatch.
4. Revoke a real Auth session and call all data RPCs with its still-unexpired
   access token: each fails `PT401`; health remains anonymous and status-only.
5. Check real PostgREST status/DETAIL mapping and default ACLs; ensure the private
   `pipechat` schema is not exposed, and only publishable/anon credentials are
   configured in the application.

The approved hosted project has since been configured and tested. See
`SUPABASE-MIGRATION.md` for dated browser evidence, user-reported real race/expiry
and revoked-session results, quota restoration, and the remaining recovery,
rollback and deployment checks. Those results do not turn these embedded tests
into hosted tests. Live Render still uses Xano.
