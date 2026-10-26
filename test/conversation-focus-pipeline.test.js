'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const crypto=require('node:crypto');
const Core=require('../public/pipeline-core'),Schema=require('../public/table-schema'),Todo=require('../public/todo-core');
const Plan=require('../public/workspace-plan'),Reports=require('../public/report-engine'),Dashboard=require('../public/dashboard-board');
const Conversation=require('../public/conversation'),ConversationCore=require('../lib/conversation-core');
const ConversationIntent=require('../lib/conversation-intent-context');
const Grounding=require('../lib/ai-grounding'),Review=require('../lib/action-review');
const {BackendError}=require('../lib/backend-contract');
const F=require('./fixtures/workspace-plans.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));
const version='2026-10-10T12:00:00.000Z';
const nine=[1,2,3,4,5,6,7,8,9],three=[1,2,3];
const open=F.where('f_stage','in',null,['Prospecting','Qualified','Proposal Sent','Negotiation']);
const blank=F.where('f_follow','is_blank');
const commands={audit:'Audit open deals with blank follow-up.',
  ravi:"Only Ravi's from that set names,count,total,average answer in chat",
  same:'For that same set give count,sum,average,median and totals by owner answer only'};
const read=outputs=>({op:'read_records',id:'answer',label:'Read the selected records',selection:'selected',showTable:false,
  outputs:outputs.map(kind=>({kind,field:['count','names'].includes(kind)?null:'f_value'}))});
const spec=()=>({version:1,title:'Totals by owner',chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,
  measures:[{label:'Value',metric:'sum',field:'f_value',where:[]}],where:[],sort:'label_asc',limit:null});
const audit=(baseIncludesBlank=true)=>({action:'audit_records',scope:'all',where:[[open,...(baseIncludesBlank?[blank]:[])]],
  groups:[{label:'Missing follow-up',where:[[blank]]}]});
const ravi=()=>F.plan([F.select('selected',[[F.where('f_owner','equals','Ravi')]],{source:'focus'}),read(['names','count','sum','average'])]);
const same=()=>F.plan([F.select('selected',[],{source:'focus'}),read(['count','sum','average','median']),
  {op:'report',id:'totals',label:'Total by owner for the same selection',selection:'selected',showDashboard:false,spec:spec(),
    questions:[{kind:'summary',elementIds:['totals']},{kind:'groups',elementId:'totals',measure:0}]}]);

function workspace(){
  const w=F.workspace();
  // Extra Ravi rows catch accidental all-table selection; row 11 also catches
  // conflating the audit's visible base predicate with its missing-date group.
  w.records=Array.from({length:12},(_,i)=>({...w.records[0],id:i+1,f_deal:'Account '+(i+1),
    f_owner:i<3||i>=9?'Ravi':'Alex',f_value:[100,300,800,1000,2000,3000,4000,5000,6000,7000,8000,9000][i],
    f_stage:i===9?'Closed Won':i===11?'':['Prospecting','Qualified','Proposal Sent','Negotiation'][i%4],
    f_follow:i===10?'2026-10-12':''}));
  return w;
}

const uiSource=fs.readFileSync(require.resolve('../public/pipechat'),'utf8').replace(/\r\n/g,'\n');
const serverSource=fs.readFileSync(require.resolve('../server'),'utf8');
const start=serverSource.indexOf('async function prepareConversation('),end=serverSource.indexOf('async function saveConversationMemory(');
assert(start>=0&&end>start);
const server=vm.createContext({aiGrounding:Grounding,conversationIntent:ConversationIntent,conversationCore:{...ConversationCore,
  contextFor:(page,command,recalled)=>ConversationCore.contextFor(plain(page),command,plain(recalled))},
  RequestError:BackendError,backendToken:()=>null,
  prepareAgentContext:async()=>{} // Tested through the full server in agent-persona-server.test.js.
});
vm.runInContext(serverSource.slice(start,end)+';globalThis.prepare=prepareConversation;',server);

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function gate(){const entered=deferred(),released=deferred();return {entered:entered.promise,release:released.resolve,
  async wait(value){entered.resolve(value);await released.promise;}};}

async function harness(t,{baseIncludesBlank=true}={}){
  const w=workspace(),original=plain(w),threadId=crypto.randomUUID(),user={id:'focus-owner',name:'Owner'};
  const current={updatedAt:version,tableSchema:w.tableSchema,customFields:[],deals:w.records,todoCards:[]};
  const page={epoch:crypto.randomUUID(),version:0,messages:[],before:null,state:null,summary:'',summaryThrough:0,memoryMessages:[]};
  const writes=[],loads=[],requests=[],answers=[],errors=[],clients=[],queue=[],outcomes=[],outcomeReads=[],storage=new Map();
  let nextRead=null,nextWrite=null,nextPayload=null;
  const backend={readCrm:async()=>plain(current),readConversation:async()=>ConversationCore.validatePage(plain(page)),
    listConversationThreads:async()=>({activeThreadId:threadId,epoch:page.epoch}),searchConversation:async()=>[],
    readConversationOutcomes:async id=>{
      assert.equal(id,threadId,'lifecycle reads must target the authenticated active thread');
      const result=plain(outcomes).sort((a,b)=>b.finishedAt.localeCompare(a.finishedAt)||a.requestId.localeCompare(b.requestId)).slice(0,12);
      outcomeReads.push({threadId:id,outcomes:plain(result)});return result;
    }};
  function append(message){page.messages.push({...message,seq:page.messages.length+1,createdAt:version});}
  async function api(url,options){
    if(url==='/api/conversations')return {...await backend.listConversationThreads(),threads:[{id:threadId,title:'Focus regression',active:true,messageCount:page.messages.length}]};
    if(url.startsWith('/api/conversation')&&(!options?.method||options.method==='GET')){
      const snapshot=await backend.readConversation();loads.push(plain(snapshot));
      const blocked=nextRead;nextRead=null;if(blocked)await blocked.wait(snapshot);
      return snapshot;
    }
    if(url==='/api/conversation'&&options.method==='PUT'){
      const input=ConversationCore.validateWrite(JSON.parse(options.body));writes.push(plain(input));
      const blocked=nextWrite;nextWrite=null;if(blocked)await blocked.wait(input);
      assert.equal(input.epoch,page.epoch);assert.equal(input.version,page.version,'flush must rebase after the server assistant append');
      for(const message of input.messages)append(message);
      page.state=input.state;page.version++;
      return {epoch:page.epoch,version:page.version};
    }
    if(url==='/api/pipechat-ai'){
      const payload=JSON.parse(options.body),browser=plain(payload);
      if(nextPayload){const change=nextPayload;nextPayload=null;change(payload);}
      let context;
      try{context=await server.prepare({backend},user,payload);}
      catch(error){errors.push(error.message);throw error;}
      requests.push({browser,grounded:plain(payload),saved:plain(context.page.state),outcomes:plain(outcomeReads.at(-1).outcomes)});
      const action=queue.shift();assert(action,'Every offline model response must be explicitly queued');
      const response={crmAction:action,assistantMessage:'Offline fixture response',ai:{workspaceVersion:version}};
      response.computedAnswer=Review.renderAnswer(payload,response);
      answers.push(response.computedAnswer);
      append({id:payload.turn.assistantMessageId,role:'assistant',content:response.computedAnswer||response.assistantMessage});
      outcomes.push({requestId:payload.turn.requestId,userMessageId:payload.turn.userMessageId,assistantMessageId:payload.turn.assistantMessageId,
        status:'succeeded',publicErrorCode:'none',finishedAt:version});
      page.version++;
      // Model output is fixed; no provider request or server is started. Like a
      // durable turn append, this advances the archive version without focus.
      return {...response,turn:{threadId,epoch:page.epoch,status:'succeeded'}};
    }
    throw new Error('Unexpected offline API call: '+url);
  }
  function makeUI(){
    const nodes=new Map();
    const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,disabled:false,innerHTML:'',
      scrollTop:0,scrollHeight:0,classList:{add(){},remove(){},toggle(){}},addEventListener(){},removeEventListener(){}});return nodes.get(id);};
    const window={PipelineCore:Core,PipeChatSchema:Schema,PipeChatTodo:Todo,PipeChatIcons:{},PipeChatPlan:Plan,
      PipeChatReports:Reports,PipeChatDashboard:Dashboard,PipeChatConversation:{create(options){const client=Conversation.create(options);clients.push(client);return client;}}};
    const startup='  wire();\n  restoreSession();';assert(uiSource.includes(startup));
    // Same VM startup replacement as proposal-context-ui.test.js. Keep say,
    // send, acceptTurnResponse, state persistence and action execution intact.
    vm.runInNewContext(uiSource.replace(startup,`render=()=>{};renderTrust=()=>{};syncWorkspacePanes=()=>{};focusTrust=()=>{};
      toast=text=>errors.push(text);updateUsage=()=>{};paintMessage=()=>{};api=handler;
      window.test={S,useSchema,send,acceptTurnResponse,handleAction,saveChatState,loadChat,aiPayload,tableView,reviewRestoredProposal,
        get conversation(){return conversation;},get restored(){return restoredProposal;}};`),
    {window,document:{getElementById:node},crypto,handler:api,errors,Intl,Date,TextEncoder,setTimeout,clearTimeout,AbortSignal,
      sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
    const h=window.test;h.useSchema(plain(w.tableSchema));
    Object.assign(h.S,{loaded:true,user,records:plain(w.records),customFields:[],todoCards:[],updatedAt:version,generation:1,
      health:{conversationPersistence:true,conversationThreads:true,aiConfigured:true}});
    h.S.report=Core.create(w.tableSchema).reconcileReport(h.S.report,[]);
    return h;
  }
  let ui=makeUI();await ui.loadChat();
  t.after(()=>{for(const client of clients)client.stop();});
  async function send(action,command){const count=requests.length;queue.push(action);await ui.send(command);
    assert.equal(requests.length,count+1,errors.join('\n'));assert.deepEqual(errors,[]);assert.equal(queue.length,0);
    const request=requests.at(-1),intent=request.grounded.conversationIntent;
    assert.equal(outcomeReads.length,requests.length,'each prepared request reads authoritative outcomes');
    assert.equal(intent.latestUserMessage.id,request.browser.turn.userMessageId);
    assert.equal(intent.latestUserMessage.content,command);
    assert.equal(intent.terminalTurns.length,count,'the current request must not appear as a historical terminal turn');
    for(const turn of intent.terminalTurns){
      assert(request.outcomes.some(outcome=>outcome.requestId===turn.requestId));
      assert.equal(turn.status,'succeeded');assert.equal(turn.intentState,'not_inferred');
      for(const [key,role] of [['userMessage','user'],['assistantMessage','assistant']]){
        const saved=page.messages.find(message=>message.id===turn[key+'Id']);
        assert.equal(turn[key].seq,saved.seq);
        assert.deepEqual(request.grounded.conversationHistory[turn[key].historyIndex],{role,content:saved.content});
      }
    }
  }
  async function reload(){ui.conversation.stop();ui=makeUI();await ui.loadChat();assert(ui.conversation.ready);assert.deepEqual(errors,[]);return ui;}
  return {get ui(){return ui;},w,original,current,page,backend,threadId,user,writes,loads,requests,answers,send,reload,
    audit:()=>send(audit(baseIncludesBlank),commands.audit),narrow:()=>send(ravi(),commands.ravi),follow:()=>send(same(),commands.same),
    holdRead(){return nextRead=gate();},holdWrite(){return nextWrite=gate();},changeNextPayload(change){nextPayload=change;}};
}

