'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Diagnostic=require('../lib/compiler-diagnostic');
const Plan=require('../public/workspace-plan'),Core=require('../public/pipeline-core'),F=require('./fixtures/workspace-plans.cjs');
const percent=(percent=10,blankPolicy='error')=>({field:'f_value',operation:'adjust_percent',value:{percent,blankPolicy}});
const shift=(offset=2,blankPolicy='error')=>({field:'f_follow',operation:'shift_date',value:{dateMode:'calendar_days',offset,blankPolicy}});
const update=(assignments,id='edit')=>({op:'update_records',id,label:id,selection:'selected',assignments});
const plan=(...assignments)=>F.plan([F.select('selected'),update(assignments)]);
function fixture(){
  const pipeline=F.workspace();pipeline.records=pipeline.records.slice(0,3).map((row,i)=>({...row,f_value:[10000,20000,0][i],f_follow:['2026-10-27','2026-10-28','2026-10-30'][i]}));
  return {pipeline:{...pipeline,currentDate:'2026-10-26',visibleIds:[1,2,3],workspaceVersion:'original'},userCommand:'Increase each value by 10% and shift each saved date by two days.'};
}
const requirement=(stepIds=['edit'],satisfied=true,requiredOutputs=[])=>({description:'Adjust the saved cells',evidenceKind:'compiled_action',stepIds,requiredOutputs,satisfied});
const transformKinds=['per_record_percentage','per_record_date_shift'];
const coverage=(payload,result,computed,outputs=transformKinds,stepIds=['edit'],evidenceKind='compiled_action')=>Review.validateReview({
  requirements:[{...requirement(stepIds,true,outputs),evidenceKind}],issues:[],clarificationQuestion:null
},result,{pipeline:payload.pipeline,computed});

test('compiler and reviewer share the exact saved-cell intent, operand and blank policy contract',()=>{
  for(const instructions of [Review.compilerInstructions,Review.instructions]){
    assert(instructions.includes(Review.transformInstructions));
    for(const pattern of [/require workspace_plan select_records then update_records/,/operation adjust_percent or shift_date/,
      /Never replace a requested saved-cell transform with set/,/Absolute set each value/,/Two days from today is a today-based set/,
      /original authorized snapshot/,/zero remains a real number/,/skip is allowed only when the user explicitly asks/,
      /never silently filter them out/,/requiredOutputs \[per_record_percentage\]/,/\[per_record_date_shift\]/,
      /Derive these outputs from the semantic request/,/never downgrade them to \[\]/,/Reject\/repair that mismatch/])assert.match(instructions,pattern);
  }
  assert.match(Review.instructions,/Requested percentage reads/);
  assert(Review.compilerInstructions.endsWith(Review.familyInstructions));assert(Review.instructions.endsWith(Review.familyInstructions));
});

test('review evidence identifies original saved bases and ignores planner-calculated prose',()=>{
  const payload=fixture(),before=structuredClone(payload),result={crmAction:plan(percent(),shift()),assistantMessage:'All values are now 77777 and dates are today.'};
  const computed=Review.evidence(payload,result),index=computed.recordTransformEvidence[0];
  assert.equal(index.stepId,'edit');assert.equal(index.selection,'selected');assert.equal(index.source,'original_record');
  assert.deepEqual(index.recordIds,[1,2,3]);assert.equal(index.cells.length,6);
  assert.deepEqual(index.cells.filter(cell=>cell.operation==='adjust_percent').map(cell=>[cell.before,cell.after]),[[10000,11000],[20000,22000],[0,0]]);
  assert.deepEqual(index.cells.filter(cell=>cell.operation==='shift_date').map(cell=>[cell.before,cell.after,cell.baseDate]),[
    ['2026-10-27','2026-10-29','2026-10-27'],['2026-10-28','2026-10-30','2026-10-28'],['2026-10-30','2026-11-01','2026-10-30']]);
  assert.deepEqual(payload,before);assert.equal(computed.lifecycle.executed,false);assert.equal(computed.lifecycle.writesApplied,0);
  const answer=Review.renderAnswer(payload,result,computed);assert.doesNotMatch(answer,/77777|dates are today/);
  assert.match(answer,/0 \+ 10% = 0/);assert.match(answer,/base date \(saved\): 2026-10-27/);
  assert.match(Review.schemaFor(result.crmAction,{pipeline:payload.pipeline,computed}).properties.requirements.items.properties.stepIds.description,/original-snapshot bases/);
});

