const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
function harness(pick=async()=>({name:'Test.csv',matrix:[['ID','Value'],['001','25'],['002','0']],primary:0}),handler){
  const nodes=new Map(),calls=[],messages=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',hidden:false,setAttribute(){},classList:{add(){},remove(){},toggle(){}}});return nodes.get(id);};
  const context={crypto,TextEncoder,AbortSignal,window:{PipeChatInspector:require('../public/inspector-core.js'),PipeChatTodo:require('../public/todo-core.js'),PipelineCore:require('../public/pipeline-core.js'),PipeChatSchema:require('../public/table-schema.js'),PipeChatSheets:require('../public/spreadsheet-import.js'),PipeChatCsv:require('../public/csv-import.js'),PipeChatSpreadsheetUI:()=>({open:pick}),PipeChatIcons:{}},document:{getElementById:node,querySelector:()=>node('selector'),querySelectorAll:()=>[]},fetch:async(url,options)=>{calls.push({url,payload:JSON.parse(options.body)});const data=handler?await handler(url,calls.at(-1).payload):{...calls.at(-1).payload,updatedAt:'v2'};return {ok:true,json:async()=>data};},clearTimeout(){},setTimeout(){},sessionStorage:{removeItem(){},setItem(){}}};
  context.window.PipeChatSheetTypes=require('../public/spreadsheet-types.js');context.window.PipeChatImportDuplicates=require('../public/import-duplicates.js');
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();','  render=()=>{};updateUsage=()=>{};say=()=>{};toast=()=>{};syncShareFields=()=>{};renderTrust=()=>{};focusTrust=()=>{};window.test={S,openSpreadsheet,confirmSchema,fieldInput,useSchema,useOriginalSheetText,analyzeSheetTypes,clearSheetPreview};'),context);
  const api=context.window.test;Object.assign(api.S,{loaded:true,user:{id:'qa'},setupUseCase:'Sales',usage:{used:1000,remaining:0},updatedAt:'v1'});api.useSchema({status:'pending'});
  return {...api,node,calls,messages};
}
test('spreadsheet at chat cap offers explicit text fallback; only confirmation persists exact populated schema',async()=>{
  const h=harness();await h.openSpreadsheet('setup');assert.equal(h.calls.length,0);assert.equal(h.S.schemaPreview,null);assert.match(h.node('schemaPreview').innerHTML,/Use original text/);h.useOriginalSheetText();assert.equal(h.S.setupRecords.length,2);assert.equal(h.S.records.length,0);
  assert.match(h.node('schemaPreview').innerHTML,/Create populated table/);await h.confirmSchema();assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/crm-data');assert.equal(h.calls[0].payload.expectedUpdatedAt,'v1');assert.equal(h.S.records[0][h.S.tableSchema.fields[0].id],'001');assert.equal(h.S.usage.used,1000);
});
test('cancel and stale/session-switched spreadsheet previews cannot save',async()=>{
  const cancel=harness(async()=>null);await cancel.openSpreadsheet('setup');assert.equal(cancel.S.schemaPreview,null);assert.equal(cancel.calls.length,0);
  const stale=harness();await stale.openSpreadsheet('setup');stale.useOriginalSheetText();stale.S.revision++;await stale.confirmSchema();assert.equal(stale.calls.length,0);
  let done;const switched=harness(()=>new Promise(resolve=>done=resolve));const pending=switched.openSpreadsheet('setup');switched.S.generation++;done({matrix:[['Name'],['Do not load']],name:'old.csv',primary:0});await pending;assert.equal(switched.S.schemaPreview,null);assert.equal(switched.calls.length,0);
});
test('failed or altered save retains preview for explicit recovery without marking onboarding complete',async()=>{
  for(const handler of [()=>{throw Error('offline');},(url,payload)=>({...payload,deals:payload.deals.map(row=>({...row,[payload.tableSchema.fields[0].id]:'changed'})),updatedAt:'v2'})]){
    const h=harness(undefined,handler);await h.openSpreadsheet('setup');h.useOriginalSheetText();await h.confirmSchema();assert.equal(h.S.tableSchema.status,'pending');assert.equal(h.S.records.length,0);assert(h.S.schemaPreview);assert.equal(h.S.setupRecords.length,2);
  }
});

test('AI profiles drive typed preview; one charged request and no save until confirmation',async()=>{
  const h=harness(undefined,(url,payload)=>url.endsWith('ai')?{spreadsheetTypes:{columns:[{index:0,type:'text',reason:'Identifier'},{index:1,type:'number',reason:'Quantity'}]},usage:{used:1,remaining:999}}:{...payload,updatedAt:'v2'});
  h.S.usage={used:0,remaining:1000};await h.openSpreadsheet('setup');
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].payload.spreadsheetBuild.columns[1].distinctCount,2);assert.equal(h.S.schemaPreview.fields[1].type,'number');assert.equal(h.S.setupRecords[1][h.S.schemaPreview.fields[1].id],0);
  assert.match(h.node('schemaPreview').innerHTML,/Column type review/);assert.equal(h.S.records.length,0);assert.equal(h.S.usage.used,1);
  await h.confirmSchema();assert.equal(h.calls.length,2);assert.equal(h.S.records.length,2);assert.equal(h.S.sheetDraft,null);
});

test('failed AI requires explicit retry or original text; late response cannot revive cancelled setup',async()=>{
  const h=harness(undefined,()=>{throw Error('offline');});h.S.usage={remaining:10};await h.openSpreadsheet('setup');
  assert.equal(h.S.schemaPreview,null);assert.match(h.S.sheetDraft.error,/offline/);h.useOriginalSheetText();assert(h.S.schemaPreview.fields.every(f=>f.type==='text'));
  let finish;const late=harness(undefined,()=>new Promise(resolve=>finish=resolve));late.S.usage={remaining:10};const work=late.openSpreadsheet('setup');await new Promise(resolve=>setImmediate(resolve));late.clearSheetPreview();finish({spreadsheetTypes:{columns:[]},usage:{used:1}});await work;assert.equal(late.S.schemaPreview,null);assert.equal(late.S.sheetDraft,null);
});
test('append uploads go through the existing mapping preview and never overwrite the schema',async()=>{
  const h=harness();h.useSchema(require('../public/table-schema.js').legacySchema());h.S.records=[{id:5,account:'Existing'}];await h.openSpreadsheet('append');assert.equal(h.calls.length,0);assert.equal(h.S.pending.kind,'csv-import');assert.match(h.S.pending.error,/Chat allowance exhausted/);assert.equal(h.S.records[0].account,'Existing');
});
test('only AI and spreadsheet build options remain; multiline cells are editable without stripping newlines',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');assert(!html.includes('Build Pipechat Table from Scratch'));assert(!html.includes('Use Default Pipechat Table'));assert.match(html,/id="buildSheetBtn"/);
  const h=harness();assert.match(h.fieldInput({id:'f_notes',name:'Notes',type:'text'},'a\nb'),/<textarea[^>]*>a\nb<\/textarea>/);assert(!h.fieldInput({id:'f_notes',name:'Notes',type:'text'},'<script>bad</script>\n').includes('<script>'));
});
