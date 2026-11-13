'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const Review=require('../lib/action-review'),Intent=require('../lib/task-query-intent');
const Tasks=require('../public/todo-actions'),Todo=require('../public/todo-core'),Core=require('../public/pipeline-core');
const F=require('./fixtures/workspace-plans.cjs');
const condition=(field,operator,value=null,values=[])=>({field,operator,value,values});
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const p=F.workspace();
  p.records=p.records.slice(0,3).map((row,i)=>({...row,f_deal:['QA1110 Beacon Print','QA1110 Tide Glass','Outside'][i],f_follow:i===1?'2026-11-17':'2026-11-13'}));
  const card=(id,recordId,nextAction,dueDate,status='To Do',notes='')=>({...Todo.create(id,recordId),nextAction,dueDate,status,notes});
  p.todoCards=[card('todo_proof',1,'Proof review','2026-11-12','To Do','Preserve the numbered proof.'),
    card('todo_second',1,'Verify colors','2026-11-11','In Progress','Check both pages.'),
    card('todo_done',1,'Completed task','2026-11-10','Done'),
    card('todo_future',2,'Send samples','2026-11-17'),
    card('todo_outside',3,'QA1110 Beacon Print','2026-11-12'),
    {...Todo.create('todo_standalone',null,'QA1110 Beacon Print'),nextAction:'Proof review',dueDate:'2026-11-12'}];
  return {...p,currentDate:'2026-11-13',workspaceVersion:'task-query-v1',visibleIds:[2],conversationFocus:null};
}
function intent(result='tasks'){
  const filters=[condition('f_deal','starts_with','QA1110')];
  if(result==='records')filters.push(condition('f_follow','equals','2026-11-13'));
  return {completeIntent:true,result,linkedRecords:{where:[filters]},taskStatus:'open',due:{kind:'overdue',date:null},taskText:[],otherRequestedWork:false,ambiguity:false};
}
function evidence(p,result='tasks'){
  const i=intent(result),action=Intent.compile(i,p).action,reply={crmAction:action,assistantMessage:'Untrusted model guess: zero tasks.'};
  const computed=Review.evidence({pipeline:p},reply);
  return {i,action,reply,computed,context:{pipeline:p,computed}};
}
function frozen(value){if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;}

test('task-query WeakMap proof survives the real review evidence spread, lifecycle and preservation bindings',()=>{
  const p=frozen(fixture()),before=structuredClone(p),f=evidence(p);
  assert.equal(Tasks.checkedQueryEvidence(f.computed,f.action,p),f.computed.taskReadEvidence);
  assert.equal(f.computed.lifecycle.operation,'read');assert.equal(f.computed.lifecycle.executed,false);
  assert.equal(f.computed.lifecycle.writesApplied,0);assert.equal(f.computed.lifecycle.requiresConfirmation,false);
  assert(f.computed.constraintEvidence.some(c=>c.id==='lifecycle:preview_only'));
  assert(Intent.assess(f.i,f.action,f.context).ok);
  assert.deepEqual(f.computed.cards.map(c=>c.id),['todo_proof','todo_second']);
  assert.equal(f.computed.count,2);assert.deepEqual(f.computed.linkedRecordIds,[1]);
  assert.deepEqual(p,before);
});

test('record-result evidence counts distinct linked records, while retaining both actual matching task witnesses',()=>{
  const p=fixture(),before=structuredClone(p),f=evidence(p,'records');
  assert.equal(f.computed.result,'records');assert.equal(f.computed.count,1);assert.equal(f.computed.cards.length,2);
  assert.deepEqual(f.computed.linkedRecordIds,[1]);assert(f.computed.cards.every(c=>c.recordId===1));
  assert.match(f.computed.answer,/1 matching linked record \(2 matching tasks\)/);
  assert.match(f.computed.answer,/Follow-up Date: 2026-11-13/);
  assert(Intent.assess(f.i,f.action,f.context).ok);assert.deepEqual(p,before);
  assert(!f.computed.cards.some(c=>c.recordId===null||c.id==='todo_outside'||c.status==='Done'));
});

test('canonical task answer reports saved notes once and never repeats the model guess',()=>{
  for(const result of ['tasks','records']){
    const p=fixture(),f=evidence(p,result),answer=Review.renderAnswer({pipeline:p},f.reply,f.computed);
    assert.equal(answer,f.computed.answer);assert.equal(answer.split('Saved task notes:').length-1,1);
    for(const note of ['Preserve the numbered proof.','Check both pages.'])assert.equal(answer.split(note).length-1,1);
    assert.doesNotMatch(answer,/Untrusted model|zero tasks/);
  }
});

test('generic review can cite count/names/fields from the same task-read evidence without adding a write',()=>{
  for(const result of ['tasks','records']){
    const p=fixture(),f=evidence(p,result),review={requirements:[{
      description:'List and count the complete requested result with linked names and dates',satisfied:true,
      evidenceKind:'computed_read',stepIds:['root'],requiredOutputs:['count','names','fields']
    }],issues:[],clarificationQuestion:null};
    const assessed=Review.validateReview(review,f.reply,f.context);
    assert.equal(assessed.ok,true,JSON.stringify(assessed));assert.equal(assessed.requested,1);assert.equal(assessed.compiled,1);
    assert.equal(f.computed.lifecycle.authorization,'prepare_only');
  }
});

