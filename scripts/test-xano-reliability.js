const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { createInterface } = require('node:readline/promises');
const { createXanoBackend, usageResult } = require('../lib/xano-backend.js');
const { WORKSPACE_API, CheckError } = require('./test-xano-live.js');
const { safeErrorSummary } = require('./diagnose-xano-auth.js');

const EXPIRY_WAIT_MS = 305000;
const WINDOW_WAIT_MS = 905000;
const LIMIT_MESSAGE = 'Too many login/signup attempts. Please wait 15 minutes.';
function check(condition, message) { if (!condition) throw new CheckError(message); }
function usage(body, label) {
  try { return usageResult(body); }
  catch { throw new CheckError(`${label}: invalid usage totals.`); }
}
function totals(value) { return [value.used, value.reserved, value.remaining, value.limit]; }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Dependencies are injectable for offline runner tests. The CLI always uses real time and HTTPS.
async function runReliabilityChecks({ baseUrl, serverKey, confirm, fetchImpl = fetch,
  wait = sleep, now = () => performance.now(), intervalMs = 3000, log = console.log } = {}) {
  check(typeof baseUrl === 'string' && baseUrl.replace(/\/$/, '') === WORKSPACE_API,
    'XANO_API_BASE_URL must point to the approved PipeChat group in Neelam\'s Workspace.');
  try { createXanoBackend({ baseUrl, serverKey, fetchImpl }); }
  catch { throw new CheckError('Set XANO_SERVER_KEY privately in this PowerShell window first.'); }
  check(typeof confirm === 'function', 'Interactive test consent is required.');
  if (!(await confirm())) {
    log('Cancelled. No network requests or data changes were made.');
    return { cancelled: true };
  }

  const runId = crypto.randomUUID();
  const account = { email: `pipechat-qa-${runId}-reliability@example.invalid`,
    name: `PipeChat QA ${runId} Reliability`, password: crypto.randomBytes(32).toString('base64url') };
  const probeEmail = `pipechat-qa-${runId}-limiter@example.invalid`;
  const wrongPassword = crypto.randomBytes(32).toString('base64url');
  const tokens = new Set(), reservations = new Set();
  let token, delay = 0;

  async function batch(requests) {
    await wait(delay);
    delay = intervalMs * requests.length;
    // Wait for all siblings before failing so any issued sessions/reservations can be cleaned up.
    const settled = await Promise.allSettled(requests.map(async ({ label, path, method = 'GET', body,
      auth, statuses = [200], captureAuth = false }) => {
      let response, payload;
      try {
        response = await fetchImpl(`${WORKSPACE_API}/${path}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { Accept: 'application/json', 'X-PipeChat-Key': serverKey,
            ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        payload = await response.json();
      } catch { throw new CheckError(`${label}: network failure or unreadable response. No automatic retry.`); }
      if (captureAuth && typeof payload?.authToken === 'string') tokens.add(payload.authToken);
      if (path === 'chat-usage/reserve' && response.status === 200 && typeof payload?.reservationId === 'string') {
        reservations.add(payload.reservationId);
      }
      if (!statuses.includes(response.status)) {
        log(`DIAGNOSTIC: ${label}: HTTP ${response.status}; ${safeErrorSummary(payload)}`);
      }
      check(statuses.includes(response.status), `${label}: expected HTTP ${statuses.join('/')}, received ${response.status}.`);
      if (response.status === 429) {
        check(payload?.message === LIMIT_MESSAGE || payload?.error === LIMIT_MESSAGE,
          `${label}: HTTP 429 was not the reviewed PipeChat limiter response; infrastructure throttling is not a pass.`);
      }
      return { status: response.status, body: payload };
    }));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return settled.map(result => result.value);
  }
  async function request(options) { return (await batch([options]))[0]; }
  async function readUsage(label) {
    return usage((await request({ label, path: 'chat-usage', auth: token })).body, label);
  }
  function attempt(email, label, statuses = [401]) {
    return { label, path: 'auth/login', method: 'POST', body: { email, password: wrongPassword }, statuses };
  }
  async function finalize(reservationId, outcome, label, statuses = [200]) {
    return request({ label, path: 'chat-usage/finalize', method: 'POST', auth: token,
      body: { reservationId, outcome }, statuses });
  }
  async function waitUntil(deadline, label) {
    const remaining = Math.max(0, deadline - now());
    if (remaining > 0) log(`WAIT: ${label}; about ${Math.ceil(remaining / 60000)} minute(s). Keep this window open.`);
    while (now() < deadline) await wait(Math.min(30000, deadline - now()));
  }
  try {
    const health = (await request({ label: 'Health', path: 'pipechat/health' })).body;
    check(health?.contract === 'pipechat-xano-v1', 'Health: wrong integration contract.');
    log('PASS: private key accepted. This runner never enables production readiness.');
    const signup = (await request({ label: 'QA signup', path: 'auth/signup', method: 'POST',
      body: account, statuses: [200, 201], captureAuth: true })).body;
    check(typeof signup?.authToken === 'string' && signup.authToken.length >= 16, 'QA signup: missing token.');
    token = signup.authToken;
    const profile = (await request({ label: 'QA identity', path: 'auth/me', auth: token })).body;
    check(profile?.email === account.email && profile?.name === account.name && Number.isSafeInteger(profile.id) && profile.id > 0,
      'QA identity did not match the freshly created account. No reservation attempted.');
    log(`Created test account: user_id=${profile.id}; name=${account.name}`);
    const baseline = await readUsage('Initial allowance');
    check(baseline.used === 0 && baseline.reserved === 0 && baseline.remaining >= 1,
      'New QA account must have an unused allowance. No customer quota should be edited.');
    const requestId = crypto.randomUUID();
    const reserved = (await request({ label: 'Expiry reservation', path: 'chat-usage/reserve', method: 'POST',
      auth: token, body: { requestId } })).body;
    const expiryDeadline = now() + EXPIRY_WAIT_MS;
    check(typeof reserved?.reservationId === 'string' && reserved.reservationId.length > 0, 'Expiry reservation: missing ID.');
    check(same(totals(usage(reserved.usage, 'Reserved allowance')), [0, 1, baseline.remaining - 1, baseline.limit]),
      'Reservation did not occupy exactly one allowance.');

    // A fresh nonexistent identity exercises first-bucket creation without touching a customer.
    await batch([attempt(probeEmail, 'First-bucket race A'), attempt(probeEmail.toUpperCase(), 'First-bucket race B')]);
    const windowDeadline = now() + WINDOW_WAIT_MS;
    for (let i = 0; i < 3; i++) {
      await batch([attempt(probeEmail, 'Locked increment A'), attempt(probeEmail.toUpperCase(), 'Locked increment B')]);
    }
    await request(attempt(probeEmail, 'Ninth attempt'));
    const lastSlot = await batch([attempt(probeEmail, 'Last-slot race A', [401, 429]),
      attempt(probeEmail.toUpperCase(), 'Last-slot race B', [401, 429])]);
    check(same(lastSlot.map(result => result.status).sort(), [401, 429]),
      'Limiter last-slot race must allow exactly one attempt and reject the other.');
    await request(attempt(probeEmail, 'Exhausted bucket', [429]));
    await request(attempt(`pipechat-qa-${runId}-control@example.invalid`, 'Independent bucket control'));
    log('PASS: first-bucket and last-slot races, locked increments, case normalization and independent bucket.');

    // Signup already used the first of this QA account's ten combined attempts.
    for (let i = 0; i < 9; i++) await request(attempt(account.email, 'Combined login/signup allowance'));
    await request({ label: 'Signup shares exhausted limiter', path: 'auth/signup', method: 'POST',
      body: account, statuses: [429], captureAuth: true });
    log('PASS: login and signup share the same ten-attempt allowance.');

    await waitUntil(expiryDeadline, 'real five-minute reservation expiry');
    check(same(totals(await readUsage('Expired allowance')), totals(baseline)), 'Expired reservation still consumes allowance.');
    await finalize(reserved.reservationId, 'commit', 'Expired commit rejected', [409]);
    await request({ label: 'Expired request cannot resurrect', path: 'chat-usage/reserve', method: 'POST', auth: token,
      body: { requestId }, statuses: [409] });
    check(same(totals(await readUsage('No charge after expired retries')), totals(baseline)), 'Expired retries changed usage.');
    const fresh = (await request({ label: 'Fresh request after expiry', path: 'chat-usage/reserve', method: 'POST', auth: token,
      body: { requestId: crypto.randomUUID() } })).body;
    check(typeof fresh?.reservationId === 'string' && fresh.reservationId !== reserved.reservationId, 'Fresh reservation was not distinct.');
    check(same(totals(usage(fresh.usage, 'Fresh allowance')), [0, 1, baseline.remaining - 1, baseline.limit]),
      'Fresh reservation did not occupy exactly one allowance.');
    await finalize(fresh.reservationId, 'release', 'Release fresh reservation');
    await finalize(reserved.reservationId, 'release', 'Release expired reservation');
    check(same(totals(await readUsage('Final allowance')), totals(baseline)), 'Expiry/release charged synthetic usage.');
    log('PASS: real reservation expiry, rejected late commit/retry, recovered allowance and zero charges.');

    await waitUntil(windowDeadline, 'real fifteen-minute limiter rollover');
    await batch([attempt(probeEmail, 'Rollover race A'), attempt(probeEmail.toUpperCase(), 'Rollover race B')]);
    for (let i = 0; i < 4; i++) {
      await batch([attempt(probeEmail, 'New window increment A'), attempt(probeEmail.toUpperCase(), 'New window increment B')]);
    }
    await request(attempt(probeEmail, 'New window exhausted', [429]));
    log('PASS: real limiter rollover race resets once and allows exactly ten new attempts.');
    log('TIMED RELIABILITY CHECKS PASSED. QA records remain; passwords/tokens were not saved.');
    log('Still pending: forced database rollback, full live browser workflows, sanitized monitoring and final security review. Do not enable production readiness.');
    return { passed: true, runId, userId: profile.id, productionReady: false };
  } finally {
    for (const reservationId of reservations) {
      try { await finalize(reservationId, 'release', 'Cleanup QA reservation', [200, 401, 409]); }
      catch { log('WARNING: a synthetic reservation could not be released; it should expire within five minutes.'); }
    }
    for (const auth of tokens) {
      try { await request({ label: 'Revoke QA session', path: 'auth/logout', method: 'POST', auth, body: {}, statuses: [200, 401] }); }
      catch { log('WARNING: a QA token could not be revoked; no token was printed or saved.'); }
    }
    account.password = null;
    token = null;
    tokens.clear();
  }
}

async function main() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runReliabilityChecks({ baseUrl: process.env.XANO_API_BASE_URL, serverKey: process.env.XANO_SERVER_KEY,
      confirm: async () => {
        console.log('This opt-in test creates ONE disposable QA account and synthetic limiter/reservation records in Neelam\'s Xano workspace.');
        console.log('It uses failed synthetic logins to test races and waits for actual 5-minute/15-minute expiry (about 17 minutes total).');
        console.log('No OpenAI calls, CRM writes, customer edits, quota changes, app restarts or readiness changes. QA records remain.');
        return (await readline.question('Type TEST to authorize these test-only changes (anything else cancels): ')).trim() === 'TEST';
      }
    });
  } finally { readline.close(); }
}
if (require.main === module) main().catch(error => {
  console.error(`FAIL: ${error instanceof CheckError ? error.message : 'Unexpected runner error; raw details suppressed to protect credentials.'}`);
  console.error('Share only PASS/FAIL/WAIT/DIAGNOSTIC lines. Do not paste keys, passwords or tokens. Existing app storage was not changed.');
  process.exitCode = 1;
});
module.exports = { runReliabilityChecks, EXPIRY_WAIT_MS, WINDOW_WAIT_MS, LIMIT_MESSAGE };
