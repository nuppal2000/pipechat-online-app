'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Typed=require('../lib/scoped-table-request'),F=require('./fixtures/workspace-plans.cjs');
const definition='numeric_field_definition',assignment='literal_numeric_assignment';
const names=['QA1105 Cedar Consulting','QA1105 Cedar North','QA1105 Maple Retail','QA1105 Elm Design','Control Other','Hidden control'];
const column='Probability percent';
const add=(type='number')=>({op:'add_field',id:'metric',label:'This label is not a field name',name:column,type,options:[]});
const select=(i,id='row_'+i)=>({...F.select(id,[[F.where('f_deal','equals',names[i])]]),label:'Misleading selector label'});
function run(action,configure){
  const p={...F.workspace(),visibleIds:[6],workspaceVersion:'review-v1',currentDate:'2026-11-10'};
  p.records.forEach((r,i)=>{r.f_deal=names[i];});configure?.(p);
  const result={crmAction:action},computed=Review.evidence({pipeline:p},result);
  return {result,context:{pipeline:p,computed},proofs:computed.numericAssignmentEvidence??[]};
}
const req=(stepId,output,evidenceKind='compiled_action')=>({description:'User-supplied outcome',satisfied:true,evidenceKind,
  stepIds:Array.isArray(stepId)?stepId:[stepId],requiredOutputs:[output]});
const check=({result,context},requirements)=>Review.validateReview({requirements,issues:[]},result,context);

for(const kind of ['native original','expanded original','native variant','expanded variant']){
  test('numeric assignment proof: '+kind,()=>{
    const variant=kind.endsWith('variant'),indexes=variant?[2,3]:[0,1,2],values=variant?[12.5,0]:[50,80,25],fieldName=variant?'QA confidence':column;
    const action=kind.startsWith('native')?F.plan([{...add(),name:fieldName},...indexes.flatMap((i,k)=>[select(i),F.update('set_'+i,'row_'+i,'@metric',values[k])])]):
      Typed.compile({action:'scoped_table_request',title:'Populate number field',source:'all',where:[],operation:{kind:'add_named_numbers',name:fieldName,
        entries:indexes.map((i,k)=>({recordName:names[i],value:values[k]}))}});
    const state=run(action),[field,...updates]=state.proofs;
    assert.equal(field.stepId,action.steps[0].id);assert.equal(field.output,definition);
    assert.deepEqual([field.fieldName,field.fieldType,field.recordCount,field.blankCount,field.populatedCount],[fieldName,'number',6,6-indexes.length,indexes.length]);
    assert.deepEqual(updates.map(p=>[p.output,p.stepId,p.selection,p.primaryField,p.cells.length]),action.steps.filter(s=>s.op==='update_records').map(s=>[assignment,s.id,s.selection,'f_deal',1]));
    assert.deepEqual(updates.map(p=>p.cells[0]),indexes.map((i,k)=>({recordId:i+1,primaryName:names[i],nameMatchCount:1,
      fieldId:field.fieldId,fieldName,fieldType:'number',before:null,after:values[k]})));
    const review=check(state,[{...req(field.stepId,definition),description:'Create number column '+fieldName},
      ...indexes.map((i,k)=>({...req(updates[k].stepId,assignment),description:'Give '+names[i]+' '+values[k]+' in '+fieldName}))]);
    assert.equal(review.ok,true);assert.equal(review.compiled,updates.length+1);
    const schema=Review.schemaFor(action,state.context).properties.requirements.items.properties.requiredOutputs;
    for(const output of [definition,assignment])assert.ok(schema.items.enum.includes(output));
    assert.match(schema.description,/not saved-data reads/);assert.match(Review.instructions,/missing, extra or swapped assignments/);
    assert.deepEqual(state.context.computed.queryResults,[]);assert.equal(state.context.computed.lifecycle.writesApplied,0);
  });
}

