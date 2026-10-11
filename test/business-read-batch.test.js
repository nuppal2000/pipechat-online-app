'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Compiler=require('../lib/business-compiler'),Workspace=require('../public/business-workspace');
const Review=require('../lib/action-review');
const Schema=require('../public/table-schema'),Core=require('../public/pipeline-core');
const Table=require('./fixtures/record-additions.cjs');
const wid='11111111-1111-4111-a111-111111111111';
const field=(id,name,required=false)=>({id,name,type:'text',required,options:[]});
const plan=operations=>({action:'business_plan',version:1,title:'Fixture records and links',operations});
const reference=(source,key)=>({source,key});
const read=(id,typeId,linkedTo=null,relationshipTypeId=null,query=null)=>({id,typeId,query,linkedTo,relationshipTypeId});
const batch=queries=>({action:'query_business_batch',queries});

test('batch reads have separate review identities, canonical answers and no mutation authority',()=>{
  const f=fixture(),action=batch(f.queries),payload={pipeline:{business:f.input,tableSchema:f.input.primary.tableSchema,workspaceVersion:4}};
  const result={crmAction:action,assistantMessage:'Untrusted unsupported planner claim'};
  const computed=Review.evidence(payload,result);
  assert.equal(computed.lifecycle.operation,'read');assert.equal(computed.lifecycle.writesApplied,0);
  assert.deepEqual(Review.schemaFor(action).properties.requirements.items.properties.stepIds.items.enum,f.queries.map(q=>q.id));
  const review={issues:[],clarificationQuestion:null,requirements:f.queries.map(q=>({description:q.id,evidenceKind:'computed_read',stepIds:[q.id],satisfied:true}))};
  assert.equal(Review.validateReview(review,result).ok,true);
  review.requirements[1].stepIds=['root'];assert.equal(Review.validateReview(review,result).ok,false);
  const answer=Review.renderAnswer(payload,result,computed);
  assert.match(answer,/Read 1 \(person_links\)/);assert.match(answer,/Read 2 \(account_contacts\)/);
  assert(answer.includes(f.person));assert(answer.includes(f.account));assert.doesNotMatch(answer,/Untrusted unsupported planner claim/);
});

// Build saved-state fixtures with the actual entity compiler and primary schema.
// Nothing here contacts a backend or relies on prompt parsing or planner prose.
function fixture({person=Table.records[0].f_contact,account=Table.records[0].f_deal,typeId='contacts',nameField='name',reverse=false,legacy=false}={}){
  const tableSchema=legacy?Schema.legacySchema():structuredClone(Table.schema),core=Core.create(tableSchema);
  const primaryField=core.role('primary'),primaryId=Workspace.legacyId(wid,1);
  const input={workspaceId:wid,version:4,role:'owner',scope:'workspace',state:Workspace.empty(),
    primary:{updatedAt:'2026-10-10',tableSchema,customFields:[],records:[
      {recordId:1,entityId:primaryId,values:{[primaryField]:account}},
      {recordId:2,entityId:Workspace.legacyId(wid,2),values:{[primaryField]:'Unrelated account'}}]}};
  const relationId='primary_people';
  const operations=[
    {op:'put_type',type:{id:typeId,name:'Contact',fields:[field(nameField,'Full name',true),field('email','Email'),field('phone','Phone'),field('title','Title'),field('notes','Notes')]}},
    {op:'put_type',type:{id:'companies',name:'Company',fields:[field('name','Company name',true)]}},
    {op:'put_relationship_type',type:{id:relationId,name:'Primary contacts',fromType:reverse?'primary':typeId,toType:reverse?typeId:'primary',cardinality:'many_to_many'}},
    {op:'upsert_entity',alias:'person',typeId,matchField:nameField,matchValue:person,mode:'reuse',values:[{field:'email',value:'fixture@example.invalid'}]},
    {op:'upsert_entity',alias:'other',typeId,matchField:nameField,matchValue:'Unlinked person',mode:'reuse',values:[]},
    {op:'link',typeId:relationId,from:reference(reverse?'primary':'alias',reverse?primaryId:'person'),to:reference(reverse?'alias':'primary',reverse?'person':primaryId)}
  ];
  input.state=Compiler.prepare(input,plan(operations),'batch-fixture').next;
  input.version++;
  const personId=input.state.entities[0].id;
  const queries=[read('person_links',null,reference('entity',personId)),read('account_contacts',typeId,reference('primary',primaryId),relationId)];
  return {input,queries,personId,primaryId,typeId,nameField,primaryField,relationId,person,account};
}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function rejectsUnchanged(input,action,pattern){const before=structuredClone(input);assert.throws(()=>Compiler.query(input,action),pattern);assert.deepEqual(input,before);}

