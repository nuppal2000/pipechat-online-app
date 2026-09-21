const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/pipeline-core.js');
const rows = [
  {id:1,account:'Mike Supply',owner:'Sarah',stage:'Discovery',value:100.25,close:'2026-11-01',notes:'Existing note',follow:'Today'},
  {id:2,account:'Mike Design',owner:'Jordan',stage:'Warm',value:250.75,close:'2026-12-01',notes:'Private',follow:'Tomorrow'},
  {id:3,account:'Acme',owner:'Sarah',stage:'Proposal Sent',value:200,close:'2026-11-20',notes:'Internal',follow:''}
];
test('ambiguous company names cannot be bypassed by a model-selected ID',()=>{
  const result=C.plan(rows,{action:'update_record',recordMatch:'Mike',ids:[1],field:'stage',value:'Won'});
  assert.deepEqual(result.clarification.candidates.map(r=>r.id),[1,2]);
  assert.equal(rows[0].stage,'Discovery');
});
test('exact names win over substring matches, while duplicate exact names need clarification',()=>{
  assert.deepEqual(C.candidates(rows,'mike supply').map(r=>r.id),[1]);
  assert.equal(C.targets([...rows,{...rows[0],id:4}],{recordMatch:'Mike Supply'},false).candidates.length,2);
});
test('multi-field preview is immutable until apply and appends notes',()=>{
  const snapshot=C.clone(rows);
  const proposal=C.plan(rows,{action:'update_records',changes:[
    {recordMatch:'Mike Supply',field:'stage',value:'Proposal',operation:'set'},
    {recordMatch:'Mike Supply',field:'close',value:'Dec 20, 2026',operation:'set'},
    {recordMatch:'Mike Supply',field:'notes',value:'New note',operation:'append'}
  ]});
  assert.equal(proposal.count,1);assert.deepEqual(rows,snapshot);
  const updated=C.apply(rows,proposal,'Test');
  assert.equal(updated[0].stage,'Proposal Sent');assert.equal(updated[0].close,'2026-12-20');
  assert.equal(updated[0].notes,'Existing note\nNew note');assert.equal(updated[0].history.length,3);assert.deepEqual(updated[1],rows[1]);
});
test('bulk month/numeric filters produce an exact record count and preserve nonmatches',()=>{
  const proposal=C.plan(rows,{action:'bulk_update',filter:{field:'close',operator:'month_equals',value:11},field:'owner',value:'Neelam'});
  assert.equal(proposal.count,2);assert.deepEqual(proposal.patches.map(p=>p.id),[1,3]);
  const greater=C.plan(rows,{action:'bulk_update',filter:{field:'value',operator:'gt',value:200},field:'stage',value:'Won'});
  assert.equal(greater.count,1);assert.equal(greater.patches[0].id,2);
});
test('invalid inputs and unsupported operations are rejected',()=>{
  for(const value of ['2026-02-30','11/30','next week','2026-13-01'])assert.throws(()=>C.validateValue('close',value));
  for(const value of [NaN,Infinity,-1,' ',true,{}])assert.throws(()=>C.validateValue('value',value));
  assert.throws(()=>C.validateValue('account',' '));assert.throws(()=>C.validateValue('stage','Made up'));
  assert.throws(()=>C.plan(rows,{action:'update_record',ids:[1],field:'owner',value:'X',operation:'append'}));
  assert.throws(()=>C.plan(rows,{action:'bulk_update',field:'stage',value:'Won'}));
  assert.throws(()=>C.plan(rows,{action:'update_record',ids:[999],field:'owner',value:'X'}));
});
test('stale/expired previews cannot overwrite later changes',()=>{
  const proposal=C.plan(rows,{action:'update_record',ids:[1],field:'stage',value:'Won'});
  const changed=C.clone(rows);changed[0].stage='Warm';
  assert.throws(()=>C.apply(changed,proposal,'Test'),/changed/);
  assert.throws(()=>C.apply(rows,proposal,'Test',new Date(proposal.createdAt+31*60*1000)),/expired/);
});
test('reports calculate sums, counts, averages and date windows from rows',()=>{
  const spec={metric:'sum',field:'value',groupBy:'owner',chart:'bar'};
  assert.deepEqual(C.report(rows,spec).data,[{label:'Sarah',value:300.25,count:2},{label:'Jordan',value:250.75,count:1}]);
  assert.equal(C.report(rows,{...spec,metric:'average'}).data.find(d=>d.label==='Sarah').value,150.13);
  assert.equal(C.report(rows,{...spec,metric:'count',groupBy:'none'}).data[0].value,3);
  assert.equal(C.report(rows,{...spec,from:'2026-12-01',to:'2026-12-31'}).count,1);
  assert.equal(C.report(rows,{...spec,filter:{field:'owner',operator:'equals',value:'Sarah'}}).count,2);
  assert.throws(()=>C.report(rows,{...spec,from:'2026-12-31',to:'2026-01-01'}));
});
test('monthly lines sort chronologically and zero-fill missing months',()=>{
  const fixture=[{...rows[0],close:'2026-01-01'},{...rows[1],close:'2026-03-10'},{...rows[2],close:''}];
  const result=C.report(fixture,{metric:'count',field:'value',groupBy:'close_month',chart:'line'});
  assert.deepEqual(result.data.map(d=>[d.label,d.value]),[['2026-01',1],['2026-02',0],['2026-03',1]]);assert.equal(result.undated,1);
});
test('empty charts have no fabricated values',()=>assert.deepEqual(C.report([],{metric:'sum',field:'value',groupBy:'owner',chart:'bar'}),{data:[],count:0,undated:0}));
test('share export projects only the explicit public field allowlist',()=>{
  const data=C.share(rows,['account','stage','value']);
  assert.deepEqual(Object.keys(data[0]),['account','stage','value']);assert.equal(JSON.stringify(data).includes('Private'),false);
  assert.throws(()=>C.share(rows,['account','notes']));assert.throws(()=>C.share(rows,['history']));
});