test('only the final writer can prove the full selection, even after restoration or an identical overwrite',()=>{
  const action=F.plan([add(),F.select('all_targets'),select(0),
    F.update('bulk','all_targets','@metric',0),F.update('middle','row_0','@metric',12.5),F.update('restore','row_0','@metric',0),
    F.update('last','row_0','@metric',0)]);
  const state=run(action);
  assert.deepEqual(state.proofs.map(p=>p.stepId),['metric','last']);
  assert.equal(state.proofs[0].populatedCount,6);
  for(const id of ['bulk','middle','restore'])assert.equal(check(state,[req(id,assignment)]).ok,false,id);
  assert.equal(check(state,[req('last',assignment)]).ok,true);
  const overwrite=F.update('two','row_0','@metric',0);overwrite.assignments.push({...overwrite.assignments[0],value:8});
  assert.deepEqual(run(F.plan([add(),select(0),overwrite])).proofs.map(p=>p.stepId),['metric']);
});

test('false labels do not hide a wrong row/value, ambiguous primary name or extra nonvisible rows',()=>{
  const action=F.plan([add(),{...select(1),label:names[0]}, {...F.update('claimed_cedar','row_1','@metric',8),label:names[0]+' gets 50'}]);
  const state=run(action,p=>{p.records[5].f_deal=names[1];});
  const [field,update]=state.proofs;
  assert.equal(field.populatedCount,2);assert.deepEqual(update.cells.map(c=>[c.primaryName,c.recordId,c.nameMatchCount,c.after]),[[names[1],2,2,8],[names[1],6,2,8]]);
  assert.equal(check(state,[{...req(update.stepId,assignment),satisfied:false}]).ok,false);
});

test('text fields, currency, clears, transforms, empty targets and mixed assignments cannot borrow a numeric proof',()=>{
  const steps=[add(),{...add('text'),id:'text',name:'Text number'},select(0),
    F.select('none',[[F.where('f_deal','equals','Not here')]]),F.update('empty','none','@metric',8),
    F.update('text_set','row_0','@text','12'),F.update('money','row_0','f_value',0),
    F.update('clear','row_0','@metric','')];
  const mixed=F.update('mixed','row_0','@metric',3);mixed.assignments.push({field:'f_notes',operation:'set',value:'3'});
  const state=run(F.plan([...steps,mixed]));
  assert.deepEqual(state.proofs.map(p=>p.stepId),['metric']);
  const shift={...F.update('shift','row_0','@metric',null),assignments:[{field:'@metric',operation:'adjust_percent',value:{percent:10,blankPolicy:'skip'}}]};
  assert.deepEqual(run(F.plan([add(),select(0),shift])).proofs.map(p=>p.stepId),['metric']);
});

test('existing number field uses the original authorized value and an overwriting clear invalidates it',()=>{
  const configure=p=>{p.customFields=[{id:'cf_score',name:'Score',type:'number'}];p.records[0].cf_score=0;};
  const steps=[select(0),F.update('write','row_0','cf_score','12.5')];
  const state=run(F.plan(steps),configure);
  assert.deepEqual(state.proofs.map(p=>[p.output,p.cells[0].before,p.cells[0].after]),[[assignment,0,12.5]]);
  assert.deepEqual(run(F.plan([...steps,F.update('clear','row_0','cf_score','')]),configure).proofs,[]);
});

test('outputs require the actual write step, kind and unmodified action-bound authorized snapshot',()=>{
  const a=F.plan([add(),select(0),F.update('write','row_0','@metric',0)]),s=run(a);
  for(const r of [req('metric',assignment),req('write',definition),req('row_0',assignment),req(['write','row_0'],assignment),
    req('write','fields'),req('write','names'),req('write',assignment,'computed_read'),req('metric',definition,'constraint'),
    {...req('write',assignment),requiredOutputs:[assignment,'fields']}])assert.equal(check(s,[r]).ok,false,JSON.stringify(r));
  const r=[req('write',assignment)],{context}=s;
  assert.match(check(s,[req('write','names')]).mappingIssues[0],/Independently requested saved-data answers still require real read evidence/);
  assert.equal(check({...s,context:{...context,computed:structuredClone(context.computed)}},r).ok,false);
  assert.equal(check({...s,context:{...context,pipeline:structuredClone(context.pipeline)}},r).ok,false);
  const different=structuredClone(a);different.steps.at(-1).assignments[0].value=8;
  assert.equal(check({...s,result:{crmAction:different}},r).ok,false);
  context.pipeline.records[4].f_notes='changed outside selection';assert.equal(check(s,r).ok,false);
  const altered=run(a);altered.proofs[1].cells[0].after=123;assert.equal(check(altered,r).ok,false);
});
