'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../public/workspace-plan'),Review=require('../lib/action-review'),Diagnostic=require('../lib/compiler-diagnostic');
const F=require('./fixtures/workspace-plans.cjs');
const options={today:'2026-10-23',nonce:'goal_coverage',now:1};
const history=(id='answer',selection='selected')=>({op:'read_history',id,label:'Read saved context',selection,kind:'all',from:null,to:null,limit:100});
const read=(id='answer',selection='selected')=>({op:'read_records',id,label:'Read current values',selection,outputs:[{kind:'fields',field:'f_notes'}],showTable:false});
const plan=(steps,ids)=>({...F.plan(steps),goals:[{description:'Requested business outcome',stepIds:ids}]});
const run=(action,workspace=F.workspace(),extra={})=>Plan.prepare(workspace,action,{...options,...extra});
function failure(action,workspace=F.workspace()){
  const before=structuredClone(workspace);let error;
  try{run(action,workspace);}catch(caught){error=caught;}
  assert(error,'The entire plan must fail');assert.deepEqual(workspace,before);return error;
}

test('one fact outcome covers its preceding selection for history and current field reads',()=>{
  for(const answer of [history(),read()]){
    const workspace=F.workspace(),action=plan([F.select('selected',[[F.where('f_deal','equals',workspace.records[0].f_deal)]]),answer],['answer']);
    const before=structuredClone({workspace,action}),result=run(action,workspace);
    assert.equal(result.mutates,false);assert.deepEqual(result.queryResults[0].recordIds,[1]);
    assert.deepEqual(result.goals,action.goals);assert.deepEqual(result.review.map(step=>step.id),['selected','answer']);
    assert.deepEqual({workspace,action},before);
    const payload={pipeline:{...workspace,currentDate:options.today}},compiled={crmAction:action},computed=Review.evidence(payload,compiled);
    const review={requirements:[{description:'Saved fact',evidenceKind:'computed_read',satisfied:true,stepIds:['answer'],requiredOutputs:['fields']}],issues:[],clarificationQuestion:null};
    assert.equal(Review.validateReview(review,compiled,{pipeline:payload.pipeline,computed}).ok,true);
    review.requirements[0].stepIds=['selected'];assert.equal(Review.validateReview(review,compiled,{pipeline:payload.pipeline,computed}).ok,false,'Selection coverage never becomes answer evidence');
  }
});

test('transitive and shared selection dependencies retain exact scope without extra goals',()=>{
  const steps=[F.select('base',[[F.where('f_value','gte',34000)]]),F.select('selected',[[F.where('f_value','lte',50000)]],{source:'base'}),
    history(),read('current')];
  const action=plan(steps,['answer','current']),result=run(action);
  assert.deepEqual(result.queryResults.map(query=>query.recordIds),[[1,2,4],[1,2,4]]);
  const legacy=F.plan(steps);assert.deepEqual(run(legacy).queryResults,result.queryResults);
  assert.equal(result.goals.length,1);assert.equal(result.review.length,4);
});

test('an explicitly requested selection covers its own predecessors, not unused sibling selections',()=>{
  const steps=[F.select('base'),F.select('selected',[],{source:'base'})];
  assert.deepEqual(run(plan(steps,['selected'])).review.map(step=>step.id),['base','selected']);
  const error=failure(plan([...steps,F.select('unused')],['selected']));
  assert.equal(error.reasonCode,'goal_coverage_invalid');
  assert.deepEqual(error.goalCoverage,{unknownReferences:0,uncoveredSelections:1,uncoveredOperations:0});
});

test('built-in selection sources are terminals, even when another step has that ID',()=>{
  for(const source of ['visible','focus']){
    const action=plan([F.select(source),F.select('selected',[],{source}),read()],['answer']);
    const error=failure(action);assert.equal(error.goalCoverage.uncoveredSelections,1);
    const covered=plan(action.steps,[source,'answer']);
    const result=run(covered,F.workspace(),{visibleIds:[2],focus:{kind:'table',ids:[2]}});
    assert.deepEqual(result.queryResults[0].recordIds,[2]);
  }
});

test('explicit updates, task additions and selected reports cover only their pure selection prerequisites',()=>{
  const spec={version:1,title:'Value',chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,
    measures:[{label:'Value',metric:'sum',field:'f_value',where:[]}]};
  const effects=[F.update('effect','selected','f_notes','Proposed update'),F.tasks('effect','selected'),
    {op:'report',id:'effect',label:'Selected report',selection:'selected',spec,questions:[{kind:'summary',elementIds:['effect']}],showDashboard:false}];
  for(const effect of effects){
    const result=run(plan([F.select('selected'),effect],['effect']));assert.equal(result.review.length,2);
    assert.deepEqual(result.goals[0].stepIds,['effect']);
  }
});

