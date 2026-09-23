const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const C=require('../public/pipeline-core.js');
const {snapshotResult}=require('../lib/backend-contract.js');
const field={id:'cf_contact',name:'Contact',type:'text'};
const row={id:1,account:'Acme QA',stage:'Warm',value:25,close:'',owner:'Ravi',next:'',follow:'',notes:'',history:[]};
const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
function harness(){
  const nodes=new Map(),calls=[],messages=[],storage=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',style:{},innerHTML:'',textContent:'',hidden:false,classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[]});return nodes.get(id);};
  let snapshot={deals:[structuredClone(row)],customFields:[],updatedAt:'v1'},failure=false;
  const context={crypto,AbortSignal,innerWidth:1400,
    window:{PipeChatInspector:require('../public/inspector-core.js'),PipeChatTodo:require('../public/todo-core.js'),PipelineCore:C,PipeChatIcons:{}},document:{getElementById:node,querySelectorAll:()=>[],querySelector:()=>null},
    sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    fetch:async(url,options)=>{
      const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
      if(failure)return {ok:false,status:503,json:async()=>({error:'Synthetic outage'})};
      if(url==='/api/pipechat-ai')return {ok:true,json:async()=>({crmAction:{action:'add_field',newFieldName:'Contact'},usage:{used:1,remaining:9}})};
      if(options.method==='PUT')snapshot={deals:body.deals,customFields:body.customFields,updatedAt:'v'+(calls.length+1)};
      return {ok:true,json:async()=>structuredClone(snapshot)};
    }};
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>{};toast=()=>{};focusTrust=()=>{};updateUsage=()=>{};say=(message)=>window.messages.push(message);window.test={S,send,prepare,confirmDraft,cancelDraft,manualEdit,undo,newRecord,renderTable,renderTrust,restoreFailedEdit,reviewFailedEdit,retryFailedEdit,aiPayload};`),Object.assign(context,{window:{PipeChatInspector:require('../public/inspector-core.js'),...context.window,messages}}));
  const h=context.window.test;
  Object.assign(h.S,{user:{id:1,email:'qa@example.invalid',name:'QA'},loaded:true,records:[structuredClone(row)],updatedAt:'v1',health:{aiConfigured:true,storageProvider:'supabase'},usage:{used:0,remaining:10}});
  return {...h,node,calls,messages,storage,fail:value=>failure=value,snapshot:()=>structuredClone(snapshot)};
}
test('custom definitions reject duplicates, aliases, reserved names, invalid types and oversized schemas',()=>{
  for(const name of ['Owner',' company ','Name','Status','__proto__','constructor','id','activity','   ','x'.repeat(61),'bad\nname'])assert.throws(()=>C.validateCustomFields([{...field,name}]));
  assert.throws(()=>C.validateCustomFields([field,{...field,id:'cf_other',name:' contact '}]));
  assert.throws(()=>C.validateCustomFields([{...field,type:'number'}]));
  assert.throws(()=>C.validateCustomFields([{...field,id:'owner'}]));
  assert.throws(()=>C.validateCustomFields(Array.from({length:21},(_,i)=>({...field,id:'cf_'+i,name:'Field '+i}))));
  assert.deepEqual(C.fieldsFor([]),C.fields);assert.equal(C.fields.contact,undefined);
});
test('custom edits and filters require current definitions; values never leak into another schema',()=>{
  const records=[{...row,cf_contact:''}],action={action:'update_record',ids:[1],field:'Contact',value:'Taylor'};
  const p=C.plan(records,action,[field]);assert.equal(records[0].cf_contact,'');
  const next=C.apply(records,p,'QA',new Date(),[field]);assert.equal(next[0].cf_contact,'Taylor');assert.match(next[0].history[0],/Contact changed/);
  assert(C.predicate({field:'Contact',operator:'equals',value:'Taylor'},[field])(next[0]));
  assert.throws(()=>C.plan(records,action));assert.throws(()=>C.customValues({cf_unknown:'x'},[field]));
  assert.throws(()=>C.customValues({cf_contact:{email:'x'}},[field]));assert.throws(()=>C.customValues({cf_contact:'x'.repeat(12001)},[field]));
  assert.deepEqual(C.customValues({},[field]),{cf_contact:''});
});
test('chat-created field is previewed only, cancel makes no save, yes confirms and undo restores schema',async()=>{
  const h=harness();await h.send('Add field called Contact');
  assert.equal(h.S.customFields.length,0);assert.equal(h.S.records[0].cf_contact,undefined);assert.equal(h.calls.length,1);
  assert.equal(h.S.pending.kind,'add-field');assert.match(h.node('trustBody').innerHTML,/Confirm new field/);
  await h.send('no');assert.equal(h.S.pending,null);assert.equal(h.calls.length,1);
  await h.send('Add field called Contact');await h.send('yes');
  const created=h.S.customFields[0];assert.equal(created.name,'Contact');assert.equal(h.S.records[0][created.id],'');
  assert.equal(h.S.records[0].account,row.account);assert.equal(h.S.records[0].owner,row.owner);
  assert.equal(h.calls.filter(call=>call.url==='/api/crm-data').length,1);
  assert.equal(h.newRecord({account:'New'},2)[created.id],'');assert.equal(h.newRecord({account:'Imported'},3,true)[created.id],'');
  assert.equal(h.aiPayload('Edit Contact').pipeline.fields[created.id],'Contact');
  await h.undo();assert.equal(h.S.customFields.length,0);assert.deepEqual(h.S.records,[row]);
});
test('empty CRM retains a created column and repeated or stale creation is rejected',async()=>{
  const h=harness();h.S.records=[];h.prepare({action:'add_field',newFieldName:'Contact'},'add');await h.confirmDraft();
  assert.equal(h.snapshot().customFields.length,1);assert.equal(h.snapshot().deals.length,0);
  assert.throws(()=>h.prepare({action:'add_field',newFieldName:'CONTACT'},'duplicate'),/already exists/);
  h.prepare({action:'add_field',newFieldName:'Region'},'add');h.S.revision++;const count=h.calls.length;await h.confirmDraft();
  assert.equal(h.calls.length,count);assert.match(h.messages.at(-1),/table changed/);
});
test('custom inline edits work at the chat cap, preserve drafts on outage and retry explicitly',async()=>{
  const h=harness();h.prepare({action:'add_field',newFieldName:'Contact'},'add');await h.confirmDraft();
  const id=h.S.customFields[0].id;h.S.usage={used:1,remaining:0,paymentRequired:true};
  const edit=value=>h.manualEdit({value,dataset:{field:id},closest:()=>({dataset:{id:'1'}})});
  h.fail(true);await edit('Taylor');assert.equal(h.S.records[0][id],'');assert.equal(h.S.failedEdit.raw,'Taylor');assert.equal(h.storage.size,1);
  h.S.failedEdit=null;h.restoreFailedEdit();assert.equal(h.S.failedEdit.field,id);
  h.fail(false);await h.reviewFailedEdit();await h.retryFailedEdit();
  assert.equal(h.S.records[0][id],'Taylor');assert.equal(h.S.failedEdit,null);assert.equal(h.storage.size,0);
  h.prepare({action:'update_record',recordMatch:'Acme QA',field:id,value:'Morgan'},'update');await h.confirmDraft();assert.equal(h.S.records[0][id],'Morgan');
  assert.equal(h.calls.filter(call=>call.url==='/api/pipechat-ai').length,0);
});
test('column names and cells are escaped and new columns render only after confirmation',async()=>{
  const h=harness(),name='<img src=x onerror=alert(1)>';
  h.prepare({action:'add_field',newFieldName:name},'add');assert(!h.node('trustBody').innerHTML.includes('<img'));
  h.renderTable(h.S.records);assert(!h.node('dealHeaders').innerHTML.includes('&lt;img'));
  await h.confirmDraft();h.S.records[0][h.S.customFields[0].id]='"><script>bad</script>';h.renderTable(h.S.records);
  assert(h.node('dealHeaders').innerHTML.includes('&lt;img'));assert(!h.node('dealRows').innerHTML.includes('<script>'));
  assert.match(h.node('dealRows').innerHTML,/data-field="cf_/);assert.equal(h.node('pipelineTable').style.minWidth,'830px');
});
test('Backend custom snapshots validate and preserve metadata even without deals',()=>{
  assert.deepEqual(snapshotResult({deals:[],customFields:[field],updatedAt:'v1'}).customFields,[field]);
  const result=snapshotResult({deals:[{...row,cf_contact:'Taylor',password:'secret'}],customFields:[field],updatedAt:'v1'});
  assert.equal(result.deals[0].cf_contact,'Taylor');assert.equal(result.deals[0].password,undefined);
  assert.throws(()=>snapshotResult({deals:[{...row,cf_bad:'x'}],customFields:[field],updatedAt:'v1'}));
});
