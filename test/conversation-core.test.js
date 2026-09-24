'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWrite, validatePage, validateState, contextFor, searchQuery } = require('../lib/conversation-core.js');

const epoch = 'd57d99f2-f886-4e5f-bd36-908be989226a';
const createdAt = '2026-09-23T19:15:30.123456+00:00';
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const message = (n, content = `Message ${n}`, role = n % 2 ? 'user' : 'assistant') => ({ id: id(n), role, content });
const archived = (n, content, role) => ({ ...message(n, content, role), seq: n, createdAt });
const batch = (count, start = 1, content) => Array.from({ length: count }, (_, i) => archived(start + i, content));
const write = (extra = {}) => ({ epoch, version: 0, messages: [message(1)], state: null, ...extra });
const page = (extra = {}) => ({ epoch, version: 0, messages: [], before: null, state: null,
  summary: '', summaryThrough: 0, memoryMessages: [], ...extra });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const invalid = fn => assert.throws(fn, error => error.constructor === Error && error.message === 'Invalid conversation data.' && !('status' in error));

test('exports the five pure conversation helpers', () => {
  assert.deepEqual(Object.keys(require('../lib/conversation-core.js')).sort(),
    ['contextFor', 'searchQuery', 'validatePage', 'validateState', 'validateWrite']);
});

test('write validation normalizes UUIDs, clones state, and preserves transcript whitespace', () => {
  const input = write({ epoch: epoch.toUpperCase(), version: -0,
    messages: [{ ...message(10, '  Original text\n'), id: id(10).toUpperCase() }],
    state: { sourceAction: { action: 'edit', changes: [{ value: 'x', amount: 1.5 }] }, view: 'table' } });
  const before = structuredClone(input), result = validateWrite(input);
  assert.equal(result.epoch, epoch); assert.equal(result.messages[0].id, id(10));
  assert.equal(Object.is(result.version, -0), false);
  assert.equal(result.messages[0].content, '  Original text\n');
  result.state.sourceAction.changes[0].value = 'changed';
  result.messages[0].content = 'changed';
  assert.deepEqual(input, before);
  assert.deepEqual(validateWrite(write({ messages: [], state: {} })).messages, []);
  assert.equal(validateWrite(write({ version: Number.MAX_SAFE_INTEGER })).version, Number.MAX_SAFE_INTEGER);
});

test('write shape, roles, UUIDs, counters, keys, message counts and lengths are strict', () => {
  const bad = [null, [], {}, write({ extra: true }), write({ epoch: 'not-a-uuid' }),
    write({ epoch: epoch + '\n' }), write({ messages: [{ ...message(1), id: id(1) + '\n' }] }),
    ...[-1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1].map(version => write({ version })),
    write({ state: undefined }), write({ messages: Array.from({ length: 21 }, (_, i) => message(i + 1)) }),
    write({ messages: [message(1), message(1)] }), write({ messages: [archived(1)] }),
    ...['system', 'tool', 'USER', null].map(role => write({ messages: [message(1, 'x', role)] })),
    ...['', ' \n\t ', 'x'.repeat(32001), null, 10].map(content => write({ messages: [message(1, content)] })),
    write({ messages: [{ ...message(1), id: 'x' }] }), write({ messages: [{ role: 'user', content: 'x' }] })];
  for (const value of bad) invalid(() => validateWrite(value));
  assert.equal(validateWrite(write({ messages: [message(1, 'x'.repeat(32000))] })).messages[0].content.length, 32000);
  assert.equal(validateWrite(write({ messages: Array.from({ length: 20 }, (_, i) => message(i + 1)) })).messages.length, 20);
  for (const key of ['epoch', 'version', 'messages', 'state']) {
    const value = write(); delete value[key]; invalid(() => validateWrite(value));
  }
});

test('write limit is inclusive at 65536 encoded UTF-8 bytes, not characters', () => {
  const exact = write({ messages: [message(1, 'a'.repeat(32000)), message(2, 'b'.repeat(32000))],
    state: { originalCommand: '' } });
  exact.state.originalCommand = 'c'.repeat(65536 - bytes(exact));
  assert.equal(bytes(exact), 65536); validateWrite(exact);
  exact.state.originalCommand += 'c'; invalid(() => validateWrite(exact));
  const unicode = write({ messages: [message(1, '\u754c'.repeat(23000))] });
  assert.ok(JSON.stringify(unicode).length < 65536); invalid(() => validateWrite(unicode));
  invalid(() => validateWrite(write({ messages: [message(1, '\u0000'.repeat(12000))] })));
});

