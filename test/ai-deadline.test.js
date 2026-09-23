const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const serverPath = path.join(__dirname, '../server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const serverRequire = createRequire(serverPath);
const startup = source.lastIndexOf('start().catch(');
assert(startup > 0, 'Locate startup without changing the production request handler');
const action = { assistantMessage: 'Offline reply', crmAction: null, memoryNote: null };
const modelData = { output_text: JSON.stringify(action) };
const secret = 'TEST_ONLY_PROVIDER_DETAIL_DO_NOT_EXPOSE';
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fakeClock() {
  let now = 0, nextId = 1;
  const timers = new Map(), delays = [];
  return {
    delays, timers,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, due: now + delay });
      delays.push(delay);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now && timers.delete(id)) timer.callback();
      }
    }
  };
}

function harness(provider, fetchImpl, { failRelease = false } = {}) {
  const clock = fakeClock(), calls = [], requests = [];
  const meter = { used: 0, reserved: 0 };
  let handler;
  const usage = () => ({ ...meter, limit: 1, remaining: 1 - meter.used - meter.reserved,
    paymentRequired: meter.used + meter.reserved === 1, updatedAt: null });
  const backend = {
    async getUser() { return { id: 'offline-user', email: 'offline@example.invalid', name: 'Offline' }; },
    async reserveUsage(token, requestId) {
      assert.equal(typeof requestId, 'string');
      assert.equal(meter.used + meter.reserved, 0);
      calls.push('reserve'); meter.reserved++;
      return { reservationId: 'offline-reservation', usage: usage() };
    },
    async finishUsage(token, reservationId, outcome) {
      assert.equal(reservationId, 'offline-reservation');
      calls.push(outcome);
      if (failRelease && outcome === 'release') throw new Error(secret);
      assert.equal(meter.reserved, 1);
      meter.reserved--;
      if (outcome === 'commit') meter.used++;
      return usage();
    }
  };
  const context = {
    __dirname: path.dirname(serverPath), Buffer, URL, structuredClone, AbortController, AbortSignal,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    process: { env: { PIPECHAT_STORAGE_PROVIDER: provider, OPENAI_API_KEY: 'TEST_ONLY_OFFLINE_KEY',
      PIPECHAT_PUBLIC_ORIGIN: 'https://pipechat.example.invalid', NODE_ENV: 'test' } },
    fetch: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      requests.push({ url, options });
      return fetchImpl(url, options);
    },
    require(name) {
      if (name === 'node:http') return { createServer(callback) { handler = callback; return {}; } };
      if (name === './lib/request-monitor.js') return { monitorRequest() {} };
      if (name === './lib/xano-backend.js') return { ...serverRequire(name), createXanoBackend: () => backend };
      if (name === './lib/supabase-backend.js') return { createSupabaseBackend: () => ({ forRequest: () => backend }) };
      return serverRequire(name);
    }
  };
  // Execute the real route and model code, but never start a listener or a backend probe.
  vm.runInNewContext(source.slice(0, startup) + '\nglobalThis.planForTest = planPipeChatAction;', context, { filename: serverPath });

  async function request() {
    const req = new EventEmitter();
    req.method = 'POST'; req.url = '/api/pipechat-ai';
    req.headers = { host: 'pipechat.example.invalid', origin: 'https://pipechat.example.invalid',
      'content-type': 'application/json', cookie: 'pipechat_xano_session=offline-session' };
    const headers = new Map();
    const res = {
      ended: false,
      setHeader(name, value) { headers.set(name.toLowerCase(), value); },
      writeHead(status, extra) { this.status = status; for (const [name, value] of Object.entries(extra)) this.setHeader(name, value); },
      end(body) { this.body = JSON.parse(body); this.ended = true; }
    };
    const done = handler(req, res);
    await settle();
    assert(req.listenerCount('data') > 0, 'Authentication reaches the real request-body reader');
    req.emit('data', Buffer.from(JSON.stringify({ userCommand: 'Offline timeout probe' })));
    req.emit('end');
    await settle();
    return { done, res };
  }
  return { clock, calls, requests, meter, request, plan: context.planForTest };
}

function assertReleased(h, res) {
  assert.equal(res.status, 502);
  assert.match(res.body.error, /AI request failed/);
  assert(!JSON.stringify(res.body).includes(secret));
  assert.equal(res.body.assistantMessage, undefined);
  assert.deepEqual(h.calls, ['reserve', 'release']);
  assert.deepEqual(h.meter, { used: 0, reserved: 0 });
  assert.equal(res.body.usage.remaining, 1);
  assert.equal(h.requests.length, 1, 'Never retry the paid model call');
  assert.equal(h.clock.timers.size, 0);
}

