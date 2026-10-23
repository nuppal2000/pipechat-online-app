'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Workflows = require('../lib/business-workflows');
const Documents = require('../lib/business-documents');
const Todo = require('../public/todo-core');
const schema = {status:'ready', useCase:'Other', description:'', title:'Work queue', recordLabel:'item', fields:[
  {id:'f_title', name:'Title', type:'text', role:'primary', options:[]},
  {id:'f_state', name:'State', type:'choice', role:'status', options:['Queued','Ready','Closed']}
]};
const spec = () => ({version:2, scope:{type:'all_records'}, name:'Review follow-up', timezone:'America/New_York',
  trigger:{type:'field_changes_to', field:'f_state', to:'Ready'},
  conditions:[{type:'no_open_qualifying_task', match:{field:'nextAction', operator:'contains', value:'review'}}],
  action:{type:'create_linked_task', nextAction:'Schedule review', notes:'Confirm outstanding items', due:{anchor:'event_date', offsetDays:2}}});
const records = () => [{id:41, f_title:'Fixture one', f_state:'Ready'}, {id:42, f_title:'Fixture two', f_state:'Ready'}];
const event = () => ({eventId:'event-fixture-1', recordId:41, field:'f_state', from:'Queued', to:'Ready', occurredAt:'2026-03-08T04:30:00Z'});
const now = '2026-03-08T05:00:00Z';
const stored = value => JSON.parse(JSON.stringify(value));
function draft() {
  const proposal = Workflows.plan({action:'create_workflow', spec:spec()}, {schema});
  return Workflows.apply(proposal, {workflows:[], id:'workflow_fixture', now:'2026-03-01T00:00:00Z', schema}).workflow;
}
function active() {
  const workflow = draft();
  const proposal = Workflows.plan({action:'set_workflow_activation', workflowId:workflow.id, active:true}, {workflows:[workflow], schema});
  return Workflows.apply(proposal, {workflows:[workflow], now:'2026-03-02T00:00:00Z', schema}).workflow;
}
function run(workflow = active(), options = {}) {
  return Workflows.handleEvent({workflow, event:event(), records:records(), cards:[], schema, now, ...options});
}
function card(index, patch = {}) {
  return {...Todo.create('todo_fixture_' + index, 41), nextAction:'Different task', ...patch};
}

test('fixture proof: document download + workflow proposal/apply/activation/run/retry/history', () => {
  const factBundle = {recordId:41, recordName:'Fixture one', revision:'r1', facts:[
    {id:'f_state', label:'State', value:'Ready'}
  ], terms:{}};
  const documentProposal = Documents.plan({action:'create_document', recordId:41, documentType:'proposal', format:'html'}, factBundle);
  assert.match(Documents.apply(documentProposal, factBundle).body, /<h1>Proposal<\/h1>/);
  let workflow = stored(draft());
  assert.equal(workflow.status, 'draft');
  const activation = Workflows.plan({action:'set_workflow_activation', workflowId:workflow.id, active:true}, {workflows:[workflow], schema});
  workflow = stored(Workflows.apply(activation, {workflows:[workflow], now:'2026-03-02T00:00:00Z', schema}).workflow);
  const before = stored(workflow), result = run(workflow);
  assert.deepEqual(workflow, before);
  assert.equal(result.execution.status, 'succeeded');
  assert.equal(result.additions.length, 1);
  assert.equal(result.cards[0].recordId, 41);
  assert.equal(result.cards[0].status, 'To Do');
  assert.equal(result.cards[0].dueDate, '2026-03-09');
  assert.equal(result.cards[0].nextAction, spec().action.nextAction);
  assert.equal(result.cards[0].notes, spec().action.notes);
  assert.deepEqual(Todo.validate(result.cards, records()), result.cards);
  const retry = run(stored(result.workflow), {cards:stored(result.cards), now:'2026-03-20T00:00:00Z'});
  assert.equal(retry.duplicate, true);
  assert.equal(retry.additions.length, 0);
  assert.equal(retry.cards.length, 1);
  assert.equal(retry.execution.attempts, 1);
  assert.deepEqual(retry.workflow, result.workflow);
  const history = Workflows.plan({action:'workflow_history', workflowId:workflow.id, limit:20}, {workflows:[retry.workflow]});
  assert.deepEqual(history.history.map(entry => entry.type), ['execution','activated','created']);
  assert.equal(history.executions[0].event.eventId, event().eventId);
});

