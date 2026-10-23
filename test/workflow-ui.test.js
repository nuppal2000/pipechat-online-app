'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const UI = require('../public/workflow-ui');
const HTTP = require('../lib/business-automation-http');
const Workflows = require('../lib/business-workflows');
const { legacySchema } = require('../public/table-schema');
const clone = x => structuredClone(x);
const version = '2026-01-01T00:00:00.000Z';
const spec = { version: 2, scope: { type: 'all_records' }, name: '<img src=x onerror=alert(1)>', timezone: 'America/New_York',
  trigger: { type: 'field_changes_to', field: 'stage', to: 'Won' },
  conditions: [{ type: 'no_open_qualifying_task', match: { field: 'nextAction', operator: 'contains', value: 'Follow up' } }],
  action: { type: 'create_linked_task', nextAction: 'Follow up', notes: '<script>bad()</script>', due: { anchor: 'event_date', offsetDays: 2 } } };
function fixture() {
  const tableSchema = legacySchema(), action = { action: 'create_workflow', spec };
  const workflow = Workflows.apply(Workflows.plan(action, { schema: tableSchema }), { workflows: [], id: 'workflow_test', now: version, schema: tableSchema }).workflow;
  const snapshot = { updatedAt: version, tableSchema, customFields: [], deals: [], todoCards: [], workflows: [workflow] };
  const proposal = HTTP.prepare('owner', { action, expectedUpdatedAt: version }, snapshot, snapshot);
  return { workflow, snapshot, proposal, action };
}
function element() {
  return { innerHTML: '', textContent: '', handlers: {}, classList: { add() {}, remove() {} },
    addEventListener(name, fn) { this.handlers[name] = fn; }, removeEventListener(name) { delete this.handlers[name]; } };
}
function button(dataset = {}, attributes = []) {
  const value = { dataset, disabled: false, hasAttribute: key => attributes.includes(key) };
  return { target: { closest: () => value } };
}

