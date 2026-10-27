'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Diagnostic=require('../lib/compiler-diagnostic');
const Business=require('../public/business-workspace'),Views=require('../public/view-actions'),F=require('./fixtures/workspace-plans.cjs');
const Customize=require('../public/workspace-customization'),Dashboard=require('../public/dashboard-board'),Core=require('../public/pipeline-core');
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
const requirement=(evidenceKind,stepIds,requiredOutputs)=>({description:'Requested view outcome',evidenceKind,stepIds,requiredOutputs,satisfied:true});
const definition=()=>requirement('compiled_action',['root'],['view_definition']);
const constraint=(id,output)=>requirement('constraint',[id],[output]);
const review=requirements=>({requirements,issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null});
function prepared(action,payload=fixture()){
  const result={crmAction:action},computed=Review.evidence(payload,result);
  return {payload,result,context:{pipeline:payload.pipeline,computed}};
}
const check=(f,...requirements)=>Review.validateReview(review(requirements),f.result,f.context);
const allowedIds=f=>Review.schemaFor(f.result.crmAction,f.context).properties.requirements.items.properties.stepIds.items.enum;
function graphFixture(){
  const payload=fixture(),p=payload.pipeline;
  const spec=groupBy=>({version:1,title:'Value by '+groupBy,chart:'bar',scope:'all',groupBy,bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,
    measures:[{label:'Value',metric:'sum',field:'f_value',where:[]}]});
  p.workspaceVersion=7;p.timezone='UTC';
  p.dashboard={board:Dashboard.apply(null,{action:'dashboard_plan',operations:[
    {op:'add',id:'by_stage',spec:spec('f_stage')},{op:'add',id:'by_owner',spec:spec('f_owner')}
  ],questions:[]},p.records,Core.create(p.tableSchema),[],{today:p.currentDate,visibleIds:p.visibleIds}).board};
  return payload;
}

