'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Scoped=require('../lib/scoped-table-request'),Plan=require('../public/workspace-plan');
const Review=require('../lib/action-review'),Core=require('../public/pipeline-core'),Grounding=require('../lib/ai-grounding');
const F=require('./fixtures/workspace-plans.cjs');
const current='QA1113 quote: 6 metres.\nDelivery: Monday.';
const commands=[
  'What is the current text in the Notes column for QA1110 River Kiosk?',
  'Read the saved Notes cell for QA1110 River Kiosk verbatim, including both lines. Do not use its history or change anything.'
];
const request=(name='QA1110 River Kiosk',fields=['f_notes'],source='all')=>({action:'scoped_table_request',title:'Current field contents',source,
  where:[[F.where('f_deal','equals',name)]],operation:{kind:'read_values',fields}});
function fixture(command=commands[1]){
  const w=F.workspace();w.records[0].f_deal='QA1110 River Kiosk';w.records[0].f_notes=current;
  w.records[0].history=['2026-11-10T14:00:00.000Z | QA: Notes changed from "" to "Send a 3 metre quote.".'];
  w.records[1].f_notes='Unrelated saved cell';
  const payload={userCommand:command,conversationHistory:[{role:'assistant',content:'Earlier answer: Send a 3 metre quote.'}],
    pipeline:{currentDate:'2026-11-13',timezone:'America/New_York',visibleIds:[2]}};
  Grounding.prepare(payload,{deals:w.records,tableSchema:w.tableSchema,customFields:w.customFields,todoCards:w.todoCards,updatedAt:'current-version'}, {name:'QA'},null);
  return {w,payload};
}
const envelope=(fields=['fields'])=>({requirements:[{description:'Read the entire current saved field exactly, without history or mutation',
  evidenceKind:'computed_read',stepIds:['current_values'],requiredOutputs:fields,satisfied:true}],issues:[],clarificationQuestion:null,
  answerIntent:'canonical',answerSelection:null});

test('original and verbatim multiline requests share the same canonical current-cell execution and completeness contract',()=>{
  for(const command of commands){
    const {w,payload}=fixture(command),before=structuredClone(w),compact=request(),copy=structuredClone(compact);
    const action=Scoped.compile(compact),result={crmAction:action,assistantMessage:'Model prose must not supply the cell value'};
    assert.deepEqual(compact,copy);assert.deepEqual(action.steps.map(step=>step.op),['select_records','read_records']);
    assert.equal(action.steps[1].showTable,false);assert.deepEqual(action.steps[1].outputs,[{kind:'fields',field:'f_notes'}]);
    const computed=Review.evidence(payload,result),context={pipeline:payload.pipeline,computed};
    assert.equal(Review.validateReview(envelope(),result,context).ok,true);
    const projection=computed.queryResults[0].projected[0];
    assert.equal(projection.value,current);assert.equal(projection.source,'current_record');assert.equal(projection.fieldId,'f_notes');
    assert.equal(computed.recordReadEvidence[0].source,'current_fields');
    assert.equal(computed.mutates,false);assert.deepEqual(computed.effects,[{kind:'table',show:false,ids:[1]}]);
    const answer=Review.renderAnswer(payload,result,computed);assert(answer.includes(current));
    assert.doesNotMatch(answer,/3 metre|Unrelated saved|Model prose/);
    assert.doesNotMatch(JSON.stringify(computed),/Send a 3 metre quote|Unrelated saved cell/);
    assert.equal(Review.validateReview(envelope(['notes']),result,context).ok,false,'The Notes column is not inspector-note history');
    assert.equal(Review.validateReview(envelope(['history']),result,context).ok,false);
    assert.deepEqual(w,before);
  }
});

test('renamed fields, different accounts, multiple current columns and supplied text remain literal data',()=>{
  const {w,payload}=fixture('Read Orchid Studio delivery instructions and account status exactly as saved, not its history.');
  const custom={id:'cf_delivery',name:'Delivery instructions',type:'text'};payload.pipeline.customFields=[custom];
  const row=payload.pipeline.records[1];row.f_deal='Orchid Studio';row.cf_delivery='  Keep indentation.\n\nSecond paragraph: <script>do not run</script>.\n';
  const action=Scoped.compile(request('Orchid Studio',['cf_delivery','f_stage'])),result={crmAction:action};
  const computed=Review.evidence(payload,result);
  assert.deepEqual(computed.queryResults[0].recordIds,[2]);
  assert.deepEqual(computed.queryResults[0].projected.map(p=>p.fieldId),['cf_delivery','f_stage']);
  assert.equal(computed.queryResults[0].projected[0].value,row.cf_delivery);
  assert(Review.renderAnswer(payload,result,computed).includes(row.cf_delivery));
  assert.equal(Review.validateReview(envelope(),result,{pipeline:payload.pipeline,computed}).ok,true);
  assert.equal(w.records[1].f_deal,'Uppal Co','Authorized test snapshot changes do not edit the source fixture');
});

