'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { legacySchema } = require('../public/table-schema');
const { sanitizeEvent } = require('../lib/beta-telemetry');

const body = s => ({ deals: s.deals, customFields: s.customFields, tableSchema: s.tableSchema, todoCards: s.todoCards });
const rejectsCode = (task, code) => assert.rejects(task, error => { assert.equal(error.code, code, error.message); return true; });

test('journal commit telemetry is sanitized, idempotent and transactional on PostgreSQL 001-016', { timeout: 120000 }, async t => {
  const db = new PGlite(); t.after(() => db.close());
  const run = async file => db.exec(await fs.readFile(path.join(__dirname, '../db', file), 'utf8'));
  await run('tests/mock-supabase.sql');
  for (const file of (await fs.readdir(path.join(__dirname, '../db/migrations')))
    .filter(file => /^(00[1-9]|01[0-6])-.*\.sql$/.test(file)).sort()) await run('migrations/' + file);
  await run('tests/security.sql');
  async function user() {
    const u = { id: randomUUID(), session: randomUUID() };
    await db.query('insert into auth.users(id) values($1)', [u.id]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [u.session, u.id]);
    return u;
  }
  async function rpc(u, name, args = []) {
    assert(/^pipechat_[a-z0-9_]+$/.test(name));
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: u.id, session_id: u.session, role: 'authenticated' })]);
    await db.exec('set role authenticated');
    try { return (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`,
      args.map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].result; }
    finally { await db.exec('reset role'); }
  }
  const read = u => rpc(u, 'pipechat_read_workspace');
  const events = (u, request = null) => rpc(u, 'pipechat_list_beta_events', [100, request]);
  const commit = (u, args) => rpc(u, 'pipechat_commit_action', args);
  const argsFor = s => [randomUUID(), randomUUID(), null, 'c'.repeat(64), s.updatedAt, body(s), {}];
  const expectedEvent = (receipt, stage = 'action') => sanitizeEvent({ requestId: receipt.requestId,
    conversationId: receipt.conversationId, planId: receipt.planId, actionId: receipt.actionId,
    stage, attempt: 0, outcome: 'succeeded', latencyMs: 0, model: 'unknown' });
  async function fixture() {
    const u = await user(), empty = await read(u);
    const ready = await rpc(u, 'pipechat_write_workspace_v2', [[], [], legacySchema(), empty.updatedAt, []]);
    const snapshot = await rpc(u, 'pipechat_write_workspace_v2', [[
      { id: 1, account: 'Account', stage: 'Discovery', owner: 'private@example.invalid', notes: 'Bearer secret-provider-value', history: [] }
    ], [], ready.tableSchema, ready.updatedAt, []]);
    return { u, snapshot };
  }

  await t.test('CRM/import commits emit exactly one correlated event and never copy private business values', async () => {
    const { u, snapshot } = await fixture(), next = structuredClone(snapshot);
    next.deals[0].notes = 'secret changed business text';
    const args = argsFor(next); args[2] = (await rpc(u, 'pipechat_read_conversation')).epoch;
    args[6] = { importReceipt: { id: 'private-import-name', digest: 'd'.repeat(64) } };
    const result = await commit(u, args), rows = await events(u, args[1]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].event, expectedEvent(result.receipt));
    const serialized = JSON.stringify(rows);
    for (const secret of ['private@example.invalid', 'Bearer', 'secret changed', 'private-import-name', 'd'.repeat(64)]) {
      assert(!serialized.includes(secret), secret + ' leaked into telemetry');
    }
    for (let i = 0; i < 3; i++) {
      const replay = await commit(u, structuredClone(args));
      assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, result.receipt);
      assert.deepEqual(await events(u, args[1]), rows);
    }
    const changed = structuredClone(args); changed[5].deals[0].notes = 'Changed replay';
    await rejectsCode(() => commit(u, changed), 'PT409');
    assert.deepEqual(await events(u, args[1]), rows);
    assert.deepEqual(await events(await user(), args[1]), []);
  });

  await t.test('ordinary To Do commit and exact undo each emit their own success slot with replay stability', async () => {
    const { u, snapshot } = await fixture();
    const todoArgs = argsFor(snapshot);
    todoArgs[5] = [{ id: 'todo_telemetry', recordId: 1, status: 'To Do', nextAction: 'Secret task text', notes: '', dueDate: '' }];
    const result = await rpc(u, 'pipechat_commit_todo_action', todoArgs);
    assert.deepEqual((await events(u, todoArgs[1]))[0].event, expectedEvent(result.receipt));
    const undoArgs = [todoArgs[0], randomUUID(), randomUUID(), result.snapshot.updatedAt];
    const undone = await rpc(u, 'pipechat_undo_action', undoArgs), rows = await events(u);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find(row => row.event.stage === 'undo').event, expectedEvent(undone.receipt, 'undo'));
    assert.deepEqual(undone.snapshot.todoCards, []);
    assert.equal((await rpc(u, 'pipechat_undo_action', undoArgs)).replayed, true);
    assert.deepEqual(await events(u), rows);
  });

  await t.test('workflow journal inserts also emit a commit event without workflow specs or history', async () => {
    const { u, snapshot } = await fixture();
    const spec = { version: 1, name: 'Private workflow name', timezone: 'America/New_York',
      trigger: { type: 'field_changes_to', field: 'stage', to: 'Won' },
      conditions: [{ type: 'no_open_qualifying_task', match: { field: 'nextAction', operator: 'contains', value: 'Follow up' } }],
      action: { type: 'create_linked_task', nextAction: 'Follow up', notes: 'Secret workflow notes', due: { anchor: 'event_date', offsetDays: 2 } } };
    const args = [randomUUID(), randomUUID(), snapshot.updatedAt, 'workflow_telemetry', spec];
    const result = await rpc(u, 'pipechat_create_workflow', args), rows = await events(u);
    assert.equal(rows.length, 1); assert.deepEqual(rows[0].event, expectedEvent(result.receipt));
    assert(!JSON.stringify(rows).includes('Private workflow'));
    assert(!JSON.stringify(rows).includes('Secret workflow'));
    await rpc(u, 'pipechat_create_workflow', args);
    assert.deepEqual(await events(u), rows);
  });

  await t.test('a late import-receipt failure rolls back canonical save, journal and its already-inserted event', async () => {
    const { u, snapshot } = await fixture(), next = structuredClone(snapshot);
    next.deals[0].notes = 'Do not commit';
    const args = argsFor(next); args[6] = { importReceipt: { id: 'rollback-import', digest: 'e'.repeat(64) } };
    await db.exec(`create function pipechat.fail_import_event_test() returns trigger language plpgsql as $$
      begin raise exception 'injected late import failure'; end $$;
      create trigger fail_import_event_test before insert on pipechat.import_receipts
        for each row execute function pipechat.fail_import_event_test()`);
    try { await rejectsCode(() => commit(u, args), 'P0001'); }
    finally { await db.exec('drop trigger fail_import_event_test on pipechat.import_receipts; drop function pipechat.fail_import_event_test()'); }
    assert.deepEqual(await read(u), snapshot);
    assert.equal(await rpc(u, 'pipechat_read_action', [args[0]]), null);
    assert.deepEqual(await events(u), []);
    assert.equal((await db.query('select count(*)::int n from pipechat.import_receipts where user_id=$1', [u.id])).rows[0].n, 0);
    await commit(u, args); assert.equal((await events(u)).length, 1);
  });

  await t.test('ledger failure aborts a canonical save and late undo-marker failure removes the undo event', async () => {
    const { u, snapshot } = await fixture(), next = structuredClone(snapshot);
    next.deals[0].owner = 'Changed'; const args = argsFor(next);
    await db.exec(`create function pipechat.fail_ledger_event_test() returns trigger language plpgsql as $$
      begin raise exception 'injected ledger failure'; end $$;
      create trigger fail_ledger_event_test before insert on pipechat.beta_event_ledger
        for each row execute function pipechat.fail_ledger_event_test()`);
    try { await rejectsCode(() => commit(u, args), 'P0001'); }
    finally { await db.exec('drop trigger fail_ledger_event_test on pipechat.beta_event_ledger; drop function pipechat.fail_ledger_event_test()'); }
    assert.deepEqual(await read(u), snapshot); assert.deepEqual(await events(u), []);
    assert.equal(await rpc(u, 'pipechat_read_action', [args[0]]), null);
    const saved = await commit(u, args), rows = await events(u);
    const undoArgs = [args[0], randomUUID(), randomUUID(), saved.snapshot.updatedAt];
    await db.exec(`create function pipechat.fail_undo_event_test() returns trigger language plpgsql as $$
      begin raise exception 'injected late undo marker failure'; end $$;
      create trigger fail_undo_event_test before update of undone_by on pipechat.action_journal
        for each row execute function pipechat.fail_undo_event_test()`);
    try { await rejectsCode(() => rpc(u, 'pipechat_undo_action', undoArgs), 'P0001'); }
    finally { await db.exec('drop trigger fail_undo_event_test on pipechat.action_journal; drop function pipechat.fail_undo_event_test()'); }
    assert.deepEqual(await read(u), saved.snapshot); assert.deepEqual(await events(u), rows);
    assert.equal((await rpc(u, 'pipechat_read_action', [args[0]])).undoneBy, null);
    assert.equal(await rpc(u, 'pipechat_read_action', [undoArgs[1]]), null);
    await rpc(u, 'pipechat_undo_action', undoArgs);
    assert.equal((await events(u, undoArgs[2])).length, 1);
  });

  await t.test('a changed preexisting event identity fails closed instead of acknowledging a mismatched action', async () => {
    const { u, snapshot } = await fixture(), next = structuredClone(snapshot);
    next.deals[0].owner = 'New owner'; const args = argsFor(next);
    const wrong = sanitizeEvent({ requestId: args[1], actionId: randomUUID(), stage: 'action', attempt: 0,
      outcome: 'succeeded', latencyMs: 0 });
    await rpc(u, 'pipechat_record_beta_event', [wrong]);
    await rejectsCode(() => commit(u, args), 'PT409');
    assert.deepEqual(await read(u), snapshot);
    assert.equal(await rpc(u, 'pipechat_read_action', [args[0]]), null);
    const rows = await events(u); assert.equal(rows.length, 1); assert.deepEqual(rows[0].event, wrong);
  });
  await run('tests/security.sql');
});
