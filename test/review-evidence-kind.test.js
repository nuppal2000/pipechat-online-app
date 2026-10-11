'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review');
const requirement=(evidenceKind,stepIds=['root'])=>({description:'Requested outcome',evidenceKind,stepIds,satisfied:true});
const check=(action,r)=>Review.validateReview({requirements:[r],issues:[],clarificationQuestion:null},{crmAction:action,assistantMessage:'Here are the saved values: 123.'});
test('review contract classifies every outcome by evidence kind',()=>{
  const schema=Review.schema.properties.requirements.items;
  assert(schema.required.includes('evidenceKind'));
  assert(schema.properties.evidenceKind.enum.includes('computed_read'));
  assert(Review.needsReview({userCommand:'What was the recorded contact?'},{crmAction:null}));
  assert(Review.needsReview({userCommand:'Good morning'},{crmAction:null}));
});
test('saved data prose cannot satisfy a computed read even if the reviewer marks it satisfied',()=>{
  for(const evidenceKind of [undefined,'invented',null])assert.equal(check({action:'audit_records'},requirement(evidenceKind)).ok,false);
  for(const action of [null,{action:'clarify'},{action:'add_field'}]){
    const result=check(action,requirement('computed_read'));
    assert.equal(result.ok,false);assert.equal(result.compiled,0);
    assert.match(result.mappingIssues[0],/canonical read step/);
  }
});
test('canonical read steps, not selection or mutation steps alone, supply read evidence',()=>{
  const action={action:'workspace_plan',steps:[{id:'cohort',op:'select_records'},{id:'edit',op:'update_records'},{id:'answer',op:'read_records'},{id:'grouped',op:'report'}]};
  for(const id of ['cohort','edit'])assert.equal(check(action,requirement('computed_read',[id])).ok,false);
  for(const id of ['answer','grouped'])assert.equal(check(action,requirement('computed_read',[id])).ok,true);
  assert.equal(check(action,requirement('computed_read',['invented'])).ok,false);
  for(const actionName of ['query_business','query_todos','audit_records','analyze_dashboard','workflow_history'])assert.equal(check({action:actionName},requirement('computed_read')).ok,true);
});
test('saved workflow history is rendered from persisted events rather than model prose',()=>{
  const payload={pipeline:{tableSchema:null,customFields:[],workflows:[{id:'workflow_fixture',spec:{name:'Follow-up automation'},history:[{type:'created',at:'2026-10-10T12:00:00Z',status:'draft'},{type:'activated',at:'2026-10-10T13:00:00Z',status:'active'}],executions:[]}]}};
  const result={crmAction:{action:'workflow_history',workflowId:'workflow_fixture',limit:20},assistantMessage:'100 tasks executed successfully.'};
  const answer=Review.renderAnswer(payload,result);
  assert.match(answer,/2 saved history entries/);assert.match(answer,/activated \/ active/);assert.match(answer,/created \/ draft/);
  assert.doesNotMatch(answer,/100 tasks/);
});
test('general discussion and unavailable-field explanations still need no write action',()=>{
  for(const kind of ['conversation','unavailable','clarification'])assert.equal(check(null,requirement(kind)).ok,true);
  assert.equal(check(null,requirement('compiled_action')).ok,false);
  assert.equal(check({action:'clarify'},requirement('compiled_action')).ok,false);
  assert.equal(check({action:'create_workflow'},requirement('compiled_action')).ok,true);
});
