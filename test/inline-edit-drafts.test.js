'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Core=require('../public/pipeline-core'),Schema=require('../public/table-schema'),Customize=require('../public/workspace-customization');
const Inspector=require('../public/inspector-core'),F=require('./fixtures/workspace-plans.cjs');
const source=fs.readFileSync(require.resolve('../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
const decode=s=>s.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=(status,data)=>({ok:status<400,status,json:async()=>data});

// Offline DOM/event model: textarea.value changes independently of its HTML text.
function harness({legacy=false,handler,storage=new Map()}={}){
  const nodes=new Map(),calls=[],timers=[];
  class Element{
    constructor(id){this.id=id;this.listeners=new Map();this.dataset={};this.style={};this.textContent='';this.value='';this.hidden=false;this.disabled=false;this.children=[];this.cells=[];this._html='';this.classList={add(){},remove(){},toggle(){}};}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn);}
    dispatch(type,target=this){const event={target,preventDefault(){this.prevented=true;}};for(const fn of this.listeners.get(type)||[])fn(event);return event;}
    set innerHTML(value){
      this._html=value;
      if(this.id!=='dealRows')return;
      this.cells=[];
      for(const row of value.matchAll(/<tr[^>]*data-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g)){
        for(const cell of row[2].matchAll(/<(textarea|input|select)\b([^>]*)(?:>([\s\S]*?)<\/\1>|>)/g)){
          const attrs=Object.fromEntries([...cell[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])]));
          if(!attrs['data-field'])continue;
          const el=new Element(attrs['data-field']);el.tagName=cell[1].toUpperCase();el.dataset.field=attrs['data-field'];el.parent={dataset:{id:row[1]}};
          el.textContent=decode(cell[3]||'');el.value=cell[1]==='textarea'?el.textContent:attrs.value||'';
          if(el.tagName==='SELECT')el.value=decode(/<option selected>([^<]*)/.exec(cell[3]||'')?.[1]||'');
          else el.defaultValue=el.value;
          el.validity={badInput:false};el.attributes=attrs;el.selectionStart=el.selectionEnd=0;this.cells.push(el);
        }
      }
    }
    get innerHTML(){return this._html;}
    querySelectorAll(selector){return this.id==='dealRows'&&(selector==='[data-field]'||selector==='input,select,textarea,button')?this.cells:[];}
    querySelector(){return new Element('child');}
    closest(){return this.parent;}
    hasAttribute(name){return name==='data-expand-text'||Object.hasOwn(this.attributes||{},name);}
    setAttribute(name,value){this[name]=value;}
    reportValidity(){this.reported=true;}
    scrollIntoView(){}
    focus(){}
  }
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
  const window=new Element('window');
  Object.assign(window,{PipelineCore:Core,PipeChatSchema:Schema,PipeChatCustomize:Customize,PipeChatReports:require('../public/report-engine'),
    PipeChatInspector:Inspector,PipeChatTodo:require('../public/todo-core'),PipeChatIcons:{}});
  const document={getElementById:id=>id==='setupView'?null:node(id),querySelector:selector=>selector==='.field-checks'?null:node(selector),
    querySelectorAll:()=>[],body:node('body'),activeElement:null};
  let saved;
  const context={window,document,crypto:require('node:crypto'),setTimeout:fn=>{timers.push(fn);return timers.length;},
    sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    fetch:async(url,options={})=>{
      const body=options.body?JSON.parse(options.body):null;calls.push({url,options,body});
      if(handler)return handler({url,options,body,saved,get current(){return saved;},set current(v){saved=v;}});
      if(options.method==='PUT')saved={deals:body.deals,tableSchema:body.tableSchema,customFields:body.customFields,todoCards:body.todoCards,updatedAt:'v'+calls.length};
      return response(200,structuredClone(saved));
    }};
  const boot='  wire();\n  restoreSession();';assert(source.includes(boot));
  vm.runInNewContext(source.replace(boot,`
    say=()=>{};toast=()=>{};renderTrust=()=>{};updateUsage=()=>{};
    wireInlineEditing();window.addEventListener('beforeunload',warnUnsaved);
    window.test={S,useSchema,render,renderTable,renderActivity,visible,setTab,manualEdit,inlineDirty,commitInlineEdits,
      restoreFailedEdit,reviewFailedEdit,retryFailedEdit,discardFailedEdit,renderDashboardKpis,dashboardExportFilters};`),context);
  const h=window.test,w=F.workspace();h.useSchema(legacy?null:w.tableSchema);
  const rows=legacy?[{id:1,account:'QA River',stage:'Warm',value:25,owner:'A',close:'',next:'',follow:'',notes:'Send a 3 metre quote.',history:[]}]:
    w.records.slice(0,3).map((r,i)=>({...r,f_deal:['QA River','Harbor','Meadow'][i],f_value:i===2?null:i===1?200:0,f_notes:i?'Other note':'Send a 3 metre quote.',history:[]}));
  Object.assign(h.S,{loaded:true,user:{id:1,email:'local@example.invalid',name:'QA'},records:rows,customFields:[],todoCards:[],updatedAt:'v0',health:{storageProvider:'test'},expanded:legacy?1:null});
  saved={deals:structuredClone(rows),tableSchema:h.S.tableSchema,customFields:[],todoCards:[],updatedAt:'v0'};
  node('saveStatus').textContent='All changes saved';h.render();
  const cell=(field=legacy?'notes':'f_notes',id=1)=>node('dealRows').cells.find(el=>el.dataset.field===field&&Number(el.parent.dataset.id)===id);
  const emit=(type,el=cell())=>node('dealRows').dispatch(type,el);
  const drain=async()=>{for(let i=0;i<15;i++){while(timers.length)timers.shift()();await tick();if(!h.S.saving)break;}await tick();};
  return {...h,node,cell,emit,window,document,calls,storage,drain,stored:()=>saved,flushTimers:()=>{while(timers.length)timers.shift()();}};
}

