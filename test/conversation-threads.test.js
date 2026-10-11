'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createConversationStore } = require('../lib/conversation-store');
const token = page => ({ epoch:page.epoch, version:page.version });
const message = (content, role = 'user') => ({ id:randomUUID(), role, content });
const status = wanted => error => error.status === wanted;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipechat-threads-')), pending = new Map();
  const lock = async (key, task) => {
    const work = (pending.get(key) || Promise.resolve()).catch(() => {}).then(task);
    pending.set(key, work);
    try { return await work; } finally { if (pending.get(key) === work) pending.delete(key); }
  };
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pipechat-threads-'));
    await fs.rm(directory, {recursive:true, force:true});
  });
  return { directory, open:options => createConversationStore(directory, lock, options) };
}

test('legacy JSON upgrades in place; thread round trip preserves all pages, roles, timestamps and memory', async t => {
  const {directory, open} = await fixture(t), old = { epoch:randomUUID(), version:7, state:{focus:{ids:[11]}, report:{title:'Saved report'}, view:'table'},
    summary:'Earlier facts', summaryThrough:20, messages:Array.from({length:113}, (_, i) => ({...message('History ' + (i + 1), i % 2 ? 'assistant':'user'), seq:i + 1, createdAt:'2026-10-01T10:00:00.000Z'})) };
  await fs.mkdir(path.join(directory, 'conversations'));
  await fs.writeFile(path.join(directory, 'conversations/account-a.json'), JSON.stringify(old));
  let store = open()('account-a');
  const initial = await store.readConversation(), listed = await store.listConversationThreads(), firstId = listed.activeThreadId;
  assert.equal(initial.epoch, old.epoch);
  assert.equal(initial.version, old.version);
  assert.equal(initial.messages.length, 50);
  assert.equal(initial.before, 64);
  assert.equal(listed.threads[0].messageCount, 113);
  const created = await store.newConversationThread({...token(initial), title:'Separate work'});
  assert.equal(created.conversation.state, null);
  assert.deepEqual(created.conversation.messages, []);
  assert.equal(created.conversation.summary, '');
  await store.writeConversation({...token(created.conversation), messages:[message('Different history')], state:{focus:{ids:[99]}}});
  store = open()('account-a');
  const second = await store.readConversation();
  const resumed = await store.switchConversationThread({...token(second), threadId:firstId});
  assert.notEqual(resumed.conversation.epoch, old.epoch);
  assert.deepEqual({...resumed.conversation, epoch:old.epoch}, initial);
  const middle = await store.readConversation(resumed.conversation.before), oldest = await store.readConversation(middle.before);
  assert.deepEqual([...oldest.messages, ...middle.messages, ...resumed.conversation.messages], old.messages);
  assert.deepEqual(await store.searchConversation('Different history'), []);
  await assert.rejects(() => store.writeConversation({...token(initial), messages:[message('Stale tab')], state:null}), status(409));
  assert.deepEqual(await store.saveConversationMemory(initial.epoch, {expectedThrough:20, through:21}, 'Stale summary'), {saved:false});
  const disk = JSON.parse(await fs.readFile(path.join(directory, 'conversations/account-a.json'), 'utf8'));
  assert.deepEqual(disk.state, old.state);
  assert.equal(disk.threadStore.items.length, 2);
});

test('only target focus resumes; pending actions remain archived but never reactivate', async t => {
  const {open} = await fixture(t), store = open()('account-a'), initial = await store.readConversation();
  const id = (await store.listConversationThreads()).activeThreadId;
  const state = {clarification:{question:'Confirm?'}, sourceAction:{action:'delete_records'}, originalCommand:'Old request',
    workspaceVersion:'old', savedAt:1, focus:{ids:[1]}, report:{title:'Own report'}, tableView:{search:'Own query'}, view:'table'};
  const saved = await store.writeConversation({...token(initial), messages:[message('Original')], state});
  const created = await store.newConversationThread({...saved, title:'Other'});
  assert.equal(created.conversation.state, null);
  const second = await store.writeConversation({...token(created.conversation), messages:[], state:{focus:{ids:[2]}}});
  const resumed = await store.switchConversationThread({...second, threadId:id});
  assert.deepEqual(resumed.conversation.state, {focus:{ids:[1]}, report:{title:'Own report'}, tableView:{search:'Own query'}, view:'table'});
  const other = await store.switchConversationThread({...token(resumed.conversation), threadId:created.threadId});
  assert.deepEqual(other.conversation.state, {focus:{ids:[2]}});
  const noOp = await store.switchConversationThread({...token(other.conversation), threadId:created.threadId});
  assert.deepEqual(noOp, other);
});

