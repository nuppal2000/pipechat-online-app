'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const Core=require('../public/pipeline-core'),Schema=require('../public/table-schema'),Todo=require('../public/todo-core');
const Inspector=require('../public/inspector-core'),Plan=require('../public/workspace-plan');
const F=require('./fixtures/workspace-plans.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));
const day='2026-11-13';
const note=(id,text,at=day+'T15:00:00.000Z')=>JSON.stringify({pipechatHistory:1,type:'note',id,actor:'qa@example.invalid',at,text});
const event=(text,at=day+'T16:00:00.000Z')=>`${at} | qa@example.invalid: ${text}`;
const read=(extra={})=>({op:'read_history',id:'history',label:'Requested Activity',selection:'selected',kind:'all',from:day,to:day,limit:100,...extra});
function workspace(){
  const w=F.workspace();
  w.records=w.records.slice(0,3);
  Object.assign(w.records[0],{f_deal:'QA1113 Copper Books',history:[
    note('copper','Copper note <img src=x onerror=alert(1)>'),
    event('Priority changed from "Low" to "High".'),
    note('older','Copper previous-day note','2026-11-12T15:00:00.000Z'),
    'Undated Copper activity']});
  Object.assign(w.records[1],{f_deal:'QA1110 River Kiosk',history:[
    note('river','River note',day+'T17:00:00.000Z'),
    event('Owner changed from "Alex" to "Sam".',day+'T14:00:00.000Z'),
    note('later','River next-day note','2026-11-14T15:00:00.000Z')]});
  Object.assign(w.records[2],{f_deal:'Unrelated Account',history:[note('other','Unrelated same-day note')]});
  w.todoCards=[{id:'kept-task',recordId:3,status:'To Do',nextAction:'Keep task',notes:'Keep notes',dueDate:'2026-12-01'}];
  return w;
}
const action=(extra={},where=[[F.where('f_deal','in',null,['QA1113 Copper Books','QA1110 River Kiosk'])]])=>
  F.plan([F.select('selected',where),read(extra)]);
const prepare=(a,w=workspace(),extra={})=>Plan.prepare(w,a,{nonce:'activity_test',today:day,timezone:'UTC',...extra});

// Exercise the actual application closure and Activity event handlers. Stub only
// unrelated rendering/startup/network side effects, not Activity selection logic.
function ui(w=workspace()){
  const nodes=new Map(),messages=[],calls=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,innerHTML:'',classList:{add(){},remove(){}}});return nodes.get(id);};
  const source=fs.readFileSync(require.resolve('../public/pipechat'),'utf8').replace(/\r\n/g,'\n');
  const startup='  wire();\n  restoreSession();';assert(source.includes(startup));
  const start=source.indexOf("    for(const id of ['activityFrom','activityTo'])");
  const end=source.indexOf('\n    wireColumnDrag();',start);assert(start>=0&&end>start,'Activity handlers must be present');
  const handlers=source.slice(start,end);
  const window={PipelineCore:Core,PipeChatSchema:Schema,PipeChatTodo:Todo,PipeChatInspector:Inspector,PipeChatIcons:{}};
  const hook=`render=()=>{if(S.tab==='activity')renderActivity();};renderTrust=()=>{};say=text=>messages.push(text);saveChatState=()=>{};
    api=(...args)=>{calls.push(args);throw new Error('Activity presentation must not call the CRM API');};
    ${handlers}
    window.test={S,useSchema,publishPlanResults,renderActivity,clearActivity};`;
  vm.runInNewContext(source.replace(startup,hook),{window,document:{getElementById:node},messages,calls,crypto,Intl,Date,TextEncoder,setTimeout,clearTimeout});
  const h=window.test;h.useSchema(w.tableSchema);
  Object.assign(h.S,{loaded:true,user:{id:'qa',name:'QA'},records:w.records,customFields:w.customFields,todoCards:w.todoCards,
    updatedAt:'version-1',generation:1,tab:'dashboard',dashboard:{version:1,elements:[],sharedFilters:[],activeId:null},
    filter:{ids:[3],where:[]},search:'prior search',scope:'mine',sort:{field:'f_value',direction:'desc'}});
  return {...h,node,messages,calls};
}
const savedState=h=>plain({records:h.S.records,tableSchema:h.S.tableSchema,customFields:h.S.customFields,todoCards:h.S.todoCards,
  updatedAt:h.S.updatedAt,dashboard:h.S.dashboard,filter:h.S.filter,search:h.S.search,scope:h.S.scope,sort:h.S.sort});
