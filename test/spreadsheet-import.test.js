const test=require('node:test'),assert=require('node:assert/strict');
const Sheets=require('../public/spreadsheet-import.js'),Schema=require('../public/table-schema.js'),Core=require('../public/pipeline-core.js'),Papa=require('../public/vendor/papaparse.min.js'),XLSX=require('../public/vendor/xlsx.full.min.js');
const grid=[[' ID ','Owner','Amount','Amount','','Notes'],['001','Ravi','100','0','','  keep\nall whitespace  '],['002','Sarah','0','$1,200.00','FALSE','=literal text'],['','','','','',''],['003','','-2','N/A','','']];
test('spreadsheet setup preserves headers, order, blanks, zeroes, duplicate labels and exact text',()=>{
  const {schema,records}=Sheets.build(grid,{useCase:'Sales'});
  assert.deepEqual(schema.fields.map(f=>f.name),grid[0]);assert.equal(records.length,4);
  const core=Core.create(schema);
  for(const [index,row] of records.entries())assert.deepEqual(schema.fields.map(f=>String(core.tableValues(row)[f.id]??'')),grid[index+1]);
  assert.equal(schema.fields[2].type,'number');assert.equal(schema.fields[3].type,'text');assert.equal(core.role('owner'),schema.fields[1].id);
  assert.throws(()=>core.fieldName('Amount'),/More than one/);assert.equal(core.fieldName(schema.fields[2].id),schema.fields[2].id);
  assert.equal(core.report(records,{metric:'sum',field:schema.fields[2].id,groupBy:core.role('owner'),chart:'bar'}).data.find(r=>r.label==='Ravi').value,100);
  assert.equal(core.sortRecords(records,{field:schema.fields[2].id,direction:'asc'})[0].id,4);
});
test('CSV source keeps literal values, quoted newlines and interior empty rows',()=>{
  const csv=Papa.unparse(grid);assert.deepEqual(Sheets.fromCsv('\ufeff'+csv+'\r\n',Papa),grid);
  assert.throws(()=>Sheets.fromCsv('a,b\n"unterminated',Papa),/Invalid CSV/);
});
test('spreadsheet limits reject rather than truncate and empty-header tables remain identifiable',()=>{
  assert.throws(()=>Sheets.build([['Name'.repeat(100)],['x']],{useCase:'Other'}),/header/);
  assert.throws(()=>Sheets.build([Array(101).fill('x')],{useCase:'Sales'}),/100/);
  assert.throws(()=>Sheets.build(Array.from({length:2002},()=>['x']),{useCase:'Sales'}),/2,000/);
  assert.throws(()=>Sheets.build([['x'],['bad\0value']],{useCase:'Sales'}),/characters/);
  assert.equal(Sheets.build([['',''],['a','b']],{useCase:'Other',primary:1}).schema.fields[1].role,'primary');
  const built=Sheets.build([['ID'],['1']],{useCase:'Sales'});
  assert.equal(Schema.transition({status:'pending'},built.schema,built.records).source,'spreadsheet');
  assert.throws(()=>Schema.transition(Schema.legacySchema(),built.schema,[]),/source/);
  assert.throws(()=>Schema.transition({status:'pending'},Schema.legacySchema(),[{}]),/empty/);
});
test('Excel reader preserves saved display values and refuses missing formula caches and merges',()=>{
  const ws={'!ref':'A1:D3',A1:{t:'s',v:'ID'},B1:{t:'s',v:'Amount'},C1:{t:'s',v:'Formula'},D1:{t:'s',v:'Date'},A2:{t:'n',v:12,z:'00000'},B2:{t:'n',v:1200,z:'"$"#,##0.00'},C2:{t:'n',v:4,f:'2+2'},D2:{t:'n',v:46000,z:'yyyy-mm-dd'},A3:{t:'s',v:'  Text  '}};
  const matrix=Sheets.fromWorkbook({Sheets:{Data:ws}},'Data',XLSX);
  assert.deepEqual(matrix[1],['00012','$1,200.00','4','2025-12-09']);assert.equal(matrix[2][0],'  Text  ');
  delete ws.C2.v;assert.throws(()=>Sheets.fromWorkbook({Sheets:{Data:ws}},'Data',XLSX),/saved result/);
  ws.C2.v=4;ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:1}}];assert.throws(()=>Sheets.fromWorkbook({Sheets:{Data:ws}},'Data',XLSX),/Merged/);
});
test('canonical inference never converts formatted, uncertain or precision-sensitive text',()=>{
  for(const value of ['001','1.00','$1,234','10%','2026-09-23',' 12 ','9007199254740993','TRUE','N/A','0.10000000000000001']){
    const {schema,records}=Sheets.build([['Name','Value'],['A',value]],{useCase:'Other'});assert.equal(schema.fields[1].type,'text',value);assert.equal(records[0][schema.fields[1].id],value);
  }
});
