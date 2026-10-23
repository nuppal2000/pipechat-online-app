'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Compiler=require('../lib/business-compiler'),Workspace=require('../public/business-workspace');
const Review=require('../lib/action-review'),Schema=require('../public/table-schema');
const wid='11111111-1111-4111-a111-111111111111';
const plan=operations=>({action:'business_plan',version:1,title:'Fixture',operations});
const field=(id,name,type='text',required=false,options=[])=>({id,name,type,required,options});
const read=(typeId,selector,extra={})=>({action:'query_business',typeId,selector,linkedTo:null,relationshipTypeId:null,...extra});
const byField=(field,value)=>({kind:'field_equals',field,value});
function fixture(){
  const input={workspaceId:wid,version:0,role:'owner',scope:'workspace',state:Workspace.empty(),
    primary:{updatedAt:null,tableSchema:Schema.legacySchema(),customFields:[],records:[{recordId:1,entityId:Workspace.legacyId(wid,1),values:{account:'Primary account',contact:'QAE Morgan Lane'}}]}};
  input.state=Compiler.prepare(input,plan([
    {op:'put_type',type:{id:'et_saved',name:'Contact',fields:[field('f_identity','Name','text',true),field('f_mail','Email'),field('f_notes','Notes'),
      field('f_score','Score','number'),field('f_active','Active','boolean'),field('f_date','Date','date'),field('f_status','Status','choice',false,['Open','Closed'])]}},
    {op:'upsert_entity',alias:'person',typeId:'et_saved',matchField:'f_identity',matchValue:'QAE Morgan Original',mode:'reuse',values:[{field:'f_mail',value:'morgan@example.com'}]},
    {op:'upsert_entity',alias:'decoy',typeId:'et_saved',matchField:'f_identity',matchValue:'QAE Morgan Lane Extra',mode:'reuse',values:[{field:'f_mail',value:'other@example.com'},{field:'f_notes',value:'morgan@example.com'}]},
    {op:'put_relationship_type',type:{id:'primary_contact',name:'Primary contact',fromType:'primary',toType:'et_saved',cardinality:'many_to_many'}},
    {op:'link',typeId:'primary_contact',from:{source:'primary',key:Workspace.legacyId(wid,1)},to:{source:'alias',key:'person'}}
  ]),'seed').next;
  const person=input.state.entities[0];
  input.state=Compiler.prepare(input,plan([{op:'update_entity',id:person.id,values:[{field:'f_identity',value:'QAE Morgan Lane'}]}]),'rename').next;
  input.version=2;
  return JSON.parse(JSON.stringify(input));
}
function unchanged(input,action,run){
  const before=structuredClone(input),original=structuredClone(action);
  run();assert.deepEqual(input,before);assert.deepEqual(action,original);
}

