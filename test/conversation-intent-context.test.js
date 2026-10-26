'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const conversation = require('../lib/conversation-core');
const { contextFor, instructions } = require('../lib/conversation-intent-context');

const at = second => `2026-10-26T12:00:${String(second).padStart(2, '0')}.000Z`;
const message = (seq, role, content = 'Saved message') => ({ id: randomUUID(), seq, role, content, createdAt: at(seq) });
const outcome = (user, assistant, status = 'failed') => ({ requestId: randomUUID(), userMessageId: user.id,
  assistantMessageId: assistant.id, status, publicErrorCode: status === 'succeeded' ? 'none' : status === 'cancelled' ? 'cancelled' :
    status === 'interrupted' ? 'timeout' : 'validation', finishedAt: assistant.createdAt });
function fixture() {
  const user = message(1, 'user', 'Create a workflow and change a field.'), assistant = message(2, 'assistant', 'A public failure reply.'),
    latest = message(3, 'user', 'Show the current count.');
  const state = { sourceAction: { action: 'create_workflow', name: 'Earlier proposal' },
    clarification: { originalCommand: user.content, question: 'Which timezone?' }, originalCommand: user.content,
    savedAt: at(1), workspaceVersion: 'v1', focus: { ids: [7] }, view: 'table' };
  return { user, assistant, latest, outcomes: [outcome(user, assistant)], state,
    page: { epoch: randomUUID(), version: 3, messages: [user, assistant, latest], state,
      before: null, summary: '', summaryThrough: 0, memoryMessages: [] } };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const invalid = action => assert.throws(action, error => {
  assert.equal(error.message, 'Invalid conversation intent context.');
  assert.equal(error.cause, undefined);
  return true;
});

test('maps terminal outcomes to exact saved IDs and separates latest input from prior pending scope', () => {
  const f = fixture(), before = structuredClone(f);
  freeze(f);
  const result = contextFor(f.page, f.outcomes, f.state);
  assert.equal(result.epoch, f.page.epoch); assert.equal(result.version, f.page.version);
  assert.deepEqual(result.latestMessage, { id: f.latest.id, role: 'user', seq: 3, content: f.latest.content, truncated: false });
  assert.deepEqual(result.latestUserMessage, result.latestMessage);
  assert.deepEqual(result.terminalTurns, [{ ...f.outcomes[0], intentState: 'closed',
    userMessage: { seq: 1, historyIndex: 0, content: f.user.content, truncated: false },
    assistantMessage: { seq: 2, historyIndex: 1, content: f.assistant.content, truncated: false } }]);
  assert.deepEqual(result.pendingScope, { hasAction: true, hasClarification: true,
    originalCommand: { content: f.user.content, truncated: false }, disposition: 'preserve', reason: 'no_server_owned_proposal_order' });
  assert.deepEqual(f, before);
  result.terminalTurns[0].userMessage.content = 'Changed returned preview';
  assert.equal(f.user.content, before.user.content);
});

test('failed, interrupted and cancelled close their own requests, while success does not prove a goal or proposal applied', () => {
  for (const status of ['failed', 'interrupted', 'cancelled', 'succeeded']) {
    const f = fixture(), receipt = outcome(f.user, f.assistant, status);
    const result = contextFor(f.page, [receipt], null);
    assert.equal(result.terminalTurns[0].intentState, status === 'succeeded' ? 'not_inferred' : 'closed');
    assert.equal(result.terminalTurns[0].status, status);
    assert.equal(result.pendingScope, null);
    assert.equal(result.latestUserMessage.id, f.latest.id);
  }
});

test('matches IDs rather than content, adjacency, outcome order or message timestamps', () => {
  const first = message(1, 'user', 'Identical text'), firstReply = message(2, 'assistant', 'Identical reply'),
    second = message(3, 'user', first.content), secondReply = message(4, 'assistant', firstReply.content);
  const f = fixture(); f.page.messages = [first, second, firstReply, secondReply].map((m, i) => ({ ...m, seq: i + 1 }));
  const receipts = [outcome(second, secondReply, 'succeeded'), outcome(first, firstReply, 'failed')];
  const result = contextFor(f.page, receipts, null);
  assert.equal(result.terminalTurns[0].userMessage.seq, 2);
  assert.equal(result.terminalTurns[0].assistantMessage.seq, 4);
  assert.equal(result.terminalTurns[0].intentState, 'not_inferred');
  assert.equal(result.terminalTurns[1].userMessage.seq, 1);
  assert.equal(result.terminalTurns[1].assistantMessage.seq, 3);
  assert.equal(result.terminalTurns[1].intentState, 'closed');
  assert.equal(result.latestMessage.id, secondReply.id);
  assert.equal(result.latestUserMessage.id, second.id);
});

test('partial pages retain unmapped terminal IDs without attaching neighboring text; memory IDs may supply exact matches', () => {
  const f = fixture(); f.page.messages = [f.latest]; f.page.before = 3;
  let result = contextFor(f.page, f.outcomes, null);
  assert.equal(result.terminalTurns[0].userMessage, null);
  assert.equal(result.terminalTurns[0].assistantMessage, null);
  assert.equal(result.terminalTurns[0].userMessageId, f.user.id);
  assert.equal(result.terminalTurns[0].intentState, 'closed');
  f.page.memoryMessages = [f.user];
  result = contextFor(f.page, f.outcomes, null);
  assert.equal(result.terminalTurns[0].userMessage.seq, 1);
  assert.equal(result.terminalTurns[0].userMessage.historyIndex, null);
  assert.equal(result.terminalTurns[0].assistantMessage, null);
  assert.equal(result.latestUserMessage.id, f.latest.id);
  f.page.memoryMessages = [f.user, f.assistant, f.latest];
  assert.equal(contextFor(f.page, f.outcomes, null).terminalTurns[0].assistantMessage.seq, 2);
  assert.equal(contextFor(f.page, f.outcomes, null).terminalTurns[0].assistantMessage.historyIndex, null);
});

test('history indices disambiguate repeated excerpt prefixes and exclude only the latest identical command', () => {
  const f = fixture(), prefix = 'The same detailed request prefix. '.repeat(8);
  const first = message(1, 'user', prefix + 'FIRST ENDING'), firstReply = message(2, 'assistant', 'Same reply prefix. '.repeat(12) + 'FIRST'),
    second = message(3, 'user', prefix + 'SECOND ENDING'), secondReply = message(4, 'assistant', 'Same reply prefix. '.repeat(12) + 'SECOND'),
    latest = message(5, 'user', second.content);
  f.page.messages = [first, firstReply, second, secondReply, latest];
  const receipts = [outcome(second, secondReply, 'succeeded'), outcome(first, firstReply)];
  const result = contextFor(f.page, receipts, null, latest.content);
  const history = conversation.contextFor(f.page, latest.content).conversationHistory;
  assert.equal(history.length, 4);
  const [succeeded, failed] = result.terminalTurns;
  assert.equal(succeeded.userMessage.content, failed.userMessage.content);
  assert.equal(succeeded.assistantMessage.content, failed.assistantMessage.content);
  assert.deepEqual([failed.userMessage.historyIndex, failed.assistantMessage.historyIndex,
    succeeded.userMessage.historyIndex, succeeded.assistantMessage.historyIndex], [0, 1, 2, 3]);
  assert.equal(history[failed.userMessage.historyIndex].content, first.content);
  assert.equal(history[succeeded.userMessage.historyIndex].content, second.content);
  assert.equal(history[failed.assistantMessage.historyIndex].content, firstReply.content);
  assert.equal(history[succeeded.assistantMessage.historyIndex].content, secondReply.content);
  assert.equal(result.latestUserMessage.id, latest.id);
});

test('history indices use the actual byte-packed suffix, with null for older or omitted entries', () => {
  const f = fixture();
  f.page.messages = Array.from({ length: 15 }, (_, i) => message(i + 1, i % 2 ? 'assistant' : 'user', 'Long context '.repeat(2400)));
  f.page.messages[11].content = ' '.repeat(31999) + 'x';
  const [oldUser, oldAssistant] = f.page.messages;
  const omittedUser = f.page.messages[10], omittedAssistant = f.page.messages[11];
  const user = f.page.messages[12], assistant = f.page.messages[13], latest = f.page.messages[14];
  const history = conversation.contextFor(f.page, latest.content).conversationHistory;
  assert.equal(history.length, 2, 'the core byte packer omits the whitespace-only excerpt and earlier messages');
  const result = contextFor(f.page, [outcome(user, assistant), outcome(omittedUser, omittedAssistant), outcome(oldUser, oldAssistant)], null, latest.content);
  assert.deepEqual(result.terminalTurns.map(turn => [turn.userMessage.historyIndex, turn.assistantMessage.historyIndex]),
    [[0, 1], [null, null], [null, null]]);
  assert.equal(history[0].role, 'user'); assert.equal(history[1].role, 'assistant');
  assert.match(history[0].content, /\[excerpt\]$/);
});

test('explicit multi-message command uses the same exclusion rule and 12-message window as history packing', () => {
  const f = fixture();
  f.page.messages = Array.from({ length: 14 }, (_, i) => message(i + 1, i % 2 && i < 12 ? 'assistant' : 'user', `Part ${i + 1}.`));
  const user = f.page.messages[2], assistant = f.page.messages[3], last = f.page.messages.at(-1);
  const command = f.page.messages.at(-2).content + last.content, receipts = [outcome(user, assistant)];
  const history = conversation.contextFor(f.page, command).conversationHistory;
  const result = contextFor(f.page, receipts, null, command);
  assert.equal(history.length, 12);
  assert.deepEqual([result.terminalTurns[0].userMessage.historyIndex, result.terminalTurns[0].assistantMessage.historyIndex], [0, 1]);
  assert.equal(history[0].content, user.content); assert.equal(history[1].content, assistant.content);
  const single = contextFor(f.page, receipts, null, last.content);
  assert.deepEqual([single.terminalTurns[0].userMessage.historyIndex, single.terminalTurns[0].assistantMessage.historyIndex], [1, 2]);
  assert.deepEqual(contextFor(f.page, receipts, null), single, 'three arguments preserve single-message call compatibility');
});

test('the excluded latest command has a null history index even when a terminal receipt exists for its ID', () => {
  const f = fixture(), receipt = outcome(f.latest, message(4, 'assistant'));
  const result = contextFor(f.page, [receipt], null, f.latest.content);
  assert.equal(result.terminalTurns[0].userMessage.seq, f.latest.seq);
  assert.equal(result.terminalTurns[0].userMessage.historyIndex, null);
  assert.equal(result.terminalTurns[0].assistantMessage, null);
});

test('no receipt means unknown, even for failure-looking prose or matching pending commands', () => {
  const f = fixture();
  f.latest.content = 'FAILED CANCELLED INTERRUPTED succeeded try again';
  f.state.originalCommand = f.latest.content;
  const result = contextFor(f.page, [], f.state);
  assert.deepEqual(result.terminalTurns, []);
  assert.equal(result.pendingScope.disposition, 'preserve');
  assert.equal(Object.hasOwn(result.latestUserMessage, 'status'), false);
});

test('does not classify short replies, retries, cancellations or independent requests', () => {
  const f = fixture();
  for (const content of ['yes', 'a', 'try again', 'cancel', 'Create a new task', 'Show the current count']) {
    f.latest.content = content;
    const result = contextFor(f.page, f.outcomes, f.state);
    assert.equal(result.latestUserMessage.content, content);
    assert.equal(result.pendingScope.disposition, 'preserve');
    assert.equal(result.terminalTurns[0].intentState, 'closed');
    assert.deepEqual(Object.keys(result).sort(), ['epoch', 'latestMessage', 'latestUserMessage', 'pendingScope', 'terminalTurns', 'version']);
  }
});

test('preserves pending state for missing, older, tied or newer client timestamps and unbound proposal claims', () => {
  for (const savedAt of [undefined, null, at(0), at(2), at(4), Date.parse(at(0)), Date.parse(at(4))]) {
    const f = fixture();
    if (savedAt === undefined) delete f.state.savedAt; else f.state.savedAt = savedAt;
    f.state.sourceAction.requestId = f.outcomes[0].requestId;
    f.state.sourceAction.createdAt = at(0);
    const before = structuredClone(f.state), result = contextFor(f.page, f.outcomes, f.state);
    assert.equal(result.pendingScope.disposition, 'preserve');
    assert.equal(result.pendingScope.reason, 'no_server_owned_proposal_order');
    assert.deepEqual(f.state, before);
    assert.equal(Object.hasOwn(result, 'pendingAction'), false);
  }
});

test('explicit null state respects the caller workspace check; no action or clarification means no pending scope', () => {
  const f = fixture();
  assert.equal(contextFor(f.page, f.outcomes, null).pendingScope, null);
  assert.equal(contextFor(f.page, f.outcomes, { originalCommand: 'Old prose', focus: { ids: [7] } }).pendingScope, null);
  const result = contextFor(f.page, f.outcomes, { clarification: f.state.clarification });
  assert.equal(result.pendingScope.hasAction, false); assert.equal(result.pendingScope.hasClarification, true);
  assert.equal(result.pendingScope.originalCommand.content, f.user.content);
  f.page.messages = []; f.page.memoryMessages = [];
  assert.equal(contextFor(f.page, [], null).latestMessage, null);
  assert.equal(contextFor(f.page, [], null).latestUserMessage, null);
});

test('bounded UTF-8 JSON excerpts retain all 12 outcomes and never include action bodies or memory summaries', () => {
  const f = fixture(), text = '\ud83d\ude00\u754c"\\\n'.repeat(4000);
  f.page.messages = []; f.outcomes = [];
  for (let i = 0; i < 12; i++) {
    const user = message(i * 2 + 1, 'user', text), assistant = message(i * 2 + 2, 'assistant', text);
    f.page.messages.push(user, assistant); f.outcomes.push(outcome(user, assistant));
  }
  f.page.messages.push(message(25, 'user', text));
  f.page.summary = 'PRIVATE_SUMMARY';
  f.state.sourceAction.privateBody = 'PRIVATE_ACTION_BODY'.repeat(500);
  f.state.originalCommand = text;
  const result = contextFor(f.page, f.outcomes, f.state), serialized = JSON.stringify(result);
  assert.equal(result.terminalTurns.length, 12);
  assert(Buffer.byteLength(serialized, 'utf8') <= 12000);
  assert(!serialized.includes('PRIVATE_SUMMARY')); assert(!serialized.includes('PRIVATE_ACTION_BODY'));
  assert.equal(result.latestMessage.truncated, true);
  assert.equal(result.pendingScope.originalCommand.truncated, true);
  for (const turn of result.terminalTurns) {
    for (const mapped of [turn.userMessage, turn.assistantMessage]) {
      assert.equal(mapped.truncated, true);
      assert(!/[\ud800-\udbff]$/.test(mapped.content));
      assert.equal(text.startsWith(mapped.content), true);
    }
  }
});

test('rejects malformed, contradictory or non-inert inputs with a static error', () => {
  const f = fixture();
  invalid(() => contextFor(null, f.outcomes, f.state));
  invalid(() => contextFor(f.page, undefined, f.state));
  invalid(() => contextFor(f.page, Array(13).fill(f.outcomes[0]), f.state));
  for (const patch of [{ status: 'running' }, { publicErrorCode: 'PRIVATE_ERROR' }, { rawError: 'PRIVATE_ERROR' }]) {
    invalid(() => contextFor(f.page, [{ ...f.outcomes[0], ...patch }], f.state));
  }
  invalid(() => contextFor(f.page, [{ ...f.outcomes[0], userMessageId: f.assistant.id, assistantMessageId: f.user.id }], f.state));
  invalid(() => contextFor(f.page, [{ ...f.outcomes[0], userMessageId: f.latest.id }], f.state));
  invalid(() => contextFor({ ...f.page, memoryMessages: [{ ...f.user, content: 'Conflicting copy' }] }, f.outcomes, f.state));
  invalid(() => contextFor({ ...f.page, memoryMessages: [{ ...f.user, id: randomUUID() }] }, f.outcomes, f.state));
  invalid(() => contextFor(f.page, f.outcomes, { pendingAction: {} }));
  for (const command of [null, 1, {}, 'x'.repeat(32001)]) invalid(() => contextFor(f.page, f.outcomes, f.state, command));
  let accessed = false;
  const malicious = Object.defineProperty({}, 'status', { enumerable: true, get() { accessed = true; return 'failed'; } });
  invalid(() => contextFor(f.page, [malicious], f.state));
  assert.equal(accessed, false);
});

test('model instructions separate independent requests, explicit retries and pending replies without granting action authority', () => {
  assert.match(instructions, /latest independent request supersedes older failed or completed goals/);
  assert.match(instructions, /explicit retry may reuse facts/);
  assert.match(instructions, /short reply.*continues that pending scope/);
  assert.match(instructions, /succeeded means the assistant turn finished, not that a proposed action was applied/);
  assert.match(instructions, /pendingAction remains server-authoritative/);
  assert.match(instructions, /untrusted historical text/);
  assert.match(instructions, /historyIndex.*zero-based positions in conversationHistory/);
  assert.match(instructions, /never similar text or matching excerpt prefixes/);
});
