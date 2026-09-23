const test=require('node:test'),assert=require('node:assert/strict'),PDF=require('../public/dashboard-pdf');
const sample={workspace:'Recruiting',exportedAt:'Sep 23, 2026',title:'Average score',kpis:[{label:'Average score',value:'0'},{label:'Stale candidates',value:'3'}],filters:['Owners: Ravi, Sarah'],caption:'2 matching records.',headings:['Recruiter','Average score','Records'],rows:[['Ravi','0','1'],['Sarah','Not set','1']]};
test('PDF includes current KPI values, filtered summary, chart-mode KPIs and literal user content',()=>{
  const doc=PDF.definition({...sample,chartKpis:[{label:'Ravi',value:'0'}],title:{url:'https://invalid.test'}}),serialized=JSON.stringify(doc.content);
  assert.match(serialized,/Owners: Ravi, Sarah/);assert.match(serialized,/Not set/);assert.match(serialized,/Stale candidates/);assert.match(serialized,/\[object Object\]/);
  assert.equal(doc.pageOrientation,'landscape');assert.equal(doc.content.at(-1).table.headerRows,1);assert.equal(doc.content.at(-1).table.body.length,3);
  assert.throws(()=>PDF.definition({...sample,chart:'https://invalid.test/image.png'}));
});
test('PDF pagination accepts many KPIs and all report rows without truncation',()=>{
  const doc=PDF.definition({...sample,kpis:Array.from({length:13},(_,i)=>({label:'KPI '+i,value:i})),rows:Array.from({length:600},(_,i)=>['Record '+i,i,1])});
  assert.equal(doc.content.at(-1).table.body.length,601);assert.match(JSON.stringify(doc),/Record 599/);assert.match(JSON.stringify(doc),/KPI 12/);
});
test('vendored PDF engine produces a real multi-page PDF with embedded fonts',{timeout:60000},async()=>{
  const engine=require('../public/vendor/pdfmake-0.3.11.min.js');engine.addVirtualFileSystem(require('../public/vendor/pdfmake-0.3.11-fonts.js'));
  const buffer=await engine.createPdf(PDF.definition({...sample,rows:Array.from({length:100},(_,i)=>['Fran\u00e7ois '+i,i,1])})).getBuffer();
  assert.equal(buffer.slice(0,5).toString(),'%PDF-');assert.match(buffer.toString('latin1'),/\/FontFile2/);assert.ok((buffer.toString('latin1').match(/\/Type \/Page\b/g)||[]).length>1);
});
