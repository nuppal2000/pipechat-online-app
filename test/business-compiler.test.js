const test=require('node:test'),assert=require('node:assert/strict');
const Compiler=require('../lib/business-compiler'),Workspace=require('../public/business-workspace'),Schema=require('../public/table-schema');
const wid='11111111-1111-4111-a111-111111111111';
const snapshot=()=>({workspaceId:wid,version:0,role:'owner',scope:'workspace',state:Workspace.empty(),primary:{updatedAt:'2026-10-10',tableSchema:Schema.legacySchema(),customFields:[],records:[{recordId:1,entityId:Workspace.legacyId(wid,1),values:{account:'Northstar Design'}}]}});
const field={id:'name',name:'Name',type:'text',required:true,options:[]};
const type={op:'put_type',type:{id:'contacts',name:'Contacts',fields:[field,{id:'email',name:'Email',type:'text',required:false,options:[]}]}};
const relation={op:'put_relationship_type',type:{id:'contact_deals',name:'Contact deals',fromType:'contacts',toType:'primary',cardinality:'many_to_many'}};
const person=(name='Maya Chen',alias='maya')=>({op:'upsert_entity',alias,typeId:'contacts',matchField:'name',matchValue:name,mode:'reuse',values:[{field:'name',value:name}]});
const plan=operations=>({action:'business_plan',version:1,title:'Linked contacts',operations});
test('entity schema, separate contact and typed primary relationship form one staged plan',()=>{
  const input=snapshot(),before=structuredClone(input);
  const p=Compiler.prepare(input,plan([type,relation,person(),{op:'link',typeId:'contact_deals',from:{source:'alias',key:'maya'},to:{source:'primary',key:'Northstar Design'}}]),'one');
  assert.equal(p.next.entityTypes.length,1);assert.equal(p.next.entities.length,1);assert.equal(p.next.relationships.length,1);assert.equal(p.next.relationships[0].toId,Workspace.legacyId(wid,1));assert.deepEqual(input,before);
  assert.deepEqual(p,Compiler.prepare(input,plan([type,relation,person(),{op:'link',typeId:'contact_deals',from:{source:'alias',key:'maya'},to:{source:'primary',key:'Northstar Design'}}]),'one'));
});
test('normalized identity reuse preserves unrelated values, and explicit update changes only supplied fields',()=>{
  let input=snapshot();input.state=Compiler.prepare(input,plan([type,person()]),'seed').next;input.version++;
  input.state.entities[0].values.email='synthetic@example.invalid';
  const reused=Compiler.prepare(input,plan([person('  MAYA   CHEN  ')]),'reuse');assert.equal(reused.mutates,false);assert.equal(reused.next.entities.length,1);assert.equal(reused.next.entities[0].values.email,'synthetic@example.invalid');
  const update=Compiler.prepare(input,plan([{...person(),mode:'update',values:[{field:'email',value:'changed@example.invalid'}]}]),'update');assert.equal(update.next.entities[0].values.name,'Maya Chen');assert.equal(update.next.entities[0].values.email,'changed@example.invalid');
  assert.throws(()=>Compiler.prepare(input,plan([{...person(),values:[{field:'email',value:'not-discarded@example.invalid'}]}]),'discard'),/discard supplied values/);
  assert.throws(()=>Compiler.prepare(input,plan([{...person(),mode:'unknown'}]),'invalid'),/reuse or update/);
});
test('ambiguous identities and duplicate primary labels require resolution, not a guessed link',()=>{
  let input=snapshot();input.state=Compiler.prepare(input,plan([type,person()]),'seed').next;
  input.state.entities.push({...input.state.entities[0],id:'ent_22222222-2222-4222-a222-222222222222'});
  assert.throws(()=>Compiler.prepare(input,plan([person()]),'ambiguous'),/More than one entity/);
  input=snapshot();input.primary.records.push({recordId:2,entityId:Workspace.legacyId(wid,2),values:{account:'Northstar Design'}});
  assert.throws(()=>Compiler.prepare(input,plan([type,relation,person(),{op:'link',typeId:'contact_deals',from:{source:'alias',key:'maya'},to:{source:'primary',key:'Northstar Design'}}]),'ambiguous'),/More than one primary/);
});
test('invalid dependent operation rejects the whole proposal and viewer cannot mutate',()=>{
  const input=snapshot(),before=structuredClone(input);
  assert.throws(()=>Compiler.prepare(input,plan([type,{op:'upsert_entity',alias:'a',typeId:'missing',matchField:'name',matchValue:'A',mode:'reuse',values:[]}]),'invalid'));
  assert.deepEqual(input,before);assert.throws(()=>Compiler.prepare({...input,role:'viewer'},plan([type]),'viewer'),/read-only/);
});
test('separate business domains retain existing pipeline and unrelated entity types',()=>{
  const input=snapshot();input.state=Compiler.prepare(input,plan([type]),'first').next;
  const p=Compiler.prepare(input,plan(['candidates','clients','job_roles'].map(id=>({op:'put_type',type:{id,name:id,fields:[field]}}))),'recruiting');
  assert.deepEqual(p.next.entityTypes.map(t=>t.id),['contacts','candidates','clients','job_roles']);assert.deepEqual(input.primary.records[0].values,{account:'Northstar Design'});
});
test('entity reads return canonical facts and never change workspace state',()=>{
  const input=snapshot();input.state=Compiler.prepare(input,plan([type,person()]),'seed').next;const before=structuredClone(input);
  const result=Compiler.query(input,{action:'query_business',typeId:'contacts',query:'maya'});assert.equal(result.count,1);assert.match(Compiler.describe(input,result),/Maya Chen/);assert.deepEqual(input,before);
});

