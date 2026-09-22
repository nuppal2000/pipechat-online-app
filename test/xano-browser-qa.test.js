const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { BASE, identities, restrictedFetch, guardedBackend } = require('../scripts/xano-browser-qa-guard.cjs');

function fixture(dir) {
  const runId = crypto.randomUUID(), accounts = identities(runId), calls = [], logs = [];
  const records = new Map(), users = new Map(); let version = 0, count = 0;
  const real = {
    async authenticate(mode, input) {
      calls.push(mode);
      if (mode === 'signup') users.set(input.email, { id: ++count, email: input.email, name: input.name });
      const user = users.get(input.email), token = `secret-token-${user.id}`;
      if (!records.has(token)) records.set(token, { deals: [], updatedAt: null });
      return { user, token };
    },
    async getUser(token) { calls.push('getUser'); return [...users.values()].find(u => token === `secret-token-${u.id}`); },
    async logout() { calls.push('logout'); },
    async readCrm(token) { calls.push('read'); return structuredClone(records.get(token)); },
    async writeCrm(token, deals, expected) {
      calls.push('write'); assert.equal(expected, records.get(token).updatedAt);
      records.set(token, { deals: structuredClone(deals), updatedAt: String(++version) });
      return structuredClone(records.get(token));
    },
    async readUsage() { return { used: 2, limit: 1000, reserved: 0, remaining: 998 }; },
    async reserveUsage() { calls.push('reserve'); }, async finishUsage() { calls.push('finalize'); }
  };
  const qa = guardedBackend(real, { runId, artifactDir: dir,
    health: async () => ({ contract: 'pipechat-xano-v1', status: 'awaiting-live-verification', capabilities: [] }),
    report: text => logs.push(text) });
  return { ...qa, accounts, calls, logs, records, runId };
}
const row = { id: 1, account: 'Acme QA', owner: 'Sarah', stage: 'Discovery', value: 1234,
  close: '2026-11-30', next: 'Call', follow: 'Today', notes: 'Synthetic QA', history: ['Created'], activity: '', health: '' };

test('QA identities require fresh UUID format; forbidden destination never sends a request', async () => {
  assert.throws(() => identities('customer'));
  let calls = 0;
  const fetch = restrictedFetch(async () => { calls++; return new Response('{}'); }, { pauseMs: 0 });
  for (const url of ['https://evil.invalid/', BASE + '/crm?secret=test', BASE + '/auth/admin', BASE + '/crm#fragment',
    'https://x8ki-letl-twmt.n7.xano.io/api:meta/workspace']) await assert.rejects(fetch(url));
  await assert.rejects(fetch(BASE + '/crm', { method: 'DELETE' }));
  assert.equal(calls, 0);
  await fetch(BASE + '/crm', { method: 'GET', redirect: 'error' }); assert.equal(calls, 1);
});

test('QA acknowledges pending health explicitly without asserting production capabilities', async () => {
  const qa = fixture(); assert.deepEqual((await qa.wrapped.check()).capabilities, []);
  assert.equal((await qa.wrapped.check()).qaOnly, true);
  const bad = guardedBackend({}, { runId: crypto.randomUUID(), health: async () => ({ contract: 'wrong' }) });
  await assert.rejects(bad.wrapped.check());
});

test('Customer identities, unknown tokens and login before QA signup are denied', async () => {
  const qa = fixture();
  await assert.rejects(qa.wrapped.authenticate('signup', { email: 'customer@example.com', password: 'never-print' }));
  await assert.rejects(qa.wrapped.authenticate('login', qa.accounts[0]));
  for (const method of ['readCrm', 'writeCrm', 'readUsage', 'reserveUsage', 'finishUsage']) {
    await assert.rejects(qa.wrapped[method]('customer-token'));
  }
  assert.equal(await qa.wrapped.getUser('customer-token'), null);
  assert.equal(qa.calls.length, 0);
});

test('Only this run owns sessions; logout/close revoke access; no credentials in reports', async () => {
  const qa = fixture();
  const a = await qa.wrapped.authenticate('signup', { ...qa.accounts[0], password: 'secret-password' });
  await qa.wrapped.readCrm(a.token);
  await qa.wrapped.logout(a.token); await assert.rejects(qa.wrapped.readCrm(a.token));
  const b = await qa.wrapped.authenticate('signup', qa.accounts[1]); await qa.close();
  await assert.rejects(qa.wrapped.reserveUsage(b.token));
  assert.equal(qa.calls.filter(v => v === 'logout').length, 2);
  assert.doesNotMatch(qa.logs.join('\n'), /secret-token|secret-password/);
});

test('QA outage rejects before writes; turning it off preserves real-provider use', async () => {
  const qa = fixture(), a = await qa.wrapped.authenticate('signup', qa.accounts[0]);
  await qa.command('outage on'); await assert.rejects(qa.wrapped.writeCrm(a.token, [row], null));
  assert.ok(!qa.calls.includes('write')); await qa.command('outage off');
  await qa.wrapped.writeCrm(a.token, [row], null); assert.ok(qa.calls.includes('write'));
});

test('QA backup restores full records only to its original fresh user with current-version CAS', async t => {
  const dir = await fs.mkdtemp(path.join(__dirname, 'qa-recovery-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), __dirname); return fs.rm(dir, { recursive: true, force: true }); });
  const qa = fixture(dir), a = await qa.wrapped.authenticate('signup', qa.accounts[0]);
  const b = await qa.wrapped.authenticate('signup', qa.accounts[1]);
  await qa.wrapped.writeCrm(a.token, [row], null); await qa.command('backup a');
  await assert.rejects(qa.command('backup a')); // No silent overwrite of evidence.
  const backup = JSON.parse(await fs.readFile(path.join(dir, 'qa-a.crm.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(backup), /secret-token|password|example.invalid/);
  await qa.wrapped.writeCrm(a.token, [], '1'); await qa.command('restore a');
  assert.deepEqual((await qa.wrapped.readCrm(a.token)).deals, [row]);
  assert.deepEqual((await qa.wrapped.readCrm(b.token)).deals, []);
  backup.userId = b.user.id;
  await fs.writeFile(path.join(dir, 'qa-a.crm.json'), JSON.stringify(backup));
  await assert.rejects(qa.command('restore a'));
  assert.ok(qa.logs.some(line => line.includes('not a full workspace restore')));
});

test('Simulated AI never reaches OpenAI, and model failures remain failures', async () => {
  let sent = false;
  const fetch = restrictedFetch(async () => { sent = true; throw new Error('Must not send'); });
  const options = command => ({ body: JSON.stringify({ input: [{ content: [{ text: JSON.stringify({ userCommand: command }) }] }] }) });
  const result = await (await fetch('https://api.openai.com/v1/responses', options('Move Acme QA to Warm'))).json();
  assert.equal(JSON.parse(result.output_text).crmAction.value, 'Warm');
  await assert.rejects(fetch('https://api.openai.com/v1/responses', options('fail model')));
  assert.equal(sent, false);
});

test('QA preload fails closed outside explicit loopback diagnostic environment', () => {
  const child = spawnSync(process.execPath, ['-e', "require('./scripts/xano-browser-qa-guard.cjs').install()"],
    { cwd: path.resolve(__dirname, '..'), env: { SystemRoot: process.env.SystemRoot }, encoding: 'utf8' });
  assert.notEqual(child.status, 0);
});
