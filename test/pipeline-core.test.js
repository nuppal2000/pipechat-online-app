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
const comparisonRows=[
  {id:1,account:'Alpha',owner:'Ravi',value:100.25,stage:'Warm',close:'2026-10-01'},
  {id:2,account:'Beta',owner:'Sarah',value:200.50,stage:'Won',close:'2026-11-01'},
  {id:3,account:'Gamma',owner:'Ravi',value:50.25,stage:'Warm',close:'2026-12-01'},
  {id:4,account:'Delta',owner:'Daniel',value:900,stage:'Warm',close:'2026-12-02'},
  {id:5,account:' alpha ',owner:' ravi ',value:0,stage:'Warm',close:'2026-12-02'},
  {id:6,account:'Unknown',owner:'Sarah',value:null,stage:'Warm',close:''}
];
const comparisonSpec={metric:'sum',field:'value',groupBy:'owner',chart:'bar',owners:['Ravi','Sarah'],accounts:null};
test('owner subsets use exact OR matching, normalize names and never include other owners',()=>{
  const before=C.clone(comparisonRows),result=C.report(comparisonRows,{...comparisonSpec,owners:[' ravi ','Sarah','RAVI']});
  assert.deepEqual(result.data,[{label:'Sarah',value:200.5,count:2},{label:'Ravi',value:150.5,count:3}]);
  assert.equal(result.count,5);assert.deepEqual(result.missingOwners,[]);assert.deepEqual(comparisonRows,before);
  assert.equal(C.report(comparisonRows,{...comparisonSpec,owners:['Ra']}).count,0);
});
test('account comparisons aggregate duplicate account names and support independent owner selection',()=>{
  const spec={...comparisonSpec,groupBy:'account',owners:null,accounts:['Alpha','Beta','Gamma']};
  assert.deepEqual(C.report(comparisonRows,spec).data,[{label:'Beta',value:200.5,count:1},{label:'Alpha',value:100.25,count:2},{label:'Gamma',value:50.25,count:1}]);
  assert.deepEqual(C.report(comparisonRows,{...spec,owners:['Ravi']}).data.map(d=>d.label),['Alpha','Gamma']);
});
test('selection lists intersect existing filters and inclusive close date bounds',()=>{
  const result=C.report(comparisonRows,{...comparisonSpec,accounts:['Alpha','Gamma','Delta'],filter:{field:'stage',operator:'equals',value:'Warm'},from:'2026-12-01',to:'2026-12-02'});
  assert.deepEqual(result.data,[{label:'Ravi',value:50.25,count:2}]);assert.deepEqual(result.missingOwners,['Sarah']);assert.deepEqual(result.missingAccounts,['Delta']);
});
test('subset counts and averages exclude unknown values without dropping their deal counts',()=>{
  assert.deepEqual(C.report(comparisonRows,{...comparisonSpec,metric:'count'}).data.map(d=>[d.label,d.value]),[['Ravi',3],['Sarah',2]]);
  assert.deepEqual(C.report(comparisonRows,{...comparisonSpec,metric:'average'}).data.map(d=>[d.label,d.value]),[['Sarah',200.5],['Ravi',50.17]]);
  assert.equal(C.report(comparisonRows,{...comparisonSpec,groupBy:'account',accounts:['Unknown']}).data[0].value,null);
});
test('empty and unmatched selections never broaden a report or invent zero-valued records',()=>{
  for(const owners of [[],['Nobody']]){const result=C.report(comparisonRows,{...comparisonSpec,owners});assert.equal(result.count,0);assert.deepEqual(result.data,[]);}
  const result=C.report(comparisonRows,{...comparisonSpec,owners:['Ravi','Nobody']});assert.deepEqual(result.missingOwners,['Nobody']);assert.equal(result.data.length,1);
  assert.equal(C.report(comparisonRows,{...comparisonSpec,owners:null}).count,6);
  assert.equal(C.report(comparisonRows,{...comparisonSpec,accounts:[]}).count,0);
});
test('malformed selection lists fail closed without changing shared write predicates',()=>{
  for(const owners of ['Ravi, Sarah',{},[1],[null],Array(2001).fill('Ravi')])assert.throws(()=>C.report(comparisonRows,{...comparisonSpec,owners}),/valid list/);
  assert.throws(()=>C.report(comparisonRows,{...comparisonSpec,accounts:[{}]}),/valid list/);
  assert.throws(()=>C.predicate({field:'owner',operator:'in',value:['Ravi','Sarah']}),/not supported/);
});
test('unassigned selections and HTML-like names are treated as literal data',()=>{
  const fixture=[{id:1,account:'',owner:'',value:7},{id:2,account:'<img onerror=alert(1)>',owner:'Ravi',value:8}];
  assert.equal(C.report(fixture,{...comparisonSpec,owners:['']}).data[0].label,'Unassigned');
  assert.equal(C.report(fixture,{...comparisonSpec,groupBy:'account',owners:null,accounts:['']}).data[0].label,'Unnamed account');
  assert.equal(C.report(fixture,{...comparisonSpec,groupBy:'account',owners:null,accounts:['<img onerror=alert(1)>']}).data[0].value,8);
});
test('share export projects only the explicit public field allowlist',()=>{
  const data=C.share(rows,['account','stage','value']);
  assert.deepEqual(Object.keys(data[0]),['account','stage','value']);assert.equal(JSON.stringify(data).includes('Private'),false);
  assert.throws(()=>C.share(rows,['account','notes']));assert.throws(()=>C.share(rows,['history']));
});
