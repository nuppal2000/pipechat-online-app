const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { createInterface } = require('node:readline/promises');
const { createXanoBackend, snapshotResult, usageResult } = require('../lib/xano-backend.js');

const WORKSPACE_API = 'https://x8ki-letl-twmt.n7.xano.io/api:pipechat';
const DEAL_FIELDS = ['id', 'account', 'owner', 'stage', 'value', 'close', 'next', 'follow', 'notes', 'activity', 'health', 'history'];
class CheckError extends Error {}
function check(condition, message) {
  if (!condition) throw new CheckError(message);
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function snapshot(input, label) {
  let result;
  try { result = snapshotResult(input); } catch { throw new CheckError(`${label}: invalid CRM response shape.`); }
  check(same(Object.keys(input).sort(), ['deals', 'updatedAt']), `${label}: unexpected snapshot fields.`);
  for (const row of input.deals) {
    check(same(Object.keys(row).sort(), [...DEAL_FIELDS].sort()), `${label}: missing or unexpected deal fields.`);
    check(typeof row.value === 'number' && Number.isFinite(row.value), `${label}: deal value must be numeric.`);
  }
  return result;
}
function usage(input, label) {
  let result;
  try { result = usageResult(input); } catch { throw new CheckError(`${label}: invalid usage totals.`); }
  check(input.paymentRequired === (result.remaining === 0), `${label}: incorrect paymentRequired flag.`);
  return result;
}
function deal(account, id = 1) {
  return { id, account, owner: 'QA', stage: 'Discovery', value: 1234.56, close: '2026-12-15',
    next: 'Synthetic test only', follow: '', notes: 'No customer data', activity: '', health: '', history: [] };
}

async function runChecks({ baseUrl, serverKey, fetchImpl = fetch, wait = sleep, intervalMs = 3000,
  confirm, prepareQuota, log = console.log } = {}) {
  check(typeof baseUrl === 'string' && baseUrl.replace(/\/$/, '') === WORKSPACE_API,
    'XANO_API_BASE_URL must point to the approved PipeChat group in Neelam\'s Workspace.');
  try { createXanoBackend({ baseUrl, serverKey, fetchImpl }); }
  catch { throw new CheckError('Set XANO_SERVER_KEY privately in this PowerShell window first.'); }
  check(typeof confirm === 'function' && typeof prepareQuota === 'function', 'Interactive consent and quota setup are required.');
  if (!(await confirm())) {
    log('Cancelled. No network requests or data changes were made.');
    return { cancelled: true };
  }

  const runId = crypto.randomUUID();
  const accounts = [];
  let delay = 0;
  // Pace requests for the free instance; only explicit race batches run concurrently.
  async function batch(requests) {
    await wait(delay);
    delay = intervalMs * requests.length;
    const results = await Promise.allSettled(requests.map(async ({ label, path, method = 'GET', token, body, statuses = [200] }) => {
      let response, payload;
      try {
        response = await fetchImpl(`${WORKSPACE_API}/${path}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { Accept: 'application/json', 'X-PipeChat-Key': serverKey,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        payload = await response.json();
      } catch { throw new CheckError(`${label}: network failure or unreadable response. Request was not retried.`); }
      if (path === 'chat-usage/reserve' && response.status === 200 && typeof payload.reservationId === 'string') {
        const account = accounts.find(item => item.token === token);
        if (account && !account.reservations.includes(payload.reservationId)) account.reservations.push(payload.reservationId);
      }
      check(statuses.includes(response.status), `${label}: expected HTTP ${statuses.join('/')}, received ${response.status}.`);
      return { status: response.status, body: payload };
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map(result => result.value);
  }
  async function request(options) { return (await batch([options]))[0]; }
  async function readCrm(account, label) {
    return snapshot((await request({ label, path: 'crm', token: account.token })).body, label);
  }
  async function save(account, data, version, label, extra = {}) {
    return snapshot((await request({ label, path: 'crm', method: 'PUT', token: account.token,
      body: { deals: data, expectedUpdatedAt: version, ...extra } })).body, label);
  }
  async function readUsage(account, label) {
    return usage((await request({ label, path: 'chat-usage', token: account.token })).body, label);
  }
  async function finalize(account, reservationId, outcome, label, statuses = [200]) {
    return request({ label, path: 'chat-usage/finalize', method: 'POST', token: account.token,
      body: { reservationId, outcome }, statuses });
  }
  try {
    const health = (await request({ label: 'Health', path: 'pipechat/health' })).body;
    check(health.contract === 'pipechat-xano-v1', 'Health: wrong integration contract.');
    log('PASS: private key accepted. Production readiness has not been enabled.');

    for (const letter of ['A', 'B']) {
      const account = { email: `pipechat-qa-${runId}-${letter.toLowerCase()}@example.invalid`,
        name: `PipeChat QA ${runId} ${letter}`, password: crypto.randomBytes(32).toString('base64url'),
        tokens: [], reservations: [] };
      const auth = (await request({ label: `Signup ${letter}`, path: 'auth/signup', method: 'POST',
        body: { email: account.email, password: account.password, name: account.name }, statuses: [200, 201] })).body;
      check(typeof auth.authToken === 'string' && auth.authToken.length >= 16, `Signup ${letter}: missing authentication token.`);
      account.token = auth.authToken;
      account.tokens.push(auth.authToken);
      accounts.push(account);
      const profile = (await request({ label: `Profile ${letter}`, path: 'auth/me', token: account.token })).body;
      check(same(Object.keys(profile).sort(), ['email', 'id', 'name']), `Profile ${letter}: unexpected fields.`);
      check(profile.email === account.email && profile.name === account.name && Number.isSafeInteger(profile.id) && profile.id > 0,
        `Profile ${letter}: fresh test-account identity did not match. No CRM writes attempted.`);
      account.id = profile.id;
      check(same(await readCrm(account, `Empty CRM ${letter}`), { deals: [], updatedAt: null }), `CRM ${letter}: new account was not empty.`);
      const initial = await readUsage(account, `Initial usage ${letter}`);
      check(initial.used === 0 && initial.reserved === 0 && initial.limit >= 1, `Usage ${letter}: unexpected initial allowance.`);
      log(`Created test account ${letter}: user_id=${account.id}; name=${account.name}`);
    }
    const [a, b] = accounts;
    check(a.id !== b.id, 'Test accounts were not distinct.');
    log('PASS: signup, profile and empty per-user storage.');
    await prepareQuota({ userId: a.id, name: a.name });
    const quota = await readUsage(a, 'One-chat setup');
    check(quota.limit === 1 && quota.used === 0 && quota.reserved === 0, 'Set only the new QA account A usage limit to 1, used=0; then rerun with new test accounts.');

    let state = await save(a, [deal('QA A'), deal('QA A second', 2)], null, 'Save A');
    check(state.updatedAt !== null, 'Save A: missing new version.');
    check(same(state.deals, snapshot({ deals: [deal('QA A'), deal('QA A second', 2)], updatedAt: null }, 'Expected A').deals), 'Save A: returned data differs.');
    const bState = await save(b, [deal('QA B')], null, 'Save B using same client ID');
    check(same(await readCrm(a, 'Read A again'), state), 'Account B changed account A.');
    check(same(await readCrm(b, 'Read B again'), bState), 'Account B data did not persist.');
    log('PASS: full-field persistence and same client IDs isolated across users.');

    for (const [label, body] of [
      ['Missing version', { deals: [] }],
      ['Invalid second row', { deals: [deal('Should not save'), deal('', 2)], expectedUpdatedAt: state.updatedAt }],
      ['Invalid calendar date', { deals: [{ ...deal('Invalid date'), close: '2026-02-30' }], expectedUpdatedAt: state.updatedAt }],
      ['Duplicate IDs', { deals: [deal('Duplicate one'), deal('Duplicate two')], expectedUpdatedAt: state.updatedAt }]
    ]) {
      await request({ label, path: 'crm', method: 'PUT', token: a.token, body, statuses: [400] });
      check(same(await readCrm(a, `${label} preserved state`), state), `${label}: rejected save changed data.`);
    }
    const firstVersion = state.updatedAt;
    state = await save(a, [deal('QA renamed')], state.updatedAt, 'Rename and delete second row');
    await request({ label: 'Stale save', path: 'crm', method: 'PUT', token: a.token,
      body: { deals: [], expectedUpdatedAt: firstVersion }, statuses: [409] });
    check(same(await readCrm(a, 'Stale save preserved data'), state), 'Stale save changed data.');
    const races = await batch(['One', 'Two'].map(suffix => ({ label: `Concurrent save ${suffix}`, path: 'crm', method: 'PUT', token: a.token,
      body: { deals: [deal(`QA race ${suffix}`)], expectedUpdatedAt: state.updatedAt }, statuses: [200, 409] })));
    check(same(races.map(result => result.status).sort(), [200, 409]), 'Concurrent saves: expected one success and one conflict.');
    state = snapshot(races.find(result => result.status === 200).body, 'Concurrent winner');
    check(same(await readCrm(a, 'Concurrent saved state'), state), 'Concurrent save did not persist the winner exactly.');
    log('PASS: rename/delete, invalid-payload rejection and stale/concurrent-save protection.');

    const spoof = await request({ label: 'Foreign user ID in save body', path: 'crm', method: 'PUT', token: a.token,
      body: { deals: [deal('QA own account only')], expectedUpdatedAt: state.updatedAt, user_id: b.id, email: b.email }, statuses: [200, 400] });
    if (spoof.status === 200) state = snapshot(spoof.body, 'Scoped save');
    check(same(await readCrm(b, 'Foreign user remains unchanged'), bState), 'Client-supplied identity changed another account.');

    const requests = [crypto.randomUUID(), crypto.randomUUID()];
    const reservations = await batch(requests.map(requestId => ({ label: 'Concurrent one-chat reservation', path: 'chat-usage/reserve', method: 'POST',
      token: a.token, body: { requestId }, statuses: [200, 402] })));
    check(same(reservations.map(result => result.status).sort(), [200, 402]), 'One-chat cap: expected one reservation and one HTTP 402.');
    const winner = reservations.findIndex(result => result.status === 200);
    const reservation = reservations[winner].body;
    check(typeof reservation.reservationId === 'string' && reservation.reservationId, 'Missing reservation ID.');
    const reservedUsage = usage(reservation.usage, 'Reserved usage');
    check(reservedUsage.used === 0 && reservedUsage.reserved === 1 && reservedUsage.remaining === 0, 'Reservation did not occupy the last chat.');
    const retry = (await request({ label: 'Active reservation retry', path: 'chat-usage/reserve', method: 'POST', token: a.token,
      body: { requestId: requests[winner] } })).body;
    check(retry.reservationId === reservation.reservationId && usage(retry.usage, 'Retry usage').reserved === 1, 'Active retry was not idempotent.');
    await finalize(b, reservation.reservationId, 'commit', 'Foreign reservation rejected', [403, 404]);
    state = await save(a, [deal('QA manual edit while reserved')], state.updatedAt, 'Manual save with zero remaining');
    await finalize(a, reservation.reservationId, 'release', 'Release failed-call reservation');
    await finalize(a, reservation.reservationId, 'release', 'Repeated release');
    await finalize(a, reservation.reservationId, 'commit', 'Released reservation cannot commit', [409]);
    await request({ label: 'Released request cannot resurrect', path: 'chat-usage/reserve', method: 'POST', token: a.token,
      body: { requestId: requests[winner] }, statuses: [409] });
    const released = await readUsage(a, 'Released usage');
    check(released.used === 0 && released.reserved === 0 && released.remaining === 1, 'Release did not restore the allowance.');
    const committed = (await request({ label: 'New reservation', path: 'chat-usage/reserve', method: 'POST', token: a.token,
      body: { requestId: crypto.randomUUID() } })).body;
    check(typeof committed.reservationId === 'string', 'New reservation has no ID.');
    await finalize(a, committed.reservationId, 'commit', 'Commit one test usage');
    await finalize(a, committed.reservationId, 'commit', 'Repeated commit');
    await finalize(a, committed.reservationId, 'release', 'Committed usage cannot be refunded');
    const capped = await readUsage(a, 'Final usage');
    check(capped.used === 1 && capped.reserved === 0 && capped.remaining === 0, 'Commit/retry/release charged incorrectly.');
    await request({ label: 'Exhausted chat blocked', path: 'chat-usage/reserve', method: 'POST', token: a.token,
      body: { requestId: crypto.randomUUID() }, statuses: [402] });
    state = await save(a, [deal('QA manual edit after cap')], state.updatedAt, 'Manual save after cap');
    check(same(await readCrm(a, 'Capped manual edit persists'), state), 'Manual editing failed at the cap.');
    const bUsage = await readUsage(b, 'Other user usage');
    check(bUsage.used === 0 && bUsage.reserved === 0, 'Account A consumed account B allowance.');
    log('PASS: one-chat race, retry/release/commit accounting, ownership and manual saves at the cap.');

    const oldToken = a.token;
    await request({ label: 'Logout A', path: 'auth/logout', method: 'POST', token: oldToken, body: {} });
    for (const path of ['auth/me', 'crm', 'chat-usage']) {
      await request({ label: `Revoked token rejected by ${path}`, path, token: oldToken, statuses: [401] });
    }
    const login = (await request({ label: 'Login again', path: 'auth/login', method: 'POST', body: { email: a.email, password: a.password } })).body;
    check(typeof login.authToken === 'string' && login.authToken.length >= 16, 'Login did not return a token.');
    a.token = login.authToken;
    a.tokens.push(login.authToken);
    check(same(await readCrm(a, 'CRM after new session'), state), 'Saved data did not survive a new session.');
    state = await save(a, [], state.updatedAt, 'Save empty CRM at cap');
    check(state.deals.length === 0 && state.updatedAt !== null && same(await readCrm(a, 'Read empty CRM'), state), 'Empty saved CRM was not preserved.');
    await save(b, [], bState.updatedAt, 'Clear QA B rows');
    log('PASS: revoked-token rejection, new-session persistence and empty-table saving.');
    log('CORE LIVE CHECKS PASSED. QA accounts remain for inspection; passwords were not saved.');
    log('Still pending: reservation expiry, limiter races, forced database rollback, starter-route/log security review and full browser workflows. Do not enable production readiness yet.');
    return { passed: true, runId, userIds: accounts.map(account => account.id), productionReady: false };
  } finally {
    for (const account of accounts) {
      for (const reservationId of account.reservations) {
        try { await finalize(account, reservationId, 'release', 'Cleanup test reservation', [200, 401, 409]); }
        catch { log('WARNING: a QA reservation could not be released; it should expire after five minutes.'); }
      }
      for (const token of new Set(account.tokens)) {
        try { await request({ label: 'Revoke test session', path: 'auth/logout', method: 'POST', token, body: {}, statuses: [200, 401] }); }
        catch { log('WARNING: a QA session could not be revoked; no token was printed or saved.'); }
      }
      account.password = null;
      account.token = null;
      account.tokens = [];
    }
  }
}

async function main() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runChecks({ baseUrl: process.env.XANO_API_BASE_URL, serverKey: process.env.XANO_SERVER_KEY,
      confirm: async () => {
        console.log('This opt-in test creates TWO disposable PipeChat QA accounts in Neelam\'s Xano workspace.');
        console.log('It edits only their synthetic CRM rows and consumes one synthetic usage count. No OpenAI calls or existing-user edits.');
        console.log('QA account/usage records remain afterward. Your app database setting will not change.');
        return (await readline.question('Type TEST to authorize these test-only changes (anything else cancels): ')).trim() === 'TEST';
      },
      prepareQuota: async ({ userId, name }) => {
        console.log(`\nPAUSED FOR ONE-CHAT TEST: ${name}; user_id=${userId}`);
        console.log('In Xano Database > chat_usage, set limit=1 ONLY for this new user_id. Leave used=0.');
        console.log('Do not alter an existing customer\'s allowance. You can ask Codex to do this using the test user_id above.');
        check((await readline.question('After that QA limit is saved, type READY to continue: ')).trim() === 'READY', 'Stopped before CRM tests.');
      }
    });
  } finally { readline.close(); }
}

if (require.main === module) main().catch(error => {
  console.error(`FAIL: ${error instanceof CheckError ? error.message : 'Unexpected runner error; raw details suppressed to protect credentials.'}`);
  console.error('Stop here and share only these status lines. Do not paste keys, passwords or tokens. Existing app storage was not changed.');
  process.exitCode = 1;
});
module.exports = { runChecks, CheckError, WORKSPACE_API };
