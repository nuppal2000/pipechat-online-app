'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('../public/business-workspace'),Compiler=require('../lib/business-compiler');
const Review=require('../lib/action-review');
const wid='11111111-1111-4111-a111-111111111111';
const eid=n=>`ent_${String(n).padStart(8,'0')}-1111-4111-a111-111111111111`;
const field=(id,name,type='text',required=false)=>({id,name,type,required,options:[]});
function fixture(){
  const state=B.empty();
  state.entityTypes=[{id:'contacts',name:'Contact',fields:[field('identity','Name','text',true),field('mail','Email'),field('temporary','QAE Temporary')]},
    {id:'other',name:'Other',fields:[field('identity','Name','text',true),field('temporary','Other field')]}];
  state.entities=[{id:eid(1),typeId:'contacts',values:{identity:'QAE Morgan Lane',mail:'morgan@example.com'}},
    {id:eid(2),typeId:'contacts',values:{identity:'Other contact',temporary:null}},
    {id:eid(3),typeId:'contacts',values:{identity:'Third contact',temporary:' \t\u00a0\ufeff'}},
    {id:eid(4),typeId:'other',values:{identity:'Unrelated',temporary:'Preserve this'}}];
  state.relationshipTypes=[{id:'linked',name:'Linked',fromType:'contacts',toType:'primary',cardinality:'many_to_many'}];
  state.relationships=[{id:'lnk_22222222-2222-4222-a222-222222222222',typeId:'linked',fromId:eid(1),toId:B.legacyId(wid,1)}];
  state.views=[{id:'view_33333333-3333-4333-a333-333333333333',name:'Contacts',entityIds:[eid(1),eid(2)]}];
  return {workspaceId:wid,version:7,role:'owner',scope:'workspace',state,
    primary:{updatedAt:null,tableSchema:null,customFields:[],records:[{recordId:1,entityId:B.legacyId(wid,1),values:{account:'Keep primary'}}]}};
}
const command={op:'remove_field',typeId:'contacts',fieldId:'temporary'};
const plan=operations=>({action:'business_plan',version:1,title:'Remove unused field',operations});

test('explicit field removal preserves all Contacts, IDs, other fields/types, links, views and primary data',()=>{
  const input=fixture(),before=structuredClone(input),preview=B.fieldRemovalPreview(input.state,command);
  B.validate(input.state,{workspaceId:wid,legacyRecordIds:[1]});
  assert.equal(preview.removable,true);assert.deepEqual(preview.dependencies,[]);assert.deepEqual(preview.affectedEntityIds,[eid(2),eid(3)]);
  const expected=structuredClone(input.state);expected.entityTypes[0].fields.pop();expected.entities.slice(0,3).forEach(entity=>delete entity.values.temporary);
  const result=B.prepare(input,[command]);assert.deepEqual(result.next,expected);assert.equal(result.expectedVersion,7);assert.equal(result.expectedPrimaryUpdatedAt,null);
  B.transition(input.state,result.next);assert.deepEqual(input,before);
  const compiled=Compiler.prepare(input,plan([command]),'removal');assert.deepEqual(compiled.next,expected);
  assert.deepEqual(compiled.review[0].before,preview);assert.deepEqual(compiled.commands,[command]);
});

test('populated fields, including zero and false, are dependencies and cannot be removed',()=>{
  for(const [type,value] of [['text','Keep'],['number',0],['boolean',false]]){
    const input=fixture();input.state.entityTypes[0].fields[2].type=type;input.state.entities[2].values.temporary=null;input.state.entities[0].values.temporary=value;
    B.validate(input.state,{workspaceId:wid,legacyRecordIds:[1]});const before=structuredClone(input);
    const preview=B.fieldRemovalPreview(input.state,command);assert.equal(preview.removable,false);assert.deepEqual(preview.dependencies[0].entityIds,[eid(1)]);
    assert.throws(()=>B.prepare(input,[command]),/contains saved values/);assert.throws(()=>Compiler.prepare(input,plan([command]),'blocked'),/contains saved values/);assert.deepEqual(input,before);
    const bypass=structuredClone(input.state);bypass.entityTypes[0].fields.pop();bypass.entities.filter(e=>e.typeId==='contacts').forEach(e=>delete e.values.temporary);
    assert.throws(()=>B.transition(input.state,bypass),/contains saved values/);
  }
});

