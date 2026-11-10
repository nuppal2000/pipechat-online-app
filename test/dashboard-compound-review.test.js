'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Read=require('../lib/read-output-contract'),F=require('./fixtures/workspace-plans.cjs');
const graph=id=>'graph:'+id,keep=id=>'unchanged:graph:'+id,cards='unchanged:kpis';
const add=(id,metric,groupBy=null)=>({op:'add',id,spec:{version:1,title:'PRIVATE title',chart:groupBy?'bar':'kpi',
  scope:'all',groupBy,splitBy:null,bucket:'none',limit:null,sort:'label_asc',where:[],
  measures:[{label:'PRIVATE measure',metric,field:metric==='count'?null:'f_value',where:[]}]}});
const plan=(...operations)=>({action:'dashboard_plan',operations,questions:[],requestScope:{scope:'all',where:[[F.where('f_deal','starts_with','QA1105')]]}});
const initial=()=>plan(add('stage','sum','f_stage'),add('mean','average'));
const nested=(id,plan)=>({op:'dashboard',id,label:'Display',plan});
function fixture(action=initial(),p={...F.workspace(),currentDate:'2026-11-05'}){
  const result={crmAction:action,assistantMessage:'PRIVATE planner claim'},computed=Review.evidence({pipeline:p},result);
  return {result,context:{pipeline:p,computed}};
}
const req=(stepIds,requiredOutputs,evidenceKind='computed_read')=>({stepIds,requiredOutputs,evidenceKind,satisfied:true,description:'PRIVATE description'});
const check=(f,...requirements)=>Review.validateReview({requirements,issues:[],clarificationQuestion:null},f.result,f.context);
const layout=['sum','groups','average','scalar_kpi','separate_widgets'];
for(const wrapped of [false,true])test('F04v compound stage total, scalar average, layout and unchanged saved cards: '+(wrapped?'nested':'direct'),()=>{
  const a=initial(),f=fixture(wrapped?F.plan([nested('plots',a)]):a),prefix=wrapped?'plots/':'',ids=['stage','mean'].map(id=>prefix+graph(id));
  const proofs=f.context.computed.constraintEvidence,all=proofs.find(p=>p.id===cards),individual=proofs.filter(p=>p.kpiId).map(p=>p.id);
  assert.equal(all.scope,'all_saved_kpis');assert.equal(all.count,individual.length);
  for(const preservation of [[cards],individual]){
    for(const kind of ['computed_read','compiled_action','constraint']){
      assert.equal(check(f,req([...ids,...preservation],[...layout,'unchanged_kpis'],kind)).ok,true);
    }
  }
  assert.equal(Read.supports(f.result.crmAction,ids,layout,f.context),true);
  assert.equal(check(f,req(ids,['average','scalar_kpi','separate_widgets'])).ok,true);
  assert.equal(check(f,req([ids[1],cards],['average','scalar_kpi','unchanged_kpis'])).ok,true);
  for(const [references,outputs] of [
    [ids,[...layout,'unchanged_kpis']],[[...ids,cards],layout],[[ids[0],cards],['average','unchanged_kpis']],
    [[...ids,cards],['median','scalar_kpi','separate_widgets','unchanged_kpis']],[[...ids,cards],['fields','unchanged_kpis']],
    [[...ids,cards],['kpi_definition','unchanged_kpis']],[[...ids,cards],['separate_graphs','unchanged_kpis']],
    [[...ids,cards],['count','scalar_kpi','separate_widgets','unchanged_kpis']],[[cards],'average'],
    [[...ids,cards,'root'],[...layout,'unchanged_kpis']],[[...ids,cards,cards],[...layout,'unchanged_kpis']],
    [[...ids,'unchanged:kpi:unknown'],[...layout,'unchanged_kpis']]
  ])assert.equal(check(f,req(references,outputs)).ok,false,JSON.stringify([references,outputs]));
});

test('wrong scalar metric cannot borrow the average computed by its neighboring chart',()=>{
  const f=fixture(plan(add('stage','average','f_stage'),add('indicator','sum')));
  assert.equal(check(f,req([graph('stage'),graph('indicator'),cards],['average','scalar_kpi','separate_widgets','unchanged_kpis'])).ok,false);
});

