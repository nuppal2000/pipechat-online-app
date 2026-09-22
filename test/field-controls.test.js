const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const Core=require('../public/pipeline-core.js'),Schema=require('../public/table-schema.js');
const {snapshotResult}=require('../lib/xano-backend.js');
const schema={status:'ready',useCase:'Recruiting',description:'',title:'Recruiting',recordLabel:'candidate',fields:[
  {id:'f_name',name:'Candidate',type:'text',role:'primary',options:[]},
  {id:'f_contact',name:'Contact',type:'text',role:'none',options:[]},
  {id:'f_owner',name:'Recruiter',type:'text',role:'owner',options:[]},
  {id:'f_amount',name:'Compensation',type:'currency',role:'none',options:[]},
  {id:'f_date',name:'Interview date',type:'date',role:'none',options:[]}
]};
const row={id:1,f_name:'Taylor',f_contact:'Morgan',f_owner:'Ravi',f_amount:50000,f_date:'2026-11-30',history:[],activity:'',health:''};
const legacy={id:1,account:'Acme',owner:'Ravi',stage:'Warm',value:50,close:'2026-11-30',next:'Call',follow:'Today',notes:'Keep',history:[],activity:'',health:''};
const core=Core.create(schema),plain=value=>JSON.parse(JSON.stringify(value));

test('typed sorting toggles natural value order, is stable, leaves blanks last and never mutates rows',()=>{
  const rows=[{id:1,f_name:'zebra',f_amount:10,f_date:'2027-01-01'},{id:2,f_name:'Alpha',f_amount:2,f_date:'2026-12-31'},{id:3,f_name:'alpha',f_amount:0,f_date:'2026-01-01'},{id:4,f_name:'',f_amount:null,f_date:''}],before=structuredClone(rows);
  const ids=(field,direction)=>core.sortRecords(rows,{field,direction}).map(r=>r.id);
  assert.deepEqual(ids('f_name','asc'),[2,3,1,4]);assert.deepEqual(ids('f_name','desc'),[1,2,3,4]);
  assert.deepEqual(ids('f_amount','asc'),[3,2,1,4]);assert.deepEqual(ids('f_amount','desc'),[1,2,3,4]);
  assert.deepEqual(ids('f_date','asc'),[3,2,1,4]);assert.deepEqual(ids('f_date','desc'),[1,2,3,4]);
  assert.deepEqual(rows,before);assert.deepEqual(core.sortRecords(rows,{field:'gone',direction:'asc'}),rows);
  assert.deepEqual(Core.sortRecords([{id:1,close:'Jan 1, 2027'},{id:2,close:'Dec 31, 2026'}],{field:'close',direction:'asc'}).map(r=>r.id),[2,1]);
});

test('primary deletion requires a different text field or a valid new text field',()=>{
  for(const replacement of [null,{field:'f_name'},{field:'f_amount'},{field:'missing'},{field:'f_contact',name:'New'}])assert.throws(()=>core.deleteColumn([row],'f_name',[],replacement));
  assert.throws(()=>core.deleteColumn([row],'f_name',[],{name:'Recruiter',id:'f_new'}));
  assert.throws(()=>core.deleteColumn([row],'f_name',[],{name:'New',id:'f_contact'}));
  assert.throws(()=>core.deleteColumn([row],'f_amount',[],{field:'f_contact'}));
});

test('existing primary replacement preserves selected values and changes the semantic role',()=>{
  const change=core.deleteColumn([row],'f_name',[],{field:'Recruiter'}),next=Core.create(change.tableSchema);
  assert.equal(row.f_name,'Taylor');assert.equal(change.records[0].f_name,undefined);assert.equal(change.records[0].f_owner,'Ravi');
  assert.equal(next.role('primary'),'f_owner');assert.equal(next.role('owner'),undefined);assert.equal(change.tableSchema.recordLabel,'Recruiter');
  assert.equal(next.report(change.records,{metric:'sum',field:'f_amount',groupBy:'f_owner',chart:'bar',accounts:['Ravi']}).data[0].value,50000);
  assert.equal(next.plan(change.records,{action:'update_record',recordMatch:'Ravi',field:'f_contact',value:'Sam'}).patches[0].id,1);
});