for(const variant of [{},
  {person:'Jordan Patel',account:'Harbor Studio',typeId:'client_contacts',nameField:'full_name',reverse:true},
  {person:'Samira Ali',account:'Cedar Supply',typeId:'people',nameField:'identity',legacy:true}
])test(`independent bidirectional reads use saved endpoints and schema (${variant.typeId||'contacts'})`,()=>{
  const f=fixture(variant),before=structuredClone(f.input),action=batch(f.queries),original=structuredClone(action);
  freeze(f.input);freeze(action);
  const result=Compiler.query(f.input,action),answer=Compiler.describe(f.input,result);
  assert.equal(result.kind,'business-read-batch');assert.equal(result.mutates,false);
  assert.deepEqual(result.results.map(item=>item.id),['person_links','account_contacts']);
  assert.deepEqual(result.results.map(item=>item.records.map(row=>row.id)),[[f.primaryId],[f.personId]]);
  assert.deepEqual(result.results.map(item=>item.count),[1,1]);
  for(const item of result.results){assert.deepEqual(item.relationships,f.input.state.relationships);assert.equal(item.relationshipCount,1);}
  assert(answer.includes(f.person));assert(answer.includes(f.account));assert.match(answer,/Email: fixture@example.invalid/);
  assert.match(answer,/Primary results are existing pipeline rows; they do not establish separate typed company or deal entities/);
  assert.doesNotMatch(answer,/Unlinked person|Unrelated account/);
  assert.deepEqual(f.input,before);assert.deepEqual(action,original);
  // The batch is composition of the same deterministic evaluator, not a second resolver.
  for(const [index,{id,...selector}] of f.queries.entries()){
    const {id:resultId,...computed}=result.results[index];
    assert.equal(resultId,id);assert.deepEqual(computed,Compiler.query(f.input,{action:'query_business',...selector}));
  }
});

