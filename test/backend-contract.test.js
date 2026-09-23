const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BackendError, snapshotResult, usageResult } = require('../lib/backend-contract.js');
const row = { id: 1, account: 'Acme', stage: 'Discovery', owner: 'Jordan', value: 100,
  close: '', next: '', follow: '', notes: '', history: [] };

test('shared snapshot validation rejects malformed responses and projects only safe fields', () => {
  for (const data of [{ deals: [] }, { deals: [{ id: 1, account: 'Missing fields' }], updatedAt: null },
    { deals: [row, row], updatedAt: 'v1' }, { deals: [], updatedAt: '' }]) {
    assert.throws(() => snapshotResult(data), BackendError);
  }
  const input = { deals: [{ ...row, user_id: 99, password: 'hidden' }], updatedAt: 'v1', token: 'hidden' };
  const before = structuredClone(input), result = snapshotResult(input);
  assert.deepEqual(input, before);
  assert.equal(result.deals[0].user_id, undefined);
  assert.equal(result.deals[0].password, undefined);
  assert.equal(result.token, undefined);
  assert.deepEqual(snapshotResult({ deals: [], updatedAt: 'saved-empty' }), { deals: [], updatedAt: 'saved-empty' });
});

test('shared usage validation includes reservations and rejects invalid counters', () => {
  const usage = { used: 2, limit: 10, reserved: 1, remaining: 7 };
  assert.equal(usageResult({ usage }).remaining, 7);
  assert.equal(usageResult({ used: 0, limit: 1, reserved: 1, remaining: 0 }).paymentRequired, true);
  for (const input of [{}, { ...usage, remaining: 10 }, { ...usage, used: -1 },
    { ...usage, reserved: 0.5 }, { ...usage, limit: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => usageResult(input), error => error instanceof BackendError && error.status === 503);
  }
  const error = new BackendError('Safe message', 402, usage);
  assert.equal(error.name, 'BackendError'); assert.equal(error.status, 402); assert.equal(error.usage, usage);
});

test('retired or unknown storage providers fail before startup instead of falling back to JSON', () => {
  for (const provider of ['xano', 'unknown']) {
    const run = spawnSync(process.execPath, [path.join(__dirname, '../server.js')], {
      env: { ...process.env, PIPECHAT_STORAGE_PROVIDER: provider },
      encoding: 'utf8', timeout: 5000, windowsHide: true
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /PIPECHAT_STORAGE_PROVIDER must be json or supabase/);
    assert.doesNotMatch(run.stdout, /server running/);
  }
});
