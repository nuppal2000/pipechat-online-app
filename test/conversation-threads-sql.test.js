'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {PGlite} = require('@electric-sql/pglite');
const {legacySchema} = require('../public/table-schema');
const signatures = {
  read_conversation:['bigint'], write_conversation:['uuid','bigint','jsonb','jsonb'], search_conversation:['text','bigint'],
  save_conversation_memory:['uuid','bigint','bigint','text'], list_conversation_threads:[],
  new_conversation_thread:['uuid','bigint','text'], switch_conversation_thread:['uuid','bigint','uuid'],
  complete_conversation_turn:['uuid','uuid','uuid','text'], read_workspace:[], reset_crm:['text','boolean'],
  commit_action:['text','uuid','uuid','text','text','jsonb'], write_workspace_v2:['jsonb','jsonb','jsonb','text','jsonb'],
  begin_conversation_turn:['uuid','uuid','bigint','uuid','uuid','uuid','integer'],
  finish_conversation_turn:['uuid','uuid','text','text','text','jsonb'],
  read_conversation_turn:['uuid','uuid'], recover_conversation_turns:['integer']
};
const msg = (content, role = 'user') => ({id:randomUUID(), role, content});
const code = (fn, expected) => assert.rejects(fn, error => { assert.equal(error.code, expected, error.message); return true; });

