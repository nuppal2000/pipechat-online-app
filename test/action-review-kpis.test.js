'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Customize=require('../public/workspace-customization'),F=require('./fixtures/workspace-plans.cjs');
const c=(field,operator,value=null)=>({field,operator,value});
function fixture(){
  const pipeline=F.workspace();pipeline.records=pipeline.records.slice(0,5).map((row,i)=>({...row,f_deal:['North A','North B','North C','North D','Other'][i],f_value:[10000,20000,0,4000,90000][i],f_follow:i<2?'2026-10-27':''}));
  return {pipeline:{...pipeline,visibleIds:[5],currentDate:'2026-10-26'}};
}
const average=()=>({title:'Selected average',metric:'average',field:'f_value',conditions:[],where:['North A','North B','North C','North D'].map(name=>[c('f_deal','equals',name)])});
const percentage=()=>({title:'Missing follow-up share',metric:'percentage',field:null,conditions:[],where:[[c('f_follow','is_blank')]],denominatorWhere:[]});
const add=kpi=>({action:'add_kpi',kpiId:null,kpi});
const review=(kind,outputs=[])=>({requirements:[{description:'Requested KPI outcome',evidenceKind:kind,stepIds:['root'],requiredOutputs:outputs,satisfied:true}],issues:[],clarificationQuestion:null});
const coverage=(payload,result,computed,kind,outputs=[])=>Review.validateReview(review(kind,outputs),result,{pipeline:payload.pipeline,computed});

test('KPI union preview uses the full authorized population, not visible rows or planner prose',()=>{
  const payload=fixture(),before=structuredClone(payload),result={crmAction:add(average()),assistantMessage:'Saved! Average $99,999 from 99 records.'};
  const computed=Review.evidence(payload,result),s=computed.summary;
  assert.equal(computed.kind,'kpi-preview');assert.equal(computed.population,'all_authorized_records');assert.equal(computed.populationCount,5);
  assert.equal(s.value,8500);assert.equal(s.count,4);assert.equal(s.numericCount,4);assert.equal(s.displayValue,'$8,500');
  assert.match(s.definition,/ OR /);assert.equal(computed.kpiChange.before,null);assert.equal(computed.kpiChange.after.metric,'average');
  assert.equal(computed.lifecycle.executed,false);assert.equal(computed.lifecycle.writesApplied,0);assert.deepEqual(payload,before);
  const answer=Review.renderAnswer(payload,result,computed);assert.match(answer,/4 matching records; 4 numeric values/);assert.match(answer,/\$8,500/);assert.doesNotMatch(answer,/Saved!|99,999|99 records/);
  assert.match(answer,/No KPI or record changes have been saved/);assert.equal(coverage(payload,result,computed,'compiled_action').ok,true);
  assert.equal(coverage(payload,result,computed,'computed_read',['count','average']).ok,true);
  assert.equal(coverage(payload,result,computed,'computed_read',['percentages']).ok,false);
});

test('legacy conditions-only add and configure previews use the same visible population as the frontend',()=>{
  const payload=fixture(),p=payload.pipeline,kpi={title:'Visible average',metric:'average',field:'f_value',conditions:[]};
  p.visibleIds=[1,3];
  for(const action of [add(kpi),{action:'configure_kpi',kpiId:'kpi_f_value',kpi}]){
    const result={crmAction:action},computed=Review.evidence(payload,result);
    const expected=Customize.summarize(computed.kpiChange.after,p.records.filter(row=>p.visibleIds.includes(row.id)),p.tableSchema,[],p.currentDate);
    assert.equal(computed.population,'visible_records');assert.equal(computed.populationCount,2);assert.deepEqual(computed.summary,expected);
    assert.equal(computed.summary.value,5000);assert.equal(computed.summary.numericCount,2);
    assert.equal(coverage(payload,result,computed,'computed_read',['count','average']).ok,true);
    assert.match(Review.renderAnswer(payload,result,computed),/current visible record population/);
    assert.doesNotMatch(Review.renderAnswer(payload,result,computed),/full authorized/);
  }
  const result={crmAction:add(kpi)},computed=Review.evidence(payload,result);
  p.visibleIds=[5];assert.equal(coverage(payload,result,computed,'computed_read',['average']).ok,false);
  assert.throws(()=>Review.renderAnswer(payload,result,computed),/canonical KPI/);
});

