'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Todo=require('../public/todo-core');
const F=require('./fixtures/workspace-plans.cjs');
const noOpen=()=>({quantifier:'none',statuses:['To Do','In Progress']});
const read=(id,kind,selection='eligible')=>({op:'read_records',id,label:id,selection,showTable:false,outputs:[{kind,field:null}]});
const req=(stepIds=['names','count'],requiredOutputs=['names','count'])=>({description:'Requested record answer',
  satisfied:true,evidenceKind:'computed_read',stepIds,requiredOutputs});
const envelope=requirement=>({requirements:[requirement],issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null});
function fixture(steps,extra={}){
  const pipeline={...F.workspace(),currentDate:'2026-11-10',...extra};
  const card=(id,recordId,status)=>({...Todo.create('todo_'+id,recordId),status,nextAction:'Follow up'});
  pipeline.todoCards=[card('done',2,'Done'),card('todo',3,'To Do'),card('progress',4,'In Progress'),
    card('mixed_done',5,'Done'),card('mixed_open',5,'To Do'),card('done_a',6,'Done'),card('done_b',6,'Done')];
  const result={crmAction:F.plan(steps||[F.select('eligible',[],{relatedTasks:noOpen()}),read('names','names'),read('count','count')])};
  const computed=Review.evidence({pipeline},result),context={pipeline,computed};
  return {result,context,schema:JSON.parse(JSON.stringify(Review.schemaFor(result.crmAction,context))),
    check:(requirement=req())=>Review.validateReview(envelope(requirement),result,context).ok};
}
// Check the serialized schema independently of runtime validation.
function accepts(s,v){
  if(s.anyOf&&!s.anyOf.some(branch=>accepts(branch,v)))return false;
  const type=v===null?'null':Array.isArray(v)?'array':typeof v,types=[s.type].flat();
  if(s.type&&!types.includes(type)&&!(Number.isInteger(v)&&types.includes('integer')))return false;
  if(s.enum&&!s.enum.includes(v))return false;
  if(type==='object'&&s.properties)return (s.required||[]).every(k=>Object.hasOwn(v,k))&&
    Object.keys(v).every(k=>Object.hasOwn(s.properties,k)?accepts(s.properties[k],v[k]):s.additionalProperties!==false);
  if(type==='array')return v.length>=(s.minItems||0)&&v.length<=(s.maxItems??Infinity)&&(!s.items||v.every(item=>accepts(s.items,item)));
  return true;
}

test('relationship review retains Done-only and never-task rows, excluding open and mixed-task rows',()=>{
  const f=fixture();
  for(const evidence of f.context.computed.recordReadEvidence){
    assert.deepEqual(evidence.recordIds,[1,2,6]);
    assert.deepEqual(evidence.selectionChain[0].relatedTasks,{source:'original_tasks',...noOpen()});
  }
  assert(f.check());
});

test('reserved focus and visible sources do not become self-referential selection dependencies',()=>{
  for(const source of ['focus','visible']){
    const f=fixture([F.select(source,[],{source,relatedTasks:noOpen()}),read('names','names',source)],
      {conversationFocus:{kind:'table',ids:[1,2,3]},visibleIds:[1,2,3]});
    const evidence=f.context.computed.recordReadEvidence[0];
    assert.deepEqual(evidence.recordIds,[1,2]);
    assert.deepEqual(evidence.selectionChain.map(step=>step.selectionId),[source]);
    assert.equal(evidence.selectionChain[0].source,source);
    assert(f.check(req(['names'],['names'])));
  }
});

test('reserved sources cannot borrow an unused same-named selection predicate',()=>{
  for(const source of ['focus','visible']){
    const f=fixture([F.select(source,[[F.where('f_owner','equals','Other owner')]]),
      F.select('eligible',[],{source,relatedTasks:noOpen()}),read('names','names')],
    {conversationFocus:{kind:'table',ids:[1,2,3]},visibleIds:[1,2,3]});
    assert.deepEqual(f.context.computed.review.find(step=>step.id===source).records,[]);
    const evidence=f.context.computed.recordReadEvidence[0];
    assert.deepEqual(evidence.recordIds,[1,2]);
    assert.deepEqual(evidence.selectionChain.map(step=>step.selectionId),['eligible']);
    assert.deepEqual(evidence.selectionChain[0].where,[]);
    assert(f.check(req(['names'],['names'])));
  }
});

test('without conversation focus, a real selection named focus remains an authenticated ancestor',()=>{
  const where=[[F.where('f_priority','equals','Low')]];
  const f=fixture([F.select('focus',where),F.select('eligible',[],{source:'focus',relatedTasks:noOpen()}),read('names','names')]);
  const evidence=f.context.computed.recordReadEvidence[0];
  assert.deepEqual(evidence.recordIds,[1,6]);
  assert.deepEqual(evidence.selectionChain.map(step=>step.selectionId),['focus','eligible']);
  assert.deepEqual(evidence.selectionChain[0].where,where);
  assert(f.check(req(['names'],['names'])));
});

test('same-cohort names and count reads can jointly satisfy one requirement in schema and validator',()=>{
  const f=fixture();
  for(const requirement of [req(),req(['count','names'],['count','names']),req(['names'],['names']),req(['count'],['count'])]){
    assert(accepts(f.schema,envelope(requirement)));
    assert(f.check(requirement));
  }
});

test('missing read outputs, missing reads and invalid compound citations fail closed',()=>{
  const f=fixture();
  for(const requirement of [req(['names']),req(['names','count'],['names','count','median']),
    req(['names','names']),req(['names','eligible']),req(['names','missing']),req([])]){
    assert(!f.check(requirement),JSON.stringify(requirement));
  }
  const namesOnly=fixture([F.select('eligible',[],{relatedTasks:noOpen()}),read('names','names')]);
  assert(!accepts(namesOnly.schema,envelope(req(['names']))));
  assert(!namesOnly.check(req(['names'])));
  const selectionOnly=fixture([F.select('eligible',[],{relatedTasks:noOpen()})]);
  assert(!selectionOnly.check(req(['eligible'],['names'])));
});

test('copied, stale and altered computed relationship evidence cannot authorize a read',()=>{
  for(const change of [f=>f.context.computed=structuredClone(f.context.computed),
    f=>f.context.pipeline.todoCards[0].status='To Do',
    f=>f.context.computed.recordReadEvidence[0].selectionChain[0].relatedTasks.statuses=['Done']]){
    const f=fixture();assert(f.check());change(f);assert(!f.check());
  }
});

test('an unused relationship step neither specializes nor contaminates an unrelated read',()=>{
  const f=fixture([F.select('unused',[],{relatedTasks:noOpen()}),F.select('all_rows'),read('names','names','all_rows')]);
  const evidence=f.context.computed.recordReadEvidence[0];
  assert.deepEqual(evidence.recordIds,[1,2,3,4,5,6]);
  assert.deepEqual(evidence.selectionChain.map(step=>step.selectionId),['all_rows']);
  assert.equal(evidence.selectionChain[0].relatedTasks,null);
  assert.equal(f.schema.properties.requirements.items.anyOf,undefined);
  assert(accepts(f.schema,envelope(req(['names'],['names']))));
  assert(f.check(req(['names'],['names'])));
});