test('F08 incremental: compare retained stage chart and KPI with newly added owner averages',()=>{
  const previous=fixture(),p={...previous.context.pipeline,dashboard:{board:previous.context.computed.board}};
  const a=plan(add('owners','average','f_owner')),f=fixture(a,p),kept=[keep('stage'),keep('mean')],ids=[graph('owners'),...kept];
  const outputs=['groups','average','separate_widgets','unchanged_graphs'];
  assert.equal(check(f,req(ids,outputs)).ok,true);
  assert.equal(check(f,req([...ids,graph('stage'),graph('mean')],outputs)).ok,true);
  assert.equal(check(f,req(kept,['unchanged_graphs','separate_widgets'])).ok,true);
  assert.equal(check(f,req([graph('mean'),keep('mean')],['unchanged_graphs','separate_widgets'])).ok,false,'same member cited twice');
  assert.equal(check(f,req(kept,['unchanged_graphs','average'])).ok,false);
  assert.equal(check(f,req([...ids,cards],[...outputs,'unchanged_kpis'])).ok,true);
  assert.equal(check(f,req(ids,['groups','average','separate_graphs','unchanged_graphs'])).ok,false);
  assert.equal(check(f,req([graph('stage'),graph('mean'),graph('owners')],['separate_graphs'])).ok,false);
  assert.equal(check(f,req([graph('owners'),keep('owners'),keep('mean')],outputs)).ok,false);
  const wrong=fixture(plan(add('owners','sum','f_owner')),p);
  assert.equal(check(wrong,req(ids,outputs)).ok,false,'the retained KPI cannot supply the new chart metric');
  assert.equal(check(wrong,req([...ids,graph('mean')],['average','unchanged_graphs','separate_widgets'])).ok,false);
  // The exact same element IDs in an earlier workspace layout are not final.
  const replaced=fixture(F.plan([nested('old',a),nested('final',plan({op:'clear'},...initial().operations))]),p);
  assert.equal(check(replaced,req(['old/graph:owners',cards],['average','unchanged_kpis'])).ok,false);
});

test('mixed mappings reject stale, copied, or edited evidence, and noncanonical claims',()=>{
  const ids=[graph('stage'),graph('mean'),cards],r=req(ids,[...layout,'unchanged_kpis']);
  for(const change of [
    f=>f.context.computed=structuredClone(f.context.computed),f=>f.context.pipeline=structuredClone(f.context.pipeline),
    f=>f.context.pipeline.records[0].f_value++,f=>f.context.pipeline.tableSchema.fields[0].name='PRIVATE changed',
    f=>f.result.crmAction.operations[0].spec.title='PRIVATE other',
    f=>f.context.computed.displayEvidence.elements[0].outputs.push('median'),f=>f.context.computed.constraintEvidence.pop()
  ]){
    const f=fixture();assert.equal(check(f,r).ok,true);change(f);assert.equal(check(f,r).ok,false);
  }
  const f=fixture();
  assert.equal(check(f,{...r,satisfied:false}).ok,false);
  for(const kind of ['conversation','clarification','unavailable'])assert.equal(check(f,{...r,evidenceKind:kind}).ok,false);
});

test('diagnostics expose only bounded enum pairs for failed dashboard mappings',()=>{
  const f=fixture(),action=f.result.crmAction,good=req([graph('stage')],['groups','sum']);
  const bad=req(['PRIVATE fake ID'],['median','PRIVATE unknown output','median']);
  const requirements=[good,{...bad,evidenceKind:'PRIVATE kind'},...Array(10).fill(bad)],review={requirements,issues:[],clarificationQuestion:null};
  const coverage=Review.validateReview(review,f.result,f.context);
  const log=(stage='mapping',args={})=>Review.validationDiagnostic({stage,review,coverage,action,...args});
  assert.equal(coverage.compiled,1);assert.deepEqual(log().failedDashboardMappings,Array(8).fill({evidenceKind:'computed_read',requiredOutputs:['median']}));
  assert.doesNotMatch(JSON.stringify(log()),/PRIVATE|graph:|QA1105|description|stage_counts/);
  for(const stage of ['response','evidence','review'])assert.equal(log(stage).failedDashboardMappings,undefined);
  assert.equal(log('mapping',{coverage:{...coverage,failedDashboardMappings:[bad]}}).failedDashboardMappings,undefined);
  assert.equal(log('mapping',{coverage:check(f,good)}).failedDashboardMappings,undefined);
  const other=fixture({action:'show_kpi',title:'PRIVATE',scope:'all',where:[],measures:action.operations[1].spec.measures});
  assert.equal(log('mapping',{action:other.result.crmAction,coverage:check(other,bad)}).failedDashboardMappings,undefined);
});
