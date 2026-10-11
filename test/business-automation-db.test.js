'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { legacySchema } = require('../public/table-schema');
const Workflow = require('../lib/business-workflows');
const { buildActionEntry, planInverse } = require('../lib/action-journal');
const { createBusinessAutomationService } = require('../lib/business-automation-service');

const spec = () => ({ version: 1, name: 'Won follow-up', timezone: 'America/New_York',
  trigger: { type: 'field_changes_to', field: 'stage', to: 'Won' },
  conditions: [{ type: 'no_open_qualifying_task', match: { field: 'nextAction', operator: 'contains', value: 'follow up' } }],
  action: { type: 'create_linked_task', nextAction: 'Follow up with customer', notes: 'Saved workflow', due: { anchor: 'event_date', offsetDays: 2 } } });
const body = s => ({ deals: s.deals, todoCards: s.todoCards, tableSchema: s.tableSchema, customFields: s.customFields });
const fails = (f, code) => assert.rejects(f, e => { assert.equal(e.code, code, e.message); return true; });

test('durable business automations on PGlite PostgreSQL', { timeout: 180000 }, async t => {
  let db = new PGlite(); t.after(() => db.close());
  const run = async file => db.exec(await fs.readFile(path.join(__dirname, '../db', file), 'utf8'));
  await run('tests/mock-supabase.sql');
  await db.exec('alter table auth.users add column email text');
  const files = (await fs.readdir(path.join(__dirname, '../db/migrations'))).filter(f => /^\d{3}-.*\.sql$/.test(f) && f < '017').sort();
  for (const file of files) await run('migrations/' + file);

  async function user() {
    const u = { id: randomUUID(), session: randomUUID() };
    await db.query('insert into auth.users(id,email) values($1,$2)', [u.id, u.id + '@example.test']);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [u.session, u.id]);
    u.wid = (await db.query('select id from pipechat.workspaces where owner_id=$1', [u.id])).rows[0].id;
    return u;
  }
  async function as(u, f, role = 'authenticated') {
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: u?.id, session_id: u?.session, role })]);
    await db.exec('set role ' + role);
    try { return await f(); } finally { await db.exec('reset role'); }
  }
  async function rpc(u, name, args = {}, role) {
    assert.match(name, /^pipechat_[a-z0-9_]+$/);
    const entries = Object.entries(args);
    for (const [key] of entries) assert.match(key, /^p_[a-z_]+$/);
    return as(u, async () => (await db.query(`select public.${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(',')}) result`,
      entries.map(([, value]) => value !== null && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].result, role);
  }
  const read = u => rpc(u, 'pipechat_read_workspace');
  const save = (u, s) => rpc(u, 'pipechat_write_workspace_v2', { p_deals: s.deals, p_custom_fields: s.customFields,
    p_table_schema: s.tableSchema, p_expected_updated_at: s.updatedAt, p_todo_cards: s.todoCards });
  const service = u => createBusinessAutomationService({ rpc: (name, args) => rpc(u, name, args) });
  const create = async (u, s, id = 'workflow_followup', value = spec()) => service(u).create({ actionId: randomUUID(),
    requestId: randomUUID(), expectedUpdatedAt: s.updatedAt, workflowId: id, spec: value });
  const activate = (u, s, w, active = true) => service(u).setActivation({ actionId: randomUUID(), requestId: randomUUID(),
    expectedUpdatedAt: s.updatedAt, workflowId: w.id, revision: w.revision, active });
  async function fixture(active = true) {
    const u = await user();
    let s = await save(u, { ...await read(u), tableSchema: legacySchema(), deals: [], todoCards: [] });
    s = await save(u, { ...s, deals: [{ id: 1, account: 'First', stage: 'Discovery', history: [] },
      { id: 2, account: 'Second', stage: 'Discovery', history: [] }] });
    const created = await create(u, s); s = created.snapshot;
    if (active) s = (await activate(u, s, created.workflow)).snapshot;
    return { u, s };
  }
  const transition = (s, to = 'Won') => {
    const next = structuredClone(s); next.deals[0].stage = to; return next;
  };
  const commit = (u, s, actionId = randomUUID(), metadata = {}) => rpc(u, 'pipechat_commit_action', { p_action_id: actionId,
    p_request_id: randomUUID(), p_conversation_id: null, p_plan_id: null, p_expected_updated_at: s.updatedAt, p_workspace: body(s), p_metadata: metadata });
  const undo = (u, id, s) => rpc(u, 'pipechat_undo_action', { p_action_id: id, p_undo_action_id: randomUUID(),
    p_request_id: randomUUID(), p_expected_updated_at: s.updatedAt });

  await t.test('draft persistence, separate activation, history, stale CAS and exact replay', async () => {
    const { u, s } = await fixture(false), svc = service(u), w = s.workflows[0];
    assert.equal(w.status, 'draft'); Workflow.validateState(w);
    assert.deepEqual((await svc.read()).workflows, s.workflows);
    const draftTransition = await save(u, transition(s));
    assert.equal(draftTransition.todoCards.length, 0);
    assert.equal(draftTransition.workflows[0].executions[0].reason, 'inactive');
    const args = { actionId: randomUUID(), requestId: randomUUID(), expectedUpdatedAt: draftTransition.updatedAt,
      workflowId: w.id, revision: draftTransition.workflows[0].revision, active: true };
    const active = await svc.setActivation(args);
    assert.equal(active.workflow.status, 'active');
    const replay = await svc.setActivation(args);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.snapshot, active.snapshot);
    await fails(() => svc.setActivation({ ...args, active: false }), 'PT409');
    await fails(() => svc.setActivation({ ...args, actionId: randomUUID() }), 'PT409');
    await fails(() => svc.setActivation({ ...args, actionId: randomUUID(), expectedUpdatedAt: active.updatedAt }), 'PT409');
    const history = await svc.history(w.id, 2);
    assert.equal(history.history.length, 2); assert.equal(history.history[0].type, 'activated');
    Workflow.validateState(active.workflow);
    assert.equal((await read(u)).todoCards.length, 0, 'activation is not a transition');
  });

  await t.test('canonical choice transition generates linked task in same returned snapshot and matches pure engine', async () => {
    const { u, s } = await fixture();
    const after = await save(u, transition(s)), w = after.workflows[0], event = w.executions[0].event;
    assert.equal(after.todoCards.length, 1);
    const expected = Workflow.handleEvent({ workflow: s.workflows[0], event, records: after.deals, cards: s.todoCards,
      schema: s.tableSchema, customFields: s.customFields, now: w.updatedAt });
    assert.deepEqual(w, expected.workflow); assert.deepEqual(after.todoCards, expected.cards);
    assert.deepEqual(await read(u), after);
    const same = await save(u, after);
    assert.deepEqual(same.workflows, after.workflows); assert.deepEqual(same.todoCards, after.todoCards);
    assert.equal(event.from, 'Discovery'); assert.equal(event.to, 'Won');
    assert.equal(event.recordId, 1); assert.equal(event.field, 'stage');
  });

  await t.test('qualifying open tasks skip; Done, other record and nonmatching tasks do not', async () => {
    for (const status of ['To Do', 'In Progress', 'Done']) {
      const { u, s } = await fixture(), next = transition(s);
      next.todoCards.push({ id: 'todo_existing', recordId: 1, status, nextAction: '  FOLLOW\tUP  customer ', notes: '', dueDate: '' });
      const after = await save(u, next), execution = after.workflows[0].executions[0];
      assert.equal(execution.reason, status === 'Done' ? 'task_created' : 'open_task_exists');
      assert.equal(after.todoCards.length, status === 'Done' ? 2 : 1); Workflow.validateState(after.workflows[0]);
    }
    const { u, s } = await fixture(), next = transition(s);
    next.todoCards = [{ id: 'todo_other', recordId: 2, status: 'To Do', nextAction: 'Follow up', notes: '', dueDate: '' },
      { id: 'todo_unrelated', recordId: 1, status: 'To Do', nextAction: 'Invoice', notes: '', dueDate: '' }];
    assert.equal((await save(u, next)).todoCards.length, 3);
  });

  await t.test('event dates use explicit timezone calendar days across midnight, DST, leap year and maximum offset', async () => {
    const cases = [
      ['2026-03-08T04:30:00.000Z', 'America/New_York', 2, '2026-03-09'],
      ['2026-11-01T03:30:00.000Z', 'America/New_York', 2, '2026-11-02'],
      ['2028-02-28T23:30:00.000Z', 'UTC', 1, '2028-02-29'],
      ['2026-10-10T23:30:00.000Z', 'Asia/Kathmandu', 0, '2026-10-11'],
      ['2026-01-01T00:30:00.000Z', 'America/Los_Angeles', 3650, '2035-12-29']
    ];
    for (const [occurredAt, timezone, offsetDays, expectedDate] of cases) {
      const { u, s } = await fixture(false), value = spec();
      value.timezone = timezone; value.action.due.offsetDays = offsetDays;
      const proposal = Workflow.plan({ action: 'create_workflow', spec: value }, { schema: s.tableSchema });
      const draft = Workflow.apply(proposal, { workflows: [], id: 'workflow_followup', now: '2025-01-01T00:00:00Z', schema: s.tableSchema });
      const activation = Workflow.plan({ action: 'set_workflow_activation', workflowId: draft.workflow.id, active: true },
        { workflows: draft.workflows, schema: s.tableSchema });
      const state = Workflow.apply(activation, { workflows: draft.workflows, now: '2025-01-01T00:00:01Z', schema: s.tableSchema }).workflow;
      await db.query('update pipechat.business_automations set state=$1 where workspace_id=$2', [JSON.stringify(state), u.wid]);
      await db.query("update pipechat.crm_records set cells=jsonb_set(cells,'{stage}','\"Won\"') where workspace_id=$1 and record_id=1", [u.wid]);
      const before = await read(u), event = { eventId: 'date_' + randomUUID(), recordId: 1, field: 'stage', from: 'Discovery', to: 'Won', occurredAt };
      const execution = (await db.query('select pipechat.automation_execute($1,$2,$3::jsonb) result', [u.wid, state.id, JSON.stringify(event)])).rows[0].result;
      const after = await read(u), result = Workflow.handleEvent({ workflow: state, event, records: before.deals, cards: [],
        schema: before.tableSchema, now: after.workflows[0].updatedAt });
      assert.equal(execution.dueDate, expectedDate);
      assert.deepEqual(after.workflows[0], result.workflow); assert.deepEqual(after.todoCards, result.cards);
      const beforeRetry = after;
      assert.deepEqual((await db.query('select pipechat.automation_execute($1,$2,$3::jsonb) result', [u.wid, state.id, JSON.stringify(event)])).rows[0].result, execution);
      assert.deepEqual(await read(u), beforeRetry);
      await fails(() => db.query('select pipechat.automation_execute($1,$2,$3::jsonb)',
        [u.wid, state.id, JSON.stringify({ ...event, from: 'Lost' })]), 'PT409');
    }
  });

  await t.test('failed execution is durable and retryable only with its original canonical event', async () => {
    const { u, s } = await fixture(), next = transition(s);
    next.todoCards = Array.from({ length: 2000 }, (_, i) => ({ id: 'todo_capacity_' + i, recordId: 2,
      status: 'Done', nextAction: 'Existing', notes: '', dueDate: '' }));
    const after = await save(u, next), first = after.workflows[0].executions[0];
    assert.equal(first.status, 'failed'); assert.equal(first.reason, 'board_capacity');
    assert.equal(after.deals[0].stage, 'Won'); assert.equal(after.todoCards.length, 2000);
    Workflow.validateState(after.workflows[0]);
    const available = await save(u, { ...after, todoCards: [] });
    const args = { actionId: randomUUID(), requestId: randomUUID(), expectedUpdatedAt: available.updatedAt,
      workflowId: after.workflows[0].id, eventId: first.event.eventId };
    const retried = await service(u).retry(args);
    assert.equal(retried.execution.attempts, 2); assert.equal(retried.execution.reason, 'task_created');
    assert.equal(retried.snapshot.todoCards.length, 1); Workflow.validateState(retried.workflow);
    const expected = Workflow.handleEvent({ workflow: available.workflows[0], event: first.event,
      records: available.deals, cards: [], schema: available.tableSchema, now: retried.workflow.updatedAt });
    assert.deepEqual(retried.workflow, expected.workflow); assert.deepEqual(retried.snapshot.todoCards, expected.cards);
    assert.equal((await service(u).retry(args)).replayed, true);
    assert.equal((await read(u)).workflows[0].executions[0].attempts, 2);
    const undone = await undo(u, retried.receipt.actionId, retried.snapshot);
    assert.deepEqual(undone.snapshot.workflows, available.workflows); assert.deepEqual(undone.snapshot.todoCards, []);
    await fails(() => service(u).retry({ ...args, actionId: randomUUID(), expectedUpdatedAt: undone.snapshot.updatedAt }), 'PT409');
  });

  await t.test('custom choice fields, batch changes, paused rules, inserts, and nonchoice edits', async () => {
    const { u, s } = await fixture(false);
    let current = structuredClone(s);
    current.customFields.push({ id: 'cf_phase', name: 'Phase', type: 'choice', options: ['Open', 'Ready'] });
    current.deals.forEach(r => { r.cf_phase = 'Open'; });
    current = await save(u, current);
    const value = spec(); value.trigger = { type: 'field_changes_to', field: 'cf_phase', to: 'Ready' };
    const created = await create(u, current, 'workflow_custom', value);
    current = (await activate(u, created.snapshot, created.workflow)).snapshot;
    const next = structuredClone(current); next.deals.forEach(r => { r.cf_phase = 'Ready'; });
    const after = await save(u, next);
    assert.equal(after.todoCards.length, 2);
    assert.deepEqual(after.todoCards.map(c => c.recordId), [1, 2]);
    const w = after.workflows.find(w => w.id === 'workflow_custom'); Workflow.validateState(w);
    const paused = await activate(u, after, w, false);
    const cleared = structuredClone(paused.snapshot); cleared.deals.forEach(r => { r.cf_phase = 'Open'; }); cleared.todoCards = [];
    current = await save(u, cleared); current.deals.forEach(r => { r.cf_phase = 'Ready'; });
    current = await save(u, current);
    assert.equal(current.todoCards.length, 0);
    assert.equal(current.workflows.find(item => item.id === w.id).status, 'paused');
    const beforeExecutions = current.workflows.map(w => w.executions.length);
    current.deals[0].owner = 'Changed'; current.deals.push({ id: 3, account: 'Already Won', stage: 'Won', cf_phase: 'Ready', history: [] });
    const inserted = await save(u, current);
    assert.deepEqual(inserted.workflows.map(w => w.executions.length), beforeExecutions);
    assert.equal(inserted.todoCards.length, 0);
  });

  await t.test('legacy CRM-only writes cannot bypass workflows, and reset removes rules without deleting tombstones', async () => {
    const { u, s } = await fixture(), next = transition(s);
    const after = await rpc(u, 'pipechat_write_crm', { p_deals: next.deals, p_custom_fields: next.customFields,
      p_table_schema: next.tableSchema, p_expected_updated_at: next.updatedAt });
    assert.equal(after.todoCards.length, 1); assert.deepEqual(await read(u), after);
    const reset = await rpc(u, 'pipechat_reset_crm', { p_expected_updated_at: after.updatedAt, p_confirm: true });
    assert.deepEqual(reset.workflows, []); assert.deepEqual(reset.todoCards, []);
    assert.equal((await db.query('select count(*)::int n from pipechat.business_automation_events where workspace_id=$1', [u.wid])).rows[0].n, 1);
    assert.deepEqual((await service(u).read()).workflows, []);
  });

  await t.test('same-event retries and lost acknowledgement never duplicate tasks, including after deletion', async () => {
    const { u, s } = await fixture();
    const args = { p_action_id: randomUUID(), p_request_id: randomUUID(), p_conversation_id: null, p_plan_id: null,
      p_expected_updated_at: s.updatedAt, p_workspace: body(transition(s)) };
    const applied = await rpc(u, 'pipechat_commit_action', args), after = applied.snapshot;
    const replay = await rpc(u, 'pipechat_commit_action', args);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.snapshot, after);
    let current = await save(u, { ...after, todoCards: [] });
    for (let i = 0; i < 2; i++) {
      const result = await service(u).retry({ actionId: randomUUID(), requestId: randomUUID(), expectedUpdatedAt: current.updatedAt,
        workflowId: after.workflows[0].id, eventId: after.workflows[0].executions[0].event.eventId });
      assert.equal(result.execution.status, 'succeeded'); assert.deepEqual(result.snapshot.todoCards, []);
      assert.deepEqual(result.workflow, after.workflows[0]); current = result.snapshot;
    }
    await fails(() => service(u).retry({ actionId: randomUUID(), requestId: randomUUID(), expectedUpdatedAt: current.updatedAt,
      workflowId: after.workflows[0].id, eventId: 'forged' }), 'PT404');
  });

  await t.test('competing CAS writes serialize and skipped events remain terminal', async () => {
    const { u, s } = await fixture(), next = transition(s);
    next.todoCards.push({ id: 'todo_existing', recordId: 1, status: 'To Do', nextAction: 'Follow up', notes: '', dueDate: '' });
    const results = await as(u, () => Promise.allSettled([1, 2].map(() => db.query(
      'select public.pipechat_commit_action($1::text,$2::uuid,null::uuid,null::text,$3::text,$4::jsonb) result',
      [randomUUID(), randomUUID(), s.updatedAt, JSON.stringify(body(next))]))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'PT409');
    const saved = await read(u), w = saved.workflows[0];
    assert.equal(w.executions.length, 1); assert.equal(w.executions[0].reason, 'open_task_exists');
    const removed = await save(u, { ...saved, todoCards: [] });
    const retried = await service(u).retry({ actionId: randomUUID(), requestId: randomUUID(), expectedUpdatedAt: removed.updatedAt,
      workflowId: w.id, eventId: w.executions[0].event.eventId });
    assert.deepEqual(retried.workflow, w); assert.deepEqual(retried.snapshot.todoCards, []);
  });

  await t.test('journal captures workflow and generated card; exact undo restores both without retriggering', async () => {
    const { u, s } = await fixture(), actionId = randomUUID();
    const applied = await commit(u, transition(s), actionId), saved = applied.snapshot;
    const details = await rpc(u, 'pipechat_read_action', { p_action_id: actionId });
    assert(details.entry.changes.some(c => c.path[0] === 'workflows'));
    assert(details.entry.changes.some(c => c.path[0] === 'tasks'));
    assert.deepEqual(details.entry, buildActionEntry({ actionId, requestId: details.entry.requestId, before: s, after: saved }));
    const unrelated = structuredClone(saved); unrelated.deals[1].notes = 'Preserve unrelated edit';
    const current = await save(u, unrelated), inverse = planInverse(details.entry, current);
    assert.equal(inverse.ok, true);
    const undone = await undo(u, actionId, current);
    assert.equal(undone.snapshot.deals[0].stage, 'Discovery');
    assert.equal(undone.snapshot.deals[1].notes, 'Preserve unrelated edit');
    assert.deepEqual(undone.snapshot.workflows, s.workflows); assert.deepEqual(undone.snapshot.todoCards, []);
    const count = (await db.query('select count(*)::int as n from pipechat.business_automation_events where workspace_id=$1', [u.wid])).rows[0].n;
    assert.equal(count, 1, 'undo retains terminal event identity');
    const freshTransition = await save(u, transition(undone.snapshot));
    assert.equal(freshTransition.todoCards.length, 1, 'a genuinely new transition can run');
  });

  await t.test('undo draft/activation and workflow conflict units', async () => {
    const { u, s } = await fixture(false), activated = await activate(u, s, s.workflows[0]);
    const undone = await undo(u, activated.receipt.actionId, activated.snapshot);
    assert.equal(undone.snapshot.workflows[0].status, 'draft');
    const created = await create(u, undone.snapshot, 'workflow_second');
    const removed = await undo(u, created.receipt.actionId, created.snapshot);
    assert.equal(removed.snapshot.workflows.length, 1);
    await fails(() => create(u, removed.snapshot, 'workflow_second'), 'PT409');
    const active = await activate(u, removed.snapshot, removed.snapshot.workflows[0]);
    const after = await save(u, transition(active.snapshot));
    await fails(() => undo(u, active.receipt.actionId, after), 'PT409');
    assert.deepEqual(await read(u), after);
  });

  await t.test('late journal or event failure rolls back CRM, task, workflow, and receipt together', async () => {
    const { u, s } = await fixture();
    await db.exec(`create function pipechat.automation_test_fail() returns trigger language plpgsql as $$ begin raise exception 'late failure'; end $$`);
    for (const table of ['action_journal', 'business_automation_events']) {
      await db.exec(`create trigger automation_test_fail before insert on pipechat.${table} for each row execute function pipechat.automation_test_fail()`);
      try { await fails(() => commit(u, transition(s)), 'P0001'); }
      finally { await db.exec(`drop trigger automation_test_fail on pipechat.${table}`); }
      assert.deepEqual(await read(u), s);
    }
    await db.exec('drop function pipechat.automation_test_fail()');
    const invalid = transition(s); invalid.todoCards = [{ id: 'invalid' }];
    await fails(() => save(u, invalid), 'PT400'); assert.deepEqual(await read(u), s);
    await db.exec(`create function pipechat.automation_test_fail() returns trigger language plpgsql as $$ begin raise exception 'receipt failure'; end $$;
      create trigger automation_test_fail before insert on pipechat.business_automation_receipts for each row execute function pipechat.automation_test_fail()`);
    try { await fails(() => create(u, s, 'workflow_rollback'), 'P0001'); }
    finally { await db.exec('drop trigger automation_test_fail on pipechat.business_automation_receipts; drop function pipechat.automation_test_fail()'); }
    assert.deepEqual(await read(u), s);
  });

  await t.test('SQL independently rejects untyped specs and preserves workflow trigger dependencies', async () => {
    const { u, s } = await fixture(false);
    const badSpecs = [null, [], { ...spec(), timezone: '' }, { ...spec(), timezone: 'Not/AZone' },
      { ...spec(), trigger: { type: 'field_changes_to', field: 'owner', to: 'Won' } },
      { ...spec(), trigger: { type: 'field_changes_to', field: 'stage', to: 'Forged' } },
      { ...spec(), injected: true }, { ...spec(), conditions: [] },
      { ...spec(), action: { ...spec().action, due: { anchor: 'today', offsetDays: 2 } } },
      { ...spec(), action: { ...spec().action, due: { anchor: 'event_date', offsetDays: -1 } } },
      { ...spec(), action: { ...spec().action, nextAction: 'Nonqualifying' } }];
    for (const bad of badSpecs) await fails(() => rpc(u, 'pipechat_create_workflow', { p_action_id: randomUUID(),
      p_request_id: randomUUID(), p_expected_updated_at: s.updatedAt, p_workflow_id: 'workflow_bad', p_spec: bad }), 'PT400');
    assert.deepEqual(await read(u), s);
    const changed = structuredClone(s); changed.tableSchema.fields.find(f => f.id === 'stage').options = ['Discovery', 'Lost'];
    await fails(() => save(u, changed), 'PT409');
    assert.deepEqual(await read(u), s);
  });

  await t.test('referenced option renames fail atomically for drafts, active and paused rules; field labels remain editable', async () => {
    for (const status of ['draft', 'active', 'paused']) {
      const fixtureData = await fixture(status !== 'draft'), u = fixtureData.u;
      let s = fixtureData.s;
      if (status === 'paused') s = (await activate(u, s, s.workflows[0], false)).snapshot;
      const changed = structuredClone(s), field = changed.tableSchema.fields.find(f => f.id === 'stage');
      field.options = field.options.map(option => option === 'Won' ? 'Customer' : option);
      changed.deals[0].stage = 'Customer';
      await fails(() => save(u, changed), 'PT409');
      await fails(() => commit(u, changed), 'PT409');
      assert.deepEqual(await read(u), s, 'CRM, workflow, board and workspace version all roll back');
      const label = structuredClone(s); label.tableSchema.fields.find(f => f.id === 'stage').name = 'Pipeline phase';
      const result = await commit(u, label);
      assert.deepEqual(result.snapshot.workflows, s.workflows);
      assert.equal(result.snapshot.todoCards.length, 0);
      assert.deepEqual((await undo(u, result.receipt.actionId, result.snapshot)).snapshot.workflows, s.workflows);
    }
  });

  const rename = (s, fieldId = 'stage', from = 'Won', to = 'Customer') => {
    const next = structuredClone(s), field = [...next.tableSchema.fields, ...next.customFields].find(f => f.id === fieldId);
    field.options = field.options.map(option => option === from ? to : option);
    next.deals.forEach(row => { if (row[fieldId] === from) row[fieldId] = to; });
    return { next, metadata: { schemaChanges: [{ kind: 'rename_choice_option', fieldId, from, to }] } };
  };

  await t.test('explicit option rename atomically remaps all workflow statuses, journals history, replays and undoes', async () => {
    for (const status of ['draft', 'active', 'paused']) {
      const f = await fixture(false), u = f.u;
      let s = await save(u, transition(f.s));
      if (status !== 'draft') s = (await activate(u, s, s.workflows[0])).snapshot;
      if (status === 'paused') s = (await activate(u, s, s.workflows[0], false)).snapshot;
      const { next, metadata } = rename(s);
      const args = { p_action_id: randomUUID(), p_request_id: randomUUID(), p_conversation_id: null, p_plan_id: null,
        p_expected_updated_at: s.updatedAt, p_workspace: body(next), p_metadata: metadata };
      const result = await rpc(u, 'pipechat_commit_action', args), w = result.snapshot.workflows[0];
      assert.equal(w.spec.trigger.to, 'Customer'); assert.equal(w.status, status);
      assert.equal(w.revision, s.workflows[0].revision + 1); assert.equal(w.activatedAt, s.workflows[0].activatedAt);
      assert.deepEqual(w.spec.conditions, s.workflows[0].spec.conditions); assert.deepEqual(w.spec.action, s.workflows[0].spec.action);
      assert.deepEqual(w.executions, s.workflows[0].executions); assert.deepEqual(result.snapshot.todoCards, s.todoCards);
      assert.equal(w.history.at(-1).type, 'trigger_renamed'); assert.deepEqual(w.history.at(-1).change, metadata.schemaChanges[0]);
      Workflow.validateState(w); assert.deepEqual((await service(u).read()).workflows, result.snapshot.workflows);
      const journal = await rpc(u, 'pipechat_read_action', { p_action_id: args.p_action_id });
      assert.ok(journal.entry.changes.some(change => change.path[0] === 'workflows'));
      const replay = await rpc(u, 'pipechat_commit_action', args);
      assert.equal(replay.replayed, true); assert.deepEqual(replay.snapshot, result.snapshot);
      await fails(() => rpc(u, 'pipechat_commit_action', { ...args, p_metadata: {} }), 'PT409');
      const reverted = await undo(u, args.p_action_id, result.snapshot);
      assert.deepEqual(reverted.snapshot.workflows, s.workflows); assert.deepEqual(reverted.snapshot.deals, s.deals);
      assert.deepEqual(reverted.snapshot.tableSchema, s.tableSchema); assert.deepEqual(reverted.snapshot.todoCards, s.todoCards);
    }
  });

  await t.test('renamed triggers generate tasks only for subsequent real transitions, including custom choices', async () => {
    const { u, s } = await fixture();
    const first = rename(s), renamed = (await commit(u, first.next, randomUUID(), first.metadata)).snapshot;
    assert.equal(renamed.workflows[0].executions.length, 0);
    const fired = await save(u, transition(renamed, 'Customer'));
    assert.equal(fired.todoCards.length, 1); assert.equal(fired.workflows[0].executions[0].event.to, 'Customer');
    const stale = rename(fired, 'stage', 'Customer', 'Client');
    const changed = (await commit(u, stale.next, randomUUID(), stale.metadata)).snapshot;
    assert.equal(changed.todoCards.length, 1); assert.equal(changed.workflows[0].executions.length, 1);
    const custom = structuredClone(changed);
    custom.customFields.push({ id: 'cf_phase', name: 'Phase', type: 'choice', options: ['Open', 'Ready'] });
    custom.deals.forEach(row => { row.cf_phase = 'Ready'; });
    let current = await save(u, custom);
    current = (await create(u, current, 'workflow_custom', { ...spec(), trigger: { type: 'field_changes_to', field: 'cf_phase', to: 'Ready' } })).snapshot;
    const converted = rename(current, 'cf_phase', 'Ready', 'Prepared');
    const saved = (await commit(u, converted.next, randomUUID(), converted.metadata)).snapshot;
    assert.equal(saved.workflows.find(w => w.id === 'workflow_custom').spec.trigger.to, 'Prepared');
    saved.workflows.forEach(Workflow.validateState);
  });

  await t.test('invalid explicit rename metadata and late journal failures roll back every changed domain', async () => {
    const { u, s } = await fixture();
    const valid = rename(s), c = valid.metadata.schemaChanges[0];
    for (const changes of [null, {}, [{ ...c, extra: true }], [{ ...c, kind: 'rename_field' }], [{ ...c, from: '' }],
      [{ ...c, to: c.from }], [c, c], [c, { ...c, from: 'Lost' }], [c, { ...c, from: c.to, to: 'Client' }]]) {
      await fails(() => commit(u, valid.next, randomUUID(), { schemaChanges: changes }), 'PT400');
      assert.deepEqual(await read(u), s);
    }
    for (const changes of [[{ ...c, fieldId: 'absent' }], [{ ...c, from: 'Missing' }], [{ ...c, to: 'Unexpected' }]]) {
      await fails(() => commit(u, valid.next, randomUUID(), { schemaChanges: changes }), 'PT409');
      assert.deepEqual(await read(u), s);
    }
    const afterWon = await save(u, transition(s)), badCells = rename(afterWon);
    badCells.next.deals[0].stage = 'Discovery';
    await fails(() => commit(u, badCells.next, randomUUID(), badCells.metadata), 'PT409');
    assert.deepEqual(await read(u), afterWon);
    const validNow = rename(afterWon);
    await db.exec(`create function pipechat.rename_test_fail() returns trigger language plpgsql as $$ begin raise exception 'late journal failure'; end $$;
      create trigger rename_test_fail before insert on pipechat.action_journal for each row execute function pipechat.rename_test_fail()`);
    try { await fails(() => commit(u, validNow.next, randomUUID(), validNow.metadata), 'P0001'); }
    finally { await db.exec('drop trigger rename_test_fail on pipechat.action_journal; drop function pipechat.rename_test_fail()'); }
    assert.deepEqual(await read(u), afterWon);
    await fails(() => rpc(u, 'pipechat_commit_todo_action', { p_action_id: randomUUID(), p_request_id: randomUUID(),
      p_conversation_id: null, p_plan_id: null, p_expected_updated_at: afterWon.updatedAt, p_todo_cards: afterWon.todoCards,
      p_metadata: valid.metadata }), 'PT400');
    await fails(() => as(u, () => db.query('select pipechat.automation_write_workspace($1,$2,$3)',
      [JSON.stringify(body(validNow.next)), afterWon.updatedAt, JSON.stringify(valid.metadata.schemaChanges)])), '42501');
  });

  await t.test('retry after a rename preserves the original event and due date while following the remapped trigger', async () => {
    const { u, s } = await fixture(), next = transition(s);
    next.todoCards = Array.from({ length: 2000 }, (_, i) => ({ id: 'todo_capacity_' + i, recordId: 2,
      status: 'Done', nextAction: 'Existing', notes: '', dueDate: '' }));
    const failed = await save(u, next), event = failed.workflows[0].executions[0].event;
    const mapped = rename(failed); mapped.next.todoCards = [];
    const renamed = (await commit(u, mapped.next, randomUUID(), mapped.metadata)).snapshot;
    const retry = await service(u).retry({ actionId: randomUUID(), requestId: randomUUID(), expectedUpdatedAt: renamed.updatedAt,
      workflowId: renamed.workflows[0].id, eventId: event.eventId });
    assert.equal(retry.execution.status, 'succeeded'); assert.deepEqual(retry.execution.event, event);
    assert.equal(retry.execution.dueDate, Workflow.eventDueDate(event.occurredAt, spec().timezone, 2));
    const expected = Workflow.handleEvent({ workflow: renamed.workflows[0], event, records: renamed.deals, cards: [],
      schema: renamed.tableSchema, now: retry.workflow.updatedAt });
    assert.deepEqual(retry.workflow, expected.workflow); assert.deepEqual(retry.snapshot.todoCards, expected.cards);
    Workflow.validateState(retry.workflow);
  });

  await t.test('real authenticated adapter round-trips a journaled rename and workflow inverse on PostgreSQL', async () => {
    const { u, s } = await fixture();
    const backend = require('../lib/supabase-backend').createSupabaseBackend({
      url: 'https://offline.supabase.co', publishableKey: 'sb_publishable_offline_1234567890',
      createClient: () => ({ rpc() { throw new Error('No shared client writes'); } }),
      createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: u.id, email: 'owner@example.test' } }, error: null }) },
        rpc: async (name, args) => { try { return { data: await rpc(u, name, args), error: null }; }
          catch (error) { return { data: null, error: { code: error.code } }; } } }) });
    const adapter = backend.forRequest({ headers: {} }, { getHeader() {}, setHeader() {} });
    const mapped = rename(s), metadata = { ...mapped.metadata, actionId: randomUUID(), requestId: randomUUID() };
    const saved = await adapter.writeCrm(null, mapped.next.deals, s.updatedAt, mapped.next.customFields,
      mapped.next.tableSchema, mapped.next.todoCards, metadata);
    assert.equal(saved.workflows[0].spec.trigger.to, 'Customer');
    const undone = await adapter.undoAction(saved.actionReceipt.actionId, saved.updatedAt, { actionId: randomUUID(), requestId: randomUUID() });
    assert.deepEqual(undone.workflows, s.workflows); assert.deepEqual(undone.tableSchema, s.tableSchema);
  });

  await t.test('owner isolation, revoked sessions, ACLs, fixed search paths and default-deny RLS', async () => {
    const { u, s } = await fixture(), other = await user();
    assert.deepEqual((await service(other).read()).workflows, []);
    const calls = [['pipechat_read_workflows', {}], ['pipechat_create_workflow', { p_action_id: randomUUID(),
      p_request_id: randomUUID(), p_expected_updated_at: s.updatedAt, p_workflow_id: 'workflow_new', p_spec: spec() }],
    ['pipechat_set_workflow_activation', { p_action_id: randomUUID(), p_request_id: randomUUID(), p_expected_updated_at: s.updatedAt,
      p_workflow_id: s.workflows[0].id, p_revision: 2, p_active: false }],
    ['pipechat_retry_workflow_event', { p_action_id: randomUUID(), p_request_id: randomUUID(), p_expected_updated_at: s.updatedAt,
      p_workflow_id: s.workflows[0].id, p_event_id: 'forged' }]];
    for (const [name, args] of calls) {
      for (const role of ['anon', 'service_role']) await fails(() => rpc(u, name, args, role), '42501');
      for (const invalid of [null, { id: u.id }, { id: u.id, session: other.session }, { id: 'bad', session: u.session }]) {
        await fails(() => rpc(invalid, name, args), 'PT401');
      }
    }
    await db.query("update pipechat.memberships set workspace_id=$1,role='member' where user_id=$2", [u.wid, other.id]);
    for (const [name, args] of calls) await fails(() => rpc(other, name, args), 'PT403');
    await fails(() => read(other), 'PT403');
    const functions = (await db.query(`select n.nspname,p.proname,p.proconfig,p.prosecdef,
      has_function_privilege('authenticated',p.oid,'execute') as authenticated,
      has_function_privilege('anon',p.oid,'execute') as anon,has_function_privilege('service_role',p.oid,'execute') as service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like 'automation_%'
      or p.proname in ('write_workspace_without_automations','write_crm_without_automations','pipechat_create_workflow','pipechat_set_workflow_activation',
        'pipechat_read_workflows','pipechat_retry_workflow_event')`)).rows;
    for (const f of functions) {
      assert(f.proconfig.includes('search_path=pg_catalog')); assert.equal(f.anon, false); assert.equal(f.service, false);
      assert.equal(f.authenticated, f.nspname === 'public'); if (f.nspname === 'public') assert(f.prosecdef);
    }
    const tables = ['business_automations', 'business_automation_events', 'business_automation_receipts'];
    for (const table of tables) for (const role of ['authenticated', 'anon', 'service_role'])
      await fails(() => as(u, () => db.query(`select * from pipechat.${table}`), role), '42501');
    await db.exec('grant usage on schema pipechat to authenticated');
    for (const table of tables) {
      await db.exec(`grant select,insert,update,delete on pipechat.${table} to authenticated`);
      try {
        assert.deepEqual((await as(u, () => db.query(`select * from pipechat.${table}`))).rows, []);
        assert.equal((await as(u, () => db.query(`delete from pipechat.${table}`))).affectedRows, 0);
      } finally { await db.exec(`revoke all on pipechat.${table} from authenticated`); }
    }
    await db.exec('revoke all on schema pipechat from authenticated');
    await db.query('delete from auth.sessions where id=$1', [u.session]);
    for (const [name, args] of calls) await fails(() => rpc(u, name, args), 'PT401');
  });

  await t.test('database reconstruction preserves workflow lifecycle, event history and exact action receipts', async () => {
    const { u, s } = await fixture();
    const args = { p_action_id: randomUUID(), p_request_id: randomUUID(), p_conversation_id: null, p_plan_id: null,
      p_expected_updated_at: s.updatedAt, p_workspace: body(transition(s)) };
    const original = await rpc(u, 'pipechat_commit_action', args), expected = await read(u);
    const archive = await db.dumpDataDir();
    await db.close();
    db = new PGlite({ loadDataDir: archive });
    assert.deepEqual(await read(u), expected);
    assert.deepEqual((await service(u).read()).workflows, expected.workflows);
    const replay = await rpc(u, 'pipechat_commit_action', args);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.snapshot, original.snapshot);
    assert.deepEqual(replay.receipt, original.receipt);
    assert.equal((await db.query('select count(*)::int n from pipechat.business_automation_events where workspace_id=$1', [u.wid])).rows[0].n, 1);
  });
});
