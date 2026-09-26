const test=require('node:test'),assert=require('node:assert/strict');
const Core=require('../public/pipeline-core');
const {schema:base}=require('./fixtures/record-additions.cjs');
const schema={...base,fields:[...base.fields,{id:'cf_priority',name:'Priority',role:'none',type:'choice',options:['Low','Medium','High']}]};
const C=Core.create(schema),filter={field:'f_value',operator:'lt',value:50000};
const values=[0,12000,49999.99,50000,73000,null,''];
const rows=values.map((value,i)=>({id:i+1,f_deal:'Account '+(i+1),f_owner:i%2?'Sarah':'Ravi',f_stage:'Prospecting',cf_priority:'Low',f_value:value,f_notes:'Keep '+i,f_follow:'2026-09-29',history:[]}));
const change=(field,value,selection={filter})=>({...selection,field,value,operation:'set'});

test('multi-field dropdown IDs update every explicit target, not a single-record clarification',()=>{
  const before=structuredClone(rows),p=C.plan(rows,{action:'update_records',changes:[change('f_stage','Qualified',{ids:[3,1,2]}),change('cf_priority','High',{ids:[3,1,2]})]});
  assert.equal(p.count,3);assert.equal(p.clarification,undefined);assert.deepEqual(p.patches.map(p=>p.account),['Account 3','Account 1','Account 2']);assert.deepEqual(rows,before);
  const after=C.apply(rows,p,'QA');for(const r of after.slice(0,3)){assert.equal(r.f_stage,'Qualified');assert.equal(r.cf_priority,'High');}assert.deepEqual(after.slice(3),rows.slice(3));
});

test('full predicates override sample targets and apply dropdown, text and date fields equally',()=>{
  const selection={filter,ids:[1],recordMatch:'Account 1'};
  const p=C.plan(rows,{action:'update_records',changes:[change('f_stage','Qualified',selection),change('cf_priority','High',selection),change('f_notes','Bulk test',selection),change('f_follow','2026-10-10',selection)]});
  assert.equal(p.count,3);assert.deepEqual(p.patches.map(p=>p.id),[1,2,3]);const after=C.apply(rows,p,'QA');
  for(const r of after.slice(0,3)){assert.equal(r.f_stage,'Qualified');assert.equal(r.cf_priority,'High');assert.equal(r.f_notes,'Bulk test');assert.equal(r.f_follow,'2026-10-10');assert.equal(r.f_deal,rows[r.id-1].f_deal);assert.equal(r.f_owner,rows[r.id-1].f_owner);}assert.deepEqual(after.slice(3),rows.slice(3));
});

test('each predicate uses the original snapshot; independent subsets are not broadened',()=>{
  const p=C.plan(rows,{action:'update_records',changes:[change('f_value',100000),change('f_stage','Qualified'),change('cf_priority','High',{filter:{field:'f_owner',operator:'equals',value:'Sarah'}})]});
  const after=C.apply(rows,p,'QA');assert(after.slice(0,3).every(r=>r.f_stage==='Qualified'));assert.equal(after[3].f_stage,'Prospecting');assert.equal(after[3].cf_priority,'High');assert.equal(after[0].cf_priority,'Low');
});

test('genuine singular name ambiguity retains dynamic identity/owner/status keys without aliasing',()=>{
  for(const action of [{action:'update_record',recordMatch:'Account',ids:[1],field:'f_stage',value:'Qualified'},{action:'update_records',changes:[change('f_stage','Qualified',{recordMatch:'Account',ids:[1]})]}]){
    const q=C.plan(rows,action).clarification;assert.equal(q.candidates.length,rows.length);assert.equal(q.candidates[0].f_deal,'Account 1');assert.equal(q.candidates[0].f_owner,'Ravi');assert.equal(q.candidates[0].f_stage,'Prospecting');assert(!Object.hasOwn(q.candidates[0],'account'));assert(!Object.hasOwn(q.candidates[0],'history'));
  }
  assert(C.plan(rows,{action:'update_record',ids:[1,2],field:'f_stage',value:'Qualified'}).clarification);
});

test('invalid field values and IDs reject the whole batch, while no-ops retain other field edits',()=>{
  const before=structuredClone(rows);
  for(const bad of [change('cf_priority','banana'),change('f_follow','2026-02-30'),change('f_stage','Qualified',{ids:[1,999]})])assert.throws(()=>C.plan(rows,{action:'update_records',changes:[change('f_notes','Should not save'),bad]}));
  assert.deepEqual(rows,before);
  const p=C.plan(rows,{action:'update_records',changes:[change('f_stage','Prospecting'),change('cf_priority','High')]});assert.equal(p.count,3);assert(p.patches.every(p=>Object.keys(p.after).join()==='cf_priority'));
});
