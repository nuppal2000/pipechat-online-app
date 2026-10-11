'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),Todo=require('../public/todo-core'),Tasks=require('../public/todo-actions');
const Review=require('../lib/action-review');
const Diagnostic=require('../lib/compiler-diagnostic');
const F=require('./fixtures/workspace-plans.cjs'),Q=require('./fixtures/objective-query-acceptance.cjs');
const options={today:'2026-10-10',nonce:'evidence_regression'};
const relative=offset=>({dateMode:'calendar_days',date:null,offset});
const literal=date=>({dateMode:'literal',date,offset:null});
const change=(field,value)=>({field,operation:'set',value});
function taskWorkspace(){
  const w=F.workspace();
  w.records[0].f_deal='UppalCo';w.records[1].f_deal='BrightpathTutors';
  w.todoCards=[{...Todo.create('todo_uppal',1),status:'In Progress',nextAction:'Contact Uppal',notes:'Keep first notes'},
    {...Todo.create('todo_brightpath',2),status:'In Progress',nextAction:'Hire a tutor',notes:'Keep second notes'}];
  return w;
}
function taskStep(w,index,field,value,id='edit_'+index){
  const card=w.todoCards[index],record=w.records.find(r=>r.id===card.recordId);
  return {op:'update_tasks',id,label:id,selection:{source:'references',references:[{taskName:card.nextAction,recordName:record.f_deal}],conditions:[]},changes:[change(field,value)]};
}
const evidence=(w,steps,extra={})=>Review.evidence({pipeline:{...w,currentDate:options.today,...extra}},{crmAction:F.plan(steps)});
const prepare=(w,steps,extra={})=>Plan.prepare(w,F.plan(steps),{...options,...extra});
const caught=fn=>{try{fn();}catch(error){return error;}assert.fail('Expected a compiler error');};

test('named task evidence resolves independent dates and preserves all other saved fields',()=>{
  for(const dates of [[relative(0),relative(1)],['2026-10-10','2026-10-11'],[literal('2026-10-10'),literal('2026-10-11')]]){
    const w=taskWorkspace(),before=structuredClone(w),steps=dates.map((date,i)=>taskStep(w,i,'dueDate',date));
    const result=evidence(w,steps,{conversationFocus:{kind:'todos',id:'prior',ids:w.todoCards.map(c=>c.id)}});
    assert.deepEqual(result.taskPatches.map(p=>p.after),w.todoCards.map((card,i)=>({...card,dueDate:'2026-10-'+(10+i)})));
    assert.deepEqual(result.review.map(s=>s.targets.map(t=>t.taskId)),[['todo_uppal'],['todo_brightpath']]);
    assert.deepEqual(result.patches,[]);assert.equal(result.lifecycle.writesApplied,0);assert.deepEqual(w,before);
  }
});

test('unchanged task steps do not make a complete workspace plan depend on step order',()=>{
  const w=taskWorkspace(),before=structuredClone(w);
  const keep=taskStep(w,0,'status','In Progress','preserve_status');
  const dates=w.todoCards.map((card,i)=>taskStep(w,i,'dueDate',relative(i)));
  for(const steps of [[keep,...dates],[...dates,keep]]){
    const result=evidence(w,steps);
    assert.deepEqual(result.taskPatches.map(p=>p.after),w.todoCards.map((card,i)=>({...card,dueDate:'2026-10-'+(10+i)})));
    assert.equal(result.mutates,true);assert.deepEqual(w,before);
  }
  const unchanged=evidence(w,[keep]);assert.equal(unchanged.mutates,false);assert.deepEqual(unchanged.taskPatches,[]);
  const action={action:'update_todos',updates:[{selection:keep.selection,changes:keep.changes}]};
  assert.throws(()=>Tasks.plan(w.todoCards,w.records,w.tableSchema,action),/already has/);
});

test('accepted date literals materialize as canonical task dates without needing today',()=>{
  for(const date of ['October 10, 2026','Oct 10 2026',' 2026-10-10 ']){
    const w=taskWorkspace(),steps=[taskStep(w,0,'dueDate',literal(date))];
    for(const today of [options.today,undefined]){
      const result=prepare(w,steps,{today});
      assert.equal(result.next.todoCards[0].dueDate,'2026-10-10');
      assert.deepEqual(result.calculations,['Date: 2026-10-10']);
    }
  }
  assert.throws(()=>Plan.dateValue(relative(1)),/current date is unavailable/);
  for(const date of ['2026-02-30','February 30, 2026','tomorrow','2026-10-10T12:00:00Z'])assert.throws(()=>Plan.dateValue(literal(date),options.today));
});

test('task no-op composition still rejects conflicts, missing references and invalid dates atomically',()=>{
  const w=taskWorkspace(),before=structuredClone(w),keep=taskStep(w,0,'status','In Progress','keep');
  const conflict=taskStep(w,0,'status','Done','conflict');
  const invalid=taskStep(w,1,'dueDate','2026-02-30','invalid');
  const missing=taskStep(w,1,'dueDate',relative(1),'missing');missing.selection.references[0].taskName='No such task';
  for(const last of [conflict,invalid,missing]){
    assert.throws(()=>prepare(w,[keep,last]));assert.deepEqual(w,before);
  }
});

