'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),Todo=require('../public/todo-core'),Core=require('../public/pipeline-core');
const Review=require('../lib/action-review');
const F=require('./fixtures/workspace-plans.cjs');
function fixture(){
  const w=F.workspace();w.records[0].f_deal='QA1110 Tide Glass';
  w.todoCards=[{...Todo.create('todo_samples',1),nextAction:'QA1113 send samples',status:'Done',dueDate:'2026-11-14',notes:'Use the small sample box.'},
    {...Todo.create('todo_delivery',1),nextAction:'QA1113 check delivery',status:'To Do',dueDate:'2026-11-19',notes:'Preserve delivery notes.'}];
  return w;
}
const set=(field,value)=>({field,operation:'set',value});
const clear=()=>({field:'dueDate',operation:'clear',value:null});
function step(w,changes,index=0){
  const card=w.todoCards[index],row=w.records.find(r=>r.id===card.recordId);
  return {op:'update_tasks',id:'edit_'+index,label:'Update task',selection:{source:'references',references:[{taskName:card.nextAction,recordName:row.f_deal}],conditions:[]},changes};
}
const prepare=(w,steps)=>Plan.prepare(w,F.plan(steps),{today:'2026-11-13',nonce:'date_clear'});
const caught=fn=>{try{fn();}catch(error){return error;}assert.fail('Expected the entire plan to reject.');};

test('F12 evidence diagnosis: null/blank literal calendar dates are invalid, while the legacy explicit empty string clears',()=>{
  const w=fixture(),before=structuredClone(w);
  for(const date of [null,'']){
    const error=caught(()=>prepare(w,[step(w,[set('status','To Do'),set('dueDate',{dateMode:'literal',date,offset:null})])]));
    assert.equal(error.compilerStep,'update_tasks');assert.equal(error.reasonCode,'date_invalid');assert.deepEqual(w,before);
  }
  const p=prepare(w,[step(w,[set('status','To Do'),set('dueDate','')])]);
  assert.equal(p.next.todoCards[0].status,'To Do');assert.equal(p.next.todoCards[0].dueDate,'');
  assert.equal(p.next.todoCards[0].notes,'Use the small sample box.');assert.deepEqual(w,before);
});