test('primary, identifying and required fields are protected even without any records',()=>{
  const input=fixture();
  for(const bad of [{...command,typeId:'primary'},{...command,fieldId:'identity'},{...command,fieldId:'missing'},{...command,typeId:'missing'}])assert.throws(()=>B.prepare(input,[bad]),/Primary|identifying|required|existing/);
  input.state.entities=[];input.state.relationships=[];input.state.views=[];
  input.state.entityTypes[0].fields[2].required=true;
  assert.throws(()=>B.prepare(input,[command]),/required/);
  input.state.entityTypes[0].fields[2].required=false;
  input.state.entityTypes[0].fields[0].required=false;
  assert.throws(()=>B.prepare(input,[{...command,fieldId:'identity'}]),/identifying/);
});

test('field deletion cannot be disguised as schema replacement or combined with collateral changes',()=>{
  const input=fixture(),type=structuredClone(input.state.entityTypes[0]);type.fields.pop();
  assert.throws(()=>B.prepare(input,[{op:'put_type',type}]),/remove_field/);
  for(const op of [{op:'update_entity',id:eid(1),values:{mail:'changed'}},{op:'delete_entity',id:eid(1)}]){
    assert.throws(()=>B.prepare(input,[command,op]),/separately/);assert.throws(()=>Compiler.prepare(input,plan([op,command]),'combined'),/separately/);
  }
  const next=B.prepare(input,[command]).next;
  for(const change of [s=>{s.entities[0].values.mail='changed';},s=>{s.entities.pop();},s=>{s.relationships=[];},s=>{s.views=[];},s=>{s.entityTypes[1].name='Changed';}]){
    const bad=structuredClone(next);change(bad);assert.throws(()=>B.transition(input.state,bad),/preserve/);
  }
  for(const role of ['editor','viewer'])assert.throws(()=>B.prepare({...input,role},[command]),/owner|read-only/);
  assert.throws(()=>B.prepare({...input,scope:'shared'},[command]),/read-only/);
});

test('schema and planner expose an explicit entity remove_field operation without primary-table substitution',()=>{
  const operation=Compiler.schemas()[0].properties.operations.items.anyOf.find(op=>op.properties.op.enum[0]==='remove_field');
  assert.deepEqual(operation.required,['op','typeId','fieldId']);assert.equal(operation.additionalProperties,false);
  assert.match(Compiler.instructions,/Never substitute primary-table delete_field/);
  assert.doesNotMatch(Compiler.instructions,/QAE Temporary|Morgan/);
});

const dependencyRead=field=>({action:'query_business',typeId:'contacts',selector:{kind:'field_removal_check',field},linkedTo:null,relationshipTypeId:null});

test('a populated Phone field has canonical read-only blocker evidence, not a removal proposal or generic failure',()=>{
  const input=fixture();input.state.entityTypes[0].fields.push(field('phone','Phone'));
  input.state.entities[0].values.phone='555-0107';input.state.entities[1].values.identity='Maya';
  const action=dependencyRead('phone'),before=structuredClone(input),payload={pipeline:{business:input}};
  const response={crmAction:action,assistantMessage:'The field was removed.'},computed=Review.evidence(payload,response);
  assert.equal(computed.mutates,false);assert.equal(computed.lifecycle.operation,'read');assert.equal(computed.lifecycle.writesApplied,0);
  assert.equal(computed.fieldRemoval.removable,false);assert.equal(computed.fieldRemoval.fieldName,'Phone');
  assert.equal(computed.fieldRemoval.typeName,'Contact');assert.equal(computed.count,1);assert.equal(computed.omittedCount,0);
  assert.deepEqual(computed.records,[{id:eid(1),typeId:'contacts',name:'QAE Morgan Lane',values:{phone:'555-0107'}}]);
  for(const key of ['next','commands','changes','expectedVersion'])assert(!Object.hasOwn(computed,key));
  const answer=Review.renderAnswer(payload,response,computed);
  assert.match(answer,/"Phone" on "Contact"/);assert.match(answer,/Removal is blocked/);
  assert.match(answer,/contains saved values in 1 entity/);assert.match(answer,/QAE Morgan Lane.*555-0107/);
  assert.match(answer,/No field or saved value was removed/);assert.doesNotMatch(answer,/Maya|morgan@example.com|The field was removed\./);
  const review={issues:[],clarificationQuestion:null,requirements:[{description:'Explain the populated-field blocker without changing anything',
    evidenceKind:'computed_read',stepIds:['root'],requiredOutputs:['dependencies'],satisfied:true}]};
  assert.equal(Review.validateReview(review,response,{pipeline:payload.pipeline}).ok,true);
  assert.throws(()=>Compiler.prepare(input,plan([{...command,fieldId:'phone'}]),'blocked'),/contains saved values/);
  assert.deepEqual(input,before);assert.deepEqual(action,dependencyRead('phone'));
  computed.records[0].values.phone='Changed';computed.fieldRemoval.dependencies[0].entityIds.pop();assert.deepEqual(input,before);
});

