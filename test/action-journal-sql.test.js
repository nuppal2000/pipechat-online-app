'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { legacySchema } = require('../public/table-schema');
const { buildActionEntry, planInverse } = require('../lib/action-journal');
const { createBetaTelemetry, createSqlTelemetrySink, sanitizeEvent } = require('../lib/beta-telemetry');
const { createSupabaseBackend } = require('../lib/supabase-backend');

const copy = value => structuredClone(value);
const workspaceBody = s => ({ deals: s.deals, todoCards: s.todoCards, tableSchema: s.tableSchema, customFields: s.customFields });
const code = (fn, expected) => assert.rejects(fn, e => { assert.equal(e.code, expected, e.message); return true; });
const signatures = {
  read_workspace: [], read_conversation: [], write_workspace_v2: ['jsonb', 'jsonb', 'jsonb', 'text', 'jsonb'],
  commit_action: ['text', 'uuid', 'uuid', 'text', 'text', 'jsonb', 'jsonb'], read_action: ['text'],
  commit_todo_action: ['text', 'uuid', 'uuid', 'text', 'text', 'jsonb', 'jsonb'], list_actions: ['jsonb', 'integer'],
  undo_action: ['text', 'text', 'uuid', 'text'], record_beta_event: ['jsonb'], list_beta_events: ['integer', 'uuid'], reset_crm: ['text', 'boolean'],
  create_workflow: ['text', 'uuid', 'text', 'text', 'jsonb'], set_workflow_activation: ['text', 'uuid', 'text', 'text', 'bigint', 'boolean']
};