test('relationship queries traverse the saved link in both directions and reject ambiguous primary names',()=>{
  const input=snapshot();input.state=Compiler.prepare(input,plan([type,relation,person(),{op:'link',typeId:'contact_deals',from:{source:'alias',key:'maya'},to:{source:'primary',key:'Northstar Design'}}]),'join').next;
  const contactId=input.state.entities[0].id,before=structuredClone(input);
  const forward=Compiler.query(input,{action:'query_business',typeId:'contacts',query:null,linkedTo:{source:'primary',key:'Northstar Design'},relationshipTypeId:'contact_deals'});
  assert.equal(forward.records[0].id,contactId);assert.equal(forward.count,1);
  const backward=Compiler.query(input,{action:'query_business',typeId:'primary',query:null,linkedTo:{source:'entity',key:contactId},relationshipTypeId:null});
  assert.equal(backward.records[0].values.account,'Northstar Design');assert.match(Compiler.describe(input,backward),/Northstar Design/);assert.deepEqual(input,before);
  input.primary.records.push({...input.primary.records[0],recordId:2,entityId:Workspace.legacyId(wid,2)});
  assert.throws(()=>Compiler.query(input,{action:'query_business',typeId:'contacts',query:null,linkedTo:{source:'primary',key:'Northstar Design'}}),/More than one linked/);
});

test('an explicit entity merge preserves the survivor and refuses unresolved field loss',()=>{
  const input=snapshot();input.state=Compiler.prepare(input,plan([type,relation,person()]),'merge-seed').next;
  const survivor=input.state.entities[0];survivor.values.email='first@example.invalid';
  const source={...structuredClone(survivor),id:'ent_22222222-2222-4222-a222-222222222222'};source.values.email='second@example.invalid';input.state.entities.push(source);
  input.state.relationships=[{id:'lnk_33333333-3333-4333-a333-333333333333',typeId:'contact_deals',fromId:source.id,toId:Workspace.legacyId(wid,1)}];
  const operation={op:'merge_entities',survivorId:survivor.id,sourceIds:[source.id],fieldResolutions:[]};
  assert.throws(()=>Compiler.prepare(input,plan([operation]),'merge'),/conflicting field/);
  const result=Compiler.prepare(input,plan([{...operation,fieldResolutions:[{field:'email',value:'second@example.invalid'}]}]),'merge');
  assert.equal(result.next.entities.length,1);assert.equal(result.next.entities[0].id,survivor.id);assert.equal(result.next.entities[0].values.email,'second@example.invalid');assert.equal(result.next.relationships[0].fromId,survivor.id);assert.notEqual(result.next.relationships[0].id,input.state.relationships[0].id);assert.equal(input.state.entities.length,2);
});