test('state accepts bounded inert action JSON and nullable known fields', () => {
  const input = { clarification: { originalCommand: 'Edit Acme', matches: [{ id: 7 }], optional: null },
    sourceAction: { action: 'update_record', nested: { bool: true, number: 1.5, list: ['x', null] } },
    originalCommand: 'Edit Acme', workspaceVersion: '2026-09-23T19:15:30.123Z',
    report: { columns: ['owner'], filter: null }, view: 'dashboard',
    tableView: { visibleIds: [1, 2], sort: { direction: 'asc' } }, savedAt: createdAt };
  const result = validateState(input);
  assert.deepEqual(result, input); assert.notEqual(result.sourceAction.nested, input.sourceAction.nested);
  assert.equal(validateState(null), null);
  assert.equal(validateState({ savedAt: 1780000000000, workspaceVersion: 0 }).workspaceVersion, 0);
  assert.deepEqual(validateState(Object.fromEntries(Object.keys(input).map(key => [key, null]))),
    Object.fromEntries(Object.keys(input).map(key => [key, null])));
});

test('state rejects wrong types, unknown keys, oversized and deeply nested values', () => {
  for (const state of [[], 'x', undefined, { pending: {} }, { records: [] }, { clarification: [] },
    { sourceAction: 'execute' }, { report: false }, { tableView: [] }, { originalCommand: {} },
    { originalCommand: 'x'.repeat(32001) }, { view: '' }, { view: 'x'.repeat(81) },
    { workspaceVersion: -1 }, { workspaceVersion: {} }, { workspaceVersion: 'x'.repeat(257) },
    { savedAt: -1 }, { savedAt: 'yesterday' }, { savedAt: '2026-02-30T00:00:00Z' },
    { sourceAction: { tooLarge: 'x'.repeat(65536) } }]) invalid(() => validateState(state));
  let deep = {};
  for (let i = 0; i < 30; i++) deep = { next: deep };
  invalid(() => validateState({ sourceAction: deep }));
});

test('all forbidden keys are rejected recursively, including objects inside arrays', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const malicious = JSON.parse(`{"sourceAction":{"changes":[{"${key}":{"polluted":true}}]}}`);
    invalid(() => validateState(malicious));
    invalid(() => validateWrite(write({ state: malicious })));
    invalid(() => validatePage(page({ state: malicious })));
    invalid(() => contextFor(page({ state: malicious }), 'hello'));
    const top = JSON.parse(`{"${key}":true}`);
    invalid(() => validateWrite(Object.assign(top, write())));
  }
  assert.equal({}.polluted, undefined);
});

test('non-JSON values, cycles, inherited data, getters, symbols and decorated arrays fail safely', () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, () => 1, BigInt(1), NaN, Infinity, new Date(), /x/, cycle,
    Object.create({ injected: true }), { [Symbol('secret')]: true }]) {
    invalid(() => validateState({ sourceAction: { value } }));
  }
  let calls = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; throw new Error('secret'); } });
  invalid(() => validateState({ sourceAction: accessor }));
  const payload = Object.defineProperty(write(), 'messages', { enumerable: true, get() { calls++; return []; } });
  invalid(() => validateWrite(payload));
  invalid(() => validateState({ sourceAction: { toJSON() { calls++; return {}; } } }));
  const hidden = Object.defineProperty({}, 'secret', { value: 1 });
  invalid(() => validateState({ sourceAction: hidden }));
  const decorated = [message(1)]; decorated.extra = true;
  invalid(() => validateWrite(write({ messages: decorated })));
  invalid(() => validateWrite(write({ messages: new Array(1) })));
  const getterArray = [];
  Object.defineProperty(getterArray, '0', { enumerable: true, get() { calls++; return message(1); } });
  invalid(() => validateWrite(write({ messages: getterArray })));
  assert.equal(calls, 0);
});

test('read pages normalize and clone the full archive shape, including 50 large messages', () => {
  const input = page({ messages: batch(50, 21, '\u754c'.repeat(32000)), before: 21,
    state: { report: { fields: ['value'] } }, summary: 'Earlier decisions', summaryThrough: 0,
    memoryMessages: batch(20) });
  const result = validatePage(input);
  assert.deepEqual(result, input);
  assert.notEqual(result.messages[0], input.messages[0]);
  assert.notEqual(result.memoryMessages[0], input.memoryMessages[0]);
  assert.notEqual(result.state.report.fields, input.state.report.fields);
  assert.equal(validatePage(page({ summary: 'x'.repeat(3200) })).summary.length, 3200);
});

