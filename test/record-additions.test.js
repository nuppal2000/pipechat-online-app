const test=require('node:test'),assert=require('node:assert/strict');
const Core=require('../public/pipeline-core'),fixture=require('./fixtures/record-additions.cjs');
const core=Core.create(fixture.schema),action={action:'add_records',record:null,records:fixture.records};
const question=pattern=>error=>error.clarification===true&&pattern.test(error.message);

test('exact three-deal failure previews every supplied field, without mutation or hardcoded company requirement',()=>{
  const existing=[{id:7,...fixture.records[0],history:['keep']}],before=structuredClone({existing,action});
  const p=core.additions(existing,action);assert.equal(p.count,3);assert.deepEqual(p.records.map(r=>r.id),[8,9,10]);
  p.records.forEach((row,i)=>{for(const [key,value]of Object.entries(fixture.records[i]))assert.equal(row[key],value);});
  assert.deepEqual({existing,action},before);
  assert.deepEqual(core.additions([],{...action,action:'add_record'}).records,core.additions([],action).records,'old singular action with records must not inspect its null record');
  assert.equal(core.additions([],{action:'add_record',record:fixture.records[0]}).count,1);
});
test('current labels and safe name aliases work without hidden field vocabulary',()=>{
  for(const name of ['Company name','Account name','Deal name','Client name','Business name','company_name','Deal/Account name','name']){
    const p=core.additions([],{action:'add_record',record:{[name]:'Northstar Design',Owner:'Alex',stage:'Qualified','follow-up':'2026-10-02',Value:12000,contact:'Maya Chen',note:'Interested in annual plan'}});
    assert.deepEqual(Object.fromEntries(Object.keys(fixture.records[0]).map(k=>[k,p.records[0][k]])),fixture.records[0]);
  }
  const legacy=Core.additions([],{action:'add_records',records:[{company_name:'One',Contact:'Maya'}]},[{id:'cf_contact',name:'Contact',type:'text'}]);
  assert.equal(legacy.records[0].account,'One');assert.equal(legacy.records[0].cf_contact,'Maya');assert.equal(legacy.records[0].value,null);assert.equal(legacy.records[0].stage,'');
});
test('distinct client/deal columns, conflicting aliases and unmapped details require clarification without losing the batch',()=>{
  const schema=structuredClone(fixture.schema);schema.fields.push({id:'f_client',name:'Client Name',type:'text',role:'none',options:[]});const c=Core.create(schema);
  assert.equal(c.additions([],{action:'add_record',record:{'Deal / Account Name':'Deal','Client Name':'Person'}}).records[0].f_client,'Person');
  assert.throws(()=>c.additions([],{action:'add_record',record:{'Company name':'Which?'}}),question(/Which column.*Deal \/ Account Name.*Client Name/));
  for(const payload of [{...fixture.records[0],'Company name':'Conflict'},{...fixture.records[0],unknown:'Do not discard'}])assert.throws(()=>core.additions([],{...action,records:[fixture.records[1],payload]}),question(/conflicting|no unambiguous/));
  assert.throws(()=>core.additions([],{...action,record:fixture.records[0]}),question(/both/));
  const missing=structuredClone(action);missing.records[1].f_deal=' ';assert.throws(()=>core.additions([],missing),question(/Deal \/ Account Name.*record 2/));assert.equal(missing.records[0].f_deal,'Northstar Design');
});
test('typed and reordered primary fields retain zero and reject invalid dates/stages atomically',()=>{
  const c=Core.create({...fixture.schema,columnOrder:['f_value','f_deal','f_stage','f_owner','f_follow','f_contact','f_notes']});
  assert.equal(c.additions([],{action:'add_record',record:{...fixture.records[0],f_value:0}}).records[0].f_value,0);
  for(const [field,value,pattern]of [['f_follow','not a date',/record 2.*Follow-up Date/],['f_stage','banana',/record 2.*Deal Stage.*Available options/]]){
    const records=structuredClone(fixture.records);records[1][field]=value;assert.throws(()=>core.additions([],{...action,records}),question(pattern));
  }
  assert.throws(()=>core.additions([],{action:'add_record',record:null}),question(/records to add/));
  assert.throws(()=>core.additions(Array.from({length:1998},(_,id)=>({id:id+1})),action),question(/2,000-record/));
  assert.throws(()=>core.additions([],{action:'add_records',records:Array(2001).fill(fixture.records[0])}),question(/2,000/));
  for(const record of [null,[],4])assert.throws(()=>core.additions([],{action:'add_records',records:[record]}),question(/incomplete/));
  for(const key of ['id','history','__proto__','constructor'])assert.throws(()=>core.additions([],{action:'add_record',record:{...fixture.records[0],[key]:'injected'}}),/only table fields/);
});