function assertFocus(value,ids=three){assert.deepEqual(plain(value),{kind:'table',ids});}
function viewOf(h){return plain({tableView:h.ui.tableView(),tab:h.ui.S.tab,report:h.ui.S.report,dashboard:h.ui.S.dashboard});}
function assertUnchanged(h,view){
  assert.deepEqual(viewOf(h),view,'answer-only operations must preserve the broader table and dashboard views');
  assert.deepEqual(plain(h.ui.S.records),h.original.records);assert.deepEqual(h.current.deals,h.original.records);
  assert.equal(h.ui.S.updatedAt,version);assert.equal(h.ui.S.pending,null);assert.equal(h.ui.S.clarification,null);
  assert.equal(h.ui.S.sourceAction,null);assert.equal(h.ui.restored,null);
}
function assertGroundedThree(h,visibleIds=nine){
  const request=h.requests.at(-1);
  assertFocus(request.browser.pipeline.conversationFocus);assertFocus(request.saved.focus);assertFocus(request.grounded.pipeline.conversationFocus);
  assert.deepEqual(request.grounded.pipeline.visibleIds,visibleIds);
  assert.deepEqual(request.grounded.pipeline.tableView.visibleIds,visibleIds);
  assert.equal(request.grounded.pendingAction,null);assert.equal(request.grounded.pendingClarification,null);
  assert.equal(request.browser.conversation.version,request.grounded.conversation.version);
  const computed=Review.evidence(request.grounded,{crmAction:same()});
  assert.deepEqual(computed.queryResults.map(result=>result.recordIds),[three,three],'read and grouped report must share exact focus');
  assert.deepEqual(computed.queryResults.map(result=>result.viewEffect),['answer_only','answer_only']);
  const answer=h.answers.at(-1);
  for(const text of ['Record count: 3.','Total Value: $1,200','Average Value: $400','Median Value: $300','Ravi'])assert(answer.includes(text),answer);
  assert(!answer.includes('Alex'),answer);
  assertFocus(h.ui.S.focus);
}

