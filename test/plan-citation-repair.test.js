'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {eligible,sameObligations}=require('../lib/plan-citation-repair');
const action={action:'dashboard_plan'},coverage={ok:false,mappingReasons:{unsupported_required_output:1}};
const req={description:'Display the mean',evidenceKind:'computed_read',requiredOutputs:['average','scalar_kpi'],satisfied:true,stepIds:['root']};
const review={issues:[],answerIntent:'canonical',answerSelection:null,clarificationQuestion:null,requirements:[req]};
test('only a complete semantic review of a read-only visual plan is eligible for citation repair',()=>{
  assert(eligible(action,review,coverage));
  assert(!eligible({action:'workspace_plan'},review,coverage));
  for(const diff of [{issues:['wrong scope']},{clarificationQuestion:'Which deal?'},{requirements:[{...req,satisfied:false}]}])
    assert(!eligible(action,{...review,...diff},coverage));
  assert(!eligible(action,review,{ok:true}));assert(!eligible(action,review,{ok:false,mappingReasons:{}}));
});
test('a numeric proposal is eligible only when every nonselection step has numeric evidence',()=>{
  const create={op:'add_field',id:'field'},write={op:'update_records',id:'assign'};
  const plan={action:'workspace_plan',steps:[create,{op:'select_records',id:'choose'},write]};
  const computed={numericAssignmentEvidence:[{stepId:'field'},{stepId:'assign'}]};
  assert(eligible(plan,review,coverage,computed));
  assert(!eligible({...plan,steps:[...plan.steps,{op:'add_todos',id:'task'}]},review,coverage,computed));
  assert(!eligible(plan,review,coverage,{numericAssignmentEvidence:[{stepId:'field'}]}));
});
test('a citation repair cannot silently remove a metric, change the request or waive a semantic rejection',()=>{
  assert(sameObligations(review,{...review,requirements:[{...req,requiredOutputs:['scalar_kpi','average'],stepIds:['graph:mean']}]}));
  for(const diff of [{requirements:[]},{issues:['wrong graph']},{requirements:[{...req,description:'Display a count'}]},
    {requirements:[{...req,satisfied:false}]},{requirements:[{...req,requiredOutputs:['average']}]},{answerIntent:'qualitative_fact'}])
    assert(!sameObligations(review,{...review,...diff}));
});
