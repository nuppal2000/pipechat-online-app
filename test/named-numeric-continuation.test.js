'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const N=require('../lib/named-numeric-intent'),Review=require('../lib/action-review'),Plan=require('../public/workspace-plan');
const F=require('./fixtures/workspace-plans.cjs');

// These are offline typed-intent fixtures, not assertions about a live model's
// natural-language extraction. The original command stays as a regression input.
const cases=[
  {command:'Set Seats to 12 for QA1113 Copper Books and 0 for QA1113 Silver Cafe. Leave the rest blank.',
    field:'Seats',names:['QA1113 Copper Books','QA1113 Silver Cafe'],values:[12,0],
    reply:'Update only those two records. Every other Seats cell is already blank; preserve those cells.'},
  {command:'In Signed variance, give Project 20 -7.125 and Project 2 0. Keep every other cell unchanged.',
    field:'Signed variance',names:['Project 20','Project 2'],values:[-7.125,0],leaveOthersBlank:false,
    reply:'Only the two projects I named. Preserve the rest.'},
  {command:'Preview Delivery days of 0 for North Harbor and 23.5 for East Harbor; leave the remaining values blank.',
    field:'Delivery days',names:['North Harbor','East Harbor'],values:[0,23.5],
    reply:'Keep the other rows empty. Use the original values for those two accounts.'}
];
const typed=(c=cases[0])=>({completeIntent:true,operation:'assign',fieldName:c.field,
  assignments:c.names.map((name,index)=>({name,value:c.values[index]})),leaveOthersBlank:c.leaveOthersBlank??true,otherRequestedWork:false,ambiguity:false});
function fixture(c=cases[0]){
  const pipeline={...F.workspace(),currentDate:'2026-11-13',workspaceVersion:'numeric-snapshot',visibleIds:[67],conversationFocus:{kind:'table',ids:[67]}};
  pipeline.customFields=[{id:'cf_license',name:'License seats',type:'number'},{id:'cf_target',name:c.field,type:'number'}];
  pipeline.records=Array.from({length:67},(_,index)=>({...structuredClone(pipeline.records[0]),id:index+1,
    f_deal:c.names[index]??'Unrelated '+index,cf_target:null,cf_license:index===0?12:null}));
  return pipeline;
}
function prove(action,pipeline){return {pipeline,computed:Review.evidence({pipeline},{crmAction:action})};}
function preview(action,pipeline){return Plan.prepare(pipeline,action,{nonce:'numeric_client',today:pipeline.currentDate,visibleIds:pipeline.visibleIds,focus:pipeline.conversationFocus});}

for(const c of cases)test('full-snapshot typed preparation: '+c.command,()=>{
  const pipeline=fixture(c),before=structuredClone(pipeline),intent=typed(c),{action,computed,assessment}=N.prepare(intent,pipeline);
  assert.deepEqual(N.input({userCommand:c.command,pipeline}),{userCommand:c.command});
  assert.deepEqual(assessment,{complete:true,ok:true,requested:2,compiled:2,issues:[]});
  assert.equal(computed.lifecycle.authorization,'prepare_only');assert.equal(computed.lifecycle.writesApplied,0);
  assert.equal(computed.lifecycle.requiresConfirmation,true);assert.equal(computed.addedFields.length,0);
  assert.deepEqual(computed.numericAssignmentEvidence.map(p=>p.cells.map(cell=>[cell.recordId,cell.fieldId,cell.after])),
    c.values.map((value,index)=>[[index+1,'cf_target',value]]));
  const next=preview(action,pipeline).next;
  assert.deepEqual(next.records,before.records.map((row,index)=>({...row,cf_target:c.values[index]??null})));
  assert.equal(next.records[0].cf_license,12);assert.deepEqual(next.customFields,before.customFields);
  assert.deepEqual(next.todoCards,before.todoCards);assert.deepEqual(pipeline,before);
});

