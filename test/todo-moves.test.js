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

test('criteria select every matching card, including late matches and existing destination cards',()=>{
  const many=Array.from({length:35},(_,i)=>({...T.create('todo_'+i,1),nextAction:'Review '+i,notes:'Preserve '+i,status:i===34?'In Progress':'To Do',dueDate:i%2?'2026-10-01':''}));
  const select=conditions=>({action:'move_todos',todoMoves:null,todoSelection:{scope:'matching',destination:'In Progress',conditions}});
  const prefix=T.plan(many,records,null,[],select([{field:'nextAction',operator:'starts_with',value:'review '}]));
  assert.equal(prefix.count,34);assert(prefix.cards.every(c=>c.status==='In Progress'));assert.equal(prefix.cards[33].notes,'Preserve 33');
  const dated=T.plan(many,records,null,[],select([{field:'status',operator:'equals',value:'To Do'},{field:'dueDate',operator:'is_not_blank',value:null}]));
  assert.equal(dated.count,17);assert.equal(dated.cards[32].status,'To Do');
  const byTitle=T.plan(cards,records,null,[],select([{field:'title',operator:'equals',value:'Alpha'},{field:'dueDate',operator:'before',value:'2026-10-02'}]));assert.equal(byTitle.count,1);
  const all=T.plan(cards,records,null,[],{action:'move_todos',todoSelection:{scope:'all',destination:'Done',conditions:[]}});assert.equal(all.count,2);
});

test('selection refuses ambiguous/invalid scopes, conflicting IDs and unknown fields without changes',()=>{
  const selection={scope:'matching',destination:'Done',conditions:[{field:'notes',operator:'contains',value:'Keep'}]};
  for(const s of [{...selection,scope:'all'},{...selection,conditions:[]},{...selection,destination:'Warm'},{...selection,conditions:[{field:'password',operator:'equals',value:'x'}]},{...selection,conditions:[{field:'dueDate',operator:'before',value:'tomorrow'}]},{...selection,conditions:[{field:'notes',operator:'contains',value:''}]},{...selection,conditions:[{field:'notes',operator:'is_blank',value:'x'}]}])assert.throws(()=>T.plan(cards,records,null,[],{action:'move_todos',todoSelection:s}));
  assert.throws(()=>T.plan(cards,records,null,[],{...action([{todoId:'todo_a',todoStatus:'Done'}]),todoSelection:selection}),/not both/);
  assert.throws(()=>T.plan(cards,records,null,[],{action:'move_todos',todoSelection:{...selection,conditions:[{field:'title',operator:'equals',value:'Unknown'}]}}),/No cards match/);
});
