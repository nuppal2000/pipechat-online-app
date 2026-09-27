const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/todo-core'),A=require('../public/todo-actions'),D=require('../lib/date-context');
const records=[{id:1,account:'Uppal Co'},{id:2,account:'Harbor Dental Group'},{id:3,account:'Brightpath Tutors'}];
const cards=[...records.map((r,i)=>({...T.create('todo_'+r.id,r.id),status:'In Progress',nextAction:['Contact Uppal','Brush my teeth','Hire a tutor'][i],notes:'Preserved '+i})),{...T.create('todo_done',1),status:'Done'}, {...T.create('todo_dated',1),dueDate:'2026-10-01'}];
const condition=(field,operator,value=null,values=[])=>({field,operator,value,values});
const select=(conditions=[],source='all',focusId=null,ids=[])=>({source,conditions,focusId,ids});
const update=(selection,changes)=>({action:'update_todos',updates:[{selection,changes}]});
const change=(field,value,operation='set')=>({field,value,operation});
test('original card question selects three exact IDs; follow-up date edits all three and no CRM cells',()=>{
  const selection=select([condition('status','not_equals','Done'),condition('dueDate','is_blank')]);
  const matches=A.select(cards,records,null,selection),focus=A.remember(matches,'reference-1');
  assert.equal(matches.length,3);assert.match(A.describe(matches,records,null),/3 matching/);assert.match(A.describe(matches,records,null),/Hire a tutor/);
  const before=structuredClone({cards,records}),due=D.dateContext('2026-09-26').nextWeekdays.Friday;
  const p=A.plan(cards,records,null,update(select([],'focus',focus.id),[change('dueDate',due)]),focus);
  assert.equal(p.count,3);assert(p.updates.every(x=>x.after.dueDate==='2026-10-02'&&x.after.status==='In Progress'));assert.deepEqual(p.cards.slice(3),cards.slice(3));assert.deepEqual({cards,records},before);
});
test('existing-lane criteria are selectors, not lane moves; dates, notes and To Do edits are independent',()=>{
  const selection=select([condition('status','equals','In Progress'),condition('dueDate','is_blank')]);
  const changes=[change('dueDate',D.dateContext('2026-09-26').nextWeekdays.Monday),change('notes','Extra','append'),change('nextAction','Review')];
  const p=A.plan(cards,records,null,update(selection,changes));assert.equal(p.count,3);
  p.updates.forEach(({before,after,fields})=>{assert.equal(after.status,'In Progress');assert.equal(after.dueDate,'2026-09-28');assert.equal(after.notes,before.notes+'\nExtra');assert.equal(after.nextAction,'Review');assert(!fields.includes('status'));});
});
test('focused membership stays fixed after due dates change, can narrow, and rejects missing/stale references',()=>{
  const focus=A.remember(cards.slice(0,3),'old'),p=A.plan(cards,records,null,update(select([],'focus','old'),[change('dueDate','2026-10-02')]),focus);
  assert.equal(A.plan(p.cards,records,null,update(select([],'focus','old'),[change('dueDate','')]),focus).count,3);
  assert.equal(A.select(p.cards,records,null,select([condition('title','equals','Uppal Co')],'focus','old'),focus).length,1);
  for(const bad of [null,{...focus,id:'new'},{...focus,ids:[...focus.ids,'todo_missing']},{...focus,ids:['todo_1','todo_1']}])assert.throws(()=>A.plan(cards,records,null,update(select([],'focus','old'),[change('notes','x')]),bad));
  assert.throws(()=>A.select(cards.filter(c=>c.id!=='todo_1'),records,null,select([],'focus','old'),focus),/no longer exists/);
});
test('bulk updates validate every later item before any mutation; overlapping fields and unsupported cells reject',()=>{
  const before=structuredClone(cards),valid=update(select([], 'ids',null,['todo_1']),[change('notes','Good')]);
  for(const bad of [change('dueDate','2026-02-30'),change('status','Qualified'),change('notes',1),change('recordId','3'),change('dueDate','2026-10-02','append')]){
    assert.throws(()=>A.plan(cards,records,null,{...valid,updates:[...valid.updates,{selection:select([],'ids',null,['todo_2']),changes:[bad]}]}));assert.deepEqual(cards,before);
  }
  assert.throws(()=>A.plan(cards,records,null,{...valid,updates:[...valid.updates,...valid.updates]}),/same card field/);
  const combined=A.plan(cards,records,null,{...valid,updates:[...valid.updates,{selection:valid.updates[0].selection,changes:[change('status','Done')]}]});assert.equal(combined.count,1);assert.equal(combined.cards[0].notes,'Good');assert.equal(combined.cards[0].status,'Done');
});
test('full-board membership, custom titles, duplicates on a record, no-ops and empty selections are safe',()=>{
  const many=Array.from({length:100},(_,i)=>({...T.create('todo_many_'+i,null,'Custom '+i),status:'In Progress'}));
  const p=A.plan(many,[],null,update(select([condition('status','in',null,['In Progress'])]),[change('dueDate','2026-10-05')]));assert.equal(p.count,100);assert.equal(p.cards.at(-1).customTitle,'Custom 99');
  assert.equal(A.select(cards,records,null,select([condition('title','equals','Uppal Co')])).length,3);
  const oneNoop=A.plan(cards,records,null,update(select([],'ids',null,['todo_1','todo_done']),[change('status','Done')]));assert.equal(oneNoop.selectedCount,2);assert.equal(oneNoop.count,1);
  assert.throws(()=>A.plan(cards,records,null,update(select([condition('notes','contains','missing')]),[change('notes','x')])),/No cards match/);
  assert.equal(A.select(cards,records,null,select([condition('notes','contains','missing')])).length,0);
  assert.throws(()=>A.plan(cards,records,null,update(select([],'ids',null,['todo_1']),[change('status','In Progress')])),/already has/);
});
test('no source confusion, malformed predicate or forged focus silently broadens selection',()=>{
  for(const selection of [{...select(),ids:['todo_1']},{...select(),focusId:'x'},select([],'ids'),select([condition('recordId','equals','1')]),select([condition('status','contains','In Progress|Done')]),select([condition('dueDate','before','tomorrow')]),select([condition('notes','is_blank','x')])])assert.throws(()=>A.select(cards,records,null,selection));
});

test('model selection variants bind focus references to the current request and cannot mix selection sources',()=>{
 const focus=A.remember(cards.slice(0,3),'current-focus-id');
 for(const schema of A.actionSchemas(focus)){
  const variants=(schema.properties.selection||schema.properties.updates.items.properties.selection).anyOf;
  assert.deepEqual(variants.map(v=>v.properties.source.enum[0]),['all','ids','focus']);
  const selected=variants[2].properties;
  assert.deepEqual(selected.focusId.enum,['current-focus-id']);assert.equal(selected.focusId.type,'string');assert.equal(selected.ids.maxItems,0);
  assert.equal(variants[0].properties.ids.maxItems,0);assert.equal(variants[1].properties.ids.minItems,1);
  assert(variants.slice(0,2).every(v=>v.properties.focusId.type==='null'));
 }
 for(const absent of [null,{kind:'report'},{kind:'todos',id:'',ids:[]},{kind:'todos',id:'x',ids:null}]){
  assert.equal(A.actionSchemas(absent)[0].properties.selection.anyOf.length,2);
 }
 const next=A.actionSchemas({...focus,id:'next-focus-id'})[0].properties.selection.anyOf[2];
 assert.deepEqual(next.properties.focusId.enum,['next-focus-id']);
});
