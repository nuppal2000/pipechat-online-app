'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Compiler=require('../lib/business-compiler'),Workspace=require('../public/business-workspace');
const Table=require('./fixtures/record-additions.cjs');
const wid='11111111-1111-4111-a111-111111111111';
const field=(id='name',name='Name',required=true)=>({id,name,type:'text',required,options:[]});
const type=(id,name,fields=[field()])=>({id,name,fields});
const relation=(id,fromType,toType,cardinality='many_to_many')=>({id,name:id,fromType,toType,cardinality});
const putType=t=>({op:'put_type',type:t});
const putRelation=t=>({op:'put_relationship_type',type:t});
const upsert=(typeId,matchValue,alias='person',matchField='name')=>({op:'upsert_entity',alias,typeId,matchField,matchValue,mode:'reuse',values:[{field:matchField,value:matchValue}]});
const ref=(source,key)=>({source,key});
const link=(typeId,from,to)=>({op:'link',typeId,from,to});
const plan=operations=>({action:'business_plan',version:1,title:'Contact and links for confirmation',operations});
const primary=()=>ref('primary',Workspace.legacyId(wid,1));
const contact=type('contacts','Contact');
const contactDeals=relation('contact_deals','contacts','primary');
const snapshot=()=>({workspaceId:wid,version:3,role:'owner',scope:'workspace',state:{...Workspace.empty(),
  entityTypes:[type('client_companies','Client Company'),type('candidates','Candidate'),type('job_roles','Job Role')]},
  primary:{updatedAt:'2026-10-10',tableSchema:structuredClone(Table.schema),customFields:[],records:[{recordId:1,entityId:Workspace.legacyId(wid,1),values:{id:1,...Table.records[0]}}]}});
const freshContact=()=>plan([putType(contact),putRelation(contactDeals),upsert('contacts','Maya Chen'),link('contact_deals',ref('alias','person'),primary())]);
function assertRejectsUnchanged(input,action,pattern,code){
  const before=structuredClone(input);
  assert.throws(()=>Compiler.prepare(input,action,'rejected'),error=>{
    assert.match(error.message,pattern);if(code)assert.equal(error.code,code);return true;
  });
  assert.deepEqual(input,before);
}

test('QA-shaped primary account/deal plus empty recruiting types supports one explicit contact-to-primary preview',()=>{
  const input=snapshot(),before=structuredClone(input),action=freshContact();
  const prepared=Compiler.prepare(input,action,'preview');
  assert.deepEqual(input,before,'Preparing the proposal must not save anything');
  assert.equal(prepared.expectedVersion,3);assert.equal(prepared.expectedPrimaryUpdatedAt,'2026-10-10');
  assert.deepEqual(prepared.next.entityTypes.slice(0,3),before.state.entityTypes);
  assert.equal(prepared.next.entityTypes.at(-1).name,'Contact');
  assert.equal(prepared.next.entities.length,1);assert.equal(prepared.next.entities[0].values.name,'Maya Chen');
  assert.equal(prepared.next.entities[0].typeId,'contacts','The primary contact cell is not a typed contact entity');
  assert.equal(prepared.next.relationshipTypes[0].cardinality,'many_to_many');
  assert.deepEqual(prepared.next.relationships.map(r=>[r.fromId,r.toId]),[[prepared.next.entities[0].id,before.primary.records[0].entityId]]);
  assert.equal(prepared.next.entities.some(e=>e.typeId==='client_companies'),false,'No nonexistent typed company is silently created');
  assert.deepEqual(prepared.commands.map(c=>c.op),['put_type','put_relationship_type','create_entity','link']);
  assert.deepEqual(prepared,Compiler.prepare(input,action,'preview'));
});

test('the ordinary new-contact and link defaults work for other names and type IDs',()=>{
  const input=snapshot();input.primary.records[0].values.f_deal='Harbor Studio';
  const action=plan([putType(type('people','Person')),putRelation(relation('people_accounts','people','primary')),
    upsert('people','Jordan Patel','jordan'),link('people_accounts',ref('alias','jordan'),ref('primary','Harbor Studio'))]);
  const prepared=Compiler.prepare(input,action,'generic');
  assert.equal(prepared.next.entities[0].values.name,'Jordan Patel');assert.equal(prepared.next.entities[0].typeId,'people');
  assert.equal(prepared.next.relationships[0].toId,input.primary.records[0].entityId);
});