test('dependency reads reuse typed blank and protected-field guards, including zero and false',()=>{
  for(const [type,value] of [['number',0],['boolean',false],['text','Saved']]){
    const input=fixture();input.state.entityTypes[0].fields[2].type=type;
    input.state.entities[0].values.temporary=value;input.state.entities[2].values.temporary=null;
    const result=Compiler.query(input,dependencyRead('temporary'));
    assert.equal(result.fieldRemoval.removable,false);assert.equal(result.count,1);
    assert.equal(result.records[0].values.temporary,value);
  }
  const input=fixture();input.state.entities=[];input.state.relationships=[];input.state.views=[];
  const result=Compiler.query(input,dependencyRead('identity'));
  assert.equal(result.fieldRemoval.removable,false);assert.equal(result.count,0);
  assert.deepEqual(result.fieldRemoval.dependencies.map(item=>item.kind),['identity_field','required_field']);
  assert.match(Compiler.describe(input,result),/identifying field cannot be removed/);
});

test('an unused-field check never removes it or substitutes for the requested confirmation proposal',()=>{
  const input=fixture(),before=structuredClone(input),result=Compiler.query(input,dependencyRead('temporary'));
  assert.equal(result.fieldRemoval.removable,true);assert.equal(result.count,0);assert.deepEqual(result.records,[]);
  assert.deepEqual(result.fieldRemoval.dependencies,[]);
  assert.match(Compiler.describe(input,result),/read-only check is not a removal proposal/);
  assert.match(Compiler.describe(input,result),/prepare and confirm removal/);assert.deepEqual(input,before);
  assert.equal(Compiler.prepare(input,plan([command]),'confirmed-later').mutates,true);
  assert.match(Compiler.instructions,/When removable is true, a check alone does NOT satisfy a request to remove/);
});

test('dependency inspection cannot be narrowed to a relationship, a partial share, an unknown field or primary data',()=>{
  const input=fixture(),action=dependencyRead('temporary'),before=structuredClone(input);
  for(const bad of [{...action,typeId:null},{...action,typeId:'missing'},{...action,typeId:'primary'},
    {...action,selector:{kind:'field_removal_check',field:'QAE Temporary'}},
    {...action,selector:{kind:'field_removal_check',field:'temporary',op:'remove_field'}},
    {...action,linkedTo:{source:'entity',key:eid(1)}},{...action,relationshipTypeId:'linked'}]){
    assert.throws(()=>Compiler.query(input,bad));
  }
  assert.throws(()=>Compiler.query({...input,role:'viewer',scope:'shared'},action),/complete authorized workspace/);
  assert.equal(Compiler.query({...input,role:'viewer'},action).mutates,false,'Full-workspace readers can inspect without gaining mutation authority');
  assert.throws(()=>B.prepare({...input,role:'viewer'},[command]),/read-only/);assert.deepEqual(input,before);
});

