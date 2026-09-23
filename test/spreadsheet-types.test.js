const test=require('node:test'),assert=require('node:assert/strict');
const T=require('../public/spreadsheet-types.js'),D=require('../public/import-duplicates.js');
const options={useCase:'Sales',primary:0,name:'Data.csv',idPrefix:'qa'};
const analysis=types=>({columns:types.map((type,index)=>({index,type,reason:'Synthetic type classification'}))});
const grid=[['Company','Stage','Amount','Close','Notes'],['A','Warm','$1,200.50','Oct 5 2026','Long note'],['B','Won','0','2026-11-02','Other'],['C','Warm','25','2026/12/01','Something else'],['D','Won','','','']];
test('AI suggestions are validated against all cells, preserve headers and derive complete dropdown options',()=>{
  const result=T.build(grid,options,analysis(['text','choice','currency','date','text']));
  assert.deepEqual(result.schema.fields.map(f=>f.name),grid[0]);assert.deepEqual(result.schema.fields[1].options,['Warm','Won']);
  assert.equal(result.records[0].f_qa_2,1200.5);assert.equal(result.records[1].f_qa_2,0);assert.equal(result.records[3].f_qa_2,null);assert.equal(result.records[0].f_qa_3,'2026-10-05');assert.equal(result.records[3].f_qa_3,'');
  assert.equal(result.schema.fields[0].role,'primary');assert.equal(result.records[0].f_qa_4,'Long note');
});
test('invalid or ambiguous dates, precision, identifiers and mixed values keep whole columns as original text',()=>{
  for(const [type,values] of [['date',['Oct 5 2026','03/04/2026']],['date',['2026-02-30','2026-01-01']],['number',['001','002']],['number',['10','TBD']],['currency',['$1.001','$2']],['number',['1234567890123456','1']],['choice',['A','a','A','a']],['choice',[' A','B',' A','B']]]){
    const result=T.build([['Name','Column'],...values.map((value,i)=>[String(i),value])],options,analysis(['number',type]));
    assert.deepEqual(result.schema.fields.map(f=>f.type),['text','text']);assert.deepEqual(result.records.map(r=>r.f_qa_1),values);
  }
});
test('unique or empty categorical columns remain text; all values beyond sampled examples are validated',()=>{
  const matrix=[['ID','Status'],...Array.from({length:80},(_,i)=>[String(i),'Warm'])];matrix.push(['last','x'.repeat(81)]);
  const profile=T.describe(matrix,options);assert.equal(profile.totalRows,81);assert.equal(profile.columns[1].distinctCount,2);
  assert.equal(T.build(matrix,options,analysis(['text','choice'])).schema.fields[1].type,'text');
  for(const values of [['a','b'],['','']])assert.equal(T.build([['ID','Status'],...values.map((v,i)=>[String(i),v])],options,analysis(['text','choice'])).schema.fields[1].type,'text');
});
test('duplicate and blank headers are indexed; untrusted or incomplete model output fails closed',()=>{
  const matrix=[['Name','',''],['A','-2','3.25']],p=T.describe(matrix,options);assert.deepEqual(p.columns.map(c=>c.index),[0,1,2]);
  const out=T.build(matrix,options,analysis(['text','number','number']));assert.equal(out.records[0].f_qa_1,-2);assert.equal(out.schema.fields[1].name,'');
  assert.throws(()=>T.validateAnalysis({columns:[{index:0,type:'text',reason:''},{index:0,type:'text',reason:''}]},2));
  assert.throws(()=>T.validateAnalysis(analysis(['text']),2));assert.throws(()=>T.validateDescription({...p,primary:99}));
  assert.throws(()=>T.validateAnalysis(analysis(['javascript']),1));
});
test('original-text fallback preserves all strings and duplicate planner uses dynamic primary, never fuzzy identity',()=>{
  const result=T.asText(grid,options);assert(result.schema.fields.every(f=>f.type==='text'));assert.deepEqual(result.records.map(r=>Object.keys(r).filter(k=>k.startsWith('f_')).map(k=>r[k])),grid.slice(1));
  const incoming=[{f_name:' c '},{f_name:'New'},{f_name:'NEW'},{f_name:''},{f_name:''},{f_name:'Cafe'},{f_name:'Caf\u00e9'}];
  const review=D.review([{f_name:'C'},{f_name:'C'}],incoming,'f_name');assert.equal(review.existingMatches,1);assert.equal(review.fileMatches,1);assert.deepEqual(review.records,incoming.slice(1).filter((_,i)=>i!==1));
});