test('a new primary starts blank and the last remaining field cannot be deleted without replacement',()=>{
  const only=Core.create({...schema,fields:[schema.fields[0]]});
  assert.throws(()=>only.deleteColumn([{id:1,f_name:'Old'}],'f_name'));
  const change=only.deleteColumn([{id:1,f_name:'Old'}],'f_name',[],{name:'New identity',id:'f_new'});
  assert.equal(change.records[0].f_new,'');assert.equal(change.tableSchema.fields.length,1);assert.equal(change.tableSchema.recordLabel,'New identity');
});

test('a custom field can become primary without duplicating or losing its values',()=>{
  const custom={id:'cf_contact',name:'Hiring contact',type:'text'};
  const change=core.deleteColumn([{...row,cf_contact:'Sam'}],'f_name',[custom],{field:'cf_contact'});
  assert.deepEqual(change.customFields,[]);assert.equal(change.tableSchema.fields[0].id,'cf_contact');assert.equal(change.records[0].cf_contact,'Sam');
  const projected=snapshotResult({deals:change.records,customFields:[],tableSchema:change.tableSchema,updatedAt:'v2'});
  assert.equal(projected.deals[0].cf_contact,'Sam');
  assert.throws(()=>Core.create(change.tableSchema).validateCustomFields([custom]));
});

test('a new primary does not consume a custom-column slot at the twenty-column limit',()=>{
  const fields=Array.from({length:20},(_,i)=>({id:i===0?'cf_primary_candidate':'cf_extra_'+i,name:'Extra '+i,type:'text'}));
  const input={...row,...Object.fromEntries(fields.map(f=>[f.id,'Keep '+f.name]))};
  const changed=core.deleteColumn([input],'f_name',fields,{name:'Client',id:'f_client'});
  assert.equal(changed.customFields.length,20);assert.equal(changed.records[0].f_client,'');
  for(const f of fields)assert.equal(changed.records[0][f.id],input[f.id]);
  assert.throws(()=>core.deleteColumn([input],'f_name',fields,{name:'Extra 1',id:'f_client'}));
});

test('legacy field deletion is explicit and preserves the remaining columns and follow-up semantics',()=>{
  for(const id of ['stage','value','close','owner','next','follow','notes']){
    const change=Core.deleteColumn([legacy],id),next=Core.create(change.tableSchema);
    assert(change.tableSchema.legacy);assert.equal(change.records[0][id],undefined);
    for(const key of Object.keys(legacy).filter(k=>k!==id))assert.deepEqual(change.records[0][key],legacy[key]);
    assert.equal(next.role('primary'),'account');
    if(id!=='follow')assert(next.predicate({field:'follow',operator:'equals',value:'today'})(change.records[0]));
    assert.deepEqual(Schema.transition(change.tableSchema,Schema.legacySchema(),[legacy]),Schema.legacySchema());
  }
  const changed=Core.deleteColumn([legacy],'account',[],{field:'owner'});
  assert.equal(changed.tableSchema.recordLabel,'Owner');assert.equal(changed.records[0].owner,'Ravi');
  assert.equal(Core.definitions().find(f=>f.id==='stage').type,'choice');
  assert.throws(()=>Core.deleteColumn([legacy],'account',[],{field:'stage'}));
  assert.throws(()=>Schema.transition(null,schema,[]));assert.throws(()=>Schema.transition(null,{...Schema.legacySchema(),fields:Schema.legacySchema().fields.slice(0,2)},[]));
});

