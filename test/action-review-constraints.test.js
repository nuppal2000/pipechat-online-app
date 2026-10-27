'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Dashboard=require('../public/dashboard-board'),Core=require('../public/pipeline-core');
const Customize=require('../public/workspace-customization'),F=require('./fixtures/workspace-plans.cjs');
const condition=(field,operator,value=null)=>({field,operator,value});
const graphIds=['deal_value_by_stage','deal_value_by_owner'];
const graph=id=>'unchanged:graph:'+id;
const spec=groupBy=>({version:1,title:'Value by '+groupBy,chart:'bar',scope:'all',groupBy,bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,
  measures:[{label:'Deal value',metric:'sum',field:'f_value',where:[]}]});
function pipeline(){
  const p={...F.workspace(),visibleIds:[49],currentDate:'2026-10-26',timezone:'UTC',workspaceVersion:70};
  p.records=Array.from({length:49},(_,i)=>({...p.records[0],id:i+1,f_deal:i<4?'QA26 '+['Alpha','Beta','Gamma','Delta'][i]:i===4?'Embedded QA26':'Other '+i,
    f_value:i<4?[10000,20000,0,4000][i]:90000,f_follow:i<25?'':'2026-11-01'}));
  p.dashboard={board:Dashboard.apply(null,{action:'dashboard_plan',operations:graphIds.map((id,i)=>({op:'add',id,spec:spec(i?'f_owner':'f_stage')})),questions:[]},p.records,Core.create(p.tableSchema),[],{today:p.currentDate,visibleIds:p.visibleIds}).board};
  return p;
}
const average=()=>({title:'QA26 average',metric:'average',field:'f_value',conditions:[],where:[[condition('f_deal','starts_with','QA26')]]});
const add=()=>({action:'add_kpi',kpiId:null,kpi:average()});
function fixture(action=add(),p=pipeline()){
  const result={crmAction:action,assistantMessage:'Untrusted proposal: saved 99999.'},computed=Review.evidence({pipeline:p},result);
  return {result,context:{pipeline:p,computed}};
}
const requirement=(evidenceKind,stepIds,requiredOutputs,description='Requested outcome')=>({description,evidenceKind,stepIds,requiredOutputs,satisfied:true});
const constraint=(id,output)=>requirement('constraint',[id],[output]);
const review=requirements=>({requirements,issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null});
const check=(f,...requirements)=>Review.validateReview(review(requirements),f.result,f.context);
const ids=f=>Review.schemaFor(f.result.crmAction,f.context).properties.requirements.items.properties.stepIds.items.enum;

test('F06 compound prefix KPI plus both existing graphs has four explicit supported outcomes',()=>{
  const p=pipeline(),before=structuredClone(p),f=fixture(add(),p),e=f.context.computed;
  const requirements=[requirement('compiled_action',['root'],['kpi_definition'],'Add the named prefix average KPI'),
    requirement('computed_read',['root'],['average'],'Average the requested deal values including zero'),
    ...graphIds.map(id=>constraint(graph(id),'unchanged_graphs'))];
  assert.deepEqual(check(f,...requirements),{ok:true,requested:4,compiled:4,mappingIssues:[]});
  assert.equal(e.populationCount,49);assert.equal(e.summary.value,8500);assert.equal(e.summary.count,4);assert.equal(e.summary.numericCount,4);
  assert.equal(e.kpiChange.after.where[0][0].operator,'starts_with');assert(graphIds.every(id=>ids(f).includes(graph(id))));
  assert.match(Review.renderAnswer({pipeline:p},f.result,e),/\$8,500.*4 matching records; 4 numeric values/);
  assert.deepEqual(p,before);assert.equal(e.lifecycle.executed,false);
  // Existing clients may still classify preservation as computed evidence.
  assert.equal(check(f,requirement('computed_read',graphIds.map(graph),['unchanged_graphs'])).ok,true);
  assert.equal(check(f,constraint('unchanged:records','unchanged_records'),constraint('unchanged:tasks','unchanged_tasks')).ok,true);
  for(const prefix of ['qa26',' QA26 ']){
    const action=add();action.kpi.where[0][0].value=prefix;
    assert.equal(fixture(action).context.computed.summary.value,8500);
  }
});

