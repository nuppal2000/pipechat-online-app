'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(require.resolve('../public/pipechat'),'utf8').replace(/\r\n/g,'\n');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function harness(handler){
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,open:false,classList:{add(){},remove(){}},setAttribute(){},focus(){},close(){this.open=false;}});return nodes.get(id);};
  const counters={clears:0,workflowClears:0,loads:[],renders:0};let snapshot={workspaceId:'previous',access:{email:'previous@example.invalid'}};
  const panel={clear(){counters.clears++;snapshot=null;},getSnapshot(){return snapshot;},async load(id){counters.loads.push(id);snapshot={workspaceId:id||'own-new'};},show(){counters.renders++;}};
  const window={PipelineCore:require('../public/pipeline-core'),PipeChatSchema:require('../public/table-schema'),PipeChatTodo:require('../public/todo-core'),PipeChatInspector:require('../public/inspector-core'),PipeChatIcons:{}};
  const hook='  wire();\n  restoreSession();';assert(source.includes(hook));
  vm.runInNewContext(source.replace(hook,`businessUI=panel;workflowUI={clear(){counters.workflowClears++;}};api=handler;updateUsage=()=>{};render=()=>{};keepFailedEdit=()=>{};toast=()=>{};window.test={S,loadBusinessView,clearBusinessSession,logout,loadWorkspace,getLoading:()=>businessLoading};`),{window,document:{getElementById:node,body:{classList:{add(){},remove(){}}},querySelectorAll:()=>[]},panel,counters,handler,crypto,Intl,Date,TextEncoder,setTimeout,clearTimeout});
  Object.assign(window.test.S,{generation:1,loaded:true,user:{id:'a'},tab:'entities'});
  return {...window.test.S,...window.test,node,counters,panel};
}
test('loading a business workspace clears old private data before the list request settles',async()=>{
  const response=deferred(),h=harness(()=>response.promise),loading=h.loadBusinessView();
  assert.equal(h.panel.getSnapshot(),null);assert.equal(h.getLoading(),true);
  response.reject(new Error('Unavailable'));await loading;
  assert.equal(h.panel.getSnapshot(),null);assert.equal(h.getLoading(),false);assert.equal(h.node('businessStatus').textContent,'Unavailable');
});
test('old account success and failure cannot publish or unlock a newer account load',async t=>{
  for(const failure of [false,true])await t.test(failure?'late error':'late list',async()=>{
    const responses=[deferred(),deferred()];let index=0;
    const h=harness(()=>responses[index++].promise),old=h.loadBusinessView();
    h.S.generation++;h.clearBusinessSession();h.S.user={id:'b'};const current=h.loadBusinessView();
    if(failure)responses[0].reject(new Error('Old private error'));else responses[0].resolve({workspaces:[{workspaceId:'old-account',title:'PRIVATE A',role:'owner'}]});
    await old;assert.equal(h.getLoading(),true);assert.equal(h.node('businessStatus').textContent,'Loading...');assert.equal(h.node('businessWorkspace').innerHTML,'');assert.deepEqual(h.counters.loads,[]);
    responses[1].resolve({workspaces:[{workspaceId:'own-new',title:'B',role:'owner'}]});await current;
    assert.equal(h.getLoading(),false);assert.equal(h.panel.getSnapshot().workspaceId,'own-new');assert.equal(h.S.ownBusinessWorkspaceId,'own-new');assert(!h.node('businessWorkspace').innerHTML.includes('PRIVATE A'));
  });
});
test('successful logout clears private panels, owner identity and selector',async()=>{
  const h=harness(async path=>{assert.equal(path,'/api/auth/logout');return {};});
  h.S.ownBusinessWorkspaceId='previous';h.node('businessWorkspace').innerHTML='private recipient';
  await h.logout();assert.equal(h.S.user,null);assert.equal(h.S.ownBusinessWorkspaceId,null);assert.equal(h.panel.getSnapshot(),null);assert.equal(h.counters.workflowClears,1);assert.equal(h.node('businessWorkspace').innerHTML,'');
});
test('loading a different account clears private panels even if CRM load fails',async()=>{
  const h=harness(async()=>{throw new Error('Offline');});
  await h.loadWorkspace({id:'b',name:'B'});
  assert.equal(h.panel.getSnapshot(),null);assert.equal(h.counters.workflowClears,1);assert.equal(h.S.ownBusinessWorkspaceId,null);
});
