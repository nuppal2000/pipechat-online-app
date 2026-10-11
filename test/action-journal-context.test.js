'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { buildActionEntry, validateReceipt, planInverse } = require('../lib/action-journal');
const { enrich, instructions } = require('../lib/action-journal-context');

const copy = value => structuredClone(value);
function saved(paths = [], overrides = {}) {
  return { receipt: validateReceipt({ formatVersion: 1, actionId: randomUUID(), requestId: randomUUID(),
    conversationId: randomUUID(), planId: 'a'.repeat(64), undoOf: null, beforeVersion: 'v1', afterVersion: 'v2',
    importReceipt: { id: 'import_batch', digest: 'b'.repeat(64) } }),
  createdAt: '2026-10-10T12:00:00.000001Z', undoneBy: null, undoInvalidated: false, paths, ...overrides };
}
function pipeline() {
  return { primaryField: 'project', fields: { project: 'Project', lead: 'Assigned to', cf_priority: 'Priority' },
    records: [{ id: 1, project: 'Atlas', lead: 'Sarah', cf_priority: 'High' },
      { id: 2, project: 'Boreal', lead: 'Sarah', cf_priority: 'High' },
      { id: 3, project: 'Cedar', lead: 'Sarah', cf_priority: 'High' }], todoCards: [], todoView: [] };
}

test('one saved three-row priority edit survives reload as one exact eligible receipt with current labels', () => {
  const p = pipeline();
  const before = { updatedAt: 'v1', deals: p.records.map(row => ({ ...row, cf_priority: 'Low' })),
    tableSchema: { status: 'ready', fields: [{ id: 'project', name: 'Project', type: 'text', role: 'primary' }] },
    customFields: [{ id: 'cf_priority', name: 'Priority', type: 'text' }], todoCards: [] };
  const after = { ...copy(before), deals: copy(p.records), updatedAt: 'v2' };
  const entry = buildActionEntry({ actionId: 'c'.repeat(64), requestId: randomUUID(), before, after });
  const { changes, dependencies, ...receipt } = entry;
  const action = saved(changes.map(change => change.path), { receipt: validateReceipt({ ...receipt, importReceipt: null }) });
  const [result] = enrich(JSON.parse(JSON.stringify([action])), JSON.parse(JSON.stringify(p)));
  assert.equal(result.eligible, true);
  assert.deepEqual(result.receipt, action.receipt);
  assert.equal(result.createdAt, action.createdAt);
  assert.equal(result.receipt.actionId, entry.actionId);
  assert.equal(result.pathCount, 3);
  assert.equal(result.omittedPathCount, 0);
  assert.deepEqual(result.paths, action.paths);
  assert.deepEqual(result.pathContext.map(c => [c.recordId, c.currentName, c.fieldId, c.currentFieldLabel]),
    [['1', 'Atlas', 'cf_priority', 'Priority'], ['2', 'Boreal', 'cf_priority', 'Priority'], ['3', 'Cedar', 'cf_priority', 'Priority']]);
  assert(!JSON.stringify(result.pathContext).includes('Low'));
  assert(!JSON.stringify(result.pathContext).includes('High'));
  after.deals[0].cf_priority = 'Later change';
  assert.equal(planInverse(entry, after).ok, false, 'eligibility never overrides the journal conflict guard');
});

test('eligibility excludes undone, invalidated, undo receipts and incomplete metadata without dropping them', () => {
  const available = saved();
  const actions = [available, saved([], { undoneBy: randomUUID() }), saved([], { undoInvalidated: true }),
    saved([], { receipt: { ...available.receipt, undoOf: randomUUID() } }),
    saved([], { undoneBy: undefined }), saved([], { undoInvalidated: undefined }),
    saved([], { receipt: { ...available.receipt, actionId: 'invented' } })];
  const result = enrich(actions, pipeline());
  assert.deepEqual(result.map(a => a.eligible), [true, false, false, false, false, false, false]);
  for (const [i, action] of actions.entries()) {
    assert.deepEqual(result[i].receipt, action.receipt);
    assert.equal(result[i].undoneBy, action.undoneBy);
    assert.equal(result[i].undoInvalidated, action.undoInvalidated);
  }
});

test('multiple eligible matches remain distinct receipts in supplied order for business/time clarification', () => {
  const paths = [['records', '1', 'cf_priority']];
  const actions = [saved(paths), saved(paths, { createdAt: '2026-10-09T10:00:00.000001Z' }),
    saved([['records', '2', 'lead']], { createdAt: '2026-10-08T10:00:00.000001Z' })];
  const result = enrich(actions, pipeline());
  assert.equal(result.length, 3);
  assert(result.every(action => action.eligible));
  assert.deepEqual(result.map(action => action.receipt.actionId), actions.map(action => action.receipt.actionId));
  assert.deepEqual(result.map(action => action.createdAt), actions.map(action => action.createdAt));
  assert.deepEqual(result[0].pathContext, result[1].pathContext);
});

