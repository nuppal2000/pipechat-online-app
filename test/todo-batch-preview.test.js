const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const T=require('../public/todo-core'),fixture=require('./fixtures/assistant-actions.cjs');

test('bulk card edits show every before/after field, selected count and one confirmation',()=>{
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){}});return nodes.get(id);};
  const window={PipeChatTodo:T,addEventListener(){}};vm.runInNewContext(fs.readFileSync(require.resolve('../public/todo-ui'),'utf8'),{window,document:{getElementById:node}});
  const S={records:fixture.records,tableSchema:fixture.schema,todoCards:fixture.records.map(r=>({...T.create('todo_'+r.id,r.id),status:'In Progress',nextAction:'Call '+r.id,notes:'old'})),saving:false};
  const ui=window.PipeChatTodoUI.create({S,esc:v=>String(v).replaceAll('<','&lt;').replaceAll('>','&gt;'),icon:()=>'',persistTodo(){},prepare(){},render(){},toast(){},localDate:()=> '2026-09-26'});
  const proposal=require('../public/todo-actions').plan(S.todoCards,S.records,S.tableSchema,{action:'update_todos',updates:[{selection:{source:'all',ids:[],focusId:null,conditions:[]},changes:[{field:'dueDate',operation:'set',value:'2026-10-02'},{field:'notes',operation:'append',value:'<script>x</script>'}]}]});ui.preview(proposal);
  const html=node('trustBody').innerHTML;assert.match(html,/3 selected; 3 cards/);assert.match(html,/Northstar/);assert.match(html,/Greenline/);assert.match(html,/Beacon/);assert.equal((html.match(/2026-10-02/g)||[]).length,3);assert.equal((html.match(/data-confirm/g)||[]).length,1);assert(!html.includes('<script>'));assert.match(html,/Confirm 3 card updates/);
});
test('batch review renders every linked task, due date and escaped note with one explicit confirmation',()=>{
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){}});return nodes.get(id);};
  const window={PipeChatTodo:T,addEventListener(){}};vm.runInNewContext(fs.readFileSync(require.resolve('../public/todo-ui'),'utf8'),{window,document:{getElementById:node}});
  const S={records:fixture.records,tableSchema:fixture.schema,todoCards:[],saving:false};
  const ui=window.PipeChatTodoUI.create({S,esc:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),icon:()=>'',persistTodo(){},prepare(){},render(){},toast(){},localDate:()=> '2026-09-23'});
  const action=structuredClone(fixture.todos);action.todos[1].todoNotes='<script>untrusted</script>';
  ui.preview(T.plan([],S.records,S.tableSchema,[],action,'todo_preview'));
  const html=node('trustBody').innerHTML;for(const value of ['2 cards to add','Greenline Foods','Northstar Design','Call Omar about Greenline','Email Maya about Northstar','2026-09-24','2026-09-28','Confirm 2 cards','&lt;script&gt;untrusted&lt;/script&gt;'])assert(html.includes(value));
  assert(!html.includes('<script>'));assert.equal((html.match(/data-confirm/g)||[]).length,1);assert.match(node('trustStatus').textContent,/CRM fields stay unchanged/);
});