test('KPI definition and numeric outputs remain typed; predicates are not arbitrary names or field projections',()=>{
  for(const [metric,field,output] of [['count',null,'count'],['sum','f_value','sum'],['average','f_value','average'],['percentage',null,'percentages']]){
    const kpi={...average(),metric,field,...(metric==='percentage'?{where:[[condition('f_follow','is_blank')]],denominatorWhere:[]}: {})};
    const f=fixture({action:'add_kpi',kpiId:null,kpi});
    assert.equal(check(f,requirement('compiled_action',['root'],['kpi_definition'])).ok,true);
    assert.equal(check(f,requirement('computed_read',['root'],[output])).ok,true);
    if(metric==='percentage'){assert.equal(f.context.computed.summary.value,25/49*100);assert.equal(f.context.computed.summary.denominatorCount,49);}
    for(const missing of ['names','fields','median','groups','separate_graphs','dependencies'])assert.equal(check(f,requirement('computed_read',['root'],[missing])).ok,false);
    assert.equal(check(f,requirement('computed_read',['root'],['kpi_definition'])).ok,false);
    assert.equal(check(f,requirement('constraint',['root'],['kpi_definition'])).ok,false);
    assert.equal(check(f,requirement('compiled_action',['root'],['kpi_definition',output])).ok,true);
  }
  const p=pipeline();p.tableSchema=Customize.addKpi(p.tableSchema,[],'kpi_user_existing',average()).tableSchema;
  for(const action of [{action:'configure_kpi',kpiId:'kpi_user_existing',kpi:{...average(),title:'Changed average'}},{action:'delete_kpi',kpiId:'kpi_user_existing',kpi:null}]){
    const f=fixture(action,p);assert.equal(check(f,requirement('compiled_action',['root'],['kpi_definition'])).ok,true);
    assert.equal(check(f,...graphIds.map(id=>constraint(graph(id),'unchanged_graphs'))).ok,true);
    assert(!ids(f).includes('unchanged:kpi:kpi_user_existing'));assert(ids(f).includes('unchanged:kpi:kpi_records'));
    if(action.action==='delete_kpi')assert.equal(check(f,requirement('computed_read',['root'],['count'])).ok,false);
  }
});

test('delete only QA26 average preserves the percentage KPI definition and both graphs',()=>{
  const p=pipeline(),averageId='kpi_user_qa26',percentageId='kpi_user_missing';
  p.tableSchema=Customize.addKpi(p.tableSchema,[],averageId,average()).tableSchema;
  p.tableSchema=Customize.addKpi(p.tableSchema,[],percentageId,{title:'Missing follow-up percent',metric:'percentage',field:null,conditions:[],
    where:[[condition('f_follow','is_blank')]],denominatorWhere:[]}).tableSchema;
  const before=structuredClone(p),f=fixture({action:'delete_kpi',kpiId:averageId,kpi:null},p);
  const requested=[requirement('compiled_action',['root'],['kpi_definition'],'Delete only QA26 average'),
    constraint('unchanged:kpi:'+percentageId,'unchanged_kpis'),...graphIds.map(id=>constraint(graph(id),'unchanged_graphs'))];
  assert.deepEqual(check(f,...requested),{ok:true,requested:4,compiled:4,mappingIssues:[]});
  const change=f.context.computed.kpiChange;
  assert.equal(change.before.id,averageId);assert.equal(change.before.title,'QA26 average');
  assert(!change.tableSchema.kpis.some(kpi=>kpi.id===averageId));
  assert.deepEqual(change.tableSchema.kpis.find(kpi=>kpi.id===percentageId),p.tableSchema.kpis.find(kpi=>kpi.id===percentageId));
  assert.deepEqual(p,before);assert(!ids(f).includes('unchanged:kpi:'+averageId));
  assert.match(Review.renderAnswer({pipeline:p},f.result,f.context.computed),/Review removal of KPI "QA26 average".*No KPI has been deleted/);
  assert.equal(check(f,requirement('computed_read',['root'],['percentages'])).ok,false);
  assert.equal(check(f,constraint('root','unchanged_kpis')).ok,false);
  const wrong=fixture({action:'delete_kpi',kpiId:percentageId,kpi:null},p);
  assert.equal(check(wrong,...requested).ok,false);
});

