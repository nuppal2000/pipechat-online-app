'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),Todo=require('../public/todo-core');
const Review=require('../lib/action-review'),Core=require('../public/pipeline-core');
const F=require('./fixtures/workspace-plans.cjs');
const noOpen=()=>({quantifier:'none',statuses:['To Do','In Progress']});
function workspace(){
  const w=F.workspace();
  w.records=Array.from({length:8},(_,i)=>({...w.records[0],id:i+1,f_deal:(i<6?'Segment ':'Outside Segment ')+(i+1)}));
  const card=(id,recordId,status)=>({...Todo.create(id,recordId),status,nextAction:'Follow up'});
  w.todoCards=[card('todo_done',2,'Done'),card('todo_todo',3,'To Do'),card('todo_progress',4,'In Progress'),
    card('todo_mixed_done',5,'Done'),card('todo_mixed_open',5,'To Do'),
    card('todo_done_a',6,'Done'),card('todo_done_b',6,'Done'),card('todo_outside',8,'In Progress'),
    {...Todo.create('todo_unlinked',null,w.records[0].f_deal),status:'To Do',nextAction:'Follow up'}];
  return w;
}
const select=relatedTasks=>F.select('selected',[[F.where('f_deal','starts_with','Segment')]],{relatedTasks});
const read={op:'read_records',id:'answer',label:'Names and count',selection:'selected',showTable:true,
  outputs:[{kind:'names',field:null},{kind:'count',field:null}]};
const prepare=(w,steps,options={})=>Plan.prepare(w,F.plan(steps),{nonce:'relations',today:'2026-11-10',...options});
const ids=p=>p.review.find(s=>s.id==='selected').records.map(r=>r.id);

test('no open task includes Done-only and never-task records, but excludes either active lane and mixed tasks',()=>{
  const w=workspace(),before=structuredClone(w);
  assert.deepEqual(ids(prepare(w,[select('none'),read])),[1],'no tasks is deliberately stricter than no open tasks');
  const p=prepare(w,[select(noOpen()),read],{visibleIds:[8]});
  assert.deepEqual(ids(p),[1,2,6]);
  assert.deepEqual(p.queryResults[0].recordIds,[1,2,6]);
  assert.deepEqual(p.effects.find(e=>e.kind==='table').ids,[1,2,6]);
  assert.equal(p.mutates,false);assert.deepEqual(w,before);assert.deepEqual(p.next,w);
  assert.equal(p.review.find(s=>s.id==='answer').count,3);
  assert.deepEqual(p.review[0].relatedTasks,{source:'original_tasks',...noOpen()});
  assert.match(p.review[0].filter,/none with status in \[To Do, In Progress\]/);
});

test('legacy task existence is unchanged and status quantifiers are generic complements',()=>{
  const w=workspace();
  for(const [filter,expected] of [['any',[1,2,3,4,5,6]],['none',[1]],['exists',[2,3,4,5,6]],
    [{quantifier:'exists',statuses:['In Progress','To Do']},[3,4,5]],
    [{quantifier:'exists',statuses:['Done']},[2,5,6]],
    [{quantifier:'none',statuses:['Done']},[1,3,4]]]){
    assert.deepEqual(ids(prepare(w,[select(filter),read])),expected);
  }
  w.todoCards=[];assert.deepEqual(ids(prepare(w,[select(noOpen()),read])),[1,2,3,4,5,6]);
  assert.deepEqual(ids(prepare(w,[select({quantifier:'exists',statuses:['To Do','In Progress']}),read])),[]);
});

test('relations intersect visible, focus and prior selections, retaining ordering and empty scope',()=>{
  const w=workspace();
  for(const [source,options,expected] of [['visible',{visibleIds:[6,5,2]},[6,2]],
    ['focus',{focus:{kind:'table',ids:[5,2,1]}},[2,1]],['focus',{focus:{kind:'table',ids:[]}},[]]]){
    assert.deepEqual(ids(prepare(w,[{...select(noOpen()),source},read],options)),expected);
  }
  const prior=F.select('cohort',[[F.where('f_deal','in',null,[w.records[1].f_deal,w.records[4].f_deal])]]);
  assert.deepEqual(ids(prepare(w,[prior,{...select(noOpen()),source:'cohort'},read])),[2]);
  w.records.forEach((row,i)=>row.f_value=i);
  assert.deepEqual(ids(prepare(w,[{...select(noOpen()),orderBy:'f_value',direction:'desc',limit:2},read])),[6,2]);
});

