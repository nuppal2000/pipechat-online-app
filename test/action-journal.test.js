'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { buildActionEntry, validateEntry, planInverse, prepareMetadata, validateReceipt } = require('../lib/action-journal');

const copy = value => structuredClone(value);
const base = () => ({ updatedAt: 'v1', deals: [{ id: 1, account: 'A', owner: 'Before', notes: '' },
  { id: 2, account: 'B', owner: 'Other' }], todoCards: [
  { id: 'todo_one', recordId: 1, status: 'To Do', notes: '', nextAction: '', dueDate: '' }
], tableSchema: { status: 'ready', fields: [{ id: 'owner', type: 'text' }] }, customFields: [] });
const entry = (before, after) => buildActionEntry({ actionId: randomUUID(), requestId: randomUUID(),
  conversationId: randomUUID(), planId: randomUUID(), before, after });

test('undo identified older action preserves intervening edits on same row, other rows and tasks', () => {
  const before = base(), after = copy(before);
  after.deals[0].owner = 'After'; after.updatedAt = 'v2';
  const a = entry(before, after), current = copy(after);
  current.deals[0].notes = 'New independent note';
  current.deals[1].owner = 'Later owner'; current.todoCards[0].status = 'Done'; current.updatedAt = 'v99';
  const original = copy(current), result = planInverse(a, current);
  assert.equal(result.ok, true); assert.equal(result.expectedUpdatedAt, 'v99');
  assert.equal(result.snapshot.deals[0].owner, 'Before');
  assert.equal(result.snapshot.deals[0].notes, 'New independent note');
  assert.equal(result.snapshot.deals[1].owner, 'Later owner');
  assert.equal(result.snapshot.todoCards[0].status, 'Done');
  assert.deepEqual(current, original);
  assert.deepEqual(result.changes.map(c => c.path), [['records', '1', 'owner']]);
  assert.deepEqual(validateEntry(a), a);
});

test('conflicting field rejects the entire inverse, without leaking values into conflicts', () => {
  const before = base(), after = copy(before);
  after.deals[0].owner = 'After'; after.todoCards[0].status = 'Done'; after.updatedAt = 'v2';
  const a = entry(before, after), current = copy(after);
  current.deals[0].owner = 'Intervening';
  const result = planInverse(a, current);
  assert.deepEqual(result, { ok: false, actionId: a.actionId,
    conflicts: [{ path: ['records', '1', 'owner'], reason: 'field_changed' }] });
  assert.equal(current.todoCards[0].status, 'Done');
});

test('missing versus null, stable IDs after reorder, and complete array conflict units', () => {
  const before = base(), after = copy(before);
  after.deals[0].nullable = null; after.deals[0].history = ['entry']; after.updatedAt = 'v2';
  const a = entry(before, after), current = copy(after);
  current.deals.reverse();
  const result = planInverse(a, current);
  assert.equal(result.ok, true); assert.equal(result.snapshot.deals[1].id, 1);
  assert.equal(Object.hasOwn(result.snapshot.deals[1], 'nullable'), false);
  current.deals[1].history.push('new history');
  assert.equal(planInverse(a, current).ok, false);
  delete current.deals[1].nullable;
  assert.equal(planInverse(a, current).conflicts.length, 2);
});

test('task edits use task IDs, preserve unrelated edits, and reject missing parents', () => {
  const before = base(), after = copy(before);
  after.todoCards[0].status = 'Done'; after.updatedAt = 'v2';
  const a = entry(before, after), current = copy(after);
  current.deals[0].owner = 'Independent'; current.todoCards[0].notes = 'Keep';
  const result = planInverse(a, current);
  assert.equal(result.snapshot.todoCards[0].status, 'To Do');
  assert.equal(result.snapshot.todoCards[0].notes, 'Keep');
  assert.equal(result.snapshot.deals[0].owner, 'Independent');
  current.todoCards = [];
  assert.equal(planInverse(a, current).ok, false);
});