test('controlled calendar dates use original event timezone across DST, month and year boundaries', () => {
  for (const [at, zone, offset, expected] of [
    ['2026-03-08T04:30:00Z','America/New_York',2,'2026-03-09'],
    ['2026-03-08T07:30:00Z','America/New_York',1,'2026-03-09'],
    ['2026-11-01T05:30:00Z','America/New_York',1,'2026-11-02'],
    ['2026-11-01T06:30:00Z','America/New_York',1,'2026-11-02'],
    ['2026-12-31T23:30:00Z','Pacific/Kiritimati',2,'2027-01-03'],
    ['2028-02-28T12:00:00Z','UTC',1,'2028-02-29'],
    ['2026-12-31T12:00:00Z','UTC',1,'2027-01-01'],
    ['2026-03-08T00:30:00-04:00','UTC',0,'2026-03-08']
  ]) assert.equal(Workflows.eventDueDate(at, zone, offset), expected);
  assert.throws(() => Workflows.eventDueDate('2026-02-30T00:00:00Z', 'UTC', 1));
  assert.throws(() => Workflows.eventDueDate('2026-02-28T00:00:00', 'UTC', 1));
  assert.throws(() => Workflows.eventDueDate('2026-02-28T24:00:00Z', 'UTC', 1));
  assert.throws(() => Workflows.eventDueDate('2026-02-28T00:00:00Z', 'Local', 1));
  assert.throws(() => Workflows.eventDueDate('9999-12-31T12:00:00Z', 'UTC', 1));
  assert.throws(() => Workflows.eventDueDate('0001-01-01T00:00:00Z', 'America/New_York', 0));
});

test('failure persists without partial tasks; retry uses the same event and original due anchor', () => {
  const full = Array.from({length:2000}, (_, index) => card(index)), before = stored(full);
  const failed = run(active(), {cards:full});
  assert.equal(failed.execution.status, 'failed');
  assert.equal(failed.execution.reason, 'board_capacity');
  assert.equal(failed.additions.length, 0);
  assert.deepEqual(full, before);
  assert.deepEqual(failed.cards, full);
  const retry = run(stored(failed.workflow), {cards:full.slice(0, 1999), now:'2026-03-12T00:00:00Z'});
  assert.equal(retry.execution.status, 'succeeded');
  assert.equal(retry.execution.attempts, 2);
  assert.equal(retry.cards.length, 2000);
  assert.equal(retry.additions[0].dueDate, '2026-03-09');
  assert.deepEqual(retry.workflow.history.filter(entry => entry.type === 'execution').map(entry => entry.status), ['failed','succeeded']);
  assert.deepEqual(Workflows.validateState(stored(retry.workflow)), retry.workflow);
  const again = run(retry.workflow, {cards:retry.cards, now:'2026-03-13T00:00:00Z'});
  assert.equal(again.duplicate, true);
  assert.equal(again.cards.length, 2000);
});

test('retry rechecks no-open-task condition and current record rather than using stale success plans', () => {
  const failed = run(active(), {cards:Array.from({length:2000}, (_, index) => card(index))});
  const retry = run(failed.workflow, {cards:[card('new', {nextAction:'Review remaining details', status:'In Progress'})]});
  assert.equal(retry.execution.status, 'skipped');
  assert.equal(retry.execution.reason, 'open_task_exists');
  assert.equal(retry.execution.attempts, 2);
  assert.equal(retry.additions.length, 0);
  assert.equal(run(failed.workflow, {records:[{...records()[0], f_state:'Closed'}, records()[1]]}).execution.reason, 'record_no_longer_matches');
  const changedSchema = {...schema, fields:schema.fields.map(field => field.id === 'f_state' ? {...field, options:['Queued','Closed']} : field)};
  assert.equal(run(failed.workflow, {schema:changedSchema}).execution.reason, 'schema_changed');
});

test('schema failure is retryable after repair and event-ID tampering is rejected', () => {
  const changed = {...schema, fields:schema.fields.filter(field => field.id !== 'f_state')};
  const failed = run(active(), {schema:changed});
  assert.equal(failed.execution.reason, 'schema_changed');
  assert.equal(run(failed.workflow).execution.status, 'succeeded');
  for (const patch of [{recordId:42}, {from:'Closed'}, {to:'Closed'}, {occurredAt:'2026-03-08T04:31:00Z'}, {field:'f_title'}]) {
    assert.throws(() => run(failed.workflow, {event:{...event(), ...patch}}), /eventId/);
  }
});

