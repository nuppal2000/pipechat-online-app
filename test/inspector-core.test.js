const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../public/inspector-core.js'),C=require('../public/pipeline-core.js');
const rows=[{id:1,account:'Acme',owner:'Sarah',value:1,history:[]},{id:2,account:'Acme',history:[]}];
test('notes use stable record IDs, preserve cells, roundtrip and deduplicate retry IDs',()=>{
  const next=H.addNote(rows,1,' First line\nSecond line <script> ','Ravi','n1',new Date('2026-09-23T15:00:00Z'));
  assert.equal(rows[0].history.length,0);assert.equal(next[1],rows[1]);assert.equal(next[0].account,'Acme');
  const entry=H.entries(next[0].history)[0];assert.equal(entry.type,'note');assert.equal(entry.text,'First line\nSecond line <script>');
  assert.deepEqual(H.addNote(next,1,'retry','Ravi','n1'),next);
  assert.throws(()=>H.addNote(rows,3,'note','Ravi','n2'),/no longer/);
  assert.throws(()=>H.addNote(rows,1,' ','Ravi','n2'),/Enter/);assert.throws(()=>H.addNote(rows,1,'a'.repeat(6001),'Ravi','n2'),/6000/);
});
test('legacy and structured entries sort by instant, preserve undated history and filter inclusive local dates',()=>{
  const a=new Date(2026,8,20,23,45),b=new Date(2026,8,21,0,15);
  const history=[`undated`,`${a.toISOString()} | Ravi: Value changed.`,...H.addNote(rows,1,'note','Sarah','n',b)[0].history];
  const all=H.entries(history);assert.deepEqual(all.map(e=>e.type),['note','activity','activity']);assert.equal(all.at(-1).at,null);
  assert.equal(H.entries(history,{from:'2026-09-20',to:'2026-09-20'}).length,1);
  assert.equal(H.entries(history,{from:'2026-09-21',to:'2026-09-21',kind:'note'}).length,1);
  assert.equal(H.entries(history,{kind:'activity'}).length,2);
  assert.throws(()=>H.entries(history,{from:'2026-09-22',to:'2026-09-21'}),/start date/);
  assert.equal(H.parse('{"pipechatHistory":1,"type":"note","at":"bogus"}').type,'activity');
});
test('manual/AI changes are not duplicated, rename preserves notes, Undo preserves history and records the reversal',()=>{
  const initial=H.addNote(rows,1,'Do not lose this','Ravi','n');
  const plan=C.plan(initial,{action:'update_record',ids:[1],field:'account',value:'Renamed'});
  const edited=C.apply(initial,plan,'Sarah');
  const saved=H.reconcile(initial,edited,C.definitions([]),C.definitions([]),'Sarah');
  assert.equal(saved[0].history.length,2);assert.equal(H.entries(saved[0].history,{kind:'note'}).length,1);
  const undone=H.reconcile(saved,rows,C.definitions([]),C.definitions([]),'Sarah');
  assert.equal(undone[0].account,'Acme');assert.equal(undone[0].history.length,3);assert.match(undone[0].history[0],/Renamed.*Acme/);
});
test('conversion changes are recorded, unrelated no-op saves do not create activity, limits fail without truncation',()=>{
  const changed=H.reconcile(rows,rows.map(r=>r.id===1?{...r,value:null}:r),C.definitions([]),C.definitions([]),'QA');
  assert.match(changed[0].history[0],/Value.*1/);assert.deepEqual(H.reconcile(rows,rows,C.definitions([]),C.definitions([]),'QA'),rows);
  assert.throws(()=>H.addNote([{...rows[0],history:Array(10000).fill('old')}],1,'new','QA','n'),/limit/);
});
