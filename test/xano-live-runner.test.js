const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runChecks, CheckError, WORKSPACE_API } = require('../scripts/test-xano-live.js');
const { snapshotResult } = require('../lib/xano-backend.js');
const key = 'fake-key-used-only-by-offline-runner-tests';

// This fixture tests the runner, not the correctness of the remote Xano backend.
function fixture({ signupFailure = false, identityMismatch = false, allowBothSaves = false, reserveFailure = false } = {}) {
  const users = [], tokens = new Map(), reservations = new Map(), calls = [], logs = [], pending = new Set();
  const reply = (status, body) => ({ status, json: async () => structuredClone(body) });
  const usage = user => {
    const reserved = [...reservations.values()].filter(item => item.user === user && item.state === 'reserved').length;
    const remaining = Math.max(user.limit - user.used - reserved, 0);
    return { used: user.used, limit: user.limit, reserved, remaining, paymentRequired: remaining === 0, updatedAt: null };
  };
  const auth = user => { const authToken = `private-test-token-${crypto.randomUUID()}`; tokens.set(authToken, user); return { authToken }; };
  let raceCount = 0, reserveCount = 0, writes = 0;
  async function fetchImpl(url, options) {
    assert(url.startsWith(`${WORKSPACE_API}/`), 'Runner must never call OpenAI or another destination');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-PipeChat-Key'], key);
    const path = url.slice(WORKSPACE_API.length + 1), body = options.body ? JSON.parse(options.body) : {};
    calls.push({ path, method: options.method });
    if (path === 'pipechat/health') return reply(200, { contract: 'pipechat-xano-v1', status: 'awaiting-live-verification', capabilities: [] });
    if (path === 'auth/signup') {
      if (signupFailure) return reply(500, { message: `never echo ${key}`, password: body.password });
      const user = { id: users.length + 1, ...body, limit: 1000, used: 0, snapshot: { deals: [], updatedAt: null } };
      users.push(user);
      return reply(200, auth(user));
    }
    if (path === 'auth/login') {
      const user = users.find(item => item.email === body.email && item.password === body.password);
      return user ? reply(200, auth(user)) : reply(401, {});
    }
    const token = options.headers.Authorization?.slice(7), user = tokens.get(token);
    if (!user) return reply(401, {});
    if (path === 'auth/me') return reply(200, { id: user.id, name: user.name, email: identityMismatch ? 'existing-customer@example.test' : user.email });
    if (path === 'auth/logout') { tokens.delete(token); return reply(200, { ok: true }); }
    if (path === 'crm') {
      if (options.method !== 'PUT') return reply(200, user.snapshot);
      writes++;
      if (!Object.hasOwn(body, 'expectedUpdatedAt')) return reply(400, {});
      try { snapshotResult({ deals: body.deals, updatedAt: body.expectedUpdatedAt }); } catch { return reply(400, {}); }
      if (body.deals.some(row => row.close === '2026-02-30')) return reply(400, {});
      const race = body.deals[0]?.account.startsWith('QA race ');
      if (race) raceCount++;
      if (!(allowBothSaves && race) && body.expectedUpdatedAt !== user.snapshot.updatedAt) return reply(409, {});
      user.snapshot = { deals: structuredClone(body.deals), updatedAt: crypto.randomUUID() };
      return reply(200, user.snapshot);
    }
    if (path === 'chat-usage') return reply(200, usage(user));
    if (path === 'chat-usage/reserve') {
      reserveCount++;
      if (reserveFailure && reserveCount === 1) return reply(500, { message: 'private failure' });
      if (reserveFailure && reserveCount === 2) {
        const pendingId = 'second reservation'; pending.add(pendingId);
        await new Promise(resolve => setTimeout(resolve, 15));
        pending.delete(pendingId);
      }
      const existing = reservations.get(`${user.id}:${body.requestId}`);
      if (existing) return existing.state === 'reserved' ? reply(200, { reservationId: body.requestId, usage: usage(user) }) : reply(409, {});
      if (usage(user).remaining === 0) return reply(402, { usage: usage(user) });
      reservations.set(`${user.id}:${body.requestId}`, { user, state: 'reserved' });
      return reply(200, { reservationId: body.requestId, usage: usage(user) });
    }
    if (path === 'chat-usage/finalize') {
      const reservation = reservations.get(`${user.id}:${body.reservationId}`);
      if (!reservation) return reply(404, {});
      if (body.outcome === 'commit') {
        if (reservation.state === 'released') return reply(409, {});
        if (reservation.state === 'reserved') { user.used++; reservation.state = 'committed'; }
      } else if (reservation.state === 'reserved') reservation.state = 'released';
      return reply(200, usage(user));
    }
    throw new Error('Unexpected test route');
  }
  return { users, tokens, reservations, calls, logs, pending, get writes() { return writes; }, get raceCount() { return raceCount; },
    options: { baseUrl: WORKSPACE_API, serverKey: key, fetchImpl, wait: async () => {}, intervalMs: 0,
      confirm: async () => true, prepareQuota: async ({ userId }) => { users.find(user => user.id === userId).limit = 1; },
      log: line => logs.push(line) } };
}

