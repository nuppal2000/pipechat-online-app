const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto').webcrypto,fixture=require('./fixtures/import-ui-fixture.cjs');
const {createHash}=require('node:crypto'),{prepareMetadata,validateReceipt}=require('../lib/action-journal.js');
const Sheets=require('../public/spreadsheet-import.js'),XLSX=require('../public/vendor/xlsx.full.min.js');
const source=fs.readFileSync(path.join(__dirname,'../public/pipechat.js'),'utf8').replace(/\r\n/g,'\n');
function harness({save,hash=crypto}={}){
  const nodes=new Map(),saves=[],calls=[],messages=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',classList:{add(){},remove(){}},insertAdjacentHTML(position,html){this.innerHTML+=html;}});return nodes.get(id);};
  const window={PipeChatSchema:require('../public/table-schema.js'),PipelineCore:require('../public/pipeline-core.js'),PipeChatCsv:require('../public/csv-import.js'),PipeChatInspector:require('../public/inspector-core.js'),PipeChatTodo:require('../public/todo-core.js'),PipeChatIcons:{},saves,messages};
  const context={window,crypto:hash,TextEncoder,AbortSignal,document:{getElementById:node,querySelector:()=>null},sessionStorage:{removeItem(){}},fetch:async(url,options)=>{
    const payload=JSON.parse(options.body);calls.push({url,payload});
    if(save)await save(payload,calls.length);
    return {ok:true,json:async()=>({...payload,updatedAt:'v'+(calls.length+1)})};
  }};
  const injection=`render=()=>{};renderTrust=()=>{if(S.pending?.importReview)renderCsv(S.pending);else $('trustBody').innerHTML='';};focusTrust=()=>{};updateUsage=()=>{};toast=()=>{};say=text=>window.messages.push(text);const actualPersist=persist;persist=(next,label,options)=>{window.saves.push({next:C.clone(next),options:C.clone(options)});return actualPersist(next,label,options);};window.test={S,useSchema,previewCsvImport,confirmDraft,cancelDraft,chooseImportDuplicates,changeImportReview,handleImportClick,handleImportChange,renderCsv};`;
  vm.runInNewContext(source.replace('  wire();\n  restoreSession();',injection),context);
  const h=window.test;h.useSchema(fixture.schema);
  Object.assign(h.S,{records:structuredClone(fixture.records),user:{id:'qa',name:'Local QA'},loaded:true,updatedAt:'v1'});
  function start(matrix=fixture.matrix){
    const sheet=XLSX.utils.aoa_to_sheet(matrix),input=Sheets.mappingSource(structuredClone(Sheets.fromWorkbook({Sheets:{'Objective 9':sheet}},'Objective 9',XLSX)));
    const draft={kind:'csv-import',name:'objective9.xlsx',...input,revision:h.S.revision,generation:h.S.generation};h.S.pending=draft;
    h.previewCsvImport(draft,fixture.analysis,'AI-assisted mapping.');return draft;
  }
  const cell=(row,field)=>h.S.pending.importReview.cells.findIndex(c=>c.row===row&&c.field===field);
  const change=(attribute,index,value)=>h.handleImportChange({target:{dataset:{[attribute]:String(index)},value,checked:!!value}});
  const correct=(row,field,value)=>{const index=cell(row,field);node('import-cell-'+index).value=value;h.handleImportClick({target:{closest:selector=>selector==='[data-import-correct]'?{dataset:{importCorrect:String(index)}}:null}});};
  const chooseConflict=(field,value)=>change('importConflict',h.S.pending.importPlan.fieldReviews.findIndex(f=>f.field===field&&f.status==='conflict'),value);
  return {...h,start,node,saves,calls,messages,cell,change,correct,chooseConflict,html:()=>node('trustBody').innerHTML};
}