test('015 archive-backed threads against full local migrations 001-014', {timeout:180000}, async t => {
  const db = new PGlite(); t.after(() => db.close());
  const run = async file => db.exec(await fs.readFile(path.join(__dirname, '../db', file), 'utf8'));
  await run('tests/mock-supabase.sql');
  const migrations = (await fs.readdir(path.join(__dirname, '../db/migrations'))).filter(file => /^(00[1-9]|01[0-4])-/.test(file)).sort();
  assert.equal(migrations.length, 14);
  for (const file of migrations) await run('migrations/' + file);
  async function user() {
    const u = {id:randomUUID(), session:randomUUID()};
    await db.query('insert into auth.users(id) values($1)', [u.id]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [u.session,u.id]);
    return u;
  }
  async function as(u, fn, role = 'authenticated') {
    assert(['authenticated','anon','service_role'].includes(role));
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(u ? {sub:u.id, session_id:u.session, role} : {})]);
    await db.exec('set role ' + role);
    try { return await fn(); } finally { await db.exec('reset role'); }
  }
  async function rpc(u, name, args = [], role) {
    const types = signatures[name].slice(0, args.length);
    return as(u, async () => (await db.query(`select public.pipechat_${name}(${types.map((type, i) => '$' + (i + 1) + '::' + type).join(',')}) as result`,
      args.map((arg, i) => types[i] === 'jsonb' ? JSON.stringify(arg) : arg))).rows[0].result, role);
  }
  const read = (u, before) => rpc(u, 'read_conversation', before === undefined ? [] : [before]);
  const write = (u, current, messages, state = null) => rpc(u, 'write_conversation', [current.epoch,current.version,messages,state]);
  const list = u => rpc(u, 'list_conversation_threads');
  const fresh = (u, current, title = 'New work') => rpc(u, 'new_conversation_thread', [current.epoch,current.version,title]);
  const switchTo = (u, current, id) => rpc(u, 'switch_conversation_thread', [current.epoch,current.version,id]);
  const complete = (u, request, role = 'authenticated') => rpc(u, 'complete_conversation_turn', [request.epoch,request.requestId,request.messageId,request.content], role);
  const begin = (u,r,role='authenticated') => rpc(u,'begin_conversation_turn',[r.threadId,r.epoch,r.version,r.requestId,r.userMessageId,r.assistantMessageId,r.leaseSeconds],role);
  const finish = (u,r,options={},role='authenticated') => rpc(u,'finish_conversation_turn',[r.threadId,r.requestId,
    options.status ?? 'failed',options.publicErrorCode ?? 'unavailable',options.content ?? null,options.resultReceipt ?? null],role);
  const receipt = (u,r) => rpc(u,'read_conversation_turn',[r.threadId,r.requestId]);
  const workspaceId = async u => (await db.query('select workspace_id from pipechat.memberships where user_id=$1',[u.id])).rows[0].workspace_id;
  const recover = async (u,role='authenticated') => rpc(u,'recover_conversation_turns',[50],role);
  async function prepareTurn(u) {
    const initial = await read(u), userMessage = msg('Flushed turn request');
    const saved = await write(u,initial,[userMessage],{focus:{ids:[1]}});
    return {...saved,threadId:(await list(u)).activeThreadId,requestId:randomUUID(),userMessageId:userMessage.id,assistantMessageId:randomUUID(),leaseSeconds:120};
  }
  const oldFunctions = async () => (await db.query(`select p.oid,p.proname,p.proacl,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','pipechat') order by p.oid`)).rows;
  const seed = await user(), state = {focus:{ids:[11]}, report:{title:'Own report'}, tableView:{search:'Stored'}, view:'table',
    clarification:{question:'Confirm?'}, sourceAction:{action:'delete_records'}, originalCommand:'Old pending request', workspaceVersion:'old', savedAt:1};
  let current = await read(seed);
  for (let i = 0; i < 113; i += 20) current = await write(seed, current, Array.from({length:Math.min(20,113-i)}, (_, j) => msg('ThreadAlpha ' + (i+j+1), (i+j)%2 ? 'assistant':'user')), state);
  await rpc(seed, 'save_conversation_memory', [current.epoch,0,20,'Preserved summary']);
  const before = await read(seed), functionsBefore = await oldFunctions(), workspaceBefore = await rpc(seed, 'read_workspace');
  const allBefore = (await db.query('select pipechat.conversation_message_json(m) as message from pipechat.conversation_messages m where thread_id=$1 order by seq', [before.epoch])).rows.map(row => row.message);
  await run('migrations/015-conversation-threads.sql');

  await t.test('old functions and active RPC result unchanged; graph/journal definitions remain untouched', async () => {
    const after = await oldFunctions();
    for (const fn of functionsBefore) assert.deepEqual(after.find(value => value.oid === fn.oid), fn);
    assert.deepEqual(await read(seed), before);
    assert.deepEqual(await rpc(seed, 'read_workspace'), workspaceBefore);
    const catalog = await list(seed);
    assert.equal(catalog.threads.length, 1); assert.equal(catalog.threads[0].messageCount, 113);
    assert.deepEqual(Object.keys(catalog.threads[0]).sort(), ['active','createdAt','id','messageCount','title','updatedAt']);
  });

  await t.test('new + switch preserve all history/memory/cursors and isolate state; epochs never revive', async () => {
    const original = (await list(seed)).activeThreadId;
    const second = await fresh(seed, before, 'Other work');
    assert.deepEqual(second.conversation.messages, []); assert.equal(second.conversation.state, null);
    const raw = (await db.query('select snapshot from pipechat.conversation_archives where id=$1', [original])).rows[0].snapshot;
    assert.deepEqual(raw.state, state); assert.deepEqual(raw.messages, allBefore); assert.equal(raw.summaryThrough,20);
    await write(seed, second.conversation, [msg('ThreadBeta')], {focus:{ids:[99]}});
    const restored = await switchTo(seed, await read(seed), original);
    assert.notEqual(restored.conversation.epoch, before.epoch);
    assert.equal(restored.conversation.version, before.version);
    assert.equal(restored.conversation.summary, before.summary); assert.equal(restored.conversation.summaryThrough, before.summaryThrough);
    assert.deepEqual(restored.conversation.messages, before.messages); assert.deepEqual(restored.conversation.memoryMessages, before.memoryMessages);
    assert.deepEqual(restored.conversation.state, {focus:{ids:[11]}, report:{title:'Own report'}, tableView:{search:'Stored'}, view:'table'});
    const middle = await read(seed, restored.conversation.before), oldest = await read(seed, middle.before);
    assert.deepEqual([...oldest.messages,...middle.messages,...restored.conversation.messages], allBefore);
    assert.deepEqual(await rpc(seed,'search_conversation',['ThreadBeta']), []);
    await code(() => write(seed, before, [msg('Stale write')]), 'PT409');
    assert.deepEqual(await rpc(seed,'save_conversation_memory',[before.epoch,20,21,'Old summary']), {saved:false});
    const secondAgain = await switchTo(seed, restored.conversation, second.threadId);
    assert.deepEqual(secondAgain.conversation.state, {focus:{ids:[99]}});
    assert.notEqual(secondAgain.conversation.epoch, second.conversation.epoch);
    assert.deepEqual(await switchTo(seed, secondAgain.conversation, second.threadId), secondAgain);
  });

  await t.test('CAS misses, invalid title, foreign IDs and late transaction failure do not lose history', async () => {
    const u = await user(), first = await read(u), id = (await list(u)).activeThreadId;
    const created = await fresh(u, first);
    await code(() => fresh(u, first), 'PT409');
    await code(() => switchTo(u, first, id), 'PT409');
    await code(() => switchTo(u, created.conversation, randomUUID()), 'PT404');
    for (const name of ['', ' ', 'x'.repeat(161), 'line\nbreak']) await code(() => fresh(u, created.conversation, name), 'PT400');
    await code(() => switchTo(u, created.conversation, null), 'PT400');
    const catalog = await list(u);
    await db.exec(`create function pipechat.thread_test_failure() returns trigger language plpgsql as $$ begin raise exception 'late switch failure'; end $$;
      create trigger z_thread_test_failure after insert on pipechat.conversation_threads for each row execute function pipechat.thread_test_failure();`);
    try { await code(() => switchTo(u, created.conversation, id), 'P0001'); }
    finally { await db.exec('drop trigger z_thread_test_failure on pipechat.conversation_threads; drop function pipechat.thread_test_failure();'); }
    assert.deepEqual(await list(u), catalog); assert.deepEqual(await read(u), created.conversation);
  });

  await t.test('authenticated owner/session isolation even for members sharing a workspace; direct tables denied', async () => {
    const owner = await user(), member = await user(), stranger = await user();
    await db.query('delete from pipechat.workspaces where owner_id=$1', [member.id]);
    await db.query("insert into pipechat.memberships(workspace_id,user_id,role) select workspace_id,$1,'member' from pipechat.memberships where user_id=$2", [member.id,owner.id]);
    const a = await read(owner), b = await read(member), ownerId = (await list(owner)).activeThreadId;
    await write(owner, a, [msg('Private owner')]);
    await code(() => switchTo(member,b,ownerId), 'PT404');
    assert.equal((await list(member)).threads.length, 1); assert.deepEqual((await read(member)).messages, []);
    await code(() => switchTo(stranger, {epoch:randomUUID(),version:0}, ownerId), 'PT409');
    for (const table of ['conversation_archives','conversation_epochs','conversation_completions','conversation_turns']) {
      for (const role of ['authenticated','anon','service_role']) await code(() => as(owner, () => db.query('select * from pipechat.' + table), role), '42501');
    }
    await code(() => rpc(owner,'list_conversation_threads',[],'anon'), '42501');
    await code(() => list({...owner,session:member.session}), 'PT401');
    await db.query('delete from auth.sessions where id=$1',[member.session]);
    await code(() => list(member), 'PT401');
  });

  await t.test('CRM reset keeps archives but clears restored pre-reset state and invalidates epochs', async () => {
    const u = await user(), first = await read(u), original = (await list(u)).activeThreadId;
    await write(u, first, [msg('Survives reset')], {focus:{ids:[1]}, sourceAction:{action:'delete_records'}});
    const workspace = await rpc(u,'read_workspace');
    await rpc(u,'reset_crm',[workspace.updatedAt,true]);
    const empty = await read(u); assert.deepEqual(empty.messages, []); assert.equal(empty.state,null);
    assert.equal((await list(u)).threads.length,2);
    const restored = await switchTo(u,empty,original);
    assert.equal(restored.conversation.messages[0].content,'Survives reset'); assert.equal(restored.conversation.state,null);
    await code(() => write(u,first,[msg('Stale after reset')]),'PT409');
  });

  await t.test('terminal failure append is owner-session-bound, idempotent and routes to archived origin', async () => {
    const u = await user(), other = await user(), first = await read(u), original = (await list(u)).activeThreadId;
    const saved = await write(u,first,[msg('Request')],{focus:{ids:[11]}});
    const request = {epoch:first.epoch,requestId:randomUUID(),messageId:randomUUID(),content:'Terminal failure; no action was applied.'};
    const second = await fresh(u,saved);
    const onceBack = await switchTo(u,second.conversation,original);
    const secondBack = await switchTo(u,onceBack.conversation,second.threadId);
    await code(() => complete(u,request,'service_role'),'42501');
    await code(() => complete(other,request),'PT404');
    await code(() => complete({...u,session:other.session},request),'PT401');
    const result = await complete(u,request);
    assert.equal(result.active,false); assert.equal(result.inserted,true); assert.equal(result.seq,2);
    assert.deepEqual(await read(u),secondBack.conversation);
    assert.deepEqual(await complete(u,request),{...result,inserted:false});
    for (const patch of [{content:'Conflicting reply'},{messageId:randomUUID()},{requestId:randomUUID()}]) await code(() => complete(u,{...request,...patch}),'PT409');
    const resumed = await switchTo(u,secondBack.conversation,original);
    assert.equal(resumed.conversation.messages.length,2); assert.equal(resumed.conversation.messages[1].role,'assistant');
    assert.equal(resumed.conversation.messages[1].content,request.content); assert.deepEqual(resumed.conversation.state,{focus:{ids:[11]}});
    assert.equal((await complete(u,request)).inserted,false);
    const activeAppend = await complete(u,{...request,requestId:randomUUID(),messageId:randomUUID(),content:'Another failed request'});
    assert.equal(activeAppend.active,true); assert.equal(activeAppend.inserted,true);
    assert.deepEqual((await read(u)).state,resumed.conversation.state);
    await db.query('delete from auth.sessions where id=$1',[u.session]);
    await code(() => complete(u,request),'PT401');
  });

  await t.test('014 rejects old pending action epochs after switching away AND back, without changing journal behavior', async () => {
    const u = await user(), workspace = await rpc(u,'read_workspace');
    const ready = await rpc(u,'write_workspace_v2',[[],[],legacySchema(),workspace.updatedAt,[]]);
    const first = await read(u), original = (await list(u)).activeThreadId;
    const candidate = {deals:ready.deals,todoCards:ready.todoCards,tableSchema:ready.tableSchema,customFields:ready.customFields};
    const second = await fresh(u,first);
    const staleRequest = [randomUUID(),randomUUID(),first.epoch,randomUUID(),ready.updatedAt,candidate];
    await code(() => rpc(u,'commit_action',staleRequest),'PT409');
    const validRequest = [randomUUID(),randomUUID(),second.conversation.epoch,randomUUID(),ready.updatedAt,candidate];
    const committed = await rpc(u,'commit_action',validRequest);
    assert.equal(committed.receipt.conversationId,second.conversation.epoch);
    await switchTo(u,second.conversation,original);
    const latest = await rpc(u,'read_workspace');
    await code(() => rpc(u,'commit_action',[randomUUID(),randomUUID(),first.epoch,randomUUID(),latest.updatedAt,candidate]),'PT409');
    // Replaying an already committed journal receipt remains idempotent, not a new action.
    assert.deepEqual(await rpc(u,'commit_action',validRequest),{...committed,replayed:true});
  });

  await t.test('terminal message and receipt roll back together on late SQL failure', async () => {
    const u = await user(), first = await read(u), request = {epoch:first.epoch,requestId:randomUUID(),messageId:randomUUID(),content:'Persist terminal failure'};
    await db.exec(`create function pipechat.completion_test_failure() returns trigger language plpgsql as $$ begin raise exception 'late completion failure'; end $$;
      create trigger completion_test_failure after insert on pipechat.conversation_completions for each row execute function pipechat.completion_test_failure();`);
    try { await code(() => complete(u,request),'P0001'); }
    finally { await db.exec('drop trigger completion_test_failure on pipechat.conversation_completions; drop function pipechat.completion_test_failure();'); }
    assert.deepEqual(await read(u),first);
    assert.equal((await complete(u,request)).inserted,true);
    assert.equal((await complete(u,request)).inserted,false);
    assert.equal((await read(u)).messages.length,1);
  });

  await t.test('queued CAS creates exactly one new thread and parent deletion cascades the private archives', async () => {
    const u = await user(), first = await read(u);
    // PGlite serializes statements; real multi-session ordering uses the SQL row locks.
    const results = await as(u, () => Promise.allSettled(Array.from({length:4}, () => db.query(
      'select public.pipechat_new_conversation_thread($1::uuid,$2::bigint,$3::text)',[first.epoch,first.version,'Concurrent']))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
    assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'PT409'));
    assert.equal((await list(u)).threads.length,2);
    await db.query('delete from auth.users where id=$1',[u.id]);
    assert.equal((await db.query('select count(*)::int as n from pipechat.conversation_archives where user_id=$1',[u.id])).rows[0].n,0);
  });

  await t.test('begin checks user flush/roles and durable identity; queued retries authorize only one provider call', async () => {
    const u = await user(), r = await prepareTurn(u);
    await code(() => begin(u,{...r,userMessageId:randomUUID()}),'PT409');
    await code(() => begin(u,r,'service_role'),'42501');
    await code(() => begin({...u,session:randomUUID()},r),'PT401');
    // One SQL role scope avoids racing session claims in this single-connection
    // harness. PostgreSQL deployments serialize the same requests by row lock.
    const calls = await as(u, () => Promise.all(Array.from({length:5}, () => db.query(
      'select public.pipechat_begin_conversation_turn($1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid,$6::uuid,$7::integer) as result',
      [r.threadId,r.epoch,r.version,r.requestId,r.userMessageId,r.assistantMessageId,r.leaseSeconds]))));
    const results = calls.map(call => call.rows[0].result), initial = results.find(value => value.shouldRun);
    assert.equal(results.filter(value => value.shouldRun).length,1);
    for (const replay of results.filter(value => !value.shouldRun)) assert.deepEqual(replay,{...initial,shouldRun:false});
    assert.equal(initial.shouldRun,true); assert.equal(initial.status,'running'); assert.equal(initial.attempt,1);
    assert.equal(initial.assistantMessageId,r.assistantMessageId); assert.equal(initial.finishedAt,null);
    for (let i=0;i<4;i++) assert.deepEqual(await begin(u,{...r,version:0}),{...initial,shouldRun:false});
    await code(() => begin(u,{...r,assistantMessageId:randomUUID()}),'PT409');
    await code(() => begin(u,{...r,requestId:randomUUID()}),'PT409');
    const second = await fresh(u,await read(u));
    await code(() => begin(u,{...r,threadId:second.threadId,...second.conversation}),'PT409');
    assert.equal((await receipt(u,r)).status,'running');
    await code(() => receipt({id:randomUUID(),session:randomUUID()},r),'PT401');
    const wrongRole = msg('Not a user request','assistant');
    const saved = await write(u,second.conversation,[wrongRole]);
    await code(() => begin(u,{...r,...saved,threadId:second.threadId,requestId:randomUUID(),
      userMessageId:wrongRole.id,assistantMessageId:randomUUID()}),'PT409');
  });

  await t.test('server finish retains current focus, stores one stable result, and is readable beyond the latest 50 messages', async () => {
    const u = await user(), other = await user(), r = await prepareTurn(u); await begin(u,r);
    await code(async () => write(u,await read(u),[{id:r.assistantMessageId,role:'assistant',content:'Browser injection'}]),'PT409');
    await code(() => complete(u,{epoch:r.epoch,requestId:r.requestId,messageId:r.assistantMessageId,content:'Bypass accepted turn'}),'PT409');
    await write(u,await read(u),[],{focus:{ids:[77]},view:'todo'});
    const payload = {status:'succeeded',publicErrorCode:'none',content:'Validated result',resultReceipt:{crmAction:{action:'query_records'}}};
    await code(() => finish(u,r,payload,'service_role'),'42501');
    const result = await finish(u,r,payload);
    assert.equal(result.status,'succeeded'); assert.equal(result.assistantMessage.id,r.assistantMessageId);
    assert.deepEqual((await read(u)).state,{focus:{ids:[77]},view:'todo'});
    assert.deepEqual(await finish(u,r,payload),result);
    await code(() => finish(u,r,{...payload,content:'Competing outcome'}),'PT409');
    await code(() => receipt(other,r),'PT404');
    assert.deepEqual(await begin(u,r),{...result,shouldRun:false});
    for (let i=0;i<60;i+=20) await write(u,await read(u),Array.from({length:20},() => msg('More recent text')),{focus:{ids:[77]}});
    assert.ok(!(await read(u)).messages.some(message => message.id===r.assistantMessageId));
    assert.deepEqual(await receipt(u,r),result);
  });

  await t.test('disconnected-browser failure is archived in its origin and never stores raw provider exceptions', async () => {
    const u = await user(), r = await prepareTurn(u); await begin(u,r);
    const second = await fresh(u,await read(u));
    await code(() => finish(u,r,{content:'RAW_PROVIDER_SECRET'}),'PT400');
    await code(() => finish(u,r,{publicErrorCode:'raw_error'}),'PT400');
    const result = await finish(u,r);
    assert.equal(result.status,'failed'); assert.equal(result.assistantMessage.content,'The assistant is temporarily unavailable.');
    assert.deepEqual(await read(u),second.conversation);
    const restored = await switchTo(u,second.conversation,r.threadId);
    assert.equal(restored.conversation.messages.at(-1).id,r.assistantMessageId);
    assert.deepEqual(await receipt(u,r),result);
  });

  await t.test('expired receipts recover after reset/logout on the next live owner session without rerun', async () => {
    const u = await user(), r = await prepareTurn(u); await begin(u,r);
    assert.deepEqual(await recover(u),{recovered:[]});
    await code(() => recover(u,'service_role'),'42501');
    const workspace = await rpc(u,'read_workspace'); await rpc(u,'reset_crm',[workspace.updatedAt,true]);
    const freshPage = await read(u);
    await db.query("update pipechat.conversation_turns set lease_until=clock_timestamp()-interval '1 second' where request_id=$1",[r.requestId]);
    await db.query('delete from auth.sessions where id=$1',[u.session]);
    await code(() => finish(u,r),'PT401');
    await code(() => recover(u),'PT401');
    u.session=randomUUID(); await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[u.session,u.id]);
    const recovered = await recover(u);
    assert.equal(recovered.recovered.length,1); assert.equal(recovered.recovered[0].status,'interrupted');
    assert.match(recovered.recovered[0].assistantMessage.content,/not rerun/);
    assert.deepEqual(await recover(u),{recovered:[]});
    assert.deepEqual(await read(u),freshPage);
    const replay = await begin(u,r); assert.equal(replay.shouldRun,false); assert.equal(replay.status,'interrupted');
    await code(() => finish(u,r,{status:'succeeded',publicErrorCode:'none',content:'Late model result'}),'PT409');
    const restored = await switchTo(u,freshPage,r.threadId);
    assert.equal(restored.conversation.messages.at(-1).id,r.assistantMessageId);
    assert.equal(restored.conversation.state,null);
  });

  await t.test('expired begin/late finish terminalize to interruption; cancellation is also immutable', async () => {
    const u = await user(), r = await prepareTurn(u); await begin(u,r);
    await db.query("update pipechat.conversation_turns set lease_until=clock_timestamp()-interval '1 second' where request_id=$1",[r.requestId]);
    const replay = await begin(u,r); assert.equal(replay.shouldRun,false); assert.equal(replay.status,'interrupted');
    const next = await prepareTurn(u); await begin(u,next);
    await db.query("update pipechat.conversation_turns set lease_until=clock_timestamp()-interval '1 second' where request_id=$1",[next.requestId]);
    assert.equal((await finish(u,next,{status:'succeeded',publicErrorCode:'none',content:'Arrived after lease'})).status,'interrupted');
    const cancelled = await prepareTurn(u); await begin(u,cancelled);
    const result = await finish(u,cancelled,{status:'cancelled',publicErrorCode:'cancelled'});
    assert.equal(result.status,'cancelled');
    assert.deepEqual(await finish(u,cancelled,{status:'cancelled',publicErrorCode:'cancelled'}),result);
    await code(() => finish(u,cancelled),'PT409');
  });

  await t.test('late finish failure rolls back assistant message, receipt and terminal status together', async () => {
    const u = await user(), r = await prepareTurn(u); await begin(u,r);
    await db.exec(`create function pipechat.turn_test_failure() returns trigger language plpgsql as $$ begin raise exception 'late durable turn failure'; end $$;
      create trigger turn_test_failure after update on pipechat.conversation_turns for each row when(new.assistant_message is not null) execute function pipechat.turn_test_failure();`);
    try { await code(() => finish(u,r),'P0001'); }
    finally { await db.exec('drop trigger turn_test_failure on pipechat.conversation_turns; drop function pipechat.turn_test_failure();'); }
    assert.equal((await receipt(u,r)).status,'running'); assert.equal((await read(u)).messages.length,1);
    assert.equal((await begin(u,r)).shouldRun,false);
    const completed = await finish(u,r); assert.equal(completed.status,'failed');
    assert.equal((await read(u)).messages.length,2);
    assert.deepEqual(await finish(u,r),completed);
  });

  await t.test('publishable-only Supabase adapter drives real authenticated thread and turn RPCs', async () => {
    const u=await user(), calls=[];
    const {createSupabaseBackend}=require('../lib/supabase-backend');
    const backend=createSupabaseBackend({url:'https://offline-thread-test.supabase.co',publishableKey:'sb_publishable_offline_threads_123456789',
      createClient:()=>({rpc:()=>{throw new Error('Health client cannot make authenticated calls');}}),
      createServerClient:(_url,key)=>{
        assert(key.startsWith('sb_publishable_'));
        return {auth:{getUser:async()=>({data:{user:{id:u.id,email:'thread-test@example.invalid',user_metadata:{name:'Thread test'}}},error:null}),
          getSession:()=>{throw new Error('Never trust a decoded browser session');}},rpc:async(name,args={})=>{
          calls.push({name,args});
          const types=signatures[name.replace(/^pipechat_/,'')], values=Object.values(args);
          try{return {data:await as(u,async()=> (await db.query(`select public.${name}(${Object.keys(args).map((arg,i)=>`${arg}=>$${i+1}::${types[i]}`).join(',')}) as result`,
            values.map((value,i)=>types[i]==='jsonb'?JSON.stringify(value):value))).rows[0].result),error:null};}
          catch(error){return {data:null,error:{code:error.code,message:error.message}};}
        }};
      }});
    const adapter=backend.forRequest({headers:{}},{headersSent:false,setHeader(){},getHeader(){}});
    let page=await adapter.readConversation();const first=await adapter.listConversationThreads();
    const userMessage=msg('Hosted adapter turn');
    await assert.rejects(()=>adapter.writeConversation({...page,messages:[userMessage]}),error=>error.status===400);
    const written=await adapter.writeConversation({epoch:page.epoch,version:page.version,messages:[userMessage],state:{focus:{ids:[1]}}});
    const request={...written,threadId:first.activeThreadId,requestId:randomUUID(),userMessageId:userMessage.id,assistantMessageId:randomUUID(),leaseSeconds:120};
    assert.equal((await adapter.beginConversationTurn(request)).shouldRun,true);
    assert.equal((await adapter.beginConversationTurn(request)).shouldRun,false);
    const second=await adapter.newConversationThread({...written,title:'Other hosted chat'});
    const result=await adapter.finishConversationTurn({threadId:request.threadId,requestId:request.requestId,status:'succeeded',publicErrorCode:'none',content:'Hosted saved reply',resultReceipt:{crmAction:null}});
    assert.equal(result.status,'succeeded');assert.deepEqual(await adapter.readConversationTurn(request.threadId,request.requestId),result);
    page=await adapter.readConversation();assert.equal(page.messages.length,0);
    const restored=await adapter.switchConversationThread({epoch:page.epoch,version:page.version,threadId:request.threadId});
    assert.equal(restored.conversation.messages.at(-1).id,request.assistantMessageId);
    assert.deepEqual(await adapter.recoverConversationTurns(),{recovered:[]});
    assert(calls.every(call=>!Object.hasOwn(call.args,'p_user_id')&&!Object.hasOwn(call.args,'p_session_id')));
    await assert.rejects(()=>adapter.readConversationTurn(second.threadId,randomUUID()),error=>error.status===404);
    await db.query('delete from auth.sessions where id=$1',[u.session]);
    await assert.rejects(()=>adapter.listConversationThreads(),error=>error.status===401);
  });
});