test('original evidence survives earlier assignments and empty selections remain explicitly empty',()=>{
  const payload=fixture(),a=F.plan([F.select('selected'),update([{field:'f_value',operation:'set',value:999}], 'earlier'),update([percent()])]);
  const e=Review.evidence(payload,{crmAction:a});assert.deepEqual(e.recordTransformEvidence[0].cells.map(cell=>cell.before),[10000,20000,0]);
  a.steps[0].where=[[F.where('f_value','lt',0)]];
  const empty=Review.evidence(payload,{crmAction:a});assert.deepEqual(empty.recordTransformEvidence,[{stepId:'edit',selection:'selected',source:'original_record',recordIds:[],cells:[]}]);
  assert.equal(empty.mutates,false);
});

test('absolute sets never masquerade as transforms and still support explicit today-relative dates',()=>{
  const payload=fixture(),result={crmAction:plan({field:'f_value',operation:'set',value:11000},{field:'f_follow',operation:'set',value:{dateMode:'calendar_days',date:null,offset:2}}),assistantMessage:'I increased each value by 10% and shifted each saved date.'};
  const e=Review.evidence(payload,result);assert.deepEqual(e.recordTransformEvidence,[]);
  assert.match(e.calculations[0],/2026-10-26 \+ 2 calendar days = 2026-10-28/);
  const review={requirements:[requirement(['edit'],false)],issues:['Relative saved-cell intent needs typed transforms, not constant replacements.'],clarificationQuestion:null};
  assert.equal(Review.validateReview(review,result,{pipeline:payload.pipeline,computed:e}).ok,false);
  assert.equal(Review.validateReview({...review,requirements:[requirement()],issues:[]},result,{pipeline:payload.pipeline,computed:e}).ok,true,'An independently reviewed absolute-set intent remains valid');
  for(const outputs of [transformKinds,...transformKinds.map(kind=>[kind])]){
    const rejected=coverage(payload,result,e,outputs);assert.equal(rejected.ok,false);
    assert.equal(rejected.mappingReasons.unsupported_required_output,1);assert.match(rejected.mappingIssues[0],/Literal sets/);
  }
});

test('review-only transform output schema extends, but never mutates, the read output contract',()=>{
  const Reads=require('../lib/read-output-contract'),before=JSON.stringify(Reads.schema);
  const action=plan({field:'f_value',operation:'set',value:11000});
  const schema=Review.schemaFor(action).properties.requirements.items.properties.requiredOutputs;
  assert.deepEqual(schema.items.enum,[...Reads.schema.items.enum,...transformKinds,'preview_only','unchanged_records','unchanged_tasks','unchanged_schema','unchanged_kpis','kpi_definition','view_definition']);
  assert.equal(schema.maxItems,schema.items.enum.length);assert.equal(JSON.stringify(Reads.schema),before);
  assert.match(schema.description,/even if the proposed action is a literal set/);
  for(const kind of transformKinds)assert.equal(Reads.supports(action,['edit'],[kind]),false);
});

test('typed requirements need their own compiled operations, original evidence and exact update step IDs',()=>{
  const payload=fixture(),result={crmAction:F.plan([F.select('selected'),update([percent()],'percent'),update([shift()],'date')])};
  const computed=Review.evidence(payload,result),check=(outputs,ids,kind)=>coverage(payload,result,computed,outputs,ids,kind).ok;
  assert.equal(check(transformKinds,['percent','date']),true);
  assert.equal(check(['per_record_percentage'],['percent']),true);assert.equal(check(['per_record_date_shift'],['date']),true);
  for(const [outputs,ids] of [[transformKinds,['percent']],[['per_record_percentage'],['date']],[['per_record_date_shift'],['percent']],
    [transformKinds,['selected','percent','date']],[transformKinds,['root']],[transformKinds,[]],[transformKinds,['percent','percent','date']],
    [['per_record_percentage','per_record_percentage'],['percent']],[['per_record_percentage','count'],['percent']],[['percentages'],['percent']]])assert.equal(check(outputs,ids),false);
  for(const kind of ['computed_read','conversation','clarification','unavailable'])assert.equal(check(transformKinds,['percent','date'],kind),false);
  assert.equal(coverage(payload,result,undefined,transformKinds,['percent','date']).ok,false);
});

test('model-calculated literals that exactly match both transforms still cannot satisfy typed requirements',()=>{
  const payload=fixture(),steps=payload.pipeline.records.flatMap((row,i)=>[
    F.select('row_'+i,[[F.where('f_deal','equals',row.f_deal)]]),
    {...update([{field:'f_value',operation:'set',value:[11000,22000,0][i]},
      {field:'f_follow',operation:'set',value:['2026-10-29','2026-10-30','2026-11-01'][i]}],'edit_'+i),selection:'row_'+i}
  ]),result={crmAction:F.plan(steps)},computed=Review.evidence(payload,result);
  assert.deepEqual(computed.recordTransformEvidence,[]);
  assert.equal(coverage(payload,result,computed,transformKinds,['edit_0','edit_1','edit_2']).ok,false);
  const forged={...computed,recordTransformEvidence:Review.evidence(payload,{crmAction:plan(percent(),shift())}).recordTransformEvidence};
  assert.equal(coverage(payload,result,forged,transformKinds,['edit_0','edit_1','edit_2']).ok,false);
  assert.equal(coverage(payload,result,computed,[],['edit_0','edit_1','edit_2']).ok,true,'Explicit absolute replacements retain their old contract');
});

