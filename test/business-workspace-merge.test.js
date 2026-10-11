'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const B = require('../public/business-workspace.js');
const id = prefix => prefix + '_' + randomUUID();
function fixture() {
  const workspaceId = randomUUID(), survivorId = id('ent'), sourceIds = [id('ent'), id('ent')], targetId = id('ent');
  const fields = [['name', 'text'], ['amount', 'number'], ['active', 'boolean'], ['detail', 'text']]
    .map(([id, type]) => ({ id, name: id, type, required: false, options: [] }));
  const state = { ...B.empty(), entityTypes: [{ id: 'item', name: 'Item', fields }],
    relationshipTypes: [{ id: 'related', name: 'Related', fromType: 'item', toType: 'item', cardinality: 'many_to_many' },
      { id: 'uses', name: 'Uses', fromType: 'primary', toType: 'item', cardinality: 'many_to_one' }],
    entities: [
      { id: survivorId, typeId: 'item', values: { name: 'Survivor', amount: 0, active: false, detail: '' } },
      { id: sourceIds[0], typeId: 'item', values: { name: 'Source', amount: null, active: '', detail: 'Fill blank' } },
      { id: sourceIds[1], typeId: 'item', values: { name: 'Survivor', amount: '', active: false, detail: '   ' } },
      { id: targetId, typeId: 'item', values: { name: 'Target' } }
    ], relationships: [
      { id: id('lnk'), typeId: 'related', fromId: survivorId, toId: targetId },
      { id: id('lnk'), typeId: 'related', fromId: sourceIds[0], toId: targetId },
      { id: id('lnk'), typeId: 'related', fromId: targetId, toId: sourceIds[0] },
      { id: id('lnk'), typeId: 'related', fromId: sourceIds[0], toId: sourceIds[1] },
      { id: id('lnk'), typeId: 'related', fromId: sourceIds[1], toId: sourceIds[0] },
      { id: id('lnk'), typeId: 'uses', fromId: B.legacyId(workspaceId, 1), toId: sourceIds[0] }
    ], views: [{ id: id('view'), name: 'Source only', entityIds: [sourceIds[0]] },
      { id: id('view'), name: 'Existing survivor', entityIds: [survivorId, sourceIds[1], targetId] }] };
  const snapshot = { workspaceId, state, role: 'owner', scope: 'workspace', version: 8,
    primary: { records: [{ recordId: 1 }, { recordId: 2 }], updatedAt: null } };
  function command(fieldResolutions = { name: 'Survivor' }) {
    const preview = B.mergePreview(state, { survivorId, sourceIds });
    return { op: 'merge_entities', survivorId, sourceIds: [...sourceIds], fieldResolutions,
      replacementLinkIds: Object.fromEntries(preview.redirectedLinkIds.map(old => [old, id('lnk')])) };
  }
  return { snapshot, state, survivorId, sourceIds, targetId, command };
}

test('merge preserves zero/false, fills blanks, redirects both endpoints, deduplicates and preserves scoped view boundaries', () => {
  const f = fixture(), original = structuredClone(f.snapshot), command = f.command();
  B.validate(f.state, { workspaceId: f.snapshot.workspaceId, legacyRecordIds: [1, 2] });
  const first = B.prepare(f.snapshot, [command]), second = B.prepare(f.snapshot, [command]);
  assert.deepEqual(first, second, 'Same reviewed IDs produce the same staged state');
  assert.deepEqual(f.snapshot, original);
  assert.deepEqual(first.changes, ['merge_entities']); assert.equal(first.expectedVersion, 8);
  assert.deepEqual(first.next.entities.map(e => e.id), [f.survivorId, f.targetId]);
  assert.deepEqual(first.next.entities[0].values, { name: 'Survivor', amount: 0, active: false, detail: 'Fill blank' });
  assert.equal(first.next.relationships.length, 4);
  assert.deepEqual(first.next.relationships[0], f.state.relationships[0], 'Already-canonical duplicate keeps its stable ID');
  assert(first.next.relationships.some(link => link.fromId === f.targetId && link.toId === f.survivorId));
  assert.equal(first.next.relationships.filter(link => link.fromId === f.survivorId && link.toId === f.survivorId).length, 1);
  assert(first.next.relationships.some(link => link.fromId.startsWith('legacy:') && link.toId === f.survivorId));
  assert(!first.next.relationships.some(link => f.sourceIds.includes(link.fromId) || f.sourceIds.includes(link.toId)));
  assert.deepEqual(first.next.views.map(v => v.entityIds), [[], [f.survivorId, f.targetId]]);
  assert.deepEqual(first.next.primary, f.state.primary);
});

test('merge requires explicit existing nonblank conflict values and remains atomic on every failure', () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  for (const values of [{}, { name: '' }, { name: null }, { name: 'Invented' }, { name: 'Source', unknown: 1 }]) {
    assert.throws(() => B.prepare(f.snapshot, [f.command(values)]), /conflicting|nonblank|resolutions/);
    assert.deepEqual(f.snapshot, before);
  }
  const selected = B.prepare(f.snapshot, [f.command({ name: 'Source' })]);
  assert.equal(selected.next.entities[0].values.name, 'Source');
  f.state.entities[1].values.active = true;
  assert.throws(() => B.prepare(f.snapshot, [f.command()]), /conflicting field: active/);
  assert.equal(B.prepare(f.snapshot, [f.command({ name: 'Survivor', active: false })]).next.entities[0].values.active, false);
});

test('merge rejects mixed types, primary IDs, invalid source sets and reused/missing redirect IDs', () => {
  const f = fixture();
  for (const sourceIds of [[], [f.survivorId], [f.sourceIds[0], f.sourceIds[0]], [id('ent')], [B.legacyId(f.snapshot.workspaceId, 1)]]) {
    assert.throws(() => B.mergePreview(f.state, { survivorId: f.survivorId, sourceIds }));
  }
  assert.throws(() => B.mergePreview(f.state, { survivorId: B.legacyId(f.snapshot.workspaceId, 1), sourceIds: f.sourceIds }));
  f.state.entityTypes.push({ id: 'other', name: 'Other', fields: f.state.entityTypes[0].fields });
  f.state.entities[1].typeId = 'other'; assert.throws(() => f.command(), /same type/); f.state.entities[1].typeId = 'item';
  for (const replace of [map => ({}), map => ({ ...map, extra: id('lnk') }), map => Object.fromEntries(Object.keys(map).map(k => [k, f.state.relationships[0].id]))]) {
    const command = f.command(); command.replacementLinkIds = replace(command.replacementLinkIds);
    assert.throws(() => B.prepare(f.snapshot, [command]));
  }
  assert.throws(() => B.prepare({ ...f.snapshot, role: 'viewer' }, [f.command()]), /read-only/);
  assert.throws(() => B.prepare({ ...f.snapshot, role: 'editor' }, [f.command()]), /shared views/);
});

test('merge refuses unresolved relationship cardinality instead of dropping distinct links', () => {
  const f = fixture();
  f.state.relationshipTypes.push({ id: 'parent', name: 'Parent', fromType: 'item', toType: 'primary', cardinality: 'many_to_one' });
  f.state.relationships.push(...f.sourceIds.map((source, index) => ({ id: id('lnk'), typeId: 'parent', fromId: source, toId: B.legacyId(f.snapshot.workspaceId, index + 1) })));
  const before = structuredClone(f.state);
  assert.throws(() => B.prepare(f.snapshot, [f.command()]), /cardinality/);
  assert.deepEqual(f.state, before);
});
