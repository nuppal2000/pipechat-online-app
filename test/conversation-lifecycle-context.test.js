'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { createConversationStore } = require('../lib/conversation-store');
const { createSupabaseBackend, BackendError } = require('../lib/supabase-backend');

const secret = 'PRIVATE_PROVIDER_TOKEN_AND_PAYLOAD';
const keys = ['requestId', 'userMessageId', 'assistantMessageId', 'status', 'publicErrorCode', 'finishedAt'];
const project = turn => Object.fromEntries(keys.map(key => [key, turn[key]]));
const token = page => ({ epoch: page.epoch, version: page.version });
const message = (content = 'The request failed. Please retry.', role = 'user') => ({ id: randomUUID(), content, role });
const errorIs = status => error => {
  assert(error instanceof BackendError);
  assert.equal(error.status, status, error.message);
  assert(!JSON.stringify(error).includes(secret));
  assert(!error.message.includes(secret));
  assert.equal(error.cause, undefined);
  return true;
};
const sqlCode = (task, code) => assert.rejects(task, error => { assert.equal(error.code, code, error.message); return true; });

async function localFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipechat-outcomes-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('pipechat-outcomes-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  let now = Date.parse('2026-10-01T12:00:00Z');
  const pending = new Map();
  const lock = async (key, task) => {
    const work = (pending.get(key) || Promise.resolve()).catch(() => {}).then(task);
    pending.set(key, work);
    try { return await work; } finally { if (pending.get(key) === work) pending.delete(key); }
  };
  const open = () => createConversationStore(directory, lock, { clock: () => new Date(now) });
  return { directory, open, advance: () => { now += 1000; }, expire: () => { now += 3600000; },
    bytes: () => fs.readFile(path.join(directory, 'conversations/account-a.json'), 'utf8') };
}

function supabaseFixture({ user = { id: randomUUID(), email: 'owner@example.test' }, result = [], rpc } = {}) {
  const calls = [];
  let verifications = 0;
  const backend = createSupabaseBackend({ url: 'https://pipechat-test.supabase.co',
    publishableKey: 'sb_publishable_offline_test_key_123456789',
    fetchImpl: () => { throw new Error('Network is forbidden in this fixture.'); },
    createClient: () => ({ rpc: () => { throw new Error('Health client is not authenticated.'); } }),
    createServerClient: () => ({ auth: { getUser: async () => { verifications++; return { data: { user }, error: null }; } },
      rpc: async (name, args) => { calls.push({ name, args }); return rpc ? rpc(name, args) : { data: result, error: null }; } }) });
  const headers = new Map();
  const adapter = backend.forRequest({ headers: {} }, { setHeader: (name, value) => headers.set(name, value), getHeader: name => headers.get(name) });
  return { adapter, calls, verifications: () => verifications };
}

async function prepare(store) {
  const current = await store.readConversation(), userMessage = message();
  const saved = await store.writeConversation({ ...token(current), messages: [userMessage], state: { focus: { ids: [7] } } });
  const request = { ...saved, threadId: (await store.listConversationThreads()).activeThreadId,
    requestId: randomUUID(), userMessageId: userMessage.id, assistantMessageId: randomUUID(), leaseSeconds: 120 };
  await store.beginConversationTurn(request);
  return request;
}
const finish = (store, request, status, publicErrorCode) => store.finishConversationTurn({
  threadId: request.threadId, requestId: request.requestId, status, publicErrorCode,
  content: status === 'succeeded' ? secret : null, resultReceipt: status === 'succeeded' ? { answer: secret } : null
});