test('Xano helper round-trips legacy conversion and promoted custom primary with no schema loss',()=>{
  const run=new Function('$input',require('../scripts/build-xano-custom-fields.js').code);
  const custom={id:'cf_hiring',name:'Hiring contact',type:'text'};
  for(const change of [Core.deleteColumn([legacy],'account',[],{name:'Candidate',id:'f_candidate'}),core.deleteColumn([{...row,cf_hiring:'Sam'}],'f_name',[custom],{field:'cf_hiring'})]){
    const saved=run({mode:'write',payload:{deals:change.records,customFields:change.customFields,tableSchema:change.tableSchema}});assert(saved.ok);
    const read=run({mode:'read',payload:{customData:saved.data,deals:[{id:1,history:[],activity:'',health:''}],updatedAt:'v1'}});assert(read.ok);
    assert.deepEqual(read.data.tableSchema,change.tableSchema);assert.deepEqual(read.data.deals,change.records);
  }
});

function harness(table=schema,records=[row]){
  const nodes=new Map(),calls=[],messages=[];
  function node(id){if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},style:{},innerHTML:'',textContent:'',hidden:false,open:false,elements:{replacementMode:{value:'existing'}},classList:{add(){},remove(){},toggle(){}},setAttribute(){},focus(){},querySelectorAll:()=>[],showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(id);}
  let fail=false,snapshot={deals:structuredClone(records),customFields:[],tableSchema:table,updatedAt:'v1'},action=null;
  const context={crypto,AbortSignal,innerWidth:1400,window:{PipelineCore:Core,PipeChatSchema:Schema,PipeChatIcons:{},messages},document:{getElementById:node,querySelector:node,querySelectorAll:()=>[]},sessionStorage:{removeItem(){},getItem(){return null;}},fetch:async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(url==='/api/pipechat-ai')return {ok:true,json:async()=>({crmAction:action,usage:{used:1,remaining:9}})};
    if(fail)return {ok:false,status:503,json:async()=>({error:'Synthetic outage'})};
    if(options.method==='PUT')snapshot={deals:body.deals,customFields:body.customFields,tableSchema:body.tableSchema,updatedAt:'v'+calls.length};
    return {ok:true,json:async()=>structuredClone(snapshot)};
  }};
  const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`const realRender=render;render=()=>{};toast=()=>{};focusTrust=()=>{};updateUsage=()=>{};say=message=>window.messages.push(message);window.test={S,useSchema,send,prepare,confirmDraft,cancelDraft,undo,openFieldDialog,closeFieldDialog,submitFieldDialog,renderTable,renderTrust,realRender,visible};`),context);
  const h=context.window.test;h.useSchema(table);
  Object.assign(h.S,{user:{id:1,name:'QA',email:'qa@example.invalid'},loaded:true,records:structuredClone(records),updatedAt:'v1',usage:{remaining:10},health:{aiConfigured:true}});
  return {...h,node,calls,messages,setAction:value=>action=value,fail:value=>fail=value,submit:()=>h.submitFieldDialog({preventDefault(){}})};
}

test('manual Add field produces the same preview as chat and works at the usage cap',async()=>{
  const h=harness();h.S.usage={remaining:0,paymentRequired:true};h.openFieldDialog('add');
  assert(h.node('fieldDialog').open);assert.equal(h.S.pending,null);
  h.node('newFieldName').value='Source';h.submit();assert.equal(h.S.pending.kind,'add-field');assert.equal(h.calls.length,0);
  assert.match(h.node('trustBody').innerHTML,/Confirm new field/);await h.confirmDraft();
  assert.equal(h.S.customFields[0].name,'Source');assert.equal(h.S.records[0][h.S.customFields[0].id],'');assert.equal(h.calls.filter(c=>c.url==='/api/pipechat-ai').length,0);
  await h.undo();assert.equal(h.S.customFields.length,0);
});

