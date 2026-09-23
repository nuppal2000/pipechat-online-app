const test = require('node:test');
const assert = require('node:assert/strict');
const { RUN_ID, RPCS, validateInput, makeTransport, runChecks, restoreOwnedSnapshot, fingerprint, together } = require('../scripts/test-supabase-live.js');
const KEY = 'sb_publishable_synthetic_test_only_key';

function fixture({ releaseWins = false, wrongQuota = false } = {}) {
  let version = 1, now = 0;
  const initial = { updatedAt: 'v1', tableSchema: { status: 'ready', title: 'QA simulated Recruiting pipeline', fields: [
    { id: 'f_name', role: 'primary', type: 'text' }, { id: 'f_amount', role: 'none', type: 'number' }
  ] }, customFields: [], deals: [1, 2, 3].map(id => ({ id, f_name: `QA ${id}`, f_amount: id, history: [] })) };
  let snapshot = structuredClone(initial);
  const bSnapshot = { ...structuredClone(initial), tableSchema: { ...initial.tableSchema, title: 'QA simulated Work tracker' }, deals: [{ id: 1, f_name: 'B only', f_amount: 9 }] };
  const ledgers = new Map(); let used = 6, writes = 0, refreshes = 0, sleeps = 0;
  const bUsage = { used: 1, reserved: 0, limit: 1, remaining: 0, paymentRequired: true, updatedAt: 'constant-b' };
  const expire = () => { for (const row of ledgers.values()) if (row.state === 'reserved' && row.expires <= now) row.state = 'expired'; };
  const usage = () => {
    expire(); const reserved = [...ledgers.values()].filter(row => row.state === 'reserved').length;
    const limit = wrongQuota ? 1000 : 7;
    return { used, reserved, limit, remaining: Math.max(0, limit - used - reserved), paymentRequired: used >= limit, updatedAt: 'qa' };
  };
  const result = (status, data = null) => ({ status, data: structuredClone(data) });
  function client(user) {
    let valid = true;
    return {
      id: user,
      async rpc(name, args = {}) {
        if (!valid) return result(401);
        if (args.p_user_id) return result(404);
        if (name === 'pipechat_read_crm') return result(200, user === 'a' ? snapshot : bSnapshot);
        if (name === 'pipechat_write_crm') {
          if (user !== 'a') throw new Error('B write attempted');
          if (args.p_expected_updated_at !== snapshot.updatedAt) return result(409);
          if (args.p_deals.some(row => typeof row.f_amount !== 'number')) return result(400);
          snapshot = { deals: structuredClone(args.p_deals), customFields: structuredClone(args.p_custom_fields), tableSchema: structuredClone(args.p_table_schema), updatedAt: `v${++version}` };
          writes++; return result(200, snapshot);
        }
        if (name === 'pipechat_read_usage') return result(200, user === 'a' ? usage() : bUsage);
        if (name === 'pipechat_reserve_usage') {
          const current = usage(), old = [...ledgers.values()].find(row => row.key === args.p_request_id);
          if (old) return old.state === 'reserved' ? result(200, { reservationId: old.id, usage: current }) : result(409);
          if (!current.remaining) return result(402);
          const row = { id: `qa-${ledgers.size}`, key: args.p_request_id, state: 'reserved', expires: now + 300000 };
          ledgers.set(row.id, row); return result(200, { reservationId: row.id, usage: usage() });
        }
        if (name === 'pipechat_finish_usage') {
          if (user === 'b') return result(409);
          if (releaseWins && args.p_outcome === 'commit') await new Promise(resolve => setImmediate(resolve));
          expire(); const row = ledgers.get(args.p_reservation_id), outcome = args.p_outcome;
          if (!row) return result(409);
          if (row.state === 'expired') return outcome === 'release' ? result(200, usage()) : result(409);
          if (row.state !== 'reserved') return row.state === outcome ? result(200, usage()) : result(409);
          row.state = outcome; if (outcome === 'commit') used++;
          return result(200, usage());
        }
        throw new Error('Unexpected method');
      },
      async privateTable() { return result(406); },
      async forgedUser() { return result(401); },
      async refresh() { refreshes++; },
      async logout() { valid = false; return result(204); }
    };
  }
  return { a: client('a'), a2: client('a'), b: client('b'), initial,
    async transport(route) { return route.endsWith('pipechat_health') ? result(200, { ok: true, contract: 'pipechat-supabase-v1', database: 'ok', schemaVersion: 1 }) : result(401); },
    async sleep(ms) { assert.equal(ms, 305000); now += ms; sleeps++; },
    state: () => ({ snapshot, used, writes, refreshes, sleeps, usage: usage() }) };
}

