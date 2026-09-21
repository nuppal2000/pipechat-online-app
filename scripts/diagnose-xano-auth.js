const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { createInterface } = require('node:readline/promises');
const { createXanoBackend } = require('../lib/xano-backend.js');
const { WORKSPACE_API, CheckError } = require('./test-xano-live.js');

// Emit fixed categories only. Raw errors can contain SQL values, headers or credentials.
function safeErrorSummary(payload) {
  const message = [payload?.message, payload?.error].filter(value => typeof value === 'string').join(' ').toLowerCase();
  const codes = new Set(['ERROR_CODE_FATAL_ERROR', 'ERROR_CODE_INPUT_ERROR', 'ERROR_CODE_ACCESS_DENIED',
    'ERROR_CODE_UNAUTHORIZED', 'ERROR_CODE_NOT_FOUND', 'ERROR_CODE_TOO_MANY_REQUESTS', 'ERROR_CODE_STANDARD']);
  const code = codes.has(payload?.code) ? payload.code : 'UNRECOGNIZED_OR_MISSING_CODE';
  const categories = [
    ['current transaction is aborted', 'DATABASE_TRANSACTION_ABORTED'],
    ['deadlock', 'DATABASE_DEADLOCK'],
    ['duplicate key', 'DATABASE_UNIQUE_CONFLICT'],
    ['unique constraint', 'DATABASE_UNIQUE_CONFLICT'],
    ['could not serialize', 'DATABASE_SERIALIZATION_CONFLICT'],
    ['lock timeout', 'DATABASE_LOCK_TIMEOUT'],
    ['statement timeout', 'DATABASE_STATEMENT_TIMEOUT'],
    ['too many connections', 'DATABASE_CONNECTION_CAPACITY'],
    ['unable to locate', 'VARIABLE_OR_RESOURCE_LOOKUP_FAILED'],
    ['not supported', 'UNSUPPORTED_OPERATION'],
    ['invalid timestamp', 'TIMESTAMP_CONVERSION_FAILED'],
    ['numbers are required', 'INVALID_NUMERIC_OPERATION'],
    ['invalid credentials', 'INVALID_CREDENTIALS'],
    ['too many login/signup attempts', 'PIPECHAT_AUTH_LIMIT'],
    ['rate limit lock acquisition failed', 'LIMITER_ROW_NOT_ACQUIRED'],
    ['unknown error', 'UNCLASSIFIED_RUNTIME_ERROR']
  ];
  const category = categories.find(([needle]) => message.includes(needle))?.[1] || 'UNCLASSIFIED_ERROR';
  return `${code}; ${category}`;
}

async function runAuthDiagnostics({ baseUrl, serverKey, confirm, fetchImpl = fetch, wait = sleep, log = console.log } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.replace(/\/$/, '') !== WORKSPACE_API) {
    throw new CheckError('XANO_API_BASE_URL must point to the approved PipeChat group in Neelam\'s Workspace.');
  }
  try { createXanoBackend({ baseUrl, serverKey, fetchImpl }); }
  catch { throw new CheckError('Set XANO_SERVER_KEY privately in this PowerShell window first.'); }
  if (typeof confirm !== 'function') throw new CheckError('Interactive test consent is required.');
  if (!(await confirm())) {
    log('Cancelled. No requests or data changes were made.');
    return { cancelled: true };
  }
  const runId = crypto.randomUUID();
  const password = crypto.randomBytes(32).toString('base64url');
  const tokens = new Set();
  async function call(label, path, body, auth) {
    let response;
    try {
      response = await fetchImpl(`${WORKSPACE_API}/${path}`, { method: body === undefined ? 'GET' : 'POST',
        redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Accept: 'application/json', 'X-PipeChat-Key': serverKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new CheckError(`${label}: network error; raw details suppressed.`); }
    let payload;
    try { payload = await response.json(); }
    catch { throw new CheckError(`${label}: HTTP ${response.status}, non-JSON response suppressed.`); }
    if (path === 'auth/login' && typeof payload?.authToken === 'string') tokens.add(payload.authToken);
    return { status: response.status, body: payload };
  }
  async function attempt(email, label) {
    const result = await call(label, 'auth/login', { email, password });
    log(`DIAGNOSTIC: ${label}: HTTP ${result.status}; ${safeErrorSummary(result.body)}`);
    return result.status;
  }
  try {
    const health = await call('Health', 'pipechat/health');
    if (health.status !== 200 || health.body?.contract !== 'pipechat-xano-v1') {
      throw new CheckError(`Health: expected the PipeChat contract with HTTP 200, received ${health.status}.`);
    }
    log('PASS: private key accepted. No production-readiness changes.');
    const sequentialEmail = `pipechat-qa-${runId}-serial@example.invalid`;
    const raceEmail = `pipechat-qa-${runId}-race@example.invalid`;
    await wait(4000);
    const first = await attempt(sequentialEmail, 'Sequential first login');
    await wait(4000);
    const second = await attempt(sequentialEmail.toUpperCase(), 'Sequential repeat login');
    await wait(6000);
    const race = await Promise.allSettled([
      attempt(raceEmail, 'Concurrent first login A'),
      attempt(raceEmail.toUpperCase(), 'Concurrent first login B')
    ]);
    for (const result of race) {
      if (result.status === 'rejected') log(`FAIL: ${result.reason instanceof CheckError ? result.reason.message : 'Unexpected diagnostic failure; details suppressed.'}`);
    }
    log('DIAGNOSTIC COMPLETE. No accounts created, CRM writes, OpenAI calls or quota edits. Synthetic limiter rows remain.');
    return { runId, statuses: [first, second, ...race.map(result => result.status === 'fulfilled' ? result.value : null)], productionReady: false };
  } finally {
    // Normally no token can be issued for these nonexistent random identities.
    for (const token of tokens) {
      try {
        await wait(4000);
        const result = await call('Revoke unexpected QA session', 'auth/logout', {}, token);
        if (![200, 401].includes(result.status)) throw new Error();
      } catch { log('WARNING: an unexpected QA session could not be revoked; no token was printed or saved.'); }
    }
    tokens.clear();
  }
}

async function main() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runAuthDiagnostics({ baseUrl: process.env.XANO_API_BASE_URL, serverKey: process.env.XANO_SERVER_KEY,
      confirm: async () => {
        console.log('This diagnostic sends four failed logins for two fresh synthetic .invalid identities in Neelam\'s Xano workspace.');
        console.log('It creates only synthetic limiter records, not accounts. No OpenAI calls, CRM writes or existing-user edits.');
        return (await readline.question('Type TEST to authorize these test-only requests: ')).trim() === 'TEST';
      } });
  } finally { readline.close(); }
}
if (require.main === module) main().catch(error => {
  console.error(`FAIL: ${error instanceof CheckError ? error.message : 'Unexpected diagnostic error; details suppressed.'}`);
  process.exitCode = 1;
});
module.exports = { safeErrorSummary, runAuthDiagnostics };
