'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Ratio=require('../lib/ratio-calculation-intent'),Outputs=require('../lib/read-output-contract');
const Review=require('../lib/action-review'),F=require('./fixtures/workspace-plans.cjs');
const Core=require('../public/pipeline-core'),Dashboard=require('../public/dashboard-board');
const commands=[
  'Show the percentage of QA1110 deals that are Won, next to the percentage of their known value that is Won.',
  'For QA1110 deals, give me two percentages: the share of deals that are Won, and the share of known Deal Value that is Won. Show the numerator and denominator for each.',
  'For the East territory, compare the share of completed engagements by count with their share of known billable hours; include both fractions and do not change my dashboard.'
];
const cohort=[[F.where('f_deal','starts_with','QA1110')]],won=[[F.where('f_stage','equals','Closed Won')]];
const aggregate=(metric,field,where=[])=>({metric,field,where:structuredClone(where)});
function intent(){
  return {completeIntent:true,otherRequestedWork:false,ambiguity:false,ratios:[
    {label:'Won record share',population:{source:'all',where:structuredClone(cohort)},
      numerator:aggregate('count',null,won),denominator:aggregate('count',null)},
    {label:'Won known value share',population:{source:'all',where:structuredClone(cohort)},
      numerator:aggregate('sum','f_value',won),denominator:aggregate('sum','f_value')}
  ]};
}
function pipeline(){
  const p={...F.workspace(),workspaceVersion:'current',currentDate:'2026-11-13',visibleIds:[1,2]};
  const template=p.records[0];
  p.records=[15000,18000,22000,8500,2000,0,null].map((value,index)=>({...structuredClone(template),id:index+1,
    f_deal:'QA1110 Deal '+(index+1),f_value:value,f_stage:index?'Qualified':'Closed Won'}));
  p.records.push({...structuredClone(template),id:8,f_deal:'Unrelated',f_value:999999,f_stage:'Closed Won'});
  p.dashboard={board:{version:1,elements:[],sharedFilters:[],activeId:null}};
  return p;
}
const prepare=(action,p=pipeline())=>({pipeline:p,computed:Review.evidence({pipeline:p},{crmAction:action})});
const check=(i,a=Ratio.compile(i,pipeline()),p=pipeline())=>Ratio.assess(i,a,prepare(a,p));
const answer=(action,p=pipeline())=>Review.renderAnswer({pipeline:p},{crmAction:action},prepare(action,p).computed);
const operands=['percentages','numerator','denominator'];

test('both report phrasings and an unrelated-workflow variant use only schema and primary names for independent intent',()=>{
  const p=pipeline();
  for(const command of commands){
    const input=Ratio.input({userCommand:command,pipeline:p,history:['private'],crmAction:Ratio.compile(intent(),p)});
    assert.equal(input.userCommand,command);
    assert.deepEqual(Object.keys(input).sort(),['fields','primaryField','primaryNames','userCommand']);
    assert.equal(JSON.stringify(input).includes('private'),false);
    assert.deepEqual(input.primaryNames,p.records.map(row=>({name:row.f_deal,matches:1})));
  }
  for(const extra of [{pendingAction:{}},{pendingClarification:{}},{userCommand:' '},{userCommand:'x'.repeat(24001)}])
    assert.equal(Ratio.input({pipeline:p,userCommand:commands[1],...extra}),null);
  assert.equal(Ratio.schemaFor(p).additionalProperties,false);
  const numeric=Ratio.schemaFor(p).properties.ratios.items.properties.numerator.anyOf[1].properties.field.enum;
  assert(numeric.includes('f_value'));assert(!numeric.includes('f_owner'));
});

test('paired percentages render both fractions using the existing deterministic executor, with no dashboard changes',()=>{
  const p=pipeline(),i=intent(),a=Ratio.compile(i,p),before=structuredClone({p,i,a}),ctx=prepare(a,p);
  assert.deepEqual(Ratio.assess(i,a,ctx),{complete:true,ok:true,issues:[],requested:2,compiled:2});
  const text=Review.renderAnswer({pipeline:p},{crmAction:a},ctx.computed);
  assert.match(text,/14\.29% \(1 \/ 7 x 100\)/);
  assert.match(text,/22\.9% \(\$15,000\.00 \/ \$65,500\.00 x 100\)/);
  assert.match(text,/7 records represented/);assert.match(text,/6 numeric values/);
  assert.equal(ctx.computed.mutates,false);
  assert(ctx.computed.effects.every(effect=>effect.kind==='table'&&effect.show===false));
  assert.deepEqual({p,i,a},before);
});