test('immediate follow-up flushes the three-record workspace_plan focus after durable current.load rebasing',async t=>{
  const h=await harness(t);await h.audit();assert.deepEqual(plain(h.ui.S.focus.ids),nine);
  const view=viewOf(h);await h.narrow();
  assertFocus(h.ui.S.focus);assert(h.ui.conversation.dirty,'Ravi focus has not yet reached the delayed autosave');
  assert.deepEqual(h.page.state.focus.ids,nine,'server still has the request-time audit state');
  assert.deepEqual(h.loads.at(-1).state.focus.ids,nine,'acceptTurnResponse loaded the earlier nine-record state');
  assert.match(h.answers.at(-1),/Record count: 3/);
  await h.follow();assertGroundedThree(h);assertUnchanged(h,view);
  await h.ui.conversation.flush();assertFocus(h.page.state.focus);
  assert.equal(h.page.messages.length,6,'quietTurnReply must not append a second assistant answer');
});

test('delayed acceptTurnResponse load does not restore its nine-record state over the interpreted three-record result',async t=>{
  const h=await harness(t);await h.audit();await h.ui.conversation.flush();const view=viewOf(h);
  const blocked=h.holdRead(),pending=h.narrow();
  try{
    const loaded=await blocked.entered;
    assert.deepEqual(loaded.state.focus.ids,nine);assert.deepEqual(plain(h.ui.S.focus.ids),nine);
    assert.equal(h.requests.length,2);assert.match(h.answers.at(-1),/Record count: 3/);
  }finally{blocked.release();await pending;}
  assertFocus(h.ui.S.focus);await h.follow();assertGroundedThree(h);assertUnchanged(h,view);
});

