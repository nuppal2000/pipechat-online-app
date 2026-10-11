'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const B = require('../public/business-workspace.js');

test('business workspace SQL: migration, tenancy, roles, scopes, CAS and rollback', { timeout: 120000 }, async t => {
  const db = new PGlite(); t.after(() => db.close());
  const run = async name => db.exec(await fs.readFile(path.join(__dirname, '../db', name), 'utf8'));
  await run('tests/mock-supabase.sql');
  await db.exec('alter table auth.users add column email text');
  const files = (await fs.readdir(path.join(__dirname, '../db/migrations'))).filter(file => /^\d{3}-.*\.sql$/.test(file)).sort();
  for (const file of files.filter(file => file < '013')) await run('migrations/' + file);
  async function user() {
    const u = { id: randomUUID(), session_id: randomUUID(), email: randomUUID() + '@example.test' };
    await db.query('insert into auth.users(id,email) values ($1,$2)', [u.id, u.email]);
    await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [u.session_id, u.id]);
    return u;
  }
  async function rpc(u, name, args = []) {
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: u.id, session_id: u.session_id, role: 'authenticated', ...u.claims })]);
    await db.exec('set role authenticated');
    try { return (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`, args)).rows[0].result; }
    finally { await db.exec('reset role'); }
  }
  const legacyRead = u => rpc(u, 'pipechat_read_workspace');
  const legacyWrite = (u, s) => rpc(u, 'pipechat_write_workspace_v2', [JSON.stringify(s.deals), JSON.stringify(s.customFields), JSON.stringify(s.tableSchema), s.updatedAt, JSON.stringify(s.todoCards)]);
  const get = (u, wid = null) => rpc(u, 'business_workspace_get', [wid]);
  const cas = (u, snapshot, state) => rpc(u, 'business_workspace_cas', [snapshot.workspaceId, snapshot.version, JSON.stringify(state), snapshot.primary.updatedAt]);
  const share = (u, s, target, scope = 'workspace', resource = null, role = 'viewer') => rpc(u, 'business_workspace_share', [s.workspaceId, target.email.toUpperCase(), scope, resource, role, s.version]);
  const revoke = (u, s, target, scope = 'workspace', resource = null) => rpc(u, 'business_workspace_revoke', [s.workspaceId, target.email, scope, resource, s.version]);
  const history = (u, id, after = '0', wid = owner.workspaceId) => rpc(u, 'business_workspace_history', [wid, id, after]);
  const denied = task => assert.rejects(task, error => error.code === 'PT403');
  const invalid = task => assert.rejects(task, error => error.code === 'PT400');
  const stale = task => assert.rejects(task, error => error.code === 'PT409');
  const a = await user(), b = await user();
  const schema = { status: 'ready', useCase: 'Other', title: 'Records', recordLabel: 'Record', description: '',
    fields: [{ id: 'f_name', name: 'Name', type: 'text', role: 'primary', options: [] }] };
  async function seedLegacy(u, name) {
    let s = await legacyWrite(u, { ...await legacyRead(u), tableSchema: schema, deals: [], todoCards: [] });
    return legacyWrite(u, { ...s, deals: [1, 2].map(id => ({ id, f_name: name + id, history: [], activity: '', health: '' })) });
  }
  const aLegacy = await seedLegacy(a, 'A-'), bLegacy = await seedLegacy(b, 'B-');
  const membershipBefore = (await db.query('select * from pipechat.memberships order by user_id')).rows;
  await run('migrations/013-business-workspaces.sql');
  let owner = await get(a), other = await get(b);
  const viewer = await user(), editor = await user(), scoped = await user(), byView = await user();
  const entityA = 'ent_' + randomUUID(), entityB = 'ent_' + randomUUID(), viewId = 'view_' + randomUUID();
  const def = { id: 'organization', name: 'Organization', fields: [
    { id: 'name', name: 'Name', type: 'text', required: true, options: [] },
    { id: 'amount', name: 'Amount', type: 'number', required: false, options: [] },
    { id: 'active', name: 'Active', type: 'boolean', required: false, options: [] },
    { id: 'day', name: 'Day', type: 'date', required: false, options: [] },
    { id: 'phase', name: 'Phase', type: 'choice', required: false, options: ['Open', 'Closed'] }
  ] };
  const staged = B.prepare(owner, [...B.compileSchemaProposal({ version: 1, entityTypes: [def], relationshipTypes: [
    { id: 'belongs_to', name: 'Belongs to', fromType: 'primary', toType: def.id, cardinality: 'many_to_one' }
  ] }),
  { op: 'create_entity', entity: { id: entityA, typeId: def.id, values: { name: 'Visible', amount: 25, active: false, day: '2026-10-10', phase: 'Open' } } },
  { op: 'create_entity', entity: { id: entityB, typeId: def.id, values: { name: 'Hidden' } } },
  { op: 'link', relationship: { id: 'lnk_' + randomUUID(), typeId: 'belongs_to', fromId: B.legacyId(owner.workspaceId, 1), toId: entityA } },
  { op: 'put_view', view: { id: viewId, name: 'Explicit set', entityIds: [entityA, B.legacyId(owner.workspaceId, 1)] } }
  ]);

  await t.test('additive initialization preserves existing primary data and owner isolation', async () => {
    assert.equal(owner.role, 'owner'); assert.equal(other.role, 'owner'); assert.notEqual(owner.workspaceId, other.workspaceId);
    assert.deepEqual(await legacyRead(a), aLegacy); assert.deepEqual(await legacyRead(b), bLegacy);
    assert.deepEqual((await db.query('select * from pipechat.memberships where user_id=any($1::uuid[]) order by user_id', [[a.id, b.id]])).rows, membershipBefore);
    assert.deepEqual(owner.state, B.empty()); assert.equal(owner.primary.records.length, 2);
    assert.equal(owner.primary.records[0].entityId, B.legacyId(owner.workspaceId, 1));
    await denied(() => get(b, owner.workspaceId)); await denied(() => cas(b, owner, staged.next));
    owner = await cas(a, owner, staged.next);
    assert.deepEqual(owner.state, staged.next); assert.deepEqual(await legacyRead(a), aLegacy);
    const events = (await history(a, entityA)).events;
    assert.deepEqual(events.map(e => e.kind), ['create', 'link']);
    assert.ok(events.every(e => e.actorId === a.id && e.version === owner.version && Number.isFinite(Date.parse(e.at))));
    assert.equal(events[0].before, null); assert.deepEqual(events[0].after, owner.state.entities[0]);
    assert.deepEqual(events[1].relationship, owner.state.relationships[0]);
    assert.equal((await history(a, B.legacyId(owner.workspaceId, 1))).events.length, 1);
    await denied(() => history(b, entityA));
  });

  await t.test('SQL revalidates payloads: typed fields, graph, authority injection and schema transition', async () => {
    for (const change of [
      s => { s.ownerId = b.id; },
      s => { s.audit = [{ kind: 'update', actorId: b.id }]; },
      s => { s.entities[0].values.amount = '25'; },
      s => { s.entities[0].values.active = 'false'; },
      s => { s.entities[0].values.day = '2026-02-30'; },
      s => { s.entities[0].values.phase = 'Unlisted'; },
      s => { s.entities[0].values.extra = 'Hidden payload'; },
      s => { s.entities[0].values.name = ''; },
      s => { s.relationships[0].fromId = B.legacyId(other.workspaceId, 1); },
      s => { s.relationships[0].toId = B.legacyId(owner.workspaceId, 2); },
      s => { s.relationships.push({ ...s.relationships[0], id: 'lnk_' + randomUUID(), toId: entityB }); },
      s => { s.views[0].entityIds.push(B.legacyId(owner.workspaceId, 999)); },
      s => { s.entityTypes[0].fields[1].type = 'text'; s.entities[0].values.amount = '25'; },
      s => { s.relationshipTypes[0].cardinality = 'many_to_many'; },
      s => { s.entities.push(s.entities[0]); }
    ]) {
      const bad = structuredClone(owner.state); change(bad);
      await invalid(() => cas(a, owner, bad)); assert.deepEqual(await get(a), owner);
    }
  });

  await t.test('workspace viewers cannot write/share; editors cannot grant, alter schema, or claim owner', async () => {
    await share(a, owner, viewer); owner = await get(a);
    await share(a, owner, editor, 'workspace', null, 'editor'); owner = await get(a);
    const v = await get(viewer, owner.workspaceId), e = await get(editor, owner.workspaceId);
    assert.equal(v.role, 'viewer'); assert.equal(e.role, 'editor'); assert.deepEqual(v.state, owner.state);
    assert.equal(v.access, null); assert.equal(e.access, null); assert.equal(owner.access.memberships.length, 2);
    await denied(() => cas(viewer, v, v.state)); await denied(() => share(viewer, v, b));
    await denied(() => share(editor, e, b)); await denied(() => revoke(editor, e, viewer));
    const schemaChange = structuredClone(e.state); schemaChange.entityTypes[0].name = 'Changed';
    await denied(() => cas(editor, e, schemaChange));
    const viewChange = structuredClone(e.state); viewChange.views[0].entityIds.push(entityB);
    await denied(() => cas(editor, e, viewChange));
    const next = B.prepare(e, [{ op: 'update_entity', id: entityA, values: { amount: 55 } }]).next;
    const saved = await cas(editor, e, next); assert.equal(saved.role, 'editor'); owner = await get(a);
    const edited = (await history(viewer, entityA)).events.at(-1);
    assert.equal(edited.kind, 'update'); assert.equal(edited.actorId, editor.id);
    assert.equal(edited.before.values.amount, 25); assert.equal(edited.after.values.amount, 55);
    const forged = { ...b, claims: { role: 'owner', ownerId: a.id, userId: a.id } };
    await denied(() => get(forged, owner.workspaceId));
    assert.equal((await legacyRead(viewer)).deals.length, 0);
    assert.equal((await legacyRead(editor)).deals.length, 0);
    await seedLegacy(editor, 'Editor-own-');
    assert.deepEqual(await legacyRead(a), aLegacy);
  });

  await t.test('record and view shares expose only scoped data, without graph traversal or legacy route authorization', async () => {
    const receipt = await share(a, owner, scoped, 'record', entityA); assert.equal(receipt.emailSent, false); owner = await get(a);
    await share(a, owner, byView, 'view', viewId); owner = await get(a);
    const s = await get(scoped, owner.workspaceId), v = await get(byView, owner.workspaceId);
    assert.equal(s.scope, 'shared'); assert.equal(s.role, 'viewer');
    assert.equal(s.access, null); assert.equal(v.access, null); assert.equal(owner.access.grants.length, 2);
    assert.deepEqual(s.state.entities.map(e => e.id), [entityA]); assert.equal(s.state.relationships.length, 0);
    assert.equal(s.state.views.length, 0); assert.equal(s.primary.records.length, 0); assert.equal(s.primary.tableSchema, null);
    assert.deepEqual(v.state.entities.map(e => e.id), [entityA]); assert.equal(v.state.relationships.length, 1);
    assert.deepEqual(v.primary.records.map(r => r.recordId), [1]); assert.equal(v.state.views.length, 1);
    assert.equal(JSON.stringify(v).includes('Hidden'), false); assert.equal(JSON.stringify(v).includes('A-2'), false);
    await denied(() => cas(scoped, s, owner.state)); await denied(() => share(byView, v, b));
    await invalid(() => share(a, owner, b, 'record', entityA, 'editor'));
    await invalid(() => share(a, owner, b, 'record', B.legacyId(other.workspaceId, 1)));
    await invalid(() => share(a, owner, { email: 'missing@example.test' }));
    assert.equal((await legacyRead(byView)).deals.length, 0);
    const listed = await rpc(byView, 'business_workspace_list'); assert.equal(listed.find(w => w.workspaceId === owner.workspaceId).scope, 'shared');
    assert.equal(listed.find(w => w.workspaceId === owner.workspaceId).title, 'Records');
    assert.equal(JSON.stringify(listed).includes(a.email), false);
    assert.deepEqual(Object.keys(listed.find(w => w.workspaceId === owner.workspaceId)).sort(), ['role', 'scope', 'title', 'workspaceId']);
    assert.deepEqual((await history(scoped, entityA)).events.map(e => e.kind), ['create', 'update']);
    const visibleHistory = (await history(byView, entityA)).events;
    assert.deepEqual(visibleHistory.map(e => e.kind), ['create', 'link', 'update']);
    await denied(() => history(scoped, entityB));
    await denied(() => history(scoped, B.legacyId(owner.workspaceId, 1)));
    assert.equal(JSON.stringify(await history(scoped, entityA)).includes(B.legacyId(owner.workspaceId, 1)), false);
    const additive = await share(a, owner, viewer, 'record', entityA); owner = await get(a);
    assert.equal(additive.effectiveScope, 'workspace'); assert.equal(additive.effectiveRole, 'viewer');
  });

  await t.test('SQL cardinality checks independently cover every direction and duplicate edge', async () => {
    const fresh = await user(); let s = await get(fresh);
    for (const cardinality of B.cardinalities) {
      const t1 = 'ent_' + randomUUID(), t2 = 'ent_' + randomUUID(), t3 = 'ent_' + randomUUID();
      const typeId = 'relation_' + cardinality;
      const next = structuredClone(s.state);
      if (!next.entityTypes.length) next.entityTypes.push({ id: 'node', name: 'Node', fields: [] });
      next.entities.push(...[t1, t2, t3].map(id => ({ id, typeId: 'node', values: {} })));
      next.relationshipTypes.push({ id: typeId, name: cardinality, fromType: 'node', toType: 'node', cardinality });
      const edge = { id: 'lnk_' + randomUUID(), typeId, fromId: t1, toId: t2 }; next.relationships.push(edge);
      s = await cas(fresh, s, next);
      for (const [fromId, toId, forbidden] of [[t1, t3, ['one_to_one', 'many_to_one'].includes(cardinality)],
        [t3, t2, ['one_to_one', 'one_to_many'].includes(cardinality)], [t1, t2, true]]) {
        const attempted = structuredClone(s.state); attempted.relationships.push({ id: 'lnk_' + randomUUID(), typeId, fromId, toId });
        if (forbidden) await invalid(() => cas(fresh, s, attempted));
        else { s = await cas(fresh, s, attempted); s = await cas(fresh, s, next); }
      }
    }
  });

  await t.test('a database failure after the state write rolls back state, version and grant cleanup', async () => {
    await db.exec(`create function public.test_fail_business_commit() returns trigger language plpgsql set search_path=pg_catalog as $$
      begin raise sqlstate 'PT400' using message='Injected after-write failure'; end $$;
      create trigger test_business_failure after update on pipechat.business_workspaces for each row execute function public.test_fail_business_commit();`);
    try {
      const proposed = B.prepare(owner, [{ op: 'delete_entity', id: entityA }]).next;
      await invalid(() => cas(a, owner, proposed)); assert.deepEqual(await get(a), owner);
      assert.equal((await get(scoped, owner.workspaceId)).state.entities[0].id, entityA);
    } finally {
      await db.exec('drop trigger test_business_failure on pipechat.business_workspaces; drop function public.test_fail_business_commit();');
    }
  });

  await t.test('CAS rejects stale state, stale legacy reads, and rolls back late validation errors', async () => {
    const beforeAudit = await history(a, entityA);
    const staleSnapshot = owner;
    owner = await cas(a, owner, owner.state); await stale(() => cas(a, staleSnapshot, staleSnapshot.state));
    const bad = structuredClone(owner.state); bad.entities[0].values.name = 'Should roll back'; bad.views[0].entityIds.push('ent_' + randomUUID());
    await invalid(() => cas(a, owner, bad)); assert.deepEqual(await get(a), owner);
    const currentLegacy = await legacyRead(a); currentLegacy.deals[0].f_name = 'Current primary';
    await legacyWrite(a, currentLegacy);
    await stale(() => cas(a, owner, owner.state)); owner = await get(a);
    assert.equal(owner.primary.records[0].values.f_name, 'Current primary');
    assert.equal(owner.state.entities.length, 2); assert.equal(owner.state.relationships.length, 1);
    const shared = await get(byView, owner.workspaceId); assert.equal(shared.primary.records[0].values.f_name, 'Current primary');
    assert.deepEqual(await legacyRead(b), bLegacy);
    assert.deepEqual(await history(a, entityA), beforeAudit);
  });

  await t.test('audit insertion failure rolls back CAS state, version, grants and every event', async () => {
    const before = await history(a, entityA);
    await db.exec(`create function public.test_fail_business_audit() returns trigger language plpgsql set search_path=pg_catalog as $$
      begin raise sqlstate 'PT400' using message='Injected audit failure'; end $$;
      create trigger test_business_audit_failure after insert on pipechat.business_audit for each row execute function public.test_fail_business_audit();`);
    try {
      await invalid(() => cas(a, owner, B.prepare(owner, [{ op: 'delete_entity', id: entityA }]).next));
      assert.deepEqual(await get(a), owner); assert.deepEqual(await history(a, entityA), before);
      assert.equal((await get(scoped, owner.workspaceId)).state.entities[0].id, entityA);
    } finally {
      await db.exec('drop trigger test_business_audit_failure on pipechat.business_audit; drop function public.test_fail_business_audit();');
    }
  });

  await t.test('chronological audit pagination has stable string cursors, persists deletes, and accepts no actor authority', async () => {
    const fresh = await user(); let s = await get(fresh);
    assert.equal((await rpc(fresh, 'business_workspace_list'))[0].title, 'Workspace');
    const id = 'ent_' + randomUUID();
    s = await cas(fresh, s, B.prepare(s, [
      { op: 'put_type', type: { id: 'item', name: 'Item', fields: [{ id: 'value', name: 'Value', type: 'number', required: false, options: [] }] } },
      { op: 'create_entity', entity: { id, typeId: 'item', values: { value: 0 } } }
    ]).next);
    const forged = { ...fresh, claims: { actorId: a.id, ownerId: a.id, role: 'owner' } };
    for (let value = 1; value <= 55; value++) s = await cas(forged, s, B.prepare(s, [{ op: 'update_entity', id, values: { value } }]).next);
    const first = await history(fresh, id, '0', s.workspaceId);
    assert.equal(first.events.length, 50); assert.equal(first.nextAfter, first.events.at(-1).id);
    const second = await history(fresh, id, first.nextAfter, s.workspaceId);
    assert.equal(second.events.length, 6); assert.equal(second.nextAfter, null);
    const all = [...first.events, ...second.events];
    assert.equal(new Set(all.map(e => e.id)).size, 56);
    assert.ok(all.every(e => typeof e.id === 'string' && e.actorId === fresh.id));
    assert.deepEqual(all.map(e => e.after.values.value), Array.from({ length: 56 }, (_, i) => i));
    assert.ok(all.every((e, i) => !i || BigInt(e.id) > BigInt(all[i - 1].id) && e.at >= all[i - 1].at));
    s = await cas(fresh, s, B.prepare(s, [{ op: 'delete_entity', id }]).next);
    const deleted = await history(fresh, id, second.events.at(-1).id, s.workspaceId);
    assert.deepEqual(deleted.events.map(e => e.kind), ['delete']);
    assert.equal(deleted.events[0].before.values.value, 55); assert.equal(deleted.events[0].after, null);
    await invalid(() => history(fresh, id, '-1', s.workspaceId));
    await denied(() => history(b, id, '0', s.workspaceId));
  });

  await t.test('downgrade/revoke is immediate and stale editor snapshots confer no authority', async () => {
    const e = await get(editor, owner.workspaceId);
    await share(a, owner, editor, 'workspace', null, 'viewer'); owner = await get(a);
    await denied(() => cas(editor, e, e.state));
    await revoke(a, owner, viewer); owner = await get(a); await denied(() => get(viewer, owner.workspaceId));
    assert.equal(owner.access.grants.some(grant => grant.userId === viewer.id), false);
    await revoke(a, owner, scoped, 'record', entityA); owner = await get(a); await denied(() => get(scoped, owner.workspaceId));
    await denied(() => history(scoped, entityA)); await denied(() => history(viewer, entityA));
    await revoke(a, owner, byView); owner = await get(a); await denied(() => get(byView, owner.workspaceId));
    assert.equal((await rpc(byView, 'business_workspace_list')).some(w => w.workspaceId === owner.workspaceId), false);
    await invalid(() => share(a, owner, a)); await invalid(() => revoke(a, owner, a));
  });

  await t.test('legacy deletion removes links/view membership and grants without copying or reviving shares', async () => {
    await share(a, owner, scoped, 'record', B.legacyId(owner.workspaceId, 1)); owner = await get(a);
    await share(a, owner, byView, 'view', viewId); owner = await get(a);
    const primary = await legacyRead(a), deletedRow = primary.deals[0];
    await legacyWrite(a, { ...primary, deals: primary.deals.slice(1) });
    const after = await get(a); assert.equal(after.version, owner.version + 1); owner = after;
    assert.equal(owner.state.relationships.length, 0); assert.deepEqual(owner.state.views[0].entityIds, [entityA]);
    await denied(() => get(scoped, owner.workspaceId));
    assert.equal((await get(byView, owner.workspaceId)).primary.records.length, 0);
    const pruned = (await history(a, entityA)).events.at(-1);
    assert.equal(pruned.kind, 'unlink'); assert.equal(pruned.actorId, a.id); assert.equal(pruned.version, owner.version);
    assert.equal(JSON.stringify(pruned).includes('Current primary'), false);
    assert.deepEqual((await history(byView, entityA)).events.map(e => e.kind), ['create', 'update']);
    const current = await legacyRead(a); await legacyWrite(a, { ...current, deals: [deletedRow, ...current.deals] });
    await denied(() => get(scoped, owner.workspaceId)); owner = await get(a);
    assert.equal(owner.state.relationships.length, 0); assert.equal(owner.primary.records.length, 2);
  });

  await t.test('typed entity deletion revokes record grants and cleans references atomically', async () => {
    await share(a, owner, scoped, 'record', entityA); owner = await get(a);
    const next = B.prepare(owner, [{ op: 'delete_entity', id: entityA }]).next;
    owner = await cas(a, owner, next); await denied(() => get(scoped, owner.workspaceId));
    assert.deepEqual(owner.state.views[0].entityIds, []);
    assert.equal((await history(a, entityA)).events.at(-1).kind, 'delete');
    assert.equal((await history(editor, entityA)).events.at(-1).kind, 'delete');
    await denied(() => history(scoped, entityA)); await denied(() => history(byView, entityA));
  });

  await t.test('entity merge commits through existing CAS with atomic audit, fresh edges and no transferred grants', async () => {
    const u = await user(); await seedLegacy(u, 'Merge-'); let s = await get(u);
    const survivor = 'ent_' + randomUUID(), source = 'ent_' + randomUUID(), sourceView = 'view_' + randomUUID();
    const originalLink = 'lnk_' + randomUUID();
    s = await cas(u, s, B.prepare(s, [
      { op: 'put_type', type: def },
      { op: 'put_relationship_type', type: { id: 'uses', name: 'Uses', fromType: 'primary', toType: def.id, cardinality: 'many_to_one' } },
      { op: 'create_entity', entity: { id: survivor, typeId: def.id, values: { name: 'Survivor', amount: 0, active: false } } },
      { op: 'create_entity', entity: { id: source, typeId: def.id, values: { name: 'Source', amount: null, active: '', phase: 'Open' } } },
      { op: 'link', relationship: { id: 'lnk_' + randomUUID(), typeId: 'uses', fromId: B.legacyId(s.workspaceId, 1), toId: survivor } },
      { op: 'link', relationship: { id: originalLink, typeId: 'uses', fromId: B.legacyId(s.workspaceId, 2), toId: source } },
      { op: 'put_view', view: { id: sourceView, name: 'Source-only view', entityIds: [source] } }
    ]).next);
    const sourceReader = await user(), viewReader = await user(), survivorReader = await user(), member = await user();
    await share(u, s, sourceReader, 'record', source); s = await get(u);
    await share(u, s, viewReader, 'view', sourceView); s = await get(u);
    await share(u, s, survivorReader, 'record', survivor); s = await get(u);
    await share(u, s, member, 'workspace', null, 'editor'); s = await get(u);
    const primary = await legacyRead(u), auditBefore = await history(u, survivor, '0', s.workspaceId);
    const newLink = 'lnk_' + randomUUID();
    const merged = B.prepare(s, [{ op: 'merge_entities', survivorId: survivor, sourceIds: [source],
      fieldResolutions: { name: 'Survivor' }, replacementLinkIds: { [originalLink]: newLink } }]).next;
    await denied(() => cas(member, s, merged));
    await db.exec(`create function public.test_fail_merge_audit() returns trigger language plpgsql set search_path=pg_catalog as $$
      begin raise sqlstate 'PT400' using message='Injected merge failure'; end $$;
      create trigger test_merge_failure after insert on pipechat.business_audit for each row execute function public.test_fail_merge_audit();`);
    try {
      await invalid(() => cas(u, s, merged)); assert.deepEqual(await get(u), s);
      assert.deepEqual(await history(u, survivor, '0', s.workspaceId), auditBefore);
      assert.equal((await get(sourceReader, s.workspaceId)).state.entities[0].id, source);
    } finally { await db.exec('drop trigger test_merge_failure on pipechat.business_audit; drop function public.test_fail_merge_audit();'); }
    const previous = s; s = await cas(u, s, merged);
    await stale(() => cas(u, previous, merged));
    assert.deepEqual(s.state.entities[0].values, { name: 'Survivor', amount: 0, active: false, phase: 'Open' });
    assert.equal(s.state.entities.length, 1); assert.equal(s.state.relationships.length, 2);
    assert(s.state.relationships.some(link => link.id === newLink && link.toId === survivor));
    assert(!s.state.relationships.some(link => link.id === originalLink));
    await denied(() => get(sourceReader, s.workspaceId));
    assert.deepEqual((await get(viewReader, s.workspaceId)).state.entities, []);
    assert.deepEqual((await get(viewReader, s.workspaceId)).state.views[0].entityIds, []);
    await denied(() => history(viewReader, survivor, '0', s.workspaceId));
    assert.equal((await get(survivorReader, s.workspaceId)).state.entities[0].id, survivor);
    assert.equal((await get(survivorReader, s.workspaceId)).primary.records.length, 0);
    assert.deepEqual(s.access.grants.map(grant => grant.resourceId).sort(), [survivor, sourceView].sort());
    assert.deepEqual(await legacyRead(u), primary);
    assert.deepEqual((await history(u, source, '0', s.workspaceId)).events.slice(-2).map(event => event.kind), ['delete', 'unlink']);
    assert.deepEqual((await history(u, survivor, '0', s.workspaceId)).events.slice(-2).map(event => event.kind), ['update', 'link']);
  });

  await t.test('RPC ACLs, private tables, anonymous access and session revocation fail closed', async () => {
    await run('tests/security.sql');
    const functions = (await db.query(`select p.oid,p.prosecdef,p.proconfig,
      p.proname||'('||oidvectortypes(p.proargtypes)||')' signature,pg_get_function_result(p.oid) result
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'business_workspace_%' order by signature`)).rows;
    assert.deepEqual(functions.map(f => f.signature), [
      'business_workspace_cas(uuid, bigint, jsonb, text)',
      'business_workspace_get(uuid)',
      'business_workspace_history(uuid, text, bigint)',
      'business_workspace_list()',
      'business_workspace_revoke(uuid, text, text, text, bigint)',
      'business_workspace_share(uuid, text, text, text, text, bigint)'
    ]);
    for (const f of functions) {
      assert.equal(f.result, 'jsonb', f.signature);
      assert.equal(f.prosecdef, true, f.signature); assert.deepEqual(f.proconfig, ['search_path=pg_catalog'], f.signature);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') ok", [role, f.oid])).rows[0].ok, role === 'authenticated', `${role}: ${f.signature}`);
      }
      assert.equal((await db.query("select count(*)::int n from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=$1 and a.grantee=0 and a.privilege_type='EXECUTE'", [f.oid])).rows[0].n, 0, f.signature);
    }
    await db.exec('set role authenticated');
    try {
      for (const sql of ['select * from pipechat.business_workspaces', 'select * from pipechat.business_audit',
        'delete from pipechat.business_audit', "select nextval('pipechat.business_audit_id_seq')",
        "select pipechat.business_audit_diff(null,'{}','{}',null,1)"])
        await assert.rejects(() => db.query(sql), e => e.code === '42501');
    }
    finally { await db.exec('reset role'); }
    await db.exec('set role anon');
    try { await assert.rejects(() => db.query('select public.business_workspace_get()'), e => e.code === '42501'); }
    finally { await db.exec('reset role'); }
    await db.query('delete from auth.sessions where id=$1', [a.session_id]);
    await assert.rejects(() => get(a), e => e.code === 'PT401');
    await assert.rejects(() => history(a, entityA), e => e.code === 'PT401');
    await assert.rejects(() => get({ ...b, session_id: viewer.session_id }), e => e.code === 'PT401');
    await assert.rejects(() => get({ id: null, session_id: null }), e => e.code === 'PT401');
  });
});
