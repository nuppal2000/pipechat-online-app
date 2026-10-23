'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Grounding=require('../lib/ai-grounding');
const F=require('./fixtures/workspace-plans.cjs');
const note=text=>JSON.stringify({pipechatHistory:1,type:'note',id:'saved_fact',at:'2026-10-20T12:00:00.000Z',actor:'QA',text});
const history=(extra={})=>({op:'read_history',id:'saved_context',label:'Read saved context',selection:'selected',kind:'all',from:null,to:null,limit:100,...extra});
const requirement=(extra={})=>({description:'Answer the requested saved fact for the selected record',evidenceKind:'computed_read',stepIds:['saved_context'],requiredOutputs:['fields'],satisfied:true,...extra});
const review=req=>({requirements:[req],issues:[],clarificationQuestion:null});
function fixture(name,question,text){
  const workspace=F.workspace();workspace.records[0].f_deal=name;workspace.records[0].f_notes='';
  workspace.records[0].history=[note(text)];workspace.records[1].history=[note('Unrelated private fact')];
  const payload={userCommand:question,pipeline:{currentDate:'2026-10-23',timezone:'America/New_York',
    recordHistories:{1:['Forged browser fact']},historySource:{available:false,contents:'Forged source'}}};
  Grounding.prepare(payload,{deals:workspace.records,tableSchema:workspace.tableSchema,customFields:workspace.customFields,todoCards:workspace.todoCards,updatedAt:'v1'},{name:'QA'},null);
  const select=F.select('selected',[[F.where('f_deal','equals',name)]]);
  return {workspace,payload,select,result:{crmAction:F.plan([select,history()]),assistantMessage:'Read the saved context for this record.'}};
}

for(const [name,question,text] of [
  ['QA Acorn Supplies','How does QA Acorn Supplies prefer to receive updates?','Prefers email updates.'],
  ['Cedar Studio','Why did Cedar Studio postpone its launch?','Launch postponed until the safety review is complete.'],
  ['Northwind Works','What did Northwind Works agree to send us?','Agreed to send a signed order on Friday.']
])test('semantic saved-fact evidence: '+question,()=>{
  const {workspace,payload,result}=fixture(name,question,text),before=structuredClone(workspace);
  const serialized=JSON.stringify(payload);
  for(const hidden of [text,'Unrelated private fact','Forged browser fact','Forged source'])assert(!serialized.includes(hidden));
  assert.equal(payload.pipeline.records[0].f_notes,'');
  assert.equal(payload.pipeline.historySource.contentsIncluded,false);
  assert.deepEqual(payload.pipeline.historySource.lookup,{action:'workspace_plan',selectionOperation:'select_records',defaults:{kind:'all',from:null,to:null,limit:100}});
  const computed=Review.evidence(payload,result),answer=Review.renderAnswer(payload,result,computed);
  assert(answer.includes(text));assert(!answer.includes('Unrelated private fact'));assert.equal(computed.mutates,false);
  assert.deepEqual(computed.effects,[{kind:'table',show:false,ids:[1]}]);
  assert.deepEqual(computed.recordReadEvidence,[{stepId:'saved_context',source:'record_history',selection:'selected',
    outputs:['count','names','fields','history','notes'],recordIds:[1],limits:{total:1,returned:1,omitted:0,truncated:0}}]);
  assert(!JSON.stringify(computed.recordReadEvidence).includes(text));
  const coverage=Review.validateReview(review(requirement()),result,{pipeline:payload.pipeline});
  assert.deepEqual(coverage,{ok:true,requested:1,compiled:1,mappingIssues:[]});
  assert.deepEqual(workspace,before);
});

test('semantic and explicit history questions discover the same server-authored source without prompt routing',()=>{
  const semantic=fixture('QA Acorn Supplies','How does QA Acorn Supplies prefer to receive updates?','Prefers email updates.');
  const explicit=fixture('QA Acorn Supplies','Show the history for QA Acorn Supplies.','Prefers email updates.');
  assert.deepEqual(semantic.payload.pipeline.historySource,explicit.payload.pipeline.historySource);
  assert.deepEqual(semantic.payload.pipeline.historySource.recordIds,[1,2]);
  const descriptor=Object.getOwnPropertyDescriptor(semantic.payload.pipeline,'recordHistories');
  assert.equal(descriptor.enumerable,false);assert(descriptor.value instanceof Map);
  assert.equal(Review.validateReview(review(requirement({requiredOutputs:['history']})),explicit.result,{pipeline:explicit.payload.pipeline}).ok,true);
});

