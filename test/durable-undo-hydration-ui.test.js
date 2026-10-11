'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const Core=require('../public/pipeline-core'),Schema=require('../public/table-schema'),Todo=require('../public/todo-core'),F=require('./fixtures/workspace-plans.cjs');
const source=fs.readFileSync(require.resolve('../public/pipechat'),'utf8').replace(/\r\n/g,'\n');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function action(actionId,extra={}){return {createdAt:'2026-10-10T12:00:00Z',receipt:{actionId},undoneBy:null,undoInvalidated:false,...extra};}
function harness(handler){
  const nodes=new Map(),renders=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,innerHTML:'',open:false,classList:{add(){},remove(){}},setAttribute(){},focus(){},showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(id);};
  const window={PipelineCore:Core,PipeChatSchema:Schema,PipeChatTodo:Todo,PipeChatInspector:require('../public/inspector-core'),PipeChatIcons:{}};
  const hook='  wire();\n  restoreSession();';assert(source.includes(hook));
  vm.runInNewContext(source.replace(hook,`render=()=>rendered(S.undo);renderTrust=()=>{};syncShareFields=()=>{};toast=()=>{};say=()=>{};keepFailedEdit=()=>{};api=handler;window.test={S,useSchema,persist,dismissUndo,restoreDurableUndo,openResetDialog,resetWorkspace};`),{window,document:{getElementById:node},crypto,handler,rendered:undo=>renders.push(undo),Intl,Date,TextEncoder,setTimeout,clearTimeout});
  const h=window.test,w=F.workspace();h.useSchema(w.tableSchema);Object.assign(h.S,{loaded:true,user:{id:'qa',name:'QA'},records:w.records,customFields:[],todoCards:[],updatedAt:'v1',generation:1});
  return {...h,node,renders};
}

test('delayed Undo hydration cannot replace or clear a newer saved Undo',async t=>{
  for(const actions of [[action('old-action')],[]])await t.test(actions.length?'stale action':'empty journal',async()=>{
    const response=deferred();
    const h=harness(async(path,options)=>{
      if(path==='/api/actions')return response.promise;
      assert.equal(path,'/api/crm-data');assert.equal(options.method,'PUT');
      const body=JSON.parse(options.body);return {...body,updatedAt:'v2',actionReceipt:{actionId:body.actionMetadata.actionId}};
    });
    const hydration=h.restoreDurableUndo(),next=structuredClone(h.S.records);next[0].f_notes='New saved note';
    assert.equal(await h.persist(next,'New saved change'),true);
    const undo=h.S.undo,renderCount=h.renders.length;
    response.resolve({actions});await hydration;
    assert.equal(h.S.undo,undo);assert.equal(h.S.undo.label,'New saved change');assert.equal(h.S.records[0].f_notes,'New saved note');assert.equal(h.renders.length,renderCount);
  });
});

test('delayed Undo hydration respects dismissal of the same Undo object',async t=>{
  for(const beforeRequest of [false,true])await t.test(beforeRequest?'already dismissed':'dismissed while waiting',async()=>{
    const response=deferred(),h=harness(()=>response.promise);
    const undo=h.S.undo={kind:'journal',actionId:'visible-action',label:'Visible change'};
    if(beforeRequest)h.dismissUndo();
    const hydration=h.restoreDurableUndo();
    if(!beforeRequest)h.dismissUndo();
    response.resolve({actions:[action('visible-action')]});await hydration;
    assert.equal(h.S.undo,undo);assert.equal(h.S.undo.dismissed,true);assert.equal(h.node('undoStrip').hidden,true);assert.equal(h.node('toast').hidden,true);assert.equal(h.renders.length,0);
  });
});

test('Undo hydration preserves a replacement Undo even without a revision change',async()=>{
  const response=deferred(),h=harness(()=>response.promise),revision=h.S.revision;
  h.S.undo={kind:'journal',actionId:'previous-action'};
  const hydration=h.restoreDurableUndo(),undo=h.S.undo={kind:'journal',actionId:'replacement-action'};
  response.resolve({actions:[action('stale-action')]});await hydration;
  assert.equal(h.S.revision,revision);assert.equal(h.S.undo,undo);assert.equal(h.renders.length,0);
});

test('Undo hydration checks revision even when current Undo remains null',async()=>{
  const response=deferred();
  const h=harness(async(path,options)=>path==='/api/actions'?response.promise:{...JSON.parse(options.body),updatedAt:'v2'});
  const revision=h.S.revision,hydration=h.restoreDurableUndo();
  assert.equal(await h.persist(h.S.records,'Undo completed',{undo:false}),true);assert.equal(h.S.undo,null);assert.equal(h.S.revision,revision+1);
  const renderCount=h.renders.length;response.resolve({actions:[action('stale-action')]});await hydration;
  assert.equal(h.S.undo,null);assert.equal(h.renders.length,renderCount);
});