test('preservation cannot borrow root, ordinary graphs, numerical outputs or unknown identities',()=>{
  const f=fixture();
  for(const stepIds of [[],['root'],['graph:'+graphIds[0]],['unchanged:graph:missing'],[graph(graphIds[0]),'root'],[graph(graphIds[0]),graph(graphIds[0])]]){
    assert.equal(check(f,requirement('constraint',stepIds,['unchanged_graphs'])).ok,false,JSON.stringify(stepIds));
  }
  for(const outputs of [[],['count'],['average'],['unchanged_graphs','average'],['kpi_definition'],['unchanged_records'],['separate_graphs']]){
    assert.equal(check(f,requirement('constraint',[graph(graphIds[0])],outputs)).ok,false,JSON.stringify(outputs));
    assert.equal(check(f,requirement('compiled_action',[graph(graphIds[0])],outputs)).ok,false,JSON.stringify(outputs));
  }
  const missing=requirement('computed_read',['root'],['names']);
  assert.equal(check(f,constraint('lifecycle:preview_only','preview_only'),missing).ok,false);
  assert.equal(check(f,{...constraint(graph(graphIds[0]),'unchanged_graphs'),satisfied:false}).ok,false);
  const empty=pipeline();empty.dashboard.board=Dashboard.empty();assert(!ids(fixture(add(),empty)).some(id=>id.startsWith('unchanged:graph:')));
});

test('constraint proofs reject copied objects, changed actions, result edits and every relevant source change',()=>{
  const requested=constraint(graph(graphIds[0]),'unchanged_graphs');
  for(const mutate of [
    f=>f.context.computed=structuredClone(f.context.computed),f=>f.context.pipeline=structuredClone(f.context.pipeline),
    f=>f.result.crmAction.kpi.title='Different',f=>f.context.computed.summary.value=99999,
    f=>f.context.computed.constraintEvidence[0].writesApplied=1,f=>f.context.computed.lifecycle.executed=true,
    f=>f.context.pipeline.workspaceVersion++,f=>f.context.pipeline.records[0].f_value++,
    f=>f.context.pipeline.visibleIds=[1],f=>f.context.pipeline.dashboard.board.elements.reverse(),
    f=>f.context.pipeline.dashboard.board.elements[0].spec.title='Renamed',
    f=>f.context.pipeline.dashboard.board.elements[0].visibleIds=[3],
    f=>f.context.pipeline.dashboard.board.sharedFilters.push({id:'new_filter',targets:[graphIds[0]],where:[[F.where('f_owner','equals','Alex')]]})
  ]){
    const f=fixture();mutate(f);assert.equal(check(f,requested).ok,false);
    assert(!ids(f).includes(requested.stepIds[0]));
  }
  const f=fixture();f.context.computed.constraintEvidence.push({id:'unchanged:graph:invented',output:'unchanged_graphs'});
  assert.equal(check(f,constraint('unchanged:graph:invented','unchanged_graphs')).ok,false);
  const raw={result:f.result,context:{pipeline:f.context.pipeline,computed:{constraintEvidence:[requested]}}};
  assert.equal(check(raw,requested).ok,false);
});

