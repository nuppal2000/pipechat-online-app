const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const C=require('../public/pipeline-core.js'),T=require('../public/todo-core.js');
const row={id:1,account:'Acme',stage:'Warm',value:0,close:'',owner:'Sarah',next:'Call',follow:'Tomorrow',notes:'',history:[]};
function harness(initial={deals:[structuredClone(row)],tableSchema:null}){
  const nodes=new Map(),calls=[],messages=[];let failure=false,reply=null,saved={...structuredClone(initial),customFields:[],todoCards:[],updatedAt:'v1'};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',style:{},classList:{add(){},remove(){}},querySelectorAll:()=>[]});return nodes.get(id);};
  const context={crypto,AbortSignal,window:{PipeChatInspector:require('../public/inspector-core.js'),PipelineCore:C,PipeChatTodo:T,PipeChatSchema:require('../public/table-schema.js'),PipeChatIcons:{}},document:{getElementById:node,querySelector:()=>null},sessionStorage:{removeItem(){},setItem(){}},fetch:async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(failure)return {ok:false,status:503,json:async()=>({error:'Test outage'})};
    if(url==='/api/pipechat-ai')return {ok:true,json:async()=>({crmAction:reply,usage:{remaining:9}})};
    if(options.method==='PUT')saved=url==='/api/todo-cards'?{...saved,todoCards:body.todoCards,updatedAt:'v'+(calls.length+1)}:{...body,tableSchema:body.tableSchema||null,updatedAt:'v'+(calls.length+1)};
    return {ok:true,json:async()=>structuredClone(saved)};
  }};
  context.window.messages=messages;
  const source=fs.readFileSync(require.resolve('../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>{};renderTrust=()=>{};toast=()=>{};focusTrust=()=>{};updateUsage=()=>{};say=message=>window.messages.push(message);window.test={S,useSchema,prepare,confirmDraft,cancelDraft,chooseCandidate,undo,persist,manualEdit,aiPayload,send};`),context);
  const h=context.window.test;h.useSchema(saved.tableSchema);saved.tableSchema=JSON.parse(JSON.stringify(h.S.tableSchema));Object.assign(h.S,{records:structuredClone(saved.deals),updatedAt:'v1',user:{id:'local',name:'QA'},loaded:true,usage:{remaining:0},health:{aiConfigured:true}});
  return {...h,calls,messages,node,fail:v=>failure=v,reply:v=>reply=v};
}
const plain=v=>JSON.parse(JSON.stringify(v));

test('bulk card moves preview/cancel, save atomically, undo, and reject stale requests without CRM edits',async()=>{
  const h=harness();h.prepare({action:'add_todos',todos:[{ids:[1],todoNextAction:'Call'},{ids:[1],todoNextAction:'Email'}]});await h.confirmDraft();
  const before=plain(h.S.todoCards),rows=plain(h.S.records),action={action:'move_todos',todoMoves:before.map(c=>({todoId:c.id,todoStatus:'Done'}))};
  h.prepare(action);assert.equal(h.S.pending.count,2);assert.deepEqual(plain(h.S.todoCards),before);h.cancelDraft();assert.deepEqual(plain(h.S.todoCards),before);
  h.prepare(action);h.fail(true);await h.confirmDraft();assert.equal(h.S.pending.count,2);assert.deepEqual(plain(h.S.todoCards),before);
  h.fail(false);await h.confirmDraft();assert(h.S.todoCards.every(c=>c.status==='Done'));assert.match(h.S.undo.label,/2 To Do cards moved/);await h.undo();assert.deepEqual(plain(h.S.todoCards),before);
  h.prepare(action);h.S.revision++;const count=h.calls.length;await h.confirmDraft();assert.equal(h.calls.length,count);assert.deepEqual(plain(h.S.records),rows);assert(h.calls.every(c=>c.url==='/api/todo-cards'));
});

test('successive clarification replies retain choices, original intent and prior answers until preview',async()=>{
  const h=harness();h.S.usage={remaining:10};const original='Add a review task for Acme';
  h.reply({action:'clarify',question:'Which date? (a) 2026-10-01, (b) leave blank',clarificationOptions:[{key:'a',label:'2026-10-01'},{key:'b',label:'leave blank'}]});await h.send(original);
  h.reply({action:'clarify',question:'Which lane? (1) To Do, (2) In Progress',clarificationOptions:[{key:'1',label:'To Do'},{key:'2',label:'In Progress'}]});await h.send('a');
  assert.equal(h.S.clarification.originalCommand,original);assert.equal(h.S.clarification.answers[0].answer,'a');
  h.reply({action:'add_todo',ids:[1],todoNextAction:'Review',todoDueDate:'2026-10-01',todoStatus:'In Progress'});await h.send('2');
  assert.equal(h.calls.at(-1).body.pendingClarification.options[1].label,'In Progress');assert.equal(h.S.clarification,null);assert.equal(h.S.pending.after.status,'In Progress');assert.equal(h.S.todoCards.length,0);
});
test('manual card preview/cancel/confirmation, deletion and undo work at the chat cap without changing rows',async()=>{
  const h=harness(),original=plain(h.S.records);
  h.prepare({action:'add_todo',ids:[1]});assert.equal(h.S.todoCards.length,0);assert.equal(h.calls.length,0);h.cancelDraft();assert.equal(h.calls.length,0);
  h.prepare({action:'add_todo',ids:[1]});await h.confirmDraft();assert.equal(h.S.todoCards.length,1);assert.deepEqual(plain(h.S.records),original);assert.equal(h.calls[0].body.todoCards.length,1);
  h.prepare({action:'delete_todo',todoId:h.S.todoCards[0].id});await h.confirmDraft();assert.equal(h.S.todoCards.length,0);assert.deepEqual(plain(h.S.records),original);
  await h.undo();assert.equal(h.S.todoCards.length,1);assert.deepEqual(plain(h.S.records),original);assert(h.calls.every(c=>c.url==='/api/todo-cards'));assert(h.calls.every(c=>!Object.hasOwn(c.body,'deals')));
});
test('failed card save retains preview; stale and expired proposals cannot overwrite the board',async()=>{
  const h=harness();h.prepare({action:'add_todo',ids:[1]});h.fail(true);await h.confirmDraft();assert(h.S.pending);assert.equal(h.S.todoCards.length,0);
  h.fail(false);h.S.revision++;await h.confirmDraft();assert.equal(h.calls.length,1);assert.equal(h.S.todoCards.length,0);
  h.prepare({action:'add_todo',ids:[1]});h.S.pending.createdAt=Date.now()-31*60*1000;await h.confirmDraft();assert.equal(h.calls.length,1);
});
test('CRM follow-up changes leave cards unchanged; record deletion and Undo restore linked cards',async()=>{
  const h=harness();h.prepare({action:'add_todo',ids:[1],todoDueDate:'2026-10-01',todoNextAction:'Call',todoNotes:'Card note'});await h.confirmDraft();
  const cards=plain(h.S.todoCards);await h.persist([{...row,follow:'Next week'}],'Follow-up');assert.equal(T.project(h.S.todoCards[0],h.S.records,null).dueDate,'2026-10-01');assert.deepEqual(plain(h.S.todoCards),cards);
  await h.persist([],'Delete record');assert.equal(h.S.todoCards.length,0);await h.undo();assert.equal(h.S.todoCards.length,1);assert.equal(h.S.records.length,1);
});
test('CRM requests open Pipeline while card requests keep card-only storage and no CRM side effects',async()=>{
  const h=harness();await h.persist([{...row,notes:'must follow up with this account'}],'Urgent note');assert.deepEqual(plain(h.S.todoSuggestions),[]);assert.equal(h.S.todoCards.length,0);
  h.prepare({action:'add_todo',ids:[1]});await h.confirmDraft();
  const payload=h.aiPayload('What is due?');assert.equal(payload.pipeline.todoCards[0].recordId,1);assert.equal(payload.pipeline.todoView[0].dueDate,'');assert.equal(payload.pipeline.todoView[0].title,'Acme');h.prepare({action:'update_record',ids:[1],field:'notes',value:'Preview only'});assert.equal(h.S.tab,'table');assert.equal(h.S.pending.kind,'update');assert.notEqual(h.S.records[0].notes,'Preview only');h.cancelDraft();
  h.S.usage={remaining:10};h.reply({action:'update_todo',todoId:h.S.todoCards[0].id,todoStatus:'Done'});await h.send('Mark the card done');assert.equal(h.S.todoCards[0].status,'To Do');assert.equal(h.S.pending.after.status,'Done');await h.confirmDraft();assert.equal(h.S.todoCards[0].status,'Done');
});

const fixture=require('./fixtures/assistant-actions.cjs');
function sales(){const h=harness({deals:fixture.records,tableSchema:fixture.schema});h.S.usage={remaining:20};return h;}
test('exact two-task prompt and three-task batch preview, cancel, confirm once and undo all cards without CRM writes',async()=>{
  const h=sales(),before=plain(h.S.records);h.S.search='Northstar';h.reply(fixture.todos);await h.send(fixture.todoPrompt);
  assert.equal(h.S.tab,'todo');assert.equal(h.S.pending.count,2);assert.equal(h.S.todoCards.length,0);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.pipeline.records.length,3);assert.deepEqual(plain(h.S.pending.additions.map(c=>c.recordId)),[2,1]);
  h.cancelDraft();assert.equal(h.S.pending,null);assert.equal(h.calls.length,1);
  const three=structuredClone(fixture.todos);three.todos.push({...three.todos[0],recordMatch:'Beacon',todoNextAction:'Call Elena'});h.reply(three);await h.send('Create those two and call Elena about Beacon as a third task.');assert.equal(h.S.pending.count,3);await h.confirmDraft();
  assert.equal(h.S.todoCards.length,3);assert.deepEqual(plain(h.S.records),before);assert.equal(h.calls.filter(c=>c.url==='/api/todo-cards').length,1);assert.equal(h.calls.filter(c=>c.url==='/api/crm-data').length,0);
  assert.equal(h.S.todoCards[0].dueDate,'2026-09-24');assert.equal(h.S.todoCards[1].dueDate,'2026-09-28');await h.undo();assert.equal(h.S.todoCards.length,0);assert.deepEqual(plain(h.S.records),before);
});
test('multi-card clarification preserves the original batch through target choice and invalid-date replies',async()=>{
  const h=sales();h.S.records.push({...h.S.records[0],id:4,f_deal:'Northstar Studio'});h.reply(fixture.todos);await h.send(fixture.todoPrompt);
  assert.equal(h.S.pending,null);assert.equal(h.S.clarification.changeIndex,1);assert.equal(h.S.clarification.action.todos.length,2);h.chooseCandidate(1);assert.equal(h.S.pending.count,2);assert.equal(h.S.pending.additions[1].recordId,1);h.cancelDraft();
  const invalid=structuredClone(fixture.todos);invalid.todos[0].todoDueDate='tomorrow';h.reply(invalid);await h.send(fixture.todoPrompt);assert.equal(h.S.pending,null);assert.equal(h.S.sourceAction.todos.length,2);assert.match(h.S.clarification.question,/item 1/);
  h.reply({...fixture.todos,todos:fixture.todos.todos.map(t=>({...t,recordMatch:null,ids:[t.recordMatch==='Greenline'?2:1]}))});await h.send('Use September 24, 2026 for the first task.');assert.equal(h.calls.at(-1).body.pendingAction.todos.length,2);assert.equal(h.calls.at(-1).body.pendingClarification.originalCommand,fixture.todoPrompt);assert.equal(h.S.pending.count,2);
});
test('task batches retain previews on failed save and reject stale revisions, sessions and expired previews',async()=>{
  const h=sales();h.prepare(fixture.todos);h.fail(true);await h.confirmDraft();assert.equal(h.S.todoCards.length,0);assert.equal(h.S.pending.count,2);
  for(const mutate of [s=>s.revision++,s=>s.generation++,s=>s.pending.createdAt=Date.now()-31*60*1000]){const x=sales();x.prepare(fixture.todos);mutate(x.S);await x.confirmDraft();assert.equal(x.calls.length,0);assert.equal(x.S.todoCards.length,0);}
});
test('exact CRM request from To Do automatically opens Pipeline and confirms all three edits on two deals, preserving cards',async()=>{
  const h=sales();h.prepare(fixture.todos);await h.confirmDraft();const cards=plain(h.S.todoCards),before=plain(h.S.records);assert.equal(h.S.tab,'todo');
  h.reply(fixture.crm);await h.send(fixture.crmPrompt);assert.equal(h.calls.at(-1).body.pipeline.currentView,'todo');assert.equal(h.S.tab,'table');assert.equal(h.S.pending.kind,'update');assert.equal(h.S.pending.count,2);assert.deepEqual(plain(h.S.records),before);assert(!h.messages.some(m=>/switch.*view|I'm there/i.test(m)));
  await h.confirmDraft();assert.equal(h.S.records[0].f_source,'Referral');assert.equal(h.S.records[1].f_source,'Website');assert.equal(h.S.records[1].f_stage,'Negotiation');assert.deepEqual(plain(h.S.todoCards),cards);
  await h.undo();assert.deepEqual(plain(h.S.records).map(r=>({...r,history:[]})),before);assert.equal(h.S.records[0].history.length,2);assert.equal(h.S.records[1].history.length,4);assert.deepEqual(plain(h.S.todoCards),cards);
});
