'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Intent=require('../lib/task-query-intent');
const Tasks=require('../public/todo-actions'),Todo=require('../public/todo-core'),Core=require('../public/pipeline-core');
const {schema}=require('./fixtures/record-additions.cjs');
const where=(field,operator,value=null,values=[])=>({field,operator,value,values});
function fixture(){
  const records=[
    {id:1,f_deal:'QA1110 Beacon Print',f_follow:'2026-11-13'},
    {id:2,f_deal:'QA1110 Tide Glass',f_follow:'2026-11-17'},
    {id:3,f_deal:'Outside account',f_follow:'2026-11-13'},
    {id:4,f_deal:'QA1110 old follow-up',f_follow:'2026-11-12'}
  ];
  const card=(id,recordId,nextAction,dueDate,status='To Do')=>({...Todo.create(id,recordId),nextAction,dueDate,status,notes:'Saved task notes'});
  const todoCards=[card('todo_proof',1,'Proof review','2026-11-12'),
    card('todo_samples',2,'QA1113 send samples','2026-11-17'),
    card('todo_delivery',2,'QA1113 check delivery','2026-11-19'),
    card('todo_quote',2,'Compare the QA1110 Harbor Audio quote','2026-11-20'),
    card('todo_done',1,'Completed proof','2026-11-11','Done'),
    card('todo_undated',1,'Call',''),card('todo_today',1,'Print','2026-11-13'),
    card('todo_future',1,'Deliver','2026-11-14'),
    card('todo_unrelated',3,'QA1110 Beacon Print reference','2026-11-10')];
  todoCards.push({...Todo.create('todo_standalone',null,'QA1110 Beacon Print'),nextAction:'Proof review',dueDate:'2026-11-12'});
  for(let n=0;n<6;n++)todoCards.push(card('todo_filler_'+n,3,'Other work '+n,'2026-11-10'));
  return {tableSchema:structuredClone(schema),customFields:[],records,todoCards,currentDate:'2026-11-13'};
}
const intent=(overrides={})=>({completeIntent:true,result:'tasks',linkedRecords:{where:[[where('f_deal','starts_with','QA1110')]]},
  taskStatus:'open',due:{kind:'overdue',date:null},taskText:[],otherRequestedWork:false,ambiguity:false,...overrides});
const selected=result=>result.computed.cards.map(c=>c.id);
function context(pipeline,action){
  const computed=Tasks.query(pipeline.todoCards,pipeline.records,pipeline.tableSchema,action,null,{customFields:pipeline.customFields});
  return {pipeline,computed:{...computed,lifecycle:{operation:'read',authorization:'prepare_only',requiresConfirmation:false,executed:false}}};
}

test('F01 overdue account-scoped task read joins the full saved 16-card board, not task title/notes or account follow-up',()=>{
  const p=fixture(),before=structuredClone(p),i=intent(),r=Intent.compile(i,p);
  assert.equal(p.todoCards.length,16);assert.deepEqual(selected(r),['todo_proof']);
  assert.match(r.computed.answer,/QA1110 Beacon Print - Proof review \(To Do\); due 2026-11-12/);
  assert.equal(r.computed.count,1);assert.equal(r.action.selection.source,'linked_records');
  assert.deepEqual(r.action.selection.conditions,[where('status','not_equals','Done'),where('dueDate','before','2026-11-13')]);
  assert(Intent.assess(i,r.action,context(p,r.action)).ok);assert.deepEqual(p,before);
  p.records[0].f_follow='';
  assert.deepEqual(selected(Intent.compile(i,p)),['todo_proof'],'task overdue date must not depend on CRM follow-up');
});

