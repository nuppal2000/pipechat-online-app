const test=require('node:test'),assert=require('node:assert/strict');
const Core=require('../public/pipeline-core'),Plan=require('../public/workspace-plan');
const {snapshotResult}=require('../lib/backend-contract'),F=require('./fixtures/workspace-plans.cjs');

const original='Add a number field called Probability percent. Set it to 50 for QA1105 Cedar Consulting, 80 for QA1105 Cedar North, and 25 for QA1105 Maple Retail.';
for(const [command,label,names,values] of [
  [original,'Probability percent',['QA1105 Cedar Consulting','QA1105 Cedar North','QA1105 Maple Retail'],[50,80,25]],
  ['Track the signed variance as a numeric column: Aspen -2.125, Birch 0, Oak 103.5.','Signed variance',['Aspen','Birch','Oak'],[-2.125,0,103.5]]
])test(command,()=>{
  const w=F.workspace();w.records=w.records.slice(0,4).map((r,i)=>({...r,f_deal:names[i]??'Untouched'}));
  const before=structuredClone(w),add={op:'add_field',id:'new_metric',label:'Add '+label,name:label,type:'number',options:[]};
  const a=F.plan([add,...names.flatMap((name,i)=>[F.select('row_'+i,[[F.where('f_deal','equals',name)]]),F.update('edit_'+i,'row_'+i,'@new_metric',values[i])])]);
  const run=()=>Plan.prepare(w,a,{nonce:'numbers',today:'2026-11-05'});
  const p=run(),[field]=p.addedFields;
  assert.deepEqual(w,before);assert.equal(field.type,'number');assert.equal(field.name,label);
  assert.equal(p.patches.length,3);assert.equal(p.next.customFields.length,1);
  const saved=snapshotResult(JSON.parse(JSON.stringify({deals:p.next.records,customFields:p.next.customFields,tableSchema:w.tableSchema,updatedAt:'v2'})));
  assert.deepEqual(saved.deals.map(r=>r[field.id]),[...values,null]);
  const core=Core.create(saved.tableSchema);
  for(const direction of ['asc','desc'])assert.deepEqual(core.sortRecords(saved.deals,{field:field.id,direction},saved.customFields).map(r=>r[field.id]),[...values.toSorted((a,b)=>direction==='asc'?a-b:b-a),null]);
  for(const metric of ['sum','average'])assert.equal(core.report(saved.deals,{metric,field:field.id,groupBy:'none',chart:'kpi'},saved.customFields).data[0].value,values.reduce((sum,n)=>sum+n,0)/(metric==='average'?values.length:1));
  a.steps.at(-1).assignments[0].value='not a number';assert.throws(run,/valid number/);assert.deepEqual(w,before);
});

test('numeric custom cells share finite bounds and blank semantics in legacy and tailored workspaces',()=>{
  const field={id:'cf_delta',name:'Delta',type:'number'};
  for(const core of [Core,Core.create(F.schema)]){
    const check=v=>core.validateStoredValue(field.id,v,[field]);
    for(const v of [null,''])assert.equal(check(v),null);
    for(const v of ['0','-0.25',1000000000000])assert.equal(check(v),Number(v));
    for(const v of [false,{},[],'  ','25%','1,000',Infinity,NaN,-1000000000001])assert.throws(()=>check(v));
  }
});
