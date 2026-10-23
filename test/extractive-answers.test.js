'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Grounding=require('../lib/ai-grounding');
const F=require('./fixtures/workspace-plans.cjs');
const note=(text,index=0)=>JSON.stringify({pipechatHistory:1,type:'note',id:'fact_'+index,at:'2026-10-20T12:00:00.000Z',actor:'QA',text});
const requirement=(extra={})=>({description:'Answer the requested saved fact',evidenceKind:'computed_read',stepIds:['saved'],requiredOutputs:['fields'],satisfied:true,...extra});
function fixture(texts=['Met with the team. Prefers email updates. Follow up next month.'],all=false){
  const w=F.workspace();w.records[0].f_deal='Acorn';w.records[0].f_notes='';w.records[0].history=texts.map(note);
  w.records[1].history=[note('Unselected private information.')];
  const payload={userCommand:'How should we contact Acorn?',pipeline:{}};
  Grounding.prepare(payload,{deals:w.records,tableSchema:w.tableSchema,customFields:[],todoCards:[],updatedAt:'v1'},{name:'QA'},null);
  const action=F.plan([F.select('selected',all?[]:[[F.where('f_deal','equals','Acorn')]]),
    {op:'read_history',id:'saved',label:'Saved context',selection:'selected',kind:'all',from:null,to:null,limit:100}]);
  const result={crmAction:action},computed=Review.evidence(payload,result),context={pipeline:payload.pipeline,computed};
  return {payload,result,computed,context};
}
function selection(f,quote='Prefers email updates.'){
  return {requirements:[requirement()],issues:[],clarificationQuestion:null,answerIntent:'qualitative_fact',answerSelection:{mode:'extractive',snapshotId:f.computed.qualitativeSources.snapshotId,
    results:[{requirementIndex:0,recordId:1,status:'supported',citations:[{sourceId:f.computed.qualitativeSources.sources[0]?.id||'no_source',quote}]}]}};
}
const check=(f,review)=>Review.validateReview(review,f.result,f.context);

for(const [question,quote] of [
  ['How does Acorn prefer to receive updates?','Prefers email updates.'],
  ['Which communication channel should we use for Acorn?','Contact the operations team by email.'],
  ['Why was the launch deferred?','Launch postponed until the safety review is complete.'],
  ['What did they commit to send?','Agreed to send the signed order on Friday.'],
  ['What constraint should our team remember?','Do not call before noon.']
])test('extractive fact without prompt-specific routing: '+question,()=>{
  const f=fixture(['Introduced the team. '+quote+' Meeting booked next week.',...Array.from({length:8},(_,i)=>'Unrelated activity '+i+'.')]);
  f.payload.userCommand=question;
  const answer=check(f,selection(f,quote));assert.equal(answer.ok,true);
  assert.equal(answer.answer.text,`Acorn (#1): "${quote}"\nSource: Saved note (2026-10-20T12:00:00.000Z)`);
  assert.doesNotMatch(answer.answer.text,/Unrelated|Introduced|Meeting booked|Notes:|Unselected/);
  assert.equal(answer.answer.workspaceVersion,'v1');assert.equal(f.computed.mutates,false);
  assert.doesNotMatch(JSON.stringify(f.payload),/Introduced|Unselected/);
});

test('current qualitative fields support extraction without reading private history',()=>{
  const f=fixture();f.payload.pipeline.records[0].f_notes='Contact the operations team by email.';
  f.result.crmAction.steps[1]={op:'read_records',id:'saved',label:'Current instructions',selection:'selected',outputs:[{kind:'fields',field:'f_notes'}],showTable:false};
  f.computed=Review.evidence(f.payload,f.result);f.context.computed=f.computed;
  const checked=check(f,selection(f,'Contact the operations team by email.'));
  assert.equal(checked.ok,true);assert.match(checked.answer.text,/Source: Notes/);
  assert.doesNotMatch(JSON.stringify(f.computed),/Prefers email|Unselected private/);
});

