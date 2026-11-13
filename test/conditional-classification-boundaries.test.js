'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Intent=require('../lib/conditional-classification-intent'),Review=require('../lib/action-review');
const Scoped=require('../lib/scoped-table-request'),F=require('./fixtures/workspace-plans.cjs');
const command='For all Segment deals, set Priority to High when value is at least 15000, otherwise Medium. Leave unknown values unchanged.';
const intent=(extra={})=>({completeIntent:true,source:'all',where:[[F.where('f_deal','starts_with','Segment ')]],
  numberField:'f_value',operator:'gte',threshold:15000,targetField:'f_priority',whenTrue:'High',otherwise:'Medium',
  whenBlank:'unchanged',otherRequestedWork:false,ambiguity:false,...extra});
function workspace(){
  const p={...F.workspace(),currentDate:'2026-11-10',workspaceVersion:'boundary-v1',visibleIds:[1,2,3,4,5,6],
    conversationFocus:{kind:'table',ids:[1,2,3,4,5,6]}};
  p.records=[null,0,14999.99,15000,20000,30000,25000,90000].map((value,i)=>({...p.records[0],id:i+1,
    f_deal:(i<7?'Segment ':'Outside ')+(i+1),f_value:value,f_priority:i===5||i===6?'High':'Low'}));
  return p;
}
function plan(i=intent(),source=i.source){
  const {numberField,operator,threshold,targetField,whenTrue,otherwise,whenBlank}=i;
  return Scoped.compile({action:'scoped_table_request',title:'Untrusted planner title',source,where:structuredClone(i.where),
    operation:{kind:'classify_number',numberField,operator,threshold,targetField,whenTrue,otherwise,whenBlank}});
}
const prepare=(action,pipeline=workspace())=>({pipeline,computed:Review.evidence({pipeline},{crmAction:action})});
const ids=(context,selection)=>context.computed.review.find(s=>s.id===selection).records.map(r=>r.id).sort((a,b)=>a-b);
const assess=(i,action,context)=>Intent.assess(i,action,context);

test('complete classification covers all seven cohort rows and both no-op assignments',()=>{
  const i=intent(),a=plan(i),p=workspace(),before=structuredClone(p),context=prepare(a,p);
  assert.equal(Intent.eligible(a),true);
  assert.deepEqual(ids(context,'population'),[1,2,3,4,5,6,7]);
  assert.deepEqual(ids(context,'match'),[4,5,6,7]);
  assert.deepEqual(ids(context,'otherwise'),[2,3]);
  assert.deepEqual(context.computed.patches.map(p=>p.id),[2,3,4,5]);
  const result=assess(i,a,context);assert.equal(result.complete,true);assert.equal(result.ok,true);
  assert.deepEqual(p,before);assert.equal(context.computed.lifecycle.writesApplied,0);
});

test('wrong focus remains eligible for independent review and rejects omission of an already-correct row',()=>{
  const i=intent(),all=plan(i),focused=plan(i,'focus'),good=prepare(all),bad=prepare(focused);
  assert.deepEqual(bad.computed.patches,good.computed.patches);
  assert.deepEqual(ids(bad,'population'),[1,2,3,4,5,6]);
  assert.deepEqual(ids(bad,'match'),[4,5,6]);
  assert.equal(Intent.eligible(focused),true,'rejecting at transport eligibility would fall through to generic review');
  assert.equal(assess(i,focused,bad).complete,true);
  assert.equal(assess(i,focused,bad).ok,false);
});

test('an unrequested read remains eligible and requires repair instead of generic-review bypass',()=>{
  const i=intent(),a=plan(i);
  a.steps.push({op:'read_records',id:'extra',label:'Extra answer',selection:'population',showTable:false,outputs:[{kind:'count',field:null}]});
  a.goals.push({description:'Extra answer',stepIds:['extra']});
  assert.equal(Intent.eligible(a),true);
  const result=assess(i,a,prepare(a));
  assert.equal(result.complete,true);assert.equal(result.ok,false);
});

test('omitted unknown root rows and coincidentally identical focus populations cannot prove all-record scope',()=>{
  for(const focus of [[2,3,4,5,6,7],[1,2,3,4,5,6,7]]){
    const i=intent(),a=plan(i,'focus'),p=workspace();p.conversationFocus.ids=focus;
    const bad=prepare(a,p),good=prepare(plan(i));
    assert.deepEqual(bad.computed.patches,good.computed.patches);
    assert.deepEqual(ids(bad,'match'),ids(good,'match'));
    assert.deepEqual(ids(bad,'otherwise'),ids(good,'otherwise'));
    assert.equal(assess(i,a,bad).ok,false);
  }
  const i=intent({source:'visible'}),a=plan(i);
  assert.equal(assess(i,a,prepare(a)).ok,true,'explicit visible intent remains supported');
});

