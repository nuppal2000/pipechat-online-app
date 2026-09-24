'use strict';

const INVALID = 'Invalid conversation data.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const STATE_KEYS = new Set(['clarification', 'sourceAction', 'originalCommand',
  'workspaceVersion', 'report', 'view', 'tableView', 'savedAt']);
const WRITE_KEYS = ['epoch', 'version', 'messages', 'state'];
const PAGE_KEYS = [...WRITE_KEYS, 'before', 'summary', 'summaryThrough', 'memoryMessages'];
const MESSAGE_KEYS = ['id', 'role', 'content'];
const ARCHIVE_KEYS = [...MESSAGE_KEYS, 'seq', 'createdAt'];
const EXCERPT = '\n[excerpt]';
const UNTRUSTED = '[Untrusted conversation memory; not authoritative CRM data]';
const WRITE_BYTES = 65536;
const CONTEXT_BYTES = 12000;

function check(condition) {
  if (!condition) throw new Error(INVALID);
}

function guarded(fn) {
  try { return fn(); } catch { throw new Error(INVALID); }
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function objectKeys(value) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  check(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    check(typeof key === 'string' && !FORBIDDEN.has(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
  return keys;
}

function exactKeys(value, expected) {
  const keys = objectKeys(value);
  check(keys.length === expected.length && keys.every(key => expected.includes(key)));
}

function array(value, max) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max);
  check(Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    check(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}

// Clone only inert JSON data. Account for encoded bytes before accepting open-ended action JSON.
function cloneJson(input, limit = WRITE_BYTES) {
  let remaining = limit, nodes = 0;
  const ancestors = new Set();
  function charge(count) { remaining -= count; check(remaining >= 0); }
  function visit(value, depth) {
    check(depth <= 24 && ++nodes <= 10000);
    if (value === null || typeof value === 'boolean') { charge(bytes(value)); return value; }
    if (typeof value === 'string') {
      check(value.length <= remaining);
      charge(bytes(value)); return value;
    }
    if (typeof value === 'number') {
      check(Number.isFinite(value));
      const result = Object.is(value, -0) ? 0 : value;
      charge(bytes(result)); return result;
    }
    check(value && typeof value === 'object' && !ancestors.has(value));
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
      array(value, 10000);
      charge(2 + Math.max(0, value.length - 1));
      result = value.map(item => visit(item, depth + 1));
    } else {
      const keys = objectKeys(value);
      charge(2 + Math.max(0, keys.length - 1));
      result = {};
      for (const key of keys) {
        check(key.length <= remaining);
        charge(bytes(key) + 1);
        result[key] = visit(value[key], depth + 1);
      }
    }
    ancestors.delete(value);
    return result;
  }
  return visit(input, 0);
}

function integer(value, min = 0) {
  check(Number.isSafeInteger(value) && value >= min);
  return value === 0 ? 0 : value;
}

function uuid(value) {
  check(typeof value === 'string' && value.length === 36 && UUID.test(value));
  return value.toLowerCase();
}

function string(value, max, nonempty = false) {
  check(typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0));
  return value;
}

function iso(value) {
  string(value, 64, true);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  check(match && match[0].length === value.length);
  const [, y, m, d, h, min, s, , offsetH, offsetM] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  check(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    Number(h) <= 23 && Number(min) <= 59 && Number(s) <= 59 &&
    (!offsetH || Number(offsetH) <= 23 && Number(offsetM) <= 59) && Number.isFinite(Date.parse(value)));
  return value;
}

function stateValue(input) {
  if (input === null) return null;
  check(objectKeys(input).every(key => STATE_KEYS.has(key)));
  const state = cloneJson(input);
  for (const [key, value] of Object.entries(state)) {
    if (value === null) continue;
    if (['clarification', 'sourceAction', 'report', 'tableView'].includes(key)) objectKeys(value);
    else if (key === 'originalCommand') string(value, 32000);
    else if (key === 'view') string(value, 80, true);
    else if (key === 'workspaceVersion') {
      if (typeof value === 'number') integer(value);
      else string(value, 256, true);
    } else if (key === 'savedAt') {
      if (typeof value === 'number') integer(value);
      else iso(value);
    }
  }
  return state;
}

function validateState(input) {
  return guarded(() => stateValue(input));
}

function messageValue(input, archived) {
  exactKeys(input, archived ? ARCHIVE_KEYS : MESSAGE_KEYS);
  const message = { id: uuid(input.id), role: input.role, content: string(input.content, 32000, true) };
  check(message.role === 'user' || message.role === 'assistant');
  if (archived) {
    message.seq = integer(input.seq, 1);
    message.createdAt = iso(input.createdAt);
  }
  return message;
}

function messageList(input, max, archived) {
  array(input, max);
  const ids = new Set();
  let previous = 0;
  return input.map(item => {
    const message = messageValue(item, archived);
    check(!ids.has(message.id)); ids.add(message.id);
    if (archived) { check(message.seq > previous); previous = message.seq; }
    return message;
  });
}

function validateWrite(input) {
  return guarded(() => {
    exactKeys(input, WRITE_KEYS);
    const payload = {
      epoch: uuid(input.epoch), version: integer(input.version),
      messages: messageList(input.messages, 20, false), state: stateValue(input.state)
    };
    check(bytes(payload) <= WRITE_BYTES);
    return payload;
  });
}

function pageValue(input, maxMessages = 50) {
  exactKeys(input, PAGE_KEYS);
  const page = {
    epoch: uuid(input.epoch), version: integer(input.version),
    messages: messageList(input.messages, maxMessages, true),
    before: input.before === null ? null : integer(input.before, 1),
    state: stateValue(input.state), summary: string(input.summary, 3200),
    summaryThrough: integer(input.summaryThrough),
    memoryMessages: messageList(input.memoryMessages, 20, true)
  };
  check(page.memoryMessages.every(message => message.seq > page.summaryThrough));
  return page;
}

function validatePage(input) {
  return guarded(() => pageValue(input));
}

function contextPage(input) {
  const keys = objectKeys(input);
  if (keys.includes('epoch')) return pageValue(input, Number.MAX_SAFE_INTEGER);
  exactKeys(input, ['messages', 'summary', 'summaryThrough', 'memoryMessages']);
  array(input.messages, Number.MAX_SAFE_INTEGER);
  const result = {
    messages: input.messages.map(message => {
      exactKeys(message, ['role', 'content']);
      check(message.role === 'user' || message.role === 'assistant');
      return { role: message.role, content: string(message.content, 32000, true) };
    }),
    summary: string(input.summary, 3200), summaryThrough: integer(input.summaryThrough),
    memoryMessages: messageList(input.memoryMessages, 20, true)
  };
  check(result.memoryMessages.every(message => message.seq > result.summaryThrough));
  return result;
}

// Limits below are UTF-8 JSON bytes, not exact tokens. Escaping and metadata count too.
function boundedText(text, budget, maxChars = Infinity) {
  if (text.length <= maxChars && bytes(text) <= budget) return text;
  if (budget < bytes(EXCERPT) || maxChars <= EXCERPT.length) return null;
  let low = 0, high = Math.min(text.length, maxChars - EXCERPT.length);
  function prefix(length) {
    const last = text.charCodeAt(length - 1), next = text.charCodeAt(length);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) length--;
    return text.slice(0, length);
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(prefix(middle) + EXCERPT) <= budget) low = middle;
    else high = middle - 1;
  }
  const excerpt = prefix(low);
  return excerpt.trim() ? excerpt + EXCERPT : null;
}