test('only the latest Undo hydration request can publish in either response order',async t=>{
  for(const reverse of [true,false])await t.test(reverse?'reverse response order':'older response while latest is pending',async()=>{
    const responses=[deferred(),deferred()];let calls=0;
    const h=harness(()=>responses[calls++].promise),older=h.restoreDurableUndo(),latest=h.restoreDurableUndo();
    assert.equal(calls,2);
    if(reverse){
      responses[1].resolve({actions:[action('latest-action')]});await latest;
      const undo=h.S.undo;assert.equal(undo.actionId,'latest-action');
      responses[0].resolve({actions:[action('older-action')]});await older;assert.equal(h.S.undo,undo);
    }else{
      responses[0].resolve({actions:[action('older-action')]});await older;assert.equal(h.S.undo,null);assert.equal(h.renders.length,0);
      responses[1].resolve({actions:[action('latest-action')]});await latest;assert.equal(h.S.undo.actionId,'latest-action');
    }
    assert.equal(h.renders.length,1);
  });
});

test('a failed latest hydration does not allow an older response to publish',async()=>{
  const responses=[deferred(),deferred()];let calls=0;
  const h=harness(()=>responses[calls++].promise),older=h.restoreDurableUndo(),latest=h.restoreDurableUndo();
  responses[1].reject(new Error('offline'));await latest;
  responses[0].resolve({actions:[action('older-action')]});await older;
  assert.equal(h.S.undo,null);assert.equal(h.renders.length,0);
});

test('Undo hydration from an earlier account generation cannot publish',async()=>{
  const response=deferred(),h=harness(()=>response.promise),hydration=h.restoreDurableUndo();
  h.S.generation++;h.S.user={id:'other-account',name:'Other'};
  response.resolve({actions:[action('previous-account-action')]});await hydration;
  assert.equal(h.S.undo,null);assert.equal(h.renders.length,0);
});

test('reset blocks Undo hydration while pending and invalidates earlier requests after completion',async t=>{
  for(const succeeds of [true,false])await t.test(succeeds?'confirmed reset':'failed reset',async()=>{
    const response=deferred(),resetResponse=deferred();let actionCalls=0;
    const h=harness(path=>{
      if(path==='/api/actions'){actionCalls++;return response.promise;}
      assert.equal(path,'/api/crm-reset');return resetResponse.promise;
    });
    const hydration=h.restoreDurableUndo();h.S.settingsOpen=true;h.openResetDialog();const resetting=h.resetWorkspace();
    assert.equal(h.S.resetting,true);
    const duringReset=h.restoreDurableUndo(),callsDuringReset=actionCalls;
    if(succeeds)resetResponse.resolve({deals:[],customFields:[],tableSchema:{status:'pending'},updatedAt:'v2'});
    else resetResponse.reject(new Error('offline'));
    await resetting;assert.equal(h.S.resetting,false);
    if(succeeds)assert.equal(h.S.tableSchema.status,'pending');
    else assert.match(h.node('resetError').textContent,/Reset not confirmed: offline/);
    const renderCount=h.renders.length;response.resolve({actions:[action('pre-reset-action')]});await Promise.all([hydration,duringReset]);
    assert.equal(callsDuringReset,1);assert.equal(h.S.undo,null);assert.equal(h.renders.length,renderCount);
  });
});

test('a hydration response arriving during reset cannot publish',async()=>{
  const response=deferred(),resetResponse=deferred();
  const h=harness(path=>path==='/api/actions'?response.promise:resetResponse.promise),hydration=h.restoreDurableUndo();
  h.S.settingsOpen=true;h.openResetDialog();const resetting=h.resetWorkspace(),renderCount=h.renders.length;
  response.resolve({actions:[action('pre-reset-action')]});await hydration;
  const undoDuringReset=h.S.undo,rendersDuringReset=h.renders.length;
  resetResponse.resolve({deals:[],customFields:[],tableSchema:{status:'pending'},updatedAt:'v2'});await resetting;
  assert.equal(undoDuringReset,null);assert.equal(rendersDuringReset,renderCount);
});

test('normal deferred hydration restores the first eligible action without changing the draft',async()=>{
  const response=deferred(),h=harness(path=>{assert.equal(path,'/api/actions');return response.promise;});
  const pending=h.S.pending={kind:'update',originalCommand:'Keep this draft'},hydration=h.restoreDurableUndo();
  assert.equal(h.S.undo,null);assert.equal(h.renders.length,0);
  response.resolve({actions:[action('undone',{undoneBy:'inverse'}),action('invalid',{undoInvalidated:true}),action('inverse',{receipt:{actionId:'inverse',undoOf:'undone'}}),action('eligible'),action('older-eligible')]});await hydration;
  assert.equal(h.S.undo.kind,'journal');assert.equal(h.S.undo.actionId,'eligible');assert.match(h.S.undo.label,/^Saved change \/ /);assert.equal(h.S.pending,pending);assert.equal(h.renders.length,1);
});

test('normal hydration clears an unavailable Undo and failure preserves the current one',async()=>{
  const responses=[deferred(),deferred()];let calls=0;
  const h=harness(()=>responses[calls++].promise);h.S.undo={kind:'journal',actionId:'unavailable'};
  const empty=h.restoreDurableUndo();responses[0].resolve({actions:[]});await empty;assert.equal(h.S.undo,null);assert.equal(h.renders.length,1);
  const undo=h.S.undo={kind:'journal',actionId:'keep-on-failure'},failed=h.restoreDurableUndo();
  responses[1].reject(new Error('offline'));await failed;assert.equal(h.S.undo,undo);assert.equal(h.renders.length,1);
});