test('reuse preserves a fitting existing Client Contact type, saved facts and reverse-direction relationship contract',()=>{
  const input=snapshot(),personId='ent_22222222-2222-4222-a222-222222222222';
  input.state.entityTypes.push(type('client_contacts','Client Contact',[field('full_name','Full name'),field('email','Email',false)]));
  input.state.entities.push({id:personId,typeId:'client_contacts',values:{full_name:'Maya Chen',email:'maya@example.invalid'}});
  input.state.relationshipTypes.push(relation('deal_contacts','primary','client_contacts','one_to_many'));
  const before=structuredClone(input),action=plan([upsert('client_contacts','  MAYA   CHEN  ','maya','full_name'),link('deal_contacts',primary(),ref('alias','maya'))]);
  const prepared=Compiler.prepare(input,action,'reuse');
  assert.deepEqual(prepared.next.entityTypes,before.state.entityTypes);assert.deepEqual(prepared.next.entities,before.state.entities);
  assert.deepEqual(prepared.next.relationshipTypes,before.state.relationshipTypes);
  assert.deepEqual(prepared.commands.map(c=>c.op),['link']);assert.equal(prepared.review[0].operation,'reuse_entity');
  assert.equal(prepared.next.relationships[0].fromId,input.primary.records[0].entityId);assert.equal(prepared.next.relationships[0].toId,personId);
  assert.deepEqual(input,before);
  input.state=prepared.next;const repeated=Compiler.prepare(input,action,'repeat');
  assert.equal(repeated.mutates,false);assert.deepEqual(repeated.commands,[]);assert.equal(repeated.review[1].operation,'reuse_link');
});

test('a genuinely saved typed company and a primary deal are two distinct link targets',()=>{
  const input=snapshot(),companyId='ent_33333333-3333-4333-a333-333333333333';
  input.state.entities.push({id:companyId,typeId:'client_companies',values:{name:'Northstar Design'}});
  const before=structuredClone(input),action=plan([putType(contact),putRelation(contactDeals),putRelation(relation('contact_companies','contacts','client_companies')),
    upsert('contacts','Maya Chen'),upsert('client_companies','Northstar Design','company'),
    link('contact_deals',ref('alias','person'),primary()),link('contact_companies',ref('alias','person'),ref('alias','company'))]);
  const prepared=Compiler.prepare(input,action,'two_targets');
  assert.equal(prepared.next.entities.length,2);assert.equal(prepared.commands.filter(c=>c.op==='create_entity').length,1);
  assert.deepEqual(new Set(prepared.next.relationships.map(r=>r.toId)),new Set([companyId,input.primary.records[0].entityId]));
  assert.deepEqual(input,before);
});

test('after explicit authorization, a separate missing company can be included visibly in the proposal',()=>{
  const input=snapshot(),action=plan([putType(contact),putRelation(contactDeals),putRelation(relation('contact_companies','contacts','client_companies')),
    upsert('contacts','Maya Chen'),upsert('client_companies','Northstar Design','company'),
    link('contact_deals',ref('alias','person'),primary()),link('contact_companies',ref('alias','person'),ref('alias','company'))]);
  const before=structuredClone(input),prepared=Compiler.prepare(input,action,'explicit_company');
  assert.deepEqual(prepared.review.filter(r=>r.op==='create_entity').map(r=>[r.entity.typeId,r.entity.values.name]),[['contacts','Maya Chen'],['client_companies','Northstar Design']]);
  assert.equal(prepared.next.relationships.length,2);assert.deepEqual(input,before);
});

test('an empty Company type, a display name and a primary ID are not saved typed company identities',()=>{
  for(const key of ['Northstar Design',Workspace.legacyId(wid,1),'ent_33333333-3333-4333-a333-333333333333']){
    const input=snapshot(),action=freshContact();
    action.operations.push(putRelation(relation('contact_companies','contacts','client_companies')),link('contact_companies',ref('alias','person'),ref('entity',key)));
    assertRejectsUnchanged(input,action,/That linked entity does not exist/);
  }
});

