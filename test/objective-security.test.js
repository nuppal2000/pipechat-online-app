'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { legacySchema } = require('../public/table-schema');
const Business = require('../public/business-workspace');
const Compiler = require('../lib/business-compiler');
const { sanitizeEvent } = require('../lib/beta-telemetry');

const clone = value => structuredClone(value);
const body = s => ({ deals: s.deals, customFields: s.customFields, tableSchema: s.tableSchema, todoCards: s.todoCards });
const rejectsCode = (fn, code) => assert.rejects(fn, error => {
  assert.equal(error.code, code, error.message); return true;
});
const workflowSpec = () => ({ version: 1, name: 'Won follow-up', timezone: 'America/New_York',
  trigger: { type: 'field_changes_to', field: 'stage', to: 'Won' },
  conditions: [{ type: 'no_open_qualifying_task', match: { field: 'nextAction', operator: 'contains', value: 'Follow up' } }],
  action: { type: 'create_linked_task', nextAction: 'Follow up', notes: '', due: { anchor: 'event_date', offsetDays: 2 } } });

// No remote client, credentials, HTTP server, or disk database: exercise the SQL
// boundary directly so browser/compiler validation cannot mask an RPC flaw.
test('objective security: combined migrations 001-016 adversarial boundaries', { timeout: 180000 }, async t => {
  const db = new PGlite(); t.after(() => db.close());
  const run = async file => db.exec(await fs.readFile(path.join(__dirname, '../db', file), 'utf8'));
  await run('tests/mock-supabase.sql');
  await db.exec('alter table auth.users add column email text');
  const files = (await fs.readdir(path.join(__dirname, '../db/migrations')))
    .filter(file => /^(00[1-9]|01[0-6])-.*\.sql$/.test(file)).sort();
  assert.equal(files.length, 16, 'Audit the complete 001-016 migration set');
  for (const file of files.filter(file => file < '013')) {
    await run('migrations/' + file);
    await run('tests/security.sql');
  }
  const oldFunctions = new Set((await db.query('select oid from pg_proc')).rows.map(row => row.oid));
  const oldTables = new Set((await db.query("select oid from pg_class where relnamespace='pipechat'::regnamespace")).rows.map(row => row.oid));
  for (const file of files.filter(file => file >= '013')) {
    await run('migrations/' + file);
    await run('tests/security.sql');
  }

  async function user() {
    const u = { id: randomUUID(), session: randomUUID(), email: randomUUID() + '@example.invalid' };
    await db.query('insert into auth.users(id,email) values($1,$2)', [u.id, u.email]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [u.session, u.id]);
    return u;
  }
  async function as(u, callback, role = 'authenticated') {
    assert(['authenticated', 'anon', 'service_role'].includes(role));
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(u ? {
      sub: u.id, session_id: u.session, role, ...u.claims
    } : {})]);
    await db.exec('set role ' + role);
    try { return await callback(); } finally { await db.exec('reset role'); }
  }
  function rpc(u, name, args = [], role) {
    assert(/^(pipechat_|business_workspace_)[a-z0-9_]+$/.test(name));
    return as(u, async () => (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as result`,
      args.map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].result, role);
  }
  const read = u => rpc(u, 'pipechat_read_workspace');
  const get = (u, wid = null) => rpc(u, 'business_workspace_get', [wid]);
  const save = (u, s) => rpc(u, 'pipechat_write_workspace_v2', [s.deals, s.customFields, s.tableSchema, s.updatedAt, s.todoCards]);
  const cas = (u, s, next) => rpc(u, 'business_workspace_cas', [s.workspaceId, s.version, next, s.primary.updatedAt]);
  const share = (u, s, target, scope = 'workspace', resource = null, role = 'viewer') => rpc(u,
    'business_workspace_share', [s.workspaceId, target.email, scope, resource, role, s.version]);
  const revoke = (u, s, target, scope = 'workspace', resource = null) => rpc(u,
    'business_workspace_revoke', [s.workspaceId, target.email, scope, resource, s.version]);
  const history = (u, s, id) => rpc(u, 'business_workspace_history', [s.workspaceId, id, 0]);
  const actionArgs = s => [randomUUID(), randomUUID(), null, null, s.updatedAt, body(s), {}];
  const commit = (u, args) => rpc(u, 'pipechat_commit_action', args);
  const auditCount = async wid => (await db.query('select count(*)::int n from pipechat.business_audit where workspace_id=$1', [wid])).rows[0].n;

  async function fixture() {
    const u = await user(), empty = await read(u);
    let crm = await save(u, { ...empty, tableSchema: legacySchema(), deals: [], todoCards: [] });
    crm = await save(u, { ...crm, deals: [
      { id: 1, account: 'Visible primary', owner: 'Owner', stage: 'Discovery', notes: '', history: [] },
      { id: 2, account: 'Secret primary', owner: 'Private', stage: 'Discovery', notes: 'hidden-primary-marker', history: [] }
    ] });
    let business = await get(u);
    const visible = 'ent_' + randomUUID(), hidden = 'ent_' + randomUUID(), view = 'view_' + randomUUID();
    const next = Business.empty();
    next.entityTypes = [{ id: 'organization', name: 'Organization', fields: [
      { id: 'name', name: 'Name', type: 'text', required: true, options: [] },
      { id: 'amount', name: 'Amount', type: 'number', required: false, options: [] },
      { id: 'day', name: 'Day', type: 'date', required: false, options: [] }
    ] }];
    next.entities = [{ id: visible, typeId: 'organization', values: { name: 'Visible organization' } },
      { id: hidden, typeId: 'organization', values: { name: 'hidden-entity-marker' } }];
    next.relationshipTypes = [
      { id: 'belongs_to', name: 'Belongs to', fromType: 'primary', toType: 'organization', cardinality: 'many_to_one' },
      { id: 'related', name: 'Related', fromType: 'organization', toType: 'organization', cardinality: 'many_to_many' }
    ];
    next.relationships = [
      { id: 'lnk_' + randomUUID(), typeId: 'belongs_to', fromId: Business.legacyId(business.workspaceId, 1), toId: visible },
      { id: 'lnk_' + randomUUID(), typeId: 'related', fromId: visible, toId: hidden }
    ];
    next.views = [{ id: view, name: 'Explicit shared set', entityIds: [visible, Business.legacyId(business.workspaceId, 1)] }];
    business = await cas(u, business, next);
    return { u, crm, business, visible, hidden, view };
  }
  async function turn(u) {
    const current = await rpc(u, 'pipechat_read_conversation'), userMessage = randomUUID();
    const saved = await rpc(u, 'pipechat_write_conversation', [current.epoch, current.version,
      [{ id: userMessage, role: 'user', content: 'User request' }], null]);
    const threads = await rpc(u, 'pipechat_list_conversation_threads');
    const args = [threads.activeThreadId, saved.epoch, saved.version,
      randomUUID(), userMessage, randomUUID(), 120];
    const receipt = await rpc(u, 'pipechat_begin_conversation_turn', args);
    return { args, receipt, saved, threadId: threads.activeThreadId };
  }

  await t.test('new functions have explicit least-privilege ACLs and fixed definer search paths', async () => {
    const functions = (await db.query(`select p.oid,p.proname,n.nspname,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'execute') anon,
      has_function_privilege('authenticated',p.oid,'execute') authenticated,
      has_function_privilege('service_role',p.oid,'execute') service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','pipechat')`)).rows
      .filter(row => !oldFunctions.has(row.oid) || /without_automations$/.test(row.proname));
    assert(functions.length > 40);
    for (const f of functions) {
      assert.equal(f.anon, false, f.proname + ' callable anonymously');
      assert.equal(f.authenticated, f.nspname === 'public', f.proname + ' authenticated ACL');
      assert.equal(f.service, false, f.proname + ' service ACL');
      if (f.prosecdef) assert.deepEqual(f.proconfig, ['search_path=pg_catalog'], f.proname);
    }
    const tables = (await db.query(`select c.oid,c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') authenticated,
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') service
      from pg_class c where c.relnamespace='pipechat'::regnamespace and c.relkind='r'`)).rows
      .filter(row => !oldTables.has(row.oid));
    assert.equal(tables.length, 14);
    for (const row of tables) {
      assert.equal(row.relrowsecurity, true, row.relname);
      assert.equal(row.anon || row.authenticated || row.service, false, row.relname + ' bypasses RPC authorization');
    }
  });

  await t.test('security assertions detect unknown signatures, missing RPCs, role grants, unsafe owners, search paths and RLS drift', async () => {
    const mutations = [
      ["create function public.business_backdoor() returns integer language sql as 'select 1'", /Unexpected public.*signature/],
      ["create function public.pipechat_read_action(uuid) returns jsonb language sql as 'select null::jsonb'", /Unexpected public.*signature/],
      ['alter function public.business_workspace_history(uuid,text,bigint) rename to removed_history', /Missing expected public RPC/],
      ['alter function public.pipechat_reset_crm(text,boolean) rename to removed_reset', /Missing expected public RPC/],
      ['alter function public.pipechat_list_beta_events(integer,uuid) security invoker', /security definer/],
      ['alter function public.business_workspace_get(uuid) set search_path=public', /Unfixed search_path/],
      ['alter function public.business_workspace_get(uuid) owner to authenticated', /Runtime role owns/],
      ['grant execute on function pipechat.business_snapshot(uuid,uuid) to authenticated', /Unexpected authenticated execute/],
      ['grant execute on function public.pipechat_list_actions(jsonb,integer) to anon', /Unexpected anonymous execute/],
      ['grant execute on function public.pipechat_read_action(text) to service_role', /Service role grant/],
      ['grant execute on function public.business_workspace_get(uuid) to public', /PUBLIC execute/],
      ['alter table pipechat.action_journal disable row level security', /Missing RLS/],
      ['create policy open_everything on pipechat.business_grants for select using (true)', /Unexpected browser RLS policy/],
      ['grant select on pipechat.conversation_archives to authenticated', /Unexpected direct table privileges/],
      ['grant usage on sequence pipechat.business_audit_id_seq to authenticated', /Unexpected direct sequence privileges/],
      ['grant usage on schema pipechat to authenticated', /Private schema is accessible/],
      ['grant create on schema pipechat to authenticated', /Private schema is writable/]
    ];
    for (const [sql, reason] of mutations) {
      await db.exec('begin');
      try { await db.exec(sql); await assert.rejects(() => run('tests/security.sql'), reason); }
      finally { await db.exec('rollback'); }
      await run('tests/security.sql');
    }
    await db.exec('begin read only');
    try { await run('tests/security.sql'); } finally { await db.exec('rollback'); }
  });

  await t.test('business RPC rejects primary writes, authority injection, malformed fields and cross-tenant graph IDs atomically', async () => {
    const f = await fixture(), outsider = await fixture(), beforeAudit = await auditCount(f.business.workspaceId);
    const mutations = [
      ['primary values', s => { s.primary.records = [{ recordId: 1, values: { account: 'Overwrite' } }]; }],
      ['primary source', s => { s.primary.source = 'auth.users'; }],
      ['primary entity type', s => { s.entityTypes[0].id = 'primary'; }],
      ['primary as editable entity', s => { s.entities[0].id = Business.legacyId(f.business.workspaceId, 1); }],
      ['owners', s => { s.ownerId = outsider.u.id; }],
      ['grants', s => { s.grants = [{ userId: outsider.u.id, role: 'owner' }]; }],
      ['memberships', s => { s.memberships = [{ userId: outsider.u.id, role: 'editor' }]; }],
      ['prototype key', s => { s.entities[0].values = JSON.parse('{"name":"Value","__proto__":{"role":"owner"}}'); }],
      ['foreign endpoint', s => { s.relationships[0].fromId = Business.legacyId(outsider.business.workspaceId, 1); }],
      ['foreign view member', s => { s.views[0].entityIds.push(outsider.visible); }],
      ['numeric string', s => { s.entities[0].values.amount = '5'; }],
      ['invalid date', s => { s.entities[0].values.day = '2026-02-30'; }],
      ['duplicate entity', s => { s.entities.push(clone(s.entities[0])); }],
      ['cardinality violation', s => { s.relationships.push({ ...s.relationships[0], id: 'lnk_' + randomUUID(), toId: f.hidden }); }],
      ['null collection', s => { s.entities = null; }]
    ];
    for (const [name, mutate] of mutations) {
      const next = clone(f.business.state); mutate(next);
      await rejectsCode(() => cas(f.u, f.business, next), 'PT400');
      assert.deepEqual(await get(f.u), f.business, name);
      assert.deepEqual(await read(f.u), f.crm, name + ' changed primary data');
      assert.equal(await auditCount(f.business.workspaceId), beforeAudit, name + ' leaked partial audit');
    }
  });

  await t.test('model business plans cannot grant permissions, write primary rows, or upgrade read-only snapshots', async () => {
    const f = await fixture(), snapshot = clone(f.business);
    const prepare = operations => Compiler.prepare(snapshot, { action: 'business_plan', version: 1, title: 'Model plan', operations }, randomUUID());
    for (const op of ['share', 'grant', 'revoke', 'set_role', 'put_membership', 'execute_sql']) {
      assert.throws(() => prepare([{ op, email: 'attacker@example.invalid', role: 'owner', sql: 'grant all to public' }]));
    }
    for (const id of [Business.legacyId(snapshot.workspaceId, 1), '1', f.hidden + "'; grant all to public; --"]) {
      assert.throws(() => prepare([{ op: 'update_entity', id, values: [{ field: 'name', value: 'Overwrite primary' }] }]));
    }
    const change = { op: 'update_entity', id: f.visible, values: [{ field: 'name', value: 'Proposal only' }] };
    assert.throws(() => Compiler.prepare({ ...snapshot, role: 'viewer' },
      { action: 'business_plan', version: 1, operations: [change] }, randomUUID()), /read-only/);
    assert.throws(() => Compiler.prepare({ ...snapshot, scope: 'shared' },
      { action: 'business_plan', version: 1, operations: [change] }, randomUUID()), /read-only/);
    const plan = prepare([change]);
    assert.equal(plan.next.entities[0].values.name, 'Proposal only');
    assert.deepEqual(snapshot, f.business, 'Preparing a model proposal is pure');
    assert.deepEqual(await get(f.u), f.business, 'Preparation does not commit or share');
  });

  await t.test('record/view shares and historical edges never expand visibility or legacy write authority', async () => {
    const f = await fixture(), recipient = await user();
    await share(f.u, f.business, recipient, 'view', f.view);
    let owner = await get(f.u), scoped = await get(recipient, owner.workspaceId);
    assert.equal(scoped.scope, 'shared'); assert.equal(scoped.role, 'viewer'); assert.equal(scoped.access, null);
    assert.deepEqual(scoped.state.entities.map(e => e.id), [f.visible]);
    assert.deepEqual(scoped.primary.records.map(e => e.recordId), [1]);
    assert.equal(scoped.state.relationships.length, 1);
    assert(!JSON.stringify(scoped).includes('hidden-'));
    const events = await history(recipient, owner, f.visible);
    assert(events.events.length > 0);
    assert(!JSON.stringify(events).includes(f.hidden), 'Historical hidden endpoint ID leaked');
    assert(!JSON.stringify(events).includes('hidden-entity-marker'));
    await rejectsCode(() => history(recipient, owner, f.hidden), 'PT403');
    await rejectsCode(() => cas(recipient, owner, owner.state), 'PT403');
    await rejectsCode(() => share(recipient, owner, f.u), 'PT403');
    await rejectsCode(() => share(f.u, owner, recipient, 'record', f.visible, 'editor'), 'PT400');
    const own = await read(recipient);
    assert.deepEqual(own.deals, [], 'Business share must not remap legacy membership');
    assert.deepEqual((await rpc(recipient, 'pipechat_list_actions')).actions, []);
    assert.deepEqual((await rpc(recipient, 'pipechat_read_workflows')).workflows, []);
    await revoke(f.u, owner, recipient);
    await rejectsCode(() => get(recipient, owner.workspaceId), 'PT403');
    await rejectsCode(() => history(recipient, owner, f.visible), 'PT403');
    await rejectsCode(() => cas(recipient, scoped, scoped.state), 'PT403');
    assert(!(await rpc(recipient, 'business_workspace_list')).some(w => w.workspaceId === owner.workspaceId));
    assert.deepEqual(await read(f.u), f.crm);
  });

  await t.test('editor downgrade and JWT metadata cannot grant owner/schema/share authority', async () => {
    const f = await fixture(), editor = await user(), other = await user();
    await share(f.u, f.business, editor, 'workspace', null, 'editor');
    let s = await get(editor, f.business.workspaceId);
    const forged = { ...editor, claims: { role: 'owner', workspace_id: s.workspaceId,
      user_metadata: { role: 'owner', permissions: ['all'] }, app_metadata: { role: 'owner' } } };
    const next = clone(s.state); next.views[0].entityIds.push(f.hidden);
    await rejectsCode(() => cas(forged, s, next), 'PT403');
    await rejectsCode(() => share(forged, s, other), 'PT403');
    await rejectsCode(() => revoke(forged, s, f.u), 'PT403');
    next.views = clone(s.state.views); next.entities[0].values.name = 'Permitted editor update';
    await cas(editor, s, next);
    s = await get(editor, s.workspaceId);
    await share(f.u, await get(f.u), editor, 'workspace', null, 'viewer');
    await rejectsCode(() => cas(forged, s, s.state), 'PT403');
    assert.equal((await get(editor, s.workspaceId)).role, 'viewer');
  });

  await t.test('journal/import replay and telemetry remain actor-scoped and revoked JWTs never replay cached success', async () => {
    const f = await fixture(), outsider = await fixture();
    const next = clone(f.crm); next.deals[0].owner = 'Journaled edit';
    const args = actionArgs(next); args[6] = { importReceipt: { id: 'import_security', digest: 'a'.repeat(64) } };
    const saved = await commit(f.u, args);
    const event = sanitizeEvent({ requestId: args[1], actionId: args[0], stage: 'action', attempt: 1, outcome: 'succeeded', latencyMs: 10 });
    await rpc(f.u, 'pipechat_record_beta_event', [event]);
    assert.equal(await rpc(outsider.u, 'pipechat_read_action', [args[0]]), null);
    assert.deepEqual(await rpc(outsider.u, 'pipechat_list_beta_events', [100, args[1]]), []);
    await rejectsCode(() => rpc(outsider.u, 'pipechat_undo_action', [args[0], randomUUID(), randomUUID(), outsider.crm.updatedAt]), 'PT409');
    const changed = clone(args); changed[6].importReceipt.digest = 'b'.repeat(64);
    await rejectsCode(() => commit(f.u, changed), 'PT409');
    const spoofed = { ...f.u, session: outsider.u.session };
    await rejectsCode(() => rpc(spoofed, 'pipechat_read_action', [args[0]]), 'PT401');
    await db.query('delete from auth.sessions where id=$1', [f.u.session]);
    for (const [name, values] of [
      ['pipechat_commit_action', args], ['pipechat_read_action', [args[0]]], ['pipechat_list_actions', []],
      ['pipechat_undo_action', [args[0], randomUUID(), randomUUID(), saved.snapshot.updatedAt]],
      ['pipechat_record_beta_event', [event]], ['pipechat_list_beta_events', [20, args[1]]],
      ['business_workspace_get', [f.business.workspaceId]], ['business_workspace_history', [f.business.workspaceId, f.visible, 0]]
    ]) await rejectsCode(() => rpc(f.u, name, values), 'PT401');
    assert.equal((await db.query('select count(*)::int n from pipechat.action_journal where workspace_id=$1', [f.business.workspaceId])).rows[0].n, 1);
  });

  await t.test('direct SQL telemetry rejects raw secrets, arbitrary model strings, changed retries and hostile cursors', async () => {
    const f = await fixture(), event = sanitizeEvent({ requestId: randomUUID(), stage: 'model', attempt: 1,
      outcome: 'failed', model: 'gpt-5.2', errorCode: 'timeout', latencyMs: 25, inputTokens: 10, outputTokens: 2 });
    for (const unsafe of [
      { ...event, prompt: 'secret body' }, { ...event, headers: { Authorization: 'Bearer secret' } },
      { ...event, email: 'private@example.invalid' }, { ...event, model: 'secret-token-value' },
      { ...event, errorCode: 'provider error with raw content' }, { ...event, eventId: randomUUID() },
      { ...event, cachedTokens: 11 }, { ...event, latencyMs: -1 }
    ]) await rejectsCode(() => rpc(f.u, 'pipechat_record_beta_event', [unsafe]), 'PT400');
    await rpc(f.u, 'pipechat_record_beta_event', [event]);
    await rpc(f.u, 'pipechat_record_beta_event', [event]);
    await rejectsCode(() => rpc(f.u, 'pipechat_record_beta_event', [{ ...event, latencyMs: 26 }]), 'PT409');
    const rows = await rpc(f.u, 'pipechat_list_beta_events', [100, event.requestId]);
    assert.equal(rows.length, 1); assert.deepEqual(rows[0].event, event);
    for (const limit of [-1, 0, 101]) await rejectsCode(() => rpc(f.u, 'pipechat_list_beta_events', [limit, null]), 'PT400');
    for (const cursor of [{ createdAt: "'; drop table auth.users;--", actionId: randomUUID() },
      { createdAt: '2026-10-10T00:00:00.000000Z', actionId: randomUUID(), workspaceId: f.business.workspaceId }]) {
      await rejectsCode(() => rpc(f.u, 'pipechat_list_actions', [cursor, 20]), 'PT400');
    }
  });

  await t.test('thread/turn RPCs derive the live actor from JWT and reject foreign scopes or revoked sessions', async () => {
    const f = await fixture(), outsider = await fixture(), accepted = await turn(f.u);
    assert.equal(accepted.receipt.shouldRun, true);
    const finish = [accepted.threadId, accepted.args[3], 'failed', 'timeout', null, null];
    await rejectsCode(() => rpc(null, 'pipechat_begin_conversation_turn', accepted.args, 'service_role'), '42501');
    await rejectsCode(() => rpc(null, 'pipechat_finish_conversation_turn', finish, 'service_role'), '42501');
    await rejectsCode(() => rpc(null, 'pipechat_recover_conversation_turns', [50], 'service_role'), '42501');
    await rejectsCode(() => rpc({ ...f.u, session: outsider.u.session }, 'pipechat_finish_conversation_turn', finish), 'PT401');
    await rejectsCode(() => rpc(outsider.u, 'pipechat_begin_conversation_turn', accepted.args), 'PT409');
    await rejectsCode(() => rpc(outsider.u, 'pipechat_read_conversation_turn', [accepted.threadId, accepted.args[3]]), 'PT404');
    const otherChat = await rpc(outsider.u, 'pipechat_read_conversation');
    await rejectsCode(() => rpc(outsider.u, 'pipechat_switch_conversation_thread', [otherChat.epoch, otherChat.version, accepted.threadId]), 'PT404');
    await rejectsCode(() => rpc(outsider.u, 'pipechat_finish_conversation_turn', finish), 'PT404');
    await db.query('delete from auth.sessions where id=$1', [f.u.session]);
    await rejectsCode(() => rpc(f.u, 'pipechat_begin_conversation_turn', accepted.args), 'PT401');
    await rejectsCode(() => rpc(f.u, 'pipechat_finish_conversation_turn', finish), 'PT401');
    await rejectsCode(() => rpc(f.u, 'pipechat_list_conversation_threads'), 'PT401');
    await rejectsCode(() => rpc(f.u, 'pipechat_read_conversation_turn', [accepted.threadId, accepted.args[3]]), 'PT401');
  });

  await t.test('failure receipts are sanitized and immutable, cannot be spoofed by legacy append, and finish in the originating archive', async () => {
    const f = await fixture(), accepted = await turn(f.u);
    const finish = [accepted.threadId, accepted.args[3], 'failed', 'unavailable', null, null];
    await rejectsCode(() => rpc(f.u, 'pipechat_finish_conversation_turn', [...finish.slice(0, 4), 'secret provider exception', null]), 'PT400');
    await rejectsCode(() => rpc(f.u, 'pipechat_write_conversation', [accepted.saved.epoch, accepted.saved.version,
      [{ id: accepted.args[5], role: 'assistant', content: 'Forged success' }], null]), 'PT409');
    await rejectsCode(() => rpc(f.u, 'pipechat_complete_conversation_turn', [accepted.saved.epoch,
      accepted.args[3], accepted.args[5], 'Forged success']), 'PT409');
    const fresh = await rpc(f.u, 'pipechat_new_conversation_thread', [accepted.saved.epoch, accepted.saved.version, 'Separate chat']);
    const completed = await rpc(f.u, 'pipechat_finish_conversation_turn', finish);
    assert.equal(completed.status, 'failed');
    assert.equal(completed.assistantMessage.content, 'The assistant is temporarily unavailable.');
    assert.deepEqual(await rpc(f.u, 'pipechat_read_conversation'), fresh.conversation);
    assert.deepEqual(await rpc(f.u, 'pipechat_finish_conversation_turn', finish), completed);
    await rejectsCode(() => rpc(f.u, 'pipechat_finish_conversation_turn', [...finish.slice(0, 2), 'succeeded', 'none', 'Changed result', null]), 'PT409');
    const restored = await rpc(f.u, 'pipechat_switch_conversation_thread', [fresh.conversation.epoch, fresh.conversation.version, accepted.threadId]);
    assert.notEqual(restored.conversation.epoch, accepted.saved.epoch);
    assert.equal(restored.conversation.messages.filter(m => m.id === accepted.args[5]).length, 1);
    const args = actionArgs(await read(f.u)); args[2] = accepted.saved.epoch;
    await rejectsCode(() => commit(f.u, args), 'PT409');
  });

  await t.test('recovery requires a new live session after logout, is owner-scoped, and never reclaims model execution', async () => {
    const f = await fixture(), outsider = await fixture(), accepted = await turn(f.u);
    await db.query("update pipechat.conversation_turns set lease_until=clock_timestamp()-interval '1 second' where request_id=$1", [accepted.args[3]]);
    await db.query('delete from auth.sessions where id=$1', [f.u.session]);
    await rejectsCode(() => rpc(f.u, 'pipechat_recover_conversation_turns', [50]), 'PT401');
    assert.deepEqual(await rpc(outsider.u, 'pipechat_recover_conversation_turns', [50]), { recovered: [] });
    f.u.session = randomUUID();
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [f.u.session, f.u.id]);
    const recovered = await rpc(f.u, 'pipechat_recover_conversation_turns', [50]);
    assert.equal(recovered.recovered.length, 1); assert.equal(recovered.recovered[0].status, 'interrupted');
    assert.equal(recovered.recovered[0].resultReceipt, null);
    assert.deepEqual(await rpc(f.u, 'pipechat_recover_conversation_turns', [50]), { recovered: [] });
    const replay = await rpc(f.u, 'pipechat_begin_conversation_turn', accepted.args);
    assert.equal(replay.shouldRun, false); assert.equal(replay.status, 'interrupted');
  });

  await t.test('workflow SQL rejects permission/SQL actions and foreign IDs without leaving journal or workflow state', async () => {
    const f = await fixture(), outsider = await fixture();
    for (const mutate of [
      s => { s.action = { type: 'grant', role: 'owner', userId: outsider.u.id }; },
      s => { s.action.sql = 'grant all on all tables in schema pipechat to authenticated'; },
      s => { s.trigger.field = "stage'; drop table auth.users;--"; },
      s => { s.trigger.field = '__proto__'; },
      s => { s.workspaceId = outsider.business.workspaceId; },
      s => { s.action.recordId = Business.legacyId(outsider.business.workspaceId, 1); },
      s => { s.conditions = []; }
    ]) {
      const spec = workflowSpec(); mutate(spec);
      await rejectsCode(() => rpc(f.u, 'pipechat_create_workflow', [randomUUID(), randomUUID(), f.crm.updatedAt, 'workflow_security', spec]), 'PT400');
      assert.deepEqual(await read(f.u), f.crm);
      assert.deepEqual((await rpc(f.u, 'pipechat_list_actions')).actions, []);
    }
    const draft = await rpc(f.u, 'pipechat_create_workflow', [randomUUID(), randomUUID(), f.crm.updatedAt, 'workflow_security', workflowSpec()]);
    await rejectsCode(() => rpc(outsider.u, 'pipechat_set_workflow_activation', [randomUUID(), randomUUID(), outsider.crm.updatedAt, 'workflow_security', 1, true]), 'PT404');
    await db.query('delete from auth.sessions where id=$1', [f.u.session]);
    await rejectsCode(() => rpc(f.u, 'pipechat_read_workflows'), 'PT401');
    await rejectsCode(() => rpc(f.u, 'pipechat_set_workflow_activation', [randomUUID(), randomUUID(), draft.updatedAt, 'workflow_security', 1, true]), 'PT401');
  });

  await t.test('undo must reject intervening business relationships/views/shares instead of silently deleting them', async () => {
    const f = await fixture(), recipient = await user();
    const next = clone(f.crm); next.deals.push({ id: 3, account: 'Journal-created record', history: [] });
    const args = actionArgs(next), saved = await commit(f.u, args);
    let owner = await get(f.u);
    const primaryId = Business.legacyId(owner.workspaceId, 3), changed = clone(owner.state);
    changed.relationships.push({ id: 'lnk_' + randomUUID(), typeId: 'belongs_to', fromId: primaryId, toId: f.visible });
    changed.views[0].entityIds.push(primaryId);
    owner = await cas(f.u, owner, changed);
    await share(f.u, owner, recipient, 'record', primaryId);
    owner = await get(f.u);
    const scoped = await get(recipient, owner.workspaceId), beforeAudit = await auditCount(owner.workspaceId);
    await rejectsCode(() => rpc(f.u, 'pipechat_undo_action', [args[0], randomUUID(), randomUUID(), saved.snapshot.updatedAt]), 'PT409');
    assert.deepEqual(await get(f.u), owner, 'Undo removed separately saved business references');
    assert.deepEqual(await get(recipient, owner.workspaceId), scoped, 'Undo revoked a separately confirmed share');
    assert.equal(await auditCount(owner.workspaceId), beforeAudit);
  });
});