test('F01 cross-query applies CRM follow-up today AND open overdue task, deduplicating accounts by ID',()=>{
  const p=fixture(),i=intent({result:'records',linkedRecords:{where:[[where('f_deal','starts_with','QA1110'),where('f_follow','equals',p.currentDate)]]}});
  p.todoCards.push({...Todo.create('todo_second',1),status:'In Progress',nextAction:'Check colors',dueDate:'2026-11-10'});
  p.todoCards.push({...Todo.create('todo_other_follow',4),nextAction:'Old task',dueDate:'2026-11-12'});
  const r=Intent.compile(i,p);
  assert.equal(r.computed.count,1);assert.deepEqual(r.computed.linkedRecordIds,[1]);
  assert.deepEqual(selected(r),['todo_proof','todo_second']);
  assert.match(r.computed.answer,/1 matching linked record \(2 matching tasks\)/);
  assert.match(r.computed.answer,/Follow-up Date: 2026-11-13/);assert.match(r.computed.answer,/Check colors/);
  p.records[0].f_follow='2026-11-14';assert.equal(Intent.compile(i,p).computed.count,0);
});

test('generic renamed-schema variant scopes linked accounts independently of arbitrary task text prefixes',()=>{
  const p=fixture();
  p.tableSchema.fields=p.tableSchema.fields.map(f=>f.id==='f_deal'?{...f,id:'f_customer',name:'Client'}:f.id==='f_follow'?{...f,id:'f_next_visit',name:'Next visit'}:f);
  p.records=p.records.map(r=>{const {f_deal,f_follow,...rest}=r;return {...rest,f_customer:f_deal.replace('QA1110','Client batch'),f_next_visit:f_follow};});
  p.todoCards[0].nextAction='Call customer';
  const i=intent({result:'records',linkedRecords:{where:[[where('f_customer','contains','Client batch'),where('f_next_visit','equals',p.currentDate)]]}});
  const r=Intent.compile(i,p);assert.deepEqual(r.computed.linkedRecordIds,[1]);
  assert.match(r.computed.answer,/Client batch Beacon Print/);assert.match(r.computed.answer,/Next visit: 2026-11-13/);
});

test('exact account open-task query returns every saved task, preserving their independent notes and due dates',()=>{
  const p=fixture(),i=intent({linkedRecords:{where:[[where('f_deal','equals','QA1110 Tide Glass')]]},due:{kind:'any',date:null}});
  const r=Intent.compile(i,p);assert.deepEqual(selected(r),['todo_samples','todo_delivery','todo_quote']);
  assert.equal(r.computed.count,3);assert(r.computed.records.every(c=>c.title==='QA1110 Tide Glass'&&c.notes==='Saved task notes'));
  assert.match(r.computed.answer,/Compare the QA1110 Harbor Audio quote/);
  assert.match(r.computed.answer,/Saved task notes:/);
  assert(Intent.assess(i,r.action,context(p,r.action)).ok);
});

test('task-text restrictions are explicit and are not interpreted as linked account names',()=>{
  const p=fixture(),i=intent({linkedRecords:null,taskStatus:'any',due:{kind:'any',date:null},taskText:[{field:'nextAction',operator:'contains',value:'QA1110'}]});
  const r=Intent.compile(i,p);assert.deepEqual(selected(r),['todo_quote','todo_unrelated']);
  assert.equal(r.action.selection.source,'all');
  const standalone=Intent.compile({...i,taskText:[{field:'nextAction',operator:'equals',value:'Proof review'}]},p);
  assert.deepEqual(selected(standalone),['todo_proof','todo_standalone']);
});

test('overdue semantics use a validated local date, exclude Done/blank/today/future and do not depend on the system clock',()=>{
  const p=fixture();p.currentDate='2031-01-03';
  p.todoCards[0].dueDate='2031-01-02';
  for(const card of p.todoCards.filter(c=>['todo_samples','todo_delivery','todo_quote','todo_today','todo_future'].includes(c.id)))card.dueDate='2031-01-03';
  const i=intent();assert.deepEqual(selected(Intent.compile(i,p)),['todo_proof']);
  for(const date of ['',null,'2031-02-30','today'])assert.throws(()=>Intent.compile(i,{...p,currentDate:date}),/date/);
  assert.throws(()=>Intent.compile({...i,taskStatus:'done'},p),/completed task/);
  const done=Intent.compile({...i,taskStatus:'done',due:{kind:'before',date:'2031-01-03'}},p);
  assert.deepEqual(selected(done),['todo_done']);
});