function juniperPlan(extra=[]){
  return F.plan([F.select('juniper',[[F.where('f_deal','in',null,['Juniper Alpha','Juniper Beta'])]]),
    F.update('followup','juniper','f_follow','2026-10-29'),...extra]);
}
function juniperPipeline(){const p=pipeline();p.records[0].f_deal='Juniper Alpha';p.records[1].f_deal='Juniper Beta';return p;}
test('resolved plural cohort maps to its update, while preview and outside-cohort preservation have explicit IDs',()=>{
  const f=fixture(juniperPlan(),juniperPipeline()),e=f.context.computed;
  assert.deepEqual(e.review.find(step=>step.id==='juniper').records.map(row=>row.id),[1,2]);
  assert.deepEqual(e.patches.map(row=>row.id),[1,2]);assert.equal(e.mutates,true);
  const requested=[requirement('compiled_action',['followup'],[],'Update both resolved deals'),
    constraint('lifecycle:preview_only','preview_only'),constraint('unchanged:records:outside:juniper','unchanged_records'),constraint('unchanged:schema','unchanged_schema')];
  assert.equal(check(f,...requested).ok,true);assert(!ids(f).includes('unchanged:records'));
  const broken=check(f,...requested.slice(0,1),{...requested[1],stepIds:[]});
  assert.equal(broken.ok,false);assert.equal(broken.mappingReasons.missing_step_ids,1);assert.match(broken.mappingIssues[0],/exact source-bound ID/);
  for(const [kind,output] of [['computed_read','count'],['computed_read','names'],['compiled_action','per_record_percentage'],['compiled_action','kpi_definition']]){
    assert.equal(check(f,requirement(kind,['lifecycle:preview_only'],[output])).ok,false);
  }
  assert.equal(check(f,requirement('constraint',['followup'],[])).ok,false);
  assert.equal(check(f,requirement('computed_read',['juniper'],['names'])).ok,false);
  const p=juniperPipeline();p.records[0].f_follow=p.records[1].f_follow='2026-10-29';
  const noOp=fixture(juniperPlan(),p);assert.equal(noOp.context.computed.mutates,false);
  assert.equal(check(noOp,requested[0],constraint('unchanged:records','unchanged_records')).ok,true);
});

test('outside-selection, schema and graph proofs reflect the complete final plan, not an intermediate update',()=>{
  const other=[F.select('others',[[F.where('f_deal','equals','Other 6')]]),F.update('change_other','others','f_value',123)];
  const f=fixture(juniperPlan(other),juniperPipeline());
  assert(!ids(f).includes('unchanged:records:outside:juniper'));assert.equal(check(f,constraint('unchanged:records:outside:juniper','unchanged_records')).ok,false);
  const renamed=fixture(F.plan([{op:'rename_choice_option',id:'rename',label:'Rename stage',field:'f_stage',from:'Qualified',to:'Qualified renamed'}]));
  assert(!ids(renamed).includes('unchanged:schema'));
  const changedGraph=pipeline();changedGraph.dashboard.board.elements[0].spec.where=[[F.where('f_stage','equals','Qualified')]];
  const action=F.plan([{op:'rename_choice_option',id:'rename',label:'Rename stage',field:'f_stage',from:'Qualified',to:'Qualified renamed'}]);
  const changed=fixture(action,changedGraph);
  assert(!ids(changed).includes(graph(graphIds[0])));assert(ids(changed).includes(graph(graphIds[1])));
  assert.equal(check(changed,constraint(graph(graphIds[0]),'unchanged_graphs')).ok,false);
});

test('record preservation compares the same hydrated history snapshot used by plan preparation',()=>{
  const p=juniperPipeline();p.recordHistories=new Map([[3,['Existing saved note']]]);
  const f=fixture(juniperPlan(),p);
  assert.equal(check(f,constraint('unchanged:records:outside:juniper','unchanged_records')).ok,true);
  assert(!ids(f).includes('unchanged:records'));
  p.records[0].f_follow=p.records[1].f_follow='2026-10-29';
  const unchanged=fixture(juniperPlan(),p);
  assert.equal(check(unchanged,constraint('unchanged:records','unchanged_records')).ok,true);
  p.recordHistories.get(3).push('Later note');
  assert.equal(check(unchanged,constraint('unchanged:records','unchanged_records')).ok,false);
});