test('new/switch operations use strict CAS and serialize concurrent windows; accounts remain isolated', async t => {
  const {open} = await fixture(t), account = open(), a = account('account-a'), b = account('account-b');
  const initial = await a.readConversation();
  const results = await Promise.allSettled([a.newConversationThread({...token(initial), title:'First'}), a.newConversationThread({...token(initial), title:'Second'})]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.status, 409);
  assert.equal((await a.listConversationThreads()).threads.length, 2);
  const other = await b.readConversation(), foreign = (await a.listConversationThreads()).activeThreadId;
  await assert.rejects(() => b.switchConversationThread({...token(other), threadId:foreign}), status(404));
  assert.equal((await b.listConversationThreads()).threads.length, 1);
  for (const title of ['', ' ', 'x'.repeat(161), 'line\nbreak']) await assert.rejects(async () => a.newConversationThread({...token(await a.readConversation()), title}), status(400));
  assert.deepEqual(await b.readConversation(), other);
});

test('reset preserves all archive history but invalidates old focus and pending state', async t => {
  const {open} = await fixture(t), store = open()('account-a');
  const initial = await store.readConversation(), original = (await store.listConversationThreads()).activeThreadId;
  await store.writeConversation({...token(initial), messages:[message('Keep across reset')], state:{focus:{ids:[1]}, sourceAction:{action:'delete_records'}}});
  assert.equal(await store.reset(), undefined);
  const reset = await store.readConversation();
  assert.equal(reset.state, null);
  assert.deepEqual(reset.messages, []);
  const listed = await store.listConversationThreads();
  assert.equal(listed.threads.length, 2);
  const restored = await store.switchConversationThread({...token(reset), threadId:original});
  assert.equal(restored.conversation.messages[0].content, 'Keep across reset');
  assert.equal(restored.conversation.state, null);
  assert.notEqual(restored.conversation.epoch, initial.epoch);
});

test('terminal failure reply is durable, idempotent and follows its origin across multiple switches/reset', async t => {
  const {open} = await fixture(t), store = open()('account-a'), initial = await store.readConversation();
  const original = (await store.listConversationThreads()).activeThreadId;
  const saved = await store.writeConversation({...token(initial), messages:[message('Request')], state:{focus:{ids:[1]}}});
  const request = {epoch:initial.epoch, requestId:randomUUID(), messageId:randomUUID(), content:'The request failed. No changes were applied.'};
  const second = await store.newConversationThread({...saved, title:'Other'});
  const a = await store.switchConversationThread({...token(second.conversation), threadId:original});
  const b = await store.switchConversationThread({...token(a.conversation), threadId:second.threadId});
  const result = await store.completeConversationTurn(request);
  assert.equal(result.active, false); assert.equal(result.inserted, true); assert.equal(result.seq, 2);
  assert.deepEqual(await store.readConversation(), b.conversation);
  const retry = await open()('account-a').completeConversationTurn(request);
  assert.equal(retry.inserted, false); assert.equal(retry.version, result.version);
  for (const patch of [{content:'Different'}, {messageId:randomUUID()}, {requestId:randomUUID()}]) {
    await assert.rejects(() => store.completeConversationTurn({...request, ...patch}), status(409));
  }
  await assert.rejects(() => open()('account-b').completeConversationTurn(request), status(404));
  await store.reset();
  const reopened = await store.switchConversationThread({...token(await store.readConversation()), threadId:original});
  assert.equal(reopened.conversation.messages.length, 2);
  assert.equal(reopened.conversation.messages[1].role, 'assistant');
  assert.equal(reopened.conversation.messages[1].content, request.content);
  assert.equal(reopened.conversation.state, null);
  assert.equal((await store.completeConversationTurn(request)).inserted, false);
});

test('active terminal append does not overwrite state and duplicate message identity rolls back', async t => {
  const {open} = await fixture(t), store = open()('account-a'), initial = await store.readConversation();
  const existing = message('Existing user text');
  await store.writeConversation({...token(initial), messages:[existing], state:{focus:{ids:[3]}}});
  const before = await store.readConversation(), request = {epoch:initial.epoch, requestId:randomUUID(), messageId:existing.id, content:existing.content};
  await assert.rejects(() => store.completeConversationTurn(request), status(409));
  assert.deepEqual(await store.readConversation(), before);
  const reply = await store.completeConversationTurn({...request, messageId:randomUUID(), content:'Failure recorded'});
  assert.equal(reply.active, true); assert.equal(reply.version, before.version + 1);
  assert.deepEqual((await store.readConversation()).state, before.state);
});

