const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const C=require('../public/pipeline-core.js'),T=require('../public/todo-core.js');
const row={id:1,account:'Acme',stage:'Warm',value:0,close:'',owner:'Sarah',next:'Call',follow:'Tomorrow',notes:'',history:[]};
function harness(){
  const nodes=new Map(),calls=[],messages=[];let failure=false,reply=null,saved={deals:[structuredClone(row)],customFields:[],tableSchema:null,todoCards:[],updatedAt:'v1'};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',style:{},classList:{add(){},remove(){}},querySelectorAll:()=>[]});return nodes.get(id);};
  const context={crypto,AbortSignal,window:{PipeChatInspector:require('../public/inspector-core.js'),PipelineCore:C,PipeChatTodo:T,PipeChatSchema:require('../public/table-schema.js'),PipeChatIcons:{}},document:{getElementById:node,querySelector:()=>null},sessionStorage:{removeItem(){},setItem(){}},fetch:async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(failure)return {ok:false,status:503,json:async()=>({error:'Test outage'})};
    if(url==='/api/pipechat-ai')return {ok:true,json:async()=>({crmAction:reply,usage:{remaining:9}})};
    if(options.method==='PUT')saved={...body,tableSchema:body.tableSchema||null,updatedAt:'v'+calls.length};
    return {ok:true,json:async()=>structuredClone(saved)};
  }};
  context.window.messages=messages;
  const source=fs.readFileSync(require.resolve('../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>{};renderTrust=()=>{};toast=()=>{};focusTrust=()=>{};updateUsage=()=>{};say=message=>window.messages.push(message);window.test={S,prepare,confirmDraft,cancelDraft,undo,persist,manualEdit,aiPayload,send};`),context);
  const h=context.window.test;Object.assign(h.S,{records:structuredClone(saved.deals),updatedAt:'v1',user:{id:'local',name:'QA'},loaded:true,usage:{remaining:0},health:{aiConfigured:true}});
  return {...h,calls,messages,node,fail:v=>failure=v,reply:v=>reply=v};
}
const plain=v=>JSON.parse(JSON.stringify(v));
test('manual card preview/cancel/confirmation, deletion and undo work at the chat cap without changing rows',async()=>{
  const h=harness(),original=plain(h.S.records);
  h.prepare({action:'add_todo',ids:[1]});assert.equal(h.S.todoCards.length,0);assert.equal(h.calls.length,0);h.cancelDraft();assert.equal(h.calls.length,0);
  h.prepare({action:'add_todo',ids:[1]});await h.confirmDraft();assert.equal(h.S.todoCards.length,1);assert.deepEqual(plain(h.S.records),original);assert.equal(h.calls[0].body.todoCards.length,1);
  h.prepare({action:'delete_todo',todoId:h.S.todoCards[0].id});await h.confirmDraft();assert.equal(h.S.todoCards.length,0);assert.deepEqual(plain(h.S.records),original);
  await h.undo();assert.equal(h.S.todoCards.length,1);assert.deepEqual(plain(h.S.records),original);assert(h.calls.every(c=>c.url==='/api/crm-data'));
});
test('failed card save retains preview; stale and expired proposals cannot overwrite the board',async()=>{
  const h=harness();h.prepare({action:'add_todo',ids:[1]});h.fail(true);await h.confirmDraft();assert(h.S.pending);assert.equal(h.S.todoCards.length,0);
  h.fail(false);h.S.revision++;await h.confirmDraft();assert.equal(h.calls.length,1);assert.equal(h.S.todoCards.length,0);
  h.prepare({action:'add_todo',ids:[1]});h.S.pending.createdAt=Date.now()-31*60*1000;await h.confirmDraft();assert.equal(h.calls.length,1);
});
test('CRM follow-up changes project immediately; record deletion and Undo restore linked cards',async()=>{
  const h=harness();h.prepare({action:'add_todo',ids:[1]});await h.confirmDraft();
  await h.persist([{...row,follow:'Next week'}],'Follow-up');assert.equal(T.project(h.S.todoCards[0],h.S.records,null).dueDate,'Next week');
  await h.persist([],'Delete record');assert.equal(h.S.todoCards.length,0);await h.undo();assert.equal(h.S.todoCards.length,1);assert.equal(h.S.records.length,1);
});
test('urgent edits only enqueue a prompt; AI gets both stable card links and current projections',async()=>{
  const h=harness();await h.persist([{...row,notes:'must follow up with this account'}],'Urgent note');assert.deepEqual(plain(h.S.todoSuggestions),[1]);assert.equal(h.S.todoCards.length,0);
  h.prepare({action:'add_todo',ids:[1]});await h.confirmDraft();
  const payload=h.aiPayload('What is due?');assert.equal(payload.pipeline.todoCards[0].recordId,1);assert.equal(payload.pipeline.todoView[0].dueDate,'Tomorrow');assert.equal(payload.pipeline.todoView[0].title,'Acme');
  h.S.usage={remaining:10};h.reply({action:'update_todo',todoId:h.S.todoCards[0].id,todoStatus:'Done'});await h.send('Mark the card done');assert.equal(h.S.todoCards[0].status,'To Do');assert.equal(h.S.pending.after.status,'Done');await h.confirmDraft();assert.equal(h.S.todoCards[0].status,'Done');
});
