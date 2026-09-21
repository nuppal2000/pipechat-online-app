const test = require('node:test');
const assert = require('node:assert/strict');
const { safeErrorSummary, runAuthDiagnostics } = require('../scripts/diagnose-xano-auth.js');
const { WORKSPACE_API } = require('../scripts/test-xano-live.js');
const key = 'fake-diagnostic-server-key-only-for-tests';

function fixture({ statuses = [401, 401, 401, 500], networkFailure = false, issueToken = false } = {}) {
  const calls = [], logs = [], completed = [];
  let attempts = 0;
  const options = { baseUrl: WORKSPACE_API, serverKey: key, confirm: async () => true, wait: async () => {},
    log: line => logs.push(line), fetchImpl: async (url, init) => {
      assert(url.startsWith(`${WORKSPACE_API}/`));
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['X-PipeChat-Key'], key);
      const path = url.slice(WORKSPACE_API.length + 1);
      calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
      if (networkFailure) throw new Error(`Do not echo ${key}`);
      if (path === 'pipechat/health') return { status: 200, json: async () => ({ contract: 'pipechat-xano-v1' }) };
      if (path === 'auth/logout') return { status: 200, json: async () => ({ ok: true }) };
      assert.equal(path, 'auth/login');
      const index = attempts++;
      if (index === 3) await new Promise(resolve => setTimeout(resolve, 10));
      completed.push(index);
      return { status: statuses[index], json: async () => ({ code: 'ERROR_CODE_FATAL_ERROR',
        message: `current transaction is aborted; private=${key}`, ...(issueToken ? { authToken: 'unexpected-test-token' } : {}) }) };
    } };
  return { options, calls, logs, completed };
}

test('safe summaries are fixed labels even when errors contain secrets or arbitrary fields', () => {
  assert.equal(safeErrorSummary({ code: 'ERROR_CODE_FATAL_ERROR', message: `current transaction is aborted ${key}` }),
    'ERROR_CODE_FATAL_ERROR; DATABASE_TRANSACTION_ABORTED');
  assert.equal(safeErrorSummary({ code: key, message: key, error: { token: key }, payload: { password: key } }),
    'UNRECOGNIZED_OR_MISSING_CODE; UNCLASSIFIED_ERROR');
  assert.equal(safeErrorSummary(null), 'UNRECOGNIZED_OR_MISSING_CODE; UNCLASSIFIED_ERROR');
});

test('diagnostic reports both race results, never calls signup/CRM/usage, and prints no raw values', async () => {
  const fake = fixture();
  const result = await runAuthDiagnostics(fake.options);
  assert.deepEqual(result.statuses, [401, 401, 401, 500]);
  assert.equal(result.productionReady, false);
  assert.equal(fake.completed.length, 4);
  assert.deepEqual(fake.calls.map(call => call.path), ['pipechat/health', 'auth/login', 'auth/login', 'auth/login', 'auth/login']);
  assert(fake.logs.some(line => line.includes('Concurrent first login B: HTTP 500')));
  const output = fake.logs.join('\n');
  assert(!output.includes(key));
  for (const call of fake.calls.filter(call => call.body)) {
    assert(call.body.email.toLowerCase().startsWith('pipechat-qa-'));
    assert(call.body.email.toLowerCase().endsWith('@example.invalid'));
    assert(!output.includes(call.body.password));
    assert(!output.includes(call.body.email));
  }
});

test('consent cancellation, wrong workspace and missing key make no network calls', async () => {
  const fake = fixture();
  assert.deepEqual(await runAuthDiagnostics({ ...fake.options, confirm: async () => false }), { cancelled: true });
  await assert.rejects(runAuthDiagnostics({ ...fake.options, baseUrl: 'https://wrong.example' }));
  await assert.rejects(runAuthDiagnostics({ ...fake.options, serverKey: '' }));
  assert.equal(fake.calls.length, 0);
});

test('unexpected issued token is revoked without appearing in output', async () => {
  const fake = fixture({ statuses: [200, 401, 401, 500], issueToken: true });
  await runAuthDiagnostics(fake.options);
  assert.equal(fake.calls.filter(call => call.path === 'auth/logout').length, 1);
  assert(!fake.logs.join('\n').includes('unexpected-test-token'));
});

test('diagnostic suppresses network exceptions that may carry credentials', async () => {
  const fake = fixture({ networkFailure: true });
  await assert.rejects(runAuthDiagnostics(fake.options), error => error.message === 'Health: network error; raw details suppressed.');
  assert(!fake.logs.join('\n').includes(key));
});
