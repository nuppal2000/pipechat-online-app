'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const N=require('../lib/named-numeric-intent'),Review=require('../lib/action-review');
const Compact=require('../lib/scoped-table-request'),F=require('./fixtures/workspace-plans.cjs');
const names=['QA1105 Cedar Consulting','QA1105 Cedar North','QA1105 Maple Retail','QA1105 Elm Design','Hidden control','Control Other'];
const original='Add a number field called Probability percent. Set it to 50 for QA1105 Cedar Consulting, 80 for QA1105 Cedar North, and 25 for QA1105 Maple Retail.';
const variant='Create a numeric column named QA confidence. Give QA1105 Maple Retail 12.5 and QA1105 Elm Design 0 in that column; leave the other rows blank.';
const intent=(fieldName,entries,leaveOthersBlank)=>({completeIntent:true,fieldName,
  assignments:entries.map(([i,value])=>({name:names[i],value})),leaveOthersBlank,otherRequestedWork:false,ambiguity:false});
const first=intent('Probability percent',[[0,50],[1,80],[2,25]],false),second=intent('QA confidence',[[2,12.5],[3,0]],true);
const add=name=>({op:'add_field',id:'field',label:'Untrusted heading',name,type:'number',options:[]});
function native(i){
  return F.plan([add(i.fieldName),...i.assignments.flatMap(({name,value},n)=>[F.select('row_'+n,[[F.where('f_deal','equals',name)]]),
    F.update('set_'+n,'row_'+n,'@field',value)])]);
}
function compact(i){
  return Compact.compile({action:'scoped_table_request',title:'Untrusted proposal',source:'all',where:[],
    operation:{kind:'add_named_numbers',name:i.fieldName,entries:i.assignments.map(a=>({recordName:a.name,value:a.value}))}});
}
function prepare(action,edit){
  const pipeline={...F.workspace(),visibleIds:[1],workspaceVersion:'current',currentDate:'2026-11-10'};
  pipeline.records.forEach((r,i)=>{r.f_deal=names[i];});edit?.(pipeline);
  return {pipeline,computed:Review.evidence({pipeline},{crmAction:action})};
}
for(const [label,build] of [['expanded compact',compact],['native',native]])for(const [command,i] of [[original,first],[variant,second]]){
  test(label+' independently matches: '+command,()=>{
    const a=build(i),ctx=prepare(a);
    assert.equal(N.eligible(a),true);assert.deepEqual(N.input({userCommand:command,pipeline:ctx.pipeline}),{userCommand:command});
    assert.equal(N.matches({...i,assignments:i.assignments.toReversed()},a,ctx),true);
    assert.equal(ctx.computed.lifecycle.requiresConfirmation,true);assert.equal(ctx.computed.lifecycle.writesApplied,0);
  });
}

test('input is a bounded projection of user text, never the suggested solution or hidden history',()=>{
  const payload={userCommand:'Use zero for Elm.',pendingClarification:{originalCommand:variant,question:'Planner proposed secret',options:['secret'],
    answers:[{question:'Planner suggestion',answer:'Keep the original field name.'}]},pipeline:{records:[{name:'secret',notes:'sensitive'}]},
    proposedField:'secret',compiled:native(first),computed:{numericAssignmentEvidence:['secret']},conversationHistory:['secret'],clarificationAnswer:{selectedMeaning:'secret'}};
  assert.deepEqual(N.input(payload),{userCommand:payload.userCommand,pendingClarification:{originalCommand:variant,answers:['Keep the original field name.']}});
  for(const p of [{...payload,pendingAction:{steps:[]}}, {...payload,userCommand:' '},{...payload,pendingClarification:{answers:[]}},
    {...payload,pendingClarification:{originalCommand:variant,answers:[{answer:{value:1}}]}},
    {...payload,userCommand:'x'.repeat(24000)}])assert.equal(N.input(p),null);
  assert.equal(N.schema.additionalProperties,false);assert.equal(N.schema.properties.assignments.items.additionalProperties,false);
  assert.deepEqual(Object.keys(second).sort(),N.schema.required.toSorted());
});

test('incomplete, mixed, malformed and ambiguous independent intents never authorize a numeric subset',()=>{
  const a=native(second),ctx=prepare(a);
  for(const edit of [i=>i.completeIntent=false,i=>i.otherRequestedWork=true,i=>i.ambiguity=true,i=>delete i.leaveOthersBlank,
    i=>i.completeIntent='yes',i=>i.leaveOthersBlank=null,i=>i.fieldName=null,i=>i.fieldName='QA Confidence',i=>i.extra='also sort',
    i=>i.assignments[0].value='12.5',i=>i.assignments[1].value=false,i=>i.assignments[1].value=NaN,i=>i.assignments[1].value=Infinity,
    i=>i.assignments[0].name='QA1105 Maple',i=>i.assignments[0].id=3,i=>i.assignments[0].value=12,i=>i.assignments.reverse().forEach((r,n)=>r.value=second.assignments[n].value),
    i=>i.assignments.pop(),i=>i.assignments=[],i=>i.assignments.push({name:names[4],value:0}),i=>i.assignments[1].name=i.assignments[0].name.toUpperCase()]){
    const wrong=structuredClone(second);edit(wrong);assert.equal(N.matches(wrong,a,ctx),false,edit.toString());
  }
});