test('trash No changes nothing; Yes only creates a proposal; cancellation and stale previews do not save',async()=>{
  const h=harness();h.openFieldDialog('delete','f_amount');assert.match(h.node('fieldDialogBody').innerHTML,/Are you sure you want to delete this entire field\?/);
  h.closeFieldDialog();assert.equal(h.S.pending,null);assert.equal(h.calls.length,0);
  h.openFieldDialog('delete','f_amount');h.submit();assert.equal(h.S.pending.kind,'delete-field');assert.equal(h.calls.length,0);assert.equal(h.S.records[0].f_amount,50000);
  h.cancelDraft();assert.equal(h.S.records[0].f_amount,50000);
  h.openFieldDialog('delete','f_amount');h.submit();h.S.revision++;await h.confirmDraft();assert.equal(h.calls.length,0);assert.match(h.messages.at(-1),/table changed/);
});

test('primary replacement changes Add label and primary dashboard grouping only after confirmation; undo restores both',async()=>{
  const h=harness();h.S.report={metric:'sum',field:'f_amount',groupBy:'f_name',chart:'bar',accounts:['Taylor']};
  h.openFieldDialog('delete','f_name');h.submit();assert.equal(h.S.pending,null);assert.match(h.node('fieldDialogError').textContent,/replacement/);
  h.node('replacementField').value='f_contact';h.submit();assert.equal(h.S.tableSchema.recordLabel,'candidate');assert.match(h.node('trustBody').innerHTML,/Confirm replacement/);assert.equal(h.calls.length,0);
  await h.confirmDraft();assert.equal(h.S.tableSchema.recordLabel,'Contact');assert.equal(h.S.records[0].f_contact,'Morgan');assert.equal(h.S.records[0].f_name,undefined);
  assert.equal(h.S.report.groupBy,'f_contact');assert.equal(h.S.report.accounts,null);h.realRender();assert.match(h.node('addAccountBtn').innerHTML,/Add Contact/);
  await h.undo();assert.equal(h.S.records[0].f_name,'Taylor');assert.equal(h.S.report.groupBy,'f_name');assert.equal(h.S.tableSchema.recordLabel,'candidate');
});

test('chat primary deletion asks for replacement, new primary is blank, and failed saves keep the preview',async()=>{
  const h=harness();h.setAction({action:'delete_field',field:'f_name'});await h.send('Delete field Candidate');
  assert(h.node('fieldDialog').open);assert.equal(h.S.pending,null);
  h.node('fieldDialogForm').elements.replacementMode.value='new';h.node('replacementName').value='Client';h.submit();
  h.fail(true);await h.confirmDraft();assert.equal(h.S.records[0].f_name,'Taylor');assert.equal(h.S.pending.kind,'delete-field');
  h.fail(false);await h.confirmDraft();const id=h.S.tableSchema.fields.find(f=>f.role==='primary').id;assert.equal(h.S.records[0][id],'');assert.equal(h.S.tableSchema.recordLabel,'Client');
});

test('all field headers include accessible sort state and deletion, including primary; labels are escaped',()=>{
  const h=harness();h.S.sort={field:'f_name',direction:'asc'};h.renderTable(h.S.records);
  assert.match(h.node('dealHeaders').innerHTML,/data-delete-field="f_name"/);assert.match(h.node('dealHeaders').innerHTML,/aria-sort="ascending"/);
  h.useSchema({...schema,fields:schema.fields.map(f=>f.id==='f_name'?{...f,name:'<img src=x>'}:f)});h.renderTable(h.S.records);
  assert(!h.node('dealHeaders').innerHTML.includes('<img'));assert(h.node('dealHeaders').innerHTML.includes('&lt;img'));
  h.S.sort={field:'f_amount',direction:'desc'};assert.equal(h.visible()[0].id,1);assert.equal(h.calls.length,0);
});

test('legacy primary replacement and undo retain original records and compatible schema',async()=>{
  const h=harness(null,[legacy]);h.prepare({action:'delete_field',field:'account',replacementName:'Candidate'},'replace');await h.confirmDraft();
  assert(h.S.tableSchema.legacy);assert.equal(h.S.records[0].account,undefined);await h.undo();
  assert.deepEqual(plain(h.S.records),[legacy]);assert.equal(Core.create(h.S.tableSchema).role('primary'),'account');
});
