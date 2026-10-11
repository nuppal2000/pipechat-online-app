'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { sanitizeEvent, createBetaTelemetry, createSqlTelemetrySink } = require('../lib/beta-telemetry');

const event = () => ({ requestId: randomUUID(), conversationId: randomUUID(), planId: randomUUID(),
  actionId: randomUUID(), stage: 'model', attempt: 0, outcome: 'succeeded', latencyMs: 218,
  model: 'primary', usage: { inputTokens: 100, outputTokens: 30, cachedTokens: 20 } });

test('allowlist removes raw text, emails, tokens, arbitrary nested metadata and provider errors', () => {
  const input = { ...event(), prompt: 'private customer text', email: 'person@example.test',
    authorization: 'Bearer secret', apiKey: 'sk-secret', error: { message: 'private error' },
    model: 'person@example.test', errorCode: 'sk-secret',
    usage: { inputTokens: 100, outputTokens: 30, cachedTokens: 20, raw: 'private token' } };
  const safe = sanitizeEvent(input), text = JSON.stringify(safe);
  assert.equal(Object.keys(safe).length, 15);
  assert.equal(safe.model, 'unknown'); assert.equal(safe.errorCode, 'unknown');
  assert.equal(safe.inputTokens, 100); assert.equal(safe.outputTokens, 30); assert.equal(safe.cachedTokens, 20);
  assert.doesNotMatch(text, /private|person@|Bearer|sk-secret/);
  assert.equal(safe.requestId, input.requestId); assert.equal(safe.conversationId, input.conversationId);
  assert.equal(safe.planId, input.planId); assert.equal(safe.actionId, input.actionId);
  assert(Object.isFrozen(safe));
  for (const model of ['gpt-5.4-mini', 'gpt-5.2']) assert.equal(sanitizeEvent({ ...event(), model }).model, model);
});

test('identity is stable per request/stage/attempt and independent of mutable outcome', () => {
  const input = event(), safe = sanitizeEvent(input);
  assert.equal(sanitizeEvent({ ...input, requestId: input.requestId.toUpperCase() }).eventId, safe.eventId);
  assert.equal(sanitizeEvent({ ...input, outcome: 'failed', latencyMs: 999 }).eventId, safe.eventId);
  assert.notEqual(sanitizeEvent({ ...input, attempt: 1 }).eventId, safe.eventId);
  assert.notEqual(sanitizeEvent({ ...input, stage: 'turn' }).eventId, safe.eventId);
});

test('missing metrics remain unknown, invalid metrics and correlations never reach sink', async () => {
  const input = event(), safe = sanitizeEvent({ ...input, usage: undefined });
  assert.equal(safe.inputTokens, null); assert.equal(safe.outputTokens, null); assert.equal(safe.cachedTokens, null);
  const telemetry = createBetaTelemetry({ sink: { append() { assert.fail('invalid event persisted'); } } });
  for (const patch of [{ requestId: 'email@example.test' }, { actionId: 'sk-secret' }, { latencyMs: Infinity },
    { latencyMs: -1 }, { latencyMs: 0.5 }, { stage: 'raw prompt' }, { outcome: 'any text' }, { attempt: 10001 },
    { usage: { inputTokens: 2, cachedTokens: 3 } }, { usage: { outputTokens: '30' } }]) {
    await assert.rejects(telemetry.record({ ...input, ...patch }), /Invalid telemetry/);
  }
});

test('safe projection ignores unknown accessors and rejects allowed accessors', () => {
  const input = event();
  Object.defineProperty(input, 'rawText', { get() { assert.fail('read untrusted text'); } });
  assert.equal(sanitizeEvent(input).latencyMs, 218);
  Object.defineProperty(input, 'latencyMs', { get() { assert.fail('invoked getter'); } });
  assert.throws(() => sanitizeEvent(input), /Invalid telemetry/);
});

test('requires an acknowledged durable sink and propagates failures for durable retry', async () => {
  assert.throws(() => createBetaTelemetry(), /durable telemetry sink/);
  assert.throws(() => createSqlTelemetrySink({}), /SQL query/);
  const failed = createBetaTelemetry({ sink: { async append() { throw new Error('sink unavailable'); } } });
  await assert.rejects(failed.record(event()), /sink unavailable/);
  await assert.rejects(createBetaTelemetry({ sink: { async append() { return {}; } } }).record(event()), /not acknowledged/);
});

test('prepared events can cross a durable outbox boundary and SQL uses parameters only', async () => {
  let saved;
  const sink = createSqlTelemetrySink({ async query(sql, params) {
    assert.equal(sql, 'select public.pipechat_record_beta_event($1::jsonb) as receipt');
    assert.equal(params.length, 1); saved = JSON.parse(params[0]);
    return { rows: [{ receipt: { eventId: saved.eventId, inserted: true } }] };
  } });
  const telemetry = createBetaTelemetry({ sink }), prepared = JSON.parse(JSON.stringify(telemetry.prepare(event())));
  const result = await telemetry.persist({ ...prepared, prompt: 'never persist' });
  assert.equal(result.inserted, true); assert.equal(saved.inputTokens, 100);
  assert.deepEqual(saved, prepared);
  await assert.rejects(telemetry.persist({ ...prepared, eventId: randomUUID() }), /Invalid telemetry/);
  await assert.rejects(telemetry.persist({ ...prepared, formatVersion: 2 }), /Invalid telemetry/);
  Object.defineProperty(prepared, 'rawText', { enumerable: true, get() { assert.fail('read ignored getter'); } });
  assert.equal((await telemetry.persist(prepared)).inserted, true);
});
