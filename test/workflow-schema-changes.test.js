'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Changes = require('../lib/schema-changes');
const Journal = require('../lib/action-journal');
const { legacySchema } = require('../public/table-schema');
const { createSupabaseBackend } = require('../lib/supabase-backend');
const rename = { kind: 'rename_choice_option', fieldId: 'stage', from: 'Won', to: 'Customer' };
function snapshots() {
  const before = { tableSchema: legacySchema(), customFields: [], todoCards: [], updatedAt: 'v1',
    deals: [{ id: 1, account: 'A', stage: 'Won', history: [] }, { id: 2, account: 'B', stage: 'Lost', history: [] }] };
  const after = structuredClone(before);
  after.tableSchema.fields.find(f => f.id === 'stage').options = before.tableSchema.fields.find(f => f.id === 'stage').options.map(o => o === 'Won' ? 'Customer' : o);
  after.deals[0].stage = 'Customer';
  return { before, after };
}

test('explicit schema-change metadata is strict, detached and part of the default action identity', () => {
  const values = [rename], validated = Changes.validate(values); validated[0].to = 'Other'; assert.equal(values[0].to, 'Customer');
  for (const invalid of [null, {}, [null], [{ ...rename, extra: true }], [{ ...rename, fieldId: 'constructor' }],
    [{ ...rename, from: '' }], [{ ...rename, to: 'bad\nlabel' }], [{ ...rename, to: rename.from }], [rename, rename],
    [rename, { ...rename, from: 'Lost' }], [rename, { ...rename, from: 'Customer', to: 'Client' }]]) assert.throws(() => Changes.validate(invalid));
  const seed = { kind: 'crm', data: {} };
  const withRename = Journal.prepareMetadata({ schemaChanges: [rename] }, seed), plain = Journal.prepareMetadata({}, seed);
  assert.notEqual(withRename.actionId, plain.actionId); assert.deepEqual(withRename.schemaChanges, [rename]);
  assert.deepEqual(Journal.prepareMetadata({ schemaChanges: [rename] }, seed), withRename);
  assert.throws(() => Journal.prepareMetadata({ schemaChanges: [rename] }, { kind: 'todo' }));
});

test('rename validation compares exact old/new fields and all original cells, with simultaneous independent mappings', () => {
  const { before, after } = snapshots();
  assert.deepEqual(Changes.transition(before, after, [rename]), [rename]);
  for (const alter of [s => { s.deals[0].stage = 'Lost'; }, s => { s.deals.shift(); },
    s => { s.tableSchema.fields.find(f => f.id === 'stage').name = 'Changed too'; },
    s => { s.tableSchema.fields.find(f => f.id === 'stage').options.reverse(); }]) {
    const bad = structuredClone(after); alter(bad); assert.throws(() => Changes.transition(before, bad, [rename]));
  }
  for (const c of [{ ...rename, from: 'Missing' }, { ...rename, fieldId: 'owner' }, { ...rename, to: 'Lost' }]) {
    assert.throws(() => Changes.transition(before, after, [c]));
  }
  const two = structuredClone(after); two.deals[1].stage = 'Archived';
  two.tableSchema.fields.find(f => f.id === 'stage').options = two.tableSchema.fields.find(f => f.id === 'stage').options.map(o => o === 'Lost' ? 'Archived' : o);
  const changes = [rename, { ...rename, from: 'Lost', to: 'Archived' }];
  assert.deepEqual(Changes.transition(before, two, changes), changes);
});

test('real adapter forwards strict rename metadata and preserves exact retries after workspace versions change', async () => {
  const { before, after } = snapshots(), calls = [];
  let current = before, original;
  const backend = createSupabaseBackend({ url: 'https://offline.supabase.co', publishableKey: 'sb_publishable_offline_1234567890',
    createClient: () => ({ rpc() { throw new Error('No shared-client RPC'); } }),
    createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.test' } }, error: null }) },
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === 'pipechat_read_workspace') return { data: current, error: null };
        assert.equal(name, 'pipechat_commit_action');
        const data = original || { snapshot: { ...args.p_workspace, updatedAt: 'v2', workflows: [] }, replayed: false,
          receipt: { formatVersion: 1, actionId: args.p_action_id, requestId: args.p_request_id, conversationId: null,
            planId: null, undoOf: null, importReceipt: null, beforeVersion: 'v1', afterVersion: 'v2' } };
        const replayed = Boolean(original); original = structuredClone(data); current = { ...data.snapshot, updatedAt: 'v3' };
        return { data: { ...data, replayed }, error: null };
      } }) });
  const adapter = backend.forRequest({ headers: {} }, { getHeader() {}, setHeader() {} });
  const save = metadata => adapter.writeCrm(null, after.deals, before.updatedAt, after.customFields, after.tableSchema, [], metadata);
  await assert.rejects(() => save({ schemaChanges: [{ ...rename, ignored: true }] }), error => error.status === 400);
  await assert.rejects(() => save({ schemaChanges: [{ ...rename, from: 'Missing' }] }), error => error.status === 409);
  assert.ok(calls.every(c => c.name === 'pipechat_read_workspace'));
  const first = await save({ schemaChanges: [rename] }), replay = await save({ schemaChanges: [rename] });
  const commits = calls.filter(c => c.name === 'pipechat_commit_action');
  assert.equal(commits.length, 2); assert.deepEqual(commits[0].args, commits[1].args);
  assert.deepEqual(commits[0].args.p_metadata, { schemaChanges: [rename] });
  assert.equal(replay.replayed, true); assert.equal(first.updatedAt, replay.updatedAt);
});