test('unlisted mutations, reads, views and schema operations never gain dependency coverage',()=>{
  const effects=[F.update('hidden','selected','f_notes','Hidden write'),F.tasks('hidden','selected'),read('hidden'),
    {op:'add_field',id:'hidden',label:'Hidden column',name:'Unrequested',type:'text',options:[]},
    {op:'rename_choice_option',id:'hidden',label:'Hidden rename',field:'f_priority',from:'Low',to:'Minimal'},
    {op:'add_unlinked_task',id:'hidden',label:'Hidden task',customTitle:'Unrequested',status:'To Do',nextAction:'Hidden',notes:'',dueDate:null},
    {op:'update_tasks',id:'hidden',label:'Hidden edit',selection:{},changes:[]},
    {op:'dashboard',id:'hidden',label:'Hidden dashboard',plan:{action:'dashboard_plan',operations:[{op:'clear'}],questions:[]}},
    {op:'report',id:'hidden',label:'Hidden report',selection:'selected',spec:{},questions:[],showDashboard:true}];
  for(const effect of effects){
    const error=failure(plan([F.select('selected'),effect,history()],['answer']));
    assert.equal(error.reasonCode,'goal_coverage_invalid',effect.op);assert.equal(error.goalCoverage.uncoveredOperations,1,effect.op);
  }
  const action=plan([{op:'add_field',id:'field',label:'New field',name:'Unrequested',type:'text',options:[]},
    F.select('selected',[[F.where('@field','is_blank')]]),read()],['answer']);
  assert.equal(failure(action).goalCoverage.uncoveredOperations,1,'Field dependencies do not imply schema authority');
});

test('forward references, cycles and references to non-selections stay invalid',()=>{
  const cases=[
    plan([history(),F.select('selected')],['answer']),
    plan([F.select('selected',[],{source:'later'}),F.select('later',[],{source:'selected'}),read()],['answer']),
    plan([F.select('selected',[],{source:'selected'}),read()],['answer']),
    plan([F.select('selected',[],{source:'missing'}),read()],['answer']),
    plan([{op:'add_field',id:'selected',label:'Not a selection',name:'New',type:'text',options:[]},history()],['answer']),
    plan([F.select('base'),read('selected','base'),history()],['answer'])
  ];
  for(const action of cases){
    failure(action);
    failure({...action,goals:action.steps.map(step=>({description:'Explicit coverage',stepIds:[step.id]}))});
  }
});

test('unknown goal IDs, empty goals and unused selections have distinct closed diagnostics',()=>{
  const base=[F.select('selected'),history()];
  const unknown=failure(plan(base,['private_missing']));
  assert.deepEqual(Diagnostic.describe(unknown,{action:'workspace_plan'}),{action:'workspace_plan',operation:null,reason:'step_reference_invalid',
    goalCoverage:{unknownReferences:1,uncoveredSelections:0,uncoveredOperations:0}});
  const unused=failure(plan([...base,F.select('private_unused')],['answer']));
  assert.equal(Diagnostic.describe(unused,{action:'workspace_plan'}).reason,'goal_coverage_invalid');
  for(const goals of [[],[{description:'Missing reference',stepIds:[]}],[{description:'',stepIds:['answer']}]]){
    const error=failure({...plan(base,['answer']),goals});assert.equal(Diagnostic.describe(error,{action:'workspace_plan'}).reason,'goal_shape_invalid');
  }
  assert.doesNotMatch(JSON.stringify([Diagnostic.describe(unknown,{action:'workspace_plan'}),Diagnostic.describe(unused,{action:'workspace_plan'})]),/private_missing|private_unused|Saved context/);
});

test('schema and planner describe dependency coverage without changing strict read-evidence authority',()=>{
  const schema=Plan.responseSchema();assert.match(schema.properties.goals.description,/Preceding select_records dependencies/);
  assert.match(Review.compilerInstructions,/PLAN GOAL COVERAGE/);assert.match(Review.compilerInstructions,/Every non-selection operation/);
  assert.match(Review.compilerInstructions,/Reviewer evidence still maps to the actual read/);
  assert.doesNotMatch(schema.properties.goals.description,/Acorn|email/);
});