test('an empty visible KPI population never broadens while explicit empty where means all authorized records',()=>{
  const payload=fixture(),p=payload.pipeline;p.visibleIds=[];
  const legacy={title:'Empty view average',metric:'average',field:'f_value',conditions:[]};
  const empty=Review.evidence(payload,{crmAction:add(legacy)});
  assert.equal(empty.populationCount,0);assert.equal(empty.summary.count,0);assert.equal(empty.summary.numericCount,0);assert.equal(empty.summary.value,null);
  const all=Review.evidence(payload,{crmAction:add({...legacy,where:[]})});
  assert.equal(all.population,'all_authorized_records');assert.equal(all.populationCount,5);assert.equal(all.summary.value,24800);
  for(const visibleIds of [undefined,[999],[1,1]]){
    p.visibleIds=visibleIds;assert.throws(()=>Review.evidence(payload,{crmAction:add(legacy)}),/visible KPI population/);
    assert.equal(Review.evidence(payload,{crmAction:add({...legacy,where:[]})}).summary.value,24800);
  }
});

test('KPI summaries distinguish missing numeric values from zero and impossible AND from OR',()=>{
  const payload=fixture();payload.pipeline.records[1].f_value=null;
  const computed=Review.evidence(payload,{crmAction:add(average())});assert.equal(computed.summary.count,4);assert.equal(computed.summary.numericCount,3);assert.equal(computed.summary.value,14000/3);
  const badIntent=average();badIntent.where=[[c('f_deal','equals','North A'),c('f_deal','equals','North B')]];
  const empty=Review.evidence(payload,{crmAction:add(badIntent)});assert.equal(empty.summary.count,0);assert.equal(empty.summary.numericCount,0);assert.equal(empty.summary.value,null);
  assert.match(Review.instructions,/named union needs separate OR groups/);assert.match(Review.instructions,/numericCount counts valid numeric values including zero/);
});

test('percentage previews expose numerator, denominator and value with deduplicated scoped populations',()=>{
  const payload=fixture(),kpi=percentage();kpi.denominatorWhere=[[c('f_deal','starts_with','North')],[c('f_deal','equals','North A')]];
  const result={crmAction:add(kpi)},computed=Review.evidence(payload,result);
  assert.equal(computed.summary.numeratorCount,2);assert.equal(computed.summary.denominatorCount,4);assert.equal(computed.summary.value,50);
  assert.match(Review.renderAnswer(payload,result,computed),/50%.*2 \/ 4 records/);
  assert.equal(coverage(payload,result,computed,'computed_read',['count','percentages']).ok,true);
  assert.equal(coverage(payload,result,computed,'computed_read',['sum']).ok,false);
  kpi.denominatorWhere=[[c('f_value','gt',1e9)]];
  const empty=Review.evidence(payload,result);assert.equal(empty.summary.value,null);assert.equal(empty.summary.numeratorCount,0);assert.equal(empty.summary.denominatorCount,0);
  assert.match(Review.renderAnswer(payload,result,empty),/Not set.*0 \/ 0 records \(zero denominator\)/);
});

test('F07 percentage evidence shows 25 of all 49 even with a narrow visible view',()=>{
  const payload=fixture(),row=payload.pipeline.records[0];payload.pipeline.records=Array.from({length:49},(_,i)=>({...row,id:i+1,f_follow:i<25?'':'2026-10-27'}));payload.pipeline.visibleIds=[49];
  const result={crmAction:add(percentage())},computed=Review.evidence(payload,result);
  assert.equal(computed.summary.numeratorCount,25);assert.equal(computed.summary.denominatorCount,49);assert.equal(computed.summary.value,25/49*100);
  assert.match(Review.renderAnswer(payload,result,computed),/51.02%.*25 \/ 49 records/);
});