test('F12 explicit clear and reopen compile atomically with unchanged notes, task identity, other cards and CRM',()=>{
  const w=fixture(),before=structuredClone(w),action=F.plan([step(w,[set('status','To Do'),clear()])]);
  const p=Plan.prepare(w,action,{nonce:'reopen'});
  assert.equal(p.taskPatches.length,1);assert.deepEqual(p.taskPatches[0].before,before.todoCards[0]);
  assert.deepEqual(p.taskPatches[0].after,{...before.todoCards[0],status:'To Do',dueDate:''});
  assert.deepEqual(p.next.todoCards[1],before.todoCards[1]);assert.deepEqual(p.next.records,before.records);
  assert.deepEqual(p.next.tableSchema,before.tableSchema);assert.deepEqual(p.patches,[]);assert.deepEqual(p.calculations,[]);
  assert.deepEqual(w,before,'Preparing or cancelling a review has no saved-state effect');
  const pipeline={...w,currentDate:'2026-11-13',workspaceVersion:'before-reopen'};
  const evidence=Review.evidence({pipeline},{crmAction:action});
  assert.equal(evidence.lifecycle.operation,'mutation');assert.equal(evidence.lifecycle.requiresConfirmation,true);
  assert.equal(evidence.lifecycle.executed,false);assert.equal(evidence.lifecycle.writesApplied,0);
  assert.deepEqual(evidence.taskPatches,p.taskPatches);assert.deepEqual(pipeline.records,before.records);
  const html=Plan.render(p,s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;'),false);
  for(const label of ['QA1110 Tide Glass','Task: QA1113 send samples','Board status','Due date','2026-11-14','(blank)'])assert(html.includes(label),label);
  assert(!html.includes('>dueDate<'));
});

test('task change reviews keep the original task identity and escape user-controlled task text',()=>{
  const w=fixture();w.todoCards[0].nextAction='<img src=x onerror=alert(1)>';
  const p=prepare(w,[step(w,[set('nextAction','New task'),clear()])]);
  const html=Plan.render(p,s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;'),false);
  assert(html.includes('Task: &lt;img src=x onerror=alert(1)>'));
  assert(!html.includes('<img'));
  assert(html.includes('New task'));
});

test('typed clear is represented distinctly from setting a calendar literal in the model schema',()=>{
  const w=fixture(),schema=Plan.responseSchema(Core.create(w.tableSchema));
  const change=schema.properties.steps.items.anyOf.find(s=>s.properties.op.enum[0]==='update_tasks').properties.changes.items;
  assert(Array.isArray(change.anyOf));
  const clearSchema=change.anyOf.find(v=>v.properties.operation.enum.includes('clear'));
  assert.deepEqual(clearSchema.properties.field.enum,['dueDate']);assert.equal(clearSchema.properties.value.type,'null');
  assert.equal(clearSchema.additionalProperties,false);assert.deepEqual(clearSchema.required,['field','operation','value']);
  assert.match(clearSchema.properties.operation.description,/clear|remove/i);
  const normal=change.anyOf.find(v=>v.properties.operation.enum.includes('set'));
  assert(normal.properties.value.anyOf.some(v=>v.type==='string'),'Legacy explicit empty-string clearing remains representable');
});

test('clear variants support multiple cards, reversed change order and already-blank dates without altering task text',()=>{
  for(const blank of [false,true]){
    const w=fixture();if(blank)w.todoCards[0].dueDate='';const before=structuredClone(w);
    const p=prepare(w,[step(w,[clear(),set('status','In Progress')]),step(w,[clear()],1)]);
    assert.deepEqual(p.next.todoCards,w.todoCards.map((c,i)=>({...c,dueDate:'',...(i===0?{status:'In Progress'}:{})})));
    assert.equal(p.taskPatches.length,2);assert.deepEqual(w,before);
  }
});

test('typed clear rejects unsupported fields, missing/null-like text operands and extra properties without coercion',()=>{
  const w=fixture(),before=structuredClone(w);
  for(const change of [{...clear(),field:'notes'},{...clear(),field:'status'},
    {...clear(),value:''},{...clear(),value:'null'},{...clear(),value:false},{...clear(),value:0},
    {...clear(),value:{dateMode:'literal',date:null,offset:null}},
    {field:'dueDate',operation:'clear'},{...clear(),extra:'ignored'}]){
    const error=caught(()=>prepare(w,[step(w,[set('status','To Do'),change])]));
    assert.equal(error.compilerStep,'update_tasks');assert.equal(error.reasonCode,'task_validation');assert.deepEqual(w,before);
  }
});

test('invalid date strings and malformed calendar expressions still reject the complete plan, never clear implicitly',()=>{
  const w=fixture(),before=structuredClone(w);
  for(const value of [null,undefined,false,0,'null','none','remove',' ','2026-02-30',
    {dateMode:'literal',date:null,offset:null},{dateMode:'literal',date:'',offset:null},
    {dateMode:'literal',date:'2026-02-30',offset:null},{dateMode:'clear',date:null,offset:null}]){
    assert.throws(()=>prepare(w,[step(w,[clear()]),step(w,[set('dueDate',value)],1)]));assert.deepEqual(w,before);
  }
});

test('independent normal date edits and cross-step conflicts retain the existing atomic validation',()=>{
  const w=fixture(),before=structuredClone(w);
  const dates=prepare(w,[step(w,[set('dueDate',{dateMode:'literal',date:'2026-11-17',offset:null})]),
    step(w,[set('dueDate','2026-11-18')],1)]);
  assert.deepEqual(dates.next.todoCards.map(c=>c.dueDate),['2026-11-17','2026-11-18']);assert.deepEqual(w,before);
  const duplicate={...step(w,[set('dueDate','2026-11-18')]),id:'conflict'};
  assert.throws(()=>prepare(w,[step(w,[clear()]),duplicate]),/same card field/);assert.deepEqual(w,before);
});