test('canonical evidence cannot be copied, altered or replayed against a different action or snapshot',()=>{
  const changes=[(p,r,c)=>c.recordTransformEvidence[0].cells[0].before=999,
    (p,r,c)=>c.recordTransformEvidence[0].cells[0].after=999,
    (p,r,c)=>c.recordTransformEvidence[0].cells[1].baseDate=p.pipeline.currentDate,
    (p,r,c)=>c.recordTransformEvidence[0].cells[0].operand.percent=20,
    (p,r,c)=>c.recordTransformEvidence[0].cells[0].skipped=true,
    (p,r,c)=>c.recordTransformEvidence[0].recordIds.pop(),
    (p,r,c)=>c.recordTransformEvidence[0].source='model',
    (p,r,c)=>c.recordTransformEvidence[0].cells.pop(),
    (p,r,c)=>c.patches[0].changes[0].after=999,
    (p,r,c)=>c.calculations.push('Fabricated'),
    p=>p.pipeline.records[0].f_value=999,
    p=>p.pipeline.visibleIds.reverse(),
    p=>p.pipeline.currentDate='2026-10-27',
    p=>p.pipeline.workspaceVersion='new-version',
    p=>p.pipeline.tableSchema.fields.find(field=>field.id==='f_value').type='text',
    (p,r)=>r.crmAction.steps[1].assignments[0].value.percent=20];
  for(const change of changes){
    const payload=fixture(),result={crmAction:plan(percent(),shift())},computed=Review.evidence(payload,result);
    assert.equal(coverage(payload,result,computed).ok,true);change(payload,result,computed);
    assert.equal(coverage(payload,result,computed).ok,false);
  }
  const payload=fixture(),result={crmAction:plan(percent(),shift())},computed=Review.evidence(payload,result);
  assert.equal(coverage(payload,result,structuredClone(computed)).ok,false);
  assert.equal(coverage(structuredClone(payload),result,computed).ok,false);
});

test('typed transform evidence covers zero, explicit blank skips and genuinely empty selections',()=>{
  for(const mode of ['zero','skip','empty']){
    const payload=fixture();payload.pipeline.records=payload.pipeline.records.slice(0,1);
    payload.pipeline.records[0].f_value=mode==='skip'?null:0;payload.pipeline.records[0].f_follow=mode==='skip'?'':'2026-10-27';
    const result={crmAction:plan(percent(10,mode==='skip'?'skip':'error'),shift(0,mode==='skip'?'skip':'error'))};
    if(mode==='empty')result.crmAction.steps[0].where=[[F.where('f_value','lt',0)]];
    const computed=Review.evidence(payload,result);assert.equal(computed.mutates,false);assert.equal(coverage(payload,result,computed).ok,true);
  }
});

test('signed decimal percentages and calendar/business shifts advertise only their typed compiled effects',()=>{
  for(const [amount,offset,dateMode] of [[-10.5,-2,'business_days'],[0.25,2,'business_days'],[-100,-2,'calendar_days']]){
    const payload=fixture(),date=shift(offset);date.value.dateMode=dateMode;
    const result={crmAction:plan(percent(amount),date)},computed=Review.evidence(payload,result);
    assert.equal(coverage(payload,result,computed).ok,true);
    const cells=computed.recordTransformEvidence[0].cells;
    assert.equal(cells[0].operand.percent,amount);assert.equal(cells[1].operand.dateMode,dateMode);
    assert.equal(cells[1].baseDate,'2026-10-27');
  }
});

test('transform contract rejection diagnostics retain only bounded static reasons',()=>{
  const payload=fixture(),result={crmAction:plan({field:'f_value',operation:'set',value:11000})},computed=Review.evidence(payload,result);
  const r={requirements:[{...requirement(['edit'],true,transformKinds),description:'PRIVATE requested cells'}],issues:[],clarificationQuestion:null};
  const c=Review.validateReview(r,result,{pipeline:payload.pipeline,computed});
  const log=Review.validationDiagnostic({stage:'mapping',review:r,coverage:c,action:result.crmAction});
  assert.deepEqual(log.codes,['evidence_mapping_invalid']);assert.equal(log.mappingReasons.unsupported_required_output,1);
  assert.doesNotMatch(JSON.stringify(log),/PRIVATE|11000|f_value|original_record/);
});

