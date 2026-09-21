const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runReliabilityChecks, EXPIRY_WAIT_MS, WINDOW_WAIT_MS, LIMIT_MESSAGE } = require('../scripts/test-xano-reliability.js');
const { CheckError, WORKSPACE_API } = require('../scripts/test-xano-live.js');
const key = 'offline-only-private-key-not-a-real-secret';

// This verifies the test runner, not Xano's database/locking implementation.
function fixture({ mismatch = false, neverExpire = false, lateCommit = false, resurrect = false,
  loseIncrements = false, infrastructure429 = false, noRollover = false, splitSignup = false,
  networkFailure = false } = {}) {
  let clock = 0, user, limiterCalls = 0;
  const calls = [], waits = [], logs = [], tokens = new Set(), buckets = new Map(), reservations = new Map();
  const reply = (status, body) => ({ status, json: async () => structuredClone(body) });
  function limited(email, signup) {
    const bucketKey = `${splitSignup && signup ? 'signup:' : ''}${email.toLowerCase()}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket || (!noRollover && clock - bucket.start >= 900000)) {
      bucket = { start: clock, count: 0 }; buckets.set(bucketKey, bucket);
    }
    if (bucket.count >= 10) return true;
    limiterCalls++;
    if (!(loseIncrements && email.includes('-limiter@') && limiterCalls % 2 === 0)) bucket.count++;
    return false;
  }
  function usage() {
    const reserved = [...reservations.values()].filter(r => r.state === 'reserved' && (neverExpire || clock < r.expires)).length;
    return { used: user.used, reserved, remaining: Math.max(1000 - user.used - reserved, 0), limit: 1000,
      paymentRequired: false, updatedAt: null };
  }
  async function fetchImpl(url, options) {
    assert(url.startsWith(`${WORKSPACE_API}/`));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-PipeChat-Key'], key);
    const path = url.slice(WORKSPACE_API.length + 1), body = options.body ? JSON.parse(options.body) : {};
    calls.push({ path, method: options.method, body });
    if (networkFailure) throw new Error(`DO NOT LOG ${key}`);
    if (path === 'pipechat/health') return reply(200, { contract: 'pipechat-xano-v1', capabilities: [], status: 'awaiting-live-verification' });
    if (path === 'auth/login' || path === 'auth/signup') {
      const signup = path === 'auth/signup';
      if (limited(body.email, signup)) {
        return reply(429, { message: infrastructure429 ? 'Infrastructure capacity exceeded' : LIMIT_MESSAGE });
      }
      if (!signup) return reply(401, {});
      if (user) return reply(409, {});
      user = { id: 81, ...body, used: 0 };
      const authToken = `private-test-token-${crypto.randomUUID()}`;
      tokens.add(authToken);
      return reply(200, { authToken });
    }
    const token = options.headers.Authorization?.slice(7);
    if (!tokens.has(token)) return reply(401, {});
    if (path === 'auth/me') return reply(200, { id: user.id, email: mismatch ? 'not-the-qa@example.invalid' : user.email, name: user.name });
    if (path === 'auth/logout') { tokens.delete(token); return reply(200, { ok: true }); }
    if (path === 'chat-usage') return reply(200, usage());
    if (path === 'chat-usage/reserve') {
      let reservation = reservations.get(body.requestId);
      if (reservation && !resurrect) return reply(409, {});
      reservation = { state: 'reserved', expires: clock + 300000 };
      reservations.set(body.requestId, reservation);
      return reply(200, { reservationId: body.requestId, usage: usage() });
    }
    if (path === 'chat-usage/finalize') {
      const r = reservations.get(body.reservationId);
      if (body.outcome === 'commit') {
        if (!lateCommit && (r.state !== 'reserved' || clock >= r.expires)) return reply(409, {});
        r.state = 'committed'; user.used++;
      } else if (r.state === 'reserved') r.state = 'released';
      return reply(200, usage());
    }
    throw new Error('Unexpected runner route');
  }
  return { calls, waits, logs, tokens, reservations, buckets, get user() { return user; },
    options: { baseUrl: WORKSPACE_API, serverKey: key, confirm: async () => true, fetchImpl,
      now: () => clock, wait: async ms => { waits.push(ms); clock += ms; }, log: line => logs.push(line) } };
}

test('timed runner uses real contract durations and leaves readiness/storage unchanged', async () => {
  const fake = fixture();
  const result = await runReliabilityChecks(fake.options);
  assert.equal(result.passed, true);
  assert.equal(result.productionReady, false);
  assert.equal(EXPIRY_WAIT_MS, 305000);
  assert.equal(WINDOW_WAIT_MS, 905000);
  assert(fake.waits.reduce((a, b) => a + b, 0) >= WINDOW_WAIT_MS);
  assert.equal(fake.tokens.size, 0);
  assert.equal(fake.user.used, 0);
  assert([...fake.reservations.values()].every(r => r.state === 'released'));
  assert(!fake.calls.some(c => c.path === 'crm' || c.method === 'PUT'));
  assert(!fake.logs.join('\n').includes(key));
  assert(!fake.logs.join('\n').includes(fake.user.password));
  for (const call of fake.calls.filter(c => c.path === 'auth/login')) {
    assert(call.body.email.toLowerCase().startsWith('pipechat-qa-'));
    assert(call.body.email.toLowerCase().endsWith('@example.invalid'));
    assert(!fake.logs.join('\n').includes(call.body.password));
  }
});

test('cancelled consent performs no network calls', async () => {
  const fake = fixture();
  assert.deepEqual(await runReliabilityChecks({ ...fake.options, confirm: async () => false }), { cancelled: true });
  assert.equal(fake.calls.length, 0);
});

test('wrong workspace and missing key stop before sending any request', async () => {
  const fake = fixture();
  await assert.rejects(runReliabilityChecks({ ...fake.options, baseUrl: 'https://wrong.example/api:pipechat' }), CheckError);
  await assert.rejects(runReliabilityChecks({ ...fake.options, serverKey: '' }), CheckError);
  assert.equal(fake.calls.length, 0);
});

test('wrong QA identity stops before reservations and revokes issued session', async () => {
  const fake = fixture({ mismatch: true });
  await assert.rejects(runReliabilityChecks(fake.options), /QA identity did not match/);
  assert.equal(fake.reservations.size, 0);
  assert.equal(fake.tokens.size, 0);
});

for (const [fault, message] of [
  ['neverExpire', /Expired reservation still consumes/],
  ['lateCommit', /Expired commit rejected: expected HTTP 409/],
  ['resurrect', /Expired request cannot resurrect: expected HTTP 409/],
  ['loseIncrements', /Limiter last-slot race/],
  ['infrastructure429', /infrastructure throttling is not a pass/],
  ['noRollover', /Rollover race A: expected HTTP 401/],
  ['splitSignup', /Signup shares exhausted limiter: expected HTTP 429/]
]) {
  test(`runner detects ${fault} and cleans up its own session/reservations`, async () => {
    const fake = fixture({ [fault]: true });
    await assert.rejects(runReliabilityChecks(fake.options), message);
    assert.equal(fake.tokens.size, 0);
    assert([...fake.reservations.values()].every(r => r.state !== 'reserved'));
    assert(!fake.logs.some(line => line.startsWith('TIMED RELIABILITY CHECKS PASSED')));
  });
}

test('network errors never echo secret-bearing raw exceptions', async () => {
  const fake = fixture({ networkFailure: true });
  await assert.rejects(runReliabilityChecks(fake.options), error => error instanceof CheckError &&
    error.message === 'Health: network failure or unreadable response. No automatic retry.');
  assert(!fake.logs.join('\n').includes(key));
});