for(const legacy of [false,true])test('input drafts survive redraw and warn on unload without per-keystroke saves: '+(legacy?'legacy':'tailored'),async()=>{
  const h=harness({legacy}),el=h.cell();h.document.activeElement=el;h.emit('focusin',el);
  el.value='Final quote:4metres';el.selectionStart=5;h.emit('input',el);
  assert.equal(el.textContent,'Send a 3 metre quote.');assert.equal(h.calls.length,0);
  assert.equal(h.node('saveStatus').textContent,'Unsaved changes');
  h.render();assert.equal(h.cell(),el);assert.equal(el.value,'Final quote:4metres');assert.equal(el.selectionStart,5);
  assert.equal(h.window.dispatch('beforeunload').prevented,true);
  h.emit('blur',el);h.emit('focusout',el);h.emit('change',el);await h.drain();
  assert.equal(h.calls.length,1);assert.equal(h.stored().deals[0][legacy?'notes':'f_notes'],'Final quote:4metres');
  assert.equal(h.stored().deals[0].history.length,1);assert.equal(h.S.records[0].history.length,1);
  assert.equal(h.node('saveStatus').textContent,'All changes saved');assert.equal(h.inlineDirty(),false);
  for(const type of ['change','blur','focusout'])h.emit(type,el);await h.drain();assert.equal(h.calls.length,1);
  const reload=harness({legacy});reload.S.records=structuredClone(h.stored().deals);reload.render();
  assert.equal(reload.cell().value,'Final quote:4metres');
});

for(const events of [['paste','input','change','blur','focusout'],['paste','blur'],['input','focusout'],['change','blur'],['blur']]){
  test('generic edit events commit once: '+events.join(', '),async()=>{
    const h=harness(),el=h.cell();h.emit('focusin',el);
    if(events[0]==='paste')h.emit('paste',el);
    el.value='Pasted <quote> & line\ntwo';
    for(const type of events.filter(t=>t!=='paste'))h.emit(type,el);
    await h.drain();assert.equal(h.calls.length,1);assert.equal(h.S.records[0].f_notes,el.value);assert.equal(h.S.records[0].history.length,1);
    assert.equal(h.inlineDirty(),false);
  });
}