test('configure and delete use helper validation and preserve unrelated cards and records',()=>{
  const payload=fixture(),p=payload.pipeline,added=Customize.addKpi(p.tableSchema,[],'kpi_user_existing',average());p.tableSchema=added.tableSchema;
  const before=structuredClone(payload),result={crmAction:{action:'configure_kpi',kpiId:'kpi_user_existing',kpi:percentage()}},computed=Review.evidence(payload,result);
  assert.equal(computed.kpiChange.before.metric,'average');assert.equal(computed.kpiChange.after.metric,'percentage');assert.equal(computed.summary.value,60);
  const deletion={crmAction:{action:'delete_kpi',kpiId:'kpi_records',kpi:null}},removed=Review.evidence(payload,deletion);
  assert.equal(removed.kpiChange.after,null);assert.equal(removed.summary,null);assert(removed.kpiChange.tableSchema.hiddenKpis.includes('kpi_records'));
  assert(removed.kpiChange.tableSchema.kpis.some(kpi=>kpi.id==='kpi_user_existing'));
  assert.match(Review.renderAnswer(payload,deletion,removed),/No KPI has been deleted/);assert.equal(coverage(payload,deletion,removed,'compiled_action').ok,true);
  assert.equal(coverage(payload,deletion,removed,'computed_read',['count']).ok,false);assert.deepEqual(payload,before);
  assert.throws(()=>Review.evidence(payload,{crmAction:{...deletion.crmAction,kpiId:'missing'}}));
});

test('KPI coverage and canonical rendering reject fabricated or stale summaries',()=>{
  const payload=fixture(),result={crmAction:add(average())},computed=Review.evidence(payload,result);
  for(const change of [e=>e.summary.value=999,e=>e.summary.count=99,e=>e.summary.numericCount=99,e=>e.summary.summary='Model prose',e=>e.populationCount=1,e=>e.kpiChange.after.where=[]]){
    const changed=structuredClone(computed);change(changed);
    assert.equal(coverage(payload,result,changed,'compiled_action').ok,false);assert.equal(coverage(payload,result,changed,'computed_read',['average']).ok,false);
    assert.throws(()=>Review.renderAnswer(payload,result,changed),/canonical KPI preview/);
  }
  payload.pipeline.records[0].f_value=100;
  assert.equal(coverage(payload,result,computed,'computed_read',['average']).ok,false);assert.throws(()=>Review.renderAnswer(payload,result,computed),/canonical KPI preview/);
  assert.equal(Review.validateReview(review('compiled_action'),result).ok,false,'An uncompiled KPI action alone is not evidence');
});

test('malformed KPI definitions reject atomically and evidence IDs expose root plus proven constraints',()=>{
  const payload=fixture(),before=structuredClone(payload),bad={...average(),field:'f_deal'},result={crmAction:add(bad)};
  assert.throws(()=>Review.evidence(payload,result));assert.deepEqual(payload,before);
  const good={crmAction:add(average())},computed=Review.evidence(payload,good),schema=Review.schemaFor(good.crmAction,{pipeline:payload.pipeline,computed});
  assert.deepEqual(schema.properties.requirements.items.properties.stepIds.items.enum,['root',...computed.constraintEvidence.map(item=>item.id)]);assert.match(schema.properties.requirements.items.properties.stepIds.description,/numericCount.*numeratorCount\/denominatorCount\/value/);
  assert.equal(coverage(payload,good,computed,'computed_read',['average','average']).ok,false);
  const wrong=review('computed_read',['average']);wrong.requirements[0].stepIds=['invented'];assert.equal(Review.validateReview(wrong,good,{pipeline:payload.pipeline,computed}).ok,false);
});

test('preview-only KPI IDs do not collide with current or hidden user cards',()=>{
  const payload=fixture();payload.pipeline.tableSchema=Customize.addKpi(payload.pipeline.tableSchema,[],'kpi_user_review',{...average(),title:'Existing'}).tableSchema;
  const first=Review.evidence(payload,{crmAction:add(average())});assert.equal(first.kpiChange.after.id,'kpi_user_review_1');
  assert.deepEqual(Review.evidence(payload,{crmAction:add(average())}),first);
});