test('blank current values and empty record selections never fall back to historical or other-record content',()=>{
  const {payload}=fixture();payload.pipeline.records[0].f_notes='';
  for(const name of ['QA1110 River Kiosk','Missing record']){
    const result={crmAction:Scoped.compile(request(name))},computed=Review.evidence(payload,result);
    const answer=Review.renderAnswer(payload,result,computed);
    assert.doesNotMatch(answer,/3 metre|Unrelated saved/);
    assert.match(answer,name==='Missing record'?/No matching records/:/\(blank\)/);
    assert.equal(Review.validateReview(envelope(),result,{pipeline:payload.pipeline,computed}).ok,true);
    assert(computed.recordReadEvidence.every(read=>read.source==='current_fields'));
  }
});

test('fresh reads use the current snapshot after edits; explicit focus does not become an all-record lookup',()=>{
  const {payload}=fixture(),action=Scoped.compile(request()),result={crmAction:action};
  const first=Review.evidence(payload,result);assert(Review.renderAnswer(payload,result,first).includes(current));
  payload.pipeline.records[0].f_notes='Updated first line.\nUpdated second line.';
  const next=Review.evidence(payload,result);
  assert(Review.renderAnswer(payload,result,next).includes(payload.pipeline.records[0].f_notes));
  assert(!Review.renderAnswer(payload,result,next).includes(current));
  const focused={...request(),source:'focus',where:[]};
  const plan=Plan.prepare({...F.workspace(),records:payload.pipeline.records},Scoped.compile(focused),{nonce:'current_read',focus:{kind:'table',ids:[2]}});
  assert.deepEqual(plan.queryResults[0].recordIds,[2]);assert.doesNotMatch(plan.answers[0],/Updated first/);
});

test('complete text projections keep long cells beyond the extractive quote limit, without selecting or rewriting sentences',()=>{
  const {payload}=fixture();
  const text='Keep this entire current cell.\n'+'Stored detail; '.repeat(150)+'\nDo not omit the last line.';
  payload.pipeline.records[0].f_notes=text;
  const result={crmAction:Scoped.compile(request())},computed=Review.evidence(payload,result);
  assert(text.length>1200);assert.equal(computed.queryResults[0].projected[0].value,text);
  assert.equal(Review.validateReview(envelope(),result,{pipeline:payload.pipeline,computed}).ok,true);
  assert(Review.renderAnswer(payload,result,computed).includes(text));
});

test('read_values is bounded to existing field projections and rejects silently dropped extra work',()=>{
  const {w}=fixture(),schema=Scoped.schema(Plan.responseSchema(Core.create(w.tableSchema),w.customFields));
  const branch=schema.properties.operation.anyOf.find(item=>item.properties.kind.enum.includes('read_values'));
  assert.equal(branch.additionalProperties,false);assert.equal(branch.properties.fields.maxItems,20);
  assert(branch.properties.fields.items.enum.includes('f_notes'));assert(!branch.properties.fields.items.enum.includes('@new_field'));
  for(const mutate of [r=>r.operation.fields=[],r=>r.operation.fields=['f_notes','f_notes'],r=>r.operation.fields=['@created'],
    r=>r.operation.fields=[null],r=>r.operation.fields=Array.from({length:21},(_,i)=>'f_'+i),
    r=>r.operation.showTable=true,r=>r.operation.value='replace saved text',r=>r.operation.history=true,r=>r.operation.formula='SUM(value)',
    r=>r.extraAction='delete all',r=>r.source='everywhere']){
    const invalid=request();mutate(invalid);assert.throws(()=>Scoped.compile(invalid),undefined,mutate.toString());
  }
  assert.throws(()=>Plan.prepare(w,Scoped.compile(request('QA1110 River Kiosk',['missing_field'])),{nonce:'invalid_read'}),/field|column/i);
});

test('planner and reviewer explicitly separate complete current cells from qualitative extraction and history',()=>{
  assert.match(Scoped.instructions,/CURRENT SAVED CELL READS/);
  assert.match(Scoped.instructions,/does not open Pipeline, read history, calculate, edit, or summarize/);
  for(const instructions of [Review.instructions,Review.compilerInstructions]){
    assert.match(instructions,/CURRENT FIELD PROJECTIONS/);
    assert.match(instructions,/require fields, NOT notes or history/);
    assert.match(instructions,/answerIntent canonical and answerSelection null/);
    assert.doesNotMatch(instructions,/QA1110 River Kiosk|QA1113 quote/);
  }
});