test('runner checks core contract without advertising production readiness', async () => {
  const fake = fixture();
  const result = await runChecks(fake.options);
  assert.equal(result.passed, true);
  assert.equal(result.productionReady, false);
  assert.equal(fake.users.length, 2);
  assert.equal(fake.raceCount, 2);
  assert.equal(fake.tokens.size, 0);
  assert.equal(fake.users[0].used, 1);
  assert.equal(fake.users[1].used, 0);
  assert(fake.users.every(user => user.snapshot.deals.length === 0));
  assert([...fake.reservations.values()].every(item => item.state !== 'reserved'));
  assert(!fake.logs.join('\n').includes(key));
  for (const user of fake.users) assert(!fake.logs.join('\n').includes(user.password));
});

test('cancelled consent performs no network requests or writes', async () => {
  const fake = fixture();
  assert.deepEqual(await runChecks({ ...fake.options, confirm: async () => false }), { cancelled: true });
  assert.equal(fake.calls.length, 0);
});

test('wrong workspace or missing key is rejected before any request', async () => {
  const fake = fixture();
  await assert.rejects(runChecks({ ...fake.options, baseUrl: 'https://another.example/api:test' }), CheckError);
  await assert.rejects(runChecks({ ...fake.options, serverKey: '' }), CheckError);
  assert.equal(fake.calls.length, 0);
});

test('upstream failure never includes raw payloads or credentials', async () => {
  const fake = fixture({ signupFailure: true });
  await assert.rejects(runChecks(fake.options), error => error instanceof CheckError && error.message === 'Signup A: expected HTTP 200/201, received 500.');
  assert.equal(fake.users.length, 0);
});

test('identity mismatch aborts before CRM mutations and revokes test token', async () => {
  const fake = fixture({ identityMismatch: true });
  await assert.rejects(runChecks(fake.options), /fresh test-account identity did not match/);
  assert.equal(fake.writes, 0);
  assert.equal(fake.tokens.size, 0);
});

test('runner detects missing compare-and-swap protection', async () => {
  const fake = fixture({ allowBothSaves: true });
  await assert.rejects(runChecks(fake.options), /expected one success and one conflict/);
  assert.equal(fake.tokens.size, 0);
});

test('runner waits for the whole race and releases a successful sibling after failure', async () => {
  const fake = fixture({ reserveFailure: true });
  await assert.rejects(runChecks(fake.options), /Concurrent one-chat reservation: expected HTTP 200\/402, received 500/);
  assert.equal(fake.pending.size, 0);
  assert.equal(fake.tokens.size, 0);
  assert([...fake.reservations.values()].every(item => item.state === 'released'));
});