async function exerciseOutcomes(store, { advance, expire, snapshot }) {
  const initial = await store.readConversation(), threadId = (await store.listConversationThreads()).activeThreadId;
  assert.deepEqual(await store.readConversationOutcomes(threadId), []);
  // Text resembling a terminal reply has no lifecycle authority without a turn ledger entry.
  await store.writeConversation({ ...token(initial), messages: [message('FAILED'), message('The request was cancelled.', 'assistant')], state: null });
  assert.deepEqual(await store.readConversationOutcomes(threadId), []);
  const terminal = [], cases = [['succeeded', 'none'], ['failed', 'validation'], ['cancelled', 'cancelled'], ['interrupted', 'timeout']];
  for (let i = 0; i < 16; i++) {
    if (i % 2 === 0) advance();
    terminal.push(await finish(store, await prepare(store), ...cases[i % cases.length]));
  }
  const running = await prepare(store);
  expire();
  const before = await snapshot();
  const expected = terminal.map(project).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.requestId.localeCompare(b.requestId)).slice(0, 12);
  const result = await store.readConversationOutcomes(threadId);
  assert.deepEqual(result, expected);
  assert.equal(result.length, 12);
  assert(!JSON.stringify(result).includes(secret));
  for (const outcome of result) assert.deepEqual(Object.keys(outcome).sort(), [...keys].sort());
  assert.deepEqual(await snapshot(), before);
  assert.equal((await store.readConversationTurn(threadId, running.requestId)).status, 'running');
  const second = await store.newConversationThread({ ...token(await store.readConversation()), title: 'Current work' });
  assert.deepEqual(await store.readConversationOutcomes(second.threadId), []);
  const switched = await snapshot();
  assert.deepEqual(await store.readConversationOutcomes(threadId.toUpperCase()), expected);
  assert.deepEqual(await snapshot(), switched);
  assert.deepEqual(await store.readConversation(), second.conversation);
  await assert.rejects(async () => store.readConversationOutcomes(randomUUID()), errorIs(404));
  return { threadId, expected, running };
}

test('local lifecycle context is bounded, ledger-only, private, durable and strictly read-only', async t => {
  const f = await localFixture(t), store = f.open()('account-a');
  await assert.rejects(async () => store.readConversationOutcomes(randomUUID()), errorIs(404));
  assert.deepEqual(await fs.readdir(f.directory), []);
  const { threadId, expected } = await exerciseOutcomes(store, { advance: f.advance, expire: f.expire, snapshot: f.bytes });
  assert.deepEqual(await f.open()('account-a').readConversationOutcomes(threadId), expected);
  const bytes = await f.bytes();
  await assert.rejects(async () => f.open()('account-b').readConversationOutcomes(threadId), errorIs(404));
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'conversations')), ['account-a.json']);
  for (const id of [undefined, null, '', 'bad', {}, `${threadId}x`]) {
    await assert.rejects(async () => store.readConversationOutcomes(id), errorIs(400));
  }
  assert.equal(await f.bytes(), bytes);
});

test('local context never migrates legacy files and validates stored public metadata', async t => {
  const f = await localFixture(t), file = path.join(f.directory, 'conversations/account-a.json');
  await fs.mkdir(path.dirname(file));
  const legacy = { epoch: randomUUID(), version: 0, messages: [], state: null, summary: '', summaryThrough: 0 };
  await fs.writeFile(file, JSON.stringify(legacy));
  const store = f.open()('account-a');
  await assert.rejects(async () => store.readConversationOutcomes(randomUUID()), errorIs(404));
  assert.equal(await f.bytes(), JSON.stringify(legacy));
  const request = await prepare(store);
  await finish(store, request, 'failed', 'unavailable');
  const original = JSON.parse(await f.bytes());
  const poisoned = structuredClone(original);
  poisoned.threadStore.turns[0].publicErrorCode = secret;
  await fs.writeFile(file, JSON.stringify(poisoned));
  await assert.rejects(async () => store.readConversationOutcomes(request.threadId), errorIs(500));
  assert.equal(await f.bytes(), JSON.stringify(poisoned));
  delete original.threadStore.turns;
  await fs.writeFile(file, JSON.stringify(original));
  assert.deepEqual(await store.readConversationOutcomes(request.threadId), []);
  assert.equal(await f.bytes(), JSON.stringify(original));
});