test('each computed fraction has its own numerator/denominator capability; raw totals or sibling ratios cannot substitute',()=>{
  const a=Ratio.compile(intent(),pipeline()),ids=Outputs.evidenceIds(a);
  assert(ids.includes('ratio_1/percentage:0'));assert(ids.includes('ratio_2/percentage:0'));
  assert.equal(Outputs.supports(a,['ratio_1/percentage:0'],[...operands,'count']),true);
  assert.equal(Outputs.supports(a,['ratio_2/percentage:0'],[...operands,'sum']),true);
  assert.equal(Outputs.supports(a,['ratio_1/percentage:0'],[...operands,'sum']),false);
  assert.equal(Outputs.supports(a,['ratio_1/percentage:0','ratio_2/percentage:0'],[...operands,'sum']),false);
  for(const id of ['root','ratio_1','ratio_2','ratio_1/percentage:1','ratio_2/percentage:9'])
    assert.equal(Outputs.supports(a,[id],operands),false,id);
  assert.equal(Outputs.supports(a,['ratio_1'],['fields']),false,'Numeric operands are not CRM field projections');
  const raw=structuredClone(a);raw.steps.forEach(s=>s.questions=s.questions.filter(q=>q.kind!=='percentage'));
  assert.equal(Outputs.supports(raw,['ratio_1','ratio_2'],['percentages']),false);
  assert.equal(check(intent(),raw).ok,false);
});

test('same-report paired ratios remain individually identified; one question cannot prove a missing second result',()=>{
  const i=intent(),a=Ratio.compile(i,pipeline()),[count,value]=a.steps;
  count.spec.measures.push(...value.spec.measures.map(m=>({...m,label:'Value '+m.label})));
  const second=structuredClone(value.questions[0]);second.left.elementId=second.right.elementId=count.id;
  second.left.measure=2;second.right.measure=3;count.questions.splice(1,0,second);
  a.steps=[count];a.goals=[a.goals[0]];
  assert.equal(check(i,a).ok,true);
  assert.equal(Outputs.supports(a,['ratio_1/percentage:1'],[...operands,'sum']),true);
  assert.equal(Outputs.supports(a,['ratio_1/percentage:0'],[...operands,'sum']),false);
  const missing=structuredClone(a);missing.steps[0].questions.splice(1,1);missing.steps[0].spec.measures.splice(2);
  assert.equal(check(i,missing).ok,false);
});

test('zero is known value; zero denominator, empty cohorts and all-unknown values never fabricate a zero percent',()=>{
  const p=pipeline();p.records.slice(0,7).forEach(r=>r.f_value=0);
  const a=Ratio.compile(intent(),p),text=answer(a,p);
  assert.match(text,/Won known value share: Not set \(\$0\.00 \/ \$0\.00 x 100\)/);
  const report=a.steps[1],board={version:1,elements:[{id:report.id,spec:report.spec,visibleIds:[]}],sharedFilters:[],activeId:report.id};
  const summary=Dashboard.evaluate(board,p.records,Core.create(p.tableSchema),p.customFields)[0].snapshot.summaries[1];
  assert.equal(summary.numericCount,7,'Every zero is included, not treated as unknown');
  assert.equal(check(intent(),a,p).ok,true);
  p.records.slice(0,7).forEach(r=>r.f_value=null);
  const unknown=answer(a,p);assert.match(unknown,/Won known value share: Not set \(Not set \/ Not set x 100\)/);
  assert.match(unknown,/7 records represented/);assert.match(unknown,/0 numeric values/);
  const empty=intent();empty.ratios.forEach(r=>r.population.where=[[F.where('f_deal','equals','Absent')]]);
  assert.equal(check(empty,Ratio.compile(empty,p),p).ok,true);
  assert.match(answer(Ratio.compile(empty,p),p),/Won record share: Not set \(0 \/ 0 x 100\)/);
  p.records[0].f_value=0;p.records[1].f_value=100;
  assert.match(answer(a,p),/Won known value share: 0% \(\$0\.00 \/ \$100\.00 x 100\)/);
});