test('XLSX import UI exposes both raw invalid cells, original coordinates, and explicit duplicate modes',async()=>{
  const h=harness();h.start();
  assert.match(h.html(),/2 invalid cells \/ 1 blank cells/);assert.match(h.html(),/Objective 9 \/ C4/);assert.match(h.html(),/TBD/);assert.match(h.html(),/not-a-date/);
  for(const mode of ['skip','keep','merge'])assert.match(h.html(),new RegExp('data-import-duplicates="'+mode+'"'));
  assert.doesNotMatch(h.html(),/Merge duplicates/);assert.equal(h.S.pending.importPlan.status,'needs-review');
  await h.confirmDraft();assert.equal(h.calls.length,0);assert.deepEqual(h.S.records,fixture.records);
});

test('a pending import shows saving, not the retry message reserved for uncertain failures',async()=>{
  let release,started;const waiting=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  const h=harness({save:async()=>{started();await waiting;}});h.start([fixture.matrix[0],fixture.matrix[2]]);
  const saving=h.confirmDraft();await entered;
  assert.equal(h.S.pending.importConfirmPending,true);assert.equal(h.node('trustStatus').textContent,'Saving the reviewed import...');
  assert.match(h.html(),/>Saving\.\.\.<\/button>/);assert.doesNotMatch(h.html(),/Retry same import/);
  release();await saving;assert.equal(h.S.pending,null);assert.equal(h.calls.length,1);
});

test('merge UI corrects raw cells, resolves field conflicts, and persists actual updates with receipt metadata',async()=>{
  const h=harness();const draft=h.start();h.chooseImportDuplicates('merge');
  assert.match(h.html(),/Conflict choice/);assert.match(h.html(),/Original notes/);
  h.correct(4,'f_amount','USD 75.25');assert.equal(h.S.pending.importReview.invalidCount,1);assert.match(h.html(),/Original: <q[^>]*>TBD/);
  assert.equal(draft.originalRows[2].Amount,'TBD');assert.equal(draft.rows[2].Amount,'USD 75.25');
  h.change('importBlank',h.cell(4,'f_follow'),true);
  h.chooseConflict('f_amount','incoming');h.chooseConflict('f_comments','existing');
  assert.equal(h.S.pending.importPlan.status,'ready');assert.match(h.html(),/1 existing records changed \/ 2 changed saved cells/);
  assert.deepEqual(h.S.records,fixture.records);await h.confirmDraft();
  assert.equal(h.calls.length,1);assert.equal(h.S.records.length,4);assert.equal(h.S.records[0].id,42);
  assert.equal(h.S.records[0].f_amount,13000);assert.equal(h.S.records[0].f_comments,'Original notes');assert.equal(h.S.records[0].f_contact,'Maya Chen');
  assert.equal(h.S.records[2].f_amount,75.25);assert.equal(h.S.records[2].f_follow,'');
  assert.equal(h.saves[0].options.exactRecords,true);assert.equal(h.saves[0].options.importReceipt.id,draft.importId);assert.match(h.saves[0].options.importReceipt.digest,/^[a-f0-9]{64}$/);
});

test('Skip and Keep differ from Merge; excluded invalid rows never appear in committed records',async()=>{
  for(const [mode,count] of [['skip',3],['keep',4]]){
    const h=harness();h.start();h.chooseImportDuplicates(mode);h.change('importExclude',4,true);
    assert.equal(h.S.pending.importPlan.status,'ready');assert.deepEqual(Array.from(h.S.pending.importPlan.updates),[]);
    await h.confirmDraft();assert.equal(h.S.records.length,count);assert.deepEqual(h.S.records[0],fixture.records[0]);
    assert(!h.S.records.some(row=>row.f_company==='QA Invalid Labs'));
  }
});