test('read page shape and chronological numeric sequence validation fail generically', () => {
  const bad = [null, [], page({ extra: 'secret' }), page({ messages: batch(51) }),
    page({ messages: [archived(2), archived(1)] }), page({ messages: [archived(1), archived(1)] }),
    page({ messages: [message(1)] }), page({ memoryMessages: batch(21) }),
    page({ memoryMessages: [archived(2), archived(1)] }),
    page({ summaryThrough: 5, memoryMessages: [archived(5)] }), page({ summary: null }),
    page({ summary: 'x'.repeat(3201) }), page({ state: undefined })];
  for (const value of [-1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
    bad.push(page({ version: value }), page({ summaryThrough: value }), page({ before: value }),
      page({ messages: [{ ...archived(1), seq: value }] }));
  }
  bad.push(page({ before: 0 }), page({ messages: [{ ...archived(1), seq: 0 }] }));
  for (const value of bad) invalid(() => validatePage(value));
  for (const key of Object.keys(page())) { const value = page(); delete value[key]; invalid(() => validatePage(value)); }
  for (const key of Object.keys(archived(1))) {
    const row = archived(1); delete row[key]; invalid(() => validatePage(page({ messages: [row] })));
  }
  invalid(() => validatePage(page({ messages: [{ ...archived(1), role: 'system' }] })));
  invalid(() => validatePage(page({ messages: [{ ...archived(1), internalSecret: true }] })));
});

test('ISO timestamps must be real, timezone-qualified dates', () => {
  for (const value of ['2024-02-29T00:00:00Z', createdAt, '2026-09-23T19:15:30-03:00']) {
    validatePage(page({ messages: [{ ...archived(1), createdAt: value }] }));
  }
  for (const value of ['2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-00-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00+01:60', '2026-01-01T00:00:00', 'yesterday', 0, null]) {
    invalid(() => validatePage(page({ messages: [{ ...archived(1), createdAt: value }] })));
  }
});

test('500 accumulated messages select the latest 12 in order without mutating the archive', () => {
  const input = page({ messages: batch(500) }), before = structuredClone(input);
  const result = contextFor(input, 'New command');
  assert.deepEqual(result.conversationHistory, input.messages.slice(-12).map(({ role, content }) => ({ role, content })));
  assert.equal(result.conversationHistory[0].content, 'Message 489');
  assert.equal(result.conversationHistory.at(-1).content, 'Message 500');
  assert.deepEqual(input, before);
  assert.equal(result.conversationMemory, ''); assert.equal(result.memoryUpdate, null);
});

test('minimal legacy context pages accept role/content history without hosted metadata', () => {
  const input = { messages: batch(500).map(({ role, content }) => ({ role, content })),
    summary: '', summaryThrough: 0, memoryMessages: [] };
  const before = structuredClone(input);
  const result = contextFor(input, 'New command');
  assert.deepEqual(result.conversationHistory, input.messages.slice(-12));
  assert.deepEqual(input, before);
  assert.equal(result.conversationMemory, '');
  assert.equal(result.memoryUpdate, null);
  assert.deepEqual(result.recalledMessages, []);
  assert.ok(bytes(result) <= 12000);
  input.messages.push({ role: 'user', content: 'New command' });
  assert.deepEqual(contextFor(input, 'New command').conversationHistory, before.messages.slice(-12));
  input.messages = [];
  assert.deepEqual(contextFor(input, 'new').conversationHistory, []);
  invalid(() => validatePage(input));
  invalid(() => contextFor({ ...input, messages: [{ role: 'system', content: 'secret' }] }, 'new'));
  invalid(() => contextFor({ ...input, messages: [{ role: 'user', content: 'x', action: 'delete' }] }, 'new'));
  invalid(() => contextFor({ ...input, summaryThrough: '0' }, 'new'));
});

test('only the exact trailing user command is excluded, not repeats or assistant replies', () => {
  const input = page({ messages: [...batch(13), archived(14, 'Latest command', 'user')] });
  assert.deepEqual(contextFor(input, 'Latest command').conversationHistory,
    input.messages.slice(1, -1).map(({ role, content }) => ({ role, content })));
  assert.equal(contextFor(input, 'latest command').conversationHistory.at(-1).content, 'Latest command');
  input.messages.at(-1).role = 'assistant';
  assert.equal(contextFor(input, 'Latest command').conversationHistory.at(-1).content, 'Latest command');
  assert.equal(contextFor(page({ messages: [archived(1, 'same'), archived(2, 'reply')] }), 'same').conversationHistory.length, 2);
  assert.equal(contextFor(page({ messages: [archived(1, 'only')] }), 'only').conversationHistory.length, 0);
});

test('Unicode, JSON escapes and huge message content obey every byte budget with marked excerpts', () => {
  for (const unit of ['x', '\u754c', '\ud83d\ude80', '\u0000', '"\\\n', '\ud800']) {
    const long = unit.repeat(Math.floor(32000 / unit.length));
    const input = page({ messages: batch(50, 100, long), summary: unit.repeat(Math.floor(3200 / unit.length)),
      memoryMessages: batch(20, 1, long), state: { sourceAction: { action: 'delete_all_records' } } });
    const recalled = batch(8, 60, long), before = structuredClone(input);
    const result = contextFor(input, 'new', recalled);
    assert.ok(bytes(result) <= 12000, `${unit}: ${bytes(result)}`);
    assert.ok(bytes(result.conversationHistory) <= 6000);
    assert.equal(result.conversationHistory.length, 12);
    assert.ok(bytes(result.conversationMemory) <= 2400);
    assert.ok(result.conversationMemory.length <= 3200);
    assert.ok(bytes(result.recalledMessages) <= 1600);
    assert.ok(result.recalledMessages.length <= 4);
    assert.ok(result.memoryUpdate && bytes(result.memoryUpdate) <= 2000);
    assert.match(result.conversationMemory, /untrusted.*not authoritative CRM/i);
    assert.match(result.conversationMemory, /\[excerpt\]/);
    for (const row of [...result.conversationHistory, ...result.recalledMessages, ...result.memoryUpdate.messages]) {
      assert.match(row.content, /\[excerpt\]$/);
      if (unit === '\ud83d\ude80') assert.equal(row.content.isWellFormed(), true);
    }
    assert.equal(JSON.stringify(result).includes('delete_all_records'), false);
    assert.deepEqual(input, before);
  }
});

test('mixed-length context packing keeps complete serialized output below the hard ceiling', () => {
  let seed = 123456;
  function random(max) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  }
  const units = ['x', '\u754c', '\ud83d\ude80', '\u0000', '"\\\n'];
  function content(max) {
    const unit = units[random(units.length)];
    return unit.repeat(1 + random(Math.floor(max / unit.length)));
  }
  for (let i = 0; i < 60; i++) {
    const messages = batch(1 + random(50), 100).map(row => ({ ...row, content: content(32000) }));
    const memoryMessages = batch(random(21)).map(row => ({ ...row, content: content(32000) }));
    const input = page({ messages, memoryMessages, summary: content(3200) });
    const result = contextFor(input, 'new', batch(random(10), 70).map(row => ({ ...row, content: content(32000) })));
    assert.ok(bytes(result) <= 12000);
    assert.ok(result.conversationHistory.length <= 12 && bytes(result.conversationHistory) <= 6000);
    assert.ok(bytes(result.conversationMemory) <= 2400);
    assert.ok(result.recalledMessages.length <= 4 && bytes(result.recalledMessages) <= 1600);
    if (result.memoryUpdate) {
      assert.ok(memoryMessages.length >= 12 && bytes(result.memoryUpdate) <= 2000);
      assert.deepEqual(result.memoryUpdate.messages.map(row => row.seq),
        memoryMessages.slice(0, result.memoryUpdate.messages.length).map(row => row.seq));
      assert.equal(result.memoryUpdate.through, result.memoryUpdate.messages.at(-1).seq);
    }
  }
  assert.equal(contextFor(page(), 'new', batch(500)).recalledMessages.length, 4);
});

