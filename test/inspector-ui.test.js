const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const H=require('../public/inspector-core.js');
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness(storage=new Map(),user='A'){
  const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,open:false,addEventListener(k,fn){this[k]=fn;},showModal(){this.open=true;},close(){this.open=false;},focus(){}});return nodes.get(id);};
  const S={user:{id:user,name:'QA',email:user+'@example.invalid'},health:{storageProvider:'json'},records:[{id:1,account:'Acme',history:[]}],customFields:[],loaded:true,generation:1};
  const context={crypto,window:{PipeChatInspector:H,PipeChatIcons:{},PipelineCore:require('../public/pipeline-core.js'),addEventListener(){}},document:{getElementById:node},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/inspector-ui.js'),'utf8'),context);
  let fail=false,calls=0,saved;
  const ui=context.window.PipeChatInspectorUI.create({S,esc:escape,icon:()=>'',rowName:r=>r.account,persist:async rows=>{calls++;if(fail)return false;S.records=rows;return true;},refresh:async()=>{if(saved)S.records=saved;},toast(){}});
  const input=text=>{node('inspectorNote').value=text;node('inspectorNote').input();};
  const submit=()=>node('inspectorForm').submit({preventDefault(){}});
  return {S,node,ui,input,submit,storage,fail:v=>fail=v,calls:()=>calls,saved:v=>saved=v};
}
test('inspector note save updates history only, blocks empty text, escapes untrusted text and shows chronological entries',async()=>{
  const h=harness();h.ui.open(1);assert(h.node('inspectorDialog').open);assert(h.node('inspectorSave').disabled);
  h.input('<img src=x onerror=alert(1)>\nFollow up');await h.submit();assert.equal(h.calls(),1);assert.equal(h.S.records[0].account,'Acme');assert.equal(h.node('inspectorNote').value,'');
  assert(h.node('inspectorTimeline').innerHTML.includes('&lt;img'));assert(!h.node('inspectorTimeline').innerHTML.includes('<img'));
  assert.equal(H.entries(h.S.records[0].history)[0].type,'note');
});
test('failed note keeps draft across close/reopen/reload; reload review resolves uncertain success without duplicate note',async()=>{
  const h=harness();h.ui.open(1);h.input('Retain me');h.fail(true);await h.submit();assert(h.node('inspectorSave').disabled);assert(!h.node('inspectorReload').hidden);assert.equal(h.S.records[0].history.length,0);
  const recovered=harness(h.storage);recovered.ui.open(1);assert.equal(recovered.node('inspectorNote').value,'Retain me');
  const draft=JSON.parse([...h.storage.values()][0]).drafts[1];h.saved(H.addNote(h.S.records,1,draft.text,'QA',draft.id));await h.node('inspectorReload').onclick();assert.equal(h.node('inspectorNote').value,'');assert.equal(h.S.records[0].history.length,1);assert.equal(h.calls(),1);
});
test('drafts do not cross users; logout/reset clear both drafts and rendered private contents',()=>{
  const a=harness();a.ui.open(1);a.input('private');const b=harness(a.storage,'B');b.ui.open(1);assert.equal(b.node('inspectorNote').value,'');
  a.ui.clear();assert.equal(a.storage.size,0);assert.equal(a.node('inspectorTimeline').innerHTML,'');assert.equal(a.node('inspectorNote').value,'');assert(!a.node('inspectorDialog').open);
});
test('notes do not silently cancel a pending proposal and unavailable records cannot open',async()=>{
  const h=harness();h.ui.open(2);assert(!h.node('inspectorDialog').open);h.ui.open(1);h.input('note');h.S.pending={kind:'update'};await h.submit();assert.equal(h.calls(),0);assert.match(h.node('inspectorError').textContent,/Confirm or cancel/);
});