test('Supabase context uses request authentication, validates input and rejects unsafe output', async () => {
  const threadId = randomUUID(), valid = { requestId: randomUUID(), userMessageId: randomUUID(), assistantMessageId: randomUUID(),
    status: 'failed', publicErrorCode: 'validation', finishedAt: '2026-10-01T12:00:00.123456Z' };
  const good = supabaseFixture({ result: [valid] });
  assert.deepEqual(await good.adapter.readConversationOutcomes(threadId), [valid]);
  assert.deepEqual(good.calls, [{ name: 'pipechat_read_conversation_outcomes', args: { p_thread_id: threadId } }]);
  assert.equal(good.verifications(), 1);
  for (const [status, publicErrorCode] of [['succeeded', 'none'], ['cancelled', 'cancelled'], ['interrupted', 'timeout'],
    ...['unknown', 'timeout', 'unavailable', 'invalid_response', 'validation', 'conflict', 'unauthorized', 'quota'].map(code => ['failed', code])]) {
    const value = { ...valid, status, publicErrorCode };
    assert.deepEqual(await supabaseFixture({ result: [value] }).adapter.readConversationOutcomes(threadId), [value]);
  }
  for (const id of [undefined, null, '', 'bad', {}, `${threadId}x`]) {
    const f = supabaseFixture();
    await assert.rejects(() => f.adapter.readConversationOutcomes(id), errorIs(400));
    assert.equal(f.verifications(), 0); assert.deepEqual(f.calls, []);
  }
  const anonymous = supabaseFixture({ user: null });
  await assert.rejects(() => anonymous.adapter.readConversationOutcomes(threadId), errorIs(401));
  assert.deepEqual(anonymous.calls, []);
  const patches = [{ requestId: secret }, { userMessageId: null }, { assistantMessageId: valid.userMessageId },
    { status: 'accepted' }, { status: 'running' }, { status: 'FAILED' }, { publicErrorCode: secret }, { publicErrorCode: null },
    { publicErrorCode: ['validation'] }, { status: 'succeeded' }, { status: 'cancelled' }, { status: 'interrupted' },
    { finishedAt: null }, { finishedAt: 'yesterday' }, { finishedAt: '2026-99-01T00:00:00Z' },
    { finishedAt: '2026-02-30T00:00:00Z' }, { finishedAt: '2026-10-01T24:00:00Z' }, { content: secret },
    { resultReceipt: { secret } }, { accessToken: secret }, { rawError: secret }];
  const malformed = [null, {}, { outcomes: [valid] }, [null], new Array(1), Array(13).fill(valid), [valid, valid],
    ...patches.map(patch => [{ ...valid, ...patch }]), ...keys.map(key => [Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key))])];
  for (const result of malformed) {
    await assert.rejects(() => supabaseFixture({ result }).adapter.readConversationOutcomes(threadId), errorIs(503));
  }
  for (const status of [401, 404]) {
    const f = supabaseFixture({ rpc: () => ({ data: null, error: { code: `PT${status}`, message: secret, details: secret } }) });
    await assert.rejects(() => f.adapter.readConversationOutcomes(threadId), errorIs(status));
  }
});