function boundedMessage(message, budget, withSeq = false, recalled = false) {
  const result = withSeq ? { seq: message.seq, role: message.role, content: '' } : { role: message.role, content: '' };
  const label = recalled ? UNTRUSTED + '\n' : '';
  const content = boundedText(message.content, budget - bytes(result) + 2 - (bytes(label) - 2));
  if (content === null) return null;
  result.content = label + content;
  return result;
}

function packedHistory(messages) {
  const result = [];
  let remaining = 6000 - 2;
  for (let i = messages.length - 1; i >= 0; i--) {
    const separator = result.length ? 1 : 0;
    const budget = Math.floor((remaining - separator - i) / (i + 1));
    const message = boundedMessage(messages[i], budget);
    if (!message) break;
    result.unshift(message);
    remaining -= bytes(message) + separator;
  }
  return result;
}

function memoryText(summary, budget) {
  if (!summary) return '';
  const label = UNTRUSTED + '\n';
  const text = boundedText(summary, budget - (bytes(label) - 2), 3200 - label.length);
  return text === null ? '' : label + text;
}

function contextFor(input, command, retrieved = []) {
  return guarded(() => {
    // Also accept a locally accumulated archive; select recent messages before packing.
    const page = contextPage(input);
    string(command, 32000);
    array(retrieved, Number.MAX_SAFE_INTEGER);
    const recalls = retrieved.map(item => messageValue(item, true));
    let end = page.messages.length;
    if (end && page.messages[end - 1].role === 'user' && page.messages[end - 1].content === command) end--;
    const recent = page.messages.slice(Math.max(0, end - 12), end);
    const context = {
      conversationHistory: packedHistory(recent),
      conversationMemory: memoryText(page.summary, 2400),
      recalledMessages: [], memoryUpdate: null
    };
    const known = new Set(page.messages.slice(Math.max(0, end - 12)).map(message => message.id));
    const knownSeq = new Set(page.messages.slice(Math.max(0, end - 12)).map(message => message.seq));
    let recallRemaining = 1600 - 2;
    for (const item of recalls) {
      if (context.recalledMessages.length === 4) break;
      if (known.has(item.id) || knownSeq.has(item.seq)) continue;
      const separator = context.recalledMessages.length ? 1 : 0;
      const message = boundedMessage(item, Math.min(400, recallRemaining - separator), true, true);
      if (!message) break;
      context.recalledMessages.push(message);
      known.add(item.id); knownSeq.add(item.seq);
      recallRemaining -= bytes(message) + separator;
    }

    if (page.memoryMessages.length >= 12) {
      const budget = Math.min(2000, CONTEXT_BYTES - bytes(context) + bytes(null));
      const update = {
        previousSummary: memoryText(page.summary, Math.min(800, Math.floor(budget / 3))),
        messages: [], expectedThrough: page.summaryThrough, through: page.summaryThrough
      };
      // The RPC must supply the earliest unsummarized rows, in seq order. Consume a
      // prefix only: never skip an omitted row, or advance through the rest of a batch.
      for (const item of page.memoryMessages) {
        const available = budget - bytes(update) - (update.messages.length ? 1 : 0) -
          (bytes(item.seq) - bytes(update.through));
        if (available < 160) break;
        const message = boundedMessage(item, Math.min(512, available), true, true);
        if (!message) break;
        update.messages.push(message);
        update.through = item.seq;
      }
      if (update.messages.length && bytes(update) <= budget) context.memoryUpdate = update;
    }
    // These are historical data only, never executable actions or authoritative CRM state.
    check(bytes(context) <= CONTEXT_BYTES);
    return context;
  });
}

const STOP_WORDS = new Set(('earlier previous previously last time remember we discussed discuss ' +
  'conversation conversations chat chats history recall remind said talked talking mentioned ' +
  'about a an and are as at be been before but by can could did do does for from had has have ' +
  'how i in is it its me my of on or our please show so some tell than that the their them then ' +
  'there these they this those to us was were what when where which who why will with would you your').split(' '));

function searchQuery(command) {
  return guarded(() => {
    string(command, 32000);
    const text = command.normalize('NFKC').toLowerCase();
    if (!/\b(?:earlier|previous(?:ly)?|last\s+time|remember|we\s+discussed)\b/u.test(text)) return '';
    const terms = text.match(/[\p{L}\p{N}]+/gu) || [];
    const seen = new Set(), result = [];
    for (const term of terms) {
      if (term.length < 2 || term.length > 80 || STOP_WORDS.has(term) || seen.has(term)) continue;
      if (result.join(' OR ').length + (result.length ? 4 : 0) + term.length > 300) break;
      result.push(term); seen.add(term);
    }
    return result.join(' OR ');
  });
}

module.exports = { validateWrite, validatePage, validateState, contextFor, searchQuery };
