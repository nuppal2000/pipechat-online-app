'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const N=require('../public/notifications.js'),C=require('../public/pipeline-core.js'),H=require('../public/inspector-core.js');
const F=require('./fixtures/objective-query-acceptance.cjs');
const collect=(w,today)=>N.collect({records:w.records,cards:w.todoCards,core:C.create(w.tableSchema),customFields:w.customFields,today,history:H});
const groups=items=>Object.fromEntries(['overdue','today','upcoming','stale'].map(section=>[section,items.filter(item=>item.section===section).map(item=>item.key).sort()]));

test('controlled calendar: overdue, today and inclusive seven-day reminders exclude completed, orphan and invalid dates',()=>{
  const w=F.freeze(F.notifications()),before=JSON.stringify(w),items=collect(w,'2026-10-10');
  assert.deepEqual(groups(items),{
    overdue:['record:1:f_follow','task:todo_1'],today:['record:2:f_follow','task:todo_2','task:todo_standalone'],
    upcoming:['record:3:f_follow','record:4:f_follow','task:todo_3','task:todo_4'],stale:[]
  });
  assert.equal(items.length,9);assert.equal(new Set(items.map(item=>item.key)).size,9);
  assert.equal(items.find(item=>item.key==='task:todo_standalone').title,'Office');
  assert.equal(JSON.stringify(w),before);assert.deepEqual(collect(w,'2026-10-10'),items);
});

test('advancing the injected day recategorizes saved dates without changing their identities or saving anything',()=>{
  const w=F.freeze(F.notifications()),before=JSON.stringify(w),first=collect(w,'2026-10-10'),next=collect(w,'2026-10-11');
  assert.deepEqual(groups(next),{
    overdue:['record:1:f_follow','record:2:f_follow','task:todo_1','task:todo_2','task:todo_standalone'],
    today:['record:3:f_follow','task:todo_3'],upcoming:['record:4:f_follow','record:5:f_follow','task:todo_4','task:todo_5'],stale:[]
  });
  for(const item of first){const after=next.find(row=>row.key===item.key);assert(after);assert.equal(after.date,item.date);assert.equal(after.id,item.id);}
  assert.equal(JSON.stringify(w),before);assert.deepEqual(collect(w,'not-a-day'),[]);
});

test('saved task completion and reminder rescheduling remove only the affected notifications',()=>{
  const w=F.notifications(),before=collect(w,'2026-10-10');
  w.todoCards.find(card=>card.id==='todo_2').status='Done';w.records.find(row=>row.id===1).f_follow='2026-11-01';
  const after=collect(F.freeze(w),'2026-10-10');
  assert.deepEqual(after,before.filter(item=>!['task:todo_2','record:1:f_follow'].includes(item.key)));
  assert(after.some(item=>item.key==='record:2:f_follow'));assert(after.some(item=>item.key==='task:todo_1'));
});

test('staleness boundary uses saved activity only and future reminders suppress a stale warning',()=>{
  const w=F.notifications();w.todoCards=[];w.records=w.records.slice(0,4);
  w.records.forEach(row=>{row.f_follow='';row.history=[];});
  w.records[0].history=['2026-09-26T00:00:00Z | QA: Saved note.'];
  w.records[1].history=['2026-09-27T00:00:00Z | QA: Saved note.'];
  w.records[3].history=[...w.records[0].history];w.records[3].f_follow='2026-11-01';
  const items=collect(F.freeze(w),'2026-10-10');assert.deepEqual(items.map(item=>item.key),['stale:1']);assert.match(items[0].detail,/14 days/);
});
