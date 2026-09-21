const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/local-qa-provider.cjs'), 'utf8');
const env = { PIPECHAT_LOCAL_QA: '1', XANO_API_BASE_URL: 'https://pipechat-qa.invalid/api:pipechat',
  PIPECHAT_HOST: '127.0.0.1', PIPECHAT_SESSION_COOKIE: 'pipechat_local_qa_session' };
function load(overrides = {}) {
  const context = { require, process: { env: { ...env, ...overrides } },
    global: {}, structuredClone, setTimeout };
  vm.runInNewContext(fixture, context); return context.global.fetch;
}

test('local QA launcher refuses to run without explicit offline opt-in', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '../scripts/start-local-qa.js')],
    { encoding: 'utf8', timeout: 3000, windowsHide: true });
  assert.equal(run.status, 1); assert.match(run.stderr, /Use --offline/);
  assert.doesNotMatch(run.stdout, /server running/);
});

test('fake providers refuse non-QA configuration before installing fetch', () => {
  for (const key of Object.keys(env)) assert.throws(() => load({ [key]: '' }));
  assert.throws(() => load({ XANO_API_BASE_URL: 'https://live.example.invalid/api:production' }));
  assert.throws(() => load({ PIPECHAT_HOST: '0.0.0.0' }));
  assert.throws(() => load({ PIPECHAT_SESSION_COOKIE: 'pipechat_xano_session' }));
});

test('fake providers reject every non-fixture destination instead of using real fetch', async () => {
  const fetch = load();
  for (const url of ['https://example.com/', 'http://127.0.0.1:8787/api/crm-data',
    'https://pipechat-qa.invalid.evil.example/api:pipechat/pipechat/health']) {
    await assert.rejects(fetch(url), /Blocked non-fixture network request/);
  }
  const health = await fetch(env.XANO_API_BASE_URL + '/pipechat/health',
    { headers: { 'X-PipeChat-Key': 'local-qa-fake-server-key-not-a-real-key' } });
  assert.equal((await health.json()).contract, 'pipechat-xano-v1');
});