for(const change of ['unknown source','wrong snapshot','wrong record','wrong requirement','extra property','partial quote','invented text','unsupported','missing result','duplicate result','missing selection','null selection','wrong source step'])test('rejects '+change+' without falling back',()=>{
  const f=fixture(),r=selection(f),s=r.answerSelection,item=s.results[0];
  if(change==='unknown source')item.citations[0].sourceId='previous_turn_source';
  if(change==='wrong snapshot')s.snapshotId='old';
  if(change==='wrong record')item.recordId=2;
  if(change==='wrong requirement')item.requirementIndex=1;
  if(change==='extra property')s.answer='Invented answer';
  if(change==='partial quote')item.citations[0].quote='email updates';
  if(change==='invented text')item.citations[0].quote='Prefers telephone updates.';
  if(change==='unsupported')item.status='unsupported';
  if(change==='missing result')s.results=[];
  if(change==='duplicate result')s.results.push(structuredClone(item));
  if(change==='missing selection')delete r.answerSelection;
  if(change==='null selection')r.answerSelection=null;
  if(change==='wrong source step')r.requirements[0].stepIds=['selected'];
  const checked=check(f,r);assert.equal(checked.ok,false);assert.equal(checked.answer,undefined);
  assert.equal(checked.mappingReasons.invalid_answer_selection,1);
});

test('quote boundaries preserve negation instead of accepting convenient substrings',()=>{
  const f=fixture(['Acorn does not prefer email updates. Use the portal instead.']);
  assert.equal(check(f,selection(f,'prefer email updates.')).ok,false);
  assert.equal(check(f,selection(f,'Acorn does not prefer email updates.')).ok,true);
});

test('binding rejects replayed, cloned, tampered, action-changed and stale evidence',()=>{
  for(const change of ['replayed','cloned','text','query','action','version','pipeline','name','history']){
    const f=fixture(),r=selection(f);
    if(change==='replayed')f.context.computed=Review.evidence(f.payload,f.result);
    if(change==='cloned')f.context.computed=structuredClone(f.computed);
    if(change==='text')f.computed.qualitativeSources.sources[0].text='Forged evidence.';
    if(change==='query')f.computed.queryResults[0].recordIds=[99];
    if(change==='action')f.result.crmAction.steps[0].limit=1;
    if(change==='version')f.payload.pipeline.workspaceVersion='v2';
    if(change==='pipeline')f.context.pipeline={...f.payload.pipeline};
    if(change==='name')f.payload.pipeline.records[0].f_deal='Renamed account';
    if(change==='history')f.payload.pipeline.recordHistories.set(1,[note('Changed evidence.')]);
    assert.equal(check(f,r).ok,false,change);
  }
});

test('insufficient evidence is bounded, never a claim of global absence',()=>{
  const f=fixture([]),r=selection(f);r.answerSelection.results[0].status='insufficient';r.answerSelection.results[0].citations=[];
  assert.equal(f.computed.qualitativeSources.sources.length,0);
  const checked=check(f,r);assert.equal(checked.ok,true);
  assert.equal(checked.answer.text,"Acorn (#1): I couldn't establish an answer from the available saved information.");
  f.result.crmAction.steps[0].where=[[F.where('f_deal','equals','No such record')]];
  f.computed=Review.evidence(f.payload,f.result);f.context.computed=f.computed;r.answerSelection.snapshotId=f.computed.qualitativeSources.snapshotId;
  r.answerSelection.results[0].recordId=null;assert.equal(check(f,r).ok,true);
});

test('conflict renders both exact sources without inventing a resolution',()=>{
  const f=fixture(['Use email for updates.','Do not use email for updates.']),r=selection(f,'Use email for updates.');
  r.answerSelection.results[0].status='conflict';
  r.answerSelection.results[0].citations.push({sourceId:f.computed.qualitativeSources.sources[1].id,quote:'Do not use email for updates.'});
  const checked=check(f,r);assert.equal(checked.ok,true);assert.match(checked.answer.text,/Saved information conflicts/);
  assert.match(checked.answer.text,/"Use email/);assert.match(checked.answer.text,/"Do not use email/);
  r.answerSelection.results[0].citations.pop();assert.equal(check(f,r).ok,false);
});