test('no-open qualification uses same-record To Do/In Progress only; standalone/unrelated/Done do not block', () => {
  for (const status of ['To Do','In Progress']) {
    const result = run(active(), {cards:[card(1, {nextAction:'  REVIEW  details ', status})]});
    assert.equal(result.execution.reason, 'open_task_exists');
  }
  for (const task of [
    card(1, {nextAction:'Review details', status:'Done'}),
    card(1, {nextAction:'Review details', recordId:42}),
    card(1), {...card(1, {nextAction:'Review details', recordId:null}), customTitle:'Standalone'}
  ]) assert.equal(run(active(), {cards:[task]}).execution.status, 'succeeded');
});

test('equals task qualifier is exact after normalization, not a substring match', () => {
  const definition = spec();
  definition.conditions[0].match = {field:'nextAction', operator:'equals', value:'Schedule review'};
  const proposal = Workflows.plan({action:'create_workflow', spec:definition}, {schema});
  const first = Workflows.apply(proposal, {workflows:[], id:'workflow_equals', now:'2026-03-01T00:00:00Z', schema}).workflow;
  const activation = Workflows.plan({action:'set_workflow_activation', workflowId:first.id, active:true}, {workflows:[first], schema});
  const workflow = Workflows.apply(activation, {workflows:[first], now:'2026-03-02T00:00:00Z', schema}).workflow;
  assert.equal(run(workflow, {cards:[card(1, {nextAction:' SCHEDULE   review '})]}).execution.reason, 'open_task_exists');
  assert.equal(run(workflow, {cards:[card(1, {nextAction:'Schedule review later'})]}).execution.status, 'succeeded');
});

test('wrong transition, missing record, stale current value and inactive events are recorded without tasks', () => {
  for (const [options, reason] of [
    [{event:{...event(), from:'Ready'}}, 'trigger_not_matched'],
    [{event:{...event(), to:'Queued'}}, 'trigger_not_matched'],
    [{event:{...event(), field:'f_title'}}, 'trigger_not_matched'],
    [{records:[records()[1]]}, 'record_missing'],
    [{records:[{...records()[0], f_state:'Closed'}, records()[1]]}, 'record_no_longer_matches'],
    [{event:{...event(), occurredAt:'2026-03-01T12:00:00Z'}}, 'before_activation']
  ]) {
    const result = run(active(), options);
    assert.equal(result.execution.reason, reason);
    assert.equal(result.execution.status, 'skipped');
    assert.equal(result.additions.length, 0);
    Workflows.validateState(result.workflow);
  }
  assert.equal(run(draft()).execution.reason, 'inactive');
});

test('terminal events remain consumed after task deletion/completion and new events recheck the board', () => {
  const first = run();
  const deleted = run(first.workflow, {cards:[]});
  assert.equal(deleted.duplicate, true);
  assert.equal(deleted.additions.length, 0);
  const another = {...event(), eventId:'event-fixture-2'};
  assert.equal(run(first.workflow, {event:another, cards:first.cards}).execution.reason, 'open_task_exists');
  const done = first.cards.map(task => ({...task, status:'Done'}));
  const later = run(first.workflow, {event:another, cards:done});
  assert.equal(later.execution.status, 'succeeded');
  assert.notEqual(later.additions[0].id, first.additions[0].id);
});

test('pause/activation previews enforce version checks and activation does not retroactively replay events', () => {
  const workflow = active(), workflows = [workflow];
  const proposal = Workflows.plan({action:'set_workflow_activation', workflowId:workflow.id, active:false}, {workflows, schema});
  const changed = run(workflow).workflow;
  assert.throws(() => Workflows.apply(proposal, {workflows:[changed], now, schema}), /changed/);
  const paused = Workflows.apply(proposal, {workflows, now:'2026-03-03T00:00:00Z', schema}).workflow;
  const skipped = run(paused);
  assert.equal(skipped.execution.reason, 'inactive');
  const activation = Workflows.plan({action:'set_workflow_activation', workflowId:paused.id, active:true}, {workflows:[skipped.workflow], schema});
  const resumed = Workflows.apply(activation, {workflows:[skipped.workflow], now, schema}).workflow;
  assert.equal(run(resumed).duplicate, true);
  assert.equal(run(resumed, {event:{...event(), eventId:'older-unconsumed'}}).execution.reason, 'before_activation');
  const repeat = Workflows.plan({action:'set_workflow_activation', workflowId:resumed.id, active:true}, {workflows:[resumed], schema});
  assert.equal(Workflows.apply(repeat, {workflows:[resumed], now, schema}).count, 0);
  Workflows.validateState(resumed);
});

