'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('../public/business-workspace'),Compiler=require('../lib/business-compiler');
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
    assert.throws(()=>B.prepare(input,[command]),/still have values/);assert.throws(()=>Compiler.prepare(input,plan([command]),'blocked'),/still have values/);assert.deepEqual(input,before);
    const bypass=structuredClone(input.state);bypass.entityTypes[0].fields.pop();bypass.entities.filter(e=>e.typeId==='contacts').forEach(e=>delete e.values.temporary);
    assert.throws(()=>B.transition(input.state,bypass),/still have values/);
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
