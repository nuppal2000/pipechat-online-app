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
  assert.match(Ratio.compilerInstructions,/independent request review/);
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

test('independent input contains only the complete current primary-name catalog, not other cells, histories or supplied catalogs',()=>{
  const {pipeline}=fixture(),userCommand='Compare the shares for QA1110 deals.';
  pipeline.records[0].f_notes='PRIVATE_CELL';pipeline.records[0].history=[{text:'PRIVATE_HISTORY'}];
  pipeline.records[1].f_value=123456789;
  const input=Ratio.input({pipeline,userCommand,primaryNames:[{name:'FORGED_NAME',matches:1}],
    conversationHistory:['PRIVATE_CHAT'],crmAction:{title:'PRIVATE_PROPOSAL'}});
  assert.deepEqual(Object.keys(input).sort(),['fields','primaryField','primaryNames','userCommand']);
  assert.deepEqual(input.primaryNames,pipeline.records.map(row=>({name:row.f_deal,matches:1})));
  assert.equal(input.primaryField,'f_deal');
  assert.doesNotMatch(JSON.stringify(input),/PRIVATE_CELL|PRIVATE_HISTORY|PRIVATE_CHAT|PRIVATE_PROPOSAL|FORGED_NAME|123456789/);
  assert.match(Ratio.instructions,/full exact unique name/);assert.match(Ratio.instructions,/uses starts_with on primaryField/);
  assert.match(Ratio.instructions,/not equals on a group token/);assert.match(Ratio.instructions,/not contains/);
});

test('catalog resolves the actual primary field and exposes normalized duplicate multiplicity without selecting an ambiguous individual',()=>{
  const {pipeline,intent}=fixture();pipeline.tableSchema.fields.find(field=>field.id==='f_deal').id='f_identity';
  pipeline.records=pipeline.records.slice(0,4).map((row,index)=>({...row,f_identity:['Caf\u00e9 Logistics','  CAFE  LOGISTICS  ',' ',null][index]}));
  const input=Ratio.input({pipeline,userCommand:'Give the Won share for Cafe Logistics.'});
  assert.equal(input.primaryField,'f_identity');
  assert.deepEqual(input.primaryNames,[{name:'Caf\u00e9 Logistics',matches:2}]);
  assert(!JSON.stringify(input.primaryNames).includes('QA1110'));
  assert.match(Ratio.instructions,/multiple matches.*completeIntent false, ambiguity true and ratios \[\]/);
  const ambiguous={completeIntent:false,otherRequestedWork:false,ambiguity:true,ratios:[]};
  assert.equal(Ratio.assess(ambiguous,null,{pipeline}).complete,false);
  assert.throws(()=>Ratio.prepare({...intent,...ambiguous},pipeline),/incomplete/);
});

test('catalog and total input enforce row and UTF-8 byte budgets without truncating names or hiding duplicates',()=>{
  const {pipeline}=fixture(),payload={pipeline,userCommand:'x'},template=clone(pipeline.records[0]);
  pipeline.records=Array.from({length:2000},(_,index)=>({...template,id:index+1}));
  assert.deepEqual(Ratio.input(payload).primaryNames,[{name:template.f_deal,matches:2000}]);
  pipeline.records.push({...template,id:2001});assert.equal(Ratio.input(payload),null);
  pipeline.records=[template];
  const overhead=Buffer.byteLength(JSON.stringify([{name:'',matches:1}]),'utf8');
  template.f_deal='n'.repeat(12000-overhead);
  assert.equal(Buffer.byteLength(JSON.stringify(Ratio.input(payload).primaryNames),'utf8'),12000);
  template.f_deal+='n';assert.equal(Ratio.input(payload),null);
  template.f_deal='\u754c'.repeat(4100);assert.equal(Ratio.input(payload),null,'Count UTF-8 bytes, not JS characters');
  template.f_deal='A';
  const base=Buffer.byteLength(JSON.stringify(Ratio.input(payload)),'utf8');
  payload.userCommand='x'.repeat(24000-base+1);
  assert.equal(Buffer.byteLength(JSON.stringify(Ratio.input(payload)),'utf8'),24000);
  payload.userCommand+='x';assert.equal(Ratio.input(payload),null);
  payload.userCommand='x';pipeline.records=[template,clone(template)];assert.equal(Ratio.input(payload),null,'Duplicate record IDs are not extra saved identities');
  pipeline.records=[{...template,f_deal:42}];assert.equal(Ratio.input(payload),null);
  delete pipeline.records;assert.equal(Ratio.input(payload),null,'Missing catalog is not an empty saved table');
});

test('blank status stays in the full record denominator, while known value excludes only missing amounts',()=>{
  const {pipeline,intent}=fixture();pipeline.records[6].f_stage='';
  pipeline.records[7].f_deal='Other QA1110 suffix';
  const prepared=Ratio.prepare(intent,pipeline),answer=Review.renderAnswer({pipeline},{crmAction:prepared.action},prepared.computed);
  assert.match(answer,/14\.29% \(1 \/ 7 x 100\)/);
  assert.match(answer,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
  assert.match(answer,/6 numeric values/);
  assert.match(Ratio.instructions,/including blank status/);assert.match(Ratio.instructions,/unless the user explicitly excludes/);
  assert.match(Ratio.instructions,/Never infer status is_not_blank/);
  assert.match(Ratio.compilerInstructions,/FULL RECORD DENOMINATOR/);
  const narrowed=clone(prepared.action);narrowed.steps[0].spec.measures[1].where=[[F.where('f_stage','is_not_blank')]];
  const narrowEvidence=computed(narrowed,pipeline);
  assert.match(Review.renderAnswer({pipeline},{crmAction:narrowed},narrowEvidence),/16\.67% \(1 \/ 6 x 100\)/);
  assert.equal(Ratio.assess(intent,narrowed,{pipeline,computed:narrowEvidence}).ok,false);
  const explicit=clone(intent);explicit.ratios[0].denominator.where=[[F.where('f_stage','is_not_blank')]];
  assert.equal(Ratio.assess(explicit,narrowed,{pipeline,computed:narrowEvidence}).ok,true,'An explicitly requested exclusion remains supported');
  const substring=clone(prepared.action);substring.steps.forEach(step=>step.spec.where[0][0].operator='contains');
  assert.equal(Ratio.assess(intent,substring,{pipeline,computed:computed(substring,pipeline)}).ok,false,'An incidental substring is not the requested prefix');
});
