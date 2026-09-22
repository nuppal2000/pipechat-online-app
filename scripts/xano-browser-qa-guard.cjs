// Explicit, loopback-only diagnostic wrapper. Never loaded by npm start.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BackendError, snapshotResult } = require('../lib/xano-backend.js');

const BASE = 'https://x8ki-letl-twmt.n7.xano.io/api:pipechat';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const routes = new Map([
  ['pipechat/health', ['GET']], ['auth/signup', ['POST']], ['auth/login', ['POST']],
  ['auth/me', ['GET']], ['auth/logout', ['POST']], ['crm', ['GET', 'PUT']],
  ['chat-usage', ['GET']], ['chat-usage/reserve', ['POST']], ['chat-usage/finalize', ['POST']]
]);
const response = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function identities(runId) {
  assert.match(runId, UUID);
  return ['a', 'b'].map(label => ({ label, email: `browser-${runId}-${label}@example.invalid`,
    name: `PipeChat Browser QA ${runId} ${label.toUpperCase()}` }));
}

function modelReply(options) {
  const input = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
  const command = input.userCommand;
  let action = null;
  if (command === 'fail model') throw new Error('Synthetic model failure');
  if (command === 'Move Acme QA to Warm') action = { action: 'update_record', recordMatch: 'Acme QA', field: 'stage', value: 'Warm' };
  if (command === 'Add Gamma QA') action = { action: 'add_record', record: { account: 'Gamma QA', owner: 'Sarah', value: 1234 } };
  if (command === 'Delete Gamma QA') action = { action: 'delete_record', recordMatch: 'Gamma QA' };
  if (command === 'Assign Acme QA to Neelam') action = { action: 'clarify', question: 'Add Neelam as the owner?' };
  if (command === 'yes' && input.pendingClarification?.originalCommand === 'Assign Acme QA to Neelam') {
    assert(input.conversationHistory.some(item => item.content === 'Assign Acme QA to Neelam'));
    action = { action: 'update_record', recordMatch: 'Acme QA', field: 'owner', value: 'Neelam' };
  }
  if (command === 'Show follow-ups today') action = { action: 'filter_view', field: 'follow', operator: 'equals', value: 'Today' };
  return response({ output_text: JSON.stringify({ assistantMessage: 'QA simulated AI reply; real Xano storage and usage.', crmAction: action, memoryNote: null }) });
}

function restrictedFetch(nativeFetch, { pauseMs = 3000 } = {}) {
  let tail = Promise.resolve();
  return async (address, options = {}) => {
    const url = new URL(address);
    if (url.href === 'https://api.openai.com/v1/responses') return modelReply(options);
    const endpoint = url.href.startsWith(BASE + '/') ? url.href.slice(BASE.length + 1) : '';
    if (url.search || url.hash || !routes.get(endpoint)?.includes(options.method || 'GET')) {
      throw new Error('QA network destination or operation blocked');
    }
    // Serialize requests to respect the Free instance; do not silently retry writes.
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await nativeFetch(address, options);
    } finally {
      await new Promise(resolve => setTimeout(resolve, pauseMs));
      release();
    }
  };
}