for (const provider of ['supabase', 'xano']) {
  test(`${provider}: stalled fetch aborts at the unchanged 80-second deadline and releases quota`, { timeout: 2000 }, async () => {
    const h = harness(provider, async () => new Promise(() => {}));
    const { done, res } = await h.request();
    assert.deepEqual(h.clock.delays, [80000]);
    assert.equal(h.requests[0].options.signal.aborted, false);
    h.clock.advance(79999); await settle();
    assert.equal(res.ended, false);
    h.clock.advance(1); await done;
    assert.equal(h.requests[0].options.signal.aborted, true);
    assertReleased(h, res);
  });

  test(`${provider}: stalled JSON body shares the fetch deadline rather than receiving a new timeout`, { timeout: 2000 }, async () => {
    const headers = deferred();
    let bodyReads = 0;
    const h = harness(provider, () => headers.promise);
    const { done, res } = await h.request();
    h.clock.advance(40000);
    headers.resolve({ ok: true, json: async () => { bodyReads++; return new Promise(() => {}); } });
    await settle();
    assert.equal(bodyReads, 1);
    assert.deepEqual(h.clock.delays, [80000]);
    h.clock.advance(39999); await settle();
    assert.equal(res.ended, false);
    h.clock.advance(1); await done;
    assert.equal(h.requests[0].options.signal.aborted, true);
    assertReleased(h, res);
  });

  test(`${provider}: success just before the deadline commits once and clears the timer`, { timeout: 2000 }, async () => {
    const body = deferred();
    const h = harness(provider, async () => ({ ok: true, json: () => body.promise }));
    const { done, res } = await h.request();
    h.clock.advance(79999); body.resolve(modelData); await done;
    assert.equal(res.status, 200);
    assert.equal(res.body.assistantMessage, action.assistantMessage);
    assert.deepEqual(h.calls, ['reserve', 'commit']);
    assert.deepEqual(h.meter, { used: 1, reserved: 0 });
    assert.equal(res.body.usage.remaining, 0);
    assert.equal(h.clock.timers.size, 0);
    h.clock.advance(1); await settle();
    assert.equal(h.requests[0].options.signal.aborted, false);
    assert.equal(h.requests.length, 1);
  });

  test(`${provider}: late headers cannot resume body consumption or commit a released reservation`, { timeout: 2000 }, async () => {
    const headers = deferred();
    let bodyReads = 0;
    const h = harness(provider, () => headers.promise);
    const { done, res } = await h.request();
    h.clock.advance(80000); await done;
    headers.resolve({ ok: true, json: async () => { bodyReads++; return modelData; } });
    await settle();
    assert.equal(bodyReads, 0);
    assertReleased(h, res);
  });

  test(`${provider}: a late body cannot return model output or charge after timeout`, { timeout: 2000 }, async () => {
    const body = deferred();
    const h = harness(provider, async () => ({ ok: true, json: () => body.promise }));
    const { done, res } = await h.request();
    h.clock.advance(80000); await done;
    body.resolve(modelData); await settle();
    assertReleased(h, res);
  });

  test(`${provider}: provider and JSON failures clean up the timer without leaking details`, { timeout: 2000 }, async () => {
    for (const fetchImpl of [
      async () => { throw new Error(secret); },
      async () => ({ ok: true, json: async () => { throw new SyntaxError(secret); } }),
      async () => ({ ok: false, status: 429, json: async () => ({ error: secret }) })
    ]) {
      const h = harness(provider, fetchImpl);
      const { done, res } = await h.request(); await done;
      assertReleased(h, res);
      h.clock.advance(80000); await settle();
      assert.equal(h.requests[0].options.signal.aborted, false);
    }
  });

  test(`${provider}: a failed release after timeout still returns sanitized failure without retrying AI`, { timeout: 2000 }, async () => {
    const h = harness(provider, async () => new Promise(() => {}), { failRelease: true });
    const { done, res } = await h.request();
    h.clock.advance(80000); await done;
    assert.equal(res.status, 502);
    assert.match(res.body.error, /expires within five minutes/);
    assert(!JSON.stringify(res.body).includes(secret));
    assert.equal(res.body.usage, undefined);
    assert.deepEqual(h.calls, ['reserve', 'release']);
    assert.deepEqual(h.meter, { used: 0, reserved: 1 });
    assert.equal(h.requests.length, 1);
    assert.equal(h.clock.timers.size, 0);
  });
}

test('JSON-only backend retains its existing model request behavior', { timeout: 2000 }, async () => {
  const h = harness('json', async () => ({ ok: true, json: async () => modelData }));
  assert.equal((await h.plan({ userCommand: 'Offline local probe' })).assistantMessage, action.assistantMessage);
  assert.equal(h.requests[0].options.signal, undefined);
  assert.deepEqual(h.clock.delays, []);
});
