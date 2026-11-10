'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Review=require('../lib/action-review'),Scoped=require('../lib/scoped-table-request');
const F=require('./fixtures/workspace-plans.cjs');

function fixture(prefix='QA1110',edit=()=>{},native=false){
  const p=F.workspace();
  p.records=[null,'',0,14999.99,15000,15000.01,20000].map((value,i)=>({...p.records[0],id:i+1,
    f_deal:(i===6?'Other':prefix)+' '+i,f_value:value,f_priority:i===5?'High':'Low',f_notes:'Keep '+i}));
  Object.assign(p,{visibleIds:[7],workspaceVersion:'v1',currentDate:'2026-11-10'});
  const scope=F.where('f_deal','starts_with',prefix);
  const action=native?F.plan([
    F.select('upper',[[scope,F.where('f_value','gte',15000)]]),F.select('lower',[[scope,F.where('f_value','lt',15000)]]),
    F.update('set_high','upper','f_priority','High'),F.update('set_medium','lower','f_priority','Medium')
  ]):Scoped.compile({action:'scoped_table_request',title:'Classify priorities',source:'all',where:[[scope]],
    operation:{kind:'classify_number',numberField:'f_value',operator:'gte',threshold:15000,targetField:'f_priority',whenTrue:'High',otherwise:'Medium',whenBlank:'unchanged'}});
  edit(p,action);
  const result={crmAction:action},computed=Review.evidence({pipeline:p},result),context={pipeline:p,computed};
  return {p,action,result,computed,context,schema:Review.schemaFor(action,context),check:requirements=>Review.validateReview(envelope(requirements),result,context)};
}
const requirement=(kind,ids,outputs=[],description='Requested outcome')=>({description,evidenceKind:kind,stepIds:ids,requiredOutputs:outputs,satisfied:true});
const constraint=(id,output='unchanged_records')=>requirement('constraint',[id],[output]);
const envelope=requirements=>({requirements,issues:[],clarificationQuestion:null,answerIntent:'canonical',answerSelection:null});
const writes=f=>f.action.steps.filter(s=>s.op==='update_records').map(s=>requirement('compiled_action',[s.id]));

// Check the actual wire shape, including anyOf alongside the legacy properties.
function accepts(s,v){
  if(s.anyOf&&!s.anyOf.some(branch=>accepts(branch,v)))return false;
  if(s.enum&&!s.enum.includes(v))return false;
  if(s.type){
    const type=v===null?'null':Array.isArray(v)?'array':typeof v;
    if(!(Array.isArray(s.type)?s.type:[s.type]).includes(type))return false;
  }
  if(Array.isArray(v))return (s.minItems===undefined||v.length>=s.minItems)&&(s.maxItems===undefined||v.length<=s.maxItems)&&v.every(x=>accepts(s.items,x));
  if(v&&typeof v==='object')return (!s.required||s.required.every(key=>Object.hasOwn(v,key)))&&Object.keys(v).every(key=>
    s.properties?.[key]?accepts(s.properties[key],v[key]):s.additionalProperties!==false);
  return true;
}

for(const prefix of ['QA1105','QA1110'])for(const native of [false,true])test(prefix+' conditional literal updates and skip-blank witness have compatible independent mappings ('+(native?'native':'compact')+')',()=>{
  const f=fixture(prefix,undefined,native),requirements=[...writes(f),constraint('unchanged:records:blank:f_value')];
  assert(accepts(f.schema,envelope(requirements)));assert(f.check(requirements).ok);
  assert(f.schema.properties.requirements.items.anyOf);
  assert.deepEqual(Review.allowedStepIdsFor(f.action,f.context),f.schema.properties.requirements.items.properties.stepIds.items.enum);
  assert.deepEqual(f.computed.recordUpdateEvidence.map(p=>[p.selectedCount,p.changedCells,p.finalValuesMatch]),[[2,1,true],[2,2,true]]);
  assert.deepEqual(f.computed.patches.map(p=>p.id),[3,4,5]);
  assert.match(f.schema.properties.requirements.items.description,/Skip missing amounts/);
  assert.match(f.schema.properties.requirements.items.anyOf[0].properties.stepIds.description,/Priority/);
});