test('action journal and telemetry on real local PostgreSQL migrations', { timeout: 180000 }, async t => {
  const db = new PGlite(); t.after(() => db.close());
  const run = async name => db.exec(await fs.readFile(path.join(__dirname, '../db', name), 'utf8'));
  await run('tests/mock-supabase.sql');
  const migrations = (await fs.readdir(path.join(__dirname, '../db/migrations'))).filter(f => /^(00[1-9]|01[0-3])-.*\.sql$/.test(f)).sort();
  assert.equal(migrations.length, 13);
  for (const name of migrations) await run('migrations/' + name);
  const originalFunctions = (await db.query(`select p.oid,pg_get_functiondef(p.oid) as definition,p.proacl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','pipechat') order by p.oid`)).rows;
  await run('migrations/014-action-journal.sql');

  async function user() {
    const u = { id: randomUUID(), session: randomUUID() };
    await db.query('insert into auth.users(id) values ($1)', [u.id]);
    await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [u.session, u.id]);
    return u;
  }
  async function as(u, fn, role = 'authenticated') {
    assert(['authenticated', 'anon', 'service_role'].includes(role));
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(u ? { sub: u.id, session_id: u.session, role } : {})]);
    await db.exec('set role ' + role);
    try { return await fn(); } finally { await db.exec('reset role'); }
  }
  function rpc(u, name, args = [], role) {
    const types = signatures[name]?.slice(0, args.length); assert(types);
    return as(u, async () => (await db.query(`select public.pipechat_${name}(${types.map((v, i) => `$${i + 1}::${v}`).join(',')}) as result`,
      args.map((v, i) => types[i] === 'jsonb' ? JSON.stringify(v) : v))).rows[0].result, role);
  }
  const read = u => rpc(u, 'read_workspace');
  const save = (u, s) => rpc(u, 'write_workspace_v2', [s.deals, s.customFields, s.tableSchema, s.updatedAt, s.todoCards]);
  const readAction = (u, id) => rpc(u, 'read_action', [id]);
  const count = async table => { assert(['action_journal', 'beta_event_ledger'].includes(table)); return (await db.query(`select count(*)::int as n from pipechat.${table}`)).rows[0].n; };
  async function fixture() {
    const u = await user(), blank = await read(u);
    const ready = await save(u, { ...blank, tableSchema: legacySchema(), deals: [], todoCards: [] });
    const snapshot = await save(u, { ...ready, deals: [
      { id: 1, account: 'First', owner: 'Before', notes: '', history: ['Initial'] },
      { id: 2, account: 'Second', owner: 'Other', notes: '', history: [] }
    ], todoCards: [{ id: 'todo_one', recordId: 1, status: 'To Do', nextAction: 'Call', notes: '', dueDate: '' }] });
    const conversationId = (await rpc(u, 'read_conversation')).epoch;
    return { u, snapshot, conversationId };
  }
  function commitArgs(s, conversationId = null) { return [randomUUID(), randomUUID(), conversationId, randomUUID(), s.updatedAt, workspaceBody(s)]; }
  function adapterFor(u, transform = value => value) {
    const calls = [];
    const backend = createSupabaseBackend({ url: 'https://journal-test.supabase.co', publishableKey: 'sb_publishable_offline_test_key_123456789',
      createClient: () => ({ rpc: async () => ({ data: {} }) }),
      createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: u.id, email: 'journal@example.test' } }, error: null }) },
        rpc: async (name, args = {}) => {
          calls.push({ name, args });
          assert(Object.hasOwn(signatures, name.replace(/^pipechat_/, '')));
          const keys = Object.keys(args); assert(keys.every(k => /^p_[a-z_]+$/.test(k)));
          try {
            const data = await as(u, async () => (await db.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as result`,
              Object.values(args).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v))).rows[0].result);
            return { data: transform(data, name), error: null };
          } catch (error) { return { data: null, error: { code: error.code, message: 'Provider detail must not leak' } }; }
        } })
    });
    const headers = new Map();
    return { calls, adapter: backend.forRequest({ headers: {} }, { headersSent: false,
      getHeader: key => headers.get(key), setHeader: (key, value) => headers.set(key, value) }) };
  }

  await t.test('migration leaves existing functions and grants unchanged', async () => {
    for (const f of originalFunctions) {
      const row = (await db.query('select p.oid,pg_get_functiondef(p.oid) as definition,p.proacl from pg_proc p where oid=$1', [f.oid])).rows[0];
      assert.deepEqual(row, f);
    }
  });

  await t.test('initial setup accepts the canonical null version and does not bypass explicit reset', async () => {
    const u = await user(), before = await read(u);
    const next = { ...before, tableSchema: legacySchema() }, args = commitArgs(next);
    const receipt = await rpc(u, 'commit_action', args), after = await read(u);
    assert.equal(receipt.receipt.beforeVersion, null);
    assert.deepEqual((await readAction(u, args[0])).entry, buildActionEntry({ actionId: args[0], requestId: args[1],
      planId: args[3], before, after }));
    await code(() => rpc(u, 'undo_action', [args[0], randomUUID(), randomUUID(), after.updatedAt]), 'PT409');
    assert.deepEqual(await read(u), after);
  });

  await t.test('canonical journal matches JS and exact inverse preserves intervening record/task edits', async () => {
    const { u, snapshot, conversationId } = await fixture(), next = copy(snapshot);
    next.deals[0].owner = 'After'; next.todoCards[0].status = 'Done';
    const args = commitArgs(next, conversationId), receipt = await rpc(u, 'commit_action', args), saved = await read(u);
    const expected = buildActionEntry({ actionId: args[0], requestId: args[1], conversationId, planId: args[3], before: snapshot, after: saved });
    assert.deepEqual((await readAction(u, args[0])).entry, expected);
    assert.deepEqual((await readAction(u, args[0])).receipt, receipt.receipt);
    const intervening = copy(saved);
    intervening.deals[0].notes = 'Keep same-row independent edit'; intervening.deals[1].owner = 'Keep other-row edit';
    intervening.todoCards[0].notes = 'Keep independent task edit';
    const latest = await save(u, intervening), preview = planInverse(expected, latest);
    assert.equal(preview.ok, true);
    const undoArgs = [args[0], randomUUID(), randomUUID(), latest.updatedAt];
    const undone = await rpc(u, 'undo_action', undoArgs), actual = await read(u);
    assert.deepEqual(workspaceBody(actual), workspaceBody(preview.snapshot));
    assert.equal(actual.deals[0].owner, 'Before'); assert.equal(actual.todoCards[0].status, 'To Do');
    assert.equal((await readAction(u, args[0])).undoneBy, undoArgs[1]);
    assert.equal(undone.receipt.undoOf, args[0]);
    assert.deepEqual(await rpc(u, 'undo_action', undoArgs), { ...undone, replayed: true });
    assert.deepEqual(await read(u), actual);
    await code(() => rpc(u, 'undo_action', [args[0], randomUUID(), randomUUID(), actual.updatedAt]), 'PT409');
  });

  await t.test('field conflicts and stale current CAS reject without partial inverse or marker', async () => {
    const { u, snapshot } = await fixture(), next = copy(snapshot);
    next.deals[0].owner = 'After'; next.todoCards[0].status = 'Done';
    const args = commitArgs(next), receipt = await rpc(u, 'commit_action', args), saved = await read(u);
    const later = copy(saved); later.deals[0].owner = 'Intervening';
    const current = await save(u, later), n = await count('action_journal');
    assert.equal(planInverse((await readAction(u, args[0])).entry, current).ok, false);
    for (const version of [saved.updatedAt, current.updatedAt]) {
      await code(() => rpc(u, 'undo_action', [args[0], randomUUID(), randomUUID(), version]), 'PT409');
      assert.deepEqual(await read(u), current); assert.equal(await count('action_journal'), n);
      assert.equal((await readAction(u, args[0])).undoneBy, null);
    }
  });

  await t.test('lost commit acknowledgement replays original receipt without resaving or accepting changed body', async () => {
    const { u, snapshot } = await fixture(), next = copy(snapshot); next.deals[0].owner = 'After';
    const args = commitArgs(next), receipt = await rpc(u, 'commit_action', args), saved = await read(u);
    const n = await count('action_journal');
    assert.deepEqual(await rpc(u, 'commit_action', args), { ...receipt, replayed: true });
    assert.deepEqual(await read(u), saved); assert.equal(await count('action_journal'), n);
    const changed = copy(args); changed[5].deals[0].owner = 'Different';
    await code(() => rpc(u, 'commit_action', changed), 'PT409');
    changed[5] = args[5]; changed[1] = randomUUID();
    await code(() => rpc(u, 'commit_action', changed), 'PT409');
  });

  await t.test('import digest and exact proposal hash persist atomically, reject changed replay, retain ORIGINAL result', async () => {
    const { u, snapshot } = await fixture(), next = copy(snapshot); next.deals[0].owner = 'Imported';
    const args = commitArgs(next); args[0] = 'a'.repeat(64); args[3] = 'b'.repeat(64);
    args.push({ importReceipt: { id: randomUUID(), digest: 'c'.repeat(64) } });
    const original = await rpc(u, 'commit_action', args);
    assert.equal(original.receipt.actionId, args[0]); assert.equal(original.receipt.planId, args[3]);
    assert.deepEqual(original.receipt.importReceipt, args[6].importReceipt);
    const later = copy(original.snapshot); later.deals[1].owner = 'Later unrelated edit';
    const current = await save(u, later), n = await count('action_journal');
    assert.deepEqual(await rpc(u, 'commit_action', args), { ...original, replayed: true });
    assert.deepEqual(await read(u), current); assert.equal(await count('action_journal'), n);
    for (const change of [a => a[6].importReceipt.digest = 'd'.repeat(64), a => a[5].deals[0].owner = 'Changed',
      a => a[3] = 'e'.repeat(64), a => a[0] = randomUUID(), a => a[4] = current.updatedAt]) {
      const changed = copy(args); change(changed);
      await code(() => rpc(u, 'commit_action', changed), 'PT409');
    }
    assert.deepEqual(await read(u), current);
    assert.equal((await db.query('select count(*)::int as n from pipechat.import_receipts where receipt_id=$1', [args[6].importReceipt.id])).rows[0].n, 1);
    await db.exec(`create function pipechat.qa_import_failure() returns trigger language plpgsql as $$ begin raise exception 'late receipt failure'; end $$;
      create trigger qa_import_failure before insert on pipechat.import_receipts for each row execute function pipechat.qa_import_failure();`);
    const failed = commitArgs({ ...current, deals: current.deals.map(r => ({ ...r, owner: 'Must roll back' })) });
    failed.push({ importReceipt: { id: randomUUID(), digest: 'f'.repeat(64) } });
    try { await code(() => rpc(u, 'commit_action', failed), 'P0001'); }
    finally { await db.exec('drop trigger qa_import_failure on pipechat.import_receipts; drop function pipechat.qa_import_failure();'); }
    assert.deepEqual(await read(u), current); assert.equal(await count('action_journal'), n);
  });

  await t.test('adapter ordinary CRM and task writes journal; import metadata, replay, listing and field-scoped undo work end-to-end', async () => {
    const { u, snapshot } = await fixture(), { adapter, calls } = adapterFor(u), rows = copy(snapshot.deals);
    rows[0].owner = 'Saved through adapter';
    const metadata = { planId: '1'.repeat(64), importReceipt: { id: randomUUID(), digest: '2'.repeat(64) } };
    const saved = await adapter.writeCrm(null, rows, snapshot.updatedAt, snapshot.customFields, snapshot.tableSchema, snapshot.todoCards, metadata);
    assert.equal(saved.replayed, false); assert.deepEqual(saved.importReceipt, metadata.importReceipt);
    assert.equal(saved.actionReceipt.planId, metadata.planId);
    assert.equal(calls.at(-1).name, 'pipechat_commit_action');
    assert.deepEqual(calls.at(-1).args.p_metadata, { importReceipt: metadata.importReceipt });
    const cardEdit = copy(saved.todoCards); cardEdit[0].notes = 'Later task edit';
    const tasks = await adapter.writeTodo(cardEdit, saved.updatedAt);
    assert.equal(calls.at(-1).name, 'pipechat_commit_todo_action');
    assert(!Object.hasOwn(calls.at(-1).args, 'p_deals')); assert(!Object.hasOwn(calls.at(-1).args, 'p_workspace'));
    assert.equal(tasks.replayed, false); assert.deepEqual(tasks.deals, saved.deals);
    const retry = await adapter.writeCrm(null, rows, snapshot.updatedAt, snapshot.customFields, snapshot.tableSchema, snapshot.todoCards, metadata);
    assert.equal(retry.replayed, true); assert.equal(retry.updatedAt, saved.updatedAt);
    assert.deepEqual(retry.actionReceipt, saved.actionReceipt); assert.notDeepEqual(retry.todoCards, tasks.todoCards);
    assert.deepEqual((await read(u)).todoCards, cardEdit);
    const first = await adapter.listActions({ limit: 1 });
    assert.equal(first.actions[0].receipt.actionId, tasks.actionReceipt.actionId); assert(first.before);
    const second = await adapter.listActions({ limit: 1, before: first.before });
    assert.equal(second.actions[0].receipt.actionId, saved.actionReceipt.actionId); assert.equal(second.before, null);
    const action = await adapter.readAction(saved.actionReceipt.actionId); assert.equal(action.entry.planId, metadata.planId);
    const undone = await adapter.undoAction(saved.actionReceipt.actionId, tasks.updatedAt);
    assert.equal(undone.deals[0].owner, snapshot.deals[0].owner); assert.deepEqual(undone.todoCards, cardEdit);
    assert.equal(undone.actionReceipt.undoOf, saved.actionReceipt.actionId);
    assert.equal((await adapter.undoAction(saved.actionReceipt.actionId, tasks.updatedAt)).replayed, true);
    assert.equal((await adapter.readAction(saved.actionReceipt.actionId)).undoneBy, undone.actionReceipt.actionId);
    const other = adapterFor(await user()).adapter;
    assert.deepEqual(await other.listActions(), { actions: [], before: null });
    assert.equal(await other.readAction(saved.actionReceipt.actionId), null);
    await assert.rejects(other.undoAction(saved.actionReceipt.actionId, tasks.updatedAt), { status: 409 });
    const ordinaryRows = copy(undone.deals); ordinaryRows[1].notes = 'Ordinary journaled edit';
    const ordinary = await adapter.writeCrm(null, ordinaryRows, undone.updatedAt, undone.customFields, undone.tableSchema, undone.todoCards);
    assert.equal(ordinary.actionReceipt.importReceipt, null);
    assert.equal((await adapter.writeCrm(null, ordinaryRows, undone.updatedAt, undone.customFields, undone.tableSchema, undone.todoCards)).replayed, true);
    await assert.rejects(adapter.listActions({ limit: 0 }), { status: 400 });
    await assert.rejects(adapter.undoAction('bad', ordinary.updatedAt), { status: 400 });
    await assert.rejects(adapter.writeTodo(cardEdit, ordinary.updatedAt, { importReceipt: metadata.importReceipt }), { status: 400 });
    await assert.rejects(adapter.writeCrm(null, ordinaryRows, ordinary.updatedAt, ordinary.customFields, ordinary.tableSchema, ordinary.todoCards,
      { importReceipt: { id: 'x', digest: 'not-a-digest' } }), { status: 400 });
  });

  await t.test('adapter rejects missing/mismatched journal receipts without falling back to unjournaled saves', async () => {
    for (const patch of [r => ({ ...r, receipt: null }), r => ({ ...r, replayed: undefined }),
      r => ({ ...r, receipt: { ...r.receipt, actionId: randomUUID() } }),
      r => ({ ...r, snapshot: { ...r.snapshot, todoCards: [] } })]) {
      const { u, snapshot } = await fixture();
      const { adapter, calls } = adapterFor(u, (raw, name) => name === 'pipechat_commit_action' ? patch(raw) : raw);
      await assert.rejects(adapter.writeCrm(null, snapshot.deals, snapshot.updatedAt, snapshot.customFields, snapshot.tableSchema, snapshot.todoCards), { status: 503 });
      assert.equal(calls.filter(c => c.name === 'pipechat_commit_action').length, 1);
      assert(!calls.some(c => c.name === 'pipechat_write_workspace_v2'));
    }
  });

  await t.test('task replay returns original receipt even after the linked record is later deleted', async () => {
    const { u, snapshot } = await fixture(), { adapter } = adapterFor(u), cards = copy(snapshot.todoCards);
    cards[0].notes = 'First action';
    const saved = await adapter.writeTodo(cards, snapshot.updatedAt);
    const deleted = copy(await read(u)); deleted.deals = deleted.deals.filter(r => r.id !== 1); deleted.todoCards = [];
    const current = await save(u, deleted), replay = await adapter.writeTodo(cards, snapshot.updatedAt);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.actionReceipt, saved.actionReceipt);
    assert.deepEqual(replay.todoCards, cards); assert.deepEqual(await read(u), current);
    await assert.rejects(adapter.writeTodo([{ ...cards[0], notes: 'Changed replay' }], snapshot.updatedAt), { status: 409 });
  });

  await t.test('journal insert failure rolls back canonical save; undo marker failure rolls back compensation', async () => {
    const { u, snapshot } = await fixture(), next = copy(snapshot); next.deals[0].owner = 'After';
    const args = commitArgs(next), n = await count('action_journal');
    await db.exec(`create function pipechat.qa_journal_failure() returns trigger language plpgsql as $$ begin raise exception 'forced late failure'; end $$;
      create trigger qa_journal_failure before insert on pipechat.action_journal for each row execute function pipechat.qa_journal_failure();`);
    try { await code(() => rpc(u, 'commit_action', args), 'P0001'); }
    finally { await db.exec('drop trigger qa_journal_failure on pipechat.action_journal;'); }
    assert.deepEqual(await read(u), snapshot); assert.equal(await count('action_journal'), n);
    await rpc(u, 'commit_action', args); const saved = await read(u);
    await db.exec('create trigger qa_journal_failure before update on pipechat.action_journal for each row execute function pipechat.qa_journal_failure();');
    try { await code(() => rpc(u, 'undo_action', [args[0], randomUUID(), randomUUID(), saved.updatedAt]), 'P0001'); }
    finally { await db.exec('drop trigger qa_journal_failure on pipechat.action_journal; drop function pipechat.qa_journal_failure();'); }
    assert.deepEqual(await read(u), saved); assert.equal(await count('action_journal'), n + 1);
    assert.equal((await readAction(u, args[0])).undoneBy, null);
  });

  await t.test('created records reject newly linked tasks; deleted records and tasks restore together', async () => {
    const { u, snapshot } = await fixture(), next = copy(snapshot);
    next.deals.push({ id: 3, account: 'Created', history: [] });
    const args = commitArgs(next); await rpc(u, 'commit_action', args);
    const saved = await read(u); saved.todoCards.push({ ...saved.todoCards[0], id: 'todo_new', recordId: 3 });
    const current = await save(u, saved);
    await code(() => rpc(u, 'undo_action', [args[0], randomUUID(), randomUUID(), current.updatedAt]), 'PT409');
    assert.deepEqual(await read(u), current);
    const deleted = copy(current); deleted.deals = deleted.deals.filter(r => r.id !== 1); deleted.todoCards = deleted.todoCards.filter(c => c.recordId !== 1);
    const deletion = commitArgs(deleted); await rpc(u, 'commit_action', deletion);
    await rpc(u, 'undo_action', [deletion[0], randomUUID(), randomUUID(), (await read(u)).updatedAt]);
    assert.deepEqual(workspaceBody(await read(u)), workspaceBody(current));
  });

  await t.test('schema dependency rejects changed definition; schema undo refuses normalization of unrelated cells', async () => {
    const { u, snapshot } = await fixture(), next = copy(snapshot); next.deals[0].owner = 'After';
    const args = commitArgs(next); await rpc(u, 'commit_action', args);
    const changedSchema = await read(u); changedSchema.tableSchema.title = 'New title';
    const current = await save(u, changedSchema);
    await code(() => rpc(u, 'undo_action', [args[0], randomUUID(), randomUUID(), current.updatedAt]), 'PT409');
    assert.deepEqual(await read(u), current);
    const addedField = copy(current);
    addedField.customFields.push({ id: 'cf_extra', name: 'Extra', type: 'text', options: [] });
    const schemaAction = commitArgs(addedField); await rpc(u, 'commit_action', schemaAction);
    const fieldEdit = await read(u); fieldEdit.deals[1].cf_extra = 'Keep later value';
    const later = await save(u, fieldEdit);
    await code(() => rpc(u, 'undo_action', [schemaAction[0], randomUUID(), randomUUID(), later.updatedAt]), 'PT409');
    assert.deepEqual(await read(u), later);
  });

  await t.test('reset invalidates old undo and unavailable thread correlation cannot commit', async () => {
    const { u, snapshot } = await fixture(), next = copy(snapshot); next.deals[0].owner = 'After';
    await code(() => rpc(u, 'commit_action', commitArgs(next, randomUUID())), 'PT409');
    const args = commitArgs(next); await rpc(u, 'commit_action', args);
    const reset = await rpc(u, 'reset_crm', [(await read(u)).updatedAt, true]);
    assert.equal((await readAction(u, args[0])).undoInvalidated, true);
    await code(() => rpc(u, 'undo_action', [args[0], randomUUID(), randomUUID(), reset.updatedAt]), 'PT409');
    assert.deepEqual(await read(u), reset);
  });

  await t.test('authenticated RPC isolation, fixed search paths, revoked sessions and default-deny RLS', async () => {
    const { u, snapshot } = await fixture(), other = await user(), next = copy(snapshot); next.deals[0].owner = 'After';
    const args = commitArgs(next); await rpc(u, 'commit_action', args);
    assert.equal(await readAction(other, args[0]), null);
    const safe = sanitizeEvent({ requestId: randomUUID(), stage: 'request', outcome: 'failed', latencyMs: 1 });
    const calls = [['commit_action', args], ['read_action', [args[0]]],
      ['undo_action', [args[0], randomUUID(), randomUUID(), (await read(u)).updatedAt]], ['record_beta_event', [safe]],
      ['list_actions', [null, 20]], ['list_beta_events', [20, null]],
      ['commit_todo_action', [randomUUID(), randomUUID(), null, null, snapshot.updatedAt, []]]];
    for (const [name, params] of calls) {
      for (const role of ['anon', 'service_role']) await code(() => rpc(u, name, params, role), '42501');
      for (const invalid of [null, { id: u.id, session: other.session }, { id: u.id }, { id: 'bad', session: u.session }]) {
        await code(() => rpc(invalid, name, params), 'PT401');
      }
    }
    const functions = (await db.query(`select p.proname,n.nspname,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0) as public
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.proname in ('journal_document','journal_slot','journal_entry','journal_inverse','invalidate_action_undo',
      'journal_receipt','journal_metadata','apply_journaled','validate_beta_event','pipechat_commit_action','pipechat_commit_todo_action',
      'pipechat_list_actions','pipechat_list_beta_events','pipechat_read_action','pipechat_undo_action','pipechat_record_beta_event')`)).rows;
    assert.equal(functions.length, 16);
    for (const f of functions) {
      assert(f.proconfig.includes('search_path=pg_catalog'));
      assert.equal(f.anon, false); assert.equal(f.service, false); assert.equal(f.public, false);
      assert.equal(f.authenticated, f.nspname === 'public');
      if (f.nspname === 'public') assert(f.prosecdef);
    }
    for (const table of ['action_journal', 'beta_event_ledger', 'import_receipts']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        await code(() => as(u, () => db.query(`select * from pipechat.${table}`), role), '42501');
      }
    }
    await db.exec('grant usage on schema pipechat to authenticated; grant select,insert,update,delete on pipechat.action_journal,pipechat.beta_event_ledger to authenticated;');
    try {
      for (const table of ['action_journal', 'beta_event_ledger']) {
        assert.deepEqual((await as(u, () => db.query(`select * from pipechat.${table}`))).rows, []);
        assert.equal((await as(u, () => db.query(`delete from pipechat.${table}`))).affectedRows, 0);
      }
    } finally { await db.exec('revoke all on pipechat.action_journal,pipechat.beta_event_ledger from authenticated; revoke all on schema pipechat from authenticated;'); }
    await db.query('delete from auth.sessions where id=$1', [u.session]);
    for (const [name, params] of calls) await code(() => rpc(u, name, params), 'PT401');
  });

  await t.test('durable SQL telemetry exactly-once effect survives lost acknowledgement and logger recreation', async () => {
    const { u, conversationId } = await fixture();
    const input = { requestId: randomUUID(), conversationId, planId: randomUUID(), actionId: randomUUID(),
      stage: 'model', outcome: 'succeeded', latencyMs: 223, model: 'gpt-5.2',
      usage: { inputTokens: 44, outputTokens: 12, cachedTokens: 8 }, prompt: 'private', email: 'a@example.test', token: 'sk-secret' };
    const n = await count('beta_event_ledger'); let loseAck = true;
    const sink = createSqlTelemetrySink({ query: (sql, params) => as(u, async () => {
      const result = await db.query(sql, params);
      if (loseAck) { loseAck = false; throw new Error('lost acknowledgement after commit'); }
      return result;
    }) });
    let telemetry = createBetaTelemetry({ sink }); const prepared = telemetry.prepare(input);
    await assert.rejects(telemetry.persist(prepared), /lost acknowledgement/);
    assert.equal(await count('beta_event_ledger'), n + 1);
    telemetry = createBetaTelemetry({ sink });
    for (let i = 0; i < 3; i++) assert.deepEqual(await telemetry.persist(JSON.parse(JSON.stringify(prepared))), { eventId: prepared.eventId, inserted: false });
    const stored = (await db.query('select event from pipechat.beta_event_ledger where event_id=$1', [prepared.eventId])).rows[0].event;
    assert.deepEqual(stored, prepared); assert.doesNotMatch(JSON.stringify(stored), /private|example|sk-secret/);
    await code(() => telemetry.record({ ...input, outcome: 'failed' }), 'PT409');
    await code(() => rpc(u, 'record_beta_event', [{ ...prepared, eventId: randomUUID() }]), 'PT400');
    assert.equal(await count('beta_event_ledger'), n + 1);
    assert.equal((await telemetry.record({ ...input, attempt: 1 })).inserted, true);
    const concurrent = sanitizeEvent({ ...input, attempt: 2 });
    const acknowledgements = await as(u, () => Promise.all(Array.from({ length: 5 }, () =>
      db.query('select public.pipechat_record_beta_event($1::jsonb) as receipt', [JSON.stringify(concurrent)]))));
    assert.equal(acknowledgements.filter(r => r.rows[0].receipt.inserted).length, 1);
    assert.equal(await count('beta_event_ledger'), n + 3);
  });

  await t.test('SQL telemetry independently rejects unsafe payloads and malformed metrics', async () => {
    const u = await user(), safe = sanitizeEvent({ requestId: randomUUID(), stage: 'turn', outcome: 'failed', latencyMs: 42, errorCode: 'timeout' });
    const n = await count('beta_event_ledger');
    for (const bad of [null, [], { ...safe, prompt: 'raw' }, { ...safe, model: 'secret@example.test' },
      { ...safe, requestId: 'sk-secret' }, { ...safe, errorCode: 'raw exception' }, { ...safe, formatVersion: '1' },
      { ...safe, latencyMs: null }, { ...safe, latencyMs: 0.5 }, { ...safe, inputTokens: -1 },
      { ...safe, cachedTokens: 2, inputTokens: 1 }, { ...safe, cachedTokens: 2 }, { ...safe, stage: null }]) {
      await code(() => rpc(u, 'record_beta_event', [bad]), 'PT400');
    }
    assert.equal(await count('beta_event_ledger'), n);
    assert.equal((await rpc(u, 'record_beta_event', [{ ...safe, model: 'gpt-5.4-mini' }])).inserted, true);
  });

  await t.test('authenticated telemetry reads are actor/workspace scoped, bounded, request-filtered and sanitized by the adapter', async () => {
    const u = await user(), other = await user(), { adapter } = adapterFor(u);
    const requestId = randomUUID(), input = { requestId, stage: 'model', outcome: 'failed', latencyMs: 900,
      model: 'gpt-5.4-mini', errorCode: 'timeout', planId: 'a'.repeat(64), actionId: 'b'.repeat(64),
      prompt: 'private text', token: 'sk-secret', usage: { inputTokens: 400, outputTokens: 0 } };
    assert.equal((await adapter.recordTelemetry(input)).inserted, true);
    assert.equal((await adapter.recordTelemetry(input)).inserted, false);
    const stored = sanitizeEvent({ ...input, stage: 'turn', latencyMs: 950 });
    assert.equal((await adapter.recordTelemetry(stored)).inserted, true);
    await adapter.recordTelemetry({ ...input, requestId: randomUUID(), outcome: 'succeeded' });
    const selected = await adapter.readTelemetry({ requestId, limit: 100 });
    assert.equal(selected.length, 2); assert(selected.every(row => row.event.requestId === requestId));
    assert.equal(selected[0].event.planId, input.planId); assert.doesNotMatch(JSON.stringify(selected), /private text|sk-secret/);
    assert.equal((await adapter.readTelemetry({ limit: 1 })).length, 1);
    assert.deepEqual(await adapterFor(other).adapter.readTelemetry({ requestId }), []);
    await assert.rejects(adapter.readTelemetry({ limit: 101 }), { status: 400 });
    await assert.rejects(adapter.readTelemetry({ requestId: 'email@example.test' }), { status: 400 });
    await code(() => rpc(u, 'list_beta_events', [0, null]), 'PT400');
    await db.query('delete from auth.sessions where id=$1', [u.session]);
    await assert.rejects(adapter.readTelemetry(), { status: 401 });
  });

  await t.test('adapter with migration016 accepts generated cards, journals full workflow state, and undoes without retriggering', async () => {
    await run('migrations/016-business-automations.sql');
    const { u, snapshot } = await fixture();
    const spec = { version: 1, name: 'Won follow-up', timezone: 'America/New_York',
      trigger: { type: 'field_changes_to', field: 'stage', to: 'Won' },
      conditions: [{ type: 'no_open_qualifying_task', match: { field: 'nextAction', operator: 'contains', value: 'follow up' } }],
      action: { type: 'create_linked_task', nextAction: 'Follow up', notes: '', due: { anchor: 'event_date', offsetDays: 2 } } };
    const created = await rpc(u, 'create_workflow', [randomUUID(), randomUUID(), snapshot.updatedAt, 'workflow_journal', spec]);
    const active = await rpc(u, 'set_workflow_activation', [randomUUID(), randomUUID(), created.snapshot.updatedAt,
      created.workflow.id, created.workflow.revision, true]);
    const { adapter } = adapterFor(u), before = active.snapshot, rows = copy(before.deals); rows[0].stage = 'Won';
    const saved = await adapter.writeCrm(null, rows, before.updatedAt, before.customFields, before.tableSchema, before.todoCards);
    assert.equal(saved.todoCards.length, before.todoCards.length + 1);
    assert.equal(saved.workflows[0].executions[0].status, 'succeeded');
    const recorded = await adapter.readAction(saved.actionReceipt.actionId);
    assert(recorded.entry.changes.some(c => c.path[0] === 'workflows'));
    const undo = await adapter.undoAction(saved.actionReceipt.actionId, saved.updatedAt);
    assert.deepEqual(undo.todoCards, before.todoCards); assert.deepEqual(undo.workflows, before.workflows);
    assert.equal(undo.deals[0].stage, before.deals[0].stage);
    assert.equal((await adapter.writeCrm(null, rows, before.updatedAt, before.customFields, before.tableSchema, before.todoCards)).replayed, true);
    assert.deepEqual((await read(u)).workflows, before.workflows);
  });
});
