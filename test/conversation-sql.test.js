const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { legacySchema } = require('../public/table-schema.js');

const signatures = {
  read_conversation: ['bigint'], write_conversation: ['uuid', 'bigint', 'jsonb', 'jsonb'],
  search_conversation: ['text', 'bigint'], save_conversation_memory: ['uuid', 'bigint', 'bigint', 'text'],
  read_workspace: [], write_workspace_v2: ['jsonb', 'jsonb', 'jsonb', 'text', 'jsonb'],
  reset_crm: ['text', 'boolean'], reserve_usage: ['uuid']
};
const message = (content = 'Private conversation', role = 'user', id = randomUUID()) => ({ id, role, content });
const range = (first, last) => Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
const seqs = messages => messages.map(m => m.seq);
const code = (fn, expected) => assert.rejects(fn, error => {
  assert.equal(error.code, expected, error.message);
  return true;
});

test('conversation archive on full local PostgreSQL migrations 001 through 010', { timeout: 180000 }, async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const run = async file => db.exec(await fs.readFile(path.join(__dirname, '../db', file), 'utf8'));
  await run('tests/mock-supabase.sql');
  const migrations = (await fs.readdir(path.join(__dirname, '../db/migrations')))
    .filter(f => /^(00[1-9]|010)-.*\.sql$/.test(f)).sort();
  assert.equal(migrations.length, 10);
  for (const file of migrations.slice(0, 9)) await run('migrations/' + file);
  await run('tests/security.sql');

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
    try { return await fn(); }
    finally { await db.exec('reset role'); }
  }
  async function rpc(u, name, args = [], role) {
    assert(Object.hasOwn(signatures, name));
    const types = signatures[name].slice(0, args.length);
    const params = types.map((type, i) => `$${i + 1}::${type}`).join(',');
    return as(u, async () => (await db.query(`select public.pipechat_${name}(${params}) as result`,
      args.map((arg, i) => types[i] === 'jsonb' ? JSON.stringify(arg) : arg))).rows[0].result, role);
  }
  const read = (u, before) => rpc(u, 'read_conversation', before === undefined ? [] : [before]);
  const write = (u, snapshot, messages = [], state = null) => rpc(u, 'write_conversation', [snapshot.epoch, snapshot.version, messages, state]);
  const search = (u, query, before) => rpc(u, 'search_conversation', before === undefined ? [query] : [query, before]);
  const memory = (u, epoch, expected, through, summary = 'Earlier conversation') => rpc(u, 'save_conversation_memory', [epoch, expected, through, summary]);
  const workspace = u => rpc(u, 'read_workspace');
  const reset = (u, snapshot, confirm = true) => rpc(u, 'reset_crm', [snapshot.updatedAt, confirm]);
  async function setup(u) {
    return rpc(u, 'write_workspace_v2', [[], [], legacySchema(), (await workspace(u)).updatedAt, []]);
  }
  async function member(u, owner) {
    await db.query('delete from pipechat.workspaces where owner_id=$1', [u.id]);
    await db.query("insert into pipechat.memberships(workspace_id,user_id,role) select workspace_id,$1,'member' from pipechat.memberships where user_id=$2", [u.id, owner.id]);
  }
  async function append(u, count, content = n => 'Message ' + n) {
    let snapshot = await read(u);
    for (let i = 1; i <= count; i += 20) {
      snapshot = await write(u, snapshot, range(i, Math.min(count, i + 19)).map(n => message(content(n), n % 2 ? 'user' : 'assistant')));
    }
    return read(u);
  }
  const countThreads = async () => (await db.query('select count(*)::int as n from pipechat.conversation_threads')).rows[0].n;
  const quota = async () => ({
    counters: (await db.query('select * from pipechat.usage_counters order by user_id')).rows,
    reservations: (await db.query('select * from pipechat.usage_reservations order by id')).rows
  });

  const seed = await user();
  let seedWorkspace = await setup(seed);
  seedWorkspace = await rpc(seed, 'write_workspace_v2', [[{ id: 1, account: 'Existing CRM', history: ['Keep me'] }], [], legacySchema(), seedWorkspace.updatedAt,
    [{ id: 'todo_existing', recordId: 1, status: 'To Do', nextAction: 'Call', notes: 'Keep this card', dueDate: '' }]]);
  await rpc(seed, 'reserve_usage', [randomUUID()]);
  const oldFunctions = async () => (await db.query(`select p.oid, pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('pipechat','public') order by p.oid`)).rows;
  const beforeFunctions = await oldFunctions();
  const beforeQuota = await quota();
  const oldTables = (await db.query("select tablename from pg_tables where schemaname='pipechat' order by tablename")).rows.map(r => r.tablename);
  const oldRows = async () => {
    const rows = {};
    for (const name of oldTables) rows[name] = (await db.query(`select to_jsonb(t) as row from pipechat.${name} t order by to_jsonb(t)::text`)).rows;
    return rows;
  };
  const beforeRows = await oldRows();
  await run('migrations/' + migrations[9]);

  await t.test('migration is additive and does not change data, quota, or existing functions', async () => {
    assert.deepEqual(await oldRows(), beforeRows);
    assert.deepEqual(await workspace(seed), seedWorkspace);
    assert.deepEqual(await quota(), beforeQuota);
    const functions = await oldFunctions();
    for (const old of beforeFunctions) assert.deepEqual(functions.find(f => f.oid === old.oid), old);
    assert.equal(await countThreads(), 0);
    const index = (await db.query("select indexdef from pg_indexes where schemaname='pipechat' and indexname='conversation_messages_search'")).rows[0].indexdef;
    assert.match(index, /USING gin/);
    assert.match(index, /to_tsvector\('simple'::regconfig, content\)/);
  });

  await t.test('lazy initialization, empty contract, queued first reads and strict CAS', async () => {
    const u = await user(), before = await countThreads();
    assert.deepEqual(await search(u, 'anything'), []);
    assert.deepEqual(await memory(u, randomUUID(), 0, 1), { saved: false });
    await code(() => write(u, { epoch: randomUUID(), version: 0 }, [message()]), 'PT409');
    assert.equal(await countThreads(), before);
    // PGlite is single-session: these overlap at the client, but execute serially.
    // The actual multi-session guarantee is the SQL unique key + ON CONFLICT and locks.
    const results = await as(u, () => Promise.all(range(1, 8).map(() => db.query('select public.pipechat_read_conversation() as result'))));
    const empty = results[0].rows[0].result;
    assert.match(empty.epoch, /^[0-9a-f-]{36}$/);
    assert.deepEqual(empty, { epoch: empty.epoch, version: 0, messages: [], before: null, state: null, summary: '', summaryThrough: 0, memoryMessages: [] });
    for (const result of results) assert.deepEqual(result.rows[0].result, empty);
    assert.equal(await countThreads(), before + 1);
    const definition = (await db.query("select pg_get_functiondef('public.pipechat_read_conversation(bigint)'::regprocedure) as source")).rows[0].source;
    assert.match(definition, /on conflict \(workspace_id,user_id\) do nothing/i);
    assert(definition.indexOf('for share') < definition.indexOf('for update'));
    for (const snapshot of [{ ...empty, epoch: null }, { ...empty, version: null }, { ...empty, epoch: randomUUID() }, { ...empty, version: -1 }]) {
      await code(() => write(u, snapshot), 'PT409');
    }
    const concurrent = await as(u, () => Promise.allSettled([message('First tab'), message('Second tab')].map(m =>
      db.query('select public.pipechat_write_conversation($1,0,$2::jsonb,null) as result', [empty.epoch, JSON.stringify([m])]))));
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(concurrent.find(r => r.status === 'rejected').reason.code, 'PT409');
    assert.equal((await read(u)).messages.length, 1);
    assert.equal((await read(u)).version, 1);
  });

  await t.test('archives are private per user AND workspace, even with shared membership and client IDs', async () => {
    const a = await user(), b = await user(), c = await user();
    await member(b, a);
    const id = randomUUID(), a0 = await read(a), b0 = await read(b);
    assert.notEqual(a0.epoch, b0.epoch);
    await write(a, a0, [message('Scarlet private owner', 'user', id)], { originalCommand: 'Owner only' });
    assert.deepEqual(await read(b), b0);
    await write(b, b0, [message('Cobalt private member', 'assistant', id)], { originalCommand: 'Member only' });
    const a1 = await read(a), b1 = await read(b);
    assert.deepEqual(await search(a, 'Cobalt'), []);
    assert.deepEqual(await search(b, 'Scarlet'), []);
    assert.equal((await search(a, 'Scarlet'))[0].id, id);
    await code(() => write(b, a1, [message('Cross-user attack')]), 'PT409');
    assert.deepEqual(await memory(b, a1.epoch, 0, 1), { saved: false });
    await db.query('update pipechat.memberships set workspace_id=(select workspace_id from pipechat.memberships where user_id=$1) where user_id=$2', [c.id, b.id]);
    const moved = await read(b);
    assert.notEqual(moved.epoch, b1.epoch);
    assert.deepEqual(moved.messages, []);
    await code(() => write(b, b1, [message('Old workspace')]), 'PT409');
    await write(b, moved, [message('Second workspace', 'user', id)]);
    assert.deepEqual((await read(c)).messages, []);
    await db.query('update pipechat.memberships set workspace_id=(select workspace_id from pipechat.memberships where user_id=$1) where user_id=$2', [a.id, b.id]);
    assert.deepEqual(await read(b), b1);
    assert.deepEqual(await read(a), a1);
  });

  await t.test('idempotent IDs, state-only versions, server timestamps, and all-or-nothing writes', async () => {
    const u = await user(), empty = await read(u), one = message('Keep exact whitespace  \n');
    let result = await write(u, empty, [one, { ...one, id: one.id.toUpperCase() }]);
    assert.deepEqual(result, { epoch: empty.epoch, version: 1 });
    let snapshot = await read(u);
    assert.deepEqual(seqs(snapshot.messages), [1]);
    assert.equal(snapshot.messages[0].content, one.content);
    assert.deepEqual(Object.keys(snapshot.messages[0]).sort(), ['content', 'createdAt', 'id', 'role', 'seq']);
    assert.match(snapshot.messages[0].createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    assert(Math.abs(Date.parse(snapshot.messages[0].createdAt) - Date.now()) < 60000);
    assert.deepEqual(await write(u, result, [one]), result);
    assert.deepEqual(await read(u), snapshot);
    await code(() => write(u, empty, [one]), 'PT409');
    const state = { view: 'table', tableView: { search: 'Keep' }, clarification: null };
    result = await write(u, result, [], state);
    assert.equal(result.version, 2);
    assert.deepEqual(await write(u, result, [], { clarification: null, tableView: { search: 'Keep' }, view: 'table' }), result);
    snapshot = await read(u);
    for (const changed of [{ ...one, content: 'Different' }, { ...one, role: 'assistant' }]) {
      await code(() => write(u, result, [message('Must roll back'), changed], { view: 'todo' }), 'PT409');
      assert.deepEqual(await read(u), snapshot);
    }
    const duplicate = message('New ID');
    await code(() => write(u, result, [duplicate, { ...duplicate, content: 'Conflicting within batch' }]), 'PT409');
    await code(() => write(u, result, [message('Valid first'), message('')]), 'PT400');
    assert.deepEqual(await read(u), snapshot);
    await db.exec(`create function pipechat.qa_conversation_failure() returns trigger language plpgsql as $$
      begin raise exception 'QA failure after message inserts'; end $$;
      create trigger qa_conversation_failure before update on pipechat.conversation_threads
      for each row execute function pipechat.qa_conversation_failure();`);
    try { await code(() => write(u, result, [message('Late failure')], null), 'P0001'); }
    finally { await db.exec('drop trigger qa_conversation_failure on pipechat.conversation_threads; drop function pipechat.qa_conversation_failure();'); }
    assert.deepEqual(await read(u), snapshot);
    result = await write(u, result, [message('Second actual message')], state);
    assert.equal(result.version, 3);
    assert.deepEqual(seqs((await read(u)).messages), [1, 2]);
    result = await write(u, result, [], null);
    assert.equal(result.version, 4);
    assert.equal((await read(u)).state, null);
    assert.deepEqual(await as(u, async () => (await db.query('select public.pipechat_write_conversation($1,$2,\'[]\',null) as result', [result.epoch, result.version])).rows[0].result), result);
  });

  await t.test('message and state validation enforce exact bounds and keep state inert', async () => {
    const u = await user(), crm = await setup(u), empty = await read(u);
    for (const messages of [null, {}, true, [null], [[]], [1], [{}], Array.from({ length: 21 }, () => message()),
      [message('', 'user')], [message(' \t\r\n\u00a0')], [message('x'.repeat(32001))], [message('bad', 'system')],
      [message('bad', 'tool')], [message('bad', 'User')], [message('bad', null)], [message('bad', 'user', 'not-uuid')],
      [message('bad', 'user', null)], [{ ...message(), content: {} }], [{ ...message(), content: null }],
      [{ ...message(), seq: 500 }], [{ ...message(), createdAt: '2000-01-01T00:00:00Z' }]]) {
      await code(() => write(u, empty, messages), 'PT400');
    }
    const invalidStates = [[], true, 'text', 1, { pending: {} }, { undo: {} }, { unknown: null },
      { clarification: [] }, { sourceAction: 'execute' }, { report: 1 }, { tableView: false },
      { originalCommand: {} }, { workspaceVersion: {} }, { workspaceVersion: -1 }, { workspaceVersion: 0.5 }, { view: {} }, { savedAt: [] },
      { savedAt: -1 }, { savedAt: 0.5 }, { savedAt: 9007199254740992 },
      JSON.parse('{"__proto__":{}}'), JSON.parse('{"report":{"constructor":{}}}'),
      JSON.parse('{"clarification":{"candidates":[{"prototype":{}}]}}'),
      { originalCommand: 'x'.repeat(65536) }, { originalCommand: '\u00e9'.repeat(32768) }];
    for (const state of invalidStates) await code(() => write(u, empty, [message('Rollback')], state), 'PT400');
    assert.deepEqual(await read(u), empty);
    const state = { clarification: { question: 'Which?', previousAction: { action: 'delete_records', ids: [1] } },
      sourceAction: { action: 'delete_records', ids: [1] }, originalCommand: '<script>deleteEverything()</script>',
      workspaceVersion: crm.updatedAt, report: { groupBy: 'owner' }, view: 'dashboard',
      tableView: { filter: null, visibleIds: [1], search: "'; drop table pipechat.workspaces; --" }, savedAt: '2026-09-23T10:00:00Z' };
    let result = await write(u, empty, [message('x'.repeat(32000)), message('\u00e9'.repeat(32000), 'assistant')], state);
    assert.deepEqual((await read(u)).state, state);
    assert.deepEqual(await workspace(u), crm);
    const overhead = (await db.query("select octet_length('{\"originalCommand\":\"\"}'::jsonb::text) as n")).rows[0].n;
    const exact = { originalCommand: 'x'.repeat(65536 - overhead) };
    result = await write(u, result, [], exact);
    assert.deepEqual((await read(u)).state, exact);
    await code(() => write(u, result, [], { originalCommand: exact.originalCommand + 'x' }), 'PT400');
    result = await write(u, result, [], { savedAt: Date.now(), workspaceVersion: 0 });
    assert.equal(typeof (await read(u)).state.savedAt, 'number');
    assert.equal((await read(u)).state.workspaceVersion, 0);
    result = await write(u, result, [], {});
    assert.deepEqual((await read(u)).state, {});
    assert.deepEqual(await workspace(u), crm);
    for (const before of [0, -1, '9007199254740992']) {
      await code(() => read(u, before), 'PT400');
      await code(() => search(u, 'text', before), 'PT400');
    }
  });

  await t.test('chronological pages of 50, cursor boundaries and indexed full-text search of at most six', async () => {
    const u = await user();
    const latest = await append(u, 113, n => `archive item ${n} ${n % 2 ? 'scarlet meadow' : 'cobalt harbor'}`);
    assert.deepEqual(seqs(latest.messages), range(64, 113));
    assert.equal(latest.before, 64);
    assert.deepEqual(seqs(latest.memoryMessages), range(1, 20));
    const older = await read(u, latest.before), oldest = await read(u, older.before);
    assert.deepEqual(seqs(older.messages), range(14, 63));
    assert.equal(older.before, 14);
    assert.deepEqual(older.memoryMessages, []);
    assert.deepEqual(seqs(oldest.messages), range(1, 13));
    assert.equal(oldest.before, null);
    assert.deepEqual(oldest.memoryMessages, []);
    assert.equal(new Set([...oldest.messages, ...older.messages, ...latest.messages].map(m => m.id)).size, 113);
    assert.deepEqual((await read(u, 1)).messages, []);
    assert.equal((await read(u, 1)).before, null);
    assert.deepEqual(seqs((await read(u, 51)).messages), range(1, 50));
    assert.equal((await read(u, 51)).before, null);
    assert.deepEqual((await read(u, 9999)).memoryMessages, []);
    assert.deepEqual(await read(u, null), latest);
    assert.deepEqual(await search(u, 'archive'), latest.messages.slice(-6));
    assert.deepEqual(seqs(await search(u, 'archive', 108)), range(102, 107));
    assert.deepEqual(seqs(await search(u, '"scarlet meadow"')), [103, 105, 107, 109, 111, 113]);
    assert.deepEqual(seqs(await search(u, 'scarlet OR cobalt')), range(108, 113));
    assert.deepEqual(await search(u, 'scarlet -meadow'), []);
    assert.deepEqual(await search(u, 'archive', 1), []);
    for (const query of ['', '   ', '"', 'nonexistent', 'x'.repeat(300)]) assert.deepEqual(await search(u, query), []);
    assert(Array.isArray(await search(u, "'; drop table pipechat.conversation_messages; --")));
    await code(() => search(u, null), 'PT400');
    await code(() => search(u, 'x'.repeat(301)), 'PT400');
    assert.deepEqual(await read(u), latest);
  });

  await t.test('memory batches use next_seq - 12, watermark CAS, and never increment UI version', async () => {
    const u = await user();
    let snapshot = await append(u, 11);
    assert.deepEqual(snapshot.memoryMessages, []);
    await code(() => memory(u, snapshot.epoch, 0, 1), 'PT400');
    await write(u, snapshot, [message('Twelfth')]);
    snapshot = await read(u);
    assert.deepEqual(seqs(snapshot.memoryMessages), [1]);
    await append(u, 33);
    snapshot = await read(u);
    assert.deepEqual(seqs(snapshot.memoryMessages), range(1, 20));
    assert.deepEqual(await memory(u, snapshot.epoch, 0, 20, 'x'.repeat(3200)), { saved: true });
    let saved = await read(u);
    assert.equal(saved.version, snapshot.version);
    assert.equal(saved.summaryThrough, 20);
    assert.equal(saved.summary.length, 3200);
    assert.deepEqual(seqs(saved.memoryMessages), range(21, 34));
    assert.deepEqual(await memory(u, snapshot.epoch, 0, 21), { saved: false });
    assert.deepEqual(await memory(u, randomUUID(), 20, 21), { saved: false });
    assert.deepEqual(await memory(u, null, 20, 21), { saved: false });
    for (const [expected, through, summary] of [[null, 21, ''], [-1, 21, ''], [20, null, ''], [20, 0, ''], [20, -1, ''],
      [20, 20, ''], [20, 19, ''], [20, 35, ''], [20, 46, ''], [20, 21, null], [20, 21, 'x'.repeat(3201)]]) {
      await code(() => memory(u, snapshot.epoch, expected, through, summary), 'PT400');
    }
    assert.deepEqual(await read(u), saved);
    assert.deepEqual(await memory(u, snapshot.epoch, 20, 34, ''), { saved: true });
    saved = await read(u);
    assert.equal(saved.summary, '');
    assert.deepEqual(saved.memoryMessages, []);
    assert.equal(saved.version, snapshot.version);
    // A tab's UI CAS token remains valid after both memory updates.
    await write(u, snapshot, [message('More recent')], { view: 'table' });
    saved = await read(u);
    assert.equal(saved.version, snapshot.version + 1);
    assert.equal(saved.summaryThrough, 34);
    assert.deepEqual(seqs(saved.memoryMessages), [35]);
  });

  await t.test('reset clears all private archives in one workspace atomically, invalidating old tabs', async () => {
    const a = await user(), b = await user(), c = await user();
    await member(b, a);
    const crm = await setup(a), otherCrm = await setup(c);
    const a1 = await append(a, 15), b1 = await append(b, 2), c1 = await append(c, 2);
    await memory(a, a1.epoch, 0, 4, 'Private summary');
    const aSaved = await read(a), beforeQuota = await quota();
    await code(() => reset(b, crm), 'PT403');
    await code(() => reset(a, crm, false), 'PT400');
    await code(() => reset(a, { updatedAt: 'stale' }), 'PT409');
    await db.exec(`create function pipechat.qa_late_reset_failure() returns trigger language plpgsql as $$
      begin raise sqlstate 'PT409' using message='QA conflict after archive deletion'; end $$;
      create trigger qa_late_reset_failure before update on pipechat.workspaces
      for each row execute function pipechat.qa_late_reset_failure();`);
    try { await code(() => reset(a, crm), 'PT409'); }
    finally { await db.exec('drop trigger qa_late_reset_failure on pipechat.workspaces; drop function pipechat.qa_late_reset_failure();'); }
    assert.deepEqual(await read(a), aSaved);
    assert.deepEqual(await read(b), b1);
    assert.deepEqual(await workspace(a), crm);
    const resetCrm = await reset(a, crm);
    assert.deepEqual(resetCrm.tableSchema, { status: 'pending' });
    for (const epoch of [a1.epoch, b1.epoch]) {
      assert.equal((await db.query('select count(*)::int as n from pipechat.conversation_messages where thread_id=$1', [epoch])).rows[0].n, 0);
      assert.equal((await db.query('select count(*)::int as n from pipechat.conversation_threads where epoch=$1', [epoch])).rows[0].n, 0);
    }
    await code(() => write(a, aSaved, [message('Stale tab')]), 'PT409');
    assert.deepEqual(await memory(a, a1.epoch, 4, 5), { saved: false });
    const a2 = await read(a), b2 = await read(b);
    assert.notEqual(a2.epoch, a1.epoch);
    assert.notEqual(b2.epoch, b1.epoch);
    assert.deepEqual(a2, { epoch: a2.epoch, version: 0, messages: [], before: null, state: null, summary: '', summaryThrough: 0, memoryMessages: [] });
    await code(() => write(a, { ...a2, epoch: a1.epoch }), 'PT409');
    assert.deepEqual(await search(a, 'Message'), []);
    assert.deepEqual(await read(c), c1);
    assert.deepEqual(await workspace(c), otherCrm);
    // Even a second reset of an already-pending workspace invalidates epochs.
    await write(a, a2, [message('New archive')]);
    await reset(a, resetCrm);
    assert.notEqual((await read(a)).epoch, a2.epoch);
    assert.deepEqual((await read(a)).messages, []);
    assert.deepEqual(await quota(), beforeQuota);
  });

  await t.test('authenticated RPCs alone have access; live-session checks, fixed paths, and RLS deny bypass', async () => {
    const a = await user(), b = await user(), snapshot = await append(a, 15);
    const calls = [['read_conversation', []], ['write_conversation', [snapshot.epoch, snapshot.version, [], null]],
      ['search_conversation', ['Message']], ['save_conversation_memory', [snapshot.epoch, 0, 1, 'summary']]];
    const functions = (await db.query(`select p.oid,p.proname,n.nspname,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','pipechat') and p.proname like '%conversation%'`)).rows;
    assert.equal(functions.length, 7);
    for (const f of functions) {
      assert(f.proconfig.includes('search_path=pg_catalog'));
      assert.equal(f.anon, false); assert.equal(f.service, false); assert.equal(f.public, false);
      assert.equal(f.authenticated, f.nspname === 'public');
      if (f.nspname === 'public') assert.equal(f.prosecdef, true);
    }
    for (const [name, args] of calls) {
      for (const role of ['anon', 'service_role']) await code(() => rpc(a, name, args, role), '42501');
      for (const invalid of [null, { ...a, session: undefined }, { ...a, session: 'bad' }, { ...a, session: b.session }, { ...a, id: 'bad' }]) {
        await code(() => rpc(invalid, name, args), 'PT401');
      }
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const sql of ['select * from pipechat.conversation_threads', 'select * from pipechat.conversation_messages',
        'delete from pipechat.conversation_messages', 'update pipechat.conversation_threads set version=999',
        'insert into pipechat.conversation_threads(workspace_id,user_id) values (gen_random_uuid(),gen_random_uuid())',
        'select pipechat.validate_conversation_state(null)', 'select pipechat.reset_conversation_history()']) {
        await code(() => as(a, () => db.query(sql), role), '42501');
      }
    }
    const tables = (await db.query(`select c.relname,c.relrowsecurity,
      exists(select 1 from pg_policy where polrelid=c.oid) as policies,
      exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0) as public,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as authenticated,
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as service
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='pipechat' and c.relname in ('conversation_threads','conversation_messages')`)).rows;
    assert.equal(tables.length, 2);
    for (const table of tables) {
      assert(table.relrowsecurity); assert.equal(table.policies, false); assert.equal(table.public, false);
      assert.equal(table.anon, false); assert.equal(table.authenticated, false); assert.equal(table.service, false);
    }
    await db.exec('grant usage on schema pipechat to authenticated; grant select,insert,update,delete on pipechat.conversation_threads,pipechat.conversation_messages to authenticated;');
    try {
      for (const table of ['conversation_threads', 'conversation_messages']) {
        assert.deepEqual((await as(a, () => db.query(`select * from pipechat.${table}`))).rows, []);
        assert.equal((await as(a, () => db.query(`delete from pipechat.${table}`))).affectedRows, 0);
      }
      await code(() => as(a, () => db.query('insert into pipechat.conversation_threads(workspace_id,user_id) values (gen_random_uuid(),gen_random_uuid())')), '42501');
    } finally {
      await db.exec('revoke all on pipechat.conversation_threads,pipechat.conversation_messages from authenticated; revoke all on schema pipechat from authenticated;');
    }
    assert.deepEqual(await read(a), snapshot);
    await db.query('delete from auth.sessions where id=$1', [a.session]);
    for (const [name, args] of calls) await code(() => rpc(a, name, args), 'PT401');
    await db.query('delete from pipechat.memberships where user_id=$1', [b.id]);
    for (const [name, args] of calls) await code(() => rpc(b, name, args), 'PT401');
    await db.query('delete from auth.users where id=$1', [a.id]);
    assert.equal((await db.query('select count(*)::int as n from pipechat.conversation_messages where thread_id=$1', [snapshot.epoch])).rows[0].n, 0);
  });

  await t.test('history, search, state, memory and reset do not touch exhausted quota or expired reservations', async () => {
    const u = await user(), crm = await setup(u);
    await rpc(u, 'reserve_usage', [randomUUID()]);
    await db.query('update pipechat.usage_counters set used=7,quota_limit=7 where user_id=$1', [u.id]);
    await db.query("update pipechat.usage_reservations set created_at=statement_timestamp()-interval '10 minutes',expires_at=statement_timestamp()-interval '5 minutes' where user_id=$1", [u.id]);
    const before = await quota();
    const snapshot = await append(u, 30);
    await search(u, 'Message');
    await read(u, 15);
    await memory(u, snapshot.epoch, 0, 19, 'Quota-independent memory');
    await write(u, snapshot, [], { view: 'todo' });
    await reset(u, crm);
    await read(u);
    assert.deepEqual(await quota(), before);
  });
});