test('scope and no-due policy are canonical in draft, activation, retry and saved list previews', () => {
  const {snapshot} = fixture(); snapshot.deals = [{id:1,account:'Acorn',stage:'Won'}];
  const scoped = clone(spec); scoped.scope = {type:'record_ids',recordIds:[1]}; scoped.action.due = null;
  const context = {schema:snapshot.tableSchema,records:snapshot.deals,workflows:[]};
  const action = {action:'create_workflow',spec:scoped};
  const created = Workflows.apply(Workflows.plan(action,context), {...context,id:'workflow_scoped',now:version});
  snapshot.workflows = created.workflows;
  const proposal = HTTP.prepare('owner',{action,expectedUpdatedAt:version},snapshot,snapshot);
  const activation = HTTP.prepare('owner',{action:{action:'set_workflow_activation',workflowId:created.workflow.id,active:true},expectedUpdatedAt:version},snapshot,snapshot);
  for (const p of [proposal,activation]) {
    assert.equal(p.preview.scope, 'Only records: Acorn (#1)');
    assert.match(UI.review(p), /<dt>Scope<\/dt><dd>Only records: Acorn \(#1\)<\/dd>/);
    assert.match(UI.review(p), /<dt>Due<\/dt><dd>No due date<\/dd>/);
  }
  const el = element(), controller = UI.create({element:el,S:{user:{id:'owner'},generation:1,updatedAt:version,
    tableSchema:snapshot.tableSchema,records:snapshot.deals}});
  controller.setSnapshot(snapshot);
  assert.match(el.innerHTML, /Only records: Acorn \(#1\)/); assert.match(el.innerHTML, /No due date/);
  assert.doesNotMatch(el.innerHTML, /Event date|undefined/);
  const active = Workflows.apply(Workflows.plan(activation.action,{...context,workflows:created.workflows}),
    {...context,workflows:created.workflows,now:version}).workflow;
  const cards = Array.from({length:2000},(_,i) => ({id:'todo_'+i,recordId:1,status:'Done',nextAction:'Other',notes:'',dueDate:''}));
  const failed = Workflows.handleEvent({workflow:active,records:snapshot.deals,cards,schema:snapshot.tableSchema,now:version,
    event:{eventId:'scope_retry',recordId:1,field:'stage',from:'Discovery',to:'Won',occurredAt:version}});
  snapshot.workflows = [failed.workflow];
  const retry = HTTP.prepare('owner',{workflowId:active.id,eventId:'scope_retry',expectedUpdatedAt:version},snapshot,snapshot,true);
  assert.equal(retry.preview.scope, proposal.preview.scope); assert.equal(retry.preview.due, 'No due date');
  assert.match(UI.review(retry), /Only records: Acorn \(#1\)/);
  const changedSchema = clone(snapshot);
  changedSchema.tableSchema.fields = changedSchema.tableSchema.fields.filter(field => field.id !== 'stage');
  const retryAfterSchemaChange = HTTP.prepare('owner',{workflowId:active.id,eventId:'scope_retry',expectedUpdatedAt:version},
    changedSchema,changedSchema,true);
  assert.equal(retryAfterSchemaChange.preview.scope, 'Only records: Acorn (#1)', 'display names do not revalidate a broken trigger');
  assert.equal(UI.reason('record_out_of_scope'), 'Record outside workflow scope');
  const tampered = clone(proposal); tampered.preview.scope = 'All records';
  assert.throws(() => HTTP.confirmation('owner',{proposal:tampered,confirm:true}), /proposal changed/);
  const legacy = clone(created.workflow); legacy.spec.version = 1; delete legacy.spec.scope;
  legacy.spec.action.due = {anchor:'event_date',offsetDays:2};
  controller.setSnapshot({...snapshot,workflows:[legacy]});
  assert.match(el.innerHTML, /All records \(legacy workflow\)/);
  assert.match(el.innerHTML, /Event date \+ 2 calendar days/);
});

test('workflow list is escaped, draft activation is review-only, and history is read-only', async () => {
  const { snapshot, workflow } = fixture(), el = element(), calls = [], prepared = [], retries = [];
  const S = { user: { id: 'owner' }, generation: 1, updatedAt: version };
  const controller = UI.create({ element: el, S, prepare: action => prepared.push(action), retry: (...args) => retries.push(args),
    api: async url => { calls.push(url); return url.includes('/history') ? { workflowId: workflow.id,
      history: workflow.history, executions: [{ status: 'failed', reason: 'board_capacity', event: { recordId: 1, eventId: '<event>' } }] } : snapshot; } });
  await controller.load();
  assert.match(el.innerHTML, /wf-draft/); assert.match(el.innerHTML, /America\/New_York/);
  assert.ok(!el.innerHTML.includes('<img')); assert.match(el.innerHTML, /&lt;img/);
  const input = { dataset: { wfActivation: workflow.id }, checked: true };
  await el.handlers.change({ target: input });
  assert.equal(input.checked, false); assert.equal(prepared.length, 1);
  assert.deepEqual(prepared[0], { action: 'set_workflow_activation', workflowId: workflow.id, active: true });
  assert.equal(controller.getSnapshot().workflows[0].status, 'draft');
  await el.handlers.click(button({ wfHistory: workflow.id }));
  assert.match(el.innerHTML, /Saved history/); assert.match(el.innerHTML, /Review retry/); assert.match(el.innerHTML, /&lt;event&gt;/);
  await el.handlers.click(button({ wfRetry: workflow.id, event: '<event>' }));
  assert.deepEqual(retries, [[workflow.id, '<event>']]);
  assert.ok(calls.every(url => !url.includes('confirm')), 'the list cannot execute mutations');
  S.pending = {}; await el.handlers.change({ target: { ...input, checked: true } }); assert.equal(prepared.length, 1);
  S.pending = null; S.updatedAt = 'newer'; controller.draw(); assert.match(el.innerHTML, /workspace has changed/);
  S.user.id = 'other'; controller.draw(); assert.equal(el.innerHTML, ''); assert.equal(controller.getSnapshot(), null);
});

test('workflow reads discard late owner/generation results and clear private data on failure', async () => {
  const { snapshot } = fixture(), el = element(), S = { user: { id: 'owner' }, generation: 1, updatedAt: version };
  let resolve;
  const controller = UI.create({ element: el, S, api: () => new Promise(done => { resolve = done; }) });
  const pending = controller.load(); S.generation++; controller.clear(); resolve(snapshot); await pending;
  assert.equal(controller.getSnapshot(), null); assert.equal(el.innerHTML, '');
  const failed = UI.create({ element: el, S, api: async () => { throw new Error('Session revoked'); } });
  failed.setSnapshot(snapshot); await failed.load();
  assert.equal(failed.getSnapshot(), null); assert.match(el.innerHTML, /Session revoked/); assert.ok(!el.innerHTML.includes('&lt;img'));
});

test('workflow review shows full escaped spec, explicit draft/activation/retry and recovery controls', () => {
  const { proposal } = fixture();
  const html = UI.review(proposal);
  assert.match(html, /Save draft/); assert.match(html, /America\/New_York/); assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
  assert.match(UI.review(proposal, { attempted: true, error: 'Not confirmed' }), /Retry same save/);
  assert.match(UI.review(proposal, { refresh: true }), /data-confirm disabled/);
  assert.match(UI.review(proposal, { refresh: true }), /Refresh and review/);
  assert.match(UI.review(proposal, { saving: true }), /Saving\.\.\./);
  const retry = { ...proposal, operation: 'retry', preview: { ...proposal.preview, status: 'paused', reason: 'board_capacity', attempts: 1,
    event: { recordId: 1, from: 'Discovery', to: 'Won', occurredAt: version } } };
  assert.match(UI.review(retry), /Confirm retry/); assert.match(UI.review(retry), /skip and consume/);
});

const source = fs.readFileSync(path.join(__dirname, '../public/pipechat.js'), 'utf8');
function handlers(api) {
  const { snapshot } = fixture(), nodes = new Map(), applied = [], messages = [];
  const S = { user: { id: 'owner' }, generation: 1, updatedAt: version, revision: 0, pending: null, history: ['keep chat'], saving: false };
  const context = vm.createContext({ S, C: { clone: x => JSON.parse(JSON.stringify(x)) }, api,
    window: { PipeChatWorkflowUI: UI }, icon: () => '', $: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    applySavedSnapshot(saved) { applied.push(clone(saved)); S.updatedAt = saved.updatedAt; S.records = saved.deals; S.todoCards = saved.todoCards; S.revision++; },
    say: message => messages.push(message), toast() {}, render() {}, renderTrust() {}, focusTrust() {},
    clearDraft() { S.pending = null; S.sourceAction = null; }, Date, Error
  });
  vm.runInContext(source.slice(source.indexOf('  let workflowUI=null;'), source.indexOf('  async function prepareDocument')) +
    '\nthis.actions={prepareWorkflow,prepareWorkflowRetry,confirmWorkflow,showWorkflowHistory,refreshWorkflowReview};', context);
  return { S, actions: context.actions, applied, messages, nodes, snapshot };
}

test('pipechat workflow handlers require review then apply durable snapshot and journal undo without losing chat', async () => {
  const { proposal, snapshot, action } = fixture(), calls = [];
  const saved = { ...snapshot, updatedAt: '2026-01-01T00:00:01.000Z' };
  const h = handlers(async (url, options) => {
    calls.push({ url, body: options && JSON.parse(options.body) });
    return url.endsWith('/prepare') ? proposal : { snapshot: saved, receipt: { actionId: proposal.actionId }, replayed: false, workflow: saved.workflows[0] };
  });
  await h.actions.prepareWorkflow(action);
  assert.equal(h.S.pending.kind, 'workflow-save'); assert.equal(h.applied.length, 0);
  await h.actions.confirmWorkflow(h.S.pending);
  assert.deepEqual(h.applied, [saved]); assert.equal(h.S.pending, null); assert.equal(h.S.updatedAt, saved.updatedAt);
  assert.deepEqual(h.S.history, ['keep chat']); assert.equal(h.S.undo.kind, 'journal'); assert.equal(h.S.undo.actionId, proposal.actionId);
  assert.equal(calls[1].body.confirm, true); assert.deepEqual(calls[1].body.proposal, proposal);
  assert.match(h.messages.at(-1), /not active/); assert.equal(h.S.saving, false);
  assert.ok(calls.every(call => call.url.startsWith('/api/workflows')), 'no AI or unrelated save');
});

test('failed acknowledgement retains exact proposal; replay refreshes current snapshot not original receipt', async () => {
  const { proposal, snapshot, action } = fixture(), bodies = [];
  const current = { ...snapshot, updatedAt: '2026-01-01T00:00:03.000Z' };
  let failure = true;
  const h = handlers(async (url, options) => {
    if (url.endsWith('/prepare')) return proposal;
    if (url === '/api/crm-data' || url === '/api/workflows') return current;
    bodies.push(JSON.parse(options.body));
    if (failure) { failure = false; throw new Error('Lost acknowledgement'); }
    return { snapshot, receipt: { actionId: proposal.actionId }, replayed: true };
  });
  await h.actions.prepareWorkflow(action); const pending = h.S.pending;
  await assert.rejects(() => h.actions.confirmWorkflow(pending), /Lost acknowledgement/);
  assert.equal(h.S.pending, pending); assert.equal(pending.attempted, true); assert.equal(h.applied.length, 0);
  assert.ok(!h.messages.some(m => m.includes('saved.')));
  await h.actions.confirmWorkflow(pending);
  assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(h.applied, [current]); assert.equal(h.S.pending, null);
});

test('stale or changed-session workflow confirmations cannot apply data or claim success', async () => {
  const { proposal, action, snapshot } = fixture(); let calls = 0, finish;
  const h = handlers(async url => { calls++; return url.endsWith('/prepare') ? proposal : new Promise(resolve => { finish = resolve; }); });
  await h.actions.prepareWorkflow(action); const p = h.S.pending;
  h.S.updatedAt = 'newer'; await assert.rejects(() => h.actions.confirmWorkflow(p), /workspace changed/);
  assert.equal(calls, 1); assert.equal(p.refresh, true); assert.equal(h.applied.length, 0);
  h.S.updatedAt = version; const pending = h.actions.confirmWorkflow(p); h.S.generation++;
  finish({ snapshot, receipt: { actionId: proposal.actionId }, replayed: false }); await pending;
  assert.equal(h.applied.length, 0); assert.equal(h.S.undo, undefined);
});

test('explicit workflow replacement prepares a fresh proposal while retaining its original request', async () => {
  const { proposal, action } = fixture(), calls = [];
  const h = handlers(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ...clone(proposal), action: JSON.parse(options.body).action };
  });
  const original = 'Create a follow-up workflow and preview before saving.';
  await h.actions.prepareWorkflow(action, null, original);
  const first = h.S.pending, revision = clone(action);
  revision.spec.action.due.offsetDays = 5;
  await h.actions.prepareWorkflow(revision, first, 'Use five calendar days.');
  assert.notEqual(h.S.pending, first);
  assert.equal(h.S.pending.originalCommand, original);
  assert.equal(h.S.pending.proposal.action.spec.action.due.offsetDays, 5);
  assert.equal(h.S.pending.attempted, false);
  assert.equal(h.applied.length, 0);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url === '/api/workflows/prepare'));
});

test('an explicit replacement must still be the current workflow draft', async () => {
  const { proposal, action } = fixture();
  let calls = 0;
  const h = handlers(async () => { calls++; return proposal; });
  await h.actions.prepareWorkflow(action);
  const old = h.S.pending;
  h.S.pending = null;
  await assert.rejects(() => h.actions.prepareWorkflow(action, old), /current draft/);
  h.S.pending = { kind: 'business-plan' };
  await assert.rejects(() => h.actions.prepareWorkflow(action, h.S.pending), /current draft/);
  assert.equal(calls, 1);
});

test('workflow routing hooks exist in action handling, trust panel and confirmation', () => {
  assert.match(source, /\['create_workflow','set_workflow_activation'\].*prepareWorkflow\(action,proposalRevision\(action,'workflow-save'\),command\)/);
  assert.match(source, /workflow_history.*showWorkflowHistory\(action\)/);
  assert.match(source, /p\.kind==='workflow-save'.*confirmWorkflow\(p\)/);
  assert.match(source, /S\.pending\?\.kind==='workflow-save'.*renderWorkflowReview/);
  assert.match(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), /src="\/workflow-ui\.js"/);
});