test('insert/delete inverses protect whole rows, ordering, and newly linked tasks', () => {
  const before = base(), after = copy(before);
  after.deals.push({ id: 3, account: 'Created' }); after.updatedAt = 'v2';
  const a = entry(before, after), current = copy(after);
  assert.deepEqual(planInverse(a, current).snapshot.deals, before.deals);
  current.todoCards.push({ ...current.todoCards[0], id: 'todo_new', recordId: 3 });
  assert.equal(planInverse(a, current).conflicts[0].reason, 'task_dependency');
  current.todoCards.pop(); current.deals[2].notes = 'Do not delete';
  assert.equal(planInverse(a, current).ok, false);
  const deleted = copy(before); deleted.deals.shift(); deleted.todoCards = []; deleted.updatedAt = 'v3';
  assert.deepEqual(planInverse(entry(before, deleted), deleted).snapshot.deals, before.deals);
});

test('schema dependencies and versioned entries fail closed', () => {
  const before = base(), after = copy(before);
  after.deals[0].owner = 'After'; after.updatedAt = 'v2';
  const a = entry(before, after), current = copy(after);
  current.tableSchema.fields[0].type = 'number';
  assert.equal(planInverse(a, current).conflicts[0].reason, 'schema_dependency');
  assert.throws(() => planInverse({ ...a, formatVersion: 2 }, after), /Invalid action/);
  assert.throws(() => planInverse({ ...a, changes: [...a.changes, a.changes[0]] }, after), /Invalid action/);
  assert.throws(() => planInverse({ ...a, dependencies: { schema: null } }, after), /Invalid action/);
  assert.throws(() => planInverse({ ...a, changes: [{ ...a.changes[0], path: ['records', '1', '__proto__'] }] }, after), /Invalid action/);
});

test('untrusted JSON never invokes accessors; snapshots and results do not alias', () => {
  const before = base(), after = copy(before); after.updatedAt = 'v2'; after.deals[0].owner = 'After';
  const a = entry(before, after);
  after.deals[0].owner = 'Modified outside';
  assert.equal(a.changes[0].after.value, 'After');
  const hostile = { ...before };
  Object.defineProperty(hostile, 'deals', { enumerable: true, get() { assert.fail('getter invoked'); } });
  assert.throws(() => entry(hostile, after), /Invalid action/);
  const cyclic = base(); cyclic.tableSchema.cycle = cyclic;
  assert.throws(() => entry(cyclic, after), /Invalid action/);
  assert.throws(() => entry({ ...before, deals: [before.deals[0], before.deals[0]] }, after), /Invalid action/);
});

test('proposal hashes and import receipt IDs survive exactly; default IDs are deterministic', () => {
  const before = base(), after = copy(before); after.updatedAt = 'v2'; after.deals[0].owner = 'After';
  const meta = prepareMetadata({ actionId: 'a'.repeat(64), planId: 'b'.repeat(64),
    importReceipt: { id: 'import_one', digest: 'c'.repeat(64) } }, { before, after });
  const action = buildActionEntry({ ...meta, before, after });
  assert.equal(validateEntry(action).actionId, meta.actionId); assert.equal(action.planId, meta.planId);
  const { changes, dependencies, ...receipt } = action;
  assert.deepEqual(validateReceipt({ ...receipt, importReceipt: meta.importReceipt }).importReceipt, meta.importReceipt);
  assert.deepEqual(prepareMetadata({}, { a: 1, b: 2 }), prepareMetadata({}, { b: 2, a: 1 }));
  assert.notEqual(prepareMetadata({}, { a: 1 }).actionId, prepareMetadata({}, { a: 2 }).actionId);
  assert.equal(prepareMetadata({ importReceipt: meta.importReceipt }, { a: 1 }).actionId,
    prepareMetadata({ importReceipt: { ...meta.importReceipt, digest: 'd'.repeat(64) } }, { a: 2 }).actionId);
  assert.throws(() => prepareMetadata({ importReceipt: { id: 'x', digest: 'raw text' } }, {}), /Invalid action/);
});

test('whole-workflow inverse preserves other workflows and rejects intervening execution changes', () => {
  const before = base(); before.workflows = [{ id: 'workflow_a', revision: 1 }, { id: 'workflow_b', revision: 1 }];
  const after = copy(before); after.updatedAt = 'v2'; after.workflows[0].revision = 2;
  const action = entry(before, after), current = copy(after); current.workflows[1].revision = 3;
  assert.deepEqual(action.changes.map(c => c.path), [['workflows', 'workflow_a']]);
  assert.deepEqual(planInverse(action, current).snapshot.workflows, [{ id: 'workflow_a', revision: 1 }, { id: 'workflow_b', revision: 3 }]);
  current.workflows[0].revision = 3;
  assert.equal(planInverse(action, current).ok, false);
});
