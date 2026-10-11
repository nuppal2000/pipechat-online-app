const test=require('node:test'),assert=require('node:assert/strict');
const Csv=require('../public/csv-import.js'),Sheets=require('../public/spreadsheet-import.js');
const Papa=require('../public/vendor/papaparse.min.js'),XLSX=require('../public/vendor/xlsx.full.min.js');

const schema={status:'ready',source:'ai',useCase:'Sales',description:'',title:'Sales',recordLabel:'deal',fields:[
  {id:'f_company',name:'Opportunity Name',type:'text',role:'primary',options:[]},
  {id:'f_rep',name:'Owner',type:'text',role:'owner',options:[]},
  {id:'f_amount',name:'Deal Value',type:'currency',role:'none',options:[]},
  {id:'f_follow',name:'Next Follow-Up Date',type:'date',role:'followup',options:[]},
  {id:'f_contact',name:'Contact',type:'text',role:'none',options:[]},
  {id:'f_comments',name:'Detailed Notes',type:'text',role:'none',options:[]}
]};
const importer=Csv.forTable(schema);
// Exact four-row/six-column report scenario. The report does not publish every
// literal value, so unspecified contact, comment and date values are synthetic.
const fixture=[
  ['Company','Rep','Amount','Follow up','Contact','Comments'],
  [' northstar   DESIGN ','Alex','$13,000.00','2026-10-20','Maya Chen','Incoming detail'],
  ['QA Cedar Labs','Ravi','USD 1,250.50','October 21, 2026','Cedar Contact','Synthetic valid row'],
  ['QA Invalid Labs','Ravi','TBD','not-a-date','Invalid Contact','Two bad cells'],
  ['QA Blank Labs','Sarah','','2026-10-22','Blank Contact','Intentionally blank amount']
];
const analysis={columnMap:Object.fromEntries(schema.fields.map((f,i)=>[f.id,fixture[0][i]])),choiceMappings:[]};
const existing=[{id:42,f_company:'Northstar Design',f_rep:'Alex',f_amount:12000,f_follow:'2026-10-20',f_contact:'',f_comments:'Original notes',history:[{text:'Keep history'}],activity:'Keep activity',health:'Keep health',unrelated:'Keep metadata'}];
const key=(row,field)=>JSON.stringify([row,field]);
function build(matrix=fixture){const source=Sheets.mappingSource(matrix);return importer.build(source.headers,source.rows,analysis,source.source);}
function accepted(review){return Object.fromEntries(review.issues.map(issue=>[key(issue.row,issue.field),'blank']));}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;}

