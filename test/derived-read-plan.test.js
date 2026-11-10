'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Plan=require('../public/workspace-plan'),Core=require('../public/pipeline-core');
const Output=require('../lib/read-output-contract'),F=require('./fixtures/workspace-plans.cjs');

function fixture(){
  const w=F.workspace();
  w.tableSchema.fields.push({id:'f_probability',name:'Probability percent',type:'number',role:'none',options:[]});
  w.records.forEach((r,i)=>Object.assign(r,{f_deal:'Selected '+i,f_value:[12000,30000,8000,0,20000,null][i],f_probability:[50,80,25,null,null,null][i]}));
  return w;
}
const derived=(field='f_probability',divisor=100)=>({kind:'row_calculation',expression:{kind:'sum_product',factors:['f_value',field],divisor}});
const action=outputs=>F.plan([F.select('cohort',[[F.where('f_deal','starts_with','Selected')]]),
  {op:'read_records',id:'answer',label:'Calculate weighted value',selection:'cohort',showTable:false,outputs}]);

test('derived reads use the selected cohort, retain checked row evidence and never write or replace the dashboard',()=>{
  const w=fixture(),before=structuredClone(w),a=action([derived()]);
  const r=Plan.prepare(w,a,{today:'2026-11-10',visibleIds:[1],nonce:'weighted'}),e=r.queryResults[0].rowCalculations[0];
  assert.equal(e.value,32000);assert.equal(e.coverage.includedCount,3);assert.equal(e.coverage.excludedCount,3);
  assert.deepEqual(e.selectedRecordIds,w.records.map(r=>r.id));assert.deepEqual(w,before);assert.deepEqual(r.next,w);
  assert.equal(r.mutates,false);assert(r.effects.every(e=>e.kind==='table'&&e.show===false));
  assert.match(r.answers[0],/\$32,000\.00/);assert.match(r.answers[0],/3 of 6.*3 excluded/);
  assert(Output.supports(a,['answer'],['derived_sum','sum']));
  assert(!Output.supports(action([{kind:'sum',field:'f_value'}]),['answer'],['derived_sum']));
  assert(!Output.supports(a,['cohort'],['derived_sum']));
});

test('renamed fields, fractional scales, zeroes and reordered cohorts keep the same general calculation',()=>{
  const w=fixture();w.tableSchema.fields.find(f=>f.id==='f_probability').name='Confidence fraction';
  for(const row of w.records)if(row.f_probability!==null)row.f_probability/=100;
  w.records.reverse();w.records.find(r=>r.id===4).f_probability=0.7;
  const r=Plan.prepare(w,action([derived('f_probability',1)]),{today:'2026-11-10',nonce:'fraction'});
  const e=r.queryResults[0].rowCalculations[0];assert.equal(e.value,32000);assert.equal(e.coverage.includedCount,4);
  assert.equal(e.coverage.excludedCount,2);assert.match(r.answers[0],/Confidence fraction.*divide by 1/);
});

test('invalid derived operations reject an entire mixed plan without exposing partial changes',()=>{
  for(const expression of [derived('f_owner'),derived('missing'),derived('f_probability',0)]){
    const w=fixture(),before=structuredClone(w),a=action([expression]);
    a.steps.splice(1,0,F.update('edit','cohort','f_priority','High'));a.goals.push({description:'Edit',stepIds:['edit']});
    assert.throws(()=>Plan.prepare(w,a,{today:'2026-11-10',nonce:'invalid'}),e=>e.reasonCode==='row_calculation_invalid');
    assert.deepEqual(w,before);
  }
});

test('typed expression is available to the model and loaded before the browser planner',()=>{
  const w=fixture(),schema=Plan.responseSchema(Core.create(w.tableSchema));
  const read=schema.properties.steps.items.anyOf.find(s=>s.properties.op.enum[0]==='read_records');
  const branch=read.properties.outputs.items.anyOf.find(s=>s.properties.kind.enum[0]==='row_calculation');
  assert(branch.properties.expression.properties.factors.items.enum.includes('f_probability'));
  const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
  assert(html.indexOf('/row-calculation.js')<html.indexOf('/workspace-plan.js'));
});