for(const c of cases)test('user-only clarification continuation: '+c.reply,()=>{
  const payload={userCommand:c.reply,pipeline:fixture(c),pendingAction:{action:'workspace_plan',title:'ASSISTANT_PROPOSAL',steps:[{value:999}]},
    pendingClarification:{originalCommand:c.command,question:'ASSISTANT_QUESTION: set every value to 999?',options:[{key:'a',label:'ASSISTANT_CHOICE'}],
      previousAction:{value:999},answers:[{question:'ASSISTANT_PRIOR_QUESTION',answer:'Keep the original column and the supplied numbers.'}]},
    clarificationAnswer:{selectedMeaning:'ASSISTANT_RESOLVED_MEANING'},conversationHistory:[{role:'assistant',content:'ASSISTANT_HISTORY'}]};
  const input=N.input(payload);
  assert.deepEqual(input,{userCommand:c.reply,pendingClarification:{originalCommand:c.command,answers:['Keep the original column and the supplied numbers.']}});
  assert.doesNotMatch(JSON.stringify(input),/ASSISTANT_|999/);
  const prepared=N.prepare(typed(c),payload.pipeline);
  assert.equal(prepared.assessment.ok,true);assert.equal(prepared.assessment.requested,2);
  assert.equal(N.input({...payload,pendingClarification:null}),null,'a prior proposal alone cannot supply missing user intent');
  assert.equal(N.input({...payload,pendingClarification:{question:c.command}}),null,'assistant questions are not an original user command');
  assert.equal(N.input({...payload,pendingClarification:{originalCommand:c.command,answers:[{answer:{selectedMeaning:c.reply}}]}}),null);
});

test('the extraction contract distinguishes preservation from extra work without accepting absent assistant meanings',()=>{
  assert.match(N.instructions,/preservation constraints, not extra actions or reasons to clarify/);
  assert.match(N.instructions,/user need not repeat the word numeric or number/);
  assert.match(N.instructions,/self-contained clarification answer/);
  assert.match(N.instructions,/bare affirmation/);
  assert.match(N.instructions,/absent assistant suggestion/);
  assert.match(N.instructions,/complete independent new request replaces the old/);
  const payload={userCommand:'Yes.',pendingClarification:{originalCommand:'Update those records.',question:cases[0].command}};
  assert.deepEqual(N.input(payload),{userCommand:'Yes.',pendingClarification:{originalCommand:'Update those records.',answers:[]}});
  const unsupported={completeIntent:false,operation:null,fieldName:null,assignments:[],leaveOthersBlank:false,otherRequestedWork:false,ambiguity:true};
  assert.equal(N.assess(unsupported,null,{pipeline:fixture()}).complete,false);
  assert.throws(()=>N.prepare(unsupported,fixture()),/complete, unambiguous/);
});

test('candidate selection variants reach independent intent but cannot borrow proof for a coincidental population',()=>{
  const pipeline=fixture(),intent=typed(),canonical=N.compile(intent,pipeline);
  const chained=F.plan([F.select('all_rows'),...intent.assignments.flatMap(({name,value},index)=>[
    F.select('row_'+index,[[F.where('f_deal','equals',name)]],{source:'all_rows'}),F.update('set_'+index,'row_'+index,'cf_target',value)])]);
  const fuzzy=structuredClone(chained);fuzzy.steps[1].where[0][0].operator='contains';
  const narrowed=structuredClone(canonical);narrowed.steps[0].source='focus';
  const partial=F.plan(canonical.steps.slice(0,2));
  const swapped=structuredClone(canonical);swapped.steps[1].assignments[0].value=0;
  const wrongField=structuredClone(canonical);wrongField.steps[1].assignments[0].field='cf_license';
  for(const action of [chained,fuzzy,narrowed,partial,swapped,wrongField]){
    assert.equal(N.candidateEligible(action),true);
    const context=prove(action,pipeline),result=N.assess(intent,action,context);
    assert.equal(result.complete,true);assert.equal(result.ok,false);assert.equal(result.compiled,0);
    assert.deepEqual(result.expectedAction,canonical);
    const repaired=N.prepare(intent,pipeline);
    assert.equal(N.matches(intent,repaired.action,{pipeline,computed:repaired.computed}),true);
    assert.equal(repaired.assessment.compiled,2);
  }
  assert.equal(N.eligible(chained),false,'the broader candidate gate is not authorization');
});