test('every final nonblank cell counts, even zero on a hidden control or an unrequested name in a native selection',()=>{
  for(const leaveOthersBlank of [true,false]){
    const extra=intent(second.fieldName,[[2,12.5],[3,0],[4,0]],leaveOthersBlank),a=compact(extra),ctx=prepare(a);
    assert.equal(ctx.computed.numericAssignmentEvidence[0].populatedCount,3);
    assert.equal(N.matches({...second,leaveOthersBlank},a,ctx),false);
  }
  const wrong=native(second);wrong.steps[1].where=[[F.where('f_deal','in',null,[names[2],'Nonexistent target'])]];
  assert.equal(N.matches(second,wrong,prepare(wrong)),false);
  const dup=native(second);
  assert.equal(N.matches(second,dup,prepare(dup,p=>{p.records[5].f_deal=names[2].toUpperCase();})),false);
});

test('a named set with one shared literal is valid; a scope that coincidentally gives the right rows is not',()=>{
  const i=intent('Score',[[2,0],[3,0]],true),a=F.plan([add('Score'),F.select('pair',[[F.where('f_deal','in',null,[names[3],names[2]])]]),
    F.update('set_pair','pair','@field',0)]);
  assert.equal(N.matches(i,a,prepare(a)),true);
  const wrong=native(second);wrong.steps[1].where=[[F.where('f_owner','equals','Only Maple')]];
  assert.equal(N.matches(second,wrong,prepare(wrong,p=>{p.records[2].f_owner='Only Maple';})),false);
});

test('structural gate rejects any extra reads, displays, schema, writes, selection effects or unconsumed selections',()=>{
  const root=native(second);
  for(const step of [
    {id:'read',op:'read_records',selection:'row_0',label:'No display',showTable:false,outputs:[{kind:'count',field:null}]},
    {id:'show',op:'read_records',selection:'row_0',label:'Display',showTable:true,outputs:[{kind:'names',field:null}]},
    F.select('orphan'),{...add('Extra'),id:'more'},F.tasks('task','row_0'),F.update('extra','row_0','f_notes','hi'),
    {id:'dashboard',op:'dashboard',label:'Create chart'},{id:'export',op:'export_records',label:'Export'}]){
    const a=F.plan([...root.steps,step]);assert.equal(N.eligible(a),false,step.op);assert.equal(N.matches(second,a,{}),false);
  }
  for(const edit of [a=>a.steps[1].source='visible',a=>a.steps[1].source='focus',a=>a.steps[1].showTable=true,
    a=>a.steps[1].orderBy='f_value',a=>a.steps[1].relatedTasks='none',a=>a.steps[2].assignments[0].operation='adjust_percent',
    a=>a.steps[2].assignments.push({field:'f_notes',operation:'set',value:'x'}),a=>a.steps[0].type='text',
    a=>a.unmappedFacts=[{text:'extra obligation'}]]){
    const a=structuredClone(root);edit(a);assert.equal(N.eligible(a),false,edit.toString());
  }
  const overwritten=F.plan([...root.steps,F.update('restore','row_0','@field',12.5)]);
  assert.equal(N.matches(second,overwritten,prepare(overwritten)),false);
});

test('no authority from planner text, a prior action, tampered proofs, or an unbound/stale full snapshot',()=>{
  const a=native(second),ctx=prepare(a);
  assert.equal(N.matches(second,a,{...ctx,computed:structuredClone(ctx.computed)}),false);
  assert.equal(N.matches(second,a,{...ctx,pipeline:structuredClone(ctx.pipeline)}),false);
  const wrong=native(first);wrong.title=variant;assert.equal(N.matches(second,wrong,ctx),false);
  const edited=prepare(a);edited.computed.numericAssignmentEvidence[0].populatedCount=1;assert.equal(N.matches(second,a,edited),false);
  const stale=prepare(a);stale.pipeline.records[5].f_notes='unseen change';assert.equal(N.matches(second,a,stale),false);
  const fabricated=native(second);fabricated.steps[2].label='Maple gets 12.5';fabricated.steps[2].assignments[0].value=125;
  assert.equal(N.matches(second,fabricated,prepare(fabricated)),false);
});