test('distinct typed company, primary deal and reverse contact scopes remain separate',()=>{
  const f=fixture();
  f.input.state=Compiler.prepare(f.input,plan([
    {op:'put_relationship_type',type:{id:'company_contacts',name:'Company contacts',fromType:'companies',toType:f.typeId,cardinality:'many_to_many'}},
    {op:'upsert_entity',alias:'company',typeId:'companies',matchField:'name',matchValue:'Actual legal company',mode:'reuse',values:[]},
    {op:'link',typeId:'company_contacts',from:reference('alias','company'),to:reference('entity',f.personId)}
  ]),'separate-company').next;
  const company=f.input.state.entities.find(entity=>entity.typeId==='companies');
  const result=Compiler.query(f.input,batch([
    read('company','companies',reference('entity',f.personId)),
    read('deal','primary',reference('entity',f.personId)),
    read('company_people',f.typeId,reference('entity',company.id)),f.queries[1]
  ]));
  assert.deepEqual(result.results.map(item=>item.records.map(row=>row.id)),[[company.id],[f.primaryId],[f.personId],[f.personId]]);
  assert.deepEqual(result.results.map(item=>item.relationshipCount),[1,1,1,1]);
  const answer=Compiler.describe(f.input,result);
  assert.match(answer,/Actual legal company \(Company/);assert.match(answer,/Company name: Actual legal company/);
});

test('zero matches and independent text searches keep their result identities and order',()=>{
  const f=fixture(),action=batch([
    read('empty_company','companies',reference('entity',f.personId)),
    read('no_text_match',f.typeId,null,null,'not stored anywhere'),
    f.queries[1],read('find_by_email',f.typeId,null,null,'FIXTURE@EXAMPLE.INVALID')
  ]);
  const result=Compiler.query(f.input,action),answer=Compiler.describe(f.input,result);
  assert.deepEqual(result.results.map(item=>item.count),[0,0,1,1]);
  assert.deepEqual(result.results[0].records,[]);assert.deepEqual(result.results[0].relationships,[]);
  assert.deepEqual(result.results[2].records.map(row=>row.id),[f.personId]);
  assert(answer.indexOf('(empty_company)')<answer.indexOf('(account_contacts)'));
  assert.equal(answer.match(/0 matching entities/g).length,2);
  assert.match(answer,/Search text: "FIXTURE@EXAMPLE.INVALID"/);
});

test('evidence includes only matching anchor, relationship type and result endpoints',()=>{
  const f=fixture();
  f.input.state=Compiler.prepare(f.input,plan([
    {op:'put_relationship_type',type:{id:'secondary',name:'Secondary association',fromType:f.typeId,toType:'primary',cardinality:'many_to_many'}},
    {op:'link',typeId:'secondary',from:reference('entity',f.personId),to:reference('primary',f.primaryId)},
    {op:'link',typeId:f.relationId,from:reference('entity',f.personId),to:reference('primary',Workspace.legacyId(wid,2))}
  ]),'other-links').next;
  const result=Compiler.query(f.input,batch([f.queries[1]]));
  assert.deepEqual(result.results[0].relationships,[f.input.state.relationships[0]]);
  assert.equal(result.results[0].relationshipCount,1);
  assert.match(Compiler.describe(f.input,result),/1 stored relationships match this relationship search/);
});

test('one invalid or ambiguous member rejects the whole read batch without guessing',()=>{
  const f=fixture();
  for(const bad of [
    {...f.queries[1],typeId:'missing'},
    {...f.queries[1],relationshipTypeId:'missing'},
    {...f.queries[1],linkedTo:reference('primary','Absent account')},
    {...f.queries[1],linkedTo:reference('entity',f.person)},
    {...f.queries[1],linkedTo:reference('entity','person_links')},
    {...f.queries[1],linkedTo:reference('alias','person')},
    {...f.queries[1],query:{}},
    {...f.queries[1],linkedTo:null}
  ])rejectsUnchanged(f.input,batch([f.queries[0],bad]),/Read 2 \(account_contacts\):/);
  f.input.primary.records[1].values[f.primaryField]=f.account;
  const byName={...f.queries[1],linkedTo:reference('primary',f.account)};
  rejectsUnchanged(f.input,batch([f.queries[0],byName]),/Read 2.*More than one linked record/);
  assert.equal(Compiler.query(f.input,batch(f.queries)).results[1].count,1,'Stable ID resolves a duplicate display name');
});

test('schema and runtime bound the batch and reject mutations, free-form answers and dependencies',()=>{
  const f=fixture(),action=batch(f.queries),schema=Compiler.schemas().find(item=>item.properties.action.enum[0]===action.action);
  assert.equal(schema.properties.queries.minItems,1);assert.equal(schema.properties.queries.maxItems,20);
  function strict(node){
    if(node?.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual(node.required,Object.keys(node.properties));}
    if(node&&typeof node==='object')Object.values(node).forEach(strict);
  }
  strict(schema);
  for(const malformed of [
    batch([]),batch(Array.from({length:21},(_,i)=>({...f.queries[0],id:`read_${i}`}))),
    batch([f.queries[0],f.queries[0]]),batch([{...f.queries[0],id:'root'}]),
    batch([{...f.queries[0],id:'not an id'}]),batch([{...f.queries[0],query:undefined,typeId:undefined}]),
    batch([{id:'read',typeId:f.typeId}]),
    {...action,operations:[]},{...action,assistantMessage:'Fabricated company'},
    batch([{...f.queries[0],answer:'Made up'}]),batch([{...f.queries[0],selection:'prior_read'}]),
    batch([{...f.queries[0],op:'delete_entity'}]),batch([{...f.queries[0],linkedTo:{...f.queries[0].linkedTo,fromResult:'earlier'}}])
  ])rejectsUnchanged(f.input,malformed,/entity read|entity type|typed query|relationship search/i);
  const max=Compiler.query(f.input,batch(Array.from({length:20},(_,i)=>({...f.queries[0],id:`read_${i}`}))));
  assert.equal(max.results.length,20);
  rejectsUnchanged(f.input,{action:'query_business',typeId:f.typeId,query:null,operations:[]},/only typed query/);
});

test('viewer reads stay inside a projected authorized snapshot and return detached evidence',()=>{
  const f=fixture();
  f.input.role='viewer';f.input.scope='shared';
  f.input.primary.records=f.input.primary.records.slice(0,1);
  f.input.state.entities=f.input.state.entities.slice(0,1);
  const before=structuredClone(f.input),result=Compiler.query(f.input,batch(f.queries));
  assert.deepEqual(result.results.map(item=>item.count),[1,1]);assert.deepEqual(f.input,before);
  result.results[1].records[0].values.email='changed outside snapshot';
  result.results[0].relationships[0].typeId='changed outside snapshot';
  assert.deepEqual(f.input,before);
  f.input.state.relationships=[];
  assert.deepEqual(Compiler.query(f.input,batch(f.queries)).results.map(item=>item.count),[0,0]);
});

test('canonical headings use current primary role and ID, not field order or requested name spelling',()=>{
  const f=fixture();
  const fields=f.input.primary.tableSchema.fields;
  fields.unshift(fields.splice(fields.findIndex(field=>field.id==='f_owner'),1)[0]);
  f.input.primary.records[0].values.f_owner='Not the account name';
  f.input.primary.records[0].values[f.primaryField]='Current account';
  const selector={...f.queries[1],linkedTo:reference('primary','  CURRENT   ACCOUNT ')};
  const result=Compiler.query(f.input,batch([selector])),answer=Compiler.describe(f.input,result);
  assert.equal(result.results[0].scope.linkedTo.key,f.primaryId);
  assert.match(answer,/Linked to: Current account/);assert.doesNotMatch(answer,/Not the account name|CURRENT   ACCOUNT/);
  f.input.state.entities[0].values.email='current@example.invalid';
  const refreshed=Compiler.describe(f.input,Compiler.query(f.input,batch([selector])));
  assert.match(refreshed,/Email: current@example.invalid/);assert.doesNotMatch(refreshed,/Email: fixture@example.invalid/);
});

test('bounded results retain full counts and rendering never drops a later independent section',()=>{
  const f=fixture(),template=f.input.state.entities[0];
  f.input.state.entities=Array.from({length:205},(_,i)=>({...structuredClone(template),id:`ent_${String(i+1).padStart(8,'0')}-2222-4222-a222-222222222222`,values:{[f.nameField]:`Contact ${i+1}`,notes:'Long saved note. '.repeat(500)}}));
  f.input.state.relationships=[];
  Workspace.validate(f.input.state,{workspaceId:wid,legacyRecordIds:[1,2]});
  const result=Compiler.query(f.input,batch(Array.from({length:20},(_,i)=>read(`read_${i}`,f.typeId))));
  for(const item of result.results){assert.equal(item.count,205);assert.equal(item.records.length,200);assert.equal(item.omittedCount,5);}
  const answer=Compiler.describe(f.input,result);
  assert(answer.length<=30000);assert.equal(answer.match(/205 matching entities/g).length,20);
  for(let i=0;i<20;i++)assert(answer.includes(`Read ${i+1} (read_${i})`));
  assert.match(answer,/Answer details truncated/);assert.match(answer,/No changes were made\.$/);
});

test('planner guidance describes typed composition without acceptance-prompt hardcoding',()=>{
  assert.match(Compiler.instructions,/query_business_batch with 1 to 20 queries/);
  assert.match(Compiler.instructions,/Review each requested read against its own computed results entry and scope/);
  assert.doesNotMatch(Compiler.instructions,/Maya Chen|Northstar Design|Jordan Patel|Harbor Studio/);
});