test('transaction result can be discarded and recomputed; stale concurrent results must not both commit', () => {
  const workflow = active(), base = stored(workflow);
  const a = run(workflow), b = run(workflow);
  assert.deepEqual(a, b);
  assert.deepEqual(workflow, base);
  assert.equal(a.baseRevision, workflow.revision);
  const different = run(workflow, {event:{...event(), eventId:'another-event'}});
  assert.equal(different.baseRevision, a.baseRevision);
  assert.notEqual(different.baseRevision, a.workflow.revision);
  const recomputed = run(a.workflow, {cards:a.cards, event:{...event(), eventId:'another-event'}});
  assert.equal(recomputed.execution.reason, 'open_task_exists');
  assert.equal(recomputed.cards.length, 1);
});

test('deterministic task-ID collisions fail without changing the board', () => {
  const workflow = active(), task = card(1, {id:Workflows.taskId(workflow.id, event().eventId), recordId:42});
  const result = run(workflow, {cards:[task]});
  assert.equal(result.execution.reason, 'task_id_conflict');
  assert.deepEqual(result.cards, [task]);
});

test('strict event, clock, snapshot and persistence validation fail atomically', () => {
  const workflow = active(), before = stored(workflow);
  for (const options of [
    {now:undefined}, {now:'2026-03-01T00:00:00Z'}, {cards:undefined}, {records:[records()[0], records()[0]]},
    {event:{...event(), occurredAt:'2026-03-09T00:00:00Z'}}, {event:{...event(), occurredAt:'2026-02-30T00:00:00Z'}},
    {event:{...event(), script:'bad'}}, {event:{...event(), eventId:''}}, {event:{...event(), recordId:-1}},
    {event:{...event(), from:{value:'Queued'}}}
  ]) assert.throws(() => run(workflow, options));
  assert.deepEqual(workflow, before);
  const executed = run().workflow;
  for (const mutate of [
    value => { value.revision++; }, value => { value.executions[0].eventHash = 'forged'; },
    value => { value.executions[0].attempts = 2; }, value => { value.status = 'paused'; },
    value => { value.executions[0].taskId = 'todo_forged'; }, value => { value.spec.action.due.anchor = 'now'; },
    value => { value.history.at(-1).reason = 'made_up'; }, value => { value.executions.push(value.executions[0]); },
    value => { value.updatedAt = '2026-03-08T05:00:00+00:00'; }
  ]) { const changed = stored(executed); mutate(changed); assert.throws(() => Workflows.validateState(changed)); }
});

test('normalized timestamps identify equivalent retries and history includes the most recent attempts first', () => {
  const failed = run(active(), {cards:Array.from({length:2000}, (_, index) => card(index))});
  const secondEvent = {...event(), eventId:'second-event', recordId:42};
  const second = run(failed.workflow, {event:secondEvent, now:'2026-03-09T00:00:00Z'});
  const retry = run(second.workflow, {cards:second.cards, event:{...event(), occurredAt:'2026-03-07T23:30:00-05:00'}, now:'2026-03-10T00:00:00Z'});
  assert.equal(retry.execution.attempts, 2);
  assert.equal(retry.execution.status, 'succeeded');
  assert.equal(retry.cards.length, 2);
  const history = Workflows.plan({action:'workflow_history', workflowId:retry.workflow.id, limit:1}, {workflows:[stored(retry.workflow)]});
  assert.equal(history.executions[0].event.eventId, event().eventId);
  assert.equal(history.history[0].eventId, event().eventId);
  assert.equal(retry.workflow.executions.length, 2);
});

test('failed event retried after pause is consumed without creating a task', () => {
  const failed = run(active(), {cards:Array.from({length:2000}, (_, index) => card(index))});
  const proposal = Workflows.plan({action:'set_workflow_activation', workflowId:failed.workflow.id, active:false}, {workflows:[failed.workflow], schema});
  const paused = Workflows.apply(proposal, {workflows:[failed.workflow], now, schema}).workflow;
  const retry = run(paused);
  assert.equal(retry.execution.attempts, 2);
  assert.equal(retry.execution.reason, 'inactive');
  assert.equal(retry.additions.length, 0);
  Workflows.validateState(retry.workflow);
});

