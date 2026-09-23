const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const Schema = require('../public/table-schema.js');
const Core = require('../public/pipeline-core.js');

const schema = {
  status: 'ready', useCase: 'Recruiting', description: '', title: 'Recruiting pipeline', recordLabel: 'candidate',
  fields: [
    { id: 'f_name', name: 'Candidate name', type: 'text', role: 'primary', options: [] },
    { id: 'f_owner', name: 'Recruiter', type: 'text', role: 'owner', options: [] },
    { id: 'f_stage', name: 'Recruiting stage', type: 'choice', role: 'status', options: ['Sourced', 'Interview', 'Hired'] },
    { id: 'f_pay', name: 'Expected compensation', type: 'currency', role: 'none', options: [] },
    { id: 'f_score', name: 'Score', type: 'number', role: 'none', options: [] },
    { id: 'f_due', name: 'Follow-up date', type: 'date', role: 'followup', options: [] }
  ]
};
const custom = [{ id: 'cf_contact', name: 'Contact', type: 'text' }];
const row = (id = 1, fields = {}) => ({ id, history: [], activity: '', health: '', ...fields });
const totals = usage => [usage.used, usage.limit, usage.reserved, usage.remaining, usage.paymentRequired];

test('Supabase migration executes on real embedded PostgreSQL', { timeout: 120000 }, async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await fs.readFile(path.join(__dirname, '../db/tests/mock-supabase.sql'), 'utf8'));
  await db.exec(await fs.readFile(path.join(__dirname, '../db/migrations/001-supabase.sql'), 'utf8'));
  await db.exec(await fs.readFile(path.join(__dirname, '../db/migrations/003-spreadsheet-setup.sql'), 'utf8'));
  await db.exec(await fs.readFile(path.join(__dirname, '../db/migrations/004-column-and-kpi-customization.sql'), 'utf8'));
  await db.exec(await fs.readFile(path.join(__dirname, '../db/migrations/005-kpi-lifecycle.sql'), 'utf8'));

  async function user(metadata = {}) {
    const result = { id: randomUUID(), session: randomUUID() };
    await db.query('insert into auth.users(id,raw_user_meta_data) values ($1,$2::jsonb)', [result.id, JSON.stringify(metadata)]);
    await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [result.session, result.id]);
    return result;
  }
  async function as(identity, sql, values = [], role = 'authenticated') {
    assert(['authenticated', 'anon', 'service_role'].includes(role));
    const claims = identity ? { sub: identity.id, session_id: identity.session, role } : {};
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
    await db.exec(`set role ${role}`);
    try { return await db.query(sql, values); }
    finally { await db.exec('reset role'); }
  }
  async function rpc(identity, name, args = [], role = 'authenticated') {
    const signatures = {
      health: [], read_crm: [], write_crm: ['jsonb', 'jsonb', 'jsonb', 'text'],
      read_usage: [], reserve_usage: ['uuid'], finish_usage: ['uuid', 'text']
    };
    assert(Object.hasOwn(signatures, name));
    const params = signatures[name].map((type, i) => `$${i + 1}::${type}`).join(',');
    const values = args.map((value, i) => signatures[name][i] === 'jsonb' ? JSON.stringify(value) : value);
    return (await as(identity, `select public.pipechat_${name}(${params}) as result`, values, role)).rows[0].result;
  }
  const read = identity => rpc(identity, 'read_crm');
  const write = (identity, snapshot) => rpc(identity, 'write_crm', [snapshot.deals, snapshot.customFields, snapshot.tableSchema, snapshot.updatedAt]);
  async function setup(identity, tableSchema = schema, customFields = []) {
    return write(identity, { ...await read(identity), tableSchema, customFields });
  }
  const code = (action, expected) => assert.rejects(action, error => {
    assert.equal(error.code, expected, error.message);
    return true;
  });

  await t.test('health is anonymous and status-only; grants and RLS are narrow', async () => {
    await db.exec(await fs.readFile(path.join(__dirname, '../db/tests/security.sql'), 'utf8'));
    assert.deepEqual(await rpc(null, 'health', [], 'anon'), {
      ok: true, contract: 'pipechat-supabase-v1', database: 'ok', schemaVersion: 1
    });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await code(() => as(null, 'select * from pipechat.crm_records', [], role), '42501');
      await code(() => as(null, 'select pipechat.require_user()', [], role), '42501');
    }
    await code(() => rpc(null, 'read_crm', [], 'anon'), '42501');
    await code(() => rpc(null, 'read_crm', [], 'service_role'), '42501');
    // Even an accidental future table grant cannot bypass policy-free RLS.
    await db.exec('grant usage on schema pipechat to authenticated; grant select,insert,update,delete on all tables in schema pipechat to authenticated;');
    try {
      assert.deepEqual((await as(null, 'select * from pipechat.schema_version')).rows, []);
      assert.equal((await as(null, 'update pipechat.schema_version set version = 1')).affectedRows, 0);
      await code(() => as(null, 'insert into pipechat.schema_version values (true,1)'), '42501');
    } finally {
      await db.exec('revoke all on all tables in schema pipechat from authenticated; revoke all on schema pipechat from authenticated;');
    }
  });

  await t.test('signup is empty, pending, isolated, and ignores untrusted metadata', async () => {
    const a = await user({ role: 'admin', quota_limit: 999999, workspace_id: randomUUID(), tableSchema: schema });
    const b = await user();
    assert.deepEqual(await read(a), { deals: [], customFields: [], tableSchema: { status: 'pending' }, updatedAt: null });
    assert.deepEqual(totals(await rpc(a, 'read_usage')), [0, 1000, 0, 1000, false]);
    const membership = await db.query('select * from pipechat.memberships where user_id=$1', [a.id]);
    assert.equal(membership.rows.length, 1); assert.equal(membership.rows[0].role, 'owner');
    const ready = await setup(a);
    assert.equal(typeof ready.updatedAt, 'string');
    const saved = await write(a, { ...ready, deals: [row(7, { f_name: 'Private A' })] });
    assert.equal(saved.deals[0].f_name, 'Private A');
    assert.deepEqual(await read(b), { deals: [], customFields: [], tableSchema: { status: 'pending' }, updatedAt: null });
    assert.equal((await db.query('select count(*)::int as n from pipechat.crm_records where workspace_id=$1', [membership.rows[0].workspace_id])).rows[0].n, 1);
  });

  await t.test('every authenticated RPC checks live session ownership and revocation', async () => {
    const a = await user(), b = await user();
    const calls = [
      ['read_crm', []], ['write_crm', [[], [], { status: 'pending' }, null]], ['read_usage', []],
      ['reserve_usage', [randomUUID()]], ['finish_usage', [randomUUID(), 'commit']]
    ];
    for (const invalid of [null, { ...a, session: undefined }, { ...a, session: 'malformed' }, { ...a, session: b.session }, { ...a, id: 'malformed' }]) {
      for (const [name, args] of calls) await code(() => rpc(invalid, name, args), 'PT401');
    }
    await db.query('delete from auth.sessions where id=$1', [a.session]);
    for (const [name, args] of calls) await code(() => rpc(a, name, args), 'PT401');
    assert.equal((await rpc(b, 'read_usage')).limit, 1000);
  });

  await t.test('CAS versions are exact, monotonic, workspace-wide, and writes are atomic', async () => {
    const a = await user();
    const ready = await setup(a);
    const saved = await write(a, { ...ready, deals: [row(20, { f_name: 'First' }), row(2, { f_name: 'Second' })] });
    assert(saved.updatedAt > ready.updatedAt);
    assert.deepEqual(saved.deals.map(record => record.id), [20, 2]);
    for (const updatedAt of [null, ready.updatedAt, 'invalid', saved.updatedAt.replace('Z', '+00:00')]) {
      await code(() => write(a, { ...saved, updatedAt, deals: [] }), 'PT409');
    }
    await code(() => write(a, { ...saved, customFields: custom, deals: [row(1, { f_name: 'Partial' }), row(2, { f_pay: true })] }), 'PT400');
    assert.deepEqual(await read(a), saved);
    // Shared membership has the same workspace token, not a per-user version.
    const b = await user();
    await db.query('delete from pipechat.workspaces where owner_id=$1', [b.id]);
    await db.query("insert into pipechat.memberships(workspace_id,user_id,role) select workspace_id,$1,'member' from pipechat.memberships where user_id=$2", [b.id, a.id]);
    assert.deepEqual(await read(b), saved);
    const changed = await write(b, { ...saved, deals: [] });
    await code(() => write(a, saved), 'PT409');
    assert.deepEqual(await read(a), changed);
  });

  await t.test('schema validation rejects malformed and malicious direct RPC payloads', async () => {
    const a = await user(), pending = await read(a);
    const f = schema.fields[0];
    const badSchemas = [null, [], {}, { status: 'unknown' }, { ...schema, useCase: 'Wrong' },
      { ...schema, title: '' }, { ...schema, title: 'bad\nlabel' }, { ...schema, title: 'x'.repeat(61) },
      { ...schema, description: 'x'.repeat(2001) }, { ...schema, description: null },
      { ...schema, fields: [] }, { ...schema, fields: {} }, { ...schema, fields: Array(31).fill(f) },
      { ...schema, fields: [null] }, { ...schema, fields: [f, f] },
      { ...schema, fields: [{ ...f, id: '__proto__' }] }, { ...schema, fields: [{ ...f, id: 'cf_' }] },
      { ...schema, fields: [{ ...f, type: 'object' }] }, { ...schema, fields: [{ ...f, role: 'none' }] },
      { ...schema, fields: [{ ...f, role: 'invalid' }] }, { ...schema, fields: [{ ...f, name: 'constructor' }] },
      { ...schema, fields: [f, { ...f, id: 'f_other', name: '  Candidate   NAME ', role: 'none' }] },
      { ...schema, fields: [f, { ...f, id: 'f_other', name: 'Other' }] },
      { ...schema, fields: [{ ...f, options: ['Not a choice'] }] },
      ...['primary', 'owner', 'followup', 'status'].map(role => ({ ...schema, fields: [f, { id: 'f_bad', name: 'Bad', role, type: 'number', options: [] }] })),
      ...[[], ['Warm', ' warm '], Array(31).fill('Warm'), [7], ['x'.repeat(81)], ['bad\toption']].map(options => ({ ...schema, fields: [f, { id: 'f_choice', name: 'Choice', role: 'none', type: 'choice', options }] }))
    ];
    for (const tableSchema of badSchemas) await code(() => write(a, { ...pending, tableSchema }), 'PT400');
    await code(() => write(a, { ...pending, tableSchema: schema, deals: [row()] }), 'PT400');
    assert.deepEqual(await read(a), pending);
    const ready = await setup(a);
    for (const tableSchema of [null, { status: 'pending' }, { ...schema, fields: schema.fields.map(field => field.id === 'f_pay' ? { ...field, type: 'number' } : field) }]) {
      await code(() => write(a, { ...ready, tableSchema }), 'PT400');
    }
  });

  await t.test('custom definitions enforce limits, IDs, collisions, normalization and text type', async () => {
    const a = await user(), ready = await setup(a);
    const bad = [null, {}, Array(21).fill(custom[0]), [null], [custom[0], custom[0]],
      [{ ...custom[0], type: 'number' }], [{ ...custom[0], id: 'f_contact' }],
      ...['Recruiter', 'r\u00e9cruiter', 'f_owner', 'ID', '__proto__', 'prototype', 'constructor', 'health', 'history', 'activity', '', 'a\tb', 'x'.repeat(61)].map(name => [{ ...custom[0], name }]),
      [custom[0], { id: 'cf_other', name: 'CONTACT', type: 'text' }]];
    for (const customFields of bad) await code(() => write(a, { ...ready, customFields }), 'PT400');
    const saved = await write(a, { ...ready, customFields: custom, deals: [row(1, { cf_contact: '  Ravi  ' })] });
    assert.equal(saved.deals[0].cf_contact, 'Ravi');
    const promoted = { ...schema, fields: [...schema.fields, { ...custom[0], role: 'none', options: [] }] };
    await code(() => write(a, { ...saved, tableSchema: promoted }), 'PT400');
    await code(() => write(a, { ...saved, tableSchema: { ...schema, fields: [...schema.fields, { ...custom[0], type: 'number', role: 'none', options: [] }] }, customFields: [] }), 'PT400');
  });

  await t.test('typed SQL cell normalization agrees with core, including blanks and JS rounding', async () => {
    const a = await user(); let snapshot = await setup(a, schema, custom);
    const table = Core.create(schema);
    const fixtures = [
      {}, { f_name: '', f_stage: null, f_pay: '', f_due: null },
      { f_name: '  Taylor  ', f_stage: 'interview', f_pay: '0', f_score: '-1.25', f_due: 'Nov 30, 2026', cf_contact: ' Name ' },
      { f_pay: 1.005, f_score: '0x10', f_due: '2024-02-29' },
      { f_pay: -1.125, f_score: '0b101', f_due: 'September 1, 2026' },
      { f_pay: -1000000000000, f_score: '0o17', f_due: 'Jan 1, 0099' },
      { f_pay: 0, f_score: '1e-400', f_name: '\u00a0Caf\u00e9\ufeff' },
      { f_score: 1000000000000, f_due: '0100-01-01' }, { f_pay: 0.29, f_score: '.75' }
    ];
    const input = fixtures.map((fields, i) => row(i + 1, fields));
    snapshot = await write(a, { ...snapshot, deals: input });
    const expected = input.map(record => ({ id: record.id, ...table.tableValues(record, custom), history: [], activity: '', health: '' }));
    assert.deepEqual(snapshot.deals, expected);
    const projected = await write(a, { ...snapshot, deals: [row(1, { password: 'secret', user_id: randomUUID(), workspace_id: randomUUID() })] });
    assert(!JSON.stringify(projected).includes('secret'));
    assert.deepEqual(projected.deals[0], { id: 1, ...table.tableValues({}, custom), history: [], activity: '', health: '' });
    await code(() => write(a, { ...projected, deals: [row(1, { f_unknown: 'bad' })] }), 'PT400');
    await code(() => write(a, { ...projected, deals: [row(1, { cf_unknown: 'bad' })] }), 'PT400');
  });

  await t.test('invalid cells, IDs and histories cannot bypass the SQL contract', async () => {
    const a = await user(), ready = await setup(a, schema, custom);
    const badCells = [
      ...[true, {}, [], ' ', 'Infinity', 'NaN', '1e13', -1000000000001, '0x1000000000000', '1,000'].map(f_pay => ({ f_pay })),
      ...[true, 1, {}, [], 'x'.repeat(12001), '\ud83d\ude00'.repeat(6001)].map(f_name => ({ f_name })),
      ...['2026-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '0099-01-01', 'February 30, 2026', 'next week', ' ', '11/30'].map(f_due => ({ f_due })),
      ...['Warm', ' ', 7].map(f_stage => ({ f_stage })), { cf_contact: 3 }
    ];
    for (const fields of badCells) await code(() => write(a, { ...ready, deals: [row(1, fields)] }), 'PT400');
    for (const id of [0, -1, 1.1, 9007199254740992, '1', null, true, {}, []]) {
      await code(() => write(a, { ...ready, deals: [row(id)] }), 'PT400');
    }
    for (const deals of [null, {}, [null], [row(), row()], Array.from({ length: 2001 }, (_, i) => row(i + 1)),
      [{ id: 1 }], [row(1, { history: null })], [row(1, { history: [1] })], [row(1, { history: ['safe', {}] })]]) {
      await code(() => write(a, { ...ready, deals }), 'PT400');
    }
    assert.deepEqual(await read(a), ready);
    const valid = await write(a, { ...ready, deals: [row(9007199254740991, { f_name: '\ud83d\ude00'.repeat(6000), history: ['First', 'Second'], activity: 'just now', health: 'updated' })] });
    assert.equal(valid.deals[0].id, 9007199254740991); assert.deepEqual(valid.deals[0].history, ['First', 'Second']);
  });

  await t.test('column deletion, custom-primary promotion, new-primary replacement and undo preserve values', async () => {
    const a = await user(); let initial = await setup(a, schema, custom);
    initial = await write(a, { ...initial, deals: [row(1, { f_name: 'Taylor', f_pay: 500, cf_contact: 'Ravi', history: ['Imported'] })] });
    for (const [field, replacement] of [['f_pay', null], ['f_name', { field: 'cf_contact' }], ['f_name', { field: 'f_owner' }], ['f_name', { name: 'New identity', id: 'f_identity' }]]) {
      const change = Core.create(schema).deleteColumn(initial.deals, field, custom, replacement);
      const deleted = await write(a, { deals: change.records, tableSchema: change.tableSchema, customFields: change.customFields, updatedAt: initial.updatedAt });
      assert.deepEqual(deleted.deals, change.records); assert.deepEqual(deleted.tableSchema, change.tableSchema); assert.deepEqual(deleted.customFields, change.customFields);
      initial = await write(a, { ...initial, updatedAt: deleted.updatedAt });
      assert.equal(initial.deals[0].f_name, 'Taylor'); assert.equal(initial.deals[0].cf_contact, 'Ravi'); assert.equal(initial.deals[0].f_pay, 500);
    }
    const cleared = await write(a, { ...initial, deals: [] });
    assert.deepEqual(cleared.tableSchema, schema); assert.deepEqual(cleared.customFields, custom);
    assert.equal((await write(a, { ...initial, updatedAt: cleared.updatedAt })).deals[0].f_name, 'Taylor');
  });

  await t.test('RPC bypass cannot store oversize snapshots, history or activity text', async () => {
    const a = await user(), ready = await setup(a);
    for (const fields of [{ history: Array(10001).fill('') }, { history: ['x'.repeat(32769)] },
      { activity: 'x'.repeat(12001) }, { health: 'x'.repeat(12001) },
      { discardedProperty: 'x'.repeat(16 * 1024 * 1024) }]) {
      await code(() => write(a, { ...ready, deals: [row(1, fields)] }), 'PT400');
      assert.deepEqual(await read(a), ready);
    }
    for (const updatedAt of ['x'.repeat(257), 'invalid\nversion']) await code(() => write(a, { ...ready, updatedAt }), 'PT400');
    const table = Core.create(schema);
    const before = { ...row(), ...table.tableValues({ f_name: 'x'.repeat(12000) }) };
    const plan = table.plan([before], { action: 'update_record', ids: [1], field: 'f_name', value: 'y'.repeat(12000) });
    const changed = table.apply([before], plan, 'Actor'.repeat(40));
    assert(changed[0].history[0].length > 24000);
    const saved = await write(a, { ...ready, deals: changed });
    assert.deepEqual(saved.deals, changed);
    // Test the aggregate byte limit with individually valid cells and histories.
    const large = Array.from({ length: 520 }, (_, i) => row(i + 1, { history: ['x'.repeat(32768)] }));
    await code(() => write(a, { ...saved, deals: large }), 'PT400');
    assert.deepEqual(await read(a), saved);
    // Sparse input can expand on normalization. The output cap must roll back too.
    const wideSchema = { ...schema, fields: [schema.fields[0], ...Array.from({ length: 29 }, (_, i) => ({
      id: `f_${String(i).padStart(2, '0')}_${'x'.repeat(55)}`, name: `Column ${i}`, type: 'text', role: 'none', options: []
    }))] };
    const sparse = { ...saved, tableSchema: wideSchema, deals: Array.from({ length: 500 }, (_, i) => row(i + 1, { history: ['x'.repeat(32768)] })) };
    assert(Buffer.byteLength(JSON.stringify(sparse)) < 16 * 1024 * 1024);
    await code(() => write(a, sparse), 'PT400');
    assert.deepEqual(await read(a), saved);
  });

  await t.test('explicit legacy-ready schema still supports blank imports and column operations', async () => {
    const a = await user(), legacy = Schema.legacySchema(), table = Core.create(legacy);
    const ready = await setup(a, legacy, custom);
    const saved = await write(a, { ...ready, deals: [row(1, { account: '', stage: '', value: null, follow: 'Today', cf_contact: 'Legacy contact' })] });
    assert.deepEqual(saved.deals[0], { ...row(), ...table.tableValues({ follow: 'Today', cf_contact: 'Legacy contact' }, custom) });
    await code(() => write(a, { ...saved, deals: [row(1, { value: -1 })] }), 'PT400');
    const change = table.deleteColumn(saved.deals, 'account', custom, { field: 'cf_contact' });
    const next = await write(a, { ...saved, deals: change.records, customFields: change.customFields, tableSchema: change.tableSchema });
    assert.equal(next.tableSchema.fields.find(f => f.role === 'primary').id, 'cf_contact');
    assert.equal(next.deals[0].cf_contact, 'Legacy contact');
  });

  await t.test('reservations are user-scoped, idempotent and quota-limited with safe PT402 detail', async () => {
    const a = await user(), b = await user(), requestId = randomUUID();
    await db.query('update pipechat.usage_counters set quota_limit=1 where user_id=$1', [a.id]);
    const first = await rpc(a, 'reserve_usage', [requestId]);
    assert.deepEqual(totals(first.usage), [0, 1, 1, 0, true]);
    const timestamps = (await db.query('select created_at,expires_at from pipechat.usage_reservations where id=$1', [first.reservationId])).rows[0];
    assert.equal(new Date(timestamps.expires_at) - new Date(timestamps.created_at), 300000);
    assert.deepEqual(await rpc(a, 'reserve_usage', [requestId]), first);
    assert.deepEqual((await db.query('select created_at,expires_at from pipechat.usage_reservations where id=$1', [first.reservationId])).rows[0], timestamps);
    await assert.rejects(() => rpc(a, 'reserve_usage', [randomUUID()]), error => {
      assert.equal(error.code, 'PT402'); assert.deepEqual(JSON.parse(error.detail), first.usage);
      assert.deepEqual(Object.keys(JSON.parse(error.detail)).sort(), ['limit', 'paymentRequired', 'remaining', 'reserved', 'updatedAt', 'used']);
      return true;
    });
    await code(() => rpc(b, 'finish_usage', [first.reservationId, 'commit']), 'PT409');
    const other = await rpc(b, 'reserve_usage', [requestId]);
    assert.notEqual(other.reservationId, first.reservationId);
    const committed = await rpc(a, 'finish_usage', [first.reservationId, 'commit']);
    assert.deepEqual(totals(committed), [1, 1, 0, 0, true]);
    assert.deepEqual(await rpc(a, 'finish_usage', [first.reservationId, 'commit']), committed);
    await code(() => rpc(a, 'finish_usage', [first.reservationId, 'release']), 'PT409');
    await code(() => rpc(a, 'reserve_usage', [requestId]), 'PT409');
    assert.deepEqual(totals(await rpc(b, 'finish_usage', [other.reservationId, 'release'])), [0, 1000, 0, 1000, false]);
    const ready = await setup(a);
    assert.equal((await write(a, { ...ready, deals: [row()] })).deals.length, 1);
  });

  await t.test('release, expiry, late finalize and retry never revive or double-charge', async () => {
    const a = await user();
    await db.query('update pipechat.usage_counters set quota_limit=1 where user_id=$1', [a.id]);
    const requestId = randomUUID(), released = await rpc(a, 'reserve_usage', [requestId]);
    const meter = await rpc(a, 'finish_usage', [released.reservationId, 'release']);
    assert.deepEqual(await rpc(a, 'finish_usage', [released.reservationId, 'release']), meter);
    await code(() => rpc(a, 'finish_usage', [released.reservationId, 'commit']), 'PT409');
    await code(() => rpc(a, 'reserve_usage', [requestId]), 'PT409');
    const expiringRequest = randomUUID(), expired = await rpc(a, 'reserve_usage', [expiringRequest]);
    await db.query("update pipechat.usage_reservations set created_at=transaction_timestamp()-interval '6 minutes', expires_at=transaction_timestamp()-interval '1 minute' where id=$1", [expired.reservationId]);
    // Error transactions roll back lazy expiry too, but deadlines still prevent charging.
    await code(() => rpc(a, 'finish_usage', [expired.reservationId, 'commit']), 'PT409');
    await code(() => rpc(a, 'reserve_usage', [expiringRequest]), 'PT409');
    const afterExpiry = await rpc(a, 'read_usage');
    assert.deepEqual(totals(afterExpiry), [0, 1, 0, 1, false]);
    assert.deepEqual(await rpc(a, 'finish_usage', [expired.reservationId, 'release']), afterExpiry);
    assert.deepEqual(await rpc(a, 'read_usage'), afterExpiry);
    const fresh = await rpc(a, 'reserve_usage', [randomUUID()]);
    assert.notEqual(fresh.reservationId, expired.reservationId);
    assert.deepEqual(totals(await rpc(a, 'finish_usage', [fresh.reservationId, 'commit'])), [1, 1, 0, 0, true]);
    await code(() => rpc(a, 'finish_usage', [expired.reservationId, 'commit']), 'PT409');
  });

  await t.test('invalid usage inputs, missing membership, admin limits and account deletion', async () => {
    const a = await user();
    await code(() => rpc(a, 'reserve_usage', [null]), 'PT400');
    for (const outcome of [null, '', 'refund', 'COMMIT']) await code(() => rpc(a, 'finish_usage', [randomUUID(), outcome]), 'PT400');
    await code(() => rpc(a, 'finish_usage', [null, 'commit']), 'PT400');
    await code(() => rpc(a, 'finish_usage', [randomUUID(), 'commit']), 'PT409');
    await code(() => as(a, 'update pipechat.usage_counters set quota_limit=999999'), '42501');
    await db.query('update pipechat.usage_counters set quota_limit=0 where user_id=$1', [a.id]);
    assert.deepEqual(totals(await rpc(a, 'read_usage')), [0, 0, 0, 0, true]);
    await code(() => rpc(a, 'reserve_usage', [randomUUID()]), 'PT402');
    await db.query('update pipechat.usage_counters set quota_limit=2 where user_id=$1', [a.id]);
    const reserved = await rpc(a, 'reserve_usage', [randomUUID()]);
    await db.query('delete from pipechat.memberships where user_id=$1', [a.id]);
    await code(() => read(a), 'PT401');
    assert.equal((await rpc(a, 'read_usage')).reserved, 1);
    await db.query('delete from auth.users where id=$1', [a.id]);
    await code(() => rpc(a, 'read_usage'), 'PT401');
    for (const [table, column, value] of [['workspaces', 'owner_id', a.id], ['usage_counters', 'user_id', a.id], ['usage_reservations', 'id', reserved.reservationId]]) {
      assert.equal((await db.query(`select count(*)::int as n from pipechat.${table} where ${column}=$1`, [value])).rows[0].n, 0);
    }
  });
});