test('render captures a changed DOM value even before its input event and a revert clears dirty state',()=>{
  const h=harness(),el=h.cell();el.value='Not yet dispatched';h.render();
  assert.equal(h.cell(),el);assert.equal(h.inlineDirty(),true);assert.equal(h.calls.length,0);
  el.value=el.defaultValue;h.emit('input',el);assert.equal(h.inlineDirty(),false);
  assert.equal(h.node('saveStatus').textContent,'All changes saved');assert.equal(h.window.dispatch('beforeunload').prevented,undefined);
});

test('reverting a draft does not erase an earlier unconfirmed-save status',()=>{
  const h=harness(),el=h.cell();h.node('saveStatus').textContent='Save not confirmed';
  el.value='Temporary edit';h.emit('input',el);assert.equal(h.node('saveStatus').textContent,'Unsaved changes');
  el.value=el.defaultValue;h.emit('input',el);assert.equal(h.node('saveStatus').textContent,'Save not confirmed');
});

test('rapid duplicate events while a write is pending do not duplicate activity',async()=>{
  let finish;
  const h=harness({handler:({body})=>new Promise(resolve=>{finish=()=>resolve(response(200,{deals:body.deals,tableSchema:body.tableSchema,customFields:[],todoCards:[],updatedAt:'v1'}));})});
  const el=h.cell();el.value='Pending quote';h.emit('input',el);h.emit('change',el);
  for(const type of ['blur','change','focusout'])h.emit(type,el);
  assert.equal(h.calls.length,1);assert.equal(h.S.saving,true);assert.equal(h.cell(),el);assert.equal(el.disabled,true);
  finish();await h.drain();assert.equal(h.S.records[0].history.length,1);assert.equal(h.calls.length,1);
});

for(const failure of ['offline','stale-value','missing-history'])test('unconfirmed '+failure+' retains recoverable raw draft, never Saved',async()=>{
  const h=harness({handler:({body,saved})=>failure==='offline'?response(503,{error:'Offline'}):
    response(200,{...saved,deals:body.deals.map(r=>({...r,...(failure==='stale-value'?{f_notes:saved.deals.find(old=>old.id===r.id).f_notes}:{history:[]} )}))})});
  const el=h.cell();el.value='Final quote:4metres';h.emit('input',el);h.emit('focusout',el);await h.drain();
  assert.equal(h.calls.length,1);assert.equal(h.S.records[0].f_notes,'Send a 3 metre quote.');
  assert.equal(h.S.failedEdit.raw,'Final quote:4metres');assert.equal(h.node('saveStatus').textContent,'Unsaved edit retained');
  const restored=harness({storage:h.storage});restored.restoreFailedEdit();assert.equal(restored.S.failedEdit.raw,'Final quote:4metres');
  await h.retryFailedEdit();assert.equal(h.calls.length,1,'No automatic replay without fresh review');
});

test('invalid string is retained with no write; native badInput cannot become a blank save',async()=>{
  const h=harness(),el=h.cell('f_value');el.value='not numeric';h.emit('input',el);h.emit('blur',el);await h.drain();
  assert.equal(h.calls.length,0);assert.equal(h.S.failedEdit.raw,'not numeric');assert.equal(h.S.records[0].f_value,0);
  h.discardFailedEdit();const native=h.cell('f_value');native.value='';native.validity.badInput=true;
  h.emit('input',native);h.emit('blur',native);await h.drain();h.render();
  assert.equal(h.cell('f_value'),native);assert.equal(native.reported,true);assert.equal(h.inlineDirty(),true);assert.equal(h.calls.length,0);
});