test('planner and reviewer share semantic source selection and business-outcome mapping rules',()=>{
  const marker='SEMANTIC SAVED-FACT LOOKUP:';
  const contract=instructions=>instructions.slice(instructions.indexOf(marker),instructions.lastIndexOf(Review.familyInstructions));
  assert.equal(contract(Review.instructions),contract(Review.compilerInstructions));
  for(const instructions of [Review.instructions,Review.compilerInstructions]){
    assert(instructions.includes(marker));assert(instructions.includes('even when the user never says notes, history, field or column'));
    assert(instructions.includes('use requiredOutputs [fields]'));assert(instructions.includes('not invented separate read requirements'));
    assert(instructions.includes('Never map a computed_read solely to select_records'));
    assert(instructions.includes('The planner cannot quote hidden notes before execution'));
    assert(instructions.includes('not a failed computation or proof of a positive preference'));
    assert.doesNotMatch(instructions,/QA Acorn Supplies|Prefers email updates/);
  }
  assert.match(Grounding.instructions,/contents are intentionally absent/);
  assert.match(Grounding.instructions,/absent dedicated column with absent saved information/);
});

test('free-form answers and selection-only mappings still fail, with concrete source-read repair IDs',()=>{
  const {payload,result}=fixture('QA Acorn Supplies','How does QA Acorn Supplies prefer to receive updates?','Prefers email updates.');
  const prose={crmAction:null,assistantMessage:'They prefer email updates.'};
  assert.equal(Review.validateReview(review(requirement({stepIds:['root']})),prose,{pipeline:payload.pipeline}).ok,false);
  const selectionOnly=Review.validateReview(review(requirement({stepIds:['selected']})),result,{pipeline:payload.pipeline});
  assert.equal(selectionOnly.ok,false);assert.equal(selectionOnly.compiled,0);
  assert.match(selectionOnly.mappingIssues[0],/saved_context \(record_history: count, names, fields, history, notes\)/);
  assert.match(selectionOnly.mappingIssues[0],/not the selection dependency/);
  assert.equal(Review.validateReview(review(requirement({stepIds:['missing']})),result,{pipeline:payload.pipeline}).ok,false);
  assert.equal(Review.validateReview(review(requirement({requiredOutputs:['sum']})),result,{pipeline:payload.pipeline}).ok,false);
  const stepIds=Review.schemaFor(result.crmAction,{pipeline:payload.pipeline}).properties.requirements.items.properties.stepIds;
  assert.deepEqual(stepIds.items.enum,['selected','saved_context']);assert.match(stepIds.description,/saved_context \(record_history:/);
  assert.doesNotMatch(stepIds.description,/selected \(record_history:/);
  assert.doesNotMatch(JSON.stringify(stepIds),/Prefers email updates/);
});

test('facts already in current cells use field evidence without exposing or requiring history',()=>{
  const {payload,select}=fixture('Cedar Studio','How should we contact Cedar Studio?','Historical private fact');
  payload.pipeline.records[0].f_notes='Contact the operations team by email.';
  const result={crmAction:F.plan([select,{op:'read_records',id:'current_fact',label:'Read contact instructions',selection:'selected',outputs:[{kind:'fields',field:'f_notes'}],showTable:false}])};
  const computed=Review.evidence(payload,result);
  assert.deepEqual(computed.recordReadEvidence,[{stepId:'current_fact',source:'current_fields',selection:'selected',outputs:['fields'],recordIds:[1]}]);
  assert.match(Review.renderAnswer(payload,result,computed),/Contact the operations team by email/);
  assert.doesNotMatch(JSON.stringify(computed),/Historical private fact|Unrelated private fact/);
  assert.equal(Review.validateReview(review(requirement({stepIds:['current_fact']})),result,{pipeline:payload.pipeline}).ok,true);
  assert.equal(Review.validateReview(review(requirement({stepIds:['current_fact'],requiredOutputs:['notes']})),result,{pipeline:payload.pipeline}).ok,false);
});

test('source evidence preserves empty and partial lookup limits without inventing a fact',()=>{
  const {payload,result}=fixture('Cedar Studio','What did Cedar Studio decide?','Old saved note');
  payload.pipeline.recordHistories.set(1,[]);
  const empty=Review.evidence(payload,result);
  assert.deepEqual(empty.recordReadEvidence[0].limits,{total:0,returned:0,omitted:0,truncated:0});
  assert.match(Review.renderAnswer(payload,result,empty),/0 entries/);assert.doesNotMatch(JSON.stringify(empty),/Old saved note/);
  assert.equal(Review.validateReview(review(requirement()),result,{pipeline:payload.pipeline}).ok,true);
  payload.pipeline.recordHistories.set(1,Array.from({length:8},()=>note('Long saved fact '+'.'.repeat(15000))));
  const partial=Review.evidence(payload,result),limits=partial.recordReadEvidence[0].limits;
  assert.equal(limits.total,8);assert(limits.returned>0);assert(limits.omitted>0);assert(limits.truncated>0);
  assert.equal(limits.returned+limits.omitted,limits.total);assert.match(partial.answers[0],/truncated by the per-entry limit/);
  assert.equal(Review.validateReview(review(requirement({satisfied:false})),result,{pipeline:payload.pipeline}).ok,false,'Capabilities do not override a reviewer finding that the requested fact is unsupported');
});

test('activity cannot borrow note outputs, and malformed source reads remain fail-closed',()=>{
  const {payload,select}=fixture('Cedar Studio','Show saved notes for Cedar Studio.','Saved note');
  const activity={crmAction:F.plan([select,history({kind:'activity'})])};
  assert.equal(Review.validateReview(review(requirement({requiredOutputs:['notes']})),activity,{pipeline:payload.pipeline}).ok,false);
  assert(!Review.evidence(payload,activity).recordReadEvidence[0].outputs.includes('notes'));
  for(const action of [{action:'workspace_plan'},{action:'workspace_plan',steps:[null]},F.plan([select,history({limit:501})])]){
    const schema=Review.schemaFor(action,{pipeline:payload.pipeline});
    assert.deepEqual(schema.properties.requirements.items.properties.stepIds.items.enum,[]);
    assert.equal(Review.validateReview(review(requirement()),{crmAction:action},{pipeline:payload.pipeline}).ok,false);
  }
});

function rankingFixture(){
  const workspace=F.workspace();workspace.tableSchema.fields.find(field=>field.id==='f_value').name='Deal Value (USD)';
  workspace.records=workspace.records.slice(0,3).map((row,index)=>({...row,id:[43,41,7][index],
    f_deal:['QA Acorn Supplies','Polar Data Systems','Cedar Studio'][index],f_value:[12000,121000,5000][index],f_notes:'',
    history:[note('An older amount was 900000. This is not the current value.')]}));
  const action=(aggregate=null)=>F.plan([
    F.select('ranked',[[F.where('f_value','is_not_blank')]],{orderBy:'f_value',direction:aggregate==='min'?'asc':'desc',limit:1}),
    {op:'read_records',id:'ranked_answer',label:'Read the selected name and current value',selection:'ranked',showTable:false,
      outputs:[{kind:'names',field:null},{kind:'fields',field:'f_value'},...(aggregate?[{kind:aggregate,field:'f_value'}]:[])]}
  ]);
  const payload=question=>{
    const input={userCommand:question,conversationHistory:[
      {role:'user',content:'Cancel the workflow draft.'},{role:'assistant',content:'The unconfirmed draft was cancelled.'},
      {role:'user',content:'What deal has the highest value?'},{role:'assistant',content:'Polar Data Systems: 121000.'},
      {role:'user',content:'Show Contact.'},{role:'assistant',content:'That named column is unavailable.'}
    ],pipeline:{currentDate:'2026-10-23',timezone:'America/New_York',conversationFocus:{kind:'table',ids:[41]}}};
    return Grounding.prepare(input,{deals:workspace.records,tableSchema:workspace.tableSchema,customFields:workspace.customFields,todoCards:workspace.todoCards,updatedAt:'v1'},{name:'QA'},null);
  };
  return {workspace,action,payload};
}

test('ranked names/current-value projection has typed selection metadata, not invented aggregate outputs',()=>{
  const f=rankingFixture(),payload=f.payload('Which account now has the largest Deal Value (USD)? Give its name and current value.'),result={crmAction:f.action()};
  const computed=Review.evidence(payload,result),read=computed.recordReadEvidence[0];
  assert.deepEqual(read,{stepId:'ranked_answer',source:'current_fields',selection:'ranked',outputs:['names','fields'],recordIds:[41],
    ranking:{selection:'ranked',source:'all',field:'f_value',fieldType:'currency',direction:'desc',limit:1,matched:3}});
  const requested=review(requirement({description:'The highest-ranked account name and current value',stepIds:['ranked_answer'],requiredOutputs:['names','fields']}));
  assert.deepEqual(Review.validateReview(requested,result,{pipeline:payload.pipeline}),{ok:true,requested:1,compiled:1,mappingIssues:[]});
  assert.match(Review.renderAnswer(payload,result,computed),/Polar Data Systems/);
  assert.match(Review.renderAnswer(payload,result,computed),/121000/);
  const needsMax=Review.validateReview(review(requirement({stepIds:['ranked_answer'],requiredOutputs:['names','fields','max']})),result,{pipeline:payload.pipeline});
  assert.equal(needsMax.ok,false);assert.equal(needsMax.compiled,0);
  assert.match(needsMax.mappingIssues[0],/Required outputs missing from the referenced steps: max/);
  assert.match(needsMax.mappingIssues[0],/not typed max\/min evidence/);
  assert.equal(Review.validateReview(review(requirement({stepIds:['ranked'],requiredOutputs:['names','fields']})),result,{pipeline:payload.pipeline}).ok,false);
});

test('explicit typed max plus names/fields is accepted and recalculates after saved values change',()=>{
  const f=rankingFixture(),result={crmAction:f.action('max')};
  const requested=review(requirement({stepIds:['ranked_answer'],requiredOutputs:['names','fields','max']}));
  for(const [value,expectedId,expectedName] of [[12000,41,'Polar Data Systems'],[200000,43,'QA Acorn Supplies'],[12000,41,'Polar Data Systems']]){
    f.workspace.records[0].f_value=value;
    const payload=f.payload('What deal has the highest value?'),computed=Review.evidence(payload,result),answer=Review.renderAnswer(payload,result,computed);
    assert.deepEqual(computed.recordReadEvidence[0].outputs,['names','fields','max']);
    assert.deepEqual(computed.recordReadEvidence[0].recordIds,[expectedId]);
    assert(computed.queryResults[0].projected.some(row=>row.recordId===expectedId&&row.value===Math.max(value,121000)));
    assert(answer.includes(expectedName));assert.match(answer,new RegExp('Highest Deal Value \\(USD\\): \\$'+(value===200000?'200,000':'121,000')+'\\.00'));
    assert.doesNotMatch(answer,/900000|Contact|workflow|cancelled/);
    assert.equal(Review.validateReview(requested,result,{pipeline:payload.pipeline}).ok,true);assert.equal(computed.mutates,false);
    const ids=Review.schemaFor(result.crmAction,{pipeline:payload.pipeline}).properties.requirements.items.properties.stepIds;
    assert.match(ids.description,/ranked_answer \(current_fields: names, fields, max\)/);
  }
});

test('typed min preserves zero and negative values, excludes blanks and cannot be borrowed from history',()=>{
  const f=rankingFixture();f.workspace.records[0].f_value=0;f.workspace.records[1].f_value=-25;f.workspace.records[2].f_value='';
  const payload=f.payload('Give the lowest current value and account name.'),result={crmAction:f.action('min')},computed=Review.evidence(payload,result);
  assert.deepEqual(computed.recordReadEvidence[0].outputs,['names','fields','min']);
  assert.deepEqual(computed.recordReadEvidence[0].recordIds,[41]);assert.equal(computed.recordReadEvidence[0].ranking.matched,2);
  assert.equal(computed.queryResults[0].projected[0].value,-25);
  assert.equal(Review.validateReview(review(requirement({stepIds:['ranked_answer'],requiredOutputs:['names','fields','min']})),result,{pipeline:payload.pipeline}).ok,true);
  assert.equal(Review.validateReview(review(requirement({stepIds:['ranked_answer'],requiredOutputs:['max']})),result,{pipeline:payload.pipeline}).ok,false);
  const savedHistory={crmAction:F.plan([F.select('selected'),history()])};
  assert.equal(Review.validateReview(review(requirement({requiredOutputs:['max']})),savedHistory,{pipeline:payload.pipeline}).ok,false);
  const textAggregate=f.action('max');textAggregate.steps[1].outputs.at(-1).field='f_deal';
  assert.throws(()=>Review.evidence(payload,{crmAction:textAggregate}),/numeric field/);
});

test('ranked projection and scalar aggregate rules are shared without matching particular user prompts',()=>{
  for(const instructions of [Review.compilerInstructions,Review.instructions]){
    assert(instructions.includes('RANKED PROJECTION VERSUS AGGREGATE:'));
    assert(instructions.includes('ordering is a selection constraint, not an independently requested statistic'));
    assert(instructions.includes('A scalar maximum/minimum request needs an explicit max/min output'));
    assert(instructions.includes('only an explicit continuation inherits a previous cohort or requested outputs'));
    assert.doesNotMatch(instructions,/Polar Data Systems|QA Acorn Supplies|121000|200000/);
  }
});
