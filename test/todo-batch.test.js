const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/todo-core'),f=require('./fixtures/assistant-actions.cjs');
test('two and three separately linked To Do items preserve every task detail without CRM mutation',()=>{
  const input=structuredClone(f),existing=[T.create('todo_old',3)];
  for(const count of [2,3]){
    const action=structuredClone(f.todos);if(count===3)action.todos.push({...action.todos[0],recordMatch:'Beacon',todoNextAction:'Call Elena',todoDueDate:'2026-10-01'});
    const p=T.plan(existing,f.records,f.schema,[],action,'todo_batch');
    assert.equal(p.count,count);assert.equal(p.cards.length,count+1);assert.deepEqual(p.cards[0],existing[0]);assert.deepEqual(p.additions.map(c=>c.recordId),count===2?[2,1]:[2,1,3]);
    action.todos.forEach((item,i)=>{assert.equal(p.additions[i].nextAction,item.todoNextAction);assert.equal(p.additions[i].dueDate,item.todoDueDate);});
    assert.equal(new Set(p.cards.map(c=>c.id)).size,count+1);
  }
  assert.deepEqual(f,input);assert.deepEqual(existing,[T.create('todo_old',3)]);
  assert.equal(T.plan([],f.records,f.schema,[],{...f.todos,action:'add_todo'},'todo_legacy').count,2);
});
test('an ambiguous batch target retains all tasks and cannot partially create cards',()=>{
  const rows=[...f.records,{...f.records[0],id:4,f_deal:'Northstar Studio'}],p=T.plan([],rows,f.schema,[],f.todos,'todo_batch');
  assert.equal(p.cards,undefined);assert.equal(p.clarification.collection,'todos');assert.equal(p.clarification.changeIndex,1);assert.deepEqual(p.clarification.action,f.todos);assert.equal(p.clarification.candidates.length,2);
});
test('late invalid tasks, malformed batches and capacity failures reject the whole request',()=>{
  const before=structuredClone(f.records),question=e=>e.clarification===true;
  for(const patch of [{recordMatch:'Missing'},{todoDueDate:'2026-02-30'},{todoStatus:'Urgent'},{todoNotes:4},{field:'f_source',value:'injected'}]){
    const action=structuredClone(f.todos);Object.assign(action.todos[1],patch);assert.throws(()=>T.plan([],f.records,f.schema,[],action,'todo_bad'),question);
  }
  for(const todos of [null,[],Array(201).fill(f.todos.todos[0]),[null],[[]]])assert.throws(()=>T.plan([],f.records,f.schema,[],{action:'add_todos',todos},'todo_bad'),question);
  assert.throws(()=>T.plan([],f.records,f.schema,[],{...f.todos,ids:[1]},'todo_bad'),question);
  const cards=Array.from({length:1999},(_,i)=>T.create('todo_old_'+i,1));assert.throws(()=>T.plan(cards,f.records,f.schema,[],f.todos,'todo_cap'),question);assert.equal(cards.length,1999);assert.deepEqual(f.records,before);
});
