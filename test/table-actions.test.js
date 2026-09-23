const test=require('node:test'),assert=require('node:assert/strict'),C=require('../public/pipeline-core.js');
const rows=[{id:1,account:'Alpha',value:0,history:['one']},{id:2,account:'Hidden',value:20,history:['two']},{id:3,account:'Uppal Co',value:30,history:['three']},{id:4,account:'Last',value:40,history:[]}];
test('move named and positional records both directions while preserving all cells and input',()=>{
  const original=structuredClone(rows),move=C.moveRecord(rows,{recordMatch:'uppal co',toPosition:2});
  assert.deepEqual(move.records.map(r=>r.id),[1,3,2,4]);assert.equal(move.record,rows[2]);assert.equal(move.fromPosition,3);
  for(const row of move.records)assert.deepEqual(row,original.find(r=>r.id===row.id));assert.deepEqual(rows,original);
  assert.deepEqual(C.moveRecord(rows,{fromPosition:1,toPosition:4}).records.map(r=>r.id),[2,3,4,1]);
  assert.equal(C.moveRecord(rows,{fromPosition:2,toPosition:2}).noChange,true);
});
test('visible moves honor sorted order and keep hidden slots; full-table moves ignore filtering',()=>{
  const move=C.moveRecord(rows,{fromPosition:1,toPosition:3},[4,3,1]);assert.deepEqual(move.records.map(r=>r.id),[3,2,1,4]);
  assert.deepEqual(C.moveRecord(rows,{recordMatch:'Hidden',toPosition:1,orderScope:'all'},[1,3]).records.map(r=>r.id),[2,1,3,4]);
  assert.throws(()=>C.moveRecord(rows,{recordMatch:'Hidden',toPosition:1},[1,3]),/hidden/);
});
test('invalid moves and ambiguous record references never fabricate or remove records',()=>{
  for(const toPosition of [0,5,1.5,'2',null])assert.throws(()=>C.moveRecord(rows,{fromPosition:1,toPosition}),/position/);
  for(const action of [{toPosition:1},{ids:[1,2],toPosition:1},{ids:[99],toPosition:1},{recordMatch:'Uppal Co',fromPosition:1,toPosition:2},{fromPosition:1,toPosition:2,orderScope:'invalid'},{fromPosition:1,toPosition:2,filter:{field:'owner'}}])assert.throws(()=>C.moveRecord(rows,action));
  for(const ids of [[1,1],[1,99],[]])assert.throws(()=>C.moveRecord(rows,{fromPosition:1,toPosition:1},ids));
  const duplicate=[...rows,{...rows[2],id:5}];assert.equal(C.moveRecord(duplicate,{recordMatch:'Uppal Co',toPosition:1}).clarification.candidates.length,2);
  assert.equal(C.moveRecord(duplicate,{recordMatch:'Uppal Co',toPosition:1},[1,3]).record.id,3);
});
