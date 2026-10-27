const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const H=require('../public/inspector-core.js');
const Core=require('../public/pipeline-core.js'),Schema=require('../public/table-schema.js');
const markup=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
const nameMarkup=/<(\w+)\b[^>]*\bid="inspectorNameInput"[^>]*>/i.exec(markup);assert(nameMarkup);
function schemaWithPrimary(type){
  const schema=Schema.legacySchema();
  schema.fields.push({id:'f_primary',name:'Current primary',role:'none',type,options:type==='choice'?['Acme','Other <x>']:[]});
  schema.columnOrder=['f_primary',...schema.fields.map(field=>field.id).filter(id=>id!=='f_primary')];
  return schema;
}
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness(storage=new Map(),user='A'){
  const nodes=new Map(),document={activeElement:null};
  function element(tag,id=''){
    let value='';
    const node={id,tagName:tag.toUpperCase(),textContent:'',innerHTML:'',hidden:false,disabled:false,open:false,
      get value(){return value;},set value(next){value=String(next);},
      addEventListener(k,fn){this[k]=fn;},showModal(){this.open=true;},close(){this.open=false;},focus(){document.activeElement=this;},
      replaceWith(next){assert.equal(nodes.get(this.id),this);nodes.delete(this.id);nodes.set(next.id,next);}};
    // Match the platform's getter-only property, not a writable plain-object stub.
    if(node.tagName==='TEXTAREA')Object.defineProperty(node,'type',{get:()=> 'textarea'});
    else if(node.tagName==='INPUT'){node.type='text';node.step='';}
    return node;
  }
  const node=id=>{if(!nodes.has(id)){
    const next=element(id==='inspectorNameInput'?nameMarkup[1]:id==='inspectorNameChoice'?'select':'div',id);
    if(id==='inspectorNameInput'){next.rows=Number(/\brows="(\d+)"/.exec(nameMarkup[0])?.[1]);next.maxLength=Number(/\bmaxlength="(\d+)"/.exec(nameMarkup[0])?.[1]);}
    nodes.set(id,next);
  }return nodes.get(id);};
  document.getElementById=node;document.createElement=tag=>element(tag);
  const S={user:{id:user,name:'QA',email:user+'@example.invalid'},health:{storageProvider:'json'},records:[{id:1,account:'Acme',history:[]}],customFields:[],loaded:true,generation:1};
  const context={crypto,window:{PipeChatInspector:H,PipeChatIcons:{},PipelineCore:Core,addEventListener(){}},document,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/inspector-ui.js'),'utf8'),context);
  let fail=false,calls=0,saved;const edits=[];
  const ui=context.window.PipeChatInspectorUI.create({S,esc:escape,icon:()=>'',rowName:r=>r[Core.create(S.tableSchema).role('primary')],persist:async rows=>{calls++;if(fail)return false;S.records=rows;return true;},editRecord:async(id,field,value)=>{calls++;edits.push({id,field,value});if(fail){S.failedEdit={id,field,raw:value};return false;}const parsed=Core.create(S.tableSchema).validateValue(field,value,S.customFields);S.records=S.records.map(r=>r.id===id?{...r,[field]:parsed}:r);return true;},refresh:async()=>{if(saved)S.records=saved;},toast(){}});
  const input=text=>{node('inspectorNote').value=text;node('inspectorNote').input();};
  const submit=()=>node('inspectorForm').submit({preventDefault(){}});
  return {S,node,ui,input,submit,storage,document,edits,fail:v=>fail=v,calls:()=>calls,saved:v=>saved=v};
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
test('inspector name editor saves only the selected primary cell, cancels without writes and retains failed edits',async()=>{
  const h=harness();h.S.records.push({id:2,account:'Acme',owner:'Sarah',history:[]});h.ui.open(1);h.node('inspectorEditName').onclick();
  assert.equal(h.node('inspectorNameInput').value,'Acme');h.node('inspectorNameInput').value='Cancelled';h.node('inspectorNameCancel').onclick();assert.equal(h.calls(),0);
  h.node('inspectorEditName').onclick();h.node('inspectorNameInput').value='Renamed';await h.node('inspectorNameForm').submit({preventDefault(){}});
  assert.equal(h.S.records[0].account,'Renamed');assert.equal(h.S.records[1].account,'Acme');assert(h.node('inspectorNameForm').hidden);assert.equal(h.node('inspectorTitle').textContent,'Renamed');
  h.node('inspectorEditName').onclick();h.node('inspectorNameInput').value='Keep this draft';h.fail(true);await h.node('inspectorNameForm').submit({preventDefault(){}});
  assert.equal(h.S.failedEdit.raw,'Keep this draft');assert.equal(h.S.records[0].account,'Renamed');assert.match(h.node('inspectorNameError').textContent,/recover/);assert(h.node('inspectorNameSave').disabled);
});
test('name editor respects choice fields, schema changes, stale values and pending proposals',async()=>{
  const h=harness();h.S.tableSchema=require('../public/table-schema.js').legacySchema();h.S.tableSchema.fields[0]={...h.S.tableSchema.fields[0],type:'choice',options:['Acme','Other <x>']};
  h.ui.open(1);h.node('inspectorEditName').onclick();assert(h.node('inspectorNameInput').hidden);assert(!h.node('inspectorNameChoice').hidden);assert.match(h.node('inspectorNameChoice').innerHTML,/&lt;x&gt;/);
  h.node('inspectorNameChoice').value='Other <x>';h.S.pending={};await h.node('inspectorNameForm').submit({preventDefault(){}});assert.equal(h.calls(),0);
  h.S.pending=null;h.S.tableSchema.fields[0].name='New heading';await h.node('inspectorNameForm').submit({preventDefault(){}});assert.equal(h.calls(),0);assert.match(h.node('inspectorNameError').textContent,/primary field changed/);
  h.node('inspectorNameCancel').onclick();h.node('inspectorEditName').onclick();h.S.records[0].account='Newer';await h.node('inspectorNameForm').submit({preventDefault(){}});assert.equal(h.calls(),0);
  h.node('inspectorNameCancel').onclick();h.node('inspectorEditName').onclick();h.node('inspectorNameChoice').value='Acme';await h.node('inspectorNameForm').submit({preventDefault(){}});assert.equal(h.calls(),1);
});
for(const [type,before,raw,expected] of [
  ['text','Acme','Renamed\nSecond line','Renamed\nSecond line'],
  ['number',0,'-12.345',-12.345],['currency',12.25,'0',0],
  ['date','2026-10-26','2026-11-02','2026-11-02'],['choice','Acme','Other <x>','Other <x>']
])test(`primary rename uses the actual textarea markup safely for a ${type} field`,async()=>{
  const h=harness();h.S.tableSchema=schemaWithPrimary(type);
  h.S.records=[{id:1,account:'Acme',f_primary:before,owner:'Ravi',history:[]},{id:2,account:'Acme',f_primary:before,owner:'Alex',history:[]}];
  const untouched=structuredClone(h.S.records[1]),initial=h.node('inspectorNameInput');
  assert.equal(initial.tagName,'TEXTAREA');assert.equal(initial.type,'textarea');
  assert.throws(()=>{(function(){'use strict';initial.type='text';})();},TypeError,'textarea.type must behave like the real getter-only DOM property');
  h.ui.open(1);assert.doesNotThrow(()=>h.node('inspectorEditName').onclick());
  const id=type==='choice'?'inspectorNameChoice':'inspectorNameInput',editor=h.node(id);
  assert.equal(editor.tagName,type==='choice'?'SELECT':type==='text'?'TEXTAREA':'INPUT');
  assert.equal(editor.value,String(before));assert.equal(editor.hidden,false);
  assert.equal(h.node('inspectorNameLabel').htmlFor,id);assert.equal(h.document.activeElement,editor);
  assert.equal(h.node('inspectorNameForm').hidden,false);
  if(type==='text'){assert.equal(editor,initial);assert.equal(editor.rows,2);assert.equal(editor.maxLength,12000);}
  if(['number','currency','date'].includes(type)){
    assert.notEqual(editor,initial);assert.equal(editor.type,type==='date'?'date':'number');
    assert.equal(editor.step,type==='currency'?'0.01':'any');
  }
  editor.value=raw;await h.node('inspectorNameForm').submit({preventDefault(){}});
  assert.deepEqual(h.edits,[{id:1,field:'f_primary',value:raw}]);assert.equal(h.S.records[0].f_primary,expected);assert.equal(h.S.records[0].account,'Acme');
  assert.equal(h.S.records[0].owner,'Ravi');assert.deepEqual(h.S.records[0].history,[]);assert.deepEqual(h.S.records[1],untouched);
  assert.equal(h.node('inspectorNameForm').hidden,true);assert.equal(h.node('inspectorNameInput').value,'');
  assert.equal(h.document.activeElement,h.node('inspectorTitle'));
});

test('name control switches between typed inputs, choices and multiline text after schema changes',()=>{
  const h=harness();
  for(const [type,value] of [['currency',12.5],['date','2026-10-26'],['choice','Acme'],['text','Acme\nLong name'],['number',0],['text','Acme']]){
    h.S.tableSchema=schemaWithPrimary(type);
    h.S.records[0].f_primary=value;h.ui.open(1);h.node('inspectorEditName').onclick();
    const editor=h.node(type==='choice'?'inspectorNameChoice':'inspectorNameInput');
    assert.equal(editor.tagName,type==='choice'?'SELECT':type==='text'?'TEXTAREA':'INPUT');
    assert.equal(editor.value,String(value));assert.equal(editor.disabled,false);
    assert.equal(h.node('inspectorNameInput').hidden,type==='choice');assert.equal(h.node('inspectorNameChoice').hidden,type!=='choice');
    assert.equal(h.node('inspectorNameLabel').htmlFor,editor.id);
    if(type==='text'){assert.equal(editor.rows,2);assert.equal(editor.maxLength,12000);assert.equal(editor.type,'textarea');}
    editor.value='Discarded';h.node('inspectorNameCancel').onclick();
    assert.equal(h.calls(),0);assert.equal(h.node('inspectorNameInput').value,'');assert.equal(h.node('inspectorNameForm').hidden,true);
    assert.equal(h.document.activeElement,h.node('inspectorEditName'));
  }
});

test('renaming after primary-column reordering edits the effective numeric field, not the old account field',async()=>{
  const h=harness();h.S.tableSchema=Schema.legacySchema();
  h.S.tableSchema.columnOrder=['value',...h.S.tableSchema.fields.map(field=>field.id).filter(id=>id!=='value')];
  h.S.records[0].value=125.5;h.ui.open(1);h.node('inspectorEditName').onclick();
  const editor=h.node('inspectorNameInput');assert.equal(editor.tagName,'INPUT');assert.equal(editor.type,'number');assert.equal(editor.value,'125.5');
  editor.value='250.75';await h.node('inspectorNameForm').submit({preventDefault(){}});
  assert.deepEqual(h.edits,[{id:1,field:'value',value:'250.75'}]);assert.equal(h.S.records[0].value,250.75);assert.equal(h.S.records[0].account,'Acme');
});

test('inspector hides authors, filters inclusive dates and resets them without changing saved history',()=>{
  const h=harness();h.S.records[0].history=['2026-09-20T12:00:00Z | private@example.invalid: Company changed from "Old" to "Acme".',...H.addNote(h.S.records,1,'Notes: preserve this','private@example.invalid','n',new Date('2026-09-21T12:00:00Z'))[0].history];
  const before=JSON.stringify(h.S.records);h.ui.open(1);assert(!h.node('inspectorTimeline').innerHTML.includes('private@example.invalid'));assert.match(h.node('inspectorTimeline').innerHTML,/Notes: preserve/);
  h.node('inspectorFrom').value='2026-09-20';h.node('inspectorTo').value='2026-09-20';h.node('inspectorFrom').change();assert.equal(h.node('inspectorCount').textContent,'1 entry');
  h.node('inspectorFrom').value='2026-09-22';h.node('inspectorFrom').change();assert.match(h.node('inspectorTimeline').innerHTML,/start date/);assert(h.node('inspectorMore').hidden);
  h.node('inspectorClearDates').onclick();assert.equal(h.node('inspectorCount').textContent,'2 entries');assert.equal(JSON.stringify(h.S.records),before);
});