test('representative satisfied reviewer mis-mappings reproduce the live 9/7 and 10/8 unsupported-output counts',()=>{
  // Live telemetry contains counts, not the raw model requirements. These are
  // representative rejected wire shapes, not a claim to replay that payload.
  const f=fixture(),base=[...writes(f),constraint('unchanged:records:blank:f_value'),constraint('unchanged:records:outside:known_values'),
    constraint('unchanged:schema','unchanged_schema'),constraint('unchanged:tasks','unchanged_tasks'),constraint('lifecycle:preview_only','preview_only')];
  for(const invalid of [writes(f).map(r=>({...r,requiredOutputs:['fields']})),[
    requirement('compiled_action',['known_values'],['unchanged_records']),requirement('constraint',[writes(f)[0].stepIds[0]],['unchanged_records'])]]){
    for(const extra of [[],[writes(f)[0]]]){
      const requirements=[...base,...extra,...invalid],failed=f.check(requirements);
      assert.equal(failed.ok,false);assert.equal(failed.requested,9+extra.length);assert.equal(failed.compiled,7+extra.length);
      assert.equal(failed.mappingReasons.unsupported_required_output,2);
      assert(!accepts(f.schema,envelope(requirements)),'the wire schema must prevent the incompatible satisfied mappings');
      const repaired=[...base,...extra,...writes(f)];
      assert(accepts(f.schema,envelope(repaired)));assert(f.check(repaired).ok);
    }
  }
});

test('no-op and empty updates prove only ordinary proposals, never requested read outputs or blanket preservation',()=>{
  for(const state of ['already correct','empty','all unknown']){
    const f=fixture('QA1110',p=>p.records.forEach(row=>{
      if(state==='already correct'&&row.f_deal.startsWith('QA1110')&&typeof row.f_value==='number')row.f_priority=row.f_value>=15000?'High':'Medium';
      if(state==='empty')row.f_deal='Other';
      if(state==='all unknown')row.f_value=null;
    }));
    assert.equal(f.computed.patches.length,0);assert(f.check(writes(f)).ok);assert(accepts(f.schema,envelope(writes(f))));
    for(const output of ['fields','names','count','sum','average','groups','difference','derived_sum','unchanged_records','preview_only','literal_numeric_assignment']){
      const invalid=[{...writes(f)[0],requiredOutputs:[output]}];
      assert(!f.check(invalid).ok,output);assert(!accepts(f.schema,envelope(invalid)),output);
    }
    assert(!f.check([requirement('computed_read',writes(f)[0].stepIds,['fields'])]).ok);
    assert(!f.check([requirement('compiled_action',['known_values'])]).ok,'a selection is not an update witness');
  }
  const f=fixture();assert(!f.check([constraint('unchanged:records')]).ok,'partial preservation is not whole-table preservation');
  assert(!f.check([constraint('unchanged:records:blank:f_value','unchanged_tasks')]).ok);
});

test('missing or semantically wrong outcomes retain an unrestricted explicit unmet path',()=>{
  const f=fixture();
  for(const [kind,outputs,description] of [
    ['compiled_action',[],'Wrong Priority value, threshold, grouping or cohort'],
    ['computed_read',['names','fields','difference'],'Also return each name and an explicit comparison'],
    ['constraint',['unchanged_records'],'A requested protected population is not preserved'],
    ['clarification',[],'Which of the ambiguous owners was intended?']
  ]){
    const unmet={...requirement(kind,[],outputs,description),satisfied:false},review=envelope([...writes(f),unmet]);
    assert(accepts(f.schema,review));assert(!f.check(review.requirements).ok);
  }
  const review=envelope(writes(f));review.issues=['Actual scope differs from the requested scope'];
  assert(!Review.validateReview(review,f.result,f.context).ok);
});

