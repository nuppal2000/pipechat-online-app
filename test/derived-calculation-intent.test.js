'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../lib/derived-calculation-intent'),Review=require('../lib/action-review');
const F=require('./fixtures/workspace-plans.cjs');
const probability='cf_probability';
const scope=[[F.where('f_deal','starts_with','QA1105')]];
const expression={kind:'sum_product',factors:['f_value',probability],divisor:100};
const intent=(where=scope,source='all')=>({completeIntent:true,population:{source,where:structuredClone(where)},
  expression:structuredClone(expression),coverage:true,counts:['selected','included','excluded'],otherRequestedWork:false,ambiguity:false});
const read=(id,selection,outputs)=>({id,op:'read_records',label:'Untrusted label',selection,showTable:false,outputs});
const calculation=e=>({kind:'row_calculation',expression:structuredClone(e)});
const count={kind:'count',field:null};
function pipeline(){
  const p={...F.workspace(),visibleIds:[1,2,3],workspaceVersion:'current',currentDate:'2026-11-10'};
  p.tableSchema.fields.find(f=>f.id==='f_value').name='Deal Value';
  p.customFields=[{id:probability,name:'Probability percent',type:'number'}];
  p.records.forEach((r,i)=>Object.assign(r,{f_deal:'QA1105 '+['Cedar Consulting','Cedar North','Maple Retail','Elm','Ash','Oak'][i],
    f_value:[12000,30000,8000,4000,9000,11000][i],[probability]:[50,80,25,null,'',null][i]}));
  p.records.push({...p.records[0],id:7,f_deal:'Other cohort',f_value:999,[probability]:100});
  return p;
}
function plan(i=intent()){
  return F.plan([F.select('cohort',i.population.where,{source:i.population.source}),read('total','cohort',[calculation(i.expression)])]);
}
const prepare=(action,p=pipeline())=>({pipeline:p,computed:Review.evidence({pipeline:p},{crmAction:action})});
const assess=(i,a,p)=>{a.goals=F.plan(a.steps).goals;return D.assess(i,a,prepare(a,p));};
const result=ctx=>ctx.computed.queryResults.find(r=>r.rowCalculations)?.rowCalculations[0];
function prefiltered(){
  return F.plan([F.select('cohort',scope),read('count_all','cohort',[count]),
    F.select('present',[[F.where(probability,'is_not_blank')]],{source:'cohort'}),
    read('count_present','present',[count]),read('total','present',[calculation(expression)])]);
}

test('all-six regression: a correct total and independent counts do not prove complete calculation coverage',()=>{
  const a=prefiltered(),ctx=prepare(a),before=structuredClone({action:a,...ctx});
  // The existing planner accepts this valid read, but cannot know its requested denominator.
  assert.equal(result(ctx).value,32000);
  assert.equal(result(ctx).coverage.selectedCount,3);assert.equal(result(ctx).coverage.excludedCount,0);
  assert.equal(ctx.computed.queryResults[0].recordIds.length,6);
  assert.equal(ctx.computed.queryResults[1].recordIds.length,3);
  const review=D.assess(intent(),a,ctx);
  assert.equal(review.complete,true);assert.equal(review.ok,false);assert.match(review.issues.join(' '),/population/i);
  assert.deepEqual({action:a,...ctx},before);
  const good=plan(),goodContext=prepare(good);
  assert.equal(D.assess(intent(),good,goodContext).ok,true);
  assert.equal(result(goodContext).value,32000);
  assert.equal(result(goodContext).coverage.selectedCount,6);assert.equal(result(goodContext).coverage.excludedCount,3);
});

test('explicit with-Probability scope remains a legitimate three-record source, never auto-unfiltered',()=>{
  const i=intent([[...scope[0],F.where(probability,'is_not_blank')]]),a=plan(i),ctx=prepare(a);
  assert.equal(D.assess(i,a,ctx).ok,true);assert.equal(result(ctx).coverage.selectedCount,3);
  assert.equal(result(ctx).coverage.excludedCount,0);
  assert.equal(assess(i,plan()).ok,false);
  assert.equal(assess(intent(),a).ok,false);
});