test('relationship-before-type fails at the exact operation without relaxing dependency validation',()=>{
  const input=snapshot(),action=freshContact();
  [action.operations[0],action.operations[1]]=[action.operations[1],action.operations[0]];
  assertRejectsUnchanged(input,action,/Operation 1 \(put_relationship_type\): Invalid relationship type/,'BUSINESS_INVALID');
});

test('bidirectional lookup does not permit reversed link-write endpoints',()=>{
  const input=snapshot(),action=freshContact();
  action.operations[3]=link('contact_deals',primary(),ref('alias','person'));
  assertRejectsUnchanged(input,action,/Operation 4 \(link\): Invalid relationship endpoints/,'BUSINESS_INVALID');
});

test('aliases must be resolved before use and primary rows cannot be upserted as typed entities',()=>{
  const input=snapshot(),action=freshContact();
  [action.operations[2],action.operations[3]]=[action.operations[3],action.operations[2]];
  assertRejectsUnchanged(input,action,/not been created or resolved/);
  assertRejectsUnchanged(input,plan([upsert('primary','Northstar Design')]),/existing entity type and identity field/);
  assertRejectsUnchanged(input,plan([putType(type('primary','Deal'))]),/Invalid schema ID/,'BUSINESS_INVALID');
});

test('new many-to-many defaults never widen an existing relationship or bypass its cardinality',()=>{
  const input=snapshot();input.state=Compiler.prepare(input,freshContact(),'seed').next;
  input.state.relationshipTypes[0].cardinality='many_to_one';
  assertRejectsUnchanged(input,plan([putRelation(contactDeals)]),/Existing relationship contracts are immutable/,'BUSINESS_INVALID');
  input.primary.records.push({recordId:2,entityId:Workspace.legacyId(wid,2),values:{...input.primary.records[0].values,id:2,f_deal:'Another Deal'}});
  assertRejectsUnchanged(input,plan([upsert('contacts','Maya Chen'),link('contact_deals',ref('alias','person'),ref('primary',Workspace.legacyId(wid,2)))]),/Relationship cardinality exceeded/,'BUSINESS_INVALID');
});

test('ambiguous saved contacts and primary names still require business identity clarification',()=>{
  const input=snapshot();input.state=Compiler.prepare(input,freshContact(),'seed').next;
  input.state.entities.push({...structuredClone(input.state.entities[0]),id:'ent_44444444-4444-4444-a444-444444444444'});
  assertRejectsUnchanged(input,plan([upsert('contacts','Maya Chen')]),/More than one entity matches/);
  const duplicate=snapshot();duplicate.primary.records.push({...structuredClone(duplicate.primary.records[0]),recordId:2,entityId:Workspace.legacyId(wid,2)});
  const action=freshContact();action.operations[3].to=ref('primary','Northstar Design');
  assertRejectsUnchanged(duplicate,action,/More than one primary record matches/);
});

test('required facts and permissions are unchanged by preview defaults',()=>{
  const input=snapshot();input.state.entityTypes.push(type('contacts','Contact',[field(),field('email','Email')]));
  assertRejectsUnchanged(input,plan([upsert('contacts','Maya Chen')]),/A required field is empty: email/,'BUSINESS_INVALID');
  assertRejectsUnchanged({...snapshot(),role:'viewer'},freshContact(),/read-only/,'BUSINESS_INVALID');
  assertRejectsUnchanged({...snapshot(),role:'editor'},freshContact(),/Only the owner can change schema/,'BUSINESS_INVALID');
  const editor=snapshot();editor.state.entityTypes.push(contact);editor.state.relationshipTypes.push(contactDeals);editor.role='editor';
  assert.equal(Compiler.prepare(editor,plan(freshContact().operations.slice(2)),'editor_existing_schema').next.entities.length,1);
});

test('planner guidance supplies defaults while preserving identity, representation and authorization distinctions',()=>{
  const guidance=Compiler.instructions;
  for(const pattern of [/user's noun/,/Do not ask Contact versus Client Contact/,/NEW ordinary association/,/cardinality many_to_many/,
    /Never widen an existing contract/,/empty Company type contains no saved company records/,/ask one concrete business question/,
    /Do not silently create the missing company/,/link writes MUST follow/,/Compile in dependency order/,/Preview before saving already authorizes preparing/])assert.match(guidance,pattern);
  assert.doesNotMatch(guidance,/Maya Chen|Northstar Design/,'Guidance must not special-case the live acceptance names');
});
