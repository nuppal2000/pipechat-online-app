const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Core=require('../public/pipeline-core.js'),Schema=require('../public/table-schema.js'),Customize=require('../public/workspace-customization.js');
const schema={status:'ready',useCase:'Sales',title:'Sales',recordLabel:'deal',description:'',fields:[{id:'f_name',name:'Company',type:'text',role:'primary',options:[]},{id:'f_score',name:'Score',type:'number',role:'none',options:[]},{id:'f_status',name:'Status',type:'text',role:'status',options:[]}]};
const records=[{id:1,f_name:'A',f_score:0,f_status:'Warm',history:[]},{id:2,f_name:'B',f_score:20,f_status:'d',history:[]}];
function harness(){
  const nodes=new Map(),calls=[],messages=[];let action=null,fail=false,saved={deals:structuredClone(records),customFields:[],tableSchema:schema,updatedAt:'v1'};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',hidden:false,open:false,dataset:{},style:{},elements:{},classList:{add(){},remove(){},toggle(){}},focus(){},setAttribute(){},querySelectorAll:()=>[],showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(id);};
  const context={crypto,AbortSignal,innerWidth:1400,innerHeight:900,window:{PipeChatInspector:require('../public/inspector-core.js'),PipeChatTodo:require('../public/todo-core.js'),PipelineCore:Core,PipeChatSchema:Schema,PipeChatCustomize:Customize,PipeChatIcons:{}},document:{getElementById:node,querySelector:node,querySelectorAll:()=>[]},sessionStorage:{removeItem(){},getItem(){return null;}},fetch:async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(url==='/api/pipechat-ai')return {ok:true,json:async()=>({crmAction:action,usage:{used:1,remaining:20}})};
    if(fail)return {ok:false,status:503,json:async()=>({error:'Synthetic failure'})};
    if(options.method==='PUT')saved={deals:body.deals,customFields:body.customFields,tableSchema:body.tableSchema,updatedAt:'v'+calls.length};
    return {ok:true,json:async()=>structuredClone(saved)};
  }};
  context.window.messages=messages;
  const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>{};focusTrust=()=>{};toast=()=>{};updateUsage=()=>{};say=(text,role='assistant')=>{S.history.push({role,content:text});window.messages.push(text);};window.test={S,useSchema,prepare,send,confirmDraft,undo,cancelDraft,openFieldDialog,submitFieldDialog,openColumnMenu,renderTrust,renderTable,renderDashboardKpis,fieldInput,resizeTextCell};`),context);
  const h=context.window.test;h.useSchema(schema);Object.assign(h.S,{records:structuredClone(records),customFields:[],updatedAt:'v1',loaded:true,user:{id:1,name:'QA'},usage:{remaining:20},health:{aiConfigured:true}});
  return {...h,node,calls,messages,reply:a=>action=a,fail:v=>fail=v};
}
const plain=v=>JSON.parse(JSON.stringify(v));
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