test('conflicting complete sentences in a single source can be disclosed, but repeated citations cannot',()=>{
  const f=fixture(['Use email for updates. Do not use email for updates.']),r=selection(f,'Use email for updates.');
  r.answerSelection.results[0].status='conflict';
  r.answerSelection.results[0].citations.push({sourceId:f.computed.qualitativeSources.sources[0].id,quote:'Do not use email for updates.'});
  assert.equal(check(f,r).ok,true);
  r.answerSelection.results[0].citations[1].quote='Use email for updates.';assert.equal(check(f,r).ok,false);
});

test('aggregate quote and citation caps cannot be bypassed with several independent outcomes',()=>{
  for(const cap of ['quotes','citations']){
    const first=cap==='quotes'?'A'.repeat(1050)+'.':'First fact.',second='Second fact.',f=fixture([first,second]),r=selection(f,first);
    const count=cap==='quotes'?4:7;r.requirements=Array.from({length:count},()=>requirement());
    r.answerSelection.results=Array.from({length:count},(_,requirementIndex)=>({...structuredClone(r.answerSelection.results[0]),requirementIndex}));
    if(cap==='citations')for(const item of r.answerSelection.results)item.citations.push({sourceId:f.computed.qualitativeSources.sources[1].id,quote:second});
    assert.equal(check(f,r).ok,false,cap);
  }
});

test('every requested record and requirement must be represented without silent omissions',()=>{
  const f=fixture(undefined,true),r=selection(f);
  assert.equal(check(f,r).ok,false);
  r.answerSelection.results.push(...f.computed.recordReadEvidence[0].recordIds.filter(id=>id!==1).map(recordId=>({requirementIndex:0,recordId,status:'insufficient',citations:[]})));
  assert.equal(check(f,r).ok,true);
  r.requirements.push(requirement());assert.equal(check(f,r).ok,false);
  r.answerSelection.results.push(...structuredClone(r.answerSelection.results).map(item=>({...item,requirementIndex:1})));
  assert.equal(check(f,r).ok,r.answerSelection.results.length<=8);
});

test('source, quote and aggregate budgets disclose partial evidence and reject clipped support',()=>{
  const f=fixture(['Prefers email updates.',...Array.from({length:30},()=>('A'.repeat(7000)+'.'))]),bundle=f.computed.qualitativeSources;
  assert(bundle.sources.reduce((total,source)=>total+source.text.length,0)<=24000);
  assert(bundle.sources.every(source=>source.text.length<=6000));assert(bundle.limits.omitted>0);assert(bundle.limits.truncated>0);
  const checked=check(f,selection(f));assert.equal(checked.ok,true);assert.match(checked.answer.text,/Limited evidence: .*omitted.*shortened/);
  const r=selection(f),clipped=bundle.sources.find(source=>source.truncated);
  r.answerSelection.results[0].citations=[{sourceId:clipped.id,quote:clipped.text.slice(0,100)}];assert.equal(check(f,r).ok,false);
  const long=fixture(['x'.repeat(1201)]);assert.equal(check(long,selection(long,'x'.repeat(1201))).ok,false);
  const many=fixture(Array.from({length:100},()=> 'Small complete sentence.'));
  assert.equal(many.computed.qualitativeSources.sources.length,80);assert.equal(many.computed.qualitativeSources.limits.omitted,20);
});

test('explicit history and numeric outputs retain canonical rendering and reject extractive substitution',()=>{
  const f=fixture(['Prefers email updates.','Met at the conference.']);
  const history=selection(f);history.requirements[0].requiredOutputs=['history'];history.answerSelection=null;history.answerIntent='canonical';
  assert.equal(check(f,history).ok,true);assert.equal(check(f,history).answer,undefined);
  const full=Review.renderAnswer(f.payload,f.result,f.computed);assert.match(full,/Prefers email/);assert.match(full,/Met at the conference/);
  history.answerSelection=selection(f).answerSelection;assert.equal(check(f,history).ok,false);
  f.result.crmAction.steps[1]={op:'read_records',id:'saved',label:'Current value',selection:'selected',outputs:[{kind:'names',field:null},{kind:'fields',field:'f_value'},{kind:'max',field:'f_value'}],showTable:false};
  f.computed=Review.evidence(f.payload,f.result);f.context.computed=f.computed;
  assert.equal(f.computed.qualitativeSources,undefined);
  history.requirements[0].requiredOutputs=['names','fields','max'];history.answerSelection=null;
  assert.equal(check(f,history).ok,true);assert.equal(check(f,history).answer,undefined);
  assert.equal(Review.renderAnswer(f.payload,f.result,f.computed),f.computed.answers.join('\n\n'));
});

