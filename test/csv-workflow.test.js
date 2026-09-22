const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const C=require('../public/pipeline-core.js');
const I=require('../public/csv-import.js');
const Papa=require('../public/vendor/papaparse.min.js');
const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
const original={id:8,account:'Existing',stage:'Warm',value:500,owner:'A',close:'',next:'',follow:'',notes:'Keep me',history:[]};
function harness(handler) {
  const nodes=new Map(),calls=[],messages=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',classList:{add(){},remove(){}},insertAdjacentHTML(){}});return nodes.get(id);};
  const context={window:{PipelineCore:C,PipeChatCsv:I,PipeChatIcons:{}},document:{getElementById:node},Papa,AbortSignal,
    sessionStorage:{removeItem(){}},fetch:async(url,options)=>{calls.push({url,options});return handler(url,options);}};
  const ctx={...context,window:{...context.window,messages}};
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>{};renderTrust=()=>{};focusTrust=()=>{};updateUsage=()=>{};toast=()=>{};say=(text)=>window.messages.push(text);window.test={S,importCsv,confirmDraft,cancelDraft,undo,display};`),ctx);
  const h=ctx.window.test;Object.assign(h.S,{records:[structuredClone(original)],user:{id:1,name:'QA'},loaded:true,updatedAt:'v1',usage:{used:0,remaining:10},health:{aiConfigured:true}});
  return {...h,calls,messages,node,import:csv=>h.importCsv({name:'synthetic.csv',size:csv.length,text:async()=>csv})};
}
const response=(status,data)=>({ok:status<400,status,json:async()=>data});
const mapping={action:'import_mapping',columnMap:{account:'Business',stage:'Journey',value:'Size'},stageMappings:[{source:'Quotation delivered',stage:'Proposal Sent'}]};
const csv='Business,Journey,Size,Unrelated\nAcme,Quotation delivered,"$1,000",red\nBeta,Active,TBD,blue';
test('AI import previews blanks, appends only after confirmation and supports undo',async()=>{
  const h=harness((url,options)=>url.endsWith('ai')?response(200,{crmAction:mapping,usage:{used:1,remaining:9}}):response(200,{deals:JSON.parse(options.body).deals,updatedAt:'v2'}));
  await h.import(csv);
  assert.equal(h.calls.length,1); assert.deepEqual(h.S.records,[original]);
  assert.equal(h.S.pending.records[0].id,9); assert.equal(h.S.pending.records[0].stage,'Proposal Sent');
  assert.equal(h.S.pending.records[1].stage,''); assert.equal(h.S.pending.records[1].value,null);
  assert.equal(h.S.pending.importReview.issues.length,1); assert.equal(h.display('value',null),'Not set'); assert.equal(h.display('value',0),'$0');
  const request=JSON.parse(h.calls[0].options.body);assert(!request.pipeline);assert.equal(request.csvImport.totalRows,2);
  await h.confirmDraft();assert.equal(h.S.records.length,3);assert.deepEqual(h.S.records[0],original);
  assert.equal(h.S.records[2].value,null);assert.equal(h.S.usage.used,1);
  await h.undo();assert.deepEqual(h.S.records,[original]);assert.equal(h.S.usage.used,1);
});
test('exhausted or disconnected AI imports recognized columns without requests to AI',async()=>{
  const h=harness(()=>{throw new Error('Unexpected request');});h.S.usage={used:1,remaining:0,paymentRequired:true};
  await h.import('Company,Stage,Value\nAcme,Unknown,not money\nBeta,Warm,0');
  assert.equal(h.calls.length,0);assert.equal(h.S.pending.records[0].value,null);assert.equal(h.S.pending.records[0].stage,'');assert.equal(h.S.pending.records[1].value,0);
  h.cancelDraft();assert.equal(h.S.pending,null);assert.equal(h.S.records.length,1);
});
test('AI failure is disclosed and falls back; malformed CSV cannot call AI or change records',async()=>{
  const h=harness(()=>response(503,{error:'Synthetic model outage'}));
  await h.import('Company,Value\nAcme,no idea');assert.equal(h.S.pending.records[0].value,null);assert(h.messages.some(m=>m.includes('AI mapping was unavailable')));
  h.cancelDraft();const before=h.calls.length;
  await h.import('Company,Value\nAcme,20,extra');assert.equal(h.calls.length,before);assert.equal(h.S.pending,null);
  await h.import('Company,Company\nA,B');assert.equal(h.calls.length,before);assert.equal(h.S.pending,null);
});
test('late analysis cannot overwrite another user, newer table, or an active draft',async()=>{
  let finish;const h=harness(()=>new Promise(resolve=>finish=resolve));
  const work=h.import(csv);await new Promise(resolve=>setImmediate(resolve));h.S.generation++;finish(response(200,{crmAction:mapping,usage:{used:8}}));await work;
  assert.equal(h.S.pending,null);assert.equal(h.S.usage.used,0);
  const h2=harness(()=>{h2.S.revision++;return response(200,{crmAction:mapping});});await h2.import(csv);assert.equal(h2.S.pending,null);assert.equal(h2.S.records.length,1);
});
test('short rows retain known cells, entirely unrelated rows are not fabricated, failed save preserves preview',async()=>{
  const h=harness(()=>response(429,{error:'Synthetic throttle'}));h.S.health.aiConfigured=false;
  await h.import('Owner,Value,Close date\nSarah');assert.equal(h.S.pending.records[0].account,'');assert.equal(h.S.pending.records[0].value,null);
  await h.confirmDraft();assert.equal(h.S.records.length,1);assert.equal(h.S.pending.records.length,1);
  h.cancelDraft();await h.import('Color\nred');assert.equal(h.S.pending,null);assert(h.messages.some(m=>m.includes('No CRM fields')));
});