test('rename failure commits neither archive/switch nor terminal reply receipt; retry is safe', async t => {
  const {directory,open} = await fixture(t), store = open()('account-a'), initial = await store.readConversation();
  const file = path.join(directory,'conversations/account-a.json'), before = await fs.readFile(file,'utf8');
  const rename = fs.rename, request = {epoch:initial.epoch,requestId:randomUUID(),messageId:randomUUID(),content:'Recorded failure'};
  fs.rename = async () => { const error = new Error('Injected filesystem failure'); error.code = 'EIO'; throw error; };
  try {
    await assert.rejects(() => store.newConversationThread({...token(initial),title:'Must not persist'}), /Injected/);
    await assert.rejects(() => store.completeConversationTurn(request), /Injected/);
    assert.equal(await fs.readFile(file,'utf8'),before);
  } finally { fs.rename = rename; }
  assert.equal((await store.listConversationThreads()).threads.length,1);
  assert.equal((await store.completeConversationTurn(request)).inserted,true);
  assert.equal((await store.completeConversationTurn(request)).inserted,false);
  assert.equal((await store.readConversation()).messages.length,1);
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')),[]);
});

async function prepareTurn(store, leaseSeconds = 120) {
  const initial = await store.readConversation(), user = message('Flushed request');
  const saved = await store.writeConversation({...token(initial),messages:[user],state:{focus:{ids:[1]}}});
  return {...saved,threadId:(await store.listConversationThreads()).activeThreadId,requestId:randomUUID(),
    userMessageId:user.id,assistantMessageId:randomUUID(),leaseSeconds};
}
const terminal = (request, changes = {}) => ({threadId:request.threadId,requestId:request.requestId,status:'failed',
  publicErrorCode:'unavailable',content:null,resultReceipt:null,...changes});

test('begin requires flushed user text and claims a request once across retries/reloads', async t => {
  const {open} = await fixture(t), store = open()('account-a'), request = await prepareTurn(store);
  await assert.rejects(() => store.beginConversationTurn({...request,userMessageId:randomUUID()}),status(409));
  let modelCalls = 0;
  const results = await Promise.all(Array.from({length:5},async () => {
    const receipt = await store.beginConversationTurn(request);
    if (receipt.shouldRun) modelCalls++;
    return receipt;
  }));
  assert.equal(modelCalls,1); assert.equal(results.filter(value => value.shouldRun).length,1);
  assert.equal(results[0].status,'running'); assert.equal(results[0].assistantMessageId,request.assistantMessageId);
  const replay = await open()('account-a').beginConversationTurn({...request,version:0});
  assert.equal(replay.shouldRun,false); assert.equal(replay.attempt,1);
  await assert.rejects(() => store.beginConversationTurn({...request,assistantMessageId:randomUUID()}),status(409));
  await assert.rejects(() => store.beginConversationTurn({...request,requestId:randomUUID()}),status(409));
  const second = await store.newConversationThread({...token(await store.readConversation()),title:'Different thread'});
  await assert.rejects(() => store.beginConversationTurn({...request,...token(second.conversation),threadId:second.threadId}),status(409));
  assert.equal((await store.readConversationTurn(request.threadId,request.requestId)).status,'running');
  await assert.rejects(() => open()('account-b').readConversationTurn(request.threadId,request.requestId),status(404));
});

