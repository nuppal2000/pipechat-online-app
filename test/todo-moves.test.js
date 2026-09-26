const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/todo-core');
const records=[{id:1,account:'Alpha'},{id:2,account:'Beta'}];
const cards=[{...T.create('todo_a',1),nextAction:'Call',notes:'Keep notes',dueDate:'2026-10-01'},
  {...T.create('todo_b',2),status:'In Progress',nextAction:'Email'},
  {...T.create('todo_c',null,'Standalone'),status:'Done'}];
const action=todoMoves=>({action:'move_todos',todoMoves});
test('bulk moves from mixed source lanes preserve every non-status value and all unselected cards',()=>{
  const before=structuredClone(cards),result=T.plan(cards,records,null,[],action([{todoId:'todo_a',todoStatus:'Done'},{todoId:'todo_b',todoStatus:'Done'}]));
  assert.equal(result.count,2);assert.deepEqual(result.cards,cards.map(c=>({...c,status:'Done'})));assert.deepEqual(cards,before);
  assert.deepEqual(result.moves.map(m=>m.before.status),['To Do','In Progress']);
  const mixed=T.plan(cards,records,null,[],action([{todoId:'todo_a',todoStatus:'In Progress'},{todoId:'todo_c',todoStatus:'To Do'}]));
  assert.equal(mixed.cards[1].status,'In Progress');assert.equal(mixed.cards[2].customTitle,'Standalone');
});
test('bulk move rejects the entire batch on invalid IDs, duplicates, lanes or extra edits',()=>{
  for(const bad of [{todoId:'missing',todoStatus:'Done'},{todoId:'todo_a',todoStatus:'Done'},{todoId:'todo_b',todoStatus:'Warm'},{todoId:'todo_b',todoStatus:'Done',notes:'overwrite'},null]){
    const before=structuredClone(cards);assert.throws(()=>T.plan(cards,records,null,[],action([{todoId:'todo_a',todoStatus:'Done'},bad])));assert.deepEqual(cards,before);
  }
  assert.throws(()=>T.plan(cards,records,null,[],{...action([{todoId:'todo_a',todoStatus:'Done'}]),todoNextAction:'overwrite'}));
  for(const items of [null,[],Array(2001).fill({todoId:'todo_a',todoStatus:'Done'})])assert.throws(()=>T.plan(cards,records,null,[],action(items)));
});
test('already-matching cards are no-ops, not duplicates or false moves',()=>{
  const result=T.plan(cards,records,null,[],action([{todoId:'todo_a',todoStatus:'Done'},{todoId:'todo_c',todoStatus:'Done'}]));assert.equal(result.count,1);
  assert.throws(()=>T.plan(cards,records,null,[],action([{todoId:'todo_c',todoStatus:'Done'}])),/already/);
});