test('renamed numeric fields, different cohorts, fractions and disjoint numerator scopes generalize without named-fixture logic',()=>{
  const p=pipeline();p.customFields=[{id:'cf_hours',name:'Billable hours',type:'number'}];
  p.records.forEach((r,index)=>{r.cf_hours=[0,1.5,3,null,99,80,null,400][index];r.f_owner=index<4?'East':'West';});
  const i=intent();i.ratios.forEach(r=>{
    r.population.where=[[F.where('f_owner','equals','East')]];
    r.numerator.where=[[F.where('f_stage','equals','Qualified')]];
  });
  i.ratios[0].label='Completed engagement share';i.ratios[1].label='Completed hours share';
  i.ratios[1].numerator.field=i.ratios[1].denominator.field='cf_hours';
  const a=Ratio.compile(i,p);
  assert.equal(check(i,a,p).ok,true);
  const text=answer(a,p);assert.match(text,/75% \(3 \/ 4 x 100\)/);assert.match(text,/100% \(4\.5 \/ 4\.5 x 100\)/);
  assert.match(text,/4 records represented/);assert.match(text,/3 numeric values/);
  i.ratios[0].population.source='visible';i.ratios[1].population.source='visible';
  const visible=Ratio.compile(i,p);assert.equal(check(i,visible,p).ok,true);
  assert.match(answer(visible,p),/50% \(1 \/ 2 x 100\)/);
  assert.equal(check(i,a,p).ok,false,'All and explicitly visible are different authorized populations');
});

test('independent operand and population contracts reject silent omission, swapped denominators and coincidental totals',()=>{
  for(const change of [
    a=>{a.steps.pop();a.goals.pop();},
    a=>{a.steps[1]=structuredClone(a.steps[0]);a.steps[1].id='ratio_2';a.steps[1].questions[0].left.elementId='ratio_2';a.steps[1].questions[0].right.elementId='ratio_2';a.steps[1].questions[1].elementIds=['ratio_2'];},
    a=>a.steps[0].spec.measures[1].where=won,
    a=>a.steps[1].spec.measures[1].where=[[F.where('f_value','gt',0)]],
    a=>a.steps[0].spec.where=[[F.where('f_deal','contains','QA1110')]],
    a=>{const q=a.steps[1].questions[0];[q.left,q.right]=[q.right,q.left];},
    a=>a.steps[0].showDashboard=true,
    a=>{a.steps.unshift(F.select('cohort',[]),F.update('edit','cohort','f_priority','High'));a.goals=F.plan(a.steps).goals;}
  ]){
    const a=Ratio.compile(intent(),pipeline());change(a);
    assert.equal(check(intent(),a).ok,false,change.toString());
  }
});

test('selection chains are compared as full predicates, never label text or matching record count',()=>{
  const i=intent(),a=Ratio.compile(i,pipeline());
  a.steps.unshift(F.select('cohort',cohort));a.goals=F.plan(a.steps).goals;
  a.steps.filter(s=>s.op==='report').forEach(s=>{s.selection='cohort';s.spec.where=[];});
  assert.equal(check(i,a).ok,true);
  const wrong=structuredClone(a);wrong.steps[0].where[0][0].operator='contains';
  assert.equal(check(i,wrong).ok,false);
});

test('known-value SUM semantics permit only the redundant own-field nonblank predicate, never changing count scope or excluding zero',()=>{
  const i=intent(),a=Ratio.compile(i,pipeline());
  a.steps[1].spec.measures[1].where=[[F.where('f_value','is_not_blank')]];
  assert.equal(check(i,a).ok,true);
  a.steps[0].spec.measures[1].where=[[F.where('f_value','is_not_blank')]];
  assert.equal(check(i,a).ok,false,'A count includes unknown amounts unless explicitly excluded');
  a.steps[0].spec.measures[1].where=[];
  a.steps[1].spec.measures[1].where=[[F.where('f_follow','is_not_blank')]];
  assert.equal(check(i,a).ok,false,'Another missing field is a business filter, not SUM handling');
  a.steps[1].spec.measures[1].where=[[F.where('f_value','gt',0)]];
  assert.equal(check(i,a).ok,false,'Zero is a known value even if removing it leaves the sum unchanged');
});