test('candidate gating leaves mixed actions, transforms, blanks and unmapped work to the general contract',()=>{
  const base=N.compile(typed(),fixture());
  for(const extra of [F.tasks('extra','number_target_0'),
    {id:'answer',op:'read_records',label:'Read',selection:'number_target_0',showTable:false,outputs:[{kind:'names',field:null}]}]){
    assert.equal(N.candidateEligible(F.plan([...base.steps,extra])),false);
  }
  for(const edit of [a=>a.unmappedFacts=[{text:'Also do more'}],a=>a.steps[1].assignments[0].operation='adjust_percent',
    a=>a.steps[1].assignments[0].value='',a=>a.steps[1].assignments[0].value=false,
    a=>a.steps[1].assignments.push({field:'f_notes',operation:'set',value:'more'}),a=>a.steps[0].showTable=true]){
    const action=structuredClone(base);edit(action);assert.equal(N.candidateEligible(action),false,edit.toString());
  }
});

test('missing, ambiguous and invalid typed identities fail closed with no replacement plan',()=>{
  for(const edit of [i=>i.assignments[0].name='Copper',i=>i.assignments[0].name='Missing record',
    i=>i.assignments[1].name=i.assignments[0].name.toUpperCase(),i=>i.fieldName='Seat',i=>i.fieldName='Value',
    i=>i.assignments[0].value='12',i=>i.assignments[0].value=Infinity,i=>i.assignments[0].value=1e13,
    i=>i.otherRequestedWork=true,i=>i.ambiguity=true,i=>i.assignments=[],i=>i.extra='unrecognized']){
    const intent=typed();edit(intent);
    assert.throws(()=>N.prepare(intent,fixture()),undefined,edit.toString());
    assert.equal(N.assess(intent,null,{pipeline:fixture()}).expectedAction,undefined);
  }
  for(const edit of [p=>p.records[66].f_deal=cases[0].names[0].toUpperCase(),p=>p.records[66].id=1,
    p=>p.customFields[1].type='text']){
    const pipeline=fixture();edit(pipeline);assert.throws(()=>N.prepare(typed(),pipeline));
    assert.equal(N.assess(typed(),null,{pipeline}).expectedAction,undefined);
  }
});

test('preserve blank is checked against every saved cell, never against the user assertion or visible rows',()=>{
  for(const value of [0,9,-2.5,'0',' ']){
    const pipeline=fixture();pipeline.records[65].cf_target=value;const before=structuredClone(pipeline);
    assert.throws(()=>N.prepare(typed(),pipeline),/Unmentioned cells are populated/);
    assert.equal(N.assess(typed(),null,{pipeline}).expectedAction,undefined);
    const intent={...typed(),leaveOthersBlank:false},ready=N.prepare(intent,pipeline);
    assert.equal(preview(ready.action,pipeline).next.records[65].cf_target,value);
    assert.deepEqual(pipeline,before);
  }
  const pipeline=fixture();pipeline.records[65].cf_target='';delete pipeline.records[66].cf_target;
  assert.equal(N.prepare(typed(),pipeline).assessment.ok,true);
});

test('zero and other already-satisfied assignments still require full evidence without phantom patches',()=>{
  const pipeline=fixture();pipeline.records[0].cf_target=12;pipeline.records[1].cf_target=0;
  const {action,computed,assessment}=N.prepare(typed(),pipeline);
  assert.equal(assessment.requested,2);assert.equal(assessment.compiled,2);assert.deepEqual(computed.patches,[]);
  assert.equal(computed.lifecycle.writesApplied,0);assert.equal(computed.lifecycle.requiresConfirmation,false);
  assert.equal(computed.numericAssignmentEvidence.length,2);
  assert.equal(N.matches(typed(),action,{pipeline,computed:structuredClone(computed)}),false);
  pipeline.records[66].cf_license=1;
  assert.equal(N.matches(typed(),action,{pipeline,computed}),false,'even unrelated snapshot changes invalidate the proof');
});