for (const releaseWins of [false, true]) test(`opt-in reliability runner completes safely when releaseWins=${releaseWins}`, async () => {
  const f = fixture({ releaseWins }), lines = [];
  await runChecks({ ...f, emit: line => lines.push(line) });
  const state = f.state();
  assert.equal(state.used, 7); assert.equal(state.usage.reserved, 0);
  assert.equal(state.refreshes, 1); assert.equal(state.sleeps, 1);
  assert.deepEqual(state.snapshot.deals, f.initial.deals);
  assert(lines.some(line => line.startsWith('HOSTED RELIABILITY CHECKS PASSED')));
  assert(!lines.join('\n').includes('QA 1'));
});

test('runner refuses an unprepared quota before any CRM writes', async () => {
  const f = fixture({ wrongQuota: true });
  await assert.rejects(runChecks({ ...f, emit() {} }), /exactly one remaining slot/);
  assert.equal(f.state().writes, 0); assert.equal(f.state().used, 6);
});

test('cleanup never overwrites unrelated QA edits and uses the current version', async () => {
  const original = { deals: [{ id: 1, name: 'original' }], customFields: [], tableSchema: {}, updatedAt: 'v1' };
  const current = { ...original, deals: [{ id: 1, name: 'outside change' }], updatedAt: 'v4' };
  let writes = 0;
  const client = { async rpc(name, args) {
    if (name === 'pipechat_read_crm') return { status: 200, data: current };
    writes++; assert.equal(args.p_expected_updated_at, 'v4'); return { status: 200, data: { ...original, updatedAt: 'v5' } };
  } };
  await assert.rejects(restoreOwnedSnapshot(client, original, new Set([fingerprint(original)])), /outside this test/);
  assert.equal(writes, 0);
  await restoreOwnedSnapshot(client, original, new Set([fingerprint(current)]));
  assert.equal(writes, 1);
});

test('round failures still await other requests before cleanup', async () => {
  let settled = false;
  await assert.rejects(together([Promise.reject(new Error('test failure')), new Promise(resolve => setTimeout(() => { settled = true; resolve(); }, 15))]), /test failure/);
  assert.equal(settled, true);
});

test('fixed project transport refuses other destinations and never prints provider detail', async () => {
  let calls = 0;
  const transport = makeTransport(KEY, async (url, init) => {
    calls++; assert(url.startsWith('https://nzktondjxxxiezkbrhdo.supabase.co/'));
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.apikey, KEY);
    throw new Error('private-password-and-token');
  });
  await assert.rejects(transport('https://other.invalid/'), /destination refused/);
  assert.equal(calls, 0);
  await assert.rejects(transport('/rest/v1/rpc/pipechat_health'), error => !error.message.includes('private-password-and-token') && /network request failed/.test(error.message));
  assert.equal(calls, 1);
  assert.throws(() => makeTransport('sb_secret_secretvalue'), /Publishable/);
});

test('approval input requires exact QA run and rejects privileged credentials', () => {
  const good = { authorization: 'TEST', runId: RUN_ID, publishableKey: KEY, a: 'qa-secret-a', b: 'qa-secret-b' };
  assert.equal(validateInput(good), good);
  for (const patch of [{ authorization: 'yes' }, { runId: 'different' }, { publishableKey: 'sb_secret_private' }, { a: '' }]) assert.throws(() => validateInput({ ...good, ...patch }));
  assert.equal(RPCS.length, 5);
});
