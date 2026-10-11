'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const B = require('../public/business-workspace.js');
const { createBusinessWorkspace } = require('../lib/business-workspace.js');

function fixture(cardinality = 'many_to_one') {
  const workspaceId = randomUUID(), a = 'ent_' + randomUUID(), b = 'ent_' + randomUUID();
  const type = { id: 'organization', name: 'Organization', fields: [
    { id: 'name', name: 'Name', type: 'text', required: true, options: [] },
    { id: 'size', name: 'Size', type: 'number', required: false, options: [] }
  ] };
  const proposal = { version: 1, entityTypes: [type], relationshipTypes: [
    { id: 'belongs_to', name: 'Belongs to', fromType: 'primary', toType: type.id, cardinality }
  ] };
  const context = { workspaceId, legacyRecordIds: [1, 2] };
  const commands = [...B.compileSchemaProposal(proposal),
    { op: 'create_entity', entity: { id: a, typeId: type.id, values: { name: 'First', size: 10 } } },
    { op: 'create_entity', entity: { id: b, typeId: type.id, values: { name: 'Second' } } },
    { op: 'link', relationship: { id: 'lnk_' + randomUUID(), typeId: 'belongs_to', fromId: B.legacyId(workspaceId, 1), toId: a } }
  ];
  return { workspaceId, a, b, proposal, context, commands, state: B.stage(B.empty(), commands, context).next };
}

test('canonical graph preserves primary table and stages CRUD, links and schema atomically', () => {
  const f = fixture(), before = structuredClone(f.state);
  assert.equal(f.state.entities.length, 2);
  assert.deepEqual(f.state.primary, { typeId: 'primary', source: 'crm_records' });
  assert.equal(B.primaryRecordId(f.workspaceId, B.legacyId(f.workspaceId, 9007199254740991)), 9007199254740991);
  const result = B.stage(f.state, [{ op: 'update_entity', id: f.a, values: { name: 'Renamed' } },
    { op: 'unlink', id: f.state.relationships[0].id }, { op: 'delete_entity', id: f.b }], f.context);
  assert.equal(result.next.entities[0].values.name, 'Renamed'); assert.equal(result.next.entities.length, 1);
  assert.equal(result.next.relationships.length, 0); assert.deepEqual(f.state, before);
  assert.throws(() => B.stage(f.state, [{ op: 'update_entity', id: f.a, values: { name: 'Would change' } },
    { op: 'update_entity', id: f.b, values: { size: 'not a number' } }], f.context), /number/);
  assert.deepEqual(f.state, before);
});

test('all cardinality directions, duplicate links, typed endpoints and tenant references are enforced', () => {
  for (const cardinality of B.cardinalities) {
    const f = fixture(cardinality);
    const link = (fromId, toId) => ({ op: 'link', relationship: { id: 'lnk_' + randomUUID(), typeId: 'belongs_to', fromId, toId } });
    const sameFrom = () => B.stage(f.state, [link(B.legacyId(f.workspaceId, 1), f.b)], f.context);
    const sameTo = () => B.stage(f.state, [link(B.legacyId(f.workspaceId, 2), f.a)], f.context);
    if (['one_to_one', 'many_to_one'].includes(cardinality)) assert.throws(sameFrom, /cardinality/); else sameFrom();
    if (['one_to_one', 'one_to_many'].includes(cardinality)) assert.throws(sameTo, /cardinality/); else sameTo();
    assert.throws(() => B.stage(f.state, [link(B.legacyId(f.workspaceId, 1), f.a)], f.context), /cardinality/);
    assert.throws(() => B.stage(f.state, [link(B.legacyId(randomUUID(), 1), f.b)], f.context), /reference/);
    assert.throws(() => B.stage(f.state, [link(f.a, f.b)], f.context), /endpoints/);
  }
});

test('schema compiler is additive, generic, and has no identity or share authority', () => {
  const f = fixture();
  assert.throws(() => B.compileSchemaProposal({ ...f.proposal, ownerId: randomUUID() }), /object/);
  assert.throws(() => B.stage(f.state, [{ op: 'share', email: 'someone@example.test' }], f.context), /separate/);
  const retype = structuredClone(f.proposal); retype.entityTypes[0].fields[1].type = 'text';
  assert.throws(() => B.stage(f.state, B.compileSchemaProposal(retype), f.context), /retyping/);
  const add = structuredClone(f.proposal); add.entityTypes[0].fields.push({ id: 'active', name: 'Active', type: 'boolean', required: false, options: [] });
  const next = B.stage(f.state, [...B.compileSchemaProposal(add), { op: 'update_entity', id: f.a, values: { active: false } }], f.context).next;
  assert.equal(next.entities[0].values.active, false);
  assert.throws(() => B.validate({ ...next, members: [] }, f.context), /object/);
});