test('coincidentally equal rows and patches do not excuse the wrong threshold or cohort predicate',()=>{
  const i=intent(),good=prepare(plan(i));
  for(const wrong of [intent({threshold:14999.999}),intent({where:[[F.where('f_deal','contains','Segment ')]]})]){
    const a=plan(wrong),bad=prepare(a);
    assert.deepEqual(bad.computed.patches,good.computed.patches);
    assert.deepEqual(ids(bad,'match'),ids(good,'match'));
    assert.deepEqual(ids(bad,'otherwise'),ids(good,'otherwise'));
    assert.equal(assess(i,a,bad).ok,false);
  }
});

test('zero and decimal boundaries partition numeric rows exactly while blanks and unknowns stay outside',()=>{
  for(const [operator,upper,lower] of [['gte',[3,4,5],[2]],['gt',[5],[2,3,4]],['lt',[2],[3,4,5]],['lte',[2,3,4],[5]]]){
    const i=intent({operator,threshold:0}),a=plan(i),p=workspace();
    [null,-0.01,0,0,0.01,'','unavailable'].forEach((value,index)=>{p.records[index].f_value=value;});
    const context=prepare(a,p);
    assert.deepEqual(ids(context,'match'),upper);assert.deepEqual(ids(context,'otherwise'),lower);
    assert.equal(assess(i,a,context).ok,true,operator);
    assert(context.computed.patches.every(p=>[2,3,4,5].includes(p.id)));
  }
});

test('missing branches, extra writes and swapped literals cannot authorize a partial classification',()=>{
  for(const edit of [a=>{a.steps=a.steps.filter(s=>!['otherwise','apply_otherwise'].includes(s.id));a.goals=a.goals.filter(g=>!g.stepIds.includes('apply_otherwise'));},
    a=>a.steps.find(s=>s.id==='apply_match').assignments[0].value='Medium',
    a=>{a.steps.push(F.update('extra','population','f_notes','Unrequested edit'));a.goals.push({description:'Extra edit',stepIds:['extra']});}]){
    const i=intent(),a=plan(i);edit(a);
    assert.equal(assess(i,a,prepare(a)).ok,false,edit.toString());
  }
});

test('unsupported or ambiguous independent intent never authorizes the numeric subset',()=>{
  const a=plan(),context=prepare(a);
  const unsupported={completeIntent:false,source:null,where:[],numberField:null,operator:null,threshold:null,
    targetField:null,whenTrue:null,otherwise:null,whenBlank:null,otherRequestedWork:true,ambiguity:false};
  assert.equal(assess(unsupported,a,context).complete,false);
  for(const i of [unsupported,intent({otherRequestedWork:true}),intent({ambiguity:true}),intent({whenBlank:'Medium'}),
    intent({threshold:'15000'}),intent({targetField:'missing_field'}),intent({whenTrue:'Unavailable choice'})]){
    assert.equal(assess(i,a,context).ok,false);
  }
});

test('copied, stale or edited snapshots and changed actions cannot supply authority',()=>{
  for(const edit of [(a,c)=>c.computed=structuredClone(c.computed),(a,c)=>c.pipeline=structuredClone(c.pipeline),
    (a,c)=>c.pipeline.records[7].f_notes='Changed outside the cohort',
    (a,c)=>c.computed.review.find(s=>s.id==='match').records.pop(),
    (a,c)=>c.computed.recordUpdateEvidence[0].selectedCount++,
    a=>a.steps.find(s=>s.id==='apply_match').assignments[0].value='Low']){
    const i=intent(),a=plan(i),context=prepare(a);assert.equal(assess(i,a,context).ok,true);
    edit(a,context);assert.equal(assess(i,a,context).ok,false,edit.toString());
  }
});

test('extractor input contains only user text and schema, not rows, prior AI text or a proposed solution',()=>{
  const p=workspace();p.records[0].f_notes='SECRET_ROW';
  const payload={userCommand:command,pipeline:p,conversationHistory:['SECRET_HISTORY'],conversationMemory:'SECRET_MEMORY',
    proposalMessage:'SECRET_PROPOSAL',compiled:{title:'SECRET_PLAN'},computed:{patches:['SECRET_COMPUTED']}};
  const input=Intent.input(payload),json=JSON.stringify(input);
  assert(input);assert.equal(input.userCommand,command);
  assert.match(json,/f_value/);assert.match(json,/f_priority/);
  assert.doesNotMatch(json,/SECRET_|Segment 1|Outside 8|conversationFocus|visibleIds/);
  assert.equal(Intent.input({...payload,pendingAction:{action:'workspace_plan'}}),null);
  assert.equal(Intent.input({...payload,pendingClarification:{originalCommand:command,answers:[]}}),null);
  const schema=Intent.schemaFor(p);
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual(schema.required.toSorted(),[...Object.keys(intent()),'rules','whenUnmatched'].toSorted());
});
