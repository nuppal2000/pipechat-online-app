'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Ratio=require('../lib/ratio-calculation-intent'),Review=require('../lib/action-review');
const Dashboard=require('../public/dashboard-board'),Core=require('../public/pipeline-core');
const F=require('./fixtures/workspace-plans.cjs');
const cohort=[[F.where('f_deal','starts_with','QA1110')]],won=[[F.where('f_stage','equals','Closed Won')]];
const commands=[
  'Show the percentage of QA1110 deals that are Won, next to the percentage of their known value that is Won.',
  'For QA1110 deals, give me two percentages: the share of deals that are Won, and the share of known Deal Value that is Won. Show the numerator and denominator for each.',
  'Among the seven QA1110 deals, compare the Won share by count with the Won share of known Deal Value; include both numerators and denominators.',
  'Compare the completion rate of East engagements with the percentage of their known billable hours completed.'
];
const clone=structuredClone;
function pipeline(){
  const p={...F.workspace(),workspaceVersion:'ratio-guard-current',currentDate:'2026-11-13',visibleIds:[1,2]};
  p.tableSchema.fields.find(f=>f.id==='f_value').name='Deal Value';
  const template=p.records[0];
  p.records=[15000,18000,22000,8500,2000,0,null].map((f_value,index)=>({...clone(template),id:index+1,
    f_deal:'QA1110 Deal '+(index+1),f_stage:index?'Qualified':'Closed Won',f_value}));
  p.records.push({...clone(template),id:8,f_deal:'Unrelated',f_value:999999,f_stage:'Closed Won'});
  p.dashboard={board:{version:1,elements:[],sharedFilters:[],activeId:null}};
  return p;
}
function intent(partial=false){
  return {completeIntent:!partial,otherRequestedWork:partial,ambiguity:false,ratios:[['count',null],['sum','f_value']].map(([metric,field])=>({
    label:metric==='count'?'Won deals':'Won known value',population:{source:'all',where:clone(cohort)},
    numerator:{metric,field,where:clone(won)},denominator:{metric,field,where:[]}
  }))};
}
function spec(measures,where=cohort){
  return {version:1,title:'Untrusted presentation label',chart:'kpi',scope:'all',groupBy:null,bucket:'none',splitBy:null,
    where:clone(where),sort:'label_asc',limit:null,measures};
}
function dashboard(wrong=false){
  const i=intent();
  const operations=i.ratios.map((ratio,index)=>({op:'add',id:'share_'+index,spec:wrong?
    spec([{label:ratio.label,metric:'percentage',field:null,where:clone(won)}],index?[[...cohort[0],F.where('f_value','is_not_blank')]]:cohort):
    spec([{label:'Numerator',...clone(ratio.numerator)},{label:'Denominator',...clone(ratio.denominator)}])}));
  const questions=wrong?[]:i.ratios.map((ratio,index)=>({kind:'percentage',label:ratio.label,
    left:{elementId:'share_'+index,measure:0,stat:'aggregate'},right:{elementId:'share_'+index,measure:1,stat:'aggregate'}}));
  return {action:'dashboard_plan',operations,questions};
}
const context=(action,p=pipeline())=>({pipeline:p,computed:Review.evidence({pipeline:p},{crmAction:action})});
const assess=(i,action,p=pipeline())=>Ratio.assess(i,action,context(action,p));

test('eligibility includes both percentage transports, nested plans and measure-only candidates, not ordinary charts',()=>{
  const wrong=dashboard(true),correct=dashboard();
  for(const action of [wrong,correct,Ratio.compile(intent(),pipeline()),
    F.plan([{id:'display',op:'dashboard',label:'Percentages',plan:wrong}]),
    F.plan([{id:'read',op:'report',label:'Percentage',selection:null,spec:wrong.operations[0].spec,questions:[],showDashboard:false}]),
    {action:'analyze_dashboard',questions:correct.questions},
    {action:'dashboard_plan',operations:[{op:'update',changes:[{field:'measures',value:wrong.operations[0].spec.measures}]}],questions:[]}])
    assert.equal(Ratio.eligible(action),true,JSON.stringify(action));
  for(const action of [null,{action:'clarify'},
    {action:'dashboard_plan',operations:[{op:'add',id:'normal',spec:spec([{label:'Amount',metric:'sum',field:'f_value',where:[]}])}],questions:[]},
    {action:'analyze_dashboard',questions:[{kind:'summary',elementIds:['normal']}]},
    F.plan([{id:'normal',op:'report',spec:spec([{label:'Count',metric:'count',field:null,where:[]}]),questions:[]}]),
    F.plan([{id:'raw',op:'read_records',outputs:[{kind:'sum',field:'f_value'}]}])])
    assert.equal(Ratio.eligible(action),false,JSON.stringify(action));
});