test('task relationships use IDs, not duplicate primary names or unlinked task titles',()=>{
  const w=workspace();w.records[1].f_deal=w.records[3].f_deal;
  const p=prepare(w,[select(noOpen()),read]);
  assert.deepEqual(ids(p),[1,2,6]);assert(!ids(p).includes(4));
});

test('relationship eligibility reads original saved tasks even after staged creation or status edits',()=>{
  const w=workspace(),before=structuredClone(w);
  const close={op:'update_tasks',id:'close',label:'Close a task',selection:{source:'ids',ids:['todo_todo'],focusId:null,conditions:[]},
    changes:[{field:'status',operation:'set',value:'Done'}]};
  const reopen={...close,id:'reopen',selection:{...close.selection,ids:['todo_done']},changes:[{field:'status',operation:'set',value:'To Do'}]};
  assert.deepEqual(ids(prepare(w,[close,reopen,select(noOpen()),read])),[1,2,6]);
  assert.deepEqual(ids(prepare(w,[F.select('all_rows'),F.tasks('create','all_rows'),select(noOpen()),read])),[1,2,6]);
  assert.deepEqual(w,before);
});

test('invalid task predicates or saved task statuses fail the complete plan, even for zero record matches',()=>{
  const invalid=[{},[],{quantifier:'all',statuses:['To Do']},{quantifier:'none',statuses:[]},
    {quantifier:'none',statuses:['Open']},{quantifier:'none',statuses:['Done','Done']},
    {quantifier:'none',statuses:'Done'},{...noOpen(),recordIds:[1]},{quantifier:'none',statuses:[null]}];
  for(const relatedTasks of invalid){
    const w=workspace(),before=structuredClone(w);
    assert.throws(()=>prepare(w,[F.select('all_rows'),F.update('edit','all_rows','f_priority','High'),
      {...select(relatedTasks),where:[[F.where('f_deal','equals','Missing')]]},read]),/entire plan is unchanged/);
    assert.deepEqual(w,before);
  }
  const w=workspace();w.todoCards[0].status='Unknown';
  assert.throws(()=>prepare(w,[select(noOpen()),read]),/Invalid To Do card/);
});

test('model schema and canonical read evidence carry the same task relationship contract',()=>{
  const p={...workspace(),currentDate:'2026-11-10',visibleIds:[8],workspaceVersion:'v1'};
  const model=Review.modelSchema({properties:{crmAction:{anyOf:[Plan.responseSchema(Core.create(p.tableSchema))]}}});
  const plan=model.properties.crmAction.anyOf.find(s=>s.properties.action.enum.includes('workspace_plan'));
  const relation=plan.properties.steps.items.anyOf.find(s=>s.properties.op.enum.includes('select_records')).properties.relatedTasks;
  assert.deepEqual(relation.anyOf[0].enum,['any','none','exists']);
  assert.deepEqual(relation.anyOf[1].properties.statuses.items.enum,Todo.statuses);
  assert.equal(relation.description,Plan.taskRelationshipInstructions);
  const result={crmAction:F.plan([select(noOpen()),read])},e=Review.evidence({pipeline:p},result);
  assert.deepEqual(e.queryResults[0].recordIds,[1,2,6]);assert.equal(e.lifecycle.executed,false);
  assert.deepEqual(e.review[0].relatedTasks,{source:'original_tasks',...noOpen()});
  const req={description:'Names and count for records without open tasks',satisfied:true,evidenceKind:'computed_read',stepIds:['answer'],requiredOutputs:['names','count']};
  assert(Review.validateReview({requirements:[req],issues:[]},result,{pipeline:p,computed:e}).ok);
  assert.match(Review.renderAnswer({pipeline:p},result,e),/Segment 2/);
});
