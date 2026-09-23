const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/todo-core.js'),C=require('../public/pipeline-core.js'),Schema=require('../public/table-schema.js');
const records=[{id:1,account:'Acme',owner:'Sarah',next:'Call client',follow:'Tomorrow',notes:'',history:[]},{id:2,account:'Beacon',owner:'Ravi',next:'Review',follow:'Next week',notes:'',history:[]}];
test('cards project the live primary, owner, next action and follow-up without duplicating CRM data',()=>{
  const card=T.create('todo_one',1,null),before=T.project(card,records,null);
  assert.equal(before.title,'Acme');assert.equal(before.owner,'Sarah');assert.equal(before.dueDate,'Tomorrow');
  const after=T.project(card,[{...records[0],account:'Acme renamed',follow:'Next week',next:'Send proposal',owner:'Ravi'}],null);
  assert.equal(after.title,'Acme renamed');assert.equal(after.dueDate,'Next week');assert.equal(after.nextAction,'Send proposal');assert.equal(after.owner,'Ravi');assert.equal(card.dueDate,'');
  assert.equal(T.project({...card,ownerField:null},records,null).owner,'');
});
test('dynamic and spreadsheet fields bind by roles or unique semantic labels; ambiguity stays unassigned',()=>{
  const fields=[{id:'f_name',name:'Candidate',type:'text',role:'primary',options:[]},{id:'f_next',name:'Next action',type:'text',role:'none',options:[]},{id:'f_due',name:'Follow up timing',type:'choice',role:'none',options:['Today','Tomorrow']},{id:'f_contact',name:'Contact name',type:'text',role:'none',options:[]}];
  const schema={status:'ready',useCase:'Recruiting',title:'Candidates',recordLabel:'candidate',description:'',fields};
  assert.deepEqual(T.bindings(schema),{nextField:'f_next',followField:'f_due',ownerField:'f_contact'});
  assert.equal(T.bindings({...schema,fields:[...fields,{id:'f_extra',name:'Next step',type:'text',role:'none',options:[]}]}).nextField,null);
});
test('AI card proposals do not write rows, resolve records and keep card changes separate',()=>{
  const p=T.plan([],records,null,[],{action:'add_todo',recordMatch:'Acme'},'todo_one');assert.equal(p.kind,'todo');assert.equal(p.after.followField,'follow');assert.equal(p.after.status,'To Do');
  const moved=T.plan(p.cards,records,null,[],{action:'update_todo',todoId:'todo_one',todoStatus:'Done'});assert.equal(moved.after.status,'Done');
  const override=T.plan(p.cards,records,null,[],{action:'update_todo',todoId:'todo_one',todoDueDate:'2026-10-01',todoNextAction:'Custom task'});assert.equal(override.after.followField,null);assert.equal(override.after.nextField,null);assert.equal(records[0].follow,'Tomorrow');
  assert.equal(T.plan(p.cards,records,null,[],{action:'delete_todo',todoId:'todo_one'}).cards.length,0);assert.equal(records.length,2);
  assert.throws(()=>T.plan([...p.cards,{...p.after,id:'todo_two'}],records,null,[],{action:'delete_todo',recordMatch:'Acme'}),/card ID/);
  const duplicates=[...records,{...records[0],id:3}];assert(T.plan(p.cards,duplicates,null,[],{action:'delete_todo',recordMatch:'Acme'}).clarification);
});
test('validation rejects unknown keys, missing records, duplicate IDs, bad bindings, dates and sizes',()=>{
  const card=T.create('todo_one',1,null);
  for(const patch of [{x:1},{recordId:7},{status:'Discovery'},{dueDate:'2026-02-30'},{dueDate:'tomorrow'},{nextAction:'x'.repeat(501)},{nextField:'value'},{ownerField:'missing'},{id:'<script>'}])assert.throws(()=>T.validate([{...card,...patch}],records,null));
  assert.throws(()=>T.validate([card,card],records,null));assert.throws(()=>T.validate(Array(2001).fill(card),records,null));
  assert.equal(T.validDate('2028-02-29'),true);assert.equal(T.validDate('2026-02-29'),false);
});
test('record and field deletion prune links, while restoring the full undo snapshot restores cards',()=>{
  const cards=[T.create('todo_one',1,null),T.create('todo_two',2,null)];
  assert.deepEqual(T.reconcile(cards,[records[1]],null),[cards[1]]);
  const schema=Schema.legacySchema();schema.fields=schema.fields.filter(f=>f.id!=='follow');
  assert.equal(T.reconcile(cards,records,schema)[0].followField,null);
  assert.deepEqual(T.reconcile(cards,records,null),cards);
  const promoted=C.create(null).deleteColumn(records,'account',[],{field:'owner'});
  assert.equal(T.project(T.reconcile(cards,promoted.records,promoted.tableSchema,promoted.customFields)[0],promoted.records,promoted.tableSchema,promoted.customFields).title,'Sarah');
});
test('urgent edits suggest without creating cards, suppress negatives and avoid duplicate open tasks',()=>{
  const edit=notes=>[{...records[0],notes},records[1]];
  for(const note of ['need to follow up','Must follow up with this account','Urgent: call'])assert.deepEqual(T.urgentChanges(records,edit(note),[],null),[1]);
  for(const note of ['No need to follow up','Do not follow up','Already completed; urgent item closed','Ordinary note'])assert.deepEqual(T.urgentChanges(records,edit(note),[],null),[]);
  const cards=[T.create('todo_one',1,null)];assert.deepEqual(T.urgentChanges(records,edit('must follow up'),cards,null),[]);
  assert.deepEqual(T.urgentChanges(records,edit('must follow up'),[{...cards[0],status:'Done'}],null),[1]);
  assert.deepEqual(T.urgentChanges(edit('must follow up'),edit('must follow up'),[],null),[]);
});
