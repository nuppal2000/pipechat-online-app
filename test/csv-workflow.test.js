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
  const context={window:{PipelineCore:C,PipeChatCsv:I,PipeChatIcons:{}},document:{getElementById:node,querySelector:()=>null},Papa,AbortSignal,
    sessionStorage:{removeItem(){}},fetch:async(url,options)=>{calls.push({url,options});return handler(url,options);}};
  const ctx={...context,window:{...context.window,messages}};
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',`render=()=>{};renderTrust=()=>{};focusTrust=()=>{};updateUsage=()=>{};toast=()=>{};say=(text)=>window.messages.push(text);window.test={S,importCsv,analyzeCsvImport,basicCsvImport,confirmDraft,cancelDraft,undo,display};`),ctx);
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
  const request=JSON.parse(h.calls[0].options.body);assert(!request.pipeline.records);assert.equal(request.pipeline.tableSchema,null);assert.equal(request.csvImport.totalRows,2);
  await h.confirmDraft();assert.equal(h.S.records.length,3);assert.deepEqual(h.S.records[0],original);
  assert.equal(h.S.records[2].value,null);assert.equal(h.S.usage.used,1);
  await h.undo();assert.deepEqual(h.S.records,[original]);assert.equal(h.S.usage.used,1);
});
test('exhausted AI requires an explicit basic-mapping choice and never calls the model',async()=>{
  const h=harness(()=>{throw new Error('Unexpected request');});h.S.usage={used:1,remaining:0,paymentRequired:true};
  await h.import('Company,Stage,Value\nAcme,Unknown,not money\nBeta,Warm,0');
  assert.equal(h.calls.length,0);assert.equal(h.S.pending.kind,'csv-import');
  await h.confirmDraft();assert.equal(h.S.records.length,1);assert.equal(h.calls.length,0);
  h.basicCsvImport();assert.match(h.S.pending.note,/Basic mapping \(not AI\)/);assert.equal(h.S.pending.records[0].value,null);assert.equal(h.S.pending.records[0].stage,'');assert.equal(h.S.pending.records[1].value,0);
  h.cancelDraft();assert.equal(h.S.pending,null);assert.equal(h.S.records.length,1);
});
test('AI failure pauses rather than silently falling back; malformed CSV never calls AI',async()=>{
  const h=harness(()=>response(503,{error:'Synthetic model outage'}));
  await h.import('Company,Value\nAcme,no idea');assert.equal(h.S.pending.kind,'csv-import');assert.equal(h.S.pending.records,undefined);assert(h.messages.some(m=>m.includes('No basic mapping was applied')));
  h.basicCsvImport();assert.equal(h.S.pending.records[0].value,null);
  h.cancelDraft();const before=h.calls.length;
  await h.import('Company,Value\nAcme,20,extra');assert.equal(h.calls.length,before);assert.equal(h.S.pending,null);
  await h.import('Company,Company\nA,B');assert.equal(h.calls.length,before);assert.equal(h.S.pending,null);
});
test('late analysis cannot overwrite another user, newer table, or an active draft',async()=>{
  let finish;const h=harness(()=>new Promise(resolve=>finish=resolve));
  const work=h.import(csv);await new Promise(resolve=>setImmediate(resolve));h.S.generation++;h.S.pending=null;finish(response(200,{crmAction:mapping,usage:{used:8}}));await work;
  assert.equal(h.S.pending,null);assert.equal(h.S.usage.used,0);
  const h2=harness(()=>{h2.S.revision++;return response(200,{crmAction:mapping});});await h2.import(csv);assert.equal(h2.S.pending,null);assert.equal(h2.S.records.length,1);
});
test('short rows retain known cells, entirely unrelated rows are not fabricated, failed save preserves preview',async()=>{
  const h=harness(()=>response(429,{error:'Synthetic throttle'}));h.S.health.aiConfigured=false;
  await h.import('Owner,Value,Close date\nSarah');assert.equal(h.calls.length,0);assert.equal(h.S.pending.kind,'csv-import');h.basicCsvImport();assert.equal(h.S.pending.records[0].account,'');assert.equal(h.S.pending.records[0].value,null);
  await h.confirmDraft();assert.equal(h.S.records.length,1);assert.equal(h.S.pending.records.length,1);
  h.cancelDraft();await h.import('Color\nred');h.basicCsvImport();assert.equal(h.S.pending.kind,'csv-import');assert.equal(h.S.pending.records,undefined);assert(h.messages.some(m=>m.includes('No CRM fields')));
});

