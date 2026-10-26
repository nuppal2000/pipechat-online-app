'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const crypto=require('node:crypto');
const Core=require('../public/pipeline-core'),Schema=require('../public/table-schema'),Todo=require('../public/todo-core');
const Plan=require('../public/workspace-plan'),Reports=require('../public/report-engine'),Dashboard=require('../public/dashboard-board');
const Conversation=require('../public/conversation'),ConversationCore=require('../lib/conversation-core');
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
const server=vm.createContext({aiGrounding:Grounding,conversationCore:{...ConversationCore,
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
  const writes=[],loads=[],requests=[],answers=[],errors=[],clients=[],queue=[],storage=new Map();
  let nextRead=null,nextWrite=null,nextPayload=null;
  const backend={readCrm:async()=>plain(current),readConversation:async()=>ConversationCore.validatePage(plain(page)),
    listConversationThreads:async()=>({activeThreadId:threadId,epoch:page.epoch}),searchConversation:async()=>[]};
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
      const context=await server.prepare({backend},user,payload);
      requests.push({browser,grounded:plain(payload),saved:plain(context.page.state)});
      const action=queue.shift();assert(action,'Every offline model response must be explicitly queued');
      const response={crmAction:action,assistantMessage:'Offline fixture response',ai:{workspaceVersion:version}};
      response.computedAnswer=Review.renderAnswer(payload,response);
      answers.push(response.computedAnswer);
      append({id:payload.turn.assistantMessageId,role:'assistant',content:response.computedAnswer||response.assistantMessage});
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
    assert.equal(requests.length,count+1,errors.join('\n'));assert.deepEqual(errors,[]);assert.equal(queue.length,0);}
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
  h.changeNextPayload(payload=>{payload.pipeline.conversationFocus={kind:'table',ids:nine};payload.pipeline.visibleIds=nine;});
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