test('nine open blank-date records can narrow by owner from focus with names count total and average',()=>{
  const w=F.workspace();w.records.push(...Q.workspace().records);
  w.records=w.records.map((row,i)=>({...row,f_stage:i===9?'Closed Won':i===10?'':'Qualified',f_follow:i===11?'2026-10-11':'',f_owner:i%3===0||i>8?'Ravi':'Alex',f_value:i*100}));
  const before=structuredClone(w),open=F.select('open_blank',[[F.where('f_stage','in',null,['Qualified','Proposal Sent','Negotiation']),F.where('f_follow','is_blank')]]);
  const initial=evidence(w,[open,Q.read('open_blank',[{kind:'names',field:null},{kind:'count',field:null}])]);
  assert.equal(initial.review[0].matched,9);assert.match(initial.answers[0],/Record count: 9/);
  const focus={kind:'table',ids:initial.queryResults[0].recordIds};
  const steps=[F.select('owner_subset',[[F.where('f_owner','equals','Ravi')]],{source:'focus'}),Q.read('owner_subset',[
    {kind:'names',field:null},{kind:'count',field:null},{kind:'sum',field:'f_value'},{kind:'average',field:'f_value'}])];
  const result=evidence(w,steps,{conversationFocus:focus,visibleIds:[12,55,101]});
  assert.deepEqual(result.queryResults[0].recordIds,[1,4,41]);assert.match(result.answers[0],/Record count: 3/);
  assert.match(result.answers[0],/Total Value: \$900\.00/);assert.match(result.answers[0],/Average Value: \$300\.00/);
  for(const id of [1,4,41])assert(result.answers[0].includes(w.records.find(r=>r.id===id).f_deal));
  assert.equal(result.mutates,false);assert.deepEqual(w,before);
  const empty=evidence(w,steps,{conversationFocus:{kind:'table',ids:[]},visibleIds:[12,55,101]});
  assert.deepEqual(empty.queryResults[0].recordIds,[]);assert.match(empty.answers[0],/Record count: 0/);
});

test('compiler errors expose only allowlisted operation and static reason metadata with original causes',()=>{
  const w=taskWorkspace(),secret='PRIVATE_LABEL_AND_VALUE';
  const cases=[
    {step:taskStep(w,0,'dueDate',literal('2026-02-30')),op:'update_tasks',reason:'date_invalid'},
    {step:{...taskStep(w,0,'dueDate',relative(1)),changes:null},op:'update_tasks',reason:'type_error',type:TypeError},
    {step:F.select('subset',[],{source:secret}),op:'select_records',reason:'selection_dependency'},
    {step:F.select('subset',[[F.where(secret,'equals',secret)]]),op:'select_records',reason:'field_unavailable'},
    {step:{op:secret,id:'unknown',label:secret},op:undefined,reason:'unsupported_operation'}
  ];
  for(const {step,op,reason,type=Error}of cases){
    step.label=secret;const error=caught(()=>prepare(w,[step]));
    assert.equal(error.compilerStep,op);assert.equal(error.reasonCode,reason);assert.equal(error.clarification,true);
    assert(error.cause instanceof type);assert.equal(Object.getOwnPropertyDescriptor(error,'cause').enumerable,false);
    assert(error instanceof type);
    const diagnostic=Diagnostic.describe(error,{action:'workspace_plan'});
    assert.equal(diagnostic.operation,op??null);
    assert.equal(diagnostic.reason,type===TypeError?'runtime_typeerror':op===undefined?'unclassified':reason);
    assert.doesNotMatch(JSON.stringify(error),/PRIVATE|Contact Uppal|UppalCo/);
    assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE|Contact Uppal|UppalCo/);
  }
  const missing=taskStep(w,0,'dueDate',relative(1));missing.selection.references[0].taskName=secret;
  assert.equal(caught(()=>prepare(w,[missing])).reasonCode,'task_reference_missing');
  w.todoCards.push({...w.todoCards[0],id:'todo_ambiguous'});
  assert.equal(caught(()=>prepare(w,[taskStep(w,0,'dueDate',relative(1))])).reasonCode,'task_reference_ambiguous');
});

test('focus and numeric read failures retain static diagnostics without broadening the cohort',()=>{
  const w=F.workspace(),selection=F.select('subset',[],{source:'focus'});
  for(const focus of [null,{kind:'todos',ids:['todo_uppal']},{kind:'table',ids:null}]){
    const error=caught(()=>prepare(w,[selection],{focus}));assert.equal(error.compilerStep,'select_records');assert.equal(error.reasonCode,'focus_unavailable');
  }
  const stale=caught(()=>prepare(w,[selection],{focus:{kind:'table',ids:[999]}}));
  assert.equal(stale.reasonCode,'record_selection_stale');
  const error=caught(()=>prepare(w,[F.select('subset'),Q.read('subset',[{kind:'sum',field:'f_owner'}])]));
  assert.equal(error.compilerStep,'read_records');assert.equal(error.reasonCode,'numeric_field_required');
});

test('every supported operation can be diagnosed but unknown dependency metadata is never forwarded',t=>{
  const w=taskWorkspace();
  for(const branch of Plan.responseSchema().properties.steps.items.anyOf){
    const op=branch.properties.op.enum[0],error=caught(()=>prepare(w,[{op,id:'step',label:'PRIVATE_LABEL'}]));
    assert.equal(error.compilerStep,op);
  }
  const cause=new Error('PRIVATE_MESSAGE');cause.reasonCode='PRIVATE_CODE';cause.compilerStep='PRIVATE_OPERATION';
  t.mock.method(Tasks,'plan',()=>{throw cause;});
  const error=caught(()=>prepare(w,[taskStep(w,0,'dueDate',relative(1))]));
  assert.equal(error.cause,cause);assert.equal(error.reasonCode,'step_validation');assert.equal(error.compilerStep,'update_tasks');
  assert.doesNotMatch(JSON.stringify(error),/PRIVATE/);
});