test('literal witnesses reject stale, copied, forged and overwritten prepared results',()=>{
  for(const mutate of [f=>f.context.computed=structuredClone(f.computed),f=>f.p.records[0].f_value=10,
    f=>f.action.steps.find(s=>s.op==='update_records').assignments[0].value='Low',
    f=>f.computed.recordUpdateEvidence[0].selectedCount=999,f=>f.p.workspaceVersion='v2']){
    const f=fixture();mutate(f);assert(!f.check(writes(f)).ok);
    assert(!Review.schemaFor(f.action,f.context).properties.requirements.items.anyOf,'stale evidence cannot shape available witnesses');
  }
  const f=fixture('QA1110',(p,a)=>{
    const write=a.steps.find(s=>s.op==='update_records');a.steps.push(F.update('overwrite',write.selection,'f_priority','Low'));
    a.goals.push({description:'Unexpected overwrite',stepIds:['overwrite']});
  });
  const old=writes(f)[0];assert.equal(f.computed.recordUpdateEvidence[0].finalValuesMatch,false);
  assert(!f.check([old]).ok);assert(!accepts(f.schema,envelope([old])));
  for(const ids of [[],['invented'],[old.stepIds[0],old.stepIds[0]],['unchanged:records:blank:f_value']]){
    assert(!f.check([requirement('compiled_action',ids)]).ok);
  }
});

test('skip-blank proof disappears after any protected-row edit, not only an amount or priority edit',()=>{
  const f=fixture('QA1110',(p,a)=>{
    a.steps.push(F.update('touch_notes','population','f_notes','changed'));a.goals.push({description:'Unexpected edit',stepIds:['touch_notes']});
  });
  const keep=constraint('unchanged:records:blank:f_value');
  assert(!f.computed.constraintEvidence.some(p=>p.id===keep.stepIds[0]));
  assert(!f.check([keep]).ok);assert(!accepts(f.schema,envelope([keep])));
});

test('mixed operations, numeric writes, transforms and dynamic date values keep the generic contract',()=>{
  for(const edit of [(p,a)=>{a.steps.push({op:'read_records',id:'read',label:'Read records',selection:'known_values',outputs:[{kind:'names',field:null}],showTable:false});a.goals.push({description:'Read',stepIds:['read']});},
    (p,a)=>{const s=a.steps.find(s=>s.op==='update_records');s.assignments=[{field:'f_value',operation:'set',value:123}];},
    (p,a)=>{const s=a.steps.find(s=>s.op==='update_records');s.assignments=[{field:'f_value',operation:'adjust_percent',value:{percent:10,blankPolicy:'error'}}];},
    (p,a)=>{const s=a.steps.find(s=>s.op==='update_records');s.assignments=[{field:'f_follow',operation:'set',value:{dateMode:'business_days',date:null,offset:2}}];}]){
    const f=fixture('QA1110',edit);assert.equal(f.computed.recordUpdateEvidence,undefined);assert(!f.schema.properties.requirements.items.anyOf);
  }
});

test('long literal text falls back to generic mapping without dropping or truncating evidence',()=>{
  const f=fixture('QA1110',(p,a)=>a.steps.filter(s=>s.op==='update_records').forEach(s=>s.assignments=[{field:'f_notes',operation:'set',value:'x'.repeat(9000)}]));
  assert(!f.schema.properties.requirements.items.anyOf);
  assert.equal(f.computed.recordUpdateEvidence[0].assignments[0].value.length,9000);assert(f.check(writes(f)).ok);
});

test('the wire schema stays strict and retains difference intent without adding unsupported output authority',()=>{
  const f=fixture();let properties=0,enums=0;
  const visit=s=>{
    if(s.type==='object'){assert.equal(s.additionalProperties,false);assert.deepEqual(s.required,Object.keys(s.properties));properties+=s.required.length;Object.values(s.properties).forEach(visit);}
    if(s.enum)enums+=s.enum.length;if(s.items)visit(s.items);if(s.anyOf)s.anyOf.forEach(visit);
  };
  visit(f.schema);assert(properties<5000&&enums<1000);assert.equal(f.schema.type,'object');assert(!f.schema.anyOf);
  assert.match(Review.instructions,/difference, dollar gap or by-how-much/);assert.match(Review.instructions,/not sum alone/);
  assert.match(Review.instructions,/requested current cohort/);
  assert.match(Review.instructions,/weighted sum or sum of per-record products requires requiredOutputs \[derived_sum\]/);
  assert.match(Review.instructions,/contributions, coverage and final value/);
  assert(f.schema.properties.requirements.items.properties.requiredOutputs.items.enum.includes('difference'));
  assert(f.schema.properties.requirements.items.properties.requiredOutputs.items.enum.includes('derived_sum'));
});
