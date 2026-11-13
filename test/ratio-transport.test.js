'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Ratio=require('../lib/ratio-calculation-intent'),Review=require('../lib/action-review');
const Derived=require('../lib/derived-calculation-intent'),F=require('./fixtures/workspace-plans.cjs');
const clone=structuredClone;
function fixture(){
  const pipeline={...F.workspace(),workspaceVersion:'ratio-transport-current',currentDate:'2026-11-13',visibleIds:[1,2]};
  pipeline.tableSchema.fields.find(field=>field.id==='f_value').name='Deal Value';
  const template=pipeline.records[0];
  pipeline.records=[15000,18000,22000,8500,2000,0,null].map((f_value,index)=>({...clone(template),id:index+1,
    f_deal:'QA1110 Deal '+(index+1),f_stage:index?'Qualified':'Closed Won',f_value}));
  pipeline.records.push({...clone(template),id:8,f_deal:'Unrelated',f_stage:'Closed Won',f_value:999999});
  pipeline.dashboard={board:{version:1,elements:[],sharedFilters:[],activeId:null}};
  const intent={completeIntent:true,otherRequestedWork:false,ambiguity:false,
    ratios:[['count',null],['sum','f_value']].map(([metric,field])=>({label:metric==='count'?'Won deal share':'Won known value share',
      population:{source:'all',where:[[F.where('f_deal','starts_with','QA1110')]]},
      numerator:{metric,field,where:[[F.where('f_stage','equals','Closed Won')]]},denominator:{metric,field,where:[]}}))};
  return {pipeline,intent,transport:{action:'ratio_transport',ratios:clone(intent.ratios)}};
}
const computed=(action,pipeline)=>Review.evidence({pipeline},{crmAction:action});

test('compact transport schema shares strict aggregate types with independent intent, without planner-authored proof or references',()=>{
  const {pipeline}=fixture(),transport=Ratio.transportSchemaFor(pipeline),intent=Ratio.schemaFor(pipeline);
  assert.deepEqual(transport.required,['action','ratios']);assert.equal(transport.additionalProperties,false);
  assert.equal(transport.properties.ratios.minItems,1);assert.equal(transport.properties.ratios.maxItems,6);
  assert.deepEqual(transport.properties.ratios.items,intent.properties.ratios.items);
  const operands=transport.properties.ratios.items.properties;
  assert.deepEqual(operands.numerator.anyOf[0].properties.metric.enum,['count']);
  assert.deepEqual(operands.denominator.anyOf[1].properties.field.enum,['f_value']);
  assert(!JSON.stringify(transport).includes('QA1110'));
  const response={type:'object',properties:{crmAction:{anyOf:[{type:'null'}]}},required:['crmAction']},before=clone(response);
  const extended=Ratio.extendResponseSchema(response,pipeline);
  assert.deepEqual(response,before);assert.deepEqual(extended.properties.crmAction.anyOf[1],transport);
  assert.deepEqual(Ratio.extendResponseSchema(extended,pipeline),extended,'Schema extension is idempotent');
  assert.match(Ratio.compilerInstructions,/independent schema-only review/);
});

