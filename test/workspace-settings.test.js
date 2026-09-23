const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
function harness(handler=()=>({deals:[],customFields:[],tableSchema:{status:'pending'},updatedAt:'v2'})){
  const nodes=new Map(),calls=[],storage=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',hidden:false,open:false,disabled:false,attributes:{},setAttribute(k,v){this.attributes[k]=v;},focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;},classList:{remove(){}}});return nodes.get(id);};
  const context={window:{PipeChatInspector:require('../public/inspector-core.js'),PipeChatTodo:require('../public/todo-core.js'),PipelineCore:require('../public/pipeline-core.js'),PipeChatSchema:require('../public/table-schema.js'),PipeChatIcons:{}},document:{getElementById:node},sessionStorage:{removeItem:k=>storage.delete(k)},clearTimeout(){},fetch:async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>handler(url,options)};}};
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();','  render=()=>{};window.test={S,openSettings,openResetDialog,closeResetDialog,resetWorkspace};'),context);
  const api=context.window.test;Object.assign(api.S,{loaded:true,user:{id:'a',email:'a@example.invalid'},records:[{id:1,account:'Preserve me'}],customFields:[],updatedAt:'v1',settingsOpen:true});
  return {...api,node,calls,storage};
}
test('reset requires confirmation; No closes without a request or state loss',async()=>{
  const h=harness();await h.resetWorkspace();assert.equal(h.calls.length,0);
  h.openResetDialog();assert(h.node('resetDialog').open);assert(h.node('resetNoBtn').focused);
  h.closeResetDialog();await h.resetWorkspace();assert.equal(h.calls.length,0);assert.equal(h.S.records[0].account,'Preserve me');assert(!h.node('resetDialog').open);
});
test('confirmed reset clears table and drafts, preserves account and quota, and returns to setup',async()=>{
  const h=harness();const user=h.S.user,usage={used:1000,limit:1000,remaining:0};h.S.usage=usage;
  Object.assign(h.S,{history:[{content:'Old chat'}],pending:{kind:'update'},clarification:{question:'old'},undo:{records:[{}]},failedEdit:{raw:'draft'},setupUseCase:'Sales',schemaPreview:{},filter:{field:'owner'},search:'old'});
  h.storage.set('pipechat.failed-edit.v1','old');h.node('shareRecipient').value='Old';h.node('chatFeed').innerHTML='Old';
  h.openResetDialog();await h.resetWorkspace();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/crm-reset');assert.deepEqual(JSON.parse(h.calls[0].options.body),{confirm:true,expectedUpdatedAt:'v1'});
  assert.equal(h.S.user,user);assert.equal(h.S.usage,usage);assert.equal(h.S.tableSchema.status,'pending');assert.equal(h.S.records.length,0);assert.equal(h.S.history.length,0);
  for(const key of ['pending','clarification','undo','failedEdit','setupUseCase','schemaPreview','filter'])assert.equal(h.S[key],null);
  assert.equal(h.S.settingsOpen,false);assert.equal(h.S.resetting,false);assert.equal(h.node('shareRecipient').value,'');assert.equal(h.node('chatFeed').innerHTML,'');assert.equal(h.storage.size,0);assert(h.node('setupQuestion').focused);
});
test('reset failures and invalid acknowledgements preserve visible data and drafts',async()=>{
  for(const handler of [()=>{throw Error('offline');},()=>({deals:[],customFields:[],tableSchema:{status:'ready'},updatedAt:'v2'}),()=>({deals:[],customFields:[],tableSchema:{status:'pending'},updatedAt:'v1'})]){
    const h=harness(handler);h.S.undo={records:[{}]};h.openResetDialog();await h.resetWorkspace();assert.equal(h.S.records[0].account,'Preserve me');assert(h.S.undo);assert(h.node('resetDialog').open);assert.match(h.node('resetError').textContent,/Reset not confirmed/);assert.equal(h.node('resetNoBtn').disabled,false);
  }
});
test('stale dialogs, busy work and duplicate clicks cannot issue destructive requests',async()=>{
  const h=harness();h.S.busy=true;h.openResetDialog();assert.equal(h.S.resetConfirmation,null);h.S.busy=false;h.openResetDialog();h.S.revision++;await h.resetWorkspace();assert.equal(h.calls.length,0);
  let resolve;const delayed=harness(()=>new Promise(r=>resolve=r));delayed.openResetDialog();const first=delayed.resetWorkspace();await Promise.resolve();await Promise.resolve();await delayed.resetWorkspace();delayed.closeResetDialog();assert.equal(delayed.calls.length,1);assert(delayed.node('resetDialog').open);
  delayed.S.generation++;delayed.S.user={id:'b'};delayed.S.records=[{id:9,account:'New session'}];resolve({deals:[],customFields:[],tableSchema:{status:'pending'},updatedAt:'v2'});await first;assert.equal(delayed.S.records[0].account,'New session');
});
test('settings confirmation has exact warning and whole-word header layout',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),css=fs.readFileSync(path.join(__dirname,'../public/pipechat.css'),'utf8');
  assert(html.includes('Are you sure you want to reset Pipechat? This will delete all existing information in your Pipechat table and return you to the onboarding screen.'));
  assert.match(html,/id="resetNoBtn"[^>]*>No</);assert.match(html,/id="resetYesBtn"[^>]*>Yes</);
  assert.match(css,/#pipelineTable\{table-layout:auto\}/);assert.match(css,/#pipelineTable[^}]*min-width:min-content;word-break:normal;overflow-wrap:normal/);
});
