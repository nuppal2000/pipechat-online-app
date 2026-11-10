const test=require('node:test'),assert=require('node:assert/strict');
const N=require('../public/notifications'),Core=require('../public/pipeline-core'),H=require('../public/inspector-core'),T=require('../public/todo-core');
const core=Core.create(null),today='2026-10-04';
const row=(id,follow='',stage='Warm',history=[])=>({id,account:'Account '+id,follow,stage,history});
const collect=(records,cards=[],extra={})=>N.collect({records,cards,core,today,history:H,...extra});
test('saved dates categorize follow-ups and tasks without mutating data or showing completed records',()=>{
  const rows=[row(1,'2026-10-03'),row(2,'2026-10-04'),row(3,'2026-10-10'),row(4,'2026-10-12'),row(5,'2026-10-02','Closed Won')];
  const cards=[{...T.create('todo_a',1),nextAction:'Call',dueDate:today},{...T.create('todo_b',2),status:'Done',dueDate:'2026-10-01'}],before=JSON.stringify([rows,cards]);
  const items=collect(rows,cards);assert.deepEqual(items.map(i=>i.section),['overdue','today','today','upcoming']);assert.equal(items.length,4);assert.equal(JSON.stringify([rows,cards]),before);
  cards[0].status='Done';rows[0].follow='2026-10-20';assert.equal(collect(rows,cards).length,2);
});
test('dynamic primary fields, extra reminder dates and standalone tasks retain identity',()=>{
  const schema={status:'ready',useCase:'Recruiting',title:'Candidates',recordLabel:'candidate',description:'',fields:[{id:'f_name',name:'Candidate',type:'text',role:'primary',options:[]},{id:'f_when',name:'Interview Date',type:'date',role:'none',options:[]},{id:'f_join',name:'Last Contacted',type:'date',role:'none',options:[]}]};
  const c=Core.create(schema),rows=[{id:1,f_name:'Maya',f_when:today,f_join:'2026-01-01',history:[]}],cards=[{...T.create('todo_custom',null,'Office'),dueDate:today}];
  const items=collect(rows,cards,{core:c});assert.equal(items.length,2);assert(items.some(i=>i.title==='Maya'&&i.detail==='Interview Date'));assert(items.some(i=>i.title==='Office'));assert(!items.some(i=>i.detail==='Last Contacted'));
});
test('staleness uses dated history or last contact, never invents age for new imports',()=>{
  const stamp='2026-09-01T12:00:00Z | QA: Value changed from "1" to "2".';
  const items=collect([row(1,'','Warm',[stamp]),row(2),row(3,'2026-10-12','Warm',[stamp]),row(4,'','Lost',[stamp])]);
  assert.equal(items.length,1);assert.equal(items[0].id,1);assert.equal(items[0].section,'stale');
});
test('F07 stale records describe active overdue tasks instead of claiming no dated reminder',()=>{
  const date='2026-11-10',stamp='2026-10-21T00:00:00Z | QA: Saved note.';
  const rows=['QA Acorn Supplies','Brightpath','Uppal'].map((account,i)=>({...row(i+1,'','Warm',[stamp]),account}));
  const cards=rows.map(r=>({...T.create('todo_'+r.id,r.id),status:'In Progress',nextAction:'Send proposal',dueDate:'2026-10-20'}));
  const before=JSON.stringify([rows,cards]),items=collect(rows,cards,{today:date});
  assert.equal(items.filter(i=>i.section==='overdue').length,3);
  for(const r of rows){
    const stale=items.find(i=>i.key==='stale:'+r.id);
    assert.equal(stale.title,r.account);assert.equal(stale.kind,'record');assert.equal(stale.date,'2026-10-21');
    assert.match(stale.detail,/20 days; overdue task: Send proposal \(due 2026-10-20\)/);
    assert.doesNotMatch(stale.detail,/no dated reminder/);
  }
  assert.equal(JSON.stringify([rows,cards]),before);
});
test('stale activity distinguishes active overdue, today, future and genuinely undated tasks',()=>{
  const stamp='2026-09-01T00:00:00Z | QA: Saved note.',rows=[row(1,'','Warm',[stamp])];
  for(const [date,status,stale,section] of [
    ['2026-10-03','To Do',true,'overdue'],[today,'In Progress',false,'today'],
    ['2026-10-11','To Do',false,'upcoming'],['2026-12-01','In Progress',false,null],
    ['2026-10-03','Done',true,null],['2026-12-01','Done',true,null],
    ['','In Progress',true,null],['next week','To Do',true,null],['2026-02-30','To Do',true,null]
  ]){
    const card={...T.create('todo_reminder',1),nextAction:'Follow up',dueDate:date,status},items=collect(rows,[card]);
    const notice=items.find(i=>i.section==='stale'),task=items.find(i=>i.kind==='task');
    assert.equal(Boolean(notice),stale,date+' '+status);assert.equal(task?.section??null,section,date+' '+status);
    if(notice)assert.equal(notice.detail.includes('no dated reminder'),section!=='overdue',date+' '+status);
  }
});
test('linked reminder identity, earliest overdue date and completion remain independent of task ordering',()=>{
  const rows=[{...row(1,'','Warm',['2026-09-01T00:00:00Z | QA: Saved note.']),account:'Same'},
    {...row(2,'','Warm',['2026-09-01T00:00:00Z | QA: Saved note.']),account:'Same'}];
  const cards=[
    {...T.create('todo_later',1),nextAction:'Second call',dueDate:'2026-10-03'},
    {...T.create('todo_first',1),status:'In Progress',nextAction:'First call',dueDate:'2026-10-01'},
    {...T.create('todo_done',1),status:'Done',dueDate:'2026-12-01'},
    {...T.create('todo_standalone',null,'Office'),dueDate:'2026-12-01'},
    {...T.create('todo_deleted',99),dueDate:today}
  ];
  const items=collect(rows,cards),stale=items.find(i=>i.key==='stale:1');
  assert.match(stale.detail,/First call \(due 2026-10-01\)/);assert.match(stale.detail,/1 more overdue task/);
  assert.match(items.find(i=>i.key==='stale:2').detail,/no dated reminder/);
  assert.deepEqual(collect(rows,cards.toReversed()),items);
  cards[1].status='Done';assert.match(collect(rows,cards).find(i=>i.key==='stale:1').detail,/Second call/);
  cards[0].dueDate=today;assert(!collect(rows,cards).some(i=>i.key==='stale:1'));
  cards[0].status='Done';assert.match(collect(rows,cards).find(i=>i.key==='stale:1').detail,/no dated reminder/);
});
test('an upcoming linked task suppresses stale activity without hiding older overdue tasks or changing record reminders',()=>{
  const rows=[row(1,'','Warm',['2026-09-01T00:00:00Z | QA: Saved note.'])];
  const cards=[{...T.create('todo_old',1),dueDate:'2026-10-01'},
    {...T.create('todo_next',1),status:'In Progress',dueDate:'2026-12-01'}];
  assert.deepEqual(collect(rows,cards).map(i=>i.key),['task:todo_old']);
  for(const follow of ['2026-10-01',today,'2026-10-11','2026-12-01']){
    rows[0].follow=follow;
    assert(!collect(rows,[cards[0]]).some(i=>i.section==='stale'),follow);
  }
  rows[0].follow='';rows[0].stage='Done';
  assert.deepEqual(collect(rows,[cards[0]]).map(i=>i.key),['task:todo_old']);
});
test('invalid or imprecise dates are not fabricated; local calendar dates survive timezone boundaries',()=>{
  assert.equal(N.day('2026-02-30'),null);assert.equal(N.day(''),null);
  assert.equal(N.due('next week',today),null);assert.equal(N.due('Today',today),N.day(today));
  const items=collect([row(1,'Tomorrow'),row(2,'2026-02-30'),row(3,'next week')]);assert.equal(items.length,1);assert.equal(items[0].date,'2026-10-05');
  assert.equal(collect([row(1,today)],[],{today:'bad'}).length,0);
});
test('deleting a linked record removes its notification while duplicate names remain separate',()=>{
  const rows=[{...row(1,today),account:'Same'},{...row(2,today),account:'Same'}],cards=[{...T.create('todo_deleted',3),dueDate:today}];
  assert.deepEqual(collect(rows,cards).map(i=>i.id),[1,2]);
});
test('server attention windows agree with Notifications at boundaries and never double-count today',()=>{
  const {dateContext}=require('../lib/date-context');
  for(const date of ['2026-10-10','2026-12-31','2024-02-28','2026-03-08','2026-11-01']){
    const windows=dateContext(date).attentionWindows;
    assert.deepEqual(windows,N.windows(date));
    const rows=[];for(let offset=-1;offset<=8;offset++)rows.push(row(offset+2,new Date(N.day(date)+offset*86400000).toISOString().slice(0,10)));
    const items=collect(rows,[],{today:date});
    assert.equal(items.filter(item=>item.section==='overdue').length,1);
    assert.equal(items.filter(item=>item.section==='today').length,1);
    const future=items.filter(item=>item.section==='upcoming');assert.equal(future.length,7);
    assert(future.every(item=>item.date>=windows.nextSevenDays.from&&item.date<=windows.nextSevenDays.through&&item.date>date));
    assert.equal(new Set(items.map(item=>item.key)).size,items.length);
  }
});