test('real review evidence cannot be forged, altered, reused after data changes or transplanted to a different action',()=>{
  const p=fixture(),f=evidence(p);
  assert.equal(Intent.assess(f.i,f.action,{pipeline:p,computed:plain(f.computed)}).ok,false);
  for(const patch of [{count:0},{cards:[]},{linkedRecordIds:[2]},{answer:'No matching task.'}]){
    assert.equal(Intent.assess(f.i,f.action,{pipeline:p,computed:{...f.computed,...patch}}).ok,false);
  }
  const different=structuredClone(f.action);different.selection.where=[];
  assert.equal(Tasks.checkedQueryEvidence(f.computed,different,p),null);
  const changed=structuredClone(p);changed.todoCards[0].notes='Changed since the evidence was computed';
  assert.equal(Intent.assess(f.i,f.action,{pipeline:changed,computed:f.computed}).ok,false);
  assert.equal(Tasks.checkedQueryEvidence(f.computed,f.action,changed),null);
});

function client(p){
  const nodes=new Map(),messages=[],calls=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',style:{},classList:{add(){},remove(){}},querySelectorAll:()=>[]});return nodes.get(id);};
  const context={crypto,AbortSignal,window:{PipelineCore:Core,PipeChatTodo:Todo,PipeChatTodoActions:Tasks,
    PipeChatInspector:require('../public/inspector-core'),PipeChatSchema:require('../public/table-schema'),PipeChatIcons:{},messages},
    document:{getElementById:node,querySelector:()=>null},sessionStorage:{removeItem(){},setItem(){}},
    fetch:async(...args)=>{calls.push(args);throw new Error('Task reads must not write or fetch another CRM resource.');}};
  const source=fs.readFileSync(require.resolve('../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
  const startup='  wire();\n  restoreSession();';assert(source.includes(startup),'The client test harness must replace only the startup calls.');
  vm.runInNewContext(source.replace(startup,
    'render=()=>{};renderTrust=()=>{};say=message=>window.messages.push(message);window.test={S,useSchema,handleAction};'),context);
  const h=context.window.test;h.useSchema(p.tableSchema);
  Object.assign(h.S,{records:structuredClone(p.records),todoCards:structuredClone(p.todoCards),customFields:structuredClone(p.customFields),
    updatedAt:p.workspaceVersion,user:{id:'qa',name:'QA'},loaded:true,tab:'dashboard',filter:{where:[],ids:[2]},search:'Tide',
    clarification:{question:'Stale question'},sourceAction:{action:'clarify'}});
  return {...h,messages,calls};
}

test('actual client task-read handler uses complete task IDs and canonical notes without CRM/card writes',()=>{
  const p=fixture(),f=evidence(p),h=client(p),before=plain({records:h.S.records,cards:h.S.todoCards,filter:h.S.filter,search:h.S.search});
  h.handleAction(f.reply,'Show overdue QA1110 tasks, with their linked deal and due date.');
  assert.equal(h.S.focus.kind,'todos');assert(h.S.focus.id);assert.deepEqual(plain(h.S.focus.ids),['todo_proof','todo_second']);
  assert.equal(h.S.clarification,null);assert.equal(h.S.sourceAction,null);assert.equal(h.S.pending,null);assert.equal(h.S.tab,'todo');
  assert.equal(h.messages.at(-1),Review.renderAnswer({pipeline:p},f.reply,f.computed));
  assert.deepEqual(plain({records:h.S.records,cards:h.S.todoCards,filter:h.S.filter,search:h.S.search}),before);
  assert.deepEqual(h.calls,[]);
});

test('actual client record-result handler preserves deduplicated record focus, not task IDs or the visible table scope',()=>{
  const p=fixture(),f=evidence(p,'records'),h=client(p),before=plain({records:h.S.records,cards:h.S.todoCards});
  h.handleAction(f.reply,'Which QA1110 deals have a follow-up today but an overdue task?');
  assert.deepEqual(plain(h.S.focus),{kind:'table',ids:[1]});assert.equal(h.S.pending,null);
  assert.match(h.messages.at(-1),/1 matching linked record \(2 matching tasks\)/);
  assert.equal(h.messages.at(-1),f.computed.answer);assert.deepEqual(h.calls,[]);
  assert.deepEqual(plain({records:h.S.records,cards:h.S.todoCards}),before);
});

test('empty results remain an explicit empty task or record focus; no fallback broadens the scope',()=>{
  for(const result of ['tasks','records']){
    const p=fixture();p.todoCards.forEach(c=>c.status='Done');
    const f=evidence(p,result),h=client(p);h.handleAction(f.reply,'Read the overdue work.');
    assert.equal(f.computed.count,0);assert.deepEqual(f.computed.linkedRecordIds,[]);assert.deepEqual(plain(h.S.focus.ids),[]);
    assert.equal(h.S.focus.kind,result==='records'?'table':'todos');assert.equal(h.S.pending,null);assert.deepEqual(h.calls,[]);
    assert(Intent.assess(f.i,f.action,f.context).ok);
  }
});