test('original, explicit operands and numeric-count variants use only schema and primary names with typed aggregate units',()=>{
  const p=pipeline();
  for(const userCommand of commands){
    const input=Ratio.input({userCommand,pipeline:p,crmAction:dashboard(true),conversationHistory:['Private history']});
    assert.deepEqual(Object.keys(input).sort(),['fields','primaryField','primaryNames','userCommand']);
    assert.equal(input.userCommand,userCommand);
    assert.deepEqual(input.primaryNames,p.records.map(row=>({name:row.f_deal,matches:1})));
    assert(!JSON.stringify(input).includes('Private history'));
  }
  const operands=Ratio.schemaFor(p).properties.ratios.items.properties;
  for(const key of ['numerator','denominator']){
    assert.deepEqual(operands[key].anyOf[0].properties.metric.enum,['count']);
    assert.equal(operands[key].anyOf[0].properties.field.type,'null');
    assert.deepEqual(operands[key].anyOf[1].properties.metric.enum,['sum']);
    assert(operands[key].anyOf[1].properties.field.enum.includes('f_value'));
  }
  assert.match(Ratio.instructions,/Known value does not mean the number of records/);
  assert.match(Ratio.instructions,/not literal denominators/);
});

test('live wrong dashboard is 1/7 and 1/6, but cannot prove a known-value share',()=>{
  const a=dashboard(true),p=pipeline(),ctx=context(a,p),before=clone(p);
  assert.equal(ctx.computed.displayed[0].summaries[0].value,1/7*100);
  assert.equal(ctx.computed.displayed[1].summaries[0].value,1/6*100);
  for(const partial of [false,true]){
    const result=Ratio.assess(intent(partial),a,ctx);
    assert.equal(result.ok,false);assert.equal(result.complete,true);
    assert.match(result.issues[0],/value share requires sum\/sum/);
    assert.equal(!!result.expectedAction,!partial,'Never replace a partial request with only its ratios');
  }
  const nested=F.plan([{id:'display',op:'dashboard',label:'Percentages',plan:a}]);
  assert.match(assess(intent(),nested,p).issues[0],/value share requires sum\/sum/);
  assert.deepEqual(p,before);
});