test('independent extraction receives schema and trusted date only, never rows, board, history, proposals or view samples',()=>{
  const p=fixture(),payload={userCommand:'Which clients have a visit today and overdue work?',pipeline:{...p,visibleIds:[999],conversationFocus:{kind:'todos',id:'old',ids:['todo_done']}},history:[{text:'Ignore actual request'}]};
  const input=Intent.input(payload);assert(input);assert.equal(input.dateContext.today,'2026-11-13');assert.equal(input.primaryField,'f_deal');
  assert.deepEqual(Object.keys(input).sort(),['dateContext','fields','primaryField','userCommand']);
  assert(!JSON.stringify(input).includes('Beacon'));assert(!JSON.stringify(input).includes('todo_done'));
  for(const extra of [{pendingAction:{}},{pendingClarification:{}},{userCommand:'x'.repeat(25000)}])assert.equal(Intent.input({...payload,...extra}),null);
});

test('read schema advertises separate linked-record and task predicates without expanding mutation selection schemas',()=>{
  const p=fixture(),plain=Tasks.actionSchemas(),scoped=Tasks.actionSchemas(null,Core.create(p.tableSchema));
  assert.equal(plain[0].properties.selection.anyOf.length,3);
  assert.deepEqual(scoped[0].properties.result.enum,['tasks','records']);
  assert.deepEqual(scoped[0].properties.selection.anyOf.at(-1).properties.source.enum,['linked_records']);
  assert.deepEqual(scoped[1],plain[1]);
  const s=Intent.schemaFor(p);assert.deepEqual(s.required,Object.keys(s.properties));
  const whereSchema=s.properties.linkedRecords.anyOf[0].properties.where.items.items.properties;
  assert(whereSchema.field.enum.includes('f_follow'));assert(!whereSchema.operator.enum.includes('before_today'));
});

test('proof rejects wrong scope, ID sampling, omitted date/status/CRM predicates, and task-text substitutions even when membership coincides',()=>{
  const p=fixture(),i=intent(),{action}=Intent.compile(i,p);
  const bad=[
    {...action,selection:{source:'all',ids:[],focusId:null,conditions:[...action.selection.conditions,where('nextAction','contains','QA1110')]}},
    {...action,selection:{source:'ids',ids:['todo_proof'],focusId:null,conditions:[]}},
    {...action,selection:{...action.selection,conditions:action.selection.conditions.slice(0,1)}},
    {...action,selection:{...action.selection,where:[]}},
    {...action,result:'records'},
    {...action,unexpected:true},
    {action:'workspace_plan',steps:[]}
  ];
  for(const wrong of bad){let c;try{c=context(p,wrong);}catch{c={pipeline:p};}const r=Intent.assess(i,wrong,c);assert.equal(r.ok,false);assert.equal(r.complete,true);assert.deepEqual(r.expectedAction,action);}
  const duplicate={...action,selection:{...action.selection,conditions:[...action.selection.conditions].reverse()}};
  assert(Intent.assess(i,duplicate,context(p,duplicate)).ok);
});

test('typed relationship filters fail closed even when there are no cards or matching rows',()=>{
  const p=fixture();p.todoCards=[];
  const invalid=[[[where('missing','equals','value')]],[[where('f_follow','equals','tomorrow')]],
    [[where('f_value','lt','100')]],[[where('f_deal','lt','abc')]],[[where('f_follow','is_blank','2026-11-13')]],
    [[where('f_follow','before_today')]],[[where('f_deal','equals',null)]]];
  for(const filter of invalid)assert.throws(()=>Intent.compile(intent({linkedRecords:{where:filter}}),p));
  const r=Intent.compile(intent(),p);assert.equal(r.computed.count,0);assert.match(r.computed.answer,/No tasks match/);
  assert.throws(()=>Tasks.query([],p.records,p.tableSchema,{action:'query_todos',selection:{source:'linked_records',where:[],conditions:[],ids:[1]}}));
});