test('025 lifecycle RPC preserves data and guards live owner sessions using the shared SQL fixture', { timeout: 180000 }, async t => {
  const db = new PGlite(); t.after(() => db.close());
  const run = async file => db.exec(await fs.readFile(path.join(__dirname, '../db', file), 'utf8'));
  await run('tests/mock-supabase.sql');
  const migrations = (await fs.readdir(path.join(__dirname, '../db/migrations'))).filter(file => /^\d{3}-.*\.sql$/.test(file) && file < '024').sort();
  for (const file of migrations) await run('migrations/' + file);
  await run('tests/security.sql');
  const signatures = { pipechat_read_conversation: ['bigint'], pipechat_list_conversation_threads: [],
    pipechat_write_conversation: ['uuid', 'bigint', 'jsonb', 'jsonb'], pipechat_new_conversation_thread: ['uuid', 'bigint', 'text'],
    pipechat_begin_conversation_turn: ['uuid', 'uuid', 'bigint', 'uuid', 'uuid', 'uuid', 'integer'],
    pipechat_finish_conversation_turn: ['uuid', 'uuid', 'text', 'text', 'text', 'jsonb'],
    pipechat_read_conversation_turn: ['uuid', 'uuid'], pipechat_read_conversation_outcomes: ['uuid'] };
  async function user() {
    const u = { id: randomUUID(), session: randomUUID() };
    await db.query('insert into auth.users(id) values($1)', [u.id]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [u.session, u.id]);
    return u;
  }
  async function as(u, task, role = 'authenticated') {
    assert(['authenticated', 'anon', 'service_role'].includes(role));
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(u ? { sub: u.id, session_id: u.session, role } : {})]);
    await db.exec('set role ' + role);
    try { return await task(); } finally { await db.exec('reset role'); }
  }
  const rpc = (u, name, args = [], role) => {
    assert(Object.hasOwn(signatures, name), 'Unexpected test RPC');
    return as(u, async () => (await db.query(
      `select public.${name}(${signatures[name].map((type, i) => '$' + (i + 1) + '::' + type).join(',')}) as result`,
      args.map((arg, i) => signatures[name][i] === 'jsonb' ? JSON.stringify(arg) : arg))).rows[0].result, role);
  };
  const adapter = u => supabaseFixture({ user: { id: u.id, email: 'owner@example.test' }, rpc: async (name, args) => {
    try { return { data: await rpc(u, name, Object.values(args || {})), error: null }; }
    catch (error) { return { data: null, error: { code: error.code } }; }
  } }).adapter;
  const a = await user(), b = await user(), member = await user(), store = adapter(a);
  const seed = await prepare(store);
  await finish(store, seed, 'failed', 'validation');
  const tables = (await db.query("select tablename from pg_tables where schemaname='pipechat' order by tablename")).rows.map(row => row.tablename);
  const snapshot = async () => {
    const result = {};
    for (const table of tables) result[table] = (await db.query(`select to_jsonb(t) as row from pipechat.${table} t order by to_jsonb(t)::text`)).rows;
    return result;
  };
  const definitions = async () => (await db.query(`select p.oid,p.proname,p.proacl,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','pipechat') order by p.oid`)).rows;
  const grants = async () => (await db.query("select oid,relacl,relrowsecurity from pg_class where relnamespace='pipechat'::regnamespace and relkind='r' order by oid")).rows;
  const before = await snapshot(), functionsBefore = await definitions(), grantsBefore = await grants();
  await run('migrations/025-conversation-context.sql');
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await grants(), grantsBefore);
  const functionsAfter = await definitions();
  assert.equal(functionsAfter.length, functionsBefore.length + 1);
  for (const fn of functionsBefore) assert.deepEqual(functionsAfter.find(item => item.oid === fn.oid), fn);
  await run('tests/security.sql');
  await t.test('025 RPC allowlist detects removal, overloads and widened execution grants', async () => {
    const mutations = [
      ['alter function public.pipechat_read_conversation_outcomes(uuid) rename to removed_outcomes', /Missing expected public RPC/],
      ['drop function public.pipechat_read_conversation_outcomes(uuid)', /Missing expected public RPC/],
      ["create function public.pipechat_read_conversation_outcomes(text) returns jsonb language sql as $$ select '[]'::jsonb $$", /Unexpected public.*signature/],
      ['grant execute on function public.pipechat_read_conversation_outcomes(uuid) to public', /PUBLIC execute/],
      ['grant execute on function public.pipechat_read_conversation_outcomes(uuid) to anon', /Unexpected anonymous execute/],
      ['grant execute on function public.pipechat_read_conversation_outcomes(uuid) to service_role', /Service role grant/],
      ['revoke execute on function public.pipechat_read_conversation_outcomes(uuid) from authenticated', /Unexpected authenticated execute/]
    ];
    for (const [sql, reason] of mutations) {
      await db.exec('begin');
      try { await db.exec(sql); await assert.rejects(() => run('tests/security.sql'), reason); }
      finally { await db.exec('rollback'); }
      await run('tests/security.sql');
    }
  });
  assert.equal((await store.readConversationOutcomes(seed.threadId))[0].requestId, seed.requestId);
  // Use a fresh logical thread for the shared local/Supabase contract checks.
  await store.newConversationThread({ ...token(await store.readConversation()), title: 'Outcomes' });
  const result = await exerciseOutcomes(store, { advance() {}, expire() {}, snapshot });
  await db.query("update pipechat.conversation_turns set lease_until=clock_timestamp()-interval '1 second' where request_id=$1", [result.running.requestId]);
  const expired = await snapshot();
  assert.deepEqual(await store.readConversationOutcomes(result.threadId), result.expected);
  assert.deepEqual(await snapshot(), expired);
  await db.query("update pipechat.conversation_turns set status='accepted' where request_id=$1", [result.running.requestId]);
  const accepted = await snapshot();
  assert.deepEqual(await store.readConversationOutcomes(result.threadId), result.expected);
  assert.deepEqual(await snapshot(), accepted);
  // Equal timestamps have deterministic request-ID order in both implementations.
  await db.query("update pipechat.conversation_turns set finished_at='2026-10-01T12:00:00Z' where thread_id=$1 and status not in ('accepted','running')", [result.threadId]);
  const tied = await store.readConversationOutcomes(result.threadId);
  const expectedIds = (await db.query("select request_id from pipechat.conversation_turns where thread_id=$1 and status not in ('accepted','running') order by request_id limit 12", [result.threadId])).rows.map(row => row.request_id);
  assert.deepEqual(tied.map(row => row.requestId), expectedIds);
  await as(a, async () => {
    await db.exec('begin read only');
    try { await db.query('select public.pipechat_read_conversation_outcomes($1)', [result.threadId]); }
    finally { await db.exec('rollback'); }
  });
  const wid = (await db.query('select workspace_id from pipechat.memberships where user_id=$1', [a.id])).rows[0].workspace_id;
  await db.query("update pipechat.memberships set workspace_id=$1,role='member' where user_id=$2", [wid, member.id]);
  for (const u of [b, member]) await assert.rejects(() => adapter(u).readConversationOutcomes(result.threadId), errorIs(404));
  await sqlCode(() => rpc(a, 'pipechat_read_conversation_outcomes', [null]), 'PT400');
  await sqlCode(() => rpc(a, 'pipechat_read_conversation_outcomes', [randomUUID()]), 'PT404');
  for (const u of [null, { ...a, session: undefined }, { ...a, session: 'bad' }, { ...a, session: b.session }, { ...a, id: 'bad' }]) {
    await sqlCode(() => rpc(u, 'pipechat_read_conversation_outcomes', [result.threadId]), 'PT401');
  }
  const privileges = (await db.query(`select p.prosecdef,p.provolatile,p.proconfig,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') as service,
    exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public
    from pg_proc p where p.oid='public.pipechat_read_conversation_outcomes(uuid)'::regprocedure`)).rows[0];
  assert.deepEqual(privileges, { prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog'], anon: false, authenticated: true, service: false, public: false });
  for (const role of ['anon', 'service_role']) await sqlCode(() => rpc(a, 'pipechat_read_conversation_outcomes', [result.threadId], role), '42501');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await sqlCode(() => as(a, () => db.query('select * from pipechat.conversation_turns'), role), '42501');
  }
  // Even a corrupt private error code cannot escape through the public RPC.
  await db.query("update pipechat.conversation_turns set terminal_payload=jsonb_build_object('publicErrorCode',$1::text,'content',$1::text,'resultReceipt',$1::text) where request_id=$2", [secret, tied[0].requestId]);
  assert(!JSON.stringify(await rpc(a, 'pipechat_read_conversation_outcomes', [result.threadId])).includes(secret));
  await assert.rejects(() => store.readConversationOutcomes(result.threadId), errorIs(503));
  await db.query('delete from auth.sessions where id=$1', [a.session]);
  await assert.rejects(() => store.readConversationOutcomes(result.threadId), errorIs(401));
  await sqlCode(() => rpc(a, 'pipechat_read_conversation_outcomes', [randomUUID()]), 'PT401');
  await db.query('delete from pipechat.memberships where user_id=$1', [member.id]);
  await sqlCode(() => rpc(member, 'pipechat_read_conversation_outcomes', [result.threadId]), 'PT401');
});