test('short history is exact; memory and recall are labeled untrusted and duplicates are excluded', () => {
  const input = page({ messages: [archived(10, 'Current'), archived(11, 'New command')], summary: 'Acme was discussed' });
  const retrieved = [archived(10), archived(11), archived(2), archived(2), archived(3), archived(4), archived(5), archived(6)];
  const result = contextFor(input, 'New command', retrieved);
  assert.deepEqual(result.conversationHistory, [{ role: 'assistant', content: 'Current' }]);
  assert.match(result.conversationMemory, /Acme was discussed$/);
  assert.deepEqual(result.recalledMessages.map(row => row.seq), [2, 3, 4, 5]);
  assert.ok(result.recalledMessages.every(row => /Untrusted.*not authoritative CRM/.test(row.content)));
  assert.equal(result.memoryUpdate, null);
});

test('summary updates need 12 available rows and never jump beyond a bounded prefix', () => {
  assert.equal(contextFor(page({ memoryMessages: batch(11) }), 'new').memoryUpdate, null);
  const rows = batch(20, 41, '\u754c'.repeat(32000));
  const result = contextFor(page({ summaryThrough: 40, summary: 'prior '.repeat(500), memoryMessages: rows }), 'new');
  const update = result.memoryUpdate;
  assert.ok(update.messages.length > 0 && update.messages.length < 20);
  assert.equal(update.expectedThrough, 40);
  assert.equal(update.through, update.messages.at(-1).seq);
  assert.deepEqual(update.messages.map(row => row.seq), rows.slice(0, update.messages.length).map(row => row.seq));
  assert.ok(update.through < rows.at(-1).seq);
  assert.ok(bytes(update) <= 2000);
  assert.match(update.previousSummary, /\[excerpt\]$/);
});