test('current effective primary and renamed field labels win over stale schema roles and sales aliases', () => {
  const p = pipeline();
  p.tableSchema = { columnOrder: ['project', 'account'], fields: [{ id: 'account', name: 'Company', role: 'primary' }] };
  p.records[0].account = 'Old account identity';
  p.fields.cf_priority = 'Urgency';
  p.records[0].project = 'Renamed current project';
  const action = saved([['records', '1', 'cf_priority'], ['records', '1', 'Priority']]);
  const [known, alias] = enrich([action], p)[0].pathContext;
  assert.equal(known.currentPrimaryField, 'project');
  assert.equal(known.currentName, 'Renamed current project');
  assert.equal(known.currentFieldLabel, 'Urgency');
  assert.equal(alias.fieldId, 'Priority');
  assert.equal(alias.currentFieldAvailable, false);
  assert.equal(alias.currentFieldLabel, null);
  delete p.primaryField;
  assert.equal(enrich([action], p)[0].pathContext[0].currentName, null);
});

test('blank, deleted and duplicate primary names retain exact stable identities', () => {
  const p = pipeline();
  p.records[0].project = '   ';
  p.records[0].account = 'Never use this fallback';
  p.records[1].project = 'Same name';
  p.records[2].project = 'Same name';
  const paths = ['1', '2', '3', '90'].map(id => ['records', id, 'cf_priority']);
  const context = enrich([saved(paths)], p)[0].pathContext;
  assert.deepEqual(context.map(c => c.currentName), [null, 'Same name', 'Same name', null]);
  assert.deepEqual(context.map(c => c.recordId), ['1', '2', '3', '90']);
  assert.deepEqual(context.map(c => c.currentRecordAvailable), [true, true, true, false]);
  assert.deepEqual(enrich([saved([['records', '1']])], p)[0].pathContext[0].path, ['records', '1']);
});

test('numeric and boolean primary values are current names, never truthiness-based aliases', () => {
  const p = pipeline();
  p.records[0].project = 0;
  p.records[1].project = false;
  p.records[2].project = { name: 'Not a primary scalar' };
  assert.deepEqual(enrich([saved(p.records.map(r => ['records', String(r.id)]))], p)[0].pathContext.map(c => c.currentName),
    ['0', 'false', null]);
});

test('deleted fields and inherited properties cannot supply labels or historical values', () => {
  const p = pipeline();
  p.fields = Object.assign(Object.create({ removed: 'Inherited label' }), p.fields);
  p.records[0].removed = 'Do not copy removed cell';
  p.records[0].history = [{ before: 'Historical secret' }];
  const context = enrich([saved([['records', '1', 'removed'], ['records', '1', 'constructor'], ['records', '1', 'history']])], p)[0].pathContext;
  assert(context.every(c => c.currentFieldLabel === null && !c.currentFieldAvailable));
  assert(!JSON.stringify(context).includes('Historical secret'));
  assert(!JSON.stringify(context).includes('Do not copy removed cell'));
});

test('task paths use exact authorized titles, statuses and card fields, including standalone and deleted tasks', () => {
  const p = pipeline();
  p.fields.status = 'Unrelated CRM status';
  p.todoView = [{ id: 'todo_linked', recordId: 2, title: 'Boreal', status: 'In Progress' },
    { id: 'todo_standalone', recordId: null, title: 'Team planning', status: 'Done' },
    { id: 'todo_blank', recordId: null, title: '', status: 'To Do' }];
  const paths = [['tasks', 'todo_linked', 'status'], ['tasks', 'todo_standalone', 'dueDate'],
    ['tasks', 'todo_blank', 'customTitle'], ['tasks', 'todo_deleted']];
  const context = enrich([saved(paths)], p)[0].pathContext;
  assert.deepEqual(context.map(c => c.taskId), ['todo_linked', 'todo_standalone', 'todo_blank', 'todo_deleted']);
  assert.deepEqual(context.map(c => c.currentTitle), ['Boreal', 'Team planning', null, null]);
  assert.deepEqual(context.map(c => c.currentStatus), ['In Progress', 'Done', 'To Do', null]);
  assert.equal(context[0].currentFieldLabel, 'Status');
  assert.equal(context[0].currentRecordId, '2');
  assert.equal(context[1].currentRecordId, null);
  assert.equal(context[1].currentFieldLabel, 'Due date');
  assert.equal(context[3].currentTaskAvailable, false);
});

test('raw task cards can resolve titles only from exact linked current records or customTitle', () => {
  const p = pipeline();
  delete p.todoView;
  p.todoCards = [{ id: 'todo_linked', recordId: 1, status: 'Done' },
    { id: 'todo_standalone', recordId: null, customTitle: 'Review', status: 'To Do' },
    { id: 'todo_orphan', recordId: 99, status: 'In Progress' }];
  const context = enrich([saved(p.todoCards.map(t => ['tasks', t.id, 'notes']))], p)[0].pathContext;
  assert.deepEqual(context.map(c => c.currentTitle), ['Atlas', 'Review', null]);
  assert.equal(context[2].currentRecordId, '99');
});