test('objective 9 XLSX fixture reports two invalid cells, one blank, all six mappings and raw coordinates',()=>{
  const ws=XLSX.utils.aoa_to_sheet(fixture),wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Objective 9');
  const decoded=XLSX.read(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
  const matrix=structuredClone(Sheets.fromWorkbook(decoded,'Objective 9',XLSX)),review=build(matrix);
  assert.equal(review.records.length,4);assert.deepEqual(review.sourceRows,[2,3,4,5]);
  assert.deepEqual(review.mapping,analysis.columnMap);assert.deepEqual(review.ignored,[]);
  assert.deepEqual(review.counts,{valid:21,blank:1,invalid:2,unmapped:0});
  assert.equal(review.invalidCount,review.issues.length);assert.equal(review.blankCount,1);assert.equal(review.emptyValueCount,3);
  assert.deepEqual(review.issues.map(i=>[i.row,i.column,i.address,i.sheet,i.field,i.raw,i.rawValue,i.error.code]),[
    [4,3,'C4','Objective 9','f_amount','TBD','TBD','invalid_currency'],
    [4,4,'D4','Objective 9','f_follow','not-a-date','not-a-date','invalid_date']
  ]);
  assert.equal(review.records[1].f_amount,1250.5);assert.equal(review.records[1].f_follow,'2026-10-21');
  assert.equal(review.records[2].f_amount,null);assert.equal(review.records[2].f_follow,'');
  assert.equal(review.cells.find(c=>c.address==='C5').status,'blank');
});

test('CSV delimiters, quoting, newlines and currency/date variations use the same staging path',()=>{
  for(const delimiter of [',',';','\t']){
    const grid=structuredClone(fixture);grid[2][5]='Quoted "text", semicolon;\nand another line';
    const review=build(Sheets.fromCsv('\ufeff'+Papa.unparse(grid,{delimiter}),Papa));
    assert.equal(review.issues.length,2);assert.equal(review.records[1].f_comments,grid[2][5]);
  }
  for(const raw of ['$1,250.50','USD 1250.50','US$1,250.50','1250.50 USD'])assert.equal(Csv.amount(raw),1250.5);
  for(const raw of ['EUR 12','1.234,56','1,25','1e3','25%','TBD','N/A','none','unknown'])assert.equal(Csv.amount(raw),null);
  for(const raw of ['2026/10/21','21 Oct 2026','October 21, 2026','2026-10-21'])assert.equal(Csv.completeDate(raw),'2026-10-21');
  for(const raw of ['10/11/2026','11/10/26','2026-02-30','not-a-date','TBD'])assert.equal(Csv.completeDate(raw),'');
});

test('nonempty placeholders are typed errors, literal text stays text, and zero is not blank',()=>{
  const matrix=[fixture[0],['Unknown','None','0','2024-02-29','N/A','TBD'],['Other','','unknown','N/A','','']];
  const review=build(matrix);
  assert.equal(review.records[0].f_amount,0);assert.equal(review.records[0].f_company,'Unknown');
  assert.equal(review.records[0].f_rep,'None');assert.equal(review.records[0].f_comments,'TBD');
  assert.deepEqual(review.issues.map(c=>c.raw),['unknown','N/A']);
  assert.equal(Csv.describe(fixture[0],Sheets.mappingSource(matrix).rows).columns[2].nonblank,2);
});

test('legacy staging counts every invalid cell, including skipped rows, without counting unmapped fields as errors',()=>{
  const headers=['Amount','Close date'],rows=[{Amount:'TBD','Close date':'not-a-date'},{Amount:'','Close date':''},{Amount:'0','Close date':'2026-10-20'}];
  const review=Csv.build(headers,rows,Csv.localMapping(headers));
  assert.equal(review.issues.length,2);assert.equal(review.invalidCount,2);assert.equal(review.skipped,2);
  assert.deepEqual(review.sourceRows,[4]);assert.equal(review.counts.unmapped,18);
  assert.deepEqual(review.issues.map(i=>[i.row,i.address,i.error.code]),[[2,'A2','invalid_currency'],[2,'B2','invalid_date']]);
});

test('workbook origin, native values, errors and formulas survive mapping without mutating the workbook',()=>{
  const ws={'!ref':'B7:D9',B7:{t:'s',v:'Company'},C7:{t:'s',v:'Amount'},D7:{t:'s',v:'Close date'},
    B8:{t:'s',v:'Acme'},C8:{t:'n',v:1250.5,z:'"$"#,##0.00',f:'1000+250.5'},D8:{t:'n',v:46000,z:'yyyy-mm-dd'},
    B9:{t:'s',v:'Other'},C9:{t:'e',v:7,w:'#DIV/0!'},D9:{t:'s',v:'invalid'}};
  const workbook={Sheets:{Data:ws}},before=structuredClone(workbook);
  const source=Sheets.mappingSource(Sheets.fromWorkbook(workbook,'Data',XLSX));
  const review=Csv.build(source.headers,source.rows,Csv.localMapping(source.headers),source.source);
  assert.deepEqual(workbook,before);assert.deepEqual(review.sourceRows,[8,9]);
  const amount=review.cells.find(c=>c.row===8&&c.field==='value');
  assert.equal(amount.address,'C8');assert.equal(amount.rawValue,1250.5);assert.equal(amount.raw,'$1,250.50');assert.equal(amount.formula,'1000+250.5');
  assert.deepEqual(review.issues.map(c=>c.address),['C9','D9']);assert.equal(review.issues[0].cellType,'e');
});

test('mapping refuses duplicate or blank headers before object conversion can lose cells',()=>{
  for(const headers of [['Amount','amount'],['Company Name','company_name'],['','Other']])assert.throws(()=>Sheets.mappingSource([headers,['1','2']]),/unique, nonblank/);
});

test('skip and keep duplicates have honest counts and never update saved fields',()=>{
  const review=build(),options={importId:'report-9',invalidDecisions:accepted(review)};
  const skip=importer.planImport(existing,review,{...options,mode:'skip'});
  assert.equal(skip.status,'ready');assert.equal(skip.counts.skippedRows,1);assert.equal(skip.counts.insertedRows,3);
  assert.deepEqual(skip.updates,[]);assert.equal(skip.duplicates[0].matches[0].id,42);
  const keep=importer.planImport(existing,review,{...options,mode:'keep'});
  assert.equal(keep.counts.insertedRows,4);assert.equal(keep.counts.skippedRows,0);assert.deepEqual(keep.updates,[]);
  assert.equal(keep.inserts[0].id,43);assert.notEqual(keep.inserts[0].id,42);
});

test('merge is a real field-level proposal with explicit conflict decisions and original IDs',()=>{
  const original=structuredClone(existing),review=freeze(build());
  freeze(existing);
  const options={importId:'merge-9',mode:'merge',invalidDecisions:accepted(review)};
  const pending=importer.planImport(existing,review,options);
  assert.equal(pending.status,'needs-review');
  assert.deepEqual(pending.errors.map(e=>[e.field,e.code]),[['f_amount','field_conflict'],['f_comments','field_conflict']]);
  assert.equal(pending.fieldReviews.find(f=>f.field==='f_contact').status,'fill');
  const plan=importer.planImport(existing,review,{...options,decisions:{[key(2,'f_amount')]:'incoming',[key(2,'f_comments')]:'existing'}});
  assert.equal(plan.status,'ready');assert.deepEqual(plan.updates,[{id:42,expected:{f_amount:12000,f_contact:''},changes:{f_amount:13000,f_contact:'Maya Chen'}}]);
  assert.equal(plan.counts.changedCells,2);assert.equal(plan.counts.updatedRows,1);
  assert.deepEqual(existing,original);
  assert.deepEqual(Csv.applyImportPlan(existing,plan).records,existing);
  assert.deepEqual(Csv.applyImportPlan(existing,plan,{approved:true,cancelled:true}).records,existing);
  const applied=Csv.applyImportPlan(existing,plan,{approved:true});
  assert.equal(applied.records[0].id,42);assert.equal(applied.records[0].f_company,'Northstar Design');assert.equal(applied.records[0].f_amount,13000);
  for(const field of ['history','activity','health','unrelated','f_comments'])assert.deepEqual(applied.records[0][field],existing[0][field]);
  assert.equal(applied.records.length,4);assert.deepEqual(existing,original);
});

test('invalid cells need individual acceptance, row exclusion or corrected source; cancellation always works',()=>{
  const review=build(),options={importId:'errors-9',mode:'skip'};
  const pending=importer.planImport(existing,review,options);
  assert.equal(pending.errors.length,2);assert.equal(pending.status,'needs-review');
  assert.throws(()=>Csv.applyImportPlan(existing,pending,{approved:true}),/Resolve all/);
  assert.equal(Csv.applyImportPlan(existing,pending,{cancelled:true}).status,'cancelled');
  const partial=importer.planImport(existing,review,{...options,invalidDecisions:{[key(4,'f_amount')]:'blank'}});
  assert.equal(partial.errors.length,1);assert.equal(partial.errors[0].field,'f_follow');
  const excluded=importer.planImport(existing,review,{...options,excludedRows:[4]});
  assert.equal(excluded.status,'ready');assert.equal(excluded.inserts.length,2);assert.equal(excluded.counts.excludedRows,1);
  const corrected=structuredClone(fixture);corrected[3][2]='25';corrected[3][3]='2026-10-23';
  assert.equal(importer.planImport(existing,build(corrected),options).status,'ready');
  assert.equal(review.issues[0].raw,'TBD');
});

test('merge never overwrites saved values with blank/invalid input even under use-incoming policy',()=>{
  const grid=[fixture[0],['NORTHSTAR DESIGN','','TBD','not-a-date','','']];
  const review=build(grid),plan=importer.planImport(existing,review,{importId:'blank-safe',mode:'merge',conflictPolicy:'use-incoming',invalidDecisions:accepted(review)});
  assert.equal(plan.status,'ready');assert.deepEqual(plan.updates,[]);assert.equal(plan.counts.unchangedRows,1);
  assert.equal(plan.counts.mergedRows,0);assert.equal(plan.counts.changedCells,0);
});

test('within-file duplicates merge fields into the first stable ID and review sequential conflicts',()=>{
  const grid=[fixture[0],['New Company','','10','','','First note'],[' new   COMPANY ','Ravi','20','','',''],['NEW COMPANY','Sarah','20','','','']];
  const review=build(grid),options={importId:'within-file',mode:'merge'};
  const pending=importer.planImport([],review,options);
  assert.deepEqual(pending.errors.map(e=>[e.row,e.field]),[[3,'f_amount'],[4,'f_rep'],[4,'f_amount']]);
  const resolved=importer.planImport([],review,{...options,decisions:{[key(3,'f_amount')]:'incoming',[key(4,'f_rep')]:'existing'}});
  assert.equal(resolved.status,'ready');assert.equal(resolved.inserts.length,1);assert.deepEqual(resolved.updates,[]);
  assert.equal(resolved.inserts[0].id,1);assert.equal(resolved.inserts[0].f_rep,'Ravi');assert.equal(resolved.inserts[0].f_amount,20);assert.equal(resolved.inserts[0].f_comments,'First note');
  assert.equal(resolved.duplicates.length,2);
  const skip=importer.planImport([],review,{...options,mode:'skip'});assert.equal(skip.counts.skippedRows,2);assert.equal(skip.inserts[0].f_rep,'');
});

test('ambiguous saved duplicate names require a specific ID and normalized matching does not remove accents',()=>{
  const review=build([fixture[0],fixture[1]]),saved=[...existing,{...existing[0],id:90,f_company:' NORTHSTAR  design '}];
  const options={importId:'ambiguous',mode:'merge',conflictPolicy:'preserve-existing'};
  const pending=importer.planImport(saved,review,options);assert.equal(pending.errors[0].code,'ambiguous_duplicate');assert.deepEqual(pending.updates,[]);
  const chosen=importer.planImport(saved,review,{...options,targets:{2:90}});
  assert.equal(chosen.status,'ready');assert.equal(chosen.updates[0].id,90);
  assert.notEqual(Csv.duplicateKey('Cafe'),Csv.duplicateKey('Caf\u00e9'));
  assert.equal(Csv.duplicateKey('Caf\u00e9'),Csv.duplicateKey('Cafe\u0301'));
});

test('approval receipts make exact replay idempotent; stale plans and reused IDs with changed content are rejected',()=>{
  const review=build(),options={importId:'retry-9',mode:'merge',conflictPolicy:'preserve-existing',invalidDecisions:accepted(review)};
  const plan=importer.planImport(existing,review,options);
  assert.deepEqual(plan,importer.planImport(existing,review,options));
  const applied=Csv.applyImportPlan(existing,plan,{approved:true});
  const replay=Csv.applyImportPlan(applied.records,plan,{approved:true,receipts:applied.receipts});
  assert.equal(replay.status,'already-applied');assert.deepEqual(replay.records,applied.records);assert.deepEqual(replay.receipts,applied.receipts);
  assert.throws(()=>Csv.applyImportPlan(applied.records,plan,{approved:true}),/table changed/);
  assert.throws(()=>Csv.applyImportPlan(existing,{...plan,mode:'keep'},{approved:true,receipts:applied.receipts}),/different plan/);
  const changed=structuredClone(existing);changed[0].f_comments='Concurrent edit';
  assert.throws(()=>Csv.applyImportPlan(changed,plan,{approved:true}),/table changed/);
  assert.equal(Csv.applyImportPlan(existing,plan,{approved:'true'}).status,'unapproved');
});

test('blank primary names and protected fields cannot silently enter an import plan',()=>{
  const review=build([fixture[0],['','Ravi','25','','','']]);
  const plan=importer.planImport([],review,{importId:'unnamed'});assert.equal(plan.errors[0].code,'missing_primary');assert.equal(plan.inserts.length,0);
  assert.throws(()=>Csv.planImport([],review,{importId:'bad',primary:'id',fieldIds:['id']}),/destination field IDs/);
});

test('typed number, choice and custom date cells retain independent errors and valid zeroes',()=>{
  const customFields=[{id:'cf_review_date',name:'Review date',type:'date'}];
  const typed=Csv.forTable({...schema,fields:[schema.fields[0],{id:'f_count',name:'Count',type:'number',role:'none',options:[]},{id:'f_status',name:'Status',type:'choice',role:'status',options:['Ready','Done']}]},customFields);
  const headers=['Company','Count','Status','Review date'],rows=[
    {Company:'A',Count:' 1,234.50 ',Status:' ready ','Review date':'2026/10/21'},
    {Company:'B',Count:'TBD',Status:'Unknown','Review date':'not-a-date'},
    {Company:'C',Count:0,Status:'','Review date':''}
  ];
  const review=typed.build(headers,rows,{columnMap:{f_company:'Company',f_count:'Count',f_status:'Status',cf_review_date:'Review date'}});
  assert.equal(review.records[0].f_count,1234.5);assert.equal(review.records[0].f_status,'Ready');
  assert.equal(review.records[2].f_count,0);assert.equal(review.invalidCount,3);
  assert.deepEqual(review.issues.map(cell=>cell.error.code),['invalid_number','invalid_choice','invalid_date']);
  assert.equal(review.cells.find(cell=>cell.row===4&&cell.field==='f_count').raw,0);
  const plan=typed.planImport([],review,{importId:'custom',invalidDecisions:accepted(review)});
  assert.equal(plan.status,'ready');assert.equal(plan.inserts[0].cf_review_date,'2026-10-21');
});

test('all-matched merges report unchanged, while repeated input with a fresh plan cannot insert duplicates',()=>{
  const review=build([fixture[0],fixture[1]]),options={importId:'first',mode:'merge',conflictPolicy:'use-incoming'};
  const applied=Csv.applyImportPlan(existing,importer.planImport(existing,review,options),{approved:true});
  const repeated=importer.planImport(applied.records,review,{...options,importId:'second'});
  assert.equal(repeated.status,'ready');assert.deepEqual(repeated.inserts,[]);assert.deepEqual(repeated.updates,[]);
  assert.equal(repeated.counts.unchangedRows,1);assert.equal(repeated.counts.mergedRows,0);
});
