'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Intent=require('../lib/conditional-classification-intent'),Review=require('../lib/action-review');
const Plan=require('../public/workspace-plan'),Scoped=require('../lib/scoped-table-request'),F=require('./fixtures/workspace-plans.cjs');
const intent=()=>({completeIntent:true,source:'all',where:[[F.where('f_deal','starts_with','Segment')]],numberField:'f_value',operator:'gte',threshold:15000,
  targetField:'f_priority',whenTrue:'High',otherwise:'Medium',whenBlank:'unchanged',otherRequestedWork:false,ambiguity:false});
function pipeline(){
  const p={...F.workspace(),currentDate:'2026-11-10',workspaceVersion:'v1',visibleIds:[1,2]};
  p.records=[null,0,14000,15000,20000].map((value,i)=>({...p.records[0],id:i+1,f_deal:'Segment '+i,f_value:value,f_priority:'Low'}));return p;
}
function plan(i=intent()){
  const {numberField,operator,threshold,targetField,whenTrue,otherwise,whenBlank}=i;
  return Scoped.compile({action:'scoped_table_request',title:'Classify',source:i.source,where:i.where,
    operation:{kind:'classify_number',numberField,operator,threshold,targetField,whenTrue,otherwise,whenBlank}});
}
const context=(a,p=pipeline())=>({pipeline:p,computed:Review.evidence({pipeline:p},{crmAction:a})});

test('transport is limited to numeric conditional updates, while malformed/incomplete candidates still reach proof',()=>{
  const ordinary=F.plan([F.select('rows'),F.update('edit','rows','f_priority','High')]);assert(!Intent.eligible(ordinary));
  ordinary.steps[0].where=[[F.where('f_deal','starts_with','Segment')]];assert(!Intent.eligible(ordinary));
  ordinary.steps[0].where=[[F.where('f_value','gte',15000)]];assert(Intent.eligible(ordinary),'one branch remains eligible');
  ordinary.steps[0].source='focus';assert(Intent.eligible(ordinary));
  ordinary.steps.push({op:'read_records',id:'read',label:'Extra projection',selection:'rows',outputs:[{kind:'names',field:null}],showTable:true});
  assert(Intent.eligible(ordinary));assert(!Intent.eligible(F.plan([F.select('rows',[[F.where('f_value','gte',15000)]])])));
});

test('native branches, reversed write order and commuting cohort predicates match the independent classification',()=>{
  const i=intent();i.where[0].push(F.where('f_owner','equals','Alex'));
  const a=F.plan([F.select('lower',[[F.where('f_value','lt',15000),...i.where[0].slice().reverse()]]),
    F.select('upper',[[...i.where[0],F.where('f_value','gte',15000)]]),
    F.update('medium','lower','f_priority','Medium'),F.update('high','upper','f_priority','High')]);
  assert(Intent.assess(i,a,context(a)).ok);
  const compiled=Scoped.compile(a);assert(Intent.assess(i,compiled,context(compiled)).ok);
});

test('OR cohort and reversed true/otherwise conventions preserve exact rule meaning',()=>{
  const i=intent();i.where.push([F.where('f_owner','equals','Jordan')]);
  const swapped={...i,where:i.where.slice().reverse(),operator:'lt',whenTrue:'Medium',otherwise:'High'},a=plan(swapped);
  assert(Intent.assess(i,a,context(a)).ok);
});

test('already-correct, all-unknown and empty cohorts retain complete no-op proofs',()=>{
  for(const kind of ['correct','unknown','empty']){
    const p=pipeline(),i=intent(),a=plan(i);
    p.records.forEach(r=>{if(kind==='empty')r.f_deal='Outside';else if(kind==='unknown')r.f_value=null;else if(r.f_value!==null)r.f_priority=r.f_value>=15000?'High':'Medium';});
    const c=context(a,p);assert.deepEqual(c.computed.patches,[]);assert(Intent.assess(i,a,c).ok,kind);
  }
});

test('patch ordering is irrelevant but every original and final value remains part of exact proof',()=>{
  const original=Plan.prepare;
  try{for(const corrupt of [false,true]){
    let calls=0;
    Plan.prepare=(...args)=>{const result=original(...args);if(calls++===0){result.patches.reverse();if(corrupt)result.patches[0].changes[0].before='Incorrect original';}return result;};
    const i=intent(),a=plan(i),c=context(a);assert.equal(Intent.assess(i,a,c).ok,!corrupt);
  }}finally{Plan.prepare=original;}
});

test('malformed complete claims fail closed and mismatch feedback preserves full actionable typed intent',()=>{
  const i=intent(),a=plan({...i,source:'focus'}),p=pipeline();p.conversationFocus={kind:'table',ids:[1,2]};const c=context(a,p);
  for(const invalid of [null,{}, {...i,completeIntent:'true'},{...i,threshold:null},{...i,targetField:'f_value'}]){
    const result=Intent.assess(invalid,a,c);assert.equal(result.complete,true);assert.equal(result.ok,false);
  }
  assert.equal(Intent.assess({...i,completeIntent:false},a,c).complete,false);
  const feedback=Intent.assess(i,a,c).issues.join('\n');
  for(const key of ['"source":"all"','"numberField":"f_value"','"operator":"gte"','"threshold":15000','"targetField":"f_priority"','"whenTrue":"High"','"otherwise":"Medium"','"whenBlank":"unchanged"','"where"'])assert(feedback.includes(key),key);
});

test('unsupported pending context and oversized current input do not enter independent extraction',()=>{
  const payload={userCommand:'Classify the Segment deals',pipeline:pipeline()};
  assert(Intent.input(payload));assert.equal(Intent.input({...payload,pendingAction:{}}),null);
  assert.equal(Intent.input({...payload,pendingClarification:{originalCommand:'Prior user request'}}),null);
  assert.equal(Intent.input({...payload,userCommand:'x'.repeat(25000)}),null);
  const schema=Intent.schemaFor(payload.pipeline);
  const visit=s=>{if(s.type==='object'){assert.equal(s.additionalProperties,false);assert.deepEqual(s.required,Object.keys(s.properties));Object.values(s.properties).forEach(visit);}if(s.items)visit(s.items);if(s.anyOf)s.anyOf.forEach(visit);};visit(schema);
  assert.match(Intent.instructions,/ENTIRE current request/);assert.match(Intent.instructions,/No proposed plan/);
});