test('later replacements cannot erase transforms and still advertise their typed effects',()=>{
  const payload=fixture();
  for(const sameStep of [false,true]){
    const literal={field:'f_value',operation:'set',value:777};
    const result={crmAction:sameStep?plan(percent(),shift(),literal):F.plan([F.select('selected'),update([percent(),shift()]),update([literal],'overwrite')])};
    const computed=Review.evidence(payload,result);
    assert.equal(coverage(payload,result,computed,['per_record_percentage']).ok,false);
    assert.equal(coverage(payload,result,computed,['per_record_date_shift']).ok,true);
    assert.equal(coverage(payload,result,computed).ok,false);
  }
});

test('blank policies and zero/no-op calculations remain visible in canonical review text',()=>{
  const payload=fixture();payload.pipeline.records=payload.pipeline.records.slice(0,2);
  payload.pipeline.records[0].f_value=0;payload.pipeline.records[1].f_value=null;
  const assignment=percent();delete assignment.value.blankPolicy;
  assert.throws(()=>Review.evidence(payload,{crmAction:plan(assignment)}),error=>error.reasonCode==='transform_blank');
  const result={crmAction:plan(percent(10,'skip'))},e=Review.evidence(payload,result),cells=e.recordTransformEvidence[0].cells;
  assert.equal(e.mutates,false);assert.deepEqual(cells.map(cell=>[cell.before,cell.after,cell.skipped]),[[0,0,false],[null,null,true]]);
  assert(cells.every(cell=>cell.operand.blankPolicy==='skip'));
  const answer=Review.renderAnswer(payload,result,e);assert.match(answer,/0 \+ 10% = 0/);assert.match(answer,/skipped by explicit blank policy/);assert.match(answer,/No changes were saved/);
  const steps=[...result.crmAction.steps,{op:'read_records',id:'count',label:'Read count',selection:'selected',showTable:false,outputs:[{kind:'count',field:null}]}];
  const combined=Review.renderAnswer(payload,{crmAction:F.plan(steps)});assert.match(combined,/0 \+ 10% = 0/);assert.match(combined,/Record count: 2/);
});

test('model schema retains the discriminated transform contract through modelSchema',()=>{
  const source=Plan.responseSchema(Core.create(F.schema)),schema=Review.modelSchema({properties:{crmAction:{anyOf:[source]}}});
  const assignments=schema.properties.crmAction.anyOf[0].properties.steps.items.anyOf.find(step=>step.properties.op.enum[0]==='update_records').properties.assignments;
  assert.deepEqual(assignments.items.anyOf.map(branch=>branch.properties.operation.enum),[['set','append'],['adjust_percent'],['shift_date']]);
  assert.equal(assignments.items.anyOf[1].properties.value.additionalProperties,false);
  assert.deepEqual(Object.keys(schema.properties.crmAction.anyOf[0].properties).slice(-1),['goals']);
});

test('all typed transform failures are allowlisted without logging private cells or labels',()=>{
  const cases=[['transform_invalid',percent('10')],['transform_type_invalid',{...shift(),field:'f_value'}],
    ['transform_blank',shift()],['transform_base_invalid',percent()],['transform_result_invalid',percent()]];
  for(const [reason,assignment] of cases){
    const payload=fixture();payload.pipeline.tableSchema.fields.find(field=>field.id===assignment.field).name='PRIVATE FIELD';
    if(reason==='transform_blank')payload.pipeline.records[1].f_follow='';
    if(reason==='transform_base_invalid')payload.pipeline.records[1].f_value='PRIVATE CELL';
    if(reason==='transform_result_invalid')payload.pipeline.records[1].f_value=1e12;
    const a=plan(assignment);a.steps[1].label='PRIVATE LABEL';const before=structuredClone(payload);
    let error;try{Review.evidence(payload,{crmAction:a});}catch(e){error=e;}
    assert(error);assert.equal(error.reasonCode,reason);assert.deepEqual(payload,before);
    assert.deepEqual(Diagnostic.describe(error,a),{action:'workspace_plan',operation:'update_records',reason});
    const log=Review.validationDiagnostic({stage:'evidence',action:a,error});assert.equal(log.compiler.reason,reason);assert.doesNotMatch(JSON.stringify(log),/PRIVATE|FIELD|CELL|LABEL|1000000000000/);
  }
  assert.equal(Diagnostic.describe({reasonCode:'transform_PRIVATE',message:'PRIVATE'},null).reason,'unclassified');
  assert.equal(Diagnostic.describe({message:'transform_blank PRIVATE'},null).reason,'unclassified','Transform categories use typed codes, not arbitrary cell text');
});
