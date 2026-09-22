const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../public/csv-import.js');
const C = require('../public/pipeline-core.js');
const Papa = require('../public/vendor/papaparse.min.js');

test('semantic AI mappings append useful fields and leave uncertain cells blank', () => {
  const headers = ['Business','Sales champion','Journey','Contract size','Target signature','Internal memo','Favorite color'];
  const rows = [
    {Business:'Acme', 'Sales champion':'Sarah',Journey:'Quotation delivered','Contract size':'$1,250.50','Target signature':'2026/11/30','Internal memo':'Call first','Favorite color':'red'},
    {Business:'Beta',Journey:'Active','Contract size':'TBD','Target signature':'11/12/26'},
    {'Sales champion':'Daniel','Contract size':'50%','Target signature':'2026-02-30'},
    {'Favorite color':'green'}
  ];
  const result = I.build(headers,rows,{columnMap:{account:'Business',owner:'Sales champion',stage:'Journey',value:'Contract size',close:'Target signature',notes:'Internal memo'},stageMappings:[{source:'Quotation delivered',stage:'Proposal Sent'},{source:'Active',stage:null}]});
  assert.equal(result.records.length,3); assert.equal(result.skipped,1);
  assert.deepEqual(result.records[0],{account:'Acme',stage:'Proposal Sent',value:1250.5,close:'2026-11-30',owner:'Sarah',next:'',follow:'',notes:'Call first'});
  assert.equal(result.records[1].stage,''); assert.equal(result.records[1].value,null); assert.equal(result.records[1].close,'');
  assert.equal(result.records[2].account,''); assert.equal(result.records[2].owner,'Daniel');
  assert.deepEqual(result.ignored,['Favorite color']); assert.equal(result.issues.length,4);
  assert.equal(rows[0].Journey,'Quotation delivered');
});
test('local mapping handles aliases but does not guess broad or competing columns', () => {
  const headers=['Company Name','company_name','Status','Contact name','Revenue','Owner','Deal Amount'];
  const result=I.localMapping(headers).columnMap;
  assert.equal(result.account,null); assert.equal(result.stage,null); assert.equal(result.value,'Deal Amount'); assert.equal(result.owner,'Owner');
});
test('bad model references, duplicate uses and unsupported stage values cannot stop useful rows or invent data', () => {
  const rows=[{Company:'Acme',Stage:'Something',Owner:'Sarah'}];
  const result=I.build(Object.keys(rows[0]),rows,{columnMap:{account:'Company',owner:'Missing',notes:'Company',stage:'Stage'},stageMappings:[{source:'Something',stage:'invented'}]});
  assert.equal(result.records.length,0); assert.equal(result.skipped,1); assert.equal(result.warnings.length,2);
});
test('money parser preserves zero and refuses uncertain currencies, formats and expressions', () => {
  for (const [raw,value] of [['0',0],['USD 1,234.50',1234.5],['US$25',25],['20 USD',20],['$0.50',.5]]) assert.equal(I.amount(raw),value);
  for (const raw of ['EUR 20','CAD $30','USD 1.234,56','1,25','1e3','10k','10-20','20%','about 25','-20','Infinity','NaN','0x10','12.345','1,2,3','1000000000001']) assert.equal(I.amount(raw),null,raw);
});
test('date parser accepts complete unambiguous dates and never guesses locale/year', () => {
  for (const raw of ['2026-11-30','2026/11/30','30 Nov 2026','November 30, 2026']) assert.equal(I.completeDate(raw),'2026-11-30');
  for (const raw of ['11/12/2026','11/30','next Friday','2026-02-30','Nov 2026','2026-13-01']) assert.equal(I.completeDate(raw),'');
});
test('all rows are inspected for bounded representative profiles, including later stage values', () => {
  const rows=Array.from({length:150},(_,i)=>({Company:'Acme',Stage:i===149?'Later stage':'Warm'}));
  const description=I.describe(['Company','Stage'],rows);
  assert.deepEqual(description.columns[1].examples,['Warm','Later stage']);
  assert.equal(I.validateDescription(description).totalRows,150);
  assert.throws(()=>I.describe(['Company','company'],rows));
  assert.throws(()=>I.validateDescription({...description,totalRows:2001}));
});
test('unknown amounts and stages round-trip through storage validation, edits, filters and reports', () => {
  const rows=[{id:1,account:'',stage:'',value:null},{id:2,account:'Acme',stage:'Warm',value:100},{id:3,account:'Free deal',stage:'Warm',value:0}];
  assert.equal(C.validateStoredValue('value',null),null); assert.equal(C.validateStoredValue('stage',''),''); assert.equal(C.validateStoredValue('account',''),'');
  assert.throws(()=>C.validateStoredValue('value',undefined)); assert.throws(()=>C.validateStoredValue('stage','Invented'));
  const spec={metric:'average',field:'value',groupBy:'none',chart:'bar'};
  assert.equal(C.report(rows,spec).data[0].value,50);
  assert.equal(C.report(rows.slice(0,1),spec).data[0].value,null);
  assert.equal(rows.filter(C.predicate({field:'value',operator:'lte',value:0})).length,1);
  assert.equal(rows.filter(C.predicate({field:'value',operator:'is_blank'})).length,1);
  const proposal=C.plan(rows,{action:'update_record',ids:[1],field:'value',value:25});
  assert.equal(C.apply(rows,proposal,'QA')[0].value,25);
  const clear=C.plan(rows,{action:'update_record',ids:[2],field:'value',value:''});
  assert.equal(C.apply(rows,clear,'QA')[1].value,null);
});
test('CSV quoting, BOM, Unicode and missing trailing cells preserve original text', () => {
  const parsed=Papa.parse('\ufeffCompany,Notes,Value\r\n"Acme, Ltd","line 1\nline 2",0\r\nSociété,"<script>do not run</script>"',{header:true,skipEmptyLines:'greedy'});
  const result=I.build(parsed.meta.fields,parsed.data,I.localMapping(parsed.meta.fields));
  assert.equal(result.records[0].account,'Acme, Ltd'); assert.equal(result.records[0].notes,'line 1\nline 2'); assert.equal(result.records[0].value,0);
  assert.equal(result.records[1].value,null); assert.equal(result.records[1].notes,'<script>do not run</script>');
});