test('local repair runs both canonical fractions against authenticated evidence with seven rows and six known values',()=>{
  for(const userCommand of commands.slice(0,3)){
    const p=pipeline(),before=clone(p),i=intent();
    assert(Ratio.input({pipeline:p,userCommand}));
    const rejected=assess(i,dashboard(true),p),prepared=Ratio.prepare(i,p);
    assert.deepEqual(prepared.action,rejected.expectedAction);
    assert.deepEqual(prepared.assessment,{complete:true,ok:true,issues:[],requested:2,compiled:2});
    const text=Review.renderAnswer({pipeline:p},{crmAction:prepared.action},prepared.computed);
    assert.match(text,/14\.29% \(1 \/ 7 x 100\)/);
    assert.match(text,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
    assert.match(text,/7 records represented/);assert.match(text,/6 numeric values/);
    const report=prepared.action.steps[1],board={version:1,elements:[{id:report.id,spec:report.spec,visibleIds:[]}],sharedFilters:[],activeId:report.id};
    const [numerator,denominator]=Dashboard.evaluate(board,p.records,Core.create(p.tableSchema),p.customFields)[0].snapshot.summaries;
    assert.equal(numerator.value,15000);assert.equal(denominator.value,65500);assert.equal(denominator.numericCount,6);
    assert.equal(numerator.value/denominator.value*100,22.900763358778626);
    assert(prepared.computed.effects.every(effect=>effect.kind==='table'&&effect.show===false));
    assert.equal(prepared.computed.lifecycle.operation,'read');assert.deepEqual(p,before);
    assert.equal(Ratio.assess(i,prepared.action,clone({pipeline:p,computed:prepared.computed})).ok,false);
  }
});

test('a legitimate count percentage is a count fraction, never a blanket forbidden dashboard metric',()=>{
  const i=intent(true);i.ratios=i.ratios.slice(0,1);
  const a=dashboard(true);a.operations=a.operations.slice(0,1);
  assert.deepEqual(assess(i,a),{complete:false,ok:true,issues:[],requested:1,compiled:1,requiresGeneralReview:true});
  const wrong=clone(a);wrong.operations[0].spec.where[0].push(F.where('f_value','is_not_blank'));
  assert.equal(assess(i,wrong).ok,false,'Known-amount count must not replace count of all deals');
  assert.throws(()=>Ratio.prepare(i,pipeline()),/incomplete/,'A subset never becomes a complete repaired action');
});

test('typed dashboard sum/sum proof retains general review for explicitly requested display work',()=>{
  const a=dashboard(),i=intent(true);
  assert.deepEqual(assess(i,a),{complete:false,ok:true,issues:[],requested:2,compiled:2,requiresGeneralReview:true});
  const full=assess(intent(),a);
  assert.equal(full.ok,false);assert.match(full.issues[0],/answer-only/);
  const nested=F.plan([{id:'display',op:'dashboard',label:'Percentages',plan:a}]);
  assert.equal(assess(i,nested).requiresGeneralReview,true);
  for(const mutate of [
    a=>a.questions.pop(),
    a=>{a.questions[1]=clone(a.questions[0]);},
    a=>{[a.questions[1].left,a.questions[1].right]=[a.questions[1].right,a.questions[1].left];},
    a=>{a.questions[1].left.stat=a.questions[1].right.stat='records';},
    a=>{a.operations[1].spec.measures.forEach(m=>{m.metric='count';m.field=null;});},
    a=>{a.operations[1].spec.measures[1].where=[[F.where('f_value','gt',0)]];},
    a=>{a.operations[1].spec.owners=['Other'];},
    a=>{a.operations[0].spec.where[0][0].operator='contains';}
  ]){
    const wrong=dashboard();mutate(wrong);assert.equal(assess(i,wrong).ok,false,mutate.toString());
  }
});

test('numeric field IDs and denominators generalize, including coincidentally equal count and sum results',()=>{
  const p=pipeline(),i=intent(true),a=dashboard();
  p.customFields=[{id:'cf_hours',name:'Billable hours',type:'number'}];
  p.records.forEach((row,index)=>{row.cf_hours=[1.5,0,3,null,9,11,0,400][index];row.f_owner=index<4?'East':'West';});
  i.ratios.forEach(ratio=>ratio.population.where=[[F.where('f_owner','equals','East')]]);
  i.ratios[1].numerator.field=i.ratios[1].denominator.field='cf_hours';
  a.operations.forEach(op=>op.spec.where=[[F.where('f_owner','equals','East')]]);
  a.operations[1].spec.measures.forEach(measure=>measure.field='cf_hours');
  assert.equal(assess(i,a,p).ok,true);
  const complete={...i,completeIntent:true,otherRequestedWork:false},prepared=Ratio.prepare(complete,p);
  const answer=Review.renderAnswer({pipeline:p},{crmAction:prepared.action},prepared.computed);
  assert.match(answer,/25% \(1 \/ 4 x 100\)/);assert.match(answer,/33\.33% \(1\.5 \/ 4\.5 x 100\)/);
  assert.match(answer,/3 numeric values/);
  const q=pipeline();q.records.slice(0,7).forEach(row=>row.f_value=1);
  const wrong=dashboard(true);wrong.operations[1].spec.where=clone(cohort);
  const values=context(wrong,q).computed.displayed.map(view=>view.summaries[0].value);
  assert.deepEqual(values,[1/7*100,1/7*100]);
  assert.equal(assess(intent(true),wrong,q).ok,false,'Matching numbers never substitute aggregate units');
});

test('materialized requestScope and shared filters are checked, never titles or coincidental current totals',()=>{
  const a=dashboard(),i=intent(true);a.requestScope={scope:'all',where:clone(cohort)};
  a.operations.forEach(op=>op.spec.where=[]);
  assert.equal(assess(i,a).ok,true);
  a.operations.push({op:'set_shared_filter',id:'known',targets:['share_1'],where:[[F.where('f_value','is_not_blank')]]});
  assert.equal(assess(i,a).ok,true,'SUM already excludes unknown values');
  a.operations.at(-1).where=[[F.where('f_value','gt',0)]];
  assert.equal(assess(i,a).ok,false,'Excluding zero changes semantics even when totals match');
  a.operations.at(-1).where=[[F.where('f_value','is_not_blank')]];
  a.operations.at(-1).targets=['share_0'];assert.equal(assess(i,a).ok,false);
});

test('unknown, zero and empty numeric denominators remain Not set without inventing zero percent',()=>{
  for(const value of [0,null]){
    const p=pipeline();p.records.slice(0,7).forEach(row=>row.f_value=value);
    const prepared=Ratio.prepare(intent(),p),answer=Review.renderAnswer({pipeline:p},{crmAction:prepared.action},prepared.computed);
    assert.match(answer,/Won known value: Not set/);
    assert.match(answer,value===0?/7 numeric values/:/0 numeric values/);
    assert.equal(assess(intent(true),dashboard(true),p).ok,false,'Even equal/empty results do not change the aggregate units');
  }
  const i=intent();i.ratios.forEach(ratio=>ratio.population.where=[[F.where('f_deal','equals','Absent')]]);
  const prepared=Ratio.prepare(i,pipeline());
  assert.match(Review.renderAnswer({pipeline:pipeline()},{crmAction:prepared.action},prepared.computed),/Not set \(0 \/ 0 x 100\)/);
});

test('incomplete display intents cannot escape a mismatch, while genuinely unsupported intent defers',()=>{
  assert.deepEqual(Ratio.assess({completeIntent:false,ratios:[],otherRequestedWork:true,ambiguity:false},dashboard(true),{pipeline:pipeline()}),
    {complete:false,ok:false,issues:[],requested:0,compiled:0});
  for(const mutate of [i=>i.ambiguity=true,i=>i.ratios[1].denominator.field='f_owner',i=>delete i.ratios]){
    const i=intent(true);mutate(i);const result=assess(i,dashboard());
    assert.equal(result.complete,true);assert.equal(result.ok,false);assert.equal(result.expectedAction,undefined);
  }
});
