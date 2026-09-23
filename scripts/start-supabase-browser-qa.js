const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { RESTORE, MODEL, SIMULATION_KEY, projectBase, identities, validateEnvironment } = require('./supabase-browser-qa-guard.cjs');

function childEnvironment(env, args) {
  if (args.length !== 1 || args[0] !== '--approved-qa') throw new Error('Explicit --approved-qa is required.');
  if (env.PIPECHAT_SUPABASE_RESTORE_QA !== undefined && !['0','1'].includes(env.PIPECHAT_SUPABASE_RESTORE_QA)) throw new Error('Invalid QA mode.');
  const restoreOnly = env.PIPECHAT_SUPABASE_RESTORE_QA === '1';
  const runId = env.PIPECHAT_QA_RUN_ID === undefined ? crypto.randomUUID() : env.PIPECHAT_QA_RUN_ID;
  const base = projectBase(restoreOnly, runId);
  if (env.SUPABASE_URL && env.SUPABASE_URL !== base || !/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(env.SUPABASE_PUBLISHABLE_KEY || '') ||
    restoreOnly && env.SUPABASE_PUBLISHABLE_KEY !== RESTORE.publishableKey) {
    throw new Error('Expected the confirmed Supabase project and a publishable key in the environment.');
  }
  identities(runId);
  const child = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (env[name]) child[name] = env[name];
  const config = { ...child, NODE_ENV: 'test', PORT: '0', PIPECHAT_HOST: '127.0.0.1',
    PIPECHAT_SUPABASE_BROWSER_QA: '1', PIPECHAT_QA_RUN_ID: runId, PIPECHAT_STORAGE_PROVIDER: 'supabase',
    PIPECHAT_SUPABASE_RESTORE_QA: restoreOnly ? '1' : '0',
    PIPECHAT_PUBLIC_ORIGIN: 'http://127.0.0.1:0', PIPECHAT_COOKIE_SECURE: 'false',
    SUPABASE_URL: base, SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
    OPENAI_API_KEY: SIMULATION_KEY, PIPECHAT_MODEL: MODEL };
  validateEnvironment(config, ['node', '--approved-qa']);
  return config;
}

function startupFailureMessage(message, healthStatus) {
  if (message?.type === 'qa-failed') return 'FAIL: QA localhost listener failed. No live app settings were changed.';
  if (message?.type !== 'qa-startup-failed' || message.stage !== 'backend-health') return null;
  const details = {
    404: 'HTTP 404: the PipeChat health function is not available through the API. Review the API schema cache; do not replay the restore.',
    401: 'HTTP 401: the public project credentials were rejected.',
    403: 'HTTP 403: access to the public health function was denied.',
    429: 'HTTP 429: the provider is rate limiting the health request.',
    200: 'HTTP 200: the health response did not satisfy the required PipeChat contract.'
  };
  return 'FAIL: QA backend health check. ' + (Number.isInteger(healthStatus) && Object.hasOwn(details, healthStatus) ? details[healthStatus] :
    'The provider or required contract is unavailable. No raw provider details printed.');
}

function runtimeFailureMessage(message) {
  if (message?.type !== 'qa-runtime-failed') return null;
  const kind = ['Error','TypeError','RangeError','ReferenceError','SyntaxError'].includes(message.kind) ? message.kind : 'Error';
  const code = ['ERR_HTTP_HEADERS_SENT','ERR_INVALID_ARG_TYPE','ERR_INVALID_CHAR','ERR_IPC_CHANNEL_CLOSED','EPIPE','ECONNRESET'].includes(message.code) ? message.code : 'UNCLASSIFIED';
  const origin = message.origin === 'UNHANDLED_REJECTION' ? message.origin : 'UNCAUGHT_EXCEPTION';
  const site = typeof message.site === 'string' && /^(server\.js|supabase-backend\.js|supabase-browser-qa-guard\.cjs):\d{1,6}:\d{1,6}$/.test(message.site) ? message.site : 'UNKNOWN';
  return `FAIL: QA runtime stopped; ${origin}; ${kind}; ${code}; ${site}. Raw details withheld.`;
}