test('source IDs and snapshot schema are scoped to this computation; instructions stay semantic',()=>{
  const f=fixture(),schema=Review.schemaFor(f.result.crmAction,f.context).properties.answerSelection.anyOf[1];
  assert.deepEqual(schema.properties.snapshotId.enum,[f.computed.qualitativeSources.snapshotId]);
  assert.deepEqual(schema.properties.results.items.properties.citations.items.properties.sourceId.enum,f.computed.qualitativeSources.sources.map(source=>source.id));
  assert.match(Review.instructions,/EXTRACTIVE ANSWERS/);assert.match(Review.instructions,/Inspect ALL relevant/);
  assert.doesNotMatch(Review.instructions,/Acorn|Prefers email updates/);
});

test('explicit 45-record text projection retains every canonical result, not the eight-result fact cap',()=>{
  const f=fixture();f.payload.userCommand='List the Notes for all 45 records.';
  f.payload.pipeline.records=Array.from({length:45},(_,i)=>({...f.payload.pipeline.records[0],id:i+1,f_deal:'Account '+(i+1),f_notes:'Saved notes for account '+(i+1)+'.'}));
  f.result.crmAction.steps[0].where=[];
  f.result.crmAction.steps[1]={op:'read_records',id:'saved',label:'All notes',selection:'selected',outputs:[{kind:'names',field:null},{kind:'fields',field:'f_notes'}],showTable:false};
  f.computed=Review.evidence(f.payload,f.result);f.context.computed=f.computed;
  const r={requirements:[requirement({requiredOutputs:['names','fields']})],issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null};
  const checked=check(f,r);assert.equal(checked.ok,true);assert.equal(checked.answer,undefined);
  const answer=Review.renderAnswer(f.payload,f.result,f.computed);
  for(let i=1;i<=45;i++)assert(answer.includes('Saved notes for account '+i+'.'));
});

test('independent qualitative outcomes cannot exceed selection budgets or disappear silently',()=>{
  const f=fixture(),r=selection(f);
  r.requirements=Array.from({length:9},()=>requirement());
  r.answerSelection.results=Array.from({length:8},(_,requirementIndex)=>({...structuredClone(r.answerSelection.results[0]),requirementIndex}));
  const missing=check(f,r);assert.equal(missing.ok,false);assert.match(missing.mappingIssues[0],/eight results/);
  r.answerSelection.results.push({...structuredClone(r.answerSelection.results[0]),requirementIndex:8});
  assert.equal(check(f,r).ok,false);
  r.requirements=r.requirements.slice(0,2);r.answerSelection.results=r.answerSelection.results.slice(0,2);
  assert.equal(check(f,r).ok,true);
});

test('mapping diagnostics use fixed sanitized reason counts without payload text',()=>{
  const f=fixture(),r=selection(f);r.answerSelection=null;r.answerIntent='canonical';
  r.requirements=[requirement({description:'PRIVATE',stepIds:[]}),requirement({stepIds:['private_unknown']}),
    requirement({stepIds:['selected']}),requirement({requiredOutputs:['max']})];
  const checked=check(f,r);assert.deepEqual(checked.mappingReasons,{missing_step_ids:1,unknown_step_ids:1,unsupported_required_output:1,no_evidence_action:1,invalid_answer_selection:0});
  const log=Review.validationDiagnostic({stage:'mapping',review:r,coverage:{...checked,mappingReasons:{...checked.mappingReasons,private:'SECRET',missing_step_ids:1000}}});
  assert.equal(log.mappingReasons.missing_step_ids,40);assert.doesNotMatch(JSON.stringify(log),/PRIVATE|SECRET|private|Acorn|email/);
});