test('saved, renamed and reloaded Contact reads by stable ID, exact name and email, with list-all control',()=>{
  const input=fixture(),id=input.state.entities[0].id;
  for(const selector of [{kind:'ids',ids:[id]},byField('f_identity','  qae   MORGAN lane '),byField('f_mail','MORGAN@EXAMPLE.COM')]){
    const action=read('et_saved',selector);
    unchanged(input,action,()=>{
      const result=Compiler.query(input,action);
      assert.equal(result.count,1);assert.equal(result.records[0].id,id);
      assert.equal(result.records[0].values.f_mail,'morgan@example.com');
      assert.match(Compiler.describe(input,result),/QAE Morgan Lane \(Contact; ent_/);
      assert.match(Compiler.describe(input,result),/Email: morgan@example.com/);
    });
  }
  assert.equal(Compiler.query(input,read('et_saved',{kind:'all'})).count,2);
  assert.equal(Compiler.query(input,read('et_saved',byField('f_identity','QAE Morgan Original'))).count,0);
});

test('field equality cannot match a notes mention, a substring, a primary cell or another type',()=>{
  const input=fixture();
  input.state=Compiler.prepare(input,plan([
    {op:'put_type',type:{id:'other',name:'Other',fields:[field('f_identity','Name','text',true),field('f_mail','Email')]}},
    {op:'upsert_entity',alias:'other',typeId:'other',matchField:'f_identity',matchValue:'QAE Morgan Lane',mode:'reuse',values:[{field:'f_mail',value:'morgan@example.com'}]}
  ]),'other').next;
  assert.equal(Compiler.query(input,read('et_saved',byField('f_identity','QAE Morgan'))).count,0);
  assert.equal(Compiler.query(input,read('et_saved',byField('f_mail','morgan@example.com'))).count,1);
  assert.equal(Compiler.query(input,read('et_saved',{kind:'text_search',text:'morgan@example.com'})).count,2);
  assert.equal(Compiler.query(input,read('et_saved',byField('f_mail','morgan@example.com.'))).count,0,'Punctuation is literal, not stripped from stored identity values');
});

test('duplicate exact identities return all matching IDs, never the first candidate',()=>{
  const input=fixture();input.state.entities[1].values.f_identity='QAE Morgan Lane';
  const result=Compiler.query(input,read('et_saved',byField('f_identity','QAE Morgan Lane')));
  assert.deepEqual(result.records.map(row=>row.id),input.state.entities.map(row=>row.id));
  for(const row of result.records)assert(Compiler.describe(input,result).includes(row.id));
  assert.equal(Compiler.query(input,read('et_saved',{kind:'ids',ids:[result.records[1].id]})).count,1);
});

test('equality retains typed false/zero, validates dates/options, and rejects labels or blank values',()=>{
  const input=fixture();Object.assign(input.state.entities[0].values,{f_score:0,f_active:false,f_date:'2026-10-23',f_status:'Open'});
  for(const [field,value] of [['f_score',0],['f_active',false],['f_date','2026-10-23'],['f_status','Open']]){
    assert.equal(Compiler.query(input,read('et_saved',byField(field,value))).count,1);
  }
  for(const [field,value] of [['f_score','0'],['f_active','false'],['f_date','2026-02-30'],['f_status','open'],['f_mail',''],['f_mail',null],['Email','morgan@example.com'],['missing','x']]){
    const action=read('et_saved',byField(field,value));unchanged(input,action,()=>assert.throws(()=>Compiler.query(input,action),/field/));
  }
  assert.throws(()=>Compiler.query(input,read(null,byField('f_mail','morgan@example.com'))),/typeId/);
});

test('selectors and canonical output follow schema IDs through label renames',()=>{
  const input=fixture();input.state.entityTypes[0].name='Client Contact';input.state.entityTypes[0].fields[1].name='Work email';
  const result=Compiler.query(input,read('et_saved',byField('f_mail','morgan@example.com'))),answer=Compiler.describe(input,result);
  assert.match(answer,/Client Contact/);assert.match(answer,/Work email: morgan@example.com/);
  assert.match(answer,/Field match: Work email \(f_mail\)/);
});

test('typed selectors compose with both relationship directions and remain in authorized scope',()=>{
  const input=fixture(),id=input.state.entities[0].id,primaryId=input.primary.records[0].entityId;
  const forward=read('et_saved',byField('f_mail','morgan@example.com'),{linkedTo:{source:'primary',key:primaryId},relationshipTypeId:'primary_contact'});
  const backward=read('primary',{kind:'ids',ids:[primaryId]},{linkedTo:{source:'entity',key:id}});
  assert.equal(Compiler.query(input,forward).records[0].id,id);
  assert.equal(Compiler.query(input,backward).records[0].id,primaryId);
  input.state.relationships=[];assert.equal(Compiler.query(input,forward).count,0);
  input.role='viewer';input.scope='shared';input.state.entities=input.state.entities.slice(1);
  assert.equal(Compiler.query(input,read('et_saved',byField('f_mail','morgan@example.com'))).count,0);
  assert.throws(()=>Compiler.query(input,read('et_saved',{kind:'ids',ids:[id]})),/authorized/);
});

test('unique named relationship anchors resolve stable IDs and distinguish zero links from absent or ambiguous Contacts',()=>{
  const input=fixture(),id=input.state.entities[0].id,primaryId=input.primary.records[0].entityId;
  input.state.relationshipTypes[0].name='QAE Works at';input.primary.records[0].values.account='QA Acorn Supplies';
  const anchor={source:'entity',typeId:'et_saved',selector:byField('f_identity','QAE Morgan Lane')};
  const action=read('primary',{kind:'all'},{linkedTo:anchor,relationshipTypeId:'primary_contact'});
  const result=Compiler.query(input,action);
  assert.equal(result.records[0].id,primaryId);assert.deepEqual(result.scope.linkedTo,{source:'entity',key:id});
  assert.match(Compiler.describe(input,result),/QA Acorn Supplies/);assert.match(Compiler.describe(input,result),/Linked to: QAE Morgan Lane/);
  assert.match(Compiler.describe(input,result),/do not establish separate typed company or deal entities/);
  const reverse=read('et_saved',{kind:'all'},{linkedTo:{source:'primary',typeId:'primary',selector:byField('account','QA Acorn Supplies')}});
  assert.equal(Compiler.query(input,reverse).records[0].id,id);
  const {action:unused,...member}=action,batch={action:'query_business_batch',queries:[{id:'works_at',...member}]};
  assert.equal(Compiler.query(input,batch).results[0].count,1);
  input.state.relationships=[];
  const empty=Compiler.query(input,action);assert.equal(empty.count,0);assert.equal(empty.relationshipCount,0);
  assert.match(Compiler.describe(input,empty),/Linked to: QAE Morgan Lane/);assert.match(Compiler.describe(input,empty),/0 stored relationships match this relationship search/);
  const missing=read('primary',{kind:'all'},{linkedTo:{...anchor,selector:byField('f_identity','Missing Contact')}});
  assert.throws(()=>Compiler.query(input,missing),/not a zero-link result/);
  input.state.entities[1].values.f_identity='QAE Morgan Lane';
  assert.throws(()=>Compiler.query(input,action),/More than one linked record/);
  assert.equal(Compiler.query(input,read('primary',{kind:'all'},{linkedTo:{...anchor,selector:{kind:'ids',ids:[id]}}})).count,0);
  for(const bad of [{...anchor,selector:{kind:'all'}},{...anchor,typeId:'primary'},{...anchor,selector:{kind:'ids',ids:[id,input.state.entities[1].id]}}]){
    assert.throws(()=>Compiler.query(input,read('primary',{kind:'all'},{linkedTo:bad})),/anchor/);
  }
});

test('single and batch selectors expose canonical evidence accepted by the existing read contracts',()=>{
  const input=fixture(),payload={pipeline:{business:input,tableSchema:input.primary.tableSchema}};
  for(const selector of [{kind:'all'},byField('f_identity','QAE Morgan Lane'),byField('f_mail','morgan@example.com')]){
    const single=read('et_saved',selector),{action,...member}=single;
    const batch={action:'query_business_batch',queries:[{id:'contact_read',...member}]};
    for(const crmAction of [single,batch]){
      const result={crmAction,assistantMessage:'Not evidence'},computed=Review.evidence(payload,result),stepIds=[crmAction===single?'root':'contact_read'];
      assert.equal(computed.lifecycle.operation,'read');assert.equal(computed.lifecycle.writesApplied,0);
      assert.equal(Review.validateReview({issues:[],clarificationQuestion:null,requirements:[{description:'Contact saved fields',evidenceKind:'computed_read',stepIds,requiredOutputs:['count','names','fields'],satisfied:true}]},result,{pipeline:payload.pipeline}).ok,true);
      assert.match(Review.renderAnswer(payload,result,computed),/Email: morgan@example.com/);
    }
    const {id,...batchResult}=Compiler.query(input,batch).results[0];assert.equal(id,'contact_read');assert.deepEqual(batchResult,Compiler.query(input,single));
  }
});

test('strict selector validation rejects mixed legacy queries, unknown keys and unavailable IDs atomically',()=>{
  const input=fixture(),id=input.state.entities[0].id;
  const bad=[null,{},[],{kind:'all',query:'ignored'},{kind:'ids',ids:[]},{kind:'ids',ids:[id,id]},
    {kind:'ids',ids:['QAE Morgan Lane']},{kind:'ids',ids:[input.primary.records[0].entityId]},
    {kind:'ids',ids:Array(201).fill(id)},{kind:'field_equals',field:'f_mail',value:'morgan@example.com',typeId:'et_saved'},
    {kind:'text_search',text:' '},{kind:'text_search',text:'x'.repeat(12001)},{kind:'field_equals',field:'f_mail',value:{op:'delete_entity'}}];
  for(const selector of bad){
    const action=read('et_saved',selector);unchanged(input,action,()=>assert.throws(()=>Compiler.query(input,action)));
  }
  for(const extra of [{query:null},{operations:[]},{selector:undefined}])assert.throws(()=>Compiler.query(input,read('et_saved',{kind:'all'},extra)));
  const {action,...valid}=read('et_saved',{kind:'all'}),batch={action:'query_business_batch',queries:[{id:'first',...valid},{id:'bad',...valid,selector:{kind:'ids',ids:['missing']}}]};
  unchanged(input,batch,()=>assert.throws(()=>Compiler.query(input,batch),/Read 2 \(bad\)/));
});

test('model schema advertises only explicit selectors while saved literal queries retain compatibility',()=>{
  const input=fixture(),schemas=Compiler.schemas();
  const single=schemas.find(schema=>schema.properties.action.enum[0]==='query_business');
  const batch=schemas.find(schema=>schema.properties.action.enum[0]==='query_business_batch');
  assert(!Object.hasOwn(single.properties,'query'));assert.deepEqual(batch.properties.queries.items.properties.selector,single.properties.selector);
  assert.deepEqual(single.properties.selector.anyOf.map(schema=>schema.properties.kind.enum[0]),['all','ids','field_equals','text_search','field_removal_check']);
  function strict(node){if(node?.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual(node.required,Object.keys(node.properties));}if(node&&typeof node==='object')Object.values(node).forEach(strict);}
  strict(single);strict(batch);
  assert.equal(Compiler.query(input,{action:'query_business',typeId:'et_saved',query:'morgan@example.com'}).count,2);
  assert.match(Compiler.instructions,/requested output .* is not part of the name selector/);
  assert.doesNotMatch(Compiler.instructions,/QAE|Morgan Lane|morgan@example/);
});

test('single reads bound returned records like batches while retaining full count and omitted totals',()=>{
  const input=fixture();
  input.state.entities=Array.from({length:5000},(_,i)=>({id:'ent_'+i,typeId:'et_saved',values:{f_identity:'Contact '+i}}));
  input.state.relationships=[];
  const single=read(null,{kind:'all'}),{action,...member}=single;
  for(const request of [single,{action:'query_business',typeId:null,query:null}]){
    const result=Compiler.query(input,request);
    assert.equal(result.records.length,200);assert.equal(result.count,5000);assert.equal(result.omittedCount,4800);
    assert(result.records.every(row=>row.typeId==='et_saved'),'An unscoped entity list does not include primary rows');
    assert.match(Compiler.describe(input,result),/5000 matching entities/);
  }
  const {id,...batched}=Compiler.query(input,{action:'query_business_batch',queries:[{id:'contacts',...member}]}).results[0];
  assert.equal(id,'contacts');assert.deepEqual(batched,Compiler.query(input,single));
});

test('post-merge email lookup composes current fields with the genuinely linked primary company, not an empty Company type',()=>{
  const input=fixture(),lane=input.state.entities[0].id,source=input.state.entities[1].id,primaryId=input.primary.records[0].entityId;
  input.primary.records[0].values.account='QA Acorn Supplies';
  const type=structuredClone(input.state.entityTypes[0]);type.fields.push(field('f_phone','Phone'));
  input.state=Compiler.prepare(input,plan([
    {op:'put_type',type},
    {op:'put_type',type:{id:'company',name:'Company',fields:[field('f_identity','Company name','text',true)]}},
    {op:'put_relationship_type',type:{id:'works_at',name:'QAE Works at',fromType:'et_saved',toType:'primary',cardinality:'many_to_many'}},
    {op:'update_entity',id:source,values:[{field:'f_identity',value:'QAE Morgan Duplicate'},{field:'f_phone',value:'555-0107'}]},
    {op:'merge_entities',survivorId:lane,sourceIds:[source],policy:'keep_survivor_fill_blanks',fieldResolutions:[]},
    {op:'link',typeId:'works_at',from:{source:'entity',key:lane},to:{source:'primary',key:primaryId}}
  ]),'compound').next;
  const lookup=byField('f_mail','morgan@example.com'),action={action:'query_business_batch',queries:[
    {id:'contact',typeId:'et_saved',selector:lookup,linkedTo:null,relationshipTypeId:null},
    {id:'company',typeId:'primary',selector:{kind:'all'},linkedTo:{source:'entity',typeId:'et_saved',selector:lookup},relationshipTypeId:'works_at'}
  ]};
  const payload={pipeline:{business:input}},response={crmAction:action},before=structuredClone(input),computed=Review.evidence(payload,response);
  const [contact,company]=computed.results;
  assert.equal(contact.count,1);assert.equal(contact.records[0].id,lane);assert.equal(contact.records[0].name,'QAE Morgan Lane');
  assert.equal(contact.records[0].values.f_phone,'555-0107');assert.equal(contact.records[0].values.f_mail,'morgan@example.com');
  assert.equal(company.count,1);assert.equal(company.records[0].id,primaryId);assert.equal(company.records[0].name,'QA Acorn Supplies');
  assert.deepEqual(company.relationshipContext.anchor,{id:lane,typeId:'et_saved',name:'QAE Morgan Lane'});
  assert.deepEqual(company.relationshipContext.selectedBy,action.queries[1].linkedTo);
  assert.equal(company.relationshipContext.resultTypes[0].source,'primary_records');
  assert(company.relationshipContext.resultTypes[0].fields.some(field=>field.id==='account'&&field.type==='text'));
  const requirements=[['Current Contact name','contact','names'],['Current Phone','contact','fields'],['Linked company','company','names']]
    .map(([description,id,output])=>({description,evidenceKind:'computed_read',stepIds:[id],requiredOutputs:[output],satisfied:true}));
  assert.equal(Review.validateReview({requirements,issues:[],clarificationQuestion:null},response,{pipeline:payload.pipeline}).ok,true);
  const answer=Review.renderAnswer(payload,response,computed);assert.match(answer,/Phone: 555-0107/);assert.match(answer,/QA Acorn Supplies/);
  assert.equal(computed.lifecycle.writesApplied,0);assert.deepEqual(input,before);
  input.state.relationships=input.state.relationships.filter(link=>link.typeId!=='works_at');
  const empty=Compiler.query(input,action);assert.equal(empty.results[0].count,1);assert.equal(empty.results[1].count,0);
  assert.equal(empty.results[1].relationshipContext.anchor.id,lane,'Zero links must not erase the resolved email anchor');
  input.state.entities.push({...structuredClone(input.state.entities[0]),id:source});
  assert.throws(()=>Compiler.query(input,action),/More than one linked record/,'An ambiguous email must not choose a company silently');
});