test('UI import receipts use exact SHA-256 envelopes and accepted journal identities',async()=>{
  const h=harness();h.start([fixture.matrix[0],fixture.matrix[2]]);
  const p=h.S.pending,envelope=JSON.stringify({version:1,workspaceVersion:p.importVersion,schema:p.importSchema,plan:p.importPlan});
  await h.confirmDraft();
  const receipt=JSON.parse(JSON.stringify(h.saves[0].options.importReceipt));
  assert.equal(receipt.id,p.importPlan.importId);
  assert.match(receipt.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(receipt.id,/^[A-Za-z0-9_-]{1,200}$/);
  assert.equal(receipt.digest,createHash('sha256').update(envelope,'utf8').digest('hex'));
  const metadata=prepareMetadata({importReceipt:receipt},h.calls[0].payload);
  assert.deepEqual(metadata.importReceipt,receipt);
  assert.deepEqual(validateReceipt({...metadata,formatVersion:1,undoOf:null,beforeVersion:'v1',afterVersion:'v2'}).importReceipt,receipt);
  const changedDigest=createHash('sha256').update(envelope+' ').digest('hex');
  assert.notEqual(changedDigest,receipt.digest);
  assert.equal(prepareMetadata({importReceipt:{...receipt,digest:changedDigest}},{changed:true}).actionId,metadata.actionId);
  assert.throws(()=>prepareMetadata({importReceipt:{...receipt,digest:receipt.digest.toUpperCase()}},{}),/Invalid action/);
  assert.throws(()=>prepareMetadata({importReceipt:{...receipt,id:'import/invalid'}},{}),/Invalid action/);
});

test('invalid corrections cannot bypass confirmation; accepting each blank is explicit and reversible',async()=>{
  const h=harness();h.start();h.chooseImportDuplicates('skip');h.correct(4,'f_amount','still not a number');
  assert.equal(h.S.pending.importReview.invalidCount,2);await h.confirmDraft();assert.equal(h.saves.length,0);
  h.change('importBlank',h.cell(4,'f_amount'),true);assert.equal(h.S.pending.importPlan.errors.length,1);
  h.change('importBlank',h.cell(4,'f_amount'),false);assert.equal(h.S.pending.importPlan.errors.length,2);
  h.change('importExclude',4,true);assert.equal(h.S.pending.importPlan.errors.length,0);
  h.change('importExclude',4,false);assert.equal(h.S.pending.importPlan.errors.length,2);
  h.cancelDraft();assert.equal(h.S.pending,null);assert.deepEqual(h.S.records,fixture.records);assert.equal(h.saves.length,0);
});

test('changing a corrected conflicting value discards prior field decisions without mutating stored records',()=>{
  const h=harness();h.start();h.chooseImportDuplicates('merge');h.chooseConflict('f_amount','incoming');h.chooseConflict('f_comments','existing');
  h.correct(4,'f_amount','90');
  assert(h.S.pending.importPlan.errors.some(e=>e.code==='field_conflict'&&e.field==='f_amount'));
  assert.deepEqual(h.S.records,fixture.records);
});

test('cancellation during receipt hashing prevents a save and duplicate confirmations cannot double-submit',async()=>{
  let release;const deferred=new Promise(resolve=>release=resolve);
  const hash={randomUUID:()=>crypto.randomUUID(),subtle:{digest:async(...args)=>{await deferred;return crypto.subtle.digest(...args);}}};
  const h=harness({hash});h.start([fixture.matrix[0],fixture.matrix[2]]);
  const first=h.confirmDraft();await h.confirmDraft();assert.equal(h.saves.length,0);h.cancelDraft();release();await first;
  assert.equal(h.saves.length,0);assert.equal(h.S.pending,null);
  const other=harness();other.start([fixture.matrix[0],fixture.matrix[2]]);await Promise.all([other.confirmDraft(),other.confirmDraft()]);assert.equal(other.saves.length,1);
});

test('failed save keeps an immutable retry with identical import ID and digest',async()=>{
  const h=harness({save:async(payload,attempt)=>{if(attempt===1)throw Error('Synthetic offline failure');}});h.start([fixture.matrix[0],fixture.matrix[2]]);
  await h.confirmDraft();const p=h.S.pending;assert(p.importAttempted);assert.match(h.html(),/Retry same import/);
  h.chooseImportDuplicates('keep');assert.equal(h.S.pending,p);
  await h.confirmDraft();assert.equal(h.saves.length,2);assert.deepEqual(h.saves[0].options.importReceipt,h.saves[1].options.importReceipt);
  assert.deepEqual(h.saves[0].next,h.saves[1].next);assert.equal(h.S.records.length,2);
});

test('stale revision, session and schema prevent review changes or confirmation',async()=>{
  for(const mutation of [h=>h.S.revision++,h=>h.S.generation++,h=>h.S.customFields=[{id:'cf_new',name:'New',type:'text'}]]){
    const h=harness();h.start();mutation(h);h.chooseImportDuplicates('skip');assert.equal(h.S.pending,null);assert.equal(h.saves.length,0);
  }
  const h=harness();h.start([fixture.matrix[0],fixture.matrix[2]]);h.S.revision++;await h.confirmDraft();assert.equal(h.S.pending,null);assert.equal(h.saves.length,0);
});

test('raw cells and corrections are escaped, and all errors remain reachable through pagination',()=>{
  const h=harness(),matrix=[fixture.matrix[0],...Array.from({length:22},(_,i)=>['Row '+i,'','<img src=x onerror=alert(1)>','','',''])];h.start(matrix);
  assert.match(h.html(),/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(h.html(),/<img src=x/);
  assert.match(h.html(),/Page 1 of 2/);assert.equal((h.html().match(/data-import-correct=/g)||[]).length,20);
  h.handleImportClick({target:{closest:selector=>selector==='[data-import-page]'?{dataset:{importPage:'1'}}:null}});
  assert.match(h.html(),/Page 2 of 2/);assert.equal((h.html().match(/data-import-correct=/g)||[]).length,2);
});

test('unusable source rows still expose raw errors for correction instead of disappearing',()=>{
  const h=harness();h.start([fixture.matrix[0],['','','TBD','','','']]);
  assert.equal(h.S.pending.kind,'csv-import');assert.match(h.html(),/TBD/);assert.match(h.html(),/data-import-correct/);
  h.correct(2,'f_amount','25');assert.equal(h.S.pending.missingPrimary,true);assert.match(h.html(),/importPrimarySource/);
  h.correct(2,'f_company','Recovered');assert.equal(h.S.pending.records[0].f_company,'Recovered');
});

test('stage translation proposals remain visible and unchanged until confirmation',async()=>{
  const h=harness();h.useSchema(null);h.S.records=[];
  const draft={kind:'csv-import',name:'stages.csv',headers:['Company','Stage'],rows:[{Company:'Example',Stage:'Quotation delivered'}],revision:h.S.revision,generation:h.S.generation};h.S.pending=draft;
  h.previewCsvImport(draft,{columnMap:{account:'Company',stage:'Stage'},stageMappings:[{source:'Quotation delivered',stage:'Proposal Sent'}]},'AI-assisted mapping.');
  assert.match(h.html(),/Proposed dropdown translations/);assert.match(h.html(),/Quotation delivered/);assert.match(h.html(),/Proposal Sent/);
  assert.equal(h.S.pending.records[0].stage,'Proposal Sent');assert.equal(h.S.records.length,0);
  await h.confirmDraft();assert.equal(h.S.records[0].stage,'Proposal Sent');
});

test('a version change during receipt hashing cannot reach persistence',async()=>{
  let release;const deferred=new Promise(resolve=>release=resolve);
  const hash={randomUUID:()=>crypto.randomUUID(),subtle:{digest:async(...args)=>{await deferred;return crypto.subtle.digest(...args);}}};
  const h=harness({hash});h.start([fixture.matrix[0],fixture.matrix[2]]);
  const confirming=h.confirmDraft();h.S.updatedAt='another-version';release();await confirming;
  assert.equal(h.saves.length,0);assert(h.messages.some(message=>message.includes('workspace changed')));
});
