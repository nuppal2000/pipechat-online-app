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