test('independent input has only current text and schema, not rows, prior answers, visible IDs or the proposed plan',()=>{
  for(const command of [
    'For QA1105 deals with a Probability percent, what is our weighted pipeline value? Multiply each deal value by its probability and add the results.',
    'Calculate expected revenue for all six QA1105 deals using Deal Value times Probability percent divided by 100, then sum. Report weighted total and included/excluded missing unknown.',
    'Sum revenue times confidence / 100 for the current view, accounting for incomplete records.'
  ]){
    const p=pipeline(),input=D.input({userCommand:command,pipeline:p,conversationHistory:['secret'],crmAction:prefiltered(),computed:{secret:1}});
    assert.equal(input.userCommand,command);
    assert.deepEqual(Object.keys(input).sort(),['fields','primaryField','userCommand']);
    assert.deepEqual(input.fields.find(f=>f.id===probability),{id:probability,name:'Probability percent',type:'number',options:[]});
    assert.equal(JSON.stringify(input).includes('secret'),false);assert.equal(JSON.stringify(input).includes('Cedar Consulting'),false);
  }
  for(const extra of [{pendingAction:{}},{pendingClarification:{}},{userCommand:' '},{userCommand:'x'.repeat(24001)}]){
    assert.equal(D.input({pipeline:pipeline(),userCommand:'Calculate the sum.',...extra}),null);
  }
  const schema=D.schemaFor(pipeline());
  assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required.toSorted(),Object.keys(intent()).sort());
  const exp=schema.properties.expression.anyOf.find(s=>s.type==='object');
  assert(exp.properties.factors.items.enum.includes(probability));
  assert(!exp.properties.factors.items.enum.includes('f_owner'));
  assert.match(D.instructions,/Ordinary preservation instructions.*compatible with completeIntent true/);
});

test('current all and explicit visible sources are distinct; exact IDs matter, not just counts or totals',()=>{
  const visible=intent(scope,'visible'),a=plan(visible);
  assert.equal(assess(visible,a).ok,true);assert.equal(assess(intent(),a).ok,false);
  assert.equal(assess(visible,plan()).ok,false);
  const sameCount=plan();sameCount.steps[0].where=[[F.where('f_deal','not_equals','QA1105 Oak')]];
  const p=pipeline();p.records[6].f_value=11000;p.records[6][probability]=null;
  assert.equal(result(prepare(sameCount,p)).value,32000);
  assert.equal(assess(intent(),sameCount,p).ok,false);
});

test('generic renamed factors, fraction scale, zero, null and empty cohorts retain exact calculation semantics',()=>{
  const p=pipeline();p.customFields[0].name='Confidence fraction';
  for(const r of p.records)if(typeof r[probability]==='number')r[probability]/=100;
  p.records[3][probability]=0;p.records[4][probability]=0.5;p.records[4].f_value=null;
  const i=intent();i.expression.divisor=1;
  const a=plan(i),ctx=prepare(a,p),r=result(ctx);
  assert.equal(D.assess(i,a,ctx).ok,true);assert.equal(r.value,32000);
  assert.equal(r.coverage.includedCount,4);assert.equal(r.coverage.excludedCount,2);
  assert.deepEqual(r.coverage.excludedRows[0].missingFields,['f_value']);
  const empty=intent([[F.where('f_deal','equals','Absent')]]);
  assert.equal(assess(empty,plan(empty)).ok,true);
  assert.equal(result(prepare(plan(empty))).value,null);
});

test('expression comparison uses typed factors and explicit scale, never a coincidentally equal total',()=>{
  const i=intent(),reversed=plan();reversed.steps[1].outputs[0].expression.factors.reverse();
  assert.equal(assess(i,reversed).ok,true);
  const zero=pipeline();zero.records.forEach(r=>{r.f_value=0;if(typeof r[probability]==='number')r[probability]=0;});
  for(const change of [e=>e.divisor=1,e=>e.factors=['f_value'],e=>e.factors=[probability]]){
    const a=plan();change(a.steps[1].outputs[0].expression);
    assert.equal(result(prepare(a,zero)).value,0);assert.equal(assess(i,a,zero).ok,false);
  }
  const scalar=plan();scalar.steps[1].outputs=[{kind:'sum',field:'f_value'}];
  assert.equal(D.assess(i,scalar,prepare(scalar)).ok,false);
});

test('only selected/included/excluded count reads belonging to the calculation are allowed',()=>{
  const a=plan();a.steps.push(read('selected_count','cohort',[count]),
    F.select('included',[[F.where('f_value','is_not_blank'),F.where(probability,'is_not_blank')]],{source:'cohort'}),read('included_count','included',[count]),
    F.select('excluded',[[F.where('f_value','is_blank')],[F.where(probability,'is_blank')]],{source:'cohort'}),read('excluded_count','excluded',[count]));
  assert.equal(assess(intent(),a).ok,true);
  const unrelated=plan();unrelated.steps.push(F.select('others',[]),read('other_count','others',[count]));
  assert.equal(assess(intent(),unrelated).ok,false);
  const noCounts=intent();noCounts.coverage=false;noCounts.counts=[];
  assert.equal(assess(noCounts,plan(noCounts)).ok,true);assert.equal(assess(noCounts,a).ok,false);
});