async function main() {
  const env = childEnvironment(process.env, process.argv.slice(2));
  const child = spawn(process.execPath, ['-e', "require('./scripts/supabase-browser-qa-guard.cjs').install(); require('./server.js');", '--', '--approved-qa'], {
    cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  let ready = false, stopping = false, exited = false, killTimer, rl, healthStatus;
  const stop = () => {
    if (stopping || exited) return;
    stopping = true;
    if (child.connected) child.send({ type: 'qa-stop' }, () => {});
    else child.kill();
    killTimer = setTimeout(() => child.kill('SIGKILL'), 6500);
    killTimer.unref();
  };
  const onInterrupt = () => stop();
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  const startupTimer = setTimeout(() => {
    console.error('QA startup timed out. Verify the migrated database and publishable configuration; no credentials were printed.');
    process.exitCode = 1; stop();
  }, 25000);
  child.on('message', message => {
    const runtimeFailure = runtimeFailureMessage(message);
    if (runtimeFailure && !stopping) {
      console.error(runtimeFailure); process.exitCode = 1;
      clearTimeout(startupTimer); stop(); return;
    }
    if (!ready && !stopping) {
      if (message?.type === 'qa-health-status' && Number.isInteger(message.status) && message.status >= 100 && message.status <= 599) {
        healthStatus = message.status;
        return;
      }
      const failure = startupFailureMessage(message, healthStatus);
      if (failure) {
        console.error(failure);
        process.exitCode = 1;
        clearTimeout(startupTimer);
        stop();
        return;
      }
    }
    if (message?.type === 'qa-outage' && ready && !stopping && typeof message.enabled === 'boolean') {
      console.log(`PASS: QA-only CRM outage ${message.enabled ? 'on' : 'off'}. Supabase and the live Render app are unchanged.`);
      return;
    }
    if (message?.type !== 'qa-ready' || ready || stopping || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
    ready = true; clearTimeout(startupTimer);
    const restoreOnly = env.PIPECHAT_SUPABASE_RESTORE_QA === '1';
    console.log(restoreOnly ? 'RESTORED QA ONLY: existing-account login and CRM reads. Chat, signup and CRM/usage writes are blocked.' :
      'REAL Supabase QA storage and usage. SIMULATED AI ONLY: no OpenAI network calls.');
    console.log(`QA URL: http://127.0.0.1:${message.port}/`);
    console.log(`QA run ID: ${env.PIPECHAT_QA_RUN_ID}`);
    for (const account of identities(env.PIPECHAT_QA_RUN_ID)) console.log(`QA ${account.label.toUpperCase()} email: ${account.email}`);
    if (restoreOnly) {
      console.log('Sign into the EXISTING restored QA A/B accounts using their original passwords privately in the browser. Do not recreate users.');
      console.log('Authentication creates/refreshes/revokes test sessions and can update login metadata; CRM/schema/quotas remain unchanged.');
      console.log('The usage meter is unavailable here: its normal read RPC can expire reservations, so it is blocked too.');
      console.log('This follows the completed snapshot/rollback checks. Do not rerun full-Auth backup equality checks after login changes Auth data.');
      console.log('No source-project or OpenAI requests. No database passwords are needed.');
    } else {
      console.log('Create only these two users in Supabase Dashboard > Authentication > Users > Add user, with Auto Confirm enabled.');
      console.log('Enter disposable passwords privately in the dashboard and app Sign in form, never in this terminal or chat.');
      console.log('No accounts or CRM/usage writes are made automatically. Browser actions use real disposable QA data and quota.');
      console.log('Setup previews for Sales, Recruiting, Real Estate and Other are deterministic simulated tables.');
      console.log('Scripted chat: Add Gamma QA; Delete Gamma QA; Move Acme QA to Warm; Assign Acme QA to Neelam; Show follow-ups today; Add Contact column; fail model.');
      console.log('Unknown chat is explicitly a simulation with no action. CSV AI analysis is not simulated.');
    }
    console.log('Commands: outage on, outage off, stop. Outage blocks only this localhost app\'s CRM reads/writes after user verification.');
    console.log('Type stop or press Ctrl+C to close the local server. QA accounts/data remain; no credential files are written.');
    if (process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', line => {
        const command = line.trim().toLowerCase();
        if (command === 'stop') stop();
        else if (['outage on', 'outage off'].includes(command) && child.connected && !stopping) {
          child.send({ type: 'qa-outage', enabled: command === 'outage on' }, () => {});
        } else console.log('Commands: outage on, outage off, stop. Enter passwords in the browser, not here.');
      });
      rl.on('close', stop);
    }
  });
  await new Promise(resolve => {
    child.once('error', () => { console.error('QA process could not start. No credentials were printed.'); process.exitCode = 1; resolve(); });
    child.once('exit', (code, signal) => {
      exited = true;
      if (!ready && !stopping) console.error('QA startup failed. Verify the migrated schema and publishable environment settings.');
      if (ready && !stopping) {
        const exit = Number.isInteger(code) && code >= -2147483648 && code <= 4294967295 ? String(code) : 'unavailable';
        const reason = ['SIGINT','SIGTERM','SIGKILL','SIGABRT','SIGSEGV'].includes(signal) ? signal : 'none';
        console.error(`FAIL: QA process exited unexpectedly; exit=${exit}; signal=${reason}. No raw details printed.`);
      }
      if (!stopping) process.exitCode = 1;
      resolve();
    });
  });
  clearTimeout(startupTimer); clearTimeout(killTimer); rl?.close();
  process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
}

if (require.main === module) main().catch(() => {
  console.error('QA startup refused. Use --approved-qa, the confirmed project publishable key, and an optional UUID PIPECHAT_QA_RUN_ID. No credentials printed.');
  process.exitCode = 1;
});
module.exports = { childEnvironment, startupFailureMessage, runtimeFailureMessage, main };