test('finish persists one stable assistant/result receipt without overwriting the latest state', async t => {
  const {open} = await fixture(t), store = open()('account-a'), request = await prepareTurn(store);
  await store.beginConversationTurn(request);
  await assert.rejects(async () => store.writeConversation({...token(await store.readConversation()),messages:[{id:request.assistantMessageId,role:'assistant',content:'Browser injection'}],state:null}),status(409));
  await store.writeConversation({...token(await store.readConversation()),messages:[],state:{focus:{ids:[55]},view:'todo'}});
  const input = terminal(request,{status:'succeeded',publicErrorCode:'none',content:'Validated result',resultReceipt:{crmAction:{action:'query_records'}}});
  const finished = await store.finishConversationTurn(input);
  assert.equal(finished.status,'succeeded'); assert.equal(finished.assistantMessage.id,request.assistantMessageId);
  assert.deepEqual((await store.readConversation()).state,{focus:{ids:[55]},view:'todo'});
  assert.deepEqual(await open()('account-a').finishConversationTurn(input),finished);
  assert.equal((await store.readConversation()).messages.filter(item => item.id === request.assistantMessageId).length,1);
  await assert.rejects(() => store.finishConversationTurn({...input,content:'Competing outcome'}),status(409));
  assert.deepEqual((await store.beginConversationTurn(request)),{...finished,shouldRun:false});
  for (let i=0;i<60;i+=20) await store.writeConversation({...token(await store.readConversation()),messages:Array.from({length:20},() => message('Later message')),state:{focus:{ids:[55]}}});
  assert.ok(!(await store.readConversation()).messages.some(item => item.id === request.assistantMessageId));
  assert.deepEqual(await store.readConversationTurn(request.threadId,request.requestId),finished);
});

test('failure finishes in archived origin without browser persistence, forbids raw errors and survives reset', async t => {
  const {open} = await fixture(t), store = open()('account-a'), request = await prepareTurn(store);
  await store.beginConversationTurn(request);
  const second = await store.newConversationThread({...token(await store.readConversation()),title:'Active elsewhere'});
  await assert.rejects(async () => store.finishConversationTurn(terminal(request,{content:'RAW_PROVIDER_SECRET'})),status(400));
  await assert.rejects(() => store.completeConversationTurn({epoch:request.epoch,requestId:request.requestId,messageId:request.assistantMessageId,content:'Bypass'}),status(409));
  const result = await store.finishConversationTurn(terminal(request));
  assert.equal(result.status,'failed'); assert.equal(result.assistantMessage.content,'The assistant is temporarily unavailable.');
  assert.deepEqual(await store.readConversation(),second.conversation);
  await store.reset();
  assert.deepEqual(await open()('account-a').readConversationTurn(request.threadId,request.requestId),result);
  const restored = await store.switchConversationThread({...token(await store.readConversation()),threadId:request.threadId});
  assert.equal(restored.conversation.messages.at(-1).id,request.assistantMessageId);
});

test('expired turns recover as interrupted with no rerun, including after process restart', async t => {
  const {open} = await fixture(t); let now = new Date('2026-10-10T12:00:00Z');
  const options = {clock:() => now}, store = open(options)('account-a'), request = await prepareTurn(store,5);
  assert.equal((await store.beginConversationTurn(request)).shouldRun,true);
  assert.deepEqual(await store.recoverConversationTurns(),{recovered:[]});
  now = new Date('2026-10-10T12:00:06Z');
  const reloaded = open(options)('account-a'), recovered = await reloaded.recoverConversationTurns();
  assert.equal(recovered.recovered.length,1); assert.equal(recovered.recovered[0].status,'interrupted');
  assert.match(recovered.recovered[0].assistantMessage.content,/not rerun/);
  assert.equal((await reloaded.beginConversationTurn(request)).shouldRun,false);
  assert.deepEqual(await reloaded.recoverConversationTurns(),{recovered:[]});
  await assert.rejects(() => reloaded.finishConversationTurn(terminal(request,{status:'succeeded',publicErrorCode:'none',content:'Too late'})),status(409));
  const next = await prepareTurn(reloaded,1); await reloaded.beginConversationTurn(next);
  now = new Date('2026-10-10T12:00:08Z');
  const replay = await reloaded.beginConversationTurn(next);
  assert.equal(replay.status,'interrupted'); assert.equal(replay.shouldRun,false);
});

test('terminal marker, result and message are one atomic local save; a failed finish is retryable', async t => {
  const {open} = await fixture(t), store = open()('account-a'), request = await prepareTurn(store);
  await store.beginConversationTurn(request);
  const rename = fs.rename;
  fs.rename = async () => { throw new Error('Injected terminal commit failure'); };
  try { await assert.rejects(() => store.finishConversationTurn(terminal(request)),/Injected/); }
  finally { fs.rename = rename; }
  assert.equal((await store.readConversationTurn(request.threadId,request.requestId)).status,'running');
  assert.equal((await store.readConversation()).messages.length,1);
  assert.equal((await store.beginConversationTurn(request)).shouldRun,false);
  await store.finishConversationTurn(terminal(request));
  assert.equal((await store.readConversation()).messages.length,2);
});
