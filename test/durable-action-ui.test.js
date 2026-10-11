'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const Core=require('../public/pipeline-core'),Schema=require('../public/table-schema'),Todo=require('../public/todo-core'),F=require('./fixtures/workspace-plans.cjs');
function harness(handler){
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,classList:{add(){},remove(){}},innerHTML:''});return nodes.get(id);};
  const source=fs.readFileSync(require.resolve('../public/pipechat'),'utf8').replace(/\r\n/g,'\n');
  const window={PipelineCore:Core,PipeChatSchema:Schema,PipeChatTodo:Todo,PipeChatInspector:require('../public/inspector-core'),PipeChatIcons:{}};
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>{};renderTrust=()=>{};syncShareFields=()=>{};toast=()=>{};say=()=>{};keepFailedEdit=()=>{};focusTrust=()=>{};api=handler;window.test={S,useSchema,persist,prepareUndo,confirmDraft,restoreDurableUndo};`),{window,document:{getElementById:node},crypto,handler,Intl,Date,TextEncoder,setTimeout,clearTimeout});
  const h=window.test,w=F.workspace();h.useSchema(w.tableSchema);Object.assign(h.S,{loaded:true,user:{id:'qa',name:'QA'},records:w.records,customFields:[],todoCards:[],updatedAt:'v1',generation:1});return h;
}
test('an interrupted import retries its identical envelope and durable receipt instead of adding twice',async()=>{
  const calls=[];let first=true;
  const h=harness(async(path,options)=>{
    assert.equal(path,'/api/crm-data');const body=JSON.parse(options.body);calls.push(body);
    if(first){first=false;throw new Error('Response lost after save');}
    return {...body,updatedAt:'v2',actionReceipt:{actionId:body.actionMetadata.actionId}};
  });
  const next=structuredClone(h.S.records);next[0].f_notes='Imported source note';const receipt={id:crypto.randomUUID(),digest:'a'.repeat(64)};
  assert.equal(await h.persist(next,'Import',{importReceipt:receipt,exactRecords:true}),false);
  assert.equal(h.S.updatedAt,'v1');assert(h.S.saveAttempt);
  assert.equal(await h.persist(next,'Import',{importReceipt:receipt,exactRecords:true}),true);
  assert.deepEqual(calls[1],calls[0]);assert.equal(h.S.undo.kind,'journal');assert.equal(h.S.undo.actionId,calls[0].actionMetadata.actionId);assert.equal(h.S.saveAttempt,null);
});
test('a replay response rereads the current workspace instead of replacing later unrelated edits',async()=>{
  const current=F.workspace();current.records[1].f_notes='A later saved note';let gets=0;
  const h=harness(async(path,options)=>{
    if(!options){gets++;return {deals:current.records,customFields:[],tableSchema:current.tableSchema,todoCards:[],updatedAt:'v3'};}
    const body=JSON.parse(options.body);return {...body,updatedAt:'v2',actionReceipt:{actionId:body.actionMetadata.actionId},replayed:true};
  });
  assert.equal(await h.persist(h.S.records,'Retry'),true);assert.equal(gets,1);assert.equal(h.S.updatedAt,'v3');assert.equal(h.S.records[1].f_notes,'A later saved note');assert.equal(h.S.undo.kind,'journal');
});
test('recovered Undo prepares a server inverse and never silently writes its previous snapshot',async()=>{
  const requests=[],id=crypto.randomUUID();
  const h=harness(async(path,options)=>{requests.push({path,options});if(path==='/api/actions')return {actions:[{createdAt:'2026-10-10T12:00:00Z',receipt:{actionId:id},undoneBy:null,undoInvalidated:false}]};return {actionId:id,expectedUpdatedAt:'v1',changes:[]};});
  await h.restoreDurableUndo();assert.equal(h.S.undo.actionId,id);await h.prepareUndo(id);assert.equal(h.S.pending.kind,'journal-undo');assert.equal(h.S.pending.proposal.actionId,id);assert.equal(requests.length,2);assert(!requests.some(r=>r.options?.method==='PUT'));
});