function guardedBackend(real, { runId, health, artifactDir, report = console.log }) {
  const accounts = identities(runId);
  const users = new Map(), tokens = new Map(), latest = new Map();
  let outage = false, closed = false;
  const needToken = token => {
    if (closed || !tokens.has(token)) throw new BackendError('This session is not part of this QA run.', 401);
  };
  const available = () => { if (outage) throw new BackendError('QA-only simulated CRM outage. No Xano request sent.', 503); };
  const wrapped = {
    async check() {
      const result = await health();
      if (result?.contract !== 'pipechat-xano-v1' || result.status !== 'awaiting-live-verification') {
        throw new BackendError('Unexpected QA health contract; review the backend before continuing.');
      }
      report('PASS: private key accepted. QA-only pending-readiness acknowledgement; production check unchanged.');
      return { ok: true, contract: result.contract, capabilities: [], qaOnly: true };
    },
    async authenticate(mode, input) {
      const account = accounts.find(item => item.email === String(input.email).trim().toLowerCase());
      if (closed || !account || !['signup', 'login'].includes(mode) || (mode === 'login' && !users.has(account.label)) ||
          (mode === 'signup' && users.has(account.label))) {
        throw new BackendError('Use only the two fresh QA accounts printed in this test terminal.', 403);
      }
      const result = await real.authenticate(mode, { ...input, email: account.email, name: account.name });
      if (result.user.email !== account.email || result.user.name !== account.name ||
          (users.has(account.label) && users.get(account.label) !== result.user.id)) {
        await real.logout(result.token).catch(() => {});
        throw new BackendError('QA identity check failed. No CRM access granted.', 403);
      }
      users.set(account.label, result.user.id);
      tokens.set(result.token, account.label); latest.set(account.label, result.token);
      report(`PASS: QA ${account.label.toUpperCase()} ${mode}; user_id=${result.user.id}`);
      return result;
    },
    async getUser(token) { if (!token || !tokens.has(token)) return null; needToken(token); return real.getUser(token); },
    async logout(token) {
      if (!token || !tokens.has(token)) return;
      await real.logout(token);
      const label = tokens.get(token); tokens.delete(token);
      if (latest.get(label) === token) latest.delete(label);
    },
    async readCrm(token) { needToken(token); available(); return real.readCrm(token); },
    async writeCrm(token, ...args) { needToken(token); available(); return real.writeCrm(token, ...args); },
    async readUsage(token) { needToken(token); return real.readUsage(token); },
    async reserveUsage(token, ...args) { needToken(token); return real.reserveUsage(token, ...args); },
    async finishUsage(token, ...args) { needToken(token); return real.finishUsage(token, ...args); }
  };
  async function command(line) {
    const parts = line.trim().toLowerCase().split(/\s+/);
    if (parts.length === 2 && parts[0] === 'outage' && ['on', 'off'].includes(parts[1])) {
      outage = parts[1] === 'on'; report(`PASS: QA-only CRM outage ${parts[1]}. Live Xano and Render unchanged.`); return;
    }
    if (parts.length !== 2 || !['backup', 'restore', 'usage'].includes(parts[0]) || !['a', 'b'].includes(parts[1])) {
      throw new Error('Unknown QA command');
    }
    const [operation, label] = parts, token = latest.get(label);
    needToken(token); available();
    if (operation === 'usage') {
      const usage = await real.readUsage(token);
      report(`PASS: QA ${label.toUpperCase()} usage used=${usage.used}, limit=${usage.limit}, reserved=${usage.reserved}`); return;
    }
    const file = path.join(artifactDir, `qa-${label}.crm.json`);
    if (operation === 'backup') {
      const data = await real.readCrm(token);
      const backup = { format: 'pipechat-qa-crm-v1', runId, userId: users.get(label), data };
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 });
      report(`PASS: QA-only CRM backup saved (${data.deals.length} rows): ${file}`); return;
    }
    const backup = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(backup.format, 'pipechat-qa-crm-v1'); assert.equal(backup.runId, runId); assert.equal(backup.userId, users.get(label));
    const data = snapshotResult(backup.data), current = await real.readCrm(token);
    const usageBefore = await real.readUsage(token);
    await real.writeCrm(token, data.deals, current.updatedAt);
    const restored = await real.readCrm(token);
    assert.deepEqual(restored.deals, data.deals);
    const usageAfter = await real.readUsage(token);
    for (const key of ['used', 'limit', 'reserved']) assert.equal(usageAfter[key], usageBefore[key]);
    report(`PASS: QA ${label.toUpperCase()} CRM restore read-back matched all fields; usage unchanged. This is not a full workspace restore.`);
  }
  async function close() {
    closed = true;
    for (const token of [...tokens.keys()]) {
      try { await real.logout(token); tokens.delete(token); }
      catch { report('WARN: QA session revocation failed; token expiry still applies.'); }
    }
  }
  return { wrapped, command, close };
}

function install() {
  assert.equal(process.env.PIPECHAT_LIVE_BROWSER_QA, '1');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.PIPECHAT_HOST, '127.0.0.1');
  assert.equal(process.env.XANO_API_BASE_URL, BASE);
  assert.equal(process.env.PIPECHAT_STORAGE_PROVIDER, 'xano');
  assert.match(process.env.PIPECHAT_QA_RUN_ID, UUID);
  assert.equal(process.env.PIPECHAT_SESSION_COOKIE, `pipechat_qa_${process.env.PIPECHAT_QA_RUN_ID}`);
  assert.equal(process.env.PIPECHAT_PUBLIC_ORIGIN, `http://127.0.0.1:${process.env.PORT}`);
  assert.equal(process.env.OPENAI_API_KEY, 'qa-simulation-not-a-real-key');
  const nativeFetch = global.fetch;
  global.fetch = restrictedFetch(nativeFetch);
  const adapter = require('../lib/xano-backend.js'), original = adapter.createXanoBackend;
  let harness;
  adapter.createXanoBackend = config => {
    const real = original(config);
    harness = guardedBackend(real, { runId: process.env.PIPECHAT_QA_RUN_ID, artifactDir: process.env.PIPECHAT_QA_ARTIFACT_DIR,
      health: async () => {
        const res = await global.fetch(`${BASE}/pipechat/health`, { headers: { 'X-PipeChat-Key': config.serverKey },
          redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new BackendError('Private QA connection rejected. Check the server key.');
        return res.json();
      } });
    return { ...harness.wrapped, async check() {
      try { return await harness.wrapped.check(); }
      catch (error) { setImmediate(() => process.exit(1)); throw error; }
    } };
  };
  let commands = Promise.resolve(), stopping = false;
  process.on('message', message => {
    if (message?.command === 'stop') {
      if (stopping) return; stopping = true;
      commands = commands.then(async () => { await harness?.close(); process.exit(0); });
    } else if (typeof message?.command === 'string' && !stopping) {
      commands = commands.then(() => harness.command(message.command))
        .catch(() => console.log('FAIL: QA command did not complete. No raw response or credentials printed.'));
    }
  });
  process.on('disconnect', () => { harness?.close().finally(() => process.exit(0)); });
}

module.exports = { BASE, identities, modelReply, restrictedFetch, guardedBackend, install };