test('send waits for an in-flight focus save before building the next payload and grounding it',async t=>{
  const h=await harness(t);await h.audit();const view=viewOf(h);await h.narrow();
  const blocked=h.holdWrite(),flush=h.ui.conversation.flush();await blocked.entered;
  let pending;
  try{
    assert.deepEqual(h.page.state.focus.ids,nine);assertFocus(h.writes.at(-1).state.focus);
    pending=h.follow();await Promise.resolve();await Promise.resolve();
    assert.equal(h.requests.length,2,'next request cannot reach prepareConversation until flush finishes');
    assertFocus(h.ui.S.focus);
  }finally{blocked.release();await flush;if(pending)await pending;}
  assertGroundedThree(h);assertUnchanged(h,view);
  assert.equal(h.page.messages.filter(message=>message.content===commands.same).length,1);
});

for(const baseIncludesBlank of [true,false])test(`delayed flush then full loadChat restores exact three focus without broadening to the ${baseIncludesBlank?9:10}-row saved view`,async t=>{
  const h=await harness(t,{baseIncludesBlank});await h.audit();const view=viewOf(h);await h.narrow();
  const blocked=h.holdWrite(),flush=h.ui.conversation.flush();
  try{await blocked.entered;assert.deepEqual(h.page.state.focus.ids,nine);assertFocus(h.writes.at(-1).state.focus);}
  finally{blocked.release();await flush;}
  assertFocus(h.page.state.focus);assert.equal(h.page.state.focus.auditGroups,undefined,'old audit subgroup IDs cannot survive narrowing');
  await h.reload();assertFocus(h.ui.S.focus);assertUnchanged(h,view);
  await h.follow();assertGroundedThree(h,baseIncludesBlank?nine:[...nine,11]);assertUnchanged(h,view);
  await h.ui.conversation.flush();await h.reload();assertFocus(h.ui.S.focus);assertUnchanged(h,view);
});