test('normalization handles exact field labels and single-record transport without changing meaning',()=>{
  const pipeline=fixture(),before=structuredClone(pipeline);
  const action={action:'update_record',recordMatch:cases[0].names[1],field:'Seats',value:'0'};
  const normalized=N.normalizeAction(action,pipeline),intent={...typed(),assignments:[typed().assignments[1]]};
  assert.equal(normalized.action,'workspace_plan');assert.equal(normalized.steps[1].assignments[0].field,'cf_target');
  assert.equal(normalized.steps[1].assignments[0].value,0);assert.equal(N.matches(intent,normalized,prove(normalized,pipeline)),true);
  for(const extra of [{field:'Seat'},{recordMatch:'Silver'},{ids:[1]},{filter:{field:'f_deal',operator:'contains',value:'Silver'}},
    {operation:'append'},{value:''},{changes:[{field:'f_notes',value:'extra'}]}]){
    const wrong={...action,...extra};assert.equal(N.normalizeAction(wrong,pipeline),wrong);
  }
  assert.deepEqual(pipeline,before);
});

test('fourteen named numeric assignments fit both the step and business-goal budgets',()=>{
  const pipeline=fixture(),intent={...typed(),assignments:pipeline.records.slice(0,14).map((r,index)=>({name:r.f_deal,value:index-7.5}))};
  const transport={action:'update_records',changes:intent.assignments.map(({name,value})=>({recordMatch:name,field:'cf_target',value,operation:'set'}))};
  const normalized=N.normalizeAction(transport,pipeline);
  assert.equal(normalized.steps.length,28);assert.equal(normalized.goals.length,14);
  assert.equal(N.matches(intent,normalized,prove(normalized,pipeline)),true);
  const created={...intent,operation:'create',fieldName:'New numbers'},ready=N.prepare(created,pipeline);
  assert.equal(ready.action.steps.length,29);assert.equal(ready.action.goals.length,15);
  assert.equal(ready.assessment.compiled,15);
});

test('oversized or malformed intent cannot produce a partial repair or an approval',()=>{
  const pipeline=fixture(),intent=typed();
  for(const bad of [{},{...intent,assignments:undefined},{...intent,completeIntent:'true'},
    {...intent,assignments:pipeline.records.slice(0,15).map(row=>({name:row.f_deal,value:0}))}]){
    const result=N.assess(bad,null,{pipeline});
    assert.equal(result.complete,true);assert.equal(result.ok,false);assert.equal(result.compiled,0);
    assert.equal(result.expectedAction,undefined);assert.throws(()=>N.prepare(bad,pipeline));
  }
  intent.assignments=pipeline.records.slice(0,14).map((row,index)=>{
    row.f_deal='Record '+index+' '+ 'x'.repeat(5000);return {name:row.f_deal,value:index};
  });
  assert.throws(()=>N.prepare(intent,pipeline),/bounded repair contract/);
  assert.equal(N.assess(intent,null,{pipeline}).expectedAction,undefined);
});

test('the primary-column role and exact normalized names are resolved from the schema',()=>{
  const pipeline=fixture(),intent=typed();
  pipeline.tableSchema.fields=pipeline.tableSchema.fields.map(f=>f.id==='f_deal'?{...f,id:'f_project',name:'Project title'}:f);
  if(pipeline.tableSchema.columnOrder)pipeline.tableSchema.columnOrder=pipeline.tableSchema.columnOrder.map(id=>id==='f_deal'?'f_project':id);
  pipeline.records.forEach(row=>{row.f_project=row.f_deal;delete row.f_deal;});
  intent.assignments[0].name=' '+intent.assignments[0].name.toUpperCase()+' ';
  const ready=N.prepare(intent,pipeline);
  assert(ready.computed.numericAssignmentEvidence.every(p=>p.primaryField==='f_project'));
  assert.equal(ready.assessment.compiled,2);
});