const idsFromMarkup=h=>[...h.node('activityList').innerHTML.matchAll(/data-inspect="(\d+)"/g)].map(match=>Number(match[1]));

test('explicit Activity presentation carries exact selected IDs, dates and kind without any CRM mutation',()=>{
  const w=workspace(),before=structuredClone(w),a=action({showActivity:true}),p=prepare(a,w);
  assert.equal(p.mutates,false);assert.deepEqual(w,before);
  assert.deepEqual(p.next.records,before.records);assert.deepEqual(p.next.todoCards,before.todoCards);
  assert.deepEqual(p.effects,[{kind:'activity',ids:[1,2],from:day,to:day,historyKind:'all'}]);
  assert.equal(p.queryResults[0].viewEffect,'show_activity');assert.deepEqual(p.queryResults[0].recordIds,[1,2]);
  const result=p.queryResults[0].history;assert.equal(result.total,4);
  assert.deepEqual(result.entries.map(entry=>entry.recordId),[2,1,1,2]);
  assert(result.entries.every(entry=>entry.at.startsWith(day)));
  assert.match(p.answers[0],/Copper note/);assert.match(p.answers[0],/River note/);
  assert.doesNotMatch(p.answers[0],/Unrelated same-day|previous-day|next-day|Undated Copper/);
  for(const name of ['patches','addedFields','schemaChanges','addedCards','taskPatches'])assert.deepEqual(p[name],[]);
});

test('legacy missing showActivity and explicit false remain chat-only and leave the current view untouched',()=>{
  for(const extra of [{},{showActivity:false}]){
    const w=workspace(),p=prepare(action(extra),w),h=ui(w),before=savedState(h);
    assert.equal(p.queryResults[0].viewEffect,'answer_only');
    assert.deepEqual(p.effects,[{kind:'table',show:false,ids:[1,2]}]);
    h.node('activityFrom').value='2026-01-01';h.node('activityTo').value='2026-12-31';
    h.publishPlanResults(p);
    assert.equal(h.S.tab,'dashboard');assert.equal(h.node('activityFrom').value,'2026-01-01');
    assert.equal(h.node('activityTo').value,'2026-12-31');assert.equal(h.node('activityList').innerHTML,'');
    assert.equal(h.messages.length,1);assert.match(h.messages[0],/Saved history: 4 entries/);
    assert.deepEqual(savedState(h),before);assert.equal(h.calls.length,0);
  }
});

