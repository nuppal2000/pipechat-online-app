const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReadiness } = require('../lib/readiness.js');
const { createOperationalAlerts } = require('../lib/operational-alerts.js');

test('readiness is cached, single-flight, bounded and emits only state transitions', async () => {
  let now = 0, probes = 0, fail = false;
  const lines = [];
  const readiness = createReadiness({ now: () => now, write: line => lines.push(line), probe: async () => {
    probes++; if (fail) throw new Error('PRIVATE_KEY and PRIVATE_CUSTOMER in raw provider error');
  } });
  const results = await Promise.all(Array.from({ length: 100 }, () => readiness.check()));
  assert(results.every(result => result.ok)); assert.equal(probes, 1);
  await readiness.check(); assert.equal(probes, 1);
  now = 30000; fail = true; assert.equal((await readiness.check()).ok, false);
  now = 60000; await readiness.check(); assert.equal(lines.length, 2);
  now = 90000; fail = false; assert.equal((await readiness.check()).ok, true);
  assert.deepEqual(lines.map(line => JSON.parse(line).state), ['ready', 'unavailable', 'ready']);
  assert(!lines.join('').includes('PRIVATE_'));
  for (const line of lines) assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['event', 'state', 'timestamp']);
});
test('a hanging probe returns unavailable within its deadline and aborts', async () => {
  let signal;
  const readiness = createReadiness({ timeoutMs: 20, write() {}, probe: s => { signal = s; return new Promise(() => {}); } });
  assert.deepEqual(await readiness.check(), { ok: false }); assert.equal(signal.aborted, true);
});
const event = (status = 200, durationMs = 100, route = '/api/crm-data') => ({ outcome: 'finished', status, durationMs, route, body: 'PRIVATE_CANARY', requestId: 'PRIVATE_ID' });
test('error and latency thresholds fire, deduplicate and recover with closed-schema events', () => {
  let now = 0; const lines = [];
  const alerts = createOperationalAlerts({ now: () => now, write: line => lines.push(line) });
  for (let i = 0; i < 19; i++) alerts.observe(event(503, 12000));
  assert.deepEqual(alerts.check(), { ok: true }); assert.equal(lines.length, 0);
  alerts.observe(event(503, 12000)); assert.equal(alerts.check().ok, false); assert.equal(lines.length, 2);
  alerts.observe(event(503, 12000)); assert.equal(lines.length, 2);
  now = 300001; assert.equal(alerts.check().ok, true); assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(line => JSON.parse(line).state), ['firing', 'firing', 'resolved', 'resolved']);
  assert(!lines.join('').includes('PRIVATE'));
  for (const line of lines) assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['check', 'event', 'state', 'timestamp']);
});
test('health traffic, quota/conflicts, auth rejections and aborted requests do not cause error alerts', () => {
  const alerts = createOperationalAlerts({ write() {} });
  for (let i = 0; i < 100; i++) {
    for (const status of [401, 403, 402, 409, 429]) alerts.observe(event(status));
    alerts.observe(event(503, 100000, '/api/ready'));
    alerts.observe({ ...event(503), outcome: 'aborted' });
    alerts.observe(event(503, NaN));
  }
  assert.deepEqual(alerts.check(), { ok: true });
});
test('AI latency uses a separate one-minute threshold, and broken logging does not break monitoring', () => {
  const alerts = createOperationalAlerts({ write() { throw new Error('Disk full'); } });
  for (let i = 0; i < 20; i++) alerts.observe(event(200, 30000, '/api/pipechat-ai'));
  assert.equal(alerts.check().ok, true);
  for (let i = 0; i < 20; i++) alerts.observe(event(200, 61000, '/api/pipechat-ai'));
  assert.equal(alerts.check().ok, false);
});

test('rejected traffic cannot dilute the twenty-percent server-error threshold', () => {
  const alerts = createOperationalAlerts({ write() {} });
  for (let i = 0; i < 16; i++) alerts.observe(event(200));
  for (let i = 0; i < 3; i++) alerts.observe(event(503));
  assert.equal(alerts.check().ok, true);
  for (let i = 0; i < 1000; i++) alerts.observe(event(401));
  alerts.observe(event(503));
  assert.equal(alerts.check().ok, false);
});