test('missing usage and health do not bypass semantic AI header matching',async()=>{
  const semantic={action:'import_mapping',columnMap:{account:'Company Name',owner:'Assigned Rep',stage:'Deal Status',value:'Estimated Deal Size',close:'Expected Close',next:'Next Action',follow:'Follow Up Timing',notes:'Source Notes'},stageMappings:[]};
  const h=harness(()=>response(200,{crmAction:semantic,usage:{used:1,limit:1000,remaining:999}}));
  h.S.usage=null;h.S.health=null;
  await h.import('Company Name,Assigned Rep,Deal Status,Estimated Deal Size,Expected Close,Next Action,Follow Up Timing,Source Notes\nCedar QA,Morgan,Discovery,34000,Oct 18 2026,Send outline,Today,Clear fields\nOak QA,Casey,hot,18500,Nov 04 2026,Follow up,Tomorrow,Unclear stage');
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/pipechat-ai');assert.match(h.S.pending.note,/AI-assisted mapping/);
  const [first,second]=h.S.pending.records;
  assert.equal(first.owner,'Morgan');assert.equal(first.stage,'Discovery');assert.equal(first.value,34000);assert.equal(first.close,'2026-10-18');assert.equal(first.next,'Send outline');assert.equal(first.follow,'Today');assert.equal(first.notes,'Clear fields');
  assert.equal(second.stage,'');assert.equal(second.owner,'Casey');assert.equal(second.value,18500);assert.equal(second.close,'2026-11-04');
  assert.deepEqual(h.S.records,[original]);assert.equal(h.S.usage.used,1);
});

test('server quota rejection when client usage is unknown pauses without a partial preview',async()=>{
  const h=harness(()=>response(402,{error:'Chat limit reached',usage:{used:1000,limit:1000,remaining:0,paymentRequired:true}}));h.S.usage=null;
  await h.import('Company,Value\nCedar,40');assert.equal(h.calls.length,1);assert.equal(h.S.pending.kind,'csv-import');assert.equal(h.S.usage.remaining,0);
  await h.analyzeCsvImport();assert.equal(h.calls.length,1);h.basicCsvImport();assert.equal(h.S.pending.records[0].value,40);assert.deepEqual(h.S.records,[original]);
});

test('explicit retry retains the CSV, updates usage once and cannot overlap another attempt',async()=>{
  let finish;const h=harness(()=>h.calls.length===1?response(429,{error:'Temporarily rate limited'}):new Promise(resolve=>finish=resolve));
  await h.import(csv);assert.equal(h.calls.length,1);assert.equal(h.S.pending.kind,'csv-import');assert.equal(h.S.busy,false);
  const retry=h.analyzeCsvImport();await new Promise(resolve=>setImmediate(resolve));await h.analyzeCsvImport();h.basicCsvImport();assert.equal(h.calls.length,2);
  finish(response(200,{crmAction:mapping,usage:{used:1,limit:1000,remaining:999}}));await retry;
  assert.equal(h.S.pending.kind,'add');assert.equal(h.S.pending.records[0].value,1000);assert.equal(h.S.usage.used,1);assert.equal(h.S.records.length,1);
});

test('cancelled or replaced import cannot reappear when analysis completes',async()=>{
  let finish;const h=harness(()=>new Promise(resolve=>finish=resolve));const work=h.import(csv);await new Promise(resolve=>setImmediate(resolve));
  h.cancelDraft();h.S.pending={kind:'editor'};finish(response(200,{crmAction:mapping,usage:{used:1}}));await work;
  assert.equal(h.S.pending.kind,'editor');assert.equal(h.S.records.length,1);assert.equal(h.S.busy,false);
});

test('reading a CSV locks out a second file and discards stale file reads',async()=>{
  let finish;const h=harness(()=>{throw new Error('Unexpected request');});
  const work=h.importCsv({name:'slow.csv',size:40,text:()=>new Promise(resolve=>finish=resolve)});
  await h.import(csv);assert.equal(h.calls.length,0);h.S.revision++;finish('Company\nCedar');await work;
  assert.equal(h.S.pending,null);assert.equal(h.S.busy,false);assert.equal(h.calls.length,0);
});