test('a changed source cell recovers the draft instead of silently overwriting newer data',async()=>{
  const h=harness(),el=h.cell();el.value='My draft';h.emit('input',el);h.S.records[0].f_notes='Concurrent value';
  h.emit('blur',el);await h.drain();assert.equal(h.calls.length,0);assert.equal(h.S.failedEdit.raw,'My draft');
  assert.match(h.S.failedEdit.message,/changed while/);assert.equal(h.S.records[0].f_notes,'Concurrent value');
});

test('replayed acknowledgement followed by a stale read cannot claim the cell was saved',async()=>{
  const h=harness({handler:({options,body,saved})=>response(200,options.method==='PUT'?
    {...saved,deals:body.deals,replayed:true,actionReceipt:{actionId:'saved'}}:saved)});
  const el=h.cell();el.value='Changed quote';h.emit('input',el);h.emit('blur',el);await h.drain();
  assert.equal(h.calls.length,2);assert.equal(h.S.failedEdit?.raw,'Changed quote');
  assert.equal(h.node('saveStatus').textContent,'Unsaved edit retained');
});

test('generation change ignores old paste timers and late edit callbacks',async()=>{
  const h=harness(),el=h.cell();h.emit('paste',el);el.value='Previous user draft';h.emit('input',el);
  h.S.generation++;h.S.user={id:2,email:'next@example.invalid'};h.S.records[0].f_notes='Next user note';h.render();
  h.emit('blur',el);await h.drain();
  assert.equal(h.calls.length,0);assert.equal(h.inlineDirty(),false);assert.equal(h.cell().value,'Next user note');
});

test('reviewing an uncertain note save recognizes the saved value without a second activity entry',async()=>{
  let writes=0;
  const h=harness({handler:request=>{
    if(request.options.method==='PUT'){
      writes++;request.current={...request.saved,deals:request.body.deals,updatedAt:'v1'};
      return response(503,{error:'Acknowledgement lost'});
    }
    return response(200,request.current);
  }});
  const el=h.cell();el.value='Final quote:4metres';h.emit('input',el);h.emit('blur',el);await h.drain();
  assert.equal(h.S.failedEdit.raw,el.value);await h.reviewFailedEdit();await h.retryFailedEdit();
  assert.equal(writes,1);assert.equal(h.S.failedEdit,null);assert.equal(h.S.records[0].history.length,1);
  assert.equal(h.node('saveStatus').textContent,'Edit already saved');
});

test('Activity describes global history and keeps table selection on return, including date filtering',()=>{
  const h=harness();h.S.filter={where:[],ids:[1,3]};
  h.S.records[0].history=['2026-11-10T12:00:00Z | QA: Quote updated.'];
  h.S.records[1].history=['2026-11-09T12:00:00Z | QA: Harbor updated.'];
  h.S.records[2].history=['2026-11-10T13:00:00Z | QA: Meadow updated.'];
  const filter=JSON.stringify(h.S.filter);h.render();
  assert.equal(h.node('recordCount').textContent,'2 records');assert.match(h.node('filterText').textContent,/2 selected records/);
  h.setTab('activity');assert.equal(h.node('recordCount').textContent,'3 records / all records');
  assert.equal(h.node('viewSummary').textContent,'Activity / all records');assert.equal(h.node('filterStrip').hidden,true);
  assert.equal(h.node('activityCount').textContent,'3 entries / all records');assert.match(h.node('activityList').innerHTML,/Harbor/);
  h.node('activityFrom').value='2026-11-10';h.renderActivity();assert.equal(h.node('activityCount').textContent,'2 entries / all records');
  assert.doesNotMatch(h.node('activityList').innerHTML,/Harbor/);assert.equal(JSON.stringify(h.S.filter),filter);
  h.setTab('table');assert.equal(h.node('recordCount').textContent,'2 records');assert.equal(h.node('filterStrip').hidden,false);
  assert.equal(JSON.stringify(h.S.filter),filter);
});