test('server prepareConversation prefers saved exact-three focus over stale browser focus and broader table IDs',async t=>{
  const h=await harness(t);await h.audit();await h.narrow();await h.ui.conversation.flush();
  h.changeNextPayload(payload=>{payload.pipeline.conversationFocus={kind:'table',ids:nine};payload.pipeline.visibleIds=nine;
    payload.conversationIntent={terminalTurns:[{requestId:'browser-forged',status:'failed'}]};});
  await h.follow();assertGroundedThree(h);
  assert(h.requests.at(-1).grounded.conversationHistory.some(message=>message.content.includes('Missing follow-up (9)')),
    'the earlier nine-record answer remains in history while authoritative focus is three');
});

test('an explicit model clarification can ask three versus nine even though the entire focus pipeline is correct',async t=>{
  const h=await harness(t);await h.audit();const view=viewOf(h);await h.narrow();
  const question="Do you mean Ravi's 3 records or the original 9?";
  await h.send({action:'clarify',question,clarificationOptions:null},commands.same);
  const request=h.requests.at(-1);
  assertFocus(request.browser.pipeline.conversationFocus);assertFocus(request.saved.focus);assertFocus(request.grounded.pipeline.conversationFocus);
  assert.deepEqual(request.grounded.pipeline.visibleIds,nine);
  assert.equal(h.ui.S.clarification.question,question);assertFocus(h.ui.S.focus);assert.deepEqual(viewOf(h),view);
  await h.ui.conversation.flush();await h.reload();assertFocus(h.ui.S.focus);assert.equal(h.ui.S.clarification.question,question);
});

