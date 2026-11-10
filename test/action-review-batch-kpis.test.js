'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Lifecycle=require('../lib/action-lifecycle');
const F=require('./fixtures/workspace-plans.cjs'),Customize=require('../public/workspace-customization');
const condition=(field,operator,value=null)=>({field,operator,value});
function fixture(){
  const p={...F.workspace(),workspaceVersion:'v1',currentDate:'2026-11-10',visibleIds:[5]};
  p.records=p.records.slice(0,5).map((r,i)=>({...r,f_deal:i<4?'North '+i:'South',f_value:[0,20,null,100,900][i]}));
  const numeric={field:'f_value',conditions:[],where:[[condition('f_deal','starts_with','North')]]};
  p.tableSchema=Customize.addKpi(p.tableSchema,[],'kpi_user_review',{...numeric,title:'Existing',metric:'sum'}).tableSchema;
  const spec={version:1,title:'By stage',scope:'all',chart:'bar',groupBy:'f_stage',bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,measures:[{label:'Value',metric:'sum',field:'f_value',where:[]}]};
  p.dashboard={board:{version:1,elements:[{id:'by_stage',spec,visibleIds:[]}],sharedFilters:[],activeId:'by_stage'}};
  const action={action:'add_kpis',kpis:[{...numeric,title:'North midpoint',metric:'median'},
    {...numeric,title:'Overall mean',metric:'average',where:[]},
    {title:'North share',metric:'percentage',field:null,conditions:[],where:numeric.where,denominatorWhere:[]}]};
  const result={crmAction:action,assistantMessage:'Saved 99999.'},before=structuredClone(p);
  const computed=Review.evidence({pipeline:p},result),context={pipeline:p,computed};
  return {p,before,result,action,computed,context};
}
const req=(id,kind,...outputs)=>({description:'Requested outcome',stepIds:[id],requiredOutputs:outputs,evidenceKind:kind,satisfied:true});
const definition=id=>req(id,'compiled_action','kpi_definition');
const check=(f,...requirements)=>Review.validateReview({requirements,issues:[],clarificationQuestion:null},f.result,f.context);

test('batch evidence previews one mutation and renders each requested statistic from all authorized rows',()=>{
  const {p,before,result,computed:e}=fixture();
  assert.deepEqual(p,before);assert.equal(e.kpiChange.before,null);assert.equal(e.populationCount,5);
  assert.equal(e.lifecycle.operation,'mutation');assert.equal(e.lifecycle.requiresConfirmation,true);
  assert.equal(e.lifecycle.phase,'proposed');assert.equal(e.lifecycle.executed,false);assert.equal(e.lifecycle.writesApplied,0);
  assert.deepEqual(e.cards.map(c=>c.definition),e.kpiChange.after);
  assert.deepEqual(e.cards.map(c=>c.definition.id),['kpi_user_review_1','kpi_user_review_2','kpi_user_review_3']);
  assert.deepEqual(e.cards.map(c=>c.summary.value),[20,255,80]);assert.equal(e.cards[0].summary.numericCount,3);assert.equal(e.cards[0].summary.count,4);
  const text=Review.renderAnswer({pipeline:p},result,e);
  assert.match(text,/North midpoint: \$20\..*3 numeric values/);
  assert.match(text,/Overall mean: \$255\..*4 numeric values/);assert.match(text,/North share: 80%\. 4 \/ 5 records/);
  assert.match(text,/Confirm the entire batch/);assert.doesNotMatch(text,/99999/);
});

test('every batch definition maps to its distinct checked card; numbers cannot cross cards or stand in for definitions',()=>{
  const f=fixture(),ids=f.computed.cards.map(c=>c.stepId),defs=ids.map(definition);
  const allowed=Review.schemaFor(f.action,f.context).properties.requirements.items.properties.stepIds;
  assert.deepEqual(allowed.items.enum,[...ids,...f.computed.constraintEvidence.map(c=>c.id)]);assert.match(allowed.description,/each requested saved card separately/);
  assert(check(f,...defs,req(ids[0],'computed_read','median','count'),req(ids[1],'computed_read','average'),req(ids[2],'computed_read','percentages')).ok);
  for(const invalid of [req('root','compiled_action','kpi_definition'),req(ids[0],'computed_read','average'),req(ids[1],'computed_read','median'),
    req(ids[2],'computed_read','kpi_definition'),req(ids[2],'compiled_action','percentages'),req(ids[1],'computed_read'),{...definition(ids[0]),stepIds:ids}]){
    assert.equal(check(f,...defs,invalid).ok,false);
  }
  for(const missing of [[defs[0],defs[1],defs[1]],[...defs.slice(1),req(ids[0],'computed_read','median')]]){
    const outcome=check(f,...missing);assert.equal(outcome.ok,false);assert.match(outcome.mappingIssues.join(' '),/Missing distinct saved-card/);
  }
  assert(check(f,...defs,...[['lifecycle:preview_only','preview_only'],['unchanged:graph:by_stage','unchanged_graphs'],
    ['unchanged:kpi:kpi_user_review','unchanged_kpis'],['unchanged:records','unchanged_records'],['unchanged:tasks','unchanged_tasks']].map(([id,output])=>req(id,'constraint',output))).ok);
  for(const id of ids)assert(!allowed.items.enum.includes('unchanged:'+id));
  assert.equal(check(f,...defs,req(ids[0],'constraint','unchanged_kpis')).ok,false);
});

test('copied, stale, reordered or edited batch evidence cannot render answers or authorize review mappings',()=>{
  for(const change of [f=>f.context.computed=structuredClone(f.computed),f=>f.p.workspaceVersion='v2',f=>f.p.records[0].f_value=101,
    f=>f.action.kpis.reverse(),f=>f.computed.cards.reverse(),f=>f.computed.cards[0].summary.value=999,
    f=>f.computed.cards[1].stepId=f.computed.cards[0].stepId,f=>f.computed.cards[2].summary.summary='unverified']){
    const f=fixture(),defs=f.computed.cards.map(c=>definition(c.stepId));change(f);
    assert.equal(check(f,...defs).ok,false);
    assert.throws(()=>Review.renderAnswer({pipeline:f.p},f.result,f.context.computed),/canonical KPI/);
  }
});

test('invalid later cards reject the full batch; single median keeps legacy root evidence and numeric blank handling',()=>{
  const f=fixture(),kpi=f.action.kpis[0];
  for(const bad of [{...kpi,title:'Invalid field',field:'f_deal'},{...kpi},{title:'No scope',field:'f_value',metric:'median',conditions:[]}]){
    assert.throws(()=>Review.evidence({pipeline:f.p},{crmAction:{action:'add_kpis',kpis:[kpi,bad]}}));assert.deepEqual(f.p,f.before);
  }
  const result={crmAction:{action:'add_kpi',kpi}},payload={pipeline:f.p};
  for(const [values,expected] of [[[0,20,null,null],10],[[null,null,null,null],null]]){
    values.forEach((v,i)=>f.p.records[i].f_value=v);
    const computed=Review.evidence(payload,result),single={result,context:{pipeline:f.p,computed}};
    assert.equal(computed.summary.value,expected);assert(check(single,definition('root'),req('root','computed_read','median')).ok);
    assert(!check(single,req('root','computed_read','average')).ok);assert.match(Review.renderAnswer(payload,result,computed),expected===null?/Not set/:/\$10/);
  }
  assert.equal(Lifecycle.describe({action:'show_kpi'},{},'v1').requiresConfirmation,false);
});
