const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/todo-core'),Schema=require('../public/table-schema');
const schema=Schema.legacySchema(),rows=[{id:1,account:'Avery Chen'},{id:2,account:'Morgan Lee'},{id:3,account:'Avery Chen'}];
test('standalone cards validate, project, survive CRM deletion and accept AI card-only edits',()=>{
  const card=T.create('todo_custom',null,'Prepare weekly review');
  assert.deepEqual(T.validate([card],[]),[card]);
  assert.equal(T.project(card,[],schema).title,card.customTitle);
  assert.deepEqual(T.reconcile([card,T.create('todo_linked',1)],[]),[card]);
  assert.deepEqual(T.migrate([card],[]),[card]);
  const p=T.plan([card],[],schema,[],{action:'update_todo',todoId:card.id,todoStatus:'Done',todoNotes:'Ready'},'unused');
  assert.equal(p.after.status,'Done');assert.equal(p.after.recordId,null);assert.equal(p.after.customTitle,card.customTitle);
  assert.deepEqual(T.plan([card],[],schema,[],{action:'delete_todo',todoId:card.id},'unused').cards,[]);
});
test('standalone title contract rejects missing, blank, oversized, hybrid and injected fields',()=>{
  const card=T.create('todo_custom',null,'Review');
  for(const patch of [{customTitle:''},{customTitle:' \n\t\u00a0\ufeff'},{customTitle:'x'.repeat(501)},{customTitle:'bad\x01'},{customTitle:null},{recordId:1},{recordId:'1'},{extra:true}])assert.throws(()=>T.validate([{...card,...patch}],rows));
  const missing={...card};delete missing.customTitle;assert.throws(()=>T.validate([missing],rows));
  assert.equal(Object.keys(T.validate([T.create('todo_linked',1)],rows)[0]).length,6);
});
test('record search is case-insensitive, keeps stable IDs and retains an explicit selection',()=>{
  assert.deepEqual(T.recordOptions(rows,schema,'AVERY','').map(r=>r.id),[1,3]);
  assert.deepEqual(T.recordOptions(rows,schema,'absent',''),[]);
  assert.deepEqual(T.recordOptions(rows,schema,'absent','2').map(r=>r.id),[2]);
  assert.deepEqual(T.recordOptions(rows,schema,'3','').map(r=>r.id),[3]);
});