test('save/open/export use exact helper selections while whitelisting reviewer metadata',()=>{
  const payload=fixture(),before=structuredClone(payload);
  for(const action of actions()){
    const result={crmAction:action,assistantMessage:'Saved, opened and downloaded PRIVATE MODEL VALUES.'},computed=Review.evidence(payload,result);
    assert.equal(computed.kind,'view-preview');assert.equal(computed.operation,action.action);assert.equal(computed.status,'prepared');assert.equal(computed.count,2);
    assert.deepEqual(computed.selection.recordIds,action.action==='save_view'?[3,1]:[2,1]);
    assert.deepEqual(computed.columns,action.action==='export_records'?[{id:'f_notes',name:'Notes'},{id:'f_value',name:'Value'}]:[]);
    assert.deepEqual(Object.keys(computed).sort(),['columns','constraintEvidence','count','disclosure','kind','lifecycle','operation','selection','status']);
    assert.deepEqual(computed.constraintEvidence.map(item=>[item.id,item.output]),[
      ['lifecycle:preview_only','preview_only'],['unchanged:records','unchanged_records'],['unchanged:tasks','unchanged_tasks'],['unchanged:schema','unchanged_schema'],
      ...Customize.kpis(payload.pipeline.tableSchema,[]).map(kpi=>['unchanged:kpi:'+kpi.id,'unchanged_kpis'])
    ]);
    assert.deepEqual(Object.keys(computed.selection).sort(),['recordIds','source','viewId']);
    assert.equal(computed.lifecycle.executed,false);assert.equal(computed.lifecycle.writesApplied,0);
    const json=JSON.stringify(computed);assert.doesNotMatch(json,/PRIVATE|"artifact"|"body"|"rawCSV"|"commands"|"tableView"|"entityIds"|"filename"/i);
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
    return {...planned,privateValues:'PRIVATE EXTRA',rawCSV:'PRIVATE RAW CSV',artifact:{body:'PRIVATE CSV BODY',rawCSV:'PRIVATE NESTED CSV'},commands:[{private:'PRIVATE COMMAND'}]};
  };
  const payload=fixture();for(const action of actions())assert.doesNotMatch(JSON.stringify(Review.evidence(payload,{crmAction:action})),/PRIVATE|artifact|rawCSV|commands/i);
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

test('view definitions and separately requested counts have explicit root-only review contracts',()=>{
  for(const action of actions()){
    const f=prepared(action),properties=Review.schemaFor(action,f.context).properties.requirements.items.properties;
    assert(properties.requiredOutputs.items.enum.includes('view_definition'));
    assert.match(properties.stepIds.description,/compiled_action view_definition/);
    assert.match(properties.stepIds.description,/computed\.selection/);assert.match(properties.stepIds.description,/computed\.columns/);
    assert.deepEqual(allowedIds(f),['root',...f.context.computed.constraintEvidence.map(item=>item.id)]);
    assert.deepEqual(check(f,definition(),requirement('computed_read',['root'],['count'])),{ok:true,requested:2,compiled:2,mappingIssues:[]});
    assert.equal(check(f,requirement('compiled_action',['root'],['view_definition','count'])).ok,true);
    assert.equal(check(f,requirement('compiled_action',['root'],['count'])).ok,true);
    for(const kind of ['computed_read','constraint','conversation','clarification','unavailable']){
      assert.equal(check(f,requirement(kind,['root'],['view_definition'])).ok,false,action.action+' '+kind);
    }
    for(const stepIds of [[],['root','root'],['missing'],['root','lifecycle:preview_only'],['lifecycle:preview_only'],[viewId]]){
      assert.equal(check(f,requirement('compiled_action',stepIds,['view_definition'])).ok,false,JSON.stringify(stepIds));
    }
    for(const outputs of [null,{},'view_definition',['view_definition','view_definition'],['view_definition','count','count']]){
      assert.equal(check(f,requirement('compiled_action',['root'],outputs)).ok,false,JSON.stringify(outputs));
    }
    assert.equal(check(f,{...definition(),satisfied:false}).ok,false);
  }
  for(const text of [Review.instructions,Review.compilerInstructions]){
    assert.match(text,/view_definition at root/);assert.match(text,/not extra computed_read requirements/);
    assert.match(text,/not whether a saved-view definition itself changes business state/);
  }
});

test('selection and column metadata never substitute for record reads or empty computed outputs',()=>{
  for(const action of actions()){
    const f=prepared(action);
    for(const output of ['fields','names','sum','average','median','min','max','distinct','groups','percentages','history','notes','dependencies','kpi_definition']){
      for(const kind of ['computed_read','compiled_action']){
        assert.equal(check(f,requirement(kind,['root'],[output])).ok,false,action.action+' '+kind+' '+output);
        assert.equal(check(f,requirement(kind,['root'],['view_definition',output])).ok,false);
        assert.equal(check(f,requirement(kind,['root'],['count',output])).ok,false);
      }
    }
    for(const outputs of [[],undefined,null]){
      const result=check(f,definition(),requirement('computed_read',['root'],outputs));
      assert.equal(result.ok,false);assert.equal(result.compiled,1);assert.equal(result.mappingIssues.length,1);
      assert.match(result.mappingIssues[0],/compiled_action view_definition/);
    }
    assert.equal(Review.validateReview(review([definition()]),f.result).ok,false,'An action without compiled proof is not a view definition');
  }
  for(const action of [{action:'query_records',where:[]},{action:'add_kpi',kpiId:null,kpi:{title:'Count',metric:'count',field:null,conditions:[],where:[]}}]){
    assert.equal(Review.validateReview(review([definition()]),{crmAction:action},{pipeline:fixture().pipeline}).ok,false);
  }
});

test('view constraints preserve primary data and graphs without claiming the business save has no effect',()=>{
  for(const action of actions()){
    const payload=graphFixture(),before=structuredClone(payload),f=prepared(action,payload),e=f.context.computed;
    const constraints=[constraint('unchanged:records','unchanged_records'),constraint('unchanged:tasks','unchanged_tasks'),constraint('unchanged:schema','unchanged_schema'),
      ...Customize.kpis(payload.pipeline.tableSchema,[]).map(kpi=>constraint('unchanged:kpi:'+kpi.id,'unchanged_kpis')),
      ...['by_stage','by_owner'].map(id=>constraint('unchanged:graph:'+id,'unchanged_graphs')),constraint('lifecycle:preview_only','preview_only')];
    assert.equal(check(f,definition(),...constraints).ok,true);assert.deepEqual(payload,before);
    assert.equal(e.lifecycle.operation,{save_view:'mutation',open_view:'view',export_records:'read'}[action.action]);
    assert.equal(e.lifecycle.requiresConfirmation,action.action==='save_view');
    assert.equal(e.lifecycle.executed,false);assert.equal(e.lifecycle.writesApplied,0);
    assert(!allowedIds(f).some(id=>/business|unchanged:view/.test(id)));
    for(const item of constraints){
      assert.equal(check(f,{...item,stepIds:['root']}).ok,false);
      assert.equal(check(f,requirement('compiled_action',item.stepIds,['view_definition'])).ok,false);
      assert.equal(check(f,requirement('computed_read',item.stepIds,['count'])).ok,false);
    }
    assert.equal(check(f,constraint('unchanged:business','unchanged_records')).ok,false);
    assert.equal(check(f,constraint('unchanged:views','unchanged_schema')).ok,false);
    assert.equal(check(f,requirement('constraint',['unchanged:records'],['unchanged_records','view_definition'])).ok,false);
  }
});

test('view definition, count and preservation reject copied, tampered or stale source-bound evidence',()=>{
  const mutations=[
    ['copied evidence',f=>f.context.computed=structuredClone(f.context.computed)],
    ['shallow copied evidence',f=>f.context.computed={...f.context.computed}],
    ['copied source',f=>f.context.pipeline=structuredClone(f.context.pipeline)],
    ['missing evidence',f=>delete f.context.computed],
    ['changed action',f=>f.result.crmAction.selection={source:'all'}],
    ['changed count',f=>f.context.computed.count++],
    ['changed ordering',f=>f.context.computed.selection.recordIds.reverse()],
    ['changed columns',f=>f.context.computed.columns.push({id:'f_deal',name:'Fabricated'})],
    ['changed disclosure',f=>f.context.computed.disclosure='Already saved'],
    ['executed lifecycle',f=>f.context.computed.lifecycle.executed=true],
    ['tampered constraint',f=>f.context.computed.constraintEvidence[0].writesApplied=1],
    ['new version',f=>f.context.pipeline.workspaceVersion++],
    ['edited cell',f=>f.context.pipeline.records[0].f_value++],
    ['changed table order',f=>f.context.pipeline.visibleIds.reverse()],
    ['changed schema',f=>f.context.pipeline.tableSchema.columnOrder.reverse()],
    ['changed tasks',f=>f.context.pipeline.todoCards.push({id:'new_task'})],
    ['changed graph',f=>f.context.pipeline.dashboard.board.elements[0].spec.title='Renamed'],
    ['changed graph order',f=>f.context.pipeline.dashboard.board.elements.reverse()],
    ['changed workspace',f=>f.context.pipeline.business.workspaceId='22222222-2222-4222-8222-222222222222'],
    ['removed saved view',f=>f.context.pipeline.business.state.views=[]],
    ['changed membership',f=>f.context.pipeline.business.state.views[0].entityIds=[Business.legacyId(workspaceId,3)]],
    ['reordered membership',f=>f.context.pipeline.business.state.views[0].entityIds.reverse()],
    ['renamed saved view',f=>f.context.pipeline.business.state.views[0].name='Renamed view']
  ];
  for(const original of actions())for(const [label,mutate] of mutations){
    const f=prepared(structuredClone(original),graphFixture());assert.equal(check(f,definition()).ok,true);mutate(f);
    assert.equal(check(f,definition()).ok,false,original.action+' '+label);
    assert.equal(check(f,requirement('computed_read',['root'],['count'])).ok,false,original.action+' count '+label);
    assert.equal(check(f,requirement('compiled_action',['root'],[])).ok,false,original.action+' untyped '+label);
    assert.equal(check(f,constraint('unchanged:records','unchanged_records')).ok,false,original.action+' constraint '+label);
    assert(!allowedIds(f).includes('unchanged:records'));
  }
});

test('reused saved-view names require fresh identity resolution and cannot reuse prior proof',()=>{
  const replacementId='view_44444444-4444-4444-8444-444444444444';
  for(const action of actions().slice(1)){
    action.selection={source:'saved_view',viewName:'Existing view'};
    const f=prepared(action);assert.equal(f.context.computed.selection.viewId,viewId);
    f.context.pipeline.business.state.views=[{id:replacementId,name:'Existing view',entityIds:[Business.legacyId(workspaceId,3)]}];
    assert.equal(check(f,definition()).ok,false);assert.equal(check(f,requirement('computed_read',['root'],['count'])).ok,false);
    const fresh=prepared(action,f.payload);assert.equal(check(fresh,definition()).ok,true);
    assert.equal(fresh.context.computed.selection.viewId,replacementId);assert.deepEqual(fresh.context.computed.selection.recordIds,[3]);
    f.context.pipeline.business.state.views.push({id:viewId,name:'Existing view',entityIds:[Business.legacyId(workspaceId,1)]});
    assert.equal(check(fresh,definition()).ok,false);
    assert.throws(()=>Review.evidence(f.payload,f.result),error=>error.reasonCode==='view_name_ambiguous');
  }
  const action=actions()[0],f=prepared(action);
  f.context.pipeline.business.state.views.push({id:replacementId,name:action.name,entityIds:[Business.legacyId(workspaceId,3)]});
  assert.equal(check(f,definition()).ok,false);
  assert.throws(()=>Review.evidence(f.payload,f.result),error=>error.reasonCode==='view_name_conflict');
});
