'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { legacySchema } = require('../public/table-schema');
const Business = require('../public/business-workspace');

const clone = value => structuredClone(value);
const body = s => ({ deals: s.deals, customFields: s.customFields, tableSchema: s.tableSchema, todoCards: s.todoCards });
const conflict = fn => assert.rejects(fn, error => { assert.equal(error.code, 'PT409', error.message); return true; });

async function harness(t, includeBusiness = true) {
  const db = new PGlite(); t.after(() => db.close());
  const run = async file => db.exec(await fs.readFile(path.join(__dirname, '../db', file), 'utf8'));
  await run('tests/mock-supabase.sql');
  await db.exec('alter table auth.users add column email text');
  for (const file of (await fs.readdir(path.join(__dirname, '../db/migrations')))
    .filter(file => /^(00[1-9]|01[0-6])-.*\.sql$/.test(file) && (includeBusiness || !file.startsWith('013-'))).sort()) {
    await run('migrations/' + file);
  }
  await run('tests/security.sql');
  async function user() {
    const u = { id: randomUUID(), session: randomUUID(), email: randomUUID() + '@example.invalid' };
    await db.query('insert into auth.users(id,email) values($1,$2)', [u.id, u.email]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [u.session, u.id]);
    return u;
  }
  async function rpc(u, name, args = []) {
    assert(/^(pipechat_|business_workspace_)[a-z0-9_]+$/.test(name));
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: u.id, session_id: u.session, role: 'authenticated' })]);
    await db.exec('set role authenticated');
    try { return (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`,
      args.map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].result; }
    finally { await db.exec('reset role'); }
  }
  const read = u => rpc(u, 'pipechat_read_workspace');
  const get = (u, wid = null) => rpc(u, 'business_workspace_get', [wid]);
  const cas = (u, s, state) => rpc(u, 'business_workspace_cas', [s.workspaceId, s.version, state, s.primary.updatedAt]);
  const commit = (u, s) => rpc(u, 'pipechat_commit_action', [randomUUID(), randomUUID(), null, null, s.updatedAt, body(s), {}]);
  const share = (u, s, target, scope, resource, role = 'viewer') => rpc(u, 'business_workspace_share',
    [s.workspaceId, target.email, scope, resource, role, s.version]);
  async function fixture() {
    const u = await user(), blank = await read(u);
    let crm = await rpc(u, 'pipechat_write_workspace_v2', [[], [], legacySchema(), blank.updatedAt, []]);
    crm = await rpc(u, 'pipechat_write_workspace_v2', [[{ id: 1, account: 'Retained record', history: [] }], [], crm.tableSchema, crm.updatedAt, []]);
    const next = clone(crm); next.deals.push({ id: 2, account: 'Action-created record', history: [] });
    const saved = await commit(u, next);
    if (!includeBusiness) return { u, saved };
    let business = await get(u);
    const state = Business.empty();
    state.relationshipTypes = [{ id: 'related', name: 'Related', fromType: 'primary', toType: 'primary', cardinality: 'many_to_many' }];
    business = await cas(u, business, state);
    return { u, saved, business, primary: Business.legacyId(business.workspaceId, 2), retained: Business.legacyId(business.workspaceId, 1) };
  }
  async function effects(wid) {
    const rows = {};
    for (const table of ['business_workspaces', 'business_grants', 'business_memberships', 'business_audit', 'action_journal', 'beta_event_ledger']) {
      rows[table] = (await db.query(`select coalesce(jsonb_agg(x order by x::text),'[]') rows
        from (select to_jsonb(t) x from pipechat.${table} t where workspace_id=$1) s`, [wid])).rows[0].rows;
    }
    return rows;
  }
  return { db, run, user, rpc, read, get, cas, commit, share, fixture, effects };
}

test('business dependencies fence journal undo without reverting unrelated graph changes', { timeout: 120000 }, async t => {
  const h = await harness(t);
  const { db, rpc, read, get, cas, share, user, fixture, effects } = h;
  for (const dependency of ['outgoing link', 'incoming link', 'unshared view', 'shared view', 'direct record share', 'editor link']) {
    await t.test(dependency + ' alone rejects before any canonical, audit, permission, journal or event change', async () => {
      const f = await fixture(), recipient = await user(), state = clone(f.business.state);
      if (dependency.includes('link')) state.relationships.push({ id: 'lnk_' + randomUUID(), typeId: 'related',
        fromId: dependency === 'incoming link' ? f.retained : f.primary,
        toId: dependency === 'incoming link' ? f.primary : f.retained });
      const view = { id: 'view_' + randomUUID(), name: 'Saved reference', entityIds: [f.primary] };
      if (dependency.includes('view')) state.views.push(view);
      if (dependency === 'editor link') {
        await share(f.u, f.business, recipient, 'workspace', null, 'editor');
        const editor = await get(recipient, f.business.workspaceId);
        await cas(recipient, editor, state);
      } else if (dependency !== 'direct record share') await cas(f.u, f.business, state);
      let current = await get(f.u);
      if (dependency === 'direct record share') await share(f.u, current, recipient, 'record', f.primary);
      if (dependency === 'shared view') await share(f.u, current, recipient, 'view', view.id);
      current = await get(f.u);
      const before = await effects(current.workspaceId), crm = await read(f.u);
      const undo = [f.saved.receipt.actionId, randomUUID(), randomUUID(), crm.updatedAt];
      await conflict(() => rpc(f.u, 'pipechat_undo_action', undo));
      assert.deepEqual(await read(f.u), crm);
      assert.deepEqual(await get(f.u), current);
      assert.deepEqual(await effects(current.workspaceId), before);
      assert.equal(await rpc(f.u, 'pipechat_read_action', [undo[1]]), null);
      assert.deepEqual(await rpc(f.u, 'pipechat_list_beta_events', [20, undo[2]]), []);
    });
  }

  await t.test('unrelated graph version changes, grants and another workspace using the same record number do not block', async () => {
    const f = await fixture(), other = await fixture(), recipient = await user();
    const state = clone(f.business.state);
    state.relationships.push({ id: 'lnk_' + randomUUID(), typeId: 'related', fromId: f.retained, toId: f.retained });
    state.views.push({ id: 'view_' + randomUUID(), name: 'Retained only', entityIds: [f.retained] });
    let business = await cas(f.u, f.business, state);
    await share(f.u, business, recipient, 'record', f.retained);
    const otherState = clone(other.business.state);
    otherState.views.push({ id: 'view_' + randomUUID(), name: 'Other workspace record 2', entityIds: [other.primary] });
    await cas(other.u, other.business, otherState);
    await share(other.u, await get(other.u), recipient, 'record', other.primary);
    business = await get(f.u);
    const before = await effects(business.workspaceId), foreign = await effects(other.business.workspaceId);
    const undoArgs = [f.saved.receipt.actionId, randomUUID(), randomUUID(), (await read(f.u)).updatedAt];
    const result = await rpc(f.u, 'pipechat_undo_action', undoArgs);
    assert.deepEqual(result.snapshot.deals.map(r => r.id), [1]);
    const after = await effects(business.workspaceId);
    for (const table of ['business_workspaces', 'business_grants', 'business_memberships', 'business_audit']) assert.deepEqual(after[table], before[table]);
    assert.deepEqual(await effects(other.business.workspaceId), foreign);
    assert.equal((await rpc(f.u, 'pipechat_undo_action', undoArgs)).replayed, true);
    assert.deepEqual(await effects(business.workspaceId), after);
  });

  await t.test('field-only inverse on a referenced record preserves all later links/views/grants', async () => {
    const f = await fixture(), recipient = await user(), next = clone(f.saved.snapshot);
    next.deals[1].owner = 'Edited owner'; const action = await h.commit(f.u, next);
    const business = await get(f.u), state = clone(business.state);
    state.relationships.push({ id: 'lnk_' + randomUUID(), typeId: 'related', fromId: f.primary, toId: f.retained });
    state.views.push({ id: 'view_' + randomUUID(), name: 'Keep view', entityIds: [f.primary] });
    await cas(f.u, business, state);
    await share(f.u, await get(f.u), recipient, 'record', f.primary);
    const before = await effects(business.workspaceId);
    const result = await rpc(f.u, 'pipechat_undo_action', [action.receipt.actionId, randomUUID(), randomUUID(), action.snapshot.updatedAt]);
    assert.equal(result.snapshot.deals[1].owner, f.saved.snapshot.deals[1].owner);
    const after = await effects(business.workspaceId);
    for (const table of ['business_workspaces', 'business_grants', 'business_memberships', 'business_audit']) assert.deepEqual(after[table], before[table]);
  });

  await t.test('explicit reference removal lets the same previously rejected undo identity succeed once', async () => {
    const f = await fixture(), recipient = await user();
    await share(f.u, f.business, recipient, 'record', f.primary);
    const undoArgs = [f.saved.receipt.actionId, randomUUID(), randomUUID(), f.saved.snapshot.updatedAt];
    await conflict(() => rpc(f.u, 'pipechat_undo_action', undoArgs));
    const business = await get(f.u);
    await rpc(f.u, 'business_workspace_revoke', [business.workspaceId, recipient.email, 'record', f.primary, business.version]);
    const result = await rpc(f.u, 'pipechat_undo_action', undoArgs);
    assert.equal(result.replayed, false); assert.deepEqual(result.snapshot.deals.map(r => r.id), [1]);
    assert.equal((await rpc(f.u, 'pipechat_list_beta_events', [20, undoArgs[2]])).length, 1);
  });

  await t.test('private dependency helper is not a new authorization surface', async () => {
    const row = (await db.query(`select p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'execute') anon,
      has_function_privilege('authenticated',p.oid,'execute') authenticated,
      has_function_privilege('service_role',p.oid,'execute') service
      from pg_proc p where p.oid='pipechat.journal_assert_business_dependencies(uuid,jsonb,jsonb)'::regprocedure`)).rows[0];
    assert.deepEqual(row, { prosecdef: false, proconfig: ['search_path=pg_catalog'], anon: false, authenticated: false, service: false });
    await h.run('tests/security.sql');
  });
});

test('journal inverse remains usable without optional business migration 013', { timeout: 120000 }, async t => {
  const h = await harness(t, false), f = await h.fixture();
  const result = await h.rpc(f.u, 'pipechat_undo_action', [f.saved.receipt.actionId, randomUUID(), randomUUID(), f.saved.snapshot.updatedAt]);
  assert.deepEqual(result.snapshot.deals.map(r => r.id), [1]);
  await h.run('tests/security.sql');
});