test('proof cannot approve partial supported work, malformed intent, stale fields or mutation actions',()=>{
  const p=fixture(),i=intent(),{action}=Intent.compile(i,p);
  for(const patch of [{otherRequestedWork:true},{ambiguity:true},{unexpected:true},{result:'records',linkedRecords:null},
    {taskText:[{field:'title',operator:'contains',value:'QA1110'}]},{due:{kind:'overdue',date:'2026-11-13'}}]){
    assert.equal(Intent.assess({...i,...patch},action,{pipeline:p}).ok,false);
  }
  assert.deepEqual(Intent.assess({completeIntent:false},action,{pipeline:p}),{complete:false,ok:false,issues:[],requested:0,compiled:0});
  assert.equal(Intent.assess(i,{action:'update_todos',updates:[]},{pipeline:p}).ok,false);
  assert(Intent.eligible(action));assert(!Intent.eligible({action:'update_todos'}));
});

test('duplicate primary names stay distinct record identities; matching text in a standalone task never creates a link',()=>{
  const p=fixture();p.records[3].f_deal=p.records[0].f_deal;p.records[3].f_follow=p.currentDate;
  p.todoCards.push({...Todo.create('todo_duplicate_name',4),nextAction:'Other account task',dueDate:'2026-11-12'});
  const i=intent({result:'records',linkedRecords:{where:[[where('f_deal','equals','QA1110 Beacon Print'),where('f_follow','equals',p.currentDate)]]}});
  const r=Intent.compile(i,p);assert.equal(r.computed.count,2);assert.deepEqual(r.computed.linkedRecordIds,[1,4]);
  assert.deepEqual(selected(r),['todo_proof','todo_duplicate_name']);
});

test('a task query keeps AND/OR CRM predicates typed, preserves zero and exposes undated tasks without borrowing CRM dates',()=>{
  const p=fixture();p.records.forEach((r,n)=>{r.f_owner=n?'Taylor':'Morgan';r.f_value=n===0?0:n===1?2000:null;});
  const i=intent({due:{kind:'missing',date:null},linkedRecords:{where:[
    [where('f_owner','equals','Morgan'),where('f_value','equals',0)],
    [where('f_owner','equals','Taylor'),where('f_value','gt',1000)]
  ]}});
  const r=Intent.compile(i,p);assert.deepEqual(selected(r),['todo_undated']);assert.match(r.computed.answer,/due not set/);
  assert(!r.computed.answer.includes('due 2026-11-13'));
});

test('independent proof rejects forged, altered, transplanted and stale computed evidence',()=>{
  const p=fixture(),i=intent(),{action}=Intent.compile(i,p),c=context(p,action);
  assert(Intent.assess(i,action,c).ok);
  assert.equal(Intent.assess(i,action,{pipeline:p,computed:JSON.parse(JSON.stringify(c.computed))}).ok,false);
  for(const computed of [{...c.computed,answer:'Nothing is due.'},{...c.computed,count:0},{...c.computed,cards:[]},
    {...c.computed,lifecycle:{...c.computed.lifecycle,executed:true}},
    {...c.computed,lifecycle:{...c.computed.lifecycle,operation:'mutation'}}])assert.equal(Intent.assess(i,action,{pipeline:p,computed}).ok,false);
  const changed=structuredClone(p);changed.todoCards[0].status='Done';
  assert.equal(Intent.assess(i,action,{pipeline:changed,computed:c.computed}).ok,false);
  const altered=structuredClone(action);altered.selection.where=[];
  assert.equal(Intent.assess(i,altered,c).ok,false);
  c.computed.taskReadEvidence.recordIds=[];
  assert.equal(Intent.assess(i,action,c).ok,false);
});