test('read-only whole intent rejects extra writes, displays, raw reads and unused selections',()=>{
  for(const change of [
    a=>a.steps.push(F.update('change','cohort','f_priority','High')),
    a=>a.steps[1].showTable=true,
    a=>a.steps[1].outputs.push({kind:'sum',field:'f_value'}),
    a=>a.steps[1].outputs.push({kind:'names',field:null}),
    a=>a.steps.push(F.select('unused',[])),
    a=>a.steps[1].outputs.push(calculation(expression)),
    a=>a.steps[0].limit=3,
    a=>a.steps[0].orderBy='f_value'
  ]){
    const a=plan();change(a);assert.equal(D.eligible(a),true);
    assert.equal(assess(intent(),a).ok,false,change.toString());
  }
});

test('only explicit unsupported falls back; malformed, partial or ambiguous complete claims fail closed',()=>{
  const a=plan(),ctx=prepare(a);
  assert.equal(D.assess({...intent(),completeIntent:false},a,ctx).complete,false);
  for(const change of [i=>delete i.completeIntent,i=>i.completeIntent='true',i=>i.ambiguity=true,i=>i.otherRequestedWork=true,
    i=>i.population=null,i=>i.population.source='focus',i=>i.population.extra=1,i=>i.expression.divisor='100',
    i=>i.expression.factors.push(probability),i=>i.expression.factors=['f_owner'],i=>i.extra='also mutate',i=>delete i.coverage,
    i=>i.counts=['other'],i=>i.counts=['included','included'],i=>i.population.where=[[F.where(probability,'gt','0')]],
    i=>i.population.where=[[F.where('f_follow','before_today')]],i=>i.population.where=[[F.where(probability,'is_blank',0)]],
    i=>i.population.where=[[F.where('f_owner','equals',null)]]]){
    const bad=intent();change(bad);const r=D.assess(bad,a,ctx);
    assert.equal(r.complete,true,change.toString());assert.equal(r.ok,false,change.toString());
  }
  assert.equal(D.assess(null,a,ctx).complete,true);
});

test('proof is authenticated against the exact computed object, action and authorized snapshot',()=>{
  const a=plan(),ctx=prepare(a);
  assert.equal(D.assess(intent(),a,ctx).ok,true);
  assert.equal(D.assess(intent(),a,structuredClone(ctx)).ok,false);
  assert.equal(D.assess(intent(),a,{...ctx,computed:structuredClone(ctx.computed)}).ok,false);
  const changed=structuredClone(a);changed.title='Different action';assert.equal(D.assess(intent(),changed,ctx).ok,false);
  for(const change of [c=>result(c).coverage.excludedCount=0,c=>result(c).expression.divisor=1,
    c=>c.pipeline.records[3][probability]=0,c=>c.pipeline.visibleIds.push(4),c=>c.computed.lifecycle.executed=true,
    c=>c.computed.effects.push({kind:'dashboard',board:{elements:[]}})]){
    const c=prepare(a);change(c);assert.equal(D.assess(intent(),a,c).ok,false,change.toString());
  }
});

test('repair feedback includes only the validated bounded typed intent, never a guessed scope',()=>{
  const r=assess(intent(),prefiltered()),expected=JSON.parse(r.issues[0].split(' Expected intent: ')[1]);
  assert.deepEqual(expected,{source:'all',where:scope,expression});
  const invalid=intent();invalid.expression.divisor='100';
  assert.equal(assess(invalid,plan()).issues[0].includes('Expected intent:'),false);
  const oversized=intent([[F.where('f_deal','in',null,['a'.repeat(7000),'b'.repeat(7000)])]]);
  const bounded=assess(oversized,plan());
  assert.equal(bounded.ok,false);assert.match(bounded.issues[0],/bounded repair/);
  assert.equal(bounded.issues[0].includes('Expected intent:'),false);
});

test('coincidentally equal cohorts cannot substitute predicate semantics; equivalent reordered chains pass',()=>{
  const wrong=plan();wrong.steps[0].where[0][0].operator='contains';
  assert.deepEqual(result(prepare(wrong)).selectedRecordIds,result(prepare(plan())).selectedRecordIds);
  assert.match(assess(intent(),wrong).issues[0],/population predicates/);
  const i=intent([[...scope[0],F.where('f_owner','equals','Alex')]]);
  const chained=F.plan([F.select('owner',[[F.where('f_owner','equals','Alex')]]),
    F.select('cohort',scope,{source:'owner'}),read('total','cohort',[calculation(expression)])]);
  assert.equal(assess(i,chained).ok,true);
});