test('F03 transport compiles goal-complete answer-only fractions and still requires an independently checked intent',()=>{
  const {pipeline,intent,transport}=fixture(),before=clone({pipeline,transport});
  const action=Ratio.normalizeAction(transport,pipeline),evidence=computed(action,pipeline);
  assert.deepEqual(action,Ratio.compile(intent,pipeline));
  assert(action.steps.every(step=>action.goals.some(goal=>goal.stepIds.includes(step.id))));
  assert.equal(action.action,'workspace_plan');assert(action.steps.every(step=>step.op==='report'&&step.showDashboard===false));
  assert.deepEqual(action.steps.flatMap(step=>step.spec.measures.map(measure=>measure.metric)),['count','count','sum','sum']);
  assert.deepEqual(Ratio.assess(intent,action,{pipeline,computed:evidence}),{complete:true,ok:true,issues:[],requested:2,compiled:2});
  const answer=Review.renderAnswer({pipeline},{crmAction:action},evidence);
  assert.match(answer,/14\.29% \(1 \/ 7 x 100\)/);
  assert.match(answer,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
  assert.match(answer,/7 records represented/);assert.match(answer,/6 numeric values/);
  assert.equal(evidence.lifecycle.operation,'read');assert.equal(evidence.lifecycle.writesApplied,0);
  assert.equal(evidence.mutates,false);assert.deepEqual({pipeline,transport},before);
  assert.equal(Ratio.assess(intent,action,{pipeline,computed:clone(evidence)}).ok,false,'Serialization cannot authenticate proof');
  assert.equal(Ratio.assess(intent,action,{pipeline,computed:transport}).ok,false,'Planner transport never authenticates proof');
});

test('goal_coverage_invalid candidates remain eligible before execution; independent complete intent can replace them locally',()=>{
  const {pipeline,intent}=fixture(),invalid=Ratio.compile(intent,pipeline);invalid.goals.pop();
  assert.equal(Ratio.candidateEligible(invalid),true);
  assert.throws(()=>computed(invalid,pipeline),error=>error.reasonCode==='goal_coverage_invalid'&&error.goalCoverage.uncoveredOperations===1);
  const repaired=Ratio.prepare(intent,pipeline);
  const rebound=computed(repaired.action,pipeline);
  assert.notStrictEqual(rebound,repaired.computed);
  assert.equal(Ratio.assess(intent,repaired.action,{pipeline,computed:rebound}).ok,true);
  assert.throws(()=>Ratio.prepare({...intent,completeIntent:false,otherRequestedWork:true},pipeline),/incomplete/);
});

test('candidate gate includes missing fractions and derived candidates, not prompt labels or proof claims',()=>{
  const {pipeline,intent,transport}=fixture(),action=Ratio.compile(intent,pipeline);
  action.steps.forEach(step=>step.questions=step.questions.filter(question=>question.kind==='summary'));
  const raw=F.plan([F.select('cohort',intent.ratios[0].population.where),
    {id:'totals',op:'read_records',label:'Untrusted label',selection:'cohort',showTable:false,
      outputs:[{kind:'count',field:null},{kind:'sum',field:'f_value'}]}]);
  const derived=clone(raw);derived.steps[1].outputs=[{kind:'row_calculation',
    expression:{kind:'sum_product',factors:['f_value'],divisor:1}}];
  assert.equal(Derived.eligible(derived),true,'Derived gate can overlap: the server must check ratio intent first');
  const derivedEvidence=computed(derived,pipeline);
  assert.equal(Ratio.assess(intent,derived,{pipeline,computed:derivedEvidence}).ok,false,'A derived sum is not either requested fraction');
  for(const candidate of [transport,action,raw,derived])assert.equal(Ratio.candidateEligible(candidate),true);
  assert.equal(Ratio.eligible(raw),false,'Legacy emitted-percentage gate is not the candidate gate');
  for(const candidate of [null,{action:'clarify'},F.plan([F.select('unconsumed',[])]),
    F.plan([{...raw.steps[1],outputs:[{kind:'fields',field:'f_value'}],label:'percentage ratio Won QA1110'}]),
    F.plan([...raw.steps,F.update('mutate','cohort','f_value',100)])])assert.equal(Ratio.candidateEligible(candidate),false);
  const ctx={pipeline,computed:computed(raw,pipeline)},failed=Ratio.assess(intent,raw,ctx);
  assert.equal(failed.ok,false);assert.deepEqual(failed.expectedAction,Ratio.compile(intent,pipeline));
});

test('transport cannot authorize omitted, duplicated, swapped, count-based value or partial extra-work answers',()=>{
  const {pipeline,intent}=fixture();
  for(const alter of [t=>t.ratios.pop(),t=>t.ratios[1]=clone(t.ratios[0]),
    t=>{const r=t.ratios[1];[r.numerator,r.denominator]=[r.denominator,r.numerator];},
    t=>{const r=t.ratios[1];r.numerator.metric=r.denominator.metric='count';r.numerator.field=r.denominator.field=null;},
    t=>t.ratios[0].denominator.where=[[F.where('f_value','is_not_blank')]]]){
    const transport={action:'ratio_transport',ratios:clone(intent.ratios)};alter(transport);
    const action=Ratio.normalizeAction(transport,pipeline),evidence=computed(action,pipeline);
    assert.equal(Ratio.assess(intent,action,{pipeline,computed:evidence}).ok,false,alter.toString());
  }
  const action=Ratio.compile(intent,pipeline),ctx={pipeline,computed:computed(action,pipeline)};
  assert.deepEqual(Ratio.assess({...intent,completeIntent:false,otherRequestedWork:true},action,ctx),
    {complete:false,ok:true,issues:[],requested:2,compiled:2,requiresGeneralReview:true});
  assert.equal(Ratio.assess({...intent,ambiguity:true},action,ctx).ok,false);
});

test('transport validates current field units and strict shape and preserves non-ratio actions by identity',()=>{
  const {pipeline,transport}=fixture();
  for(const alter of [t=>t.completeIntent=true,t=>t.steps=[],t=>t.ratios=[],
    t=>t.ratios.push(...clone(t.ratios),...clone(t.ratios),clone(t.ratios[0])),
    t=>t.ratios[0].numerator.field='f_value',t=>t.ratios[1].denominator.field='f_owner',
    t=>t.ratios[1].denominator.metric='average',t=>t.ratios[1].numerator.value=15000,
    t=>t.ratios[0].population.source='focus',t=>t.ratios[0].population.where=[[F.where('f_value','gt','0')]]]){
    const bad=clone(transport);alter(bad);assert.throws(()=>Ratio.normalizeAction(bad,pipeline),undefined,alter.toString());
  }
  const other={action:'workspace_plan',steps:[]};assert.strictEqual(Ratio.normalizeAction(other,pipeline),other);
  assert.equal(Ratio.normalizeAction(null,pipeline),null);
  const large=clone(transport);large.ratios[0].population.where=[[F.where('f_deal','in',null,Array.from({length:300},(_,i)=>'Record '+i+'x'.repeat(30)))]];
  assert.throws(()=>Ratio.normalizeAction(large,pipeline),/bounded/);
});

test('transport generalizes to custom quantities and explicit visible scope, retaining zero and unknown semantics',()=>{
  const {pipeline,intent,transport}=fixture();
  pipeline.customFields=[{id:'cf_hours',name:'Billable hours',type:'number'}];
  pipeline.records.forEach((row,index)=>row.cf_hours=[1.5,0,3,null,9,11,0,400][index]);
  for(const ratios of [intent.ratios,transport.ratios]){
    ratios.forEach(ratio=>{ratio.population={source:'visible',where:[]};});
    ratios[1].numerator.field=ratios[1].denominator.field='cf_hours';
  }
  const action=Ratio.normalizeAction(transport,pipeline),evidence=computed(action,pipeline);
  assert.equal(Ratio.assess(intent,action,{pipeline,computed:evidence}).ok,true);
  assert.match(Review.renderAnswer({pipeline},{crmAction:action},evidence),/100% \(1\.5 \/ 1\.5 x 100\)/);
  pipeline.records[0].cf_hours=null;pipeline.records[1].cf_hours=0;
  const zero=computed(action,pipeline);
  assert.match(Review.renderAnswer({pipeline},{crmAction:action},zero),/Not set \(Not set \/ 0 x 100\)/);
  assert.match(Review.renderAnswer({pipeline},{crmAction:action},zero),/1 numeric value\)/);
});