test('KPI metadata describes each computed population; exports do not label all cards with the table scope',()=>{
  const h=harness(),cond={field:'f_deal',operator:'starts_with',value:'QA'};
  for(const [id,kpi] of [
    ['kpi_user_global',{title:'Mean <safe>',metric:'average',field:'f_value',conditions:[],where:[]}],
    ['kpi_user_rate',{title:'Prefix share',metric:'percentage',field:null,conditions:[],where:[[cond]],denominatorWhere:[]}],
    ['kpi_user_visible',{title:'Visible total',metric:'sum',field:'f_value',conditions:[]}]]){
    h.useSchema(Customize.addKpi(h.S.tableSchema,[],id,kpi).tableSchema);
  }
  h.S.filter={where:[],ids:[1]};h.renderDashboardKpis(h.visible());
  const html=h.node('.metrics').innerHTML;
  const attrs=id=>Object.fromEntries([...new RegExp('<div data-kpi-id="'+id+'"([^>]*)>').exec(html)[1].matchAll(/data-kpi-([\w-]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])]));
  const avg=attrs('kpi_user_global');assert.equal(avg.population,'all_authorized_records');assert.equal(avg['population-count'],'3');assert.equal(avg.count,'3');assert.equal(avg['numeric-count'],'2');
  const pct=attrs('kpi_user_rate');assert.equal(pct.metric,'percentage');assert.equal(pct['numerator-count'],'1');assert.equal(pct['denominator-count'],'3');assert.match(pct.scope,/Numerator:.*Deal.*starts with.*QA.*Denominator:/);
  const local=attrs('kpi_user_visible');assert.equal(local.population,'visible_records');assert.equal(local.count,'1');assert.match(local.scope,/1 selected records/);
  assert(!html.includes('Mean <safe>'));assert(html.includes('Mean &lt;safe&gt;'));
  h.S.report={version:1,title:'Count',chart:'bar',scope:'all',groupBy:'f_owner',bucket:'none',splitBy:null,where:[],sort:'label_asc',limit:null,measures:[{label:'Count',metric:'count',field:null,where:[]}]};
  assert.match(h.dashboardExportFilters()[0],/^Pipeline table context:.*1 selected records/);
  assert(h.dashboardExportFilters().every(text=>!text.includes('Top KPI cards')));
  const cards=[...html.matchAll(/<div (data-kpi-id="[^"]*"[^>]*)><span>([\s\S]*?)<\/span><strong>([\s\S]*?)<\/strong><\/div>/g)].map(match=>({
    dataset:Object.fromEntries([...match[1].matchAll(/data-([\w-]+)="([^"]*)"/g)].map(m=>[m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),decode(m[2])])),
    querySelector:selector=>({textContent:decode(selector==='span'?match[2]:match[3])})
  }));
  h.document.querySelectorAll=selector=>selector==='.metrics > div'?cards:[];
  for(const id of ['dashboardElements','chartContainer','reportKpis'])h.node(id).hidden=true;
  h.node('dashboardView').hidden=false;
  h.S.records[0].f_value=9900; // Export must copy the already-rendered evidence, not recalculate.
  const PDF=require('../public/dashboard-pdf'),snapshot=PDF.capture(h.document,h.dashboardExportFilters());
  assert.equal(snapshot.kpis.length,cards.length);
  const saved=snapshot.kpis.find(k=>k.label==='Mean <safe>');
  assert.equal(saved.value,'$100');assert.equal(saved.count,3);assert.equal(saved.numericCount,2);
  assert.equal(saved.population,'all_authorized_records');
  assert.equal(snapshot.kpis.find(k=>k.label==='Prefix share').denominatorCount,3);
  const pdf=JSON.stringify(PDF.definition(snapshot));
  assert.match(pdf,/3 matching records; 2 numeric values/);assert.match(pdf,/Numerator: 1 records; denominator: 3 records/);
  assert(!pdf.includes('Top KPI cards'));
});