test('schema, order, workflow and unfamiliar paths preserve IDs without inventing an operation or column', () => {
  const paths = [['schema', 'workspace', 'tableSchema'], ['schema', 'workspace', 'customFields'],
    ['order', 'workspace', 'records'], ['order', 'workspace', 'tasks'], ['workflows', 'workflow_one'],
    ['schema', 'workspace', 'cf_priority'], ['future', 'exact-id', 'exact-field']];
  const result = enrich([saved(paths)], pipeline())[0];
  assert.deepEqual(result.paths, paths);
  assert.deepEqual(result.pathContext.map(c => c.kind), ['schema', 'schema', 'order', 'order', 'workflow', 'unknown', 'unknown']);
  assert.equal(result.pathContext[0].schemaPart, 'tableSchema');
  assert.equal(result.pathContext[1].schemaPart, 'customFields');
  assert.equal(result.pathContext[4].workflowId, 'workflow_one');
  assert(result.pathContext.every(c => !Object.hasOwn(c, 'fieldId') && !Object.hasOwn(c, 'currentName')));
});

test('bounded paths and actions expose sampling without shortening IDs or changing receipts', () => {
  const p = pipeline();
  p.records[0].project = 'A'.repeat(600);
  const fieldId = 'field_' + 'x'.repeat(250);
  const action = saved(Array.from({ length: 125 }, (_, i) => ['records', String(i + 1), fieldId]));
  const result = enrich(Array.from({ length: 105 }, () => action), p);
  assert.equal(result.length, 100);
  assert.equal(result[0].paths.length, 100);
  assert.equal(result[0].pathContext.length, 100);
  assert.equal(result[0].pathCount, 125);
  assert.equal(result[0].omittedPathCount, 25);
  assert.equal(result[0].pathContext[0].fieldId, fieldId);
  assert.equal(result[0].paths[0][2], fieldId);
  assert.equal(result[0].pathContext[0].currentName.length, 240);
  assert(result[0].pathContext[0].currentName.endsWith('...'));
  assert.deepEqual(result[0].receipt, action.receipt);
  assert.equal(action.paths.length, 125);
});

test('absent paths are unknown, not an assertion that an action changed nothing', () => {
  const action = saved();
  delete action.paths;
  const [result] = enrich([action]);
  assert.equal(result.eligible, true);
  assert(!Object.hasOwn(result, 'paths'));
  assert.equal(result.pathCount, null);
  assert.equal(result.omittedPathCount, null);
  assert.deepEqual(result.pathContext, []);
  assert.deepEqual(enrich(null), []);
  assert.deepEqual(enrich([]), []);
  assert.throws(() => enrich([saved('records/1/priority')]), /Invalid recent action paths/);
  assert.throws(() => enrich([saved([['records', '1', 'priority', 'nested']])]), /Invalid recent action path/);
});

test('neither enrichment nor later output edits mutate input or share receipt/path arrays', () => {
  const actions = [saved([['records', '1', 'cf_priority']])], p = pipeline();
  const originalActions = copy(actions), originalPipeline = copy(p);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const [result] = enrich(freeze(actions), freeze(p));
  result.receipt.importReceipt.id = 'changed';
  result.paths[0][1] = '999';
  assert.equal(result.pathContext[0].path[1], '1');
  result.pathContext[0].currentName = 'Changed';
  result.pathContext[0].path[1] = '888';
  assert.deepEqual(actions, originalActions);
  assert.deepEqual(p, originalPipeline);
});

test('duplicate IDs and near IDs never guess another record or task', () => {
  const p = pipeline();
  p.records.push({ id: 1, project: 'Duplicate identity' });
  p.todoView = [{ id: 'todo_a', title: 'First' }, { id: 'todo_a', title: 'Second' }];
  const context = enrich([saved([['records', '1'], ['records', '01'], ['tasks', 'todo_a'], ['tasks', 'todo_A']])], p)[0].pathContext;
  assert.equal(context[0].currentName, null);
  assert.equal(context[1].kind, 'unknown');
  assert.equal(context[2].currentTitle, null);
  assert.equal(context[3].kind, 'unknown');
});

test('exported model instructions resolve business undo while preserving historical and conflict boundaries', () => {
  for (const fragment of ['exactly one eligible recent action', 'undo_action', 'exact receipt.actionId', 'after reload',
    'Never ask the user for a technical', 'multiple eligible actions genuinely match', 'business change or time',
    'not historical before/after values', 'not evidence', 'conflict guard', 'user confirmation',
    'preserving unrelated edits', 'Never reconstruct historical before values']) assert(instructions.includes(fragment), fragment);
});