test('saved views contain only explicit IDs; deletion cleans references in one next-state', () => {
  const f = fixture(), view = { id: 'view_' + randomUUID(), name: 'Selected', entityIds: [f.a, B.legacyId(f.workspaceId, 1)] };
  const withView = B.stage(f.state, [{ op: 'put_view', view }], f.context).next;
  const deleted = B.stage(withView, [{ op: 'delete_entity', id: f.a }], f.context).next;
  assert.deepEqual(deleted.views[0].entityIds, [B.legacyId(f.workspaceId, 1)]); assert.equal(deleted.relationships.length, 0);
  assert.throws(() => B.stage(f.state, [{ op: 'put_view', view: { ...view, entityIds: [B.legacyId(f.workspaceId, 3)] } }], f.context), /reference/);
});

test('typed values reject malformed data and reserved fields without input mutation', () => {
  const f = fixture();
  for (const values of [{ name: '' }, { size: {} }, { size: true }, { unknown: 1 }, { size: NaN }, { size: Infinity }, { size: undefined }]) {
    assert.throws(() => B.stage(f.state, [{ op: 'update_entity', id: f.a, values }], f.context));
  }
  assert.throws(() => B.compileSchemaProposal({ version: 1, entityTypes: [{ id: 'constructor', name: 'Invalid', fields: [] }], relationshipTypes: [] }));
  const p = structuredClone(f.proposal); p.entityTypes[0].fields.push({ id: 'day', name: 'Day', type: 'date', required: false, options: [] });
  const s = B.stage(f.state, B.compileSchemaProposal(p), f.context).next;
  assert.throws(() => B.stage(s, [{ op: 'update_entity', id: f.a, values: { day: '2026-02-30' } }], f.context), /date/);
});

test('adapter rejects malformed and incomplete commit acknowledgements', async () => {
  const f = fixture();
  const current = { workspaceId: f.workspaceId, version: 0, role: 'owner', scope: 'workspace', state: f.state,
    primary: { updatedAt: null, records: [1, 2].map(recordId => ({ recordId, entityId: B.legacyId(f.workspaceId, recordId), values: {} })), tableSchema: null, customFields: [] } };
  const prepared = B.prepare(current, [{ op: 'update_entity', id: f.a, values: { size: 25 } }]);
  const api = createBusinessWorkspace({ rpc: async () => ({ ...current, version: 1 }) });
  await assert.rejects(() => api.commit(prepared), e => e.status === 503);
  await assert.rejects(() => api.read('not-a-workspace'), e => e.status === 400);
  await assert.rejects(() => api.commit({ ...prepared, expectedPrimaryUpdatedAt: undefined }), e => e.status === 400);
});

test('request adapter forwards only CAS state/version, never an acting identity or authority', async () => {
  const f = fixture(), calls = [];
  const current = { workspaceId: f.workspaceId, version: 4, role: 'owner', scope: 'workspace', state: f.state,
    primary: { updatedAt: null, records: [1, 2].map(recordId => ({ recordId, entityId: B.legacyId(f.workspaceId, recordId), values: {} })), tableSchema: null, customFields: [] } };
  const api = createBusinessWorkspace({ rpc: async (name, args) => {
    calls.push({ name, args }); return name === 'business_workspace_cas' ? { ...current, version: 5, state: args.p_state } : current;
  } });
  assert.deepEqual(await api.read(), current);
  const prepared = api.prepare(current, [{ op: 'update_entity', id: f.a, values: { size: 20 } }]);
  assert.equal((await api.commit(prepared)).state.entities[0].values.size, 20);
  assert.deepEqual(Object.keys(calls[1].args).sort(), ['p_expected_primary_updated_at', 'p_expected_version', 'p_state', 'p_workspace']);
  assert.throws(() => api.prepare({ ...current, role: 'viewer' }, []), /read-only/);
  assert.throws(() => api.prepare({ ...current, role: 'editor' }, [{ op: 'put_view', view: { id: 'view_' + randomUUID(), name: 'View', entityIds: [] } }]), /owner/);
});