function scoped(due = null) {
  const value = spec(); value.scope = {type:'record_ids', recordIds:[41]}; value.action.due = due;
  const context = {schema, records:records(), workflows:[]};
  const created = Workflows.apply(Workflows.plan({action:'create_workflow', spec:value}, context),
    {...context, id:'workflow_scoped', now:'2026-03-01T00:00:00Z'});
  return Workflows.apply(Workflows.plan({action:'set_workflow_activation', workflowId:created.workflow.id, active:true},
    {...context, workflows:created.workflows}), {...context, workflows:created.workflows, now:'2026-03-02T00:00:00Z'}).workflow;
}

test('F01 scoped workflow matches stable IDs, not names, and never assigns an unrequested due date', () => {
  const workflow = scoped(), result = run(workflow);
  assert.equal(result.execution.status, 'succeeded');
  assert.equal(result.execution.dueDate, null);
  assert.equal(result.additions[0].dueDate, '');
  assert.equal(result.additions[0].recordId, 41);
  assert.deepEqual(Workflows.validateState(stored(result.workflow)), result.workflow);
  const wrong = run(workflow, {event:{...event(), recordId:42}, records:records().map(r => ({...r, f_title:'Same name'}))});
  assert.equal(wrong.execution.reason, 'record_out_of_scope');
  assert.deepEqual(wrong.cards, []);
  assert.equal(run(wrong.workflow, {event:{...event(), recordId:42}}).duplicate, true);
  const renamed = run(workflow, {records:records().map(r => ({...r, f_title:'Renamed'}))});
  assert.equal(renamed.execution.status, 'succeeded');
  assert.equal(run(workflow, {records:records().slice(1)}).execution.reason, 'record_missing');
  const replacement = {...records()[0], id:43};
  assert.equal(run(workflow, {records:[replacement], event:{...event(), recordId:43}}).execution.reason, 'record_out_of_scope');
  assert.equal(run(result.workflow, {cards:[]}).duplicate, true, 'task deletion cannot reopen an event');
  assert.equal(run(active(), {event:{...event(), recordId:42}}).execution.status, 'succeeded', 'explicit all-record intent');
});

test('undated scoped workflows preserve failures, retry, dedup, pause and creation validation', () => {
  const workflow = scoped(), full = Array.from({length:2000}, (_,i) => card(i));
  const failed = run(workflow, {cards:full});
  assert.equal(failed.execution.reason, 'board_capacity');
  const retried = run(failed.workflow, {now:'2026-03-20T00:00:00Z'});
  assert.equal(retried.execution.status, 'succeeded');
  assert.equal(retried.execution.attempts, 2);
  assert.equal(retried.execution.dueDate, null);
  assert.equal(retried.cards[0].dueDate, '');
  Workflows.validateState(retried.workflow);
  const pause = Workflows.plan({action:'set_workflow_activation', workflowId:workflow.id, active:false}, {workflows:[failed.workflow], schema});
  const paused = Workflows.apply(pause, {workflows:[failed.workflow], schema, now}).workflow;
  const skipped = run(paused);
  assert.equal(skipped.execution.reason, 'inactive');
  assert.equal(run(skipped.workflow).duplicate, true);
  const plan = Workflows.plan({action:'create_workflow', spec:workflow.spec}, {schema, records:records()});
  assert.throws(() => Workflows.apply(plan, {workflows:[], schema, records:[], id:'workflow_new', now}), /current workspace/);
  const invalid = stored(retried.workflow); invalid.executions[0].dueDate = '2026-03-09';
  assert.throws(() => Workflows.validateState(invalid), /persisted task result/);
});

test('persisted legacy states retain global scope, due dates and lifecycle without normalization', () => {
  const legacy = active(); legacy.spec.version = 1; delete legacy.spec.scope;
  const original = stored(legacy);
  assert.deepEqual(Workflows.validateState(legacy), original);
  const result = run(legacy, {event:{...event(), recordId:42}});
  assert.equal(result.execution.status, 'succeeded');
  assert.equal(result.execution.dueDate, '2026-03-09');
  assert.deepEqual(result.workflow.spec, original.spec);
  assert.deepEqual(legacy, original);
  const invalid = stored(result.workflow); invalid.executions[0].dueDate = null;
  assert.throws(() => Workflows.validateState(invalid), /persisted task result/);
});
