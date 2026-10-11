'use strict';

const { createHash } = require('node:crypto');

/* Server-side only. No default console or in-memory sink. sink.append(event)
 * MUST durably insert-or-compare by eventId AND (requestId, stage, attempt),
 * returning {eventId, inserted}; changed content for the same key is a conflict.
 * createSqlTelemetrySink implements this via migration 014 and the caller's
 * authenticated SQL session. Keep JWT/session setup outside the event object.
 * Await record(); do not fire-and-forget. On an unavailable sink retain prepared
 * events in a durable outbox and replay them; this helper does not invent one.
 * It guarantees idempotent ledger effects, not exactly-once model execution or
 * exactly-once delivery. No raw prompts, answers, emails, errors, headers, URLs,
 * access tokens, provider IDs or arbitrary dimensions cross the sink boundary.
 * model is a trusted routing alias or allowlisted configured model ID, never an
 * arbitrary provider response string. The model IDs below mirror the repo's
 * defaults; extend BOTH JS and SQL allowlists deliberately for new deployments.
 * If telemetry must commit with a CRM action, use an outbox/append inside the
 * SAME transaction. Calling record() after an action RPC is not atomic with it.
 *
 * Conversation integration gaps observed in the existing code:
 * - server prepareConversation reads history; /api/pipechat-ai never durably
 *   writes a terminal assistant/failed turn. The browser's 180ms outbox is lost
 *   on exit; its catch-generated failure text is not a server receipt.
 * - Persist accepted(requestId, threadId, userMessageId) before model work, then
 *   CAS to succeeded/failed/cancelled/interrupted with a stable assistant ID and
 *   bounded public error code. Write terminal message + status + telemetry
 *   outbox transactionally before acknowledging. Recover stale running turns
 *   as interrupted; never automatically rerun a possibly paid model request.
 * - Usage reservation currently gets a new random UUID per HTTP attempt. Bind
 *   it to the accepted request ID and replay the saved result on retries.
 * - conversation_threads has PK(workspace_id,user_id); epoch is a reset token,
 *   not a multi-thread selection API. Add immutable thread IDs, a per-user
 *   active-thread pointer and create/list/select RPCs; scope reads/writes/search,
 *   summaries, state and accepted turns by owned thread ID. Creating a thread
 *   must retain earlier threads, start with empty focus/summary/draft state, and
 *   never invoke workspace reset. Fence late responses by request AND thread ID.
 * - The current 409 acknowledgement check looks only at the last 50 messages;
 *   add a request/message-ID receipt lookup instead of assuming absence means
 *   a save failed. Neither this helper nor migration 014 implements that UI/API.
 *
 * Objective26 handoff: proposed parent-owned SQL/API contract (NOT implemented):
 *
 * Tables:
 *   conversation_turns(workspace_id,user_id,request_id PK scoped to workspace/user,
 *     thread_id,user_message_id,assistant_message_id,attempt,status,lease_until,
 *     public_error_code,result_receipt,accepted_at,finished_at).
 *   status: accepted/running -> succeeded/failed/cancelled/interrupted, immutable
 *   once terminal. A repeated terminal request must compare identical result
 *   identity; a competing outcome is 409, never last-writer-wins.
 *   Add a UNIQUE(workspace_id,user_id,epoch) to the thread table, move its PK to
 *   epoch (currently already unique), REMOVE UNIQUE(workspace_id,user_id), and
 *   add conversation_active(workspace_id,user_id,thread_id,version) with a
 *   composite owned-thread FK. Retain existing epochs/messages during migration.
 *   Add the same composite thread FK to turns. Request ID stays unique across
 *   the user's threads so a retry cannot silently become work in a new thread.
 *
 * RPC begin_turn(threadId, requestId, userMessageId, assistantMessageId,
 *                expectedThreadVersion):
 *   authenticate -> lock workspace FOR UPDATE -> owned thread -> turn;
 *   replay existing receipt first (verify immutable thread/message identity);
 *   otherwise check current thread version and verify the already-flushed user
 *   message exists in THAT thread. Insert accepted turn and reserve_usage with
 *   requestId in this transaction. Commit BEFORE calling the provider. Catch a
 *   quota refusal in a subtransaction, then commit its failed receipt outside
 *   that exception block; throwing out of the RPC would roll the receipt back.
 *
 * RPC finish_turn(threadId, requestId, terminalStatus, publicErrorCode,
 *                 assistantMessage, preparedTelemetry):
 *   same authentication and workspace -> thread -> turn lock order;
 *   replay terminal receipt BEFORE checking stale UI versions; reject a changed
 *   terminal payload; verify a pending turn and its stable assistantMessageId;
 *   map failure codes to server-owned display text, not raw provider exceptions;
 *   append the terminal assistant message, increment thread sequence/version,
 *   preserve CURRENT thread state (do not overwrite with the request's old draft),
 *   CAS turn to terminal, finish_usage(commit for produced plans, release for
 *   provider failure), and record_beta_event(preparedTelemetry) in ONE SQL call.
 *   A late failure rolls back message + terminal marker + usage + ledger. Return
 *   {requestId,threadId,status,assistantMessageId,threadVersion,resultReceipt}.
 *   In today's single-thread schema a wrapper can call write_conversation with
 *   the LOCKED CURRENT version/state, not the stale pre-model version. Once
 *   multiple threads exist, replace that helper's user-only thread lookup first.
 *   An alternate telemetry outbox INSERT in this same transaction is acceptable;
 *   a later standalone HTTP telemetry call is NOT an atomic substitute.
 *
 * Routes: POST /api/conversations (idempotent thread creation + active pointer),
 * GET /api/conversations, GET/PUT /api/conversations/:threadId, and
 * GET /api/conversations/:threadId/turns/:requestId (exact durable receipt).
 * Thread-scoped versions/search/memory APIs must check ownership, not just UUID.
 * Reuse the pre-send flush, adding stable message/request/thread IDs to its
 * response and AI request. On failure the server awaits finish_turn even after
 * the HTTP client disconnects; abort provider work, not terminal persistence.
 * Browser recovery reads receipts and renders saved messages without re-adding
 * catch text under random IDs. A new-thread switch fences late UI responses but
 * allows the old turn's terminal archive to finish in the OLD thread.
 *
 * A finally block alone cannot survive process death: persist lease/attempt at
 * acceptance, and run a recovery worker for expired turns. It marks interrupted
 * and releases/reconciles reservations without rerunning the model. Revoked user
 * sessions cannot call authenticated RPCs: that worker needs a separate narrow,
 * server-only recovery function with audited tenant scope, not a browser grant.
 * Local mode needs turns+messages+thread state in ONE atomic file/transaction;
 * a conversation JSON save followed by a separate receipt save has a crash gap.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = Object.freeze(['request', 'model', 'plan', 'action', 'undo', 'turn']);
const OUTCOMES = Object.freeze(['succeeded', 'failed', 'cancelled', 'conflict', 'interrupted']);
const MODELS = Object.freeze(['primary', 'fallback', 'unknown', 'gpt-5.4-mini', 'gpt-5.2']);
const ERRORS = Object.freeze(['none', 'unknown', 'timeout', 'unavailable', 'invalid_response',
  'validation', 'conflict', 'unauthorized', 'quota', 'cancelled']);
function invalid() { throw new Error('Invalid telemetry event.'); }
function read(input, key) {
  const d = Object.getOwnPropertyDescriptor(input, key);
  if (!d) return undefined;
  if (!Object.hasOwn(d, 'value')) invalid();
  return d.value;
}
function id(value, optional = false, hash = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (hash && typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return value;
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value.toLowerCase();
}
function choice(value, values) { if (!values.includes(value)) invalid(); return value; }
function count(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
  return value === 0 ? 0 : value;
}

function sanitizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const get = key => read(input, key);
  const requestId = id(get('requestId'));
  const stage = choice(get('stage'), STAGES), attempt = count(get('attempt') ?? 0, 10000);
  const hash = createHash('sha256').update(JSON.stringify(['beta-telemetry-v1', requestId, stage, attempt])).digest('hex');
  const eventId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const usage = get('usage');
  if (usage !== undefined && usage !== null && (typeof usage !== 'object' || Array.isArray(usage))) invalid();
  const metric = name => usage == null || read(usage, name) == null ? null : count(read(usage, name), 1000000000);
  const inputTokens = metric('inputTokens'), outputTokens = metric('outputTokens'), cachedTokens = metric('cachedTokens');
  if (cachedTokens !== null && (inputTokens === null || cachedTokens > inputTokens)) invalid();
  const errorCode = get('errorCode');
  return Object.freeze({
    formatVersion: 1, eventId, requestId, conversationId: id(get('conversationId'), true),
    planId: id(get('planId'), true, true), actionId: id(get('actionId'), true, true), stage, attempt,
    outcome: choice(get('outcome'), OUTCOMES), latencyMs: count(get('latencyMs'), 86400000),
    model: MODELS.includes(get('model')) ? get('model') : 'unknown',
    inputTokens, outputTokens, cachedTokens,
    errorCode: errorCode === undefined ? 'none' : ERRORS.includes(errorCode) ? errorCode : 'unknown'
  });
}

function createSqlTelemetrySink({ query }) {
  if (typeof query !== 'function') throw new TypeError('An authenticated SQL query function is required.');
  return Object.freeze({
    async append(event) {
      const result = await query('select public.pipechat_record_beta_event($1::jsonb) as receipt', [JSON.stringify(event)]);
      return result.rows[0].receipt;
    }
  });
}

function validateStoredEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) invalid();
  const input = {};
  for (const key of ['requestId', 'conversationId', 'planId', 'actionId', 'stage', 'attempt',
    'outcome', 'latencyMs', 'model', 'errorCode']) input[key] = read(event, key);
  input.usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens']) input.usage[key] = read(event, key);
  const sanitized = sanitizeEvent(input);
  if (read(event, 'eventId') !== sanitized.eventId || read(event, 'formatVersion') !== 1) invalid();
  return sanitized;
}

function createBetaTelemetry({ sink } = {}) {
  if (!sink || typeof sink.append !== 'function') throw new TypeError('A durable telemetry sink is required.');
  return Object.freeze({
    prepare: sanitizeEvent,
    async record(input) {
      const event = sanitizeEvent(input);
      return persist(event);
    },
    // Prepared events are serialized by the caller's durable retry outbox.
    async persist(event) {
      return persist(validateStoredEvent(event));
    }
  });
  async function persist(event) {
    const receipt = await sink.append(event);
    if (!receipt || receipt.eventId !== event.eventId || typeof receipt.inserted !== 'boolean') {
      throw new Error('Telemetry persistence was not acknowledged.');
    }
    return Object.freeze({ eventId: receipt.eventId, inserted: receipt.inserted });
  }
}

module.exports = { sanitizeEvent, validateStoredEvent, createBetaTelemetry, createSqlTelemetrySink };