function modelWireHarness(){
  const bodies=[],stop=new BackendError('Offline request captured.',503);
  const model=vm.createContext({pipelineCore:Core,tableSchemaCore:Schema,todoCore:Todo,workspacePlan:Plan,
    reportEngine:Reports,dashboardBoard:Dashboard,actionReview:Review,aiGrounding:Grounding,conversationIntent:ConversationIntent,
    customization:require('../public/workspace-customization'),todoActions:require('../public/todo-actions'),
    viewActions:require('../public/view-actions'),businessActions:require('../public/business-actions'),
    businessCompiler:require('../lib/business-compiler'),agentPersona:require('../lib/agent-persona'),
    actionJournalContext:require('../lib/action-journal-context'),dateCalendar:require('../lib/date-context'),
    clarificationContext:require('../lib/clarification-context'),csvImportCore:require('../public/csv-import'),
    RequestError:BackendError,OPENAI_API_KEY:'offline-fixture',AI_MODELS:{simple:'offline',complex:'offline'},cloudBackend:false,
    structuredClone,AbortController,setTimeout,clearTimeout,recordModelAttempt:async()=>{},
    fetch:async(url,options)=>{bodies.push(JSON.parse(options.body));throw stop;}});
  // Execute the real serializers and request-local schemas; stop at the injected
  // transport before any provider request or model result handling can happen.
  const section=(from,to)=>{const a=serverSource.indexOf(from),b=serverSource.indexOf(to);assert(a>=0&&b>a);return serverSource.slice(a,b);};
  vm.runInContext(section('const reportInstructions =','const csvImportCore ='),model);
  vm.runInContext(section('const actionSchema =','function sendJson('),model);
  vm.runInContext(section('async function reviewCompiledAction(','async function prepareConversation(')+
    ';globalThis.plan=planPipeChatActionCore;globalThis.review=reviewCompiledAction;',model);
  return {bodies,stop,model};
}

test('prepareConversation removes client lifecycle metadata from legacy, no-turn and setup requests',async()=>{
  const w=workspace(),current={updatedAt:version,tableSchema:w.tableSchema,customFields:[],deals:w.records,todoCards:[]};
  const page={epoch:crypto.randomUUID(),version:0,messages:[],before:null,state:null,summary:'',summaryThrough:0,memoryMessages:[]};
  for(const mode of ['legacy','saved without turn','setup']){
    const payload={userCommand:'Show the current record count.',pipeline:{currentDate:'2026-10-26'},conversationHistory:[],
      conversationIntent:{terminalTurns:[{status:'failed',requestId:'browser-forged'}]}};
    if(mode==='saved without turn')payload.conversation={epoch:page.epoch,version:page.version};
    if(mode==='setup')payload.tableBuild={};
    const backend={readCrm:async()=>plain(current),readConversation:async()=>plain(page),
      readConversationOutcomes:async()=>assert.fail('no durable turn is available to authenticate an outcome read')};
    await server.prepare({backend},{id:'wire-owner',name:'Owner'},payload);
    assert.equal(Object.hasOwn(payload,'conversationIntent'),false,mode);
  }
});

