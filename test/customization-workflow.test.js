const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Core=require('../public/pipeline-core.js'),Schema=require('../public/table-schema.js'),Customize=require('../public/workspace-customization.js');
const schema={status:'ready',useCase:'Sales',title:'Sales',recordLabel:'deal',description:'',fields:[{id:'f_name',name:'Company',type:'text',role:'primary',options:[]},{id:'f_score',name:'Score',type:'number',role:'none',options:[]},{id:'f_status',name:'Status',type:'text',role:'status',options:[]}]};
const records=[{id:1,f_name:'A',f_score:0,f_status:'Warm',history:[]},{id:2,f_name:'B',f_score:20,f_status:'d',history:[]}];
function harness(){
  const nodes=new Map(),calls=[],messages=[];let action=null,fail=false,aiResponse=null,beforeReply=null,saved={deals:structuredClone(records),customFields:[],tableSchema:schema,updatedAt:'v1'};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',hidden:false,open:false,dataset:{},style:{},elements:{},classList:{add(){},remove(){},toggle(){}},focus(){},setAttribute(){},insertAdjacentHTML(where,text){this.innerHTML=where==='afterbegin'?text+this.innerHTML:this.innerHTML+text;},querySelectorAll:()=>[],showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(id);};
  const context={crypto,AbortSignal,innerWidth:1400,innerHeight:900,window:{PipeChatInspector:require('../public/inspector-core.js'),PipeChatTodo:require('../public/todo-core.js'),PipelineCore:Core,PipeChatSchema:Schema,PipeChatCustomize:Customize,PipeChatIcons:{}},document:{getElementById:node,querySelector:node,querySelectorAll:()=>[]},sessionStorage:{removeItem(){},getItem(){return null;}},fetch:async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(url==='/api/pipechat-ai'){beforeReply?.();return aiResponse||{ok:true,json:async()=>({crmAction:action,usage:{used:1,remaining:20}})};}
    if(fail)return {ok:false,status:503,json:async()=>({error:'Synthetic failure'})};
    if(options.method==='PUT')saved={deals:body.deals,customFields:body.customFields,tableSchema:body.tableSchema,todoCards:body.todoCards||[],updatedAt:'v'+calls.length};
    return {ok:true,json:async()=>structuredClone(saved)};
  }};
  context.window.messages=messages;
  const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>{};focusTrust=()=>{};toast=()=>{};updateUsage=()=>{};say=(text,role='assistant')=>{S.history.push({role,content:text});window.messages.push(text);};window.test={S,useSchema,prepare,send,confirmDraft,undo,dismissUndo,cancelDraft,openFieldDialog,submitFieldDialog,openColumnMenu,renderTrust,renderTable,renderDashboardKpis,fieldInput,resizeTextCell,moveColumn,selectScope,visible,fieldHeader};`),context);
  const h=context.window.test;h.useSchema(schema);Object.assign(h.S,{records:structuredClone(records),customFields:[],updatedAt:'v1',loaded:true,user:{id:1,name:'QA'},usage:{remaining:20},health:{aiConfigured:true}});
  return {...h,node,calls,messages,reply:a=>action=a,fail:v=>fail=v,response:v=>aiResponse=v,beforeReply:f=>beforeReply=f};
}
const plain=v=>JSON.parse(JSON.stringify(v));
const additionsFixture=require('./fixtures/record-additions.cjs');
const assistantFixture=require('./fixtures/assistant-actions.cjs');
test('exact new-dropdown request previews choices and persists editable blank dropdowns, preserving rows and Undo',async()=>{
  const h=harness(),before=plain(h.S.records);h.S.tab='todo';h.reply(assistantFixture.dropdown);await h.send(assistantFixture.dropdownPrompt);
  assert.equal(h.S.tab,'table');assert.equal(h.S.pending.field.type,'choice');assert.deepEqual(plain(h.S.pending.field.options),['hot','medium','cold']);assert.match(h.node('trustBody').innerHTML,/Dropdown options: hot, medium, cold/);assert.equal(h.S.customFields.length,0);assert.deepEqual(plain(h.S.records),before);
  h.cancelDraft();assert.equal(h.calls.length,1);h.reply(assistantFixture.dropdown);await h.send(assistantFixture.dropdownPrompt);const id=h.S.pending.field.id;await h.confirmDraft();assert.equal(h.S.customFields[0].type,'choice');assert(h.S.records.every(r=>r[id]===''));h.renderTable(h.S.records);assert.match(h.node('dealRows').innerHTML,/<option[^>]*>hot<\/option>/);
  const stored=h.calls.filter(c=>c.url==='/api/crm-data').at(-1).body;assert.deepEqual(stored.customFields[0].options,['hot','medium','cold']);await h.undo();assert.equal(h.S.customFields.length,0);assert.deepEqual(plain(h.S.records),before);
});
test('new dropdown without options asks in context; invalid choices, failure and stale previews never add a text fallback',async()=>{
  const h=harness();h.reply({...assistantFixture.dropdown,dropdownOptions:null});await h.send('Add a dropdown called test');assert.equal(h.S.pending,null);assert.equal(h.S.clarification.question,'What options would you like the dropdown menu to have?');assert.equal(h.S.sourceAction.newFieldName,'test');
  h.reply(assistantFixture.dropdown);await h.send('hot medium cold');assert.equal(h.calls.at(-1).body.pendingAction.targetType,'choice');assert.equal(h.S.pending.field.type,'choice');h.fail(true);await h.confirmDraft();assert.equal(h.S.customFields.length,0);assert.equal(h.S.pending.field.type,'choice');
  h.fail(false);h.S.revision++;await h.confirmDraft();assert.equal(h.S.customFields.length,0);h.cancelDraft();
  for(const options of [['hot','HOT'],[''],Array.from({length:31},(_,i)=>String(i))])assert.throws(()=>h.prepare({...assistantFixture.dropdown,dropdownOptions:options}),/dropdown options/);
  assert.equal(h.S.customFields.length,0);h.prepare({action:'add_field',newFieldName:'Plain'});assert.equal(h.S.pending.field.type,'text');h.cancelDraft();h.prepare({action:'add_field',newFieldName:'Date',targetType:'date'});assert.equal(h.S.pending.field.type,'date');
});
function additionHarness(){const h=harness();h.useSchema(additionsFixture.schema);h.S.records=[];return h;}
test('original three-deal prompt previews all rows, cancel writes nothing, confirm saves once, and Undo restores',async()=>{
  const h=additionHarness(),action={action:'add_records',record:null,records:additionsFixture.records};h.reply(action);await h.send(additionsFixture.prompt);
  assert.equal(h.S.pending.count,3);assert.equal(h.S.records.length,0);assert.equal(h.calls.filter(c=>c.url==='/api/crm-data').length,0);
  for(const record of additionsFixture.records)assert(h.node('trustBody').innerHTML.includes(record.f_deal));
  h.cancelDraft();assert.equal(h.S.pending,null);assert.equal(h.calls.length,1);
  h.reply({...action,action:'add_record'});await h.send(additionsFixture.prompt);assert.equal(h.S.pending.count,3);await h.confirmDraft();
  assert.equal(h.calls.filter(c=>c.url==='/api/crm-data').length,1);assert.equal(h.S.records.length,3);
  additionsFixture.records.forEach((r,i)=>{for(const [key,value]of Object.entries(r))assert.equal(h.S.records[i][key],value);});
  await h.undo();assert.equal(h.S.records.length,0);
});
test('batch clarification retains the original request and every other record, then resolves or cancels consistently',async()=>{
  const h=additionHarness(),bad=structuredClone(additionsFixture.records);bad[1].f_stage='banana';h.reply({action:'add_records',records:bad});await h.send(additionsFixture.prompt);
  assert.equal(h.S.pending,null);assert.match(h.S.clarification.question,/record 2.*Deal Stage/);assert.equal(h.S.clarification.originalCommand,additionsFixture.prompt);assert.equal(h.S.sourceAction.records.length,3);
  assert(!h.messages.some(m=>/Sorry, I couldn't/.test(m)));assert.match(h.node('trustStatus').textContent,/Waiting for your reply/);
  h.reply({action:'add_records',records:additionsFixture.records});await h.send('Use Proposal Sent for Greenline Foods.');
  assert.equal(h.calls[1].body.pendingAction.records.length,3);assert.equal(h.calls[1].body.pendingClarification.originalCommand,additionsFixture.prompt);assert.equal(h.S.pending.count,3);assert.equal(h.S.clarification,null);
  await h.send('no');assert.equal(h.S.pending,null);assert.equal(h.S.clarification,null);assert.equal(h.S.records.length,0);assert.equal(h.calls.filter(c=>c.url==='/api/crm-data').length,0);
});
test('stale or failed batch confirmation never partially creates rows',async()=>{
  const h=additionHarness();h.prepare({action:'add_records',records:additionsFixture.records},additionsFixture.prompt);h.S.revision++;await h.confirmDraft();assert.equal(h.calls.length,0);assert.match(h.messages.at(-1),/table changed/);
  h.prepare({action:'add_records',records:additionsFixture.records},additionsFixture.prompt);h.fail(true);await h.confirmDraft();assert.equal(h.S.records.length,0);assert.equal(h.S.pending.records.length,3);
});
test('AI row move previews, confirms, persists cells/history, restores sorting on undo, and carries table context',async()=>{
  const h=harness();h.S.sort={field:'f_score',direction:'desc'};h.reply({action:'move_record',recordMatch:'B',toPosition:2});await h.send('Move B to row 2');
  assert.equal(h.S.pending.kind,'move-record');assert.deepEqual(plain(h.S.records),records);assert.match(h.node('trustBody').innerHTML,/sort will be cleared/);
  const payload=h.calls[0].body;assert.deepEqual(plain(payload.pipeline.tableView.visibleIds),[2,1]);assert.deepEqual(plain(payload.pipeline.tableView.columnOrder),['f_name','f_score','f_status']);
  await h.confirmDraft();assert.equal(h.S.sort,null);assert.deepEqual(plain(h.S.records),records);assert.equal(h.messages.at(-1),'Saved. Record moved to position 2. Cell values are unchanged.');
  await h.undo();assert.equal(h.S.sort.direction,'desc');assert.deepEqual(plain(h.S.records),records);
  h.S.sort=null;h.reply({action:'move_record',recordMatch:'B',toPosition:1});await h.send('Move B first');await h.confirmDraft();assert.deepEqual(plain(h.S.records.map(r=>r.id)),[2,1]);assert.deepEqual(plain(h.S.records[0]),records[1]);
  await h.undo();assert.deepEqual(plain(h.S.records),records);
});
test('moves reject stale views, revisions, sessions and failed saves; cancel and no-op do not write',async()=>{
  for(const mutate of [h=>h.S.search='A',h=>h.S.revision++,h=>h.S.generation++]){const h=harness();h.prepare({action:'move_record',fromPosition:2,toPosition:1});mutate(h);await h.confirmDraft();assert.equal(h.calls.length,0);assert.match(h.messages.at(-1),/changed/);}
  const h=harness();h.prepare({action:'move_record',fromPosition:2,toPosition:1});h.fail(true);await h.confirmDraft();assert.deepEqual(plain(h.S.records),records);assert.equal(h.S.pending.kind,'move-record');assert.match(h.messages.at(-1),/save was not confirmed/);
  h.cancelDraft();const count=h.calls.length;h.prepare({action:'move_record',fromPosition:2,toPosition:2});assert.equal(h.S.pending,null);assert.equal(h.calls.length,count);
  const stale=harness();stale.reply({action:'move_record',fromPosition:1,toPosition:2});stale.beforeReply(()=>{stale.S.sort={field:'f_name',direction:'desc'};});await stale.send('Move first last');assert.equal(stale.S.pending,null);assert.match(stale.messages.at(-1),/while I was thinking/);
});
test('AI moves columns through preview and undo; typed sorting changes only the view',async()=>{
  const h=harness();h.reply({action:'move_field',field:'f_status',toPosition:1});await h.send('Move Status to first column');assert.equal(h.S.pending.kind,'move-field');await h.confirmDraft();assert.deepEqual(plain(h.S.tableSchema.columnOrder),['f_status','f_name','f_score']);assert.deepEqual(plain(h.S.records),records);await h.undo();assert.equal(h.S.tableSchema.columnOrder,undefined);
  const writes=h.calls.filter(c=>c.url==='/api/crm-data').length;h.reply({action:'sort_table',field:'f_score',sortDirection:'desc'});await h.send('Sort score descending');assert.deepEqual(plain(h.visible().map(r=>r.id)),[2,1]);assert.deepEqual(plain(h.S.records),records);
  h.reply({action:'sort_table',field:null,sortDirection:null});await h.send('Clear sorting');assert.equal(h.S.sort,null);assert.equal(h.calls.filter(c=>c.url==='/api/crm-data').length,writes);
});
test('unreadable 200/502, missing response, unsupported action and quota errors are friendly and make no writes',async()=>{
  for(const status of [200,502]){const h=harness();h.response({ok:status===200,status,json:async()=>{throw new Error('Private server detail');}});await h.send('Please move row 2');assert.match(h.messages.at(-1),/^Sorry, I couldn't complete/);assert(!h.messages.at(-1).includes('Private'));assert.equal(h.S.pending,null);assert.equal(h.calls.length,1);assert.deepEqual(plain(h.S.records),records);}
  const h=harness();h.response({ok:true,json:async()=>({})});await h.send('Do it');assert.match(h.messages.at(-1),/^Sorry/);
  h.response(null);h.reply({action:'arbitrary_sql'});await h.send('Unsupported action');assert.match(h.messages.at(-1),/cannot perform that action yet/);assert.equal(h.S.pending,null);
  h.response({ok:false,status:429,json:async()=>({error:'Limit reached',usage:{remaining:0}})});await h.send('Do it');assert.equal(h.S.usage.remaining,0);assert.match(h.messages.at(-1),/still edit the table manually/);
  const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8');assert.match(source,/el.className=`chat-message \$\{role\}`/);assert(!source.includes('AI request failed:'));
});
test('text cells are compact escaped textareas that expand and collapse without writes',()=>{
  const h=harness(),value='A long single-line note <script> not markup & more text';
  const html=h.fieldInput({id:'f_status',name:'Notes',type:'text'},value);
  assert.match(html,/<textarea/);assert.match(html,/data-expand-text/);assert.match(html,/rows="1"/);assert.match(html,/&lt;script&gt;/);
  const el={style:{},scrollHeight:220,hasAttribute:name=>name==='data-expand-text'};
  h.resizeTextCell(el,true);assert.equal(el.style.height,'222px');h.resizeTextCell(el,false);assert.equal(el.style.height,'34px');assert.equal(h.calls.length,0);
  assert(!h.fieldInput({id:'f_score',name:'Score',type:'number'},3).includes('data-expand-text'));
  assert.match(h.fieldInput({id:'f_status',name:'Notes',type:'text'},'Line one\nLine two'),/Line one\nLine two/);
});
test('right-click rename is a preview, preserves all row data, works at cap and can undo',async()=>{
  const h=harness();h.S.usage={remaining:0};let prevented=false;
  h.openColumnMenu({preventDefault(){prevented=true;},clientX:1300,clientY:850,target:{closest:()=>({dataset:{sortField:'f_name'},getBoundingClientRect:()=>({left:0,bottom:30})})}});
  assert(prevented);assert.equal(h.node('columnMenu').hidden,false);assert.equal(h.node('columnMenu').dataset.field,'f_name');
  h.openFieldDialog('rename','f_name');h.node('renameFieldName').value='Customer';h.submitFieldDialog({preventDefault(){}});
  assert.equal(h.S.pending.kind,'rename-field');assert.equal(h.calls.length,0);assert.match(h.node('trustBody').innerHTML,/Only the header changes/);
  await h.confirmDraft();assert.equal(h.S.tableSchema.fields[0].name,'Customer');assert.deepEqual(plain(h.S.records),records);
  await h.undo();assert.equal(h.S.tableSchema.fields[0].name,'Company');assert.deepEqual(plain(h.S.records),records);
});
test('missing dropdown options clarify in context; reply proposes blanks; confirm, reload data and undo preserve other cells',async()=>{
  const h=harness();h.reply({action:'convert_field',field:'f_status',dropdownOptions:null});await h.send('Make Status a dropdown');
  assert.equal(h.S.pending,null);assert.equal(h.S.clarification.question,'What options would you like the dropdown menu to have?');
  h.reply({action:'convert_field',field:'f_status',dropdownOptions:['Warm','Won']});await h.send('Warm and Won');
  const request=h.calls.filter(c=>c.url==='/api/pipechat-ai').at(-1).body;assert.equal(request.pendingClarification.field,'f_status');assert.equal(request.pendingAction.field,'f_status');
  assert.match(h.node('trustBody').innerHTML,/Row #2.*d.*left blank/);assert.equal(h.S.records[1].f_status,'d');
  h.fail(true);await h.confirmDraft();assert.equal(h.S.records[1].f_status,'d');assert.equal(h.S.pending.kind,'convert-field');
  h.fail(false);await h.confirmDraft();assert.equal(h.S.records[1].f_status,'');assert.equal(h.S.records[1].f_score,20);h.renderTable(h.S.records);assert.match(h.node('dealRows').innerHTML,/<select/);
  await h.undo();assert.deepEqual(plain(h.S.records).map(r=>({...r,history:[]})),records);assert.equal(h.S.records[1].history.length,2);assert.equal(h.S.tableSchema.fields[2].type,'text');
});
test('KPI AI proposal changes only a card after confirmation and survives stored-schema reloading',async()=>{
  const h=harness();h.reply({action:'configure_kpi',kpiId:'kpi_f_score',kpi:{title:'Average score',metric:'average',field:'f_score',conditions:[]}});await h.send('Make total score an average');
  assert.equal(h.S.pending.kind,'configure-kpi');assert.equal(h.calls.filter(c=>c.url==='/api/crm-data').length,0);h.renderTrust();assert.match(h.node('trustBody').innerHTML,/Average score/);
  await h.confirmDraft();assert.deepEqual(plain(h.S.records),records);const stored=plain(h.S.tableSchema);h.useSchema(stored);h.renderDashboardKpis(h.S.records);assert.match(h.node('.metrics').innerHTML,/Average score<\/span><strong>10/);
  await h.undo();h.renderDashboardKpis(h.S.records);assert.match(h.node('.metrics').innerHTML,/Total Score<\/span><strong>20/);
});
test('cancel, stale revision and changed login prevent old proposals saving',async()=>{
  const h=harness();h.prepare({action:'rename_field',field:'f_name',newFieldName:'Customer'});h.cancelDraft();assert.equal(h.calls.length,0);
  h.prepare({action:'convert_field',field:'f_status',dropdownOptions:['Warm']});h.S.revision++;await h.confirmDraft();assert.equal(h.calls.length,0);assert.match(h.messages.at(-1),/table changed/);
});
test('conversion clears incompatible active filters without losing the saved table',async()=>{
  const h=harness();h.S.filter={field:'f_status',operator:'equals',value:'d'};h.S.report.filter=h.S.filter;
  h.prepare({action:'convert_field',field:'f_status',dropdownOptions:['Warm']});await h.confirmDraft();assert.equal(h.S.filter,null);assert.equal(h.S.report.filter,null);assert.equal(h.S.records[0].f_status,'Warm');
});
test('AI can add and delete KPI cards with previews, cancel, undo, reload and unchanged rows',async()=>{
  const h=harness(),spec={title:'Tracked statuses',metric:'count',field:null,conditions:[{field:'f_status',operator:'is_not_blank',value:null}]};
  h.reply({action:'add_kpi',kpi:spec,kpiId:null});await h.send('Add dashboard KPI Tracked statuses');h.renderTrust();
  assert.equal(h.S.pending.kind,'add-kpi');assert.match(h.node('trustBody').innerHTML,/existing KPI cards will be kept/);assert.equal(h.calls.filter(c=>c.url==='/api/crm-data').length,0);
  await h.confirmDraft();assert.equal(Customize.kpis(h.S.tableSchema).length,3);assert.deepEqual(plain(h.S.records),records);
  const id=Customize.kpis(h.S.tableSchema).at(-1).id;h.reply({action:'delete_kpi',kpiId:id});await h.send('Delete Tracked statuses');h.renderTrust();assert.match(h.node('trustBody').innerHTML,/Other KPI cards will be kept/);h.cancelDraft();assert.equal(Customize.kpis(h.S.tableSchema).length,3);
  await h.send('Delete Tracked statuses');await h.confirmDraft();assert.equal(Customize.kpis(h.S.tableSchema).length,2);await h.undo();assert.equal(Customize.kpis(h.S.tableSchema).length,3);
  h.reply({action:'delete_kpi',kpiId:'kpi_records'});await h.send('Delete Records');await h.confirmDraft();h.useSchema(plain(h.S.tableSchema));assert(!Customize.kpis(h.S.tableSchema).some(k=>k.id==='kpi_records'));assert.deepEqual(plain(h.S.records),records);
  await h.undo();assert(Customize.kpis(h.S.tableSchema).some(k=>k.id==='kpi_records'));
});
test('All records clears AI filters, search and owner scope without editing or charging',()=>{
  const h=harness();h.S.scope='mine';h.S.search='nothing';h.S.filter={field:'f_status',operator:'equals',value:'Warm'};h.node('dealSearch').value='nothing';
  assert.equal(h.visible().length,0);h.selectScope('all');assert.equal(h.visible().length,2);assert.equal(h.S.filter,null);assert.equal(h.S.search,'');assert.equal(h.node('dealSearch').value,'');assert.equal(h.calls.length,0);
});
test('header reorder persists whole columns, does not sort rows or alter cells, and supports undo and failed saves',async()=>{
  const h=harness();h.S.usage={remaining:0};assert.equal(await h.moveColumn('f_name','f_status'),true);
  assert.deepEqual(plain(h.S.tableSchema.columnOrder),['f_score','f_status','f_name']);assert.deepEqual(plain(h.S.records),records);
  h.renderTable(h.S.records);const html=h.node('dealHeaders').innerHTML;assert(html.indexOf('f_status')<html.indexOf('f_name'));assert.equal(h.S.sort,null);
  await h.undo();assert.equal(h.S.tableSchema.columnOrder,undefined);assert.deepEqual(plain(h.S.records),records);
  h.fail(true);assert.equal(await h.moveColumn('f_status','f_name'),false);assert.equal(h.S.tableSchema.columnOrder,undefined);
  h.fail(false);const count=h.calls.length;for(const flag of ['saving','busy','failedEdit','pending','clarification']){h.S[flag]=true;assert.equal(await h.moveColumn('f_status','f_name'),false);h.S[flag]=false;}assert.equal(h.calls.length,count);
  assert.equal(await h.moveColumn('f_status','f_name',h.S.revision-1),false);assert.equal(await h.moveColumn('f_status','f_name',h.S.revision,h.S.generation-1),false);
});
test('first displayed column is primary after dragging away or into first; zero values and undo remain intact',async()=>{
  const h=harness();h.S.report.groupBy='f_name';await h.moveColumn('f_name','f_status');
  assert.equal(Core.create(h.S.tableSchema).role('primary'),'f_score');assert.equal(h.S.report.groupBy,'f_score');
  h.renderTable(h.S.records);assert.match(h.node('dealRows').innerHTML,/Open inspector for 0/);assert(!h.node('dealRows').innerHTML.includes('Unnamed record #1'));
  assert.equal(require('../public/todo-core').project({recordId:1},h.S.records,h.S.tableSchema).title,'0');
  await h.undo();assert.equal(Core.create(h.S.tableSchema).role('primary'),'f_name');assert.equal(h.S.report.groupBy,'f_name');
  await h.moveColumn('f_status','f_name');assert.equal(Core.create(h.S.tableSchema).role('primary'),'f_status');assert.equal(Core.create(h.S.tableSchema).role('status'),'f_status');assert.deepEqual(plain(h.S.records),records);
});

test('bulk blank-client deletion previews every match regardless of guessed IDs, cancels, confirms linked-card deletion and undoes',async()=>{
  const h=harness();h.S.records=[...records,{id:3,f_name:'C',f_status:' ',f_score:5,history:[]}];h.S.records[0].f_status='';
  h.S.todoCards=[{id:'todo_a',recordId:1,status:'To Do',nextAction:'Call',notes:'Keep until confirmed',dueDate:''},{id:'todo_b',recordId:2,status:'Done',nextAction:'Done',notes:'',dueDate:''}];
  const before=plain(h.S.records),cards=plain(h.S.todoCards);h.S.filter={field:'f_name',operator:'equals',value:'B'};
  h.reply({action:'delete_records',filter:{field:'f_status',operator:'is_blank',value:null},ids:[1],recordMatch:'A'});
  await h.send('Delete all records without a client name');assert.equal(h.S.pending.count,2);assert.match(h.node('trustBody').innerHTML,/all 1 associated Kanban/);assert.deepEqual(plain(h.S.records),before);h.cancelDraft();assert.equal(h.calls.filter(c=>c.url==='/api/crm-data').length,0);
  await h.send('Delete all blank clients');await h.confirmDraft();assert.deepEqual(plain(h.S.records.map(r=>r.id)),[2]);assert.deepEqual(plain(h.S.todoCards.map(c=>c.id)),['todo_b']);await h.undo();assert.deepEqual(plain(h.S.records),before);assert.deepEqual(plain(h.S.todoCards),cards);
});

test('bulk explicit IDs work, single ambiguous name still clarifies, and stale or failed deletions do not apply',async()=>{
  const h=harness();h.S.records[1].f_name='A';h.prepare({action:'delete_record',recordMatch:'A'});assert.equal(h.S.clarification.candidates.length,2);h.cancelDraft();
  h.prepare({action:'delete_records',ids:[1,2]});assert.equal(h.S.pending.count,2);h.S.revision++;await h.confirmDraft();assert.equal(h.calls.length,0);
  h.prepare({action:'delete_records',ids:[1,2]});h.fail(true);await h.confirmDraft();assert.equal(h.S.records.length,2);assert.equal(h.S.pending.count,2);
  h.fail(false);await h.confirmDraft();assert.equal(h.S.records.length,0);await h.undo();assert.equal(h.S.records.length,2);
});

test('recurring concept produces a labelled, escaped field suggestion with cancel, confirm, duplicate protection and undo',async()=>{
  const h=harness();h.S.history=[{role:'user',content:'Track the renewal for A'},{role:'user',content:'B also has a renewal coming up'}];
  h.reply({action:'propose_field',newFieldName:'Renewal',summary:'Renewals recur across your accounts. <b>Track them separately.</b>'});await h.send('How should I keep track of those?');
  assert.equal(h.node('trustTitle').textContent,'Proposed new field');assert.match(h.node('trustBody').innerHTML,/&lt;b&gt;/);assert.equal(h.S.customFields.length,0);h.cancelDraft();assert.equal(h.S.customFields.length,0);
  await h.send('Suggest that field again');await h.confirmDraft();assert.equal(h.S.customFields[0].name,'Renewal');assert(h.S.records.every(r=>r[h.S.customFields[0].id]===''));
  assert.throws(()=>h.prepare({action:'propose_field',newFieldName:'renewal',summary:'Duplicate'}),/already exists/);await h.undo();assert.equal(h.S.customFields.length,0);assert.deepEqual(plain(h.S.records),records);
});

test('dismissing the undo notice hides it without reverting data and the next save gets a fresh notice',async()=>{
  const h=harness();await h.moveColumn('f_status','f_name');h.dismissUndo();assert.equal(h.node('undoStrip').hidden,true);assert.equal(h.S.undo.dismissed,true);assert.equal(Core.create(h.S.tableSchema).role('primary'),'f_status');
  await h.moveColumn('f_name','f_status');assert.equal(h.S.undo.dismissed,undefined);assert.equal(Core.create(h.S.tableSchema).role('primary'),'f_name');
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');assert.match(html,/id="dismissUndo"[^>]+aria-label="Dismiss undo notification"/);
});

test('AI calendar conversion previews without options, confirms a native date input, and undo restores original strings',async()=>{
  const h=harness();h.S.records[0].f_status='oct 5 2026';h.S.records[1].f_status='';
  h.reply({action:'convert_field',field:'f_status',targetType:'date',dropdownOptions:null});await h.send('Make Status a calendar date field');
  assert.equal(h.S.pending.kind,'convert-field');assert.match(h.node('trustBody').innerHTML,/Calendar date field/);assert.equal(h.S.records[0].f_status,'oct 5 2026');
  await h.confirmDraft();assert.equal(h.S.records[0].f_status,'2026-10-05');h.renderTable(h.S.records);assert.match(h.node('dealRows').innerHTML,/type="date"/);
  await h.undo();assert.equal(h.S.records[0].f_status,'oct 5 2026');assert.equal(h.S.tableSchema.fields[2].type,'text');
});
test('ambiguous dates ask clarification with no pending write; dropdown-to-text keeps selections and previews',async()=>{
  const h=harness();h.S.records[0].f_status='10/5/2026';h.reply({action:'convert_field',field:'f_status',targetType:'date',dropdownOptions:null});await h.send('Make Status a date field');
  assert.equal(h.S.pending,null);assert.match(h.S.clarification.question,/clarify these dates/);assert.equal(h.S.clarification.previousAction.targetType,'date');assert.equal(h.calls.filter(c=>c.url==='/api/crm-data').length,0);
  h.cancelDraft();h.S.records[0].f_status='Warm';h.S.records[1].f_status='Won';h.useSchema({...schema,fields:schema.fields.map(f=>f.id==='f_status'?{...f,type:'choice',options:['Warm','Won']}:f)});
  h.reply({action:'convert_field',field:'f_status',targetType:'text',dropdownOptions:null});await h.send('Make Status plain text');assert.match(h.node('trustBody').innerHTML,/preserved as text/);
  await h.confirmDraft();assert.deepEqual(plain(h.S.records.map(r=>r.f_status)),['Warm','Won']);assert.equal(h.S.tableSchema.fields[2].type,'text');
});