test('summary updates can consume 12 short rows but never skip a row that cannot yield an excerpt', () => {
  const complete = contextFor(page({ memoryMessages: batch(12, 1, 'x') }), 'new').memoryUpdate;
  assert.equal(complete.messages.length, 12); assert.equal(complete.through, 12);
  const rows = batch(20);
  rows[1].content = ' '.repeat(31000) + 'trailing';
  const partial = contextFor(page({ memoryMessages: rows }), 'new').memoryUpdate;
  assert.equal(partial.through, 1); assert.deepEqual(partial.messages.map(row => row.seq), [1]);
  rows[0].content = rows[1].content;
  assert.equal(contextFor(page({ memoryMessages: rows }), 'new').memoryUpdate, null);
});

test('sequence order is numeric beyond single digits and watermarks stay safe near MAX_SAFE_INTEGER', () => {
  const start = Number.MAX_SAFE_INTEGER - 20;
  const rows = batch(20).map((row, i) => ({ ...row, seq: start + i + 1 }));
  const result = contextFor(page({ summaryThrough: start, memoryMessages: rows }), 'new');
  assert.ok(Number.isSafeInteger(result.memoryUpdate.through));
  assert.equal(result.memoryUpdate.expectedThrough, start);
  assert.equal(result.memoryUpdate.through, rows[result.memoryUpdate.messages.length - 1].seq);
  validatePage(page({ messages: [archived(9), archived(10)] }));
});

test('context validates malformed pages, recalled messages and command types with generic errors', () => {
  for (const command of [null, {}, 5, 'x'.repeat(32001)]) invalid(() => contextFor(page(), command));
  for (const retrieved of [null, {}, [message(1)], [{ ...archived(1), role: 'system' }],
    [{ ...archived(1), seq: '1' }], [{ ...archived(1), content: '' }]]) {
    invalid(() => contextFor(page(), 'new', retrieved));
  }
  invalid(() => contextFor(page({ messages: [archived(2), archived(1)] }), 'new'));
});

test('search activates only for explicit historical references and extracts safe meaningful keywords', () => {
  for (const command of ['Move Acme to won', 'Show all records', 'Update the previousQuarter field', '', 'remember', 'we discussed']) {
    assert.equal(searchQuery(command), '');
  }
  assert.equal(searchQuery('What did we discuss earlier about Acme renewal?'), 'acme OR renewal');
  assert.equal(searchQuery('Remember the Acme ACME renewal 2026?'), 'acme OR renewal OR 2026');
  assert.equal(searchQuery('Previous conversation about Northwind pricing'), 'northwind OR pricing');
  assert.equal(searchQuery('What did we discuss last time about invoice 431?'), 'invoice OR 431');
  assert.equal(searchQuery('We discussed caf\u00e9 pricing'), 'caf\u00e9 OR pricing');
  assert.equal(searchQuery('Remember \u6771\u4eac 2026?'), '\u6771\u4eac OR 2026');
});

test('search strips query operators, deduplicates, bounds query length and never emits punctuation', () => {
  const query = searchQuery('Earlier: Acme\'); DROP TABLE users; -- | (pricing:* & secret) "renewal"');
  assert.match(query, /^[\p{L}\p{N}]+(?: OR [\p{L}\p{N}]+)*$/u);
  const huge = searchQuery('Remember ' + Array.from({ length: 400 }, (_, i) => `keyword${i}`).join(' '));
  assert.ok(huge.length > 200 && huge.length <= 300);
  assert.ok(!huge.endsWith(' OR '));
  assert.equal(searchQuery('Remember ' + 'x'.repeat(1000)), '');
  for (const command of [undefined, null, 42, {}, 'x'.repeat(32001)]) invalid(() => searchQuery(command));
});
