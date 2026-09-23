const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
function harness(pick=async()=>({name:'Test.csv',matrix:[['ID','Value'],['001','25'],['002','0']],primary:0}),handler){
  const nodes=new Map(),calls=[],messages=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',hidden:false,setAttribute(){},classList:{add(){},remove(){},toggle(){}}});return nodes.get(id);};
  const context={crypto,TextEncoder,AbortSignal,window:{PipeChatTodo:require('../public/todo-core.js'),PipelineCore:require('../public/pipeline-core.js'),PipeChatSchema:require('../public/table-schema.js'),PipeChatSheets:require('../public/spreadsheet-import.js'),PipeChatCsv:require('../public/csv-import.js'),PipeChatSpreadsheetUI:()=>({open:pick}),PipeChatIcons:{}},document:{getElementById:node,querySelector:()=>node('selector'),querySelectorAll:()=>[]},fetch:async(url,options)=>{calls.push({url,payload:JSON.parse(options.body)});const data=handler?await handler(url,calls.at(-1).payload):{...calls.at(-1).payload,updatedAt:'v2'};return {ok:true,json:async()=>data};},clearTimeout(){},setTimeout(){},sessionStorage:{removeItem(){},setItem(){}}};
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();','  render=()=>{};updateUsage=()=>{};say=()=>{};toast=()=>{};syncShareFields=()=>{};renderTrust=()=>{};focusTrust=()=>{};window.test={S,openSpreadsheet,confirmSchema,fieldInput,useSchema};'),context);
  const api=context.window.test;Object.assign(api.S,{loaded:true,user:{id:'qa'},setupUseCase:'Sales',usage:{used:1000,remaining:0},updatedAt:'v1'});api.useSchema({status:'pending'});
  return {...api,node,calls,messages};
}
test('spreadsheet preview is free at chat cap; only explicit confirmation persists exact populated schema',async()=>{
  const h=harness();await h.openSpreadsheet('setup');assert.equal(h.calls.length,0);assert.equal(h.S.setupRecords.length,2);assert.equal(h.S.records.length,0);
  assert.match(h.node('schemaPreview').innerHTML,/Create populated table/);await h.confirmSchema();assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/crm-data');assert.equal(h.calls[0].payload.expectedUpdatedAt,'v1');assert.equal(h.S.records[0][h.S.tableSchema.fields[0].id],'001');assert.equal(h.S.usage.used,1000);
});
test('cancel and stale/session-switched spreadsheet previews cannot save',async()=>{
  const cancel=harness(async()=>null);await cancel.openSpreadsheet('setup');assert.equal(cancel.S.schemaPreview,null);assert.equal(cancel.calls.length,0);
  const stale=harness();await stale.openSpreadsheet('setup');stale.S.revision++;await stale.confirmSchema();assert.equal(stale.calls.length,0);
  let done;const switched=harness(()=>new Promise(resolve=>done=resolve));const pending=switched.openSpreadsheet('setup');switched.S.generation++;done({matrix:[['Name'],['Do not load']],name:'old.csv',primary:0});await pending;assert.equal(switched.S.schemaPreview,null);assert.equal(switched.calls.length,0);
});
test('failed or altered save retains preview for explicit recovery without marking onboarding complete',async()=>{
  for(const handler of [()=>{throw Error('offline');},(url,payload)=>({...payload,deals:payload.deals.map(row=>({...row,[payload.tableSchema.fields[0].id]:'changed'})),updatedAt:'v2'})]){
    const h=harness(undefined,handler);await h.openSpreadsheet('setup');await h.confirmSchema();assert.equal(h.S.tableSchema.status,'pending');assert.equal(h.S.records.length,0);assert(h.S.schemaPreview);assert.equal(h.S.setupRecords.length,2);
  }
});
test('append uploads go through the existing mapping preview and never overwrite the schema',async()=>{
  const h=harness();h.useSchema(require('../public/table-schema.js').legacySchema());h.S.records=[{id:5,account:'Existing'}];await h.openSpreadsheet('append');assert.equal(h.calls.length,0);assert.equal(h.S.pending.kind,'csv-import');assert.match(h.S.pending.error,/Chat allowance exhausted/);assert.equal(h.S.records[0].account,'Existing');
});
test('only AI and spreadsheet build options remain; multiline cells are editable without stripping newlines',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');assert(!html.includes('Build Pipechat Table from Scratch'));assert(!html.includes('Use Default Pipechat Table'));assert.match(html,/id="buildSheetBtn"/);
  const h=harness();assert.match(h.fieldInput({id:'f_notes',name:'Notes',type:'text'},'a\nb'),/<textarea[^>]*>a\nb<\/textarea>/);assert(!h.fieldInput({id:'f_notes',name:'Notes',type:'text'},'<script>bad</script>\n').includes('<script>'));
});