test('missing or malformed canonical selection review never creates outside-selection proofs',()=>{
  const Plan=require('../public/workspace-plan'),prepare=Plan.prepare;
  const corruptions=[()=>null,()=>({}),()=>[],items=>items.filter(item=>item.op!=='select_records'),
    items=>items.map(item=>item.op==='select_records'?{...item,records:null}:item),
    items=>items.map(item=>item.op==='select_records'?{...item,records:[null]}:item),
    items=>items.map(item=>item.op==='select_records'?{...item,records:[{id:999999}]}:item),
    items=>items.map(item=>item.op==='select_records'?{...item,records:[item.records[0],item.records[0]]}:item),
    items=>[...items,items.find(item=>item.op==='select_records')]];
  try{
    for(const corrupt of corruptions){
      Plan.prepare=(...args)=>{const result=prepare(...args);result.review=corrupt(result.review);return result;};
      const f=fixture(juniperPlan(),juniperPipeline());
      assert(!ids(f).includes('unchanged:records:outside:juniper'));
      assert.equal(check(f,constraint('unchanged:records:outside:juniper','unchanged_records')).ok,false);
    }
  }finally{Plan.prepare=prepare;}
});

test('graph proofs use the final displayed report board and effect constraints cannot substitute for writes',()=>{
  const report=showDashboard=>({op:'report',id:'replacement',label:'Replacement report',selection:null,spec:spec('f_stage'),questions:[],showDashboard});
  const dashboard={op:'dashboard',id:'retained',label:'Append graph',plan:{action:'dashboard_plan',operations:[{op:'add',id:'intermediate',spec:spec('f_stage')}],questions:[]}};
  for(const steps of [[report(true)],[dashboard,report(true)]]){
    const f=fixture(F.plan(steps));
    assert(!ids(f).some(id=>id.includes('unchanged:graph:')));
    assert.equal(check(f,...graphIds.map(id=>constraint(graph(id),'unchanged_graphs'))).ok,false);
  }
  const answerOnly=fixture(F.plan([report(false)]));
  assert.equal(check(answerOnly,...graphIds.map(id=>constraint(graph(id),'unchanged_graphs'))).ok,true);
  const task=fixture(F.plan([{op:'add_unlinked_task',id:'task',label:'Add task',customTitle:'Requested task',status:'To Do',nextAction:'Call',notes:'',dueDate:null}]));
  assert(!ids(task).includes('unchanged:tasks'));
  assert.equal(check(task,constraint('unchanged:tasks','unchanged_tasks')).ok,false);
  assert.equal(check(task,constraint('lifecycle:preview_only','preview_only')).ok,true);
  assert.equal(check(task,requirement('compiled_action',['lifecycle:preview_only'],[])).ok,false);
});

test('review schema, repair guidance and diagnostics expose bounded explicit constraints without weakening failures',()=>{
  const f=fixture(),s=Review.schemaFor(f.result.crmAction,f.context),req=s.properties.requirements.items.properties;
  assert(req.evidenceKind.enum.includes('constraint'));assert(req.requiredOutputs.items.enum.includes('kpi_definition'));
  assert(req.requiredOutputs.items.enum.includes('preview_only'));assert.match(req.stepIds.description,/Constraint evidence/);
  for(const text of [Review.instructions,Review.compilerInstructions]){
    assert.match(text,/both\/all named-record clarification/);assert.match(text,/never a shortcut for a missing read/);
    assert.match(text,/saved KPI proposal can retain existing dashboard graphs without any dashboard_plan/);
  }
  const coverage=check(f,requirement('constraint',[],['preview_only'],'Private Juniper detail'));
  const diagnostic=Review.validationDiagnostic({attempt:0,stage:'mapping',review:review([constraint('root','unchanged_graphs')]),coverage,action:f.result.crmAction});
  assert.equal(coverage.ok,false);assert.equal(coverage.mappingReasons.missing_step_ids,1);
  assert.doesNotMatch(JSON.stringify(diagnostic),/Juniper|QA26|8500|unchanged:graph|Private/);
  assert.doesNotThrow(()=>check(f,requirement('computed_read',undefined,['average'])));
  for(const malformed of [null,{},'average',42])assert.equal(check(f,requirement('computed_read',['root'],malformed)).ok,false);
});