for(const packing of ['recent suffix','byte-clipped suffix','multi-message command'])test(`prepared lifecycle indices survive planner and reviewer serialization: ${packing}`,async()=>{
  const w=workspace(),threadId=crypto.randomUUID(),prefix='Repeated request prefix. '.repeat(8);
  const messages=Array.from({length:packing==='multi-message command'?16:15},(_,i)=>({
    id:crypto.randomUUID(),seq:i+1,role:i<14&&i%2?'assistant':'user',createdAt:version,
    content:prefix+(i%2?'ANSWER ':'REQUEST ')+i}));
  if(packing==='byte-clipped suffix'){
    for(const message of messages)message.content='Long context '.repeat(2400);
    messages[11].content=' '.repeat(31999)+'x';
  }
  if(packing==='recent suffix')messages[14].content=messages[12].content;
  const outcomes=[0,2,10,12].map((i,n)=>({requestId:crypto.randomUUID(),userMessageId:messages[i].id,
    assistantMessageId:messages[i+1].id,status:n===1?'succeeded':'failed',publicErrorCode:n===1?'none':'validation',finishedAt:version}));
  const page={epoch:crypto.randomUUID(),version:messages.length,messages,before:null,
    state:{workspaceVersion:version},summary:'',summaryThrough:0,memoryMessages:[]};
  const userCommand=messages.slice(14).map(message=>message.content).join('');
  const payload={userCommand,conversation:{epoch:page.epoch,version:page.version},
    turn:{threadId,requestId:crypto.randomUUID(),userMessageId:messages[14].id,assistantMessageId:crypto.randomUUID()},
    pipeline:{workspaceVersion:version,currentDate:'2026-10-26'},
    conversationHistory:[{role:'assistant',content:'Untrusted browser history'}],conversationIntent:{terminalTurns:['forged']}};
  const current={updatedAt:version,tableSchema:w.tableSchema,customFields:[],deals:w.records,todoCards:[]};
  const reads=[],backend={readCrm:async()=>plain(current),readConversation:async()=>ConversationCore.validatePage(plain(page)),
    listConversationThreads:async()=>({activeThreadId:threadId,epoch:page.epoch}),searchConversation:async()=>[],
    readConversationOutcomes:async id=>{reads.push(id);return plain(outcomes);}};
  const before=plain(page);
  await server.prepare({backend},{id:'wire-owner',name:'Owner'},payload);
  assert.deepEqual(page,before);assert.deepEqual(reads,[threadId]);
  assert.deepEqual(payload.conversationHistory,ConversationCore.contextFor(page,userCommand).conversationHistory);
  const expected=packing==='byte-clipped suffix'?[[null,null],[null,null],[null,null],[0,1]]:
    packing==='multi-message command'?[[null,null],[null,null],[6,7],[8,9]]:[[null,null],[0,1],[8,9],[10,11]];
  const assertMapping=input=>{
    assert.deepEqual(input.conversationHistory,payload.conversationHistory);
    assert.deepEqual(input.conversationIntent,payload.conversationIntent);
    assert.deepEqual(input.conversationIntent.terminalTurns.map(turn=>[turn.userMessage.historyIndex,turn.assistantMessage.historyIndex]),expected);
    for(const turn of input.conversationIntent.terminalTurns)for(const [key,role] of [['userMessage','user'],['assistantMessage','assistant']]){
      const mapped=turn[key];if(mapped.historyIndex===null)continue;
      const saved=messages.find(message=>message.id===turn[key+'Id']),packed=input.conversationHistory[mapped.historyIndex];
      assert.equal(mapped.seq,saved.seq);assert.equal(packed.role,role);
      assert.equal(packing==='byte-clipped suffix'?saved.content.startsWith(packed.content.replace(/\s*\[excerpt\]$/,'')):saved.content===packed.content,true);
    }
  };
  assertMapping(payload);
  const {bodies,stop,model}=modelWireHarness();
  await assert.rejects(model.plan(payload,{tier:'complex',model:'offline'},Date.now()),error=>error===stop);
  assert.equal(bodies.length,1);
  const planner=JSON.parse(bodies[0].input[0].content[0].text);assertMapping(planner);
  const compiled=F.plan([F.select('selected',[]),read(['count'])]);
  const computed=Review.evidence(payload,{crmAction:compiled});
  await assert.rejects(model.review({...planner,compiled,computed,proposalMessage:'Offline count.'},Date.now(),payload),error=>error===stop);
  assert.equal(bodies.length,2);assertMapping(JSON.parse(bodies[1].input));
  for(const body of bodies)assert(body.instructions.includes(ConversationIntent.instructions));
  if(packing==='recent suffix'){
    const turns=payload.conversationIntent.terminalTurns;
    assert.equal(turns[1].userMessage.content,turns[3].userMessage.content,'bounded excerpts alone cannot distinguish these saved requests');
    assert.notEqual(planner.conversationHistory[0].content,planner.conversationHistory[10].content);
    assert.equal(planner.conversationHistory.length,12,'exclude only the last repeated command, not its earlier identical occurrence');
  }
});