test('each history kind is applied to both canonical answers and the actual rendered Activity list',()=>{
  for(const [kind,total] of [['all',4],['note',2],['activity',2]]){
    const w=workspace(),p=prepare(action({kind,showActivity:true}),w),h=ui(w),before=savedState(h);
    h.publishPlanResults(p);
    assert.equal(h.S.tab,'activity');assert.equal(h.node('activityFrom').value,day);assert.equal(h.node('activityTo').value,day);
    assert.equal(h.node('activityRecordScope').hidden,false);
    assert.equal(h.node('activityRecordNames').textContent,'QA1113 Copper Books, QA1110 River Kiosk');
    assert.equal(h.node('activityCount').textContent,`${total} entries / 2 selected records`);
    assert.equal(idsFromMarkup(h).length,total);assert.deepEqual([...new Set(idsFromMarkup(h))].sort(),[1,2]);
    assert.equal(h.node('filterStrip').hidden,true);
    assert.equal(p.queryResults[0].history.total,total);
    if(kind==='note')assert.doesNotMatch(h.node('activityList').innerHTML,/Priority changed|Owner changed/);
    if(kind==='activity')assert.doesNotMatch(h.node('activityList').innerHTML,/Copper note|River note/);
    if(kind!=='activity'){
      assert.match(h.node('activityList').innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.doesNotMatch(h.node('activityList').innerHTML,/<img/);
    }
    assert.deepEqual(savedState(h),before);assert.equal(h.calls.length,0);
  }
});

test('an empty matched cohort never broadens to all Activity records',()=>{
  const w=workspace(),h=ui(w),p=prepare(action({showActivity:true},[[F.where('f_deal','equals','No such account')]]),w);
  assert.deepEqual(p.effects[0].ids,[]);h.publishPlanResults(p);
  assert.equal(h.S.tab,'activity');assert.equal(h.node('activityRecordScope').hidden,false);
  assert.equal(h.node('activityCount').textContent,'0 entries / 0 selected records');
  assert.deepEqual(idsFromMarkup(h),[]);assert.match(h.node('activityList').innerHTML,/No activity/);
});

test('date reset preserves selected records and kind; clear-record filter preserves the dates and resets kind',()=>{
  const w=workspace(),h=ui(w),before=savedState(h);
  h.publishPlanResults(prepare(action({showActivity:true,kind:'note'}),w));
  h.node('activityResetDates').onclick();
  assert.equal(h.node('activityFrom').value,'');assert.equal(h.node('activityTo').value,'');
  assert.equal(h.node('activityCount').textContent,'4 entries / 2 selected records');
  assert.match(h.node('activityList').innerHTML,/previous-day|next-day/);
  assert.doesNotMatch(h.node('activityList').innerHTML,/Unrelated|Priority changed|Owner changed|Undated/);
  h.node('activityFrom').value=day;h.node('activityFrom').onchange();
  h.node('activityTo').value=day;h.node('activityTo').onchange();
  assert.equal(h.node('activityCount').textContent,'2 entries / 2 selected records');
  h.node('activityClearRecords').onclick();
  assert.equal(h.node('activityFrom').value,day);assert.equal(h.node('activityTo').value,day);
  assert.equal(h.node('activityRecordScope').hidden,true);
  assert.equal(h.node('activityCount').textContent,'5 entries / all records');
  assert.match(h.node('activityList').innerHTML,/Unrelated same-day note|Priority changed/);
  assert.deepEqual(savedState(h),before);assert.equal(h.calls.length,0);
});

test('a second request replaces scope instead of intersecting with earlier record, date, or table filters',()=>{
  const w=workspace(),h=ui(w),before=savedState(h);
  h.publishPlanResults(prepare(action({showActivity:true,kind:'activity'}),w));
  const next=action({showActivity:true,kind:'note',from:null,to:null},[[F.where('f_deal','equals','Unrelated Account')]]);
  h.publishPlanResults(prepare(next,w));
  assert.deepEqual(idsFromMarkup(h),[3]);assert.equal(h.node('activityRecordNames').textContent,'Unrelated Account');
  assert.equal(h.node('activityFrom').value,'');assert.equal(h.node('activityTo').value,'');
  assert.equal(h.node('activityCount').textContent,'1 entry / 1 selected records');
  assert.deepEqual(savedState(h),before);
});

test('Activity pagination stays scoped and changing a date resets the visible page size',()=>{
  const w=workspace();w.records[0].history=Array.from({length:170},(_,i)=>note('note-'+i,'Selected note '+i));
  const h=ui(w),p=prepare(action({showActivity:true,kind:'note',limit:2},[[F.where('f_deal','equals','QA1113 Copper Books')]]),w);
  assert.equal(p.queryResults[0].history.entries.length,2);assert.equal(p.queryResults[0].history.omitted,168);
  h.publishPlanResults(p);
  assert.equal(idsFromMarkup(h).length,150);assert(idsFromMarkup(h).every(id=>id===1));
  assert.equal(h.node('activityMore').hidden,false);assert.equal(h.node('activityCount').textContent,'170 entries / 1 selected records');
  h.node('activityMore').onclick();assert.equal(idsFromMarkup(h).length,170);assert.equal(h.node('activityMore').hidden,true);
  h.node('activityFrom').onchange();assert.equal(idsFromMarkup(h).length,150);assert.equal(h.node('activityMore').hidden,false);
  assert.doesNotMatch(h.node('activityList').innerHTML,/River note|Unrelated same-day/);
});

test('invalid dates show a UI error instead of widening the scope; account reset clears old Activity filters',()=>{
  const w=workspace(),h=ui(w),before=savedState(h);
  h.publishPlanResults(prepare(action({showActivity:true}),w));
  h.node('activityFrom').value='2026-11-14';h.node('activityFrom').onchange();
  assert.match(h.node('activityList').innerHTML,/role="alert"/);assert.deepEqual(idsFromMarkup(h),[]);
  assert.equal(h.node('activityMore').hidden,true);assert.equal(h.node('activityRecordScope').hidden,false);
  h.clearActivity();h.renderActivity();
  assert.equal(h.node('activityFrom').value,'');assert.equal(h.node('activityTo').value,'');
  assert.equal(h.node('activityRecordScope').hidden,true);assert.match(h.node('activityCount').textContent,/all records/);
  assert.match(h.node('activityList').innerHTML,/Unrelated same-day|Undated Copper/);
  assert.deepEqual(savedState(h),before);assert.equal(h.calls.length,0);
});

test('server history scope honors inclusive local calendar bounds rather than UTC date prefixes',()=>{
  const w=workspace();w.records[0].history=[
    note('previous','Previous local day',day+'T04:59:59.000Z'),
    note('start','Start boundary',day+'T05:00:00.000Z'),
    note('end','End boundary','2026-11-14T04:59:59.999Z'),
    note('next','Next local day','2026-11-14T05:00:00.000Z')];
  const p=prepare(action({showActivity:true,kind:'note'},[[F.where('f_deal','equals','QA1113 Copper Books')]]),w,{timezone:'America/New_York'});
  assert.deepEqual(p.queryResults[0].history.entries.map(entry=>entry.text),['End boundary','Start boundary']);
  assert.deepEqual(p.effects[0],{kind:'activity',ids:[1],from:day,to:day,historyKind:'note'});
});

test('malformed display flags or dates reject the plan without partial state changes',()=>{
  const w=workspace(),before=structuredClone(w);
  for(const extra of [{showActivity:'true'},{showActivity:1},{showActivity:null},{showActivity:[]},
    {showActivity:true,from:'2026-02-30'},{showActivity:true,from:'2026-11-14',to:day},{showActivity:true,kind:'everything'}])
    assert.throws(()=>prepare(action(extra),w));
  assert.deepEqual(w,before);
  const schema=Plan.responseSchema(Core.create(w.tableSchema),w.customFields);
  const readSchema=schema.properties.steps.items.anyOf.find(step=>step.properties.op.enum.includes('read_history'));
  assert.equal(readSchema.properties.showActivity.type,'boolean');
});

test('Activity HTML exposes independent date controls and a scoped-record clear control',()=>{
  const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
  for(const id of ['activityView','activityFrom','activityTo','activityResetDates','activityRecordScope','activityRecordNames','activityClearRecords','activityCount','activityList','activityMore'])
    assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id);
  assert.match(html,/id="activityClearRecords"[^>]*aria-label="Clear activity record filter"/);
  assert.match(html,/id="activityResetDates"[^>]*aria-label="Reset activity dates"/);
  assert.match(html,/id="activityCount"[^>]*role="status"/);
});
