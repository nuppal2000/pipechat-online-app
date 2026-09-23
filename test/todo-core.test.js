const test=require('node:test'),assert=require('node:assert/strict'),T=require('../public/todo-core.js');
const rows=[{id:1,account:'Acme',owner:'Sarah',next:'CRM action',follow:'Tomorrow',notes:'Private CRM notes'}];
const card={...T.create('todo_one',1),nextAction:'Call client',notes:'Ask about timing',dueDate:'2026-10-01'};
test('only the primary name projects from CRM; all other card data is independent',()=>{
  const before=structuredClone(rows);const view=T.project(card,rows,null);
  assert.deepEqual(view,{...card,title:'Acme'});assert.deepEqual(rows,before);
  const changed=[{...rows[0],account:'New name',owner:'Ravi',next:'Changed',follow:'Next month',notes:'Different'}];
  assert.deepEqual(T.project(card,changed,null),{...card,title:'New name'});assert.deepEqual(T.reconcile([card],changed),[card]);
});
test('new cards are blank; AI proposals change only card fields',()=>{
  const add=T.plan([],rows,null,[],{action:'add_todo',ids:[1]},'todo_new');assert.deepEqual(add.after,T.create('todo_new',1));
  const update=T.plan([card],rows,null,[],{action:'update_todo',todoId:card.id,todoNotes:'New notes',todoNextAction:'Email',todoDueDate:'2026-10-05',todoStatus:'Done'});
  assert.deepEqual(update.after,{...card,notes:'New notes',nextAction:'Email',dueDate:'2026-10-05',status:'Done'});
  assert.equal(rows[0].next,'CRM action');assert.equal(card.notes,'Ask about timing');
  assert.equal(T.plan([card],rows,null,[],{action:'delete_todo',todoId:card.id}).cards.length,0);
});
test('ambiguous record/card selection cannot silently choose a task',()=>{
  assert.throws(()=>T.plan([card,{...card,id:'todo_two'}],rows,null,[],{action:'update_todo',ids:[1],todoStatus:'Done'}),/card ID/);
  assert.throws(()=>T.plan([],rows,null,[],{action:'add_todo',ids:[999]},'todo_new'));
});
test('validation rejects old bindings, invalid dates, oversized notes and missing record links',()=>{
  for(const patch of [{nextField:'next'},{recordId:999},{status:'Other'},{dueDate:'2026-02-30'},{dueDate:'Tomorrow'},{nextAction:'x'.repeat(12001)},{notes:'x'.repeat(16001)},{notes:'\0'}])assert.throws(()=>T.validate([{...card,...patch}],rows));
  assert.throws(()=>T.validate([card,card],rows));assert.throws(()=>T.validate(Array(2001).fill(card),rows));
  assert.equal(T.validate([{...card,notes:'line one\nline two'}],rows)[0].notes,'line one\nline two');
});
test('record deletion prunes every associated card; field deletion leaves cards unchanged',()=>{
  assert.deepEqual(T.reconcile([card,{...card,id:'todo_two'}],[]),[]);assert.deepEqual(T.reconcile([card],[{id:1,account:'Acme'}]),[card]);
});
test('legacy migration freezes displayed text and preserves ambiguous due information without guessing dates',()=>{
  const old={id:'todo_old',recordId:1,status:'To Do',nextAction:'Fallback',dueDate:'',nextField:'next',followField:'follow',ownerField:'owner'};
  const migrated=T.migrate([old],rows)[0];assert.equal(migrated.nextAction,'CRM action');assert.equal(migrated.dueDate,'');assert.equal(migrated.notes,'Previous due information: Tomorrow');
  assert.equal(T.migrate([old],[{...rows[0],follow:'2026-10-02'}])[0].dueDate,'2026-10-02');
  assert.deepEqual(T.migrate([card],rows),[card]);assert.deepEqual(T.migrate([old],[]),[]);
});