test('nested dashboard percentages use question-local namespaces, including nonzero question indexes',()=>{
  const a=Ratio.compile(intent(),pipeline()),spec=a.steps[1].spec;
  const q={kind:'percentage',label:'Value share',left:{elementId:'ratio',measure:0,stat:'aggregate'},right:{elementId:'ratio',measure:1,stat:'aggregate'}};
  const board={action:'dashboard_plan',operations:[{op:'add',id:'ratio',spec}],questions:[{kind:'summary',elementIds:['ratio']},q]};
  const action=F.plan([{op:'dashboard',id:'display',label:'Dashboard',plan:board}]);
  assert(Outputs.evidenceIds(action).includes('display/percentage:1'));
  assert.equal(Outputs.supports(action,['display/percentage:1'],operands),true);
  for(const id of ['display','percentage:1','display/graph:ratio','display/percentage:0'])
    assert.equal(Outputs.supports(action,[id],operands),false);
});

test('bounded typed intent compiles all requested fractions or rejects the entire unsupported request',()=>{
  const p=pipeline(),i=intent();
  for(let index=2;index<6;index++)i.ratios.push({...structuredClone(i.ratios[index%2]),label:'Independent share '+index,
    population:{source:'all',where:[[F.where('f_owner','equals','Owner '+index)]]}});
  assert.equal(check(i,Ratio.compile(i,p),p).compiled,6);
  i.ratios.push(structuredClone(i.ratios[0]));
  assert.throws(()=>Ratio.compile(i,p),/incomplete/);
  assert.equal(Ratio.eligible({action:'workspace_plan',steps:[{op:'read_records',outputs:[{kind:'sum',field:'f_value'}]}]}),false);
  const missing=Ratio.compile(intent(),p);missing.steps.pop();missing.goals.pop();
  const failure=check(intent(),missing,p);
  assert.equal(failure.requested,2);assert.equal(failure.compiled,0);
  assert.deepEqual(JSON.parse(failure.issues[0].split(' Expected percentage intent: ')[1]),intent().ratios);
});

test('stale or fabricated evidence and malformed independent complete claims fail closed',()=>{
  const i=intent(),a=Ratio.compile(i,pipeline()),ctx=prepare(a);
  assert.equal(Ratio.assess(i,a,ctx).ok,true);
  assert.equal(Ratio.assess(i,a,structuredClone(ctx)).ok,false);
  for(const change of [c=>c.pipeline.records[0].f_value=1,c=>c.computed.answers.pop(),c=>c.computed.effects.push({kind:'dashboard'})]){
    const c=prepare(a);change(c);assert.equal(Ratio.assess(i,a,c).ok,false);
  }
  for(const change of [x=>x.otherRequestedWork=true,x=>x.ambiguity=true,x=>x.ratios=[],x=>delete x.completeIntent,
    x=>x.ratios[0].numerator.field='f_owner',x=>x.ratios[1].denominator.metric='count',
    x=>x.ratios[0].population.source='focus',x=>x.ratios[0].numerator.where=[[F.where('f_value','gt','0')]]]){
    const bad=intent();change(bad);const result=Ratio.assess(bad,a,ctx);
    assert.equal(result.complete,true);assert.equal(result.ok,false);
    assert(!result.issues[0].includes('Expected percentage intent:'));
  }
  assert.equal(Ratio.assess({...i,completeIntent:false},a,ctx).complete,false);
});

test('cross-graph arithmetic has one question-local operand proof, not operand-graph claims',()=>{
  const spec=Ratio.compile(intent(),pipeline()).steps[1].spec;
  const p={dashboard:{board:{version:1,elements:[{id:'left',spec},{id:'right',spec}],sharedFilters:[],activeId:'left'}}};
  const q={kind:'percentage',label:'Ratio',left:{elementId:'left',measure:0,stat:'aggregate'},right:{elementId:'right',measure:1,stat:'aggregate'}};
  const a={action:'analyze_dashboard',questions:[q]};
  assert(Outputs.evidenceIds(a,{pipeline:p}).includes('percentage:0'));
  assert.equal(Outputs.supports(a,['percentage:0'],operands,{pipeline:p}),true);
  for(const ids of [['root'],['graph:left'],['graph:right'],['graph:left','graph:right']])
    assert.equal(Outputs.supports(a,ids,operands,{pipeline:p}),false);
});
