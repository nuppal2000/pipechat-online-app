'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Diagnostic=require('../lib/compiler-diagnostic');
const Business=require('../public/business-workspace'),Views=require('../public/view-actions'),F=require('./fixtures/workspace-plans.cjs');
const workspaceId='11111111-1111-4111-8111-111111111111',viewId='view_33333333-3333-4333-8333-333333333333';
function fixture(){
  const pipeline=F.workspace();pipeline.records=pipeline.records.slice(0,3).map(row=>({...row,f_deal:'PRIVATE RECORD '+row.id,f_notes:'=PRIVATE_CELL()',history:['PRIVATE HISTORY']}));
  pipeline.tableSchema.columnOrder=['f_deal','f_value','f_notes','f_follow','f_owner','f_contact','f_stage','f_priority'];
  return {pipeline:{...pipeline,currentDate:'2026-10-26',visibleIds:[3,1],business:{workspaceId,state:{...Business.empty(),views:[{id:viewId,name:'Existing view',entityIds:[2,1].map(id=>Business.legacyId(workspaceId,id))}]}}}};
}
const saved=()=>({source:'saved_view',viewId});
const actions=()=>[
  {action:'save_view',name:'My selection',selection:{source:'visible'}},
  {action:'open_view',selection:saved()},
  {action:'export_records',selection:saved(),columns:{source:'selected',columnIds:['f_notes','f_value']},format:'csv'}
];

test('save/open/export use exact helper selections while whitelisting reviewer metadata',()=>{
  const payload=fixture(),before=structuredClone(payload);
  for(const action of actions()){
    const result={crmAction:action,assistantMessage:'Saved, opened and downloaded PRIVATE MODEL VALUES.'},computed=Review.evidence(payload,result);
    assert.equal(computed.kind,'view-preview');assert.equal(computed.operation,action.action);assert.equal(computed.status,'prepared');assert.equal(computed.count,2);
    assert.deepEqual(computed.selection.recordIds,action.action==='save_view'?[3,1]:[2,1]);
    assert.deepEqual(computed.columns,action.action==='export_records'?[{id:'f_notes',name:'Notes'},{id:'f_value',name:'Value'}]:[]);
    assert.deepEqual(Object.keys(computed).sort(),['columns','constraintEvidence','count','disclosure','kind','lifecycle','operation','selection','status']);
    assert.deepEqual(computed.constraintEvidence.map(item=>[item.id,item.output]),[['lifecycle:preview_only','preview_only']]);
    assert.deepEqual(Object.keys(computed.selection).sort(),['recordIds','source','viewId']);
    assert.equal(computed.lifecycle.executed,false);assert.equal(computed.lifecycle.writesApplied,0);
    const json=JSON.stringify(computed);assert.doesNotMatch(json,/PRIVATE|"artifact"|"body"|"commands"|"tableView"|"entityIds"|"filename"/);
    const answer=Review.renderAnswer(payload,result,computed);assert.match(answer,/Prepared/);assert.doesNotMatch(answer,/PRIVATE|Saved, opened and downloaded/);
    if(action.action==='save_view')assert.match(answer,/No view has been saved/);
    if(action.action==='open_view')assert.match(answer,/table view has not been changed/);
    if(action.action==='export_records')assert.match(answer,/No file has been downloaded or sent/);
    assert.deepEqual(payload,before);
  }
});

test('all-column exports preserve current schema order and empty visible scope never broadens',()=>{
  const payload=fixture(),action={action:'export_records',selection:{source:'all'},columns:{source:'all'},format:'csv'};
  const all=Review.evidence(payload,{crmAction:action});assert.equal(all.count,3);assert.deepEqual(all.selection.recordIds,[1,2,3]);
  assert.deepEqual(all.columns.map(column=>column.id),payload.pipeline.tableSchema.columnOrder);
  payload.pipeline.visibleIds=[];action.selection={source:'visible'};
  const empty=Review.evidence(payload,{crmAction:action});assert.equal(empty.count,0);assert.deepEqual(empty.selection.recordIds,[]);
  assert.match(Review.renderAnswer(payload,{crmAction:action},empty),/Prepared CSV export: 0 records/);
  assert.match(empty.disclosure,/anyone|Anyone/);assert.match(empty.disclosure,/apostrophe/);
});

test('view planning allocates an application UUID and never copies artifact contents into evidence',t=>{
  const original=Views.plan,seen=[];t.after(()=>{Views.plan=original;});
  Views.plan=(action,context,options)=>{
    assert.equal(context.workspaceId,workspaceId);assert.deepEqual(context.visibleIds,[3,1]);
    assert.match(options.newViewId,/^view_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    seen.push(options.newViewId);
    const planned=original(action,context,options);
    return {...planned,privateValues:'PRIVATE EXTRA',artifact:{body:'PRIVATE CSV BODY'},commands:[{private:'PRIVATE COMMAND'}]};
  };
  const payload=fixture();for(const action of actions())assert.doesNotMatch(JSON.stringify(Review.evidence(payload,{crmAction:action})),/PRIVATE|artifact|commands/);
  assert.equal(new Set(seen).size,3);
});

test('stale views, removed columns, wrong workspace and guessed model values reject before evidence',()=>{
  const cases=[
    [p=>p.pipeline.visibleIds=[999],actions()[0],'view_selection_stale'],
    [p=>p.pipeline.business.state.views=[],actions()[1],'view_selection_stale'],
    [()=>{},{...actions()[2],columns:{source:'selected',columnIds:['missing']}},'view_columns_stale'],
    [p=>p.pipeline.business.workspaceId='22222222-2222-4222-8222-222222222222',actions()[1],'view_selection_stale'],
    [()=>{},{...actions()[0],count:99},'view_validation'],
    [()=>{},{...actions()[2],body:'PRIVATE MODEL CSV'},'view_validation']
  ];
  for(const [change,action,reason] of cases){
    const payload=fixture();change(payload);const before=structuredClone(payload);let error;
    try{Review.evidence(payload,{crmAction:action});}catch(e){error=e;}
    assert(error);assert.equal(error.reasonCode,reason);assert.deepEqual(payload,before);
    assert.deepEqual(Diagnostic.describe(error,action),{action:action.action,operation:null,reason});
    assert.doesNotMatch(JSON.stringify(Review.validationDiagnostic({stage:'evidence',action,error})),/PRIVATE|999|body/);
  }
});

test('prepared view metadata supplies action coverage, not arbitrary saved-value read answers',()=>{
  const payload=fixture();
  for(const action of actions()){
    const result={crmAction:action},computed=Review.evidence(payload,result),context={pipeline:payload.pipeline,computed};
    const review={requirements:[{description:'Prepare requested operation',evidenceKind:'compiled_action',stepIds:['root'],requiredOutputs:[],satisfied:true}],issues:[],clarificationQuestion:null};
    assert.equal(Review.validateReview(review,result,context).ok,true);
    review.requirements[0].evidenceKind='computed_read';review.requirements[0].requiredOutputs=['fields'];
    assert.equal(Review.validateReview(review,result,context).ok,false);
    assert.throws(()=>Review.renderAnswer(payload,result,{...computed,status:'applied'}),/prepared saved-view or export preview/);
  }
  assert.match(Review.instructions,/never CSV contents or model-authored cell values/);
});
