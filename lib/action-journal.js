'use strict';

const { isDeepStrictEqual: equal } = require('node:util');
const { createHash } = require('node:crypto');

/* Integration contract (migration 014):
 * Call pipechat_commit_action(actionId, requestId, conversationId, planId,
 *   expectedUpdatedAt, {deals, todoCards, tableSchema, customFields}, metadata)
 * INSTEAD OF
 * write_workspace_v2 followed by a journal insert. The RPC locks the workspace,
 * saves canonical data, derives the diff from canonical snapshots, and journals
 * it in ONE transaction. Retry the identical RPC with the same IDs/body.
 * pipechat_undo_action(actionId, undoActionId, requestId, expectedUpdatedAt)
 * rechecks the inverse under that same lock and journals the compensation.
 * commit_todo_action has the same arguments but takes only todoCards as payload.
 * metadata optionally includes importReceipt:{id,digest} and schemaChanges:
 * [{kind:'rename_choice_option',fieldId,from,to}]. Both are CRM-only. The receipt
 * and canonical apply share the transaction; replay compares the EXACT submitted
 * payload, expected version, correlation IDs and metadata (not just the digest).
 * Action/plan IDs accept UUIDs OR exact lowercase SHA-256 IDs from action-lifecycle.
 * Commit/undo return {snapshot,receipt,replayed}; snapshot is the ORIGINAL commit
 * snapshot on replay, not current state. Adapter returns {...snapshot,
 * actionReceipt:receipt,replayed,importReceipt?}. Reload readCrm after replay.
 * Freeze all arguments (including optional schema/cards) for cross-request
 * retries; reconstructing omitted fields from a newer read can change the body.
 * Default ordinary IDs hash the normalized request; supply actionId/requestId
 * explicitly when correlating a user-confirmed proposal across network retries.
 * read_action returns {entry,receipt,undoneBy,undoInvalidated}, or null if absent.
 * list_actions(before,limit) returns {actions,before}; before is an opaque cursor.
 * UI Undo sends the selected receipt.actionId and CURRENT updatedAt, plus stable
 * metadata.actionId/requestId for the undo attempt. Do not resend old whole data.
 * A 409 leaves all data untouched: refresh and show conflict. Hide unavailable
 * actions (undoneBy/undoInvalidated or receipt.undoOf != null). No redo in v1.
 * Never accept a client-supplied journal entry as authority to execute undo.
 * This pure planner is for previews/tests; the SQL RPC is the final authority.
 *
 * Format v1 compares complete top-level cell values, including history arrays.
 * Missing and JSON null differ. Record/task IDs are stable, never row offsets.
 * Whole-row creation/deletion, schema objects and saved order are conservative
 * conflict units. Record edits depend on the post-action schema. No global
 * afterVersion equality is required for undo: current-version CAS protects the
 * apply, while only touched fields/dependencies protect its meaning.
 * Value CAS does not detect ABA edits or reused record IDs. All writers must use
 * non-reused IDs (or later add per-field revision/generation tokens) to prevent
 * those cases. Existing writers are NOT retroactively journaled by this module.
 * Initialization may have beforeVersion=null; undo to a pending/unconfigured
 * table is rejected by the existing canonical validator. Use explicit reset.
 *
 * Local JSON integration needs a single durable document/transaction containing
 * workspace + journal, or a WAL with recovery; separate file renames are NOT an
 * atomic multi-file commit. Do not claim atomicity across separate HTTP saves.
 * Retain journal business values privately; never forward them to telemetry.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const COLLECTIONS = new Set(['records', 'tasks', 'schema', 'order', 'workflows']);

function invalid() { throw new Error('Invalid action journal data.'); }
function uuid(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value.toLowerCase();
}
function identifier(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return value;
  return uuid(value);
}

// Reject executable/non-JSON objects instead of invoking getters or toJSON.
function clone(value) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 1000000 || depth > 32) invalid();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) invalid();
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype) &&
        !(Object.getPrototypeOf(item) === null && !array)) invalid();
    ancestors.add(item);
    const result = array ? [] : {};
    const keys = Reflect.ownKeys(item).filter(key => !(array && key === 'length'));
    if (array && keys.length !== item.length) invalid();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || RESERVED.has(key) || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value') || array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
      result[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024 * 1024) invalid();
  return result;
}

function exact(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}

function document(snapshot) {
  const result = { records: {}, tasks: {}, schema: { workspace: {} }, order: { workspace: {} }, workflows: {} };
  for (const [collection, source] of [['records', 'deals'], ['tasks', 'todoCards']]) {
    if (!Array.isArray(snapshot[source])) invalid();
    result.order.workspace[collection] = snapshot[source].map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid();
      if (collection === 'records' ? !Number.isSafeInteger(row.id) || row.id < 1 :
        typeof row.id !== 'string' || !/^todo_[a-z0-9_]{1,60}$/.test(row.id)) invalid();
      const id = String(row.id);
      if (Object.hasOwn(result[collection], id)) invalid();
      result[collection][id] = row;
      return id;
    });
  }
  if (!snapshot.tableSchema || typeof snapshot.tableSchema !== 'object' ||
      Array.isArray(snapshot.tableSchema) || !Array.isArray(snapshot.customFields)) invalid();
  result.schema.workspace = { tableSchema: snapshot.tableSchema, customFields: snapshot.customFields };
  if (snapshot.workflows !== undefined && !Array.isArray(snapshot.workflows)) invalid();
  for (const workflow of snapshot.workflows || []) {
    if (!workflow || typeof workflow.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(workflow.id) ||
        RESERVED.has(workflow.id) || Object.hasOwn(result.workflows, workflow.id)) invalid();
    result.workflows[workflow.id] = workflow;
  }
  return result;
}

function slot(doc, path) {
  let value = doc;
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return { exists: false };
    value = value[key];
  }
  return { exists: true, value };
}

function diff(before, after) {
  const changes = [];
  for (const collection of COLLECTIONS) {
    const ids = [...new Set([...Object.keys(before[collection]), ...Object.keys(after[collection])])].sort();
    for (const id of ids) {
      const left = before[collection][id], right = after[collection][id];
      const paths = collection === 'workflows' || !left || !right ? [[collection, id]] :
        [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().map(key => [collection, id, key]);
      for (const path of paths) {
        const previous = slot(before, path), next = slot(after, path);
        if (!equal(previous, next)) changes.push({ path, before: previous, after: next });
      }
    }
  }
  return changes;
}

function version(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > 256) invalid();
  return value;
}

function buildActionEntry({ actionId, requestId, conversationId = null, planId = null, undoOf = null, before, after }) {
  before = clone(before); after = clone(after);
  const left = document(before), right = document(after), changes = diff(left, right);
  return {
    formatVersion: 1, actionId: identifier(actionId), requestId: uuid(requestId),
    conversationId: uuid(conversationId, true), planId: identifier(planId, true), undoOf: identifier(undoOf, true),
    beforeVersion: version(before.updatedAt, true), afterVersion: version(after.updatedAt), changes,
    dependencies: { schema: changes.some(c => ['records', 'schema'].includes(c.path[0])) ? right.schema.workspace : null }
  };
}

function validateEntry(input) {
  const entry = clone(input);
  exact(entry, ['formatVersion', 'actionId', 'requestId', 'conversationId', 'planId', 'undoOf',
    'beforeVersion', 'afterVersion', 'changes', 'dependencies']);
  if (entry.formatVersion !== 1 || !Array.isArray(entry.changes)) invalid();
  for (const key of ['actionId', 'requestId', 'conversationId', 'planId', 'undoOf']) {
    entry[key] = (['actionId', 'planId', 'undoOf'].includes(key) ? identifier : uuid)(entry[key], !['actionId', 'requestId'].includes(key));
  }
  version(entry.beforeVersion, true); version(entry.afterVersion);
  exact(entry.dependencies, ['schema']);
  if (entry.dependencies.schema !== null) exact(entry.dependencies.schema, ['tableSchema', 'customFields']);
  const paths = [];
  for (const change of entry.changes) {
    exact(change, ['path', 'before', 'after']);
    const p = change.path;
    if (!Array.isArray(p) || ![2, 3].includes(p.length) || !COLLECTIONS.has(p[0]) ||
        p.some(key => typeof key !== 'string' || !key.length || RESERVED.has(key)) ||
        (p[0] === 'records' && !/^[1-9][0-9]*$/.test(p[1])) ||
        (p[0] === 'tasks' && !/^todo_[a-z0-9_]{1,60}$/.test(p[1])) ||
        (['schema', 'order'].includes(p[0]) && (p[1] !== 'workspace' || p.length !== 3)) ||
        (p[0] === 'schema' && !['tableSchema', 'customFields'].includes(p[2])) ||
        (p[0] === 'order' && !['records', 'tasks'].includes(p[2])) || p[2] === 'id') invalid();
    if (p[0] === 'workflows' && (p.length !== 2 || !/^[A-Za-z0-9_-]{1,200}$/.test(p[1]))) invalid();
    if (paths.some(other => other.every((key, i) => p[i] === key) || p.every((key, i) => other[i] === key))) invalid();
    paths.push(p);
    for (const value of [change.before, change.after]) {
      if (typeof value?.exists !== 'boolean') invalid();
      exact(value, value.exists ? ['exists', 'value'] : ['exists']);
    }
    if (equal(change.before, change.after)) invalid();
  }
  if (entry.changes.some(c => ['records', 'schema'].includes(c.path[0])) && entry.dependencies.schema === null) invalid();
  return entry;
}

function planInverse(input, currentSnapshot) {
  const entry = validateEntry(input), current = clone(currentSnapshot), doc = document(current), conflicts = [];
  version(current.updatedAt);
  if (entry.dependencies.schema !== null && !equal(entry.dependencies.schema, doc.schema.workspace)) {
    conflicts.push({ path: ['schema', 'workspace'], reason: 'schema_dependency' });
  }
  for (const change of entry.changes) {
    if (!equal(slot(doc, change.path), change.after) ||
        change.path.length === 3 && !slot(doc, change.path.slice(0, 2)).exists) {
      conflicts.push({ path: change.path, reason: 'field_changed' });
    }
  }
  if (conflicts.length) return { ok: false, actionId: entry.actionId, conflicts };
  for (const change of entry.changes) {
    let parent = doc;
    for (const key of change.path.slice(0, -1)) parent = parent[key];
    const key = change.path.at(-1);
    if (change.before.exists) parent[key] = change.before.value;
    else delete parent[key];
  }
  for (const [id, task] of Object.entries(doc.tasks)) {
    if (task.recordId !== null && !Object.hasOwn(doc.records, String(task.recordId))) {
      conflicts.push({ path: ['tasks', id, 'recordId'], reason: 'task_dependency' });
    }
  }
  for (const collection of ['records', 'tasks']) {
    const order = doc.order.workspace[collection];
    if (!Array.isArray(order) || new Set(order).size !== order.length ||
        !equal([...order].sort(), Object.keys(doc[collection]).sort())) {
      conflicts.push({ path: ['order', 'workspace', collection], reason: 'order_dependency' });
    }
    for (const [id, row] of Object.entries(doc[collection])) if (String(row?.id) !== id) invalid();
  }
  if (conflicts.length) return { ok: false, actionId: entry.actionId, conflicts };
  return {
    ok: true, actionId: entry.actionId, expectedUpdatedAt: current.updatedAt,
    changes: entry.changes.map(c => ({ path: c.path, before: c.after, after: c.before })),
    snapshot: { ...current, deals: doc.order.workspace.records.map(id => doc.records[id]),
      todoCards: doc.order.workspace.tasks.map(id => doc.tasks[id]), ...doc.schema.workspace,
      ...(Object.hasOwn(current, 'workflows') ? { workflows: Object.keys(doc.workflows).sort().map(id => doc.workflows[id]) } : {}) }
  };
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function importReceipt(value) {
  if (value === undefined || value === null) return null;
  exact(value, ['id', 'digest']);
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id) ||
      typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) invalid();
  return value;
}
function prepareMetadata(input = {}, seed) {
  const meta = clone(input);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).some(key =>
    !['actionId', 'requestId', 'conversationId', 'planId', 'importReceipt', 'schemaChanges'].includes(key))) invalid();
  const receipt = importReceipt(meta.importReceipt);
  const schemaChanges = Object.hasOwn(meta, 'schemaChanges') ? require('./schema-changes').validate(meta.schemaChanges) : undefined;
  if (schemaChanges !== undefined && seed?.kind !== 'crm') invalid();
  // Deterministic defaults make exact ordinary retries idempotent too. Imports
  // key on their stable import ID, so a changed digest cannot become a new save.
  const hash = createHash('sha256').update(canonical(receipt ? { importId: receipt.id } :
    schemaChanges === undefined ? clone(seed) : { seed: clone(seed), schemaChanges })).digest('hex');
  const id = identifier(meta.actionId ?? hash);
  const requestHash = createHash('sha256').update('action-request-v1:' + id).digest('hex');
  const request = `${requestHash.slice(0, 8)}-${requestHash.slice(8, 12)}-8${requestHash.slice(13, 16)}-a${requestHash.slice(17, 20)}-${requestHash.slice(20, 32)}`;
  return { actionId: id, requestId: uuid(meta.requestId ?? request), conversationId: uuid(meta.conversationId ?? null, true),
    planId: identifier(meta.planId ?? null, true), importReceipt: receipt, ...(schemaChanges === undefined ? {} : { schemaChanges }) };
}
function validateReceipt(input) {
  const r = clone(input);
  exact(r, ['formatVersion', 'actionId', 'requestId', 'conversationId', 'planId', 'undoOf', 'beforeVersion', 'afterVersion', 'importReceipt']);
  if (r.formatVersion !== 1) invalid();
  r.actionId = identifier(r.actionId); r.requestId = uuid(r.requestId); r.conversationId = uuid(r.conversationId, true);
  r.planId = identifier(r.planId, true); r.undoOf = identifier(r.undoOf, true);
  version(r.beforeVersion, true); version(r.afterVersion); r.importReceipt = importReceipt(r.importReceipt);
  return r;
}
function validateCursor(value) {
  if (value === null) return null;
  const cursor = clone(value); exact(cursor, ['createdAt', 'actionId']);
  if (typeof cursor.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.createdAt) || !Number.isFinite(Date.parse(cursor.createdAt))) invalid();
  cursor.actionId = identifier(cursor.actionId);
  return cursor;
}

module.exports = { buildActionEntry, validateEntry, planInverse, prepareMetadata, validateReceipt, validateCursor, identifier };