test('large dependency reads retain full blocker counts with bounded records and canonical text',()=>{
  const input=fixture();input.state.entities=Array.from({length:5000},(_,i)=>({id:eid(i+1),typeId:'contacts',values:{identity:'Contact '+i,temporary:'Saved'}}));
  const preview=B.fieldRemovalPreview(input.state,command),stored=preview.dependencies[0];
  assert.equal(stored.count,5000);assert.equal(stored.entityIds.length,200);assert.equal(stored.omittedCount,4800);
  const result=Compiler.query(input,dependencyRead('temporary'));
  assert.equal(result.count,5000);assert.equal(result.records.length,200);assert.equal(result.omittedCount,4800);
  assert(!Object.hasOwn(result.fieldRemoval,'affectedEntityIds'));
  assert.match(Compiler.describe(input,result),/5000 records contain saved values; showing 200, 4800 omitted/);
  input.state.entities.forEach(entity=>entity.values.temporary='x'.repeat(12000));
  const long=Compiler.describe(input,Compiler.query(input,dependencyRead('temporary')));
  assert(long.length<=30000);assert.match(long,/Answer details truncated/);assert.match(long,/No changes were made/);
});

test('dependency checks compose as independently reviewed batch reads and advertise a strict selector',()=>{
  const input=fixture(),{action,...check}=dependencyRead('mail');
  const batch={action:'query_business_batch',queries:[{id:'blockers',...check},{id:'contacts',...check,selector:{kind:'all'}}]};
  const payload={pipeline:{business:input}},response={crmAction:batch},computed=Review.evidence(payload,response);
  assert.equal(computed.results[0].fieldRemoval.removable,false);assert.equal(computed.results[1].count,3);
  assert.match(Review.renderAnswer(payload,response,computed),/Read 1 \(blockers\)/);
  assert.match(Review.renderAnswer(payload,response,computed),/Read 2 \(contacts\)/);
  const requirements=['blockers','contacts'].map(id=>({description:id,evidenceKind:'computed_read',stepIds:[id],requiredOutputs:[id==='blockers'?'dependencies':'fields'],satisfied:true}));
  assert.equal(Review.validateReview({requirements,issues:[],clarificationQuestion:null},response,{pipeline:payload.pipeline}).ok,true);
  const selector=Compiler.schemas().find(branch=>branch.properties.action.enum[0]==='query_business').properties.selector.anyOf.find(branch=>branch.properties.kind.enum[0]==='field_removal_check');
  assert.deepEqual(selector.required,['kind','field']);assert.equal(selector.additionalProperties,false);assert.deepEqual(selector.properties.field,{type:'string'});
  assert.match(Review.instructions,/computed.fieldRemoval.removable false/);assert.match(Review.compilerInstructions,/repair with this read/);
});

test('required Full Name metadata is independently reviewable even with no populated records',()=>{
  for(const empty of [false,true]){
    const input=fixture();input.state.entityTypes[0].fields[0].name='Full Name';
    if(empty){input.state.entities=[];input.state.relationships=[];input.state.views=[];}
    const payload={pipeline:{business:input}},response={crmAction:dependencyRead('identity')},before=structuredClone(input);
    const computed=Review.evidence(payload,response),metadata=computed.fieldRemoval.field;
    assert.deepEqual(metadata,{id:'identity',name:'Full Name',type:'text',required:true,options:[],identifying:true});
    assert.deepEqual(computed.readEvidence,[{stepId:'root',source:'entity_field_dependencies',
      subject:{kind:'entity_field',typeId:'contacts',fieldId:'identity'},outputs:['dependencies','count','names','fields'],recordScope:'records_with_saved_values'}]);
    const review={issues:[],clarificationQuestion:null,requirements:[
      {description:'Whether the field can be removed and its blockers',evidenceKind:'computed_read',stepIds:['root'],requiredOutputs:['dependencies'],satisfied:true},
      {description:'No changes',evidenceKind:'computed_read',stepIds:['root'],requiredOutputs:[],satisfied:true}
    ]};
    assert.equal(Review.validateReview(review,response,{pipeline:payload.pipeline}).ok,true);
    const answer=Review.renderAnswer(payload,response,computed);
    assert.match(answer,/required: yes; identifying: yes/);assert.match(answer,/identifying field cannot be removed/);
    assert.match(answer,/required field cannot be removed/);assert.match(answer,/No changes were made/);
    assert.equal(computed.lifecycle.writesApplied,0);assert.deepEqual(input,before);
    const {action,...member}=response.crmAction,batch={action:'query_business_batch',queries:[{id:'field_check',...member}]};
    assert.equal(Compiler.query(input,batch).readEvidence[0].stepId,'field_check');
    assert.doesNotMatch(Compiler.instructions,/Full Name|QAE|Morgan/);
  }
});
