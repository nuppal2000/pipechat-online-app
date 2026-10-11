'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {createConversationStore}=require('../lib/conversation-store');
const {BackendError}=require('../lib/backend-contract');
const telemetry=require('../lib/beta-telemetry');

test('durable route shares request ID with usage and emits terminal request/plan telemetry only once',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pipechat-turn-telemetry-'));
  t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('pipechat-turn-telemetry-'));await fs.rm(directory,{recursive:true,force:true});});
  const locks=new Map(),lock=(key,work)=>{const next=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(work);locks.set(key,next);return next;};
  const store=createConversationStore(directory,lock)('fixture-account'),events=[],reservations=[],finished=[];
  let modelCalls=0,mode='success';
  const json=value=>JSON.parse(JSON.stringify(value));
  const backend={...store,finishConversationTurn:input=>store.finishConversationTurn(json(input)),reserveUsage:async(_token,id)=>{reservations.push(id);if(mode==='quota')throw new BackendError('Quota',402);return {reservationId:id};},
    finishUsage:async(_token,id,outcome)=>{finished.push({id,outcome});return {used:1,limit:10,remaining:9};}};
  const source=await fs.readFile(path.join(__dirname,'../server.js'),'utf8');
  const code=source.slice(source.indexOf('function turnResponse('),source.indexOf('const readiness ='));
  const context=vm.createContext({Date,OPENAI_API_KEY:'OFFLINE',RequestError:BackendError,conversationCore:{validateState:value=>require('../lib/conversation-core').validateState(json(value))},
    backendToken:()=>null,prepareConversation:async()=>null,saveConversationMemory:async()=>{},
    planPipeChatAction:async()=>{modelCalls++;if(mode==='failure')throw new Error('PRIVATE_PROVIDER_DETAIL');return {assistantMessage:'Validated response',crmAction:null,lifecycle:{planId:'a'.repeat(64)}};}});
  vm.runInContext(code+';globalThis.run=runConversationTurn;',context);
  async function request(command) {
    const page=await store.readConversation(),userMessageId=randomUUID();
    const saved=await store.writeConversation({epoch:page.epoch,version:page.version,messages:[{id:userMessageId,role:'user',content:command}],state:{focus:{ids:[1]}}});
    const turn={threadId:(await store.listConversationThreads()).activeThreadId,requestId:randomUUID(),userMessageId,assistantMessageId:randomUUID()};
    return {userCommand:command,conversation:saved,turn,_recordTelemetry:async event=>{
      assert(!['accepted','running'].includes((await store.readConversationTurn(turn.threadId,turn.requestId)).status));
      events.push(telemetry.sanitizeEvent({...event,requestId:turn.requestId,conversationId:saved.epoch}));
    }};
  }
  const payload=await request('Success');
  const result=await context.run({backend},{id:'fixture-account'},payload);
  assert.equal(result.turn.status,'succeeded');assert.equal(modelCalls,1);assert.deepEqual(reservations,[payload.turn.requestId]);
  assert.deepEqual(finished,[{id:payload.turn.requestId,outcome:'commit'}]);assert.deepEqual(events.map(event=>event.stage),['request','plan']);
  assert(events.every(event=>event.requestId===payload.turn.requestId&&event.attempt===0&&event.model==='unknown'&&event.planId==='a'.repeat(64)));
  await context.run({backend},{id:'fixture-account'},payload);assert.equal(modelCalls,1);assert.equal(events.length,2);assert.equal(reservations.length,1);
  mode='failure';const failed=await request('Failure');
  assert.equal((await context.run({backend},{id:'fixture-account'},failed)).turn.status,'failed');
  assert.equal(events.at(-1).stage,'request');assert.equal(events.at(-1).outcome,'failed');assert.equal(events.at(-1).errorCode,'unavailable');
  assert.deepEqual(finished.at(-1),{id:failed.turn.requestId,outcome:'release'});assert(!JSON.stringify(events).includes('PRIVATE_PROVIDER_DETAIL'));
  mode='quota';const quota=await request('Quota');
  const refused=await context.run({backend},{id:'fixture-account'},quota);assert.equal(refused.turn.publicErrorCode,'quota');assert.equal(modelCalls,2);
  assert.equal(events.at(-1).errorCode,'quota');assert.equal((await store.readConversation()).messages.at(-1).id,quota.turn.assistantMessageId);
});
