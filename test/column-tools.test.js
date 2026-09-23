const test=require('node:test'),assert=require('node:assert/strict');
const Schema=require('../public/table-schema'),Core=require('../public/pipeline-core'),X=require('../public/workspace-customization');
const field=(id,type='text',role='none',options=[])=>({id,name:id,type,role,options});
const schema={status:'ready',useCase:'Other',title:'QA',recordLabel:'record',description:'',fields:[field('f_name','text','primary'),field('f_date'),field('f_status','choice','status',['Warm','Won'])]};
test('column order preserves identity and fields, supports custom interleaving, deletion and new columns',()=>{
  const custom=[{id:'cf_notes',name:'Notes',type:'text'}],before=structuredClone(schema);
  const s=Schema.reorder(schema,custom,'cf_notes','f_name');
  assert.deepEqual(s.columnOrder,['cf_notes','f_name','f_date','f_status']);assert.deepEqual(s.fields,schema.fields);assert.deepEqual(schema,before);
  const moved=Schema.reorder(s,custom,'f_name','f_status');assert.deepEqual(moved.columnOrder,['cf_notes','f_date','f_status','f_name']);assert.equal(Core.create(moved).role('primary'),'f_name');
  assert.deepEqual(Schema.orderedFields([field('f_name'),field('f_status'),field('f_new')],moved.columnOrder).map(f=>f.id),['f_status','f_name','f_new']);
  assert.deepEqual(Schema.validate(moved),moved);assert.throws(()=>Schema.reorder(s,custom,'missing','f_name'));
  for(const columnOrder of [null,{},['f_name','f_name'],['<bad>'],Array(121).fill('f_name')])assert.throws(()=>Schema.validate({...s,columnOrder}));
});
test('date conversion preserves dates, blanks and other fields without mutating input',()=>{
  const values=['oct 5 2026','October 5, 2026','5 October 2026','2026/10/5','2026-10-05','','February 29 2028'];
  const rows=values.map((v,i)=>({id:i+1,f_name:'Row '+i,f_date:v,f_status:'Warm',history:[]})),before=structuredClone(rows);
  const c=X.editColumn(rows,schema,[],'f_date',{targetType:'date',options:null});
  assert.deepEqual(c.records.map(r=>r.f_date),['2026-10-05','2026-10-05','2026-10-05','2026-10-05','2026-10-05','','2028-02-29']);
  assert.deepEqual(rows,before);assert.equal(c.after.type,'date');assert.equal(c.issues.length,0);
  for(const row of c.records)assert.equal(Core.create(c.tableSchema).tableValues(row,[]).f_date,row.f_date);
  assert.doesNotThrow(()=>Schema.transition(c.tableSchema,schema,rows));
  assert.deepEqual(X.editColumn(c.records,c.tableSchema,[],'f_date',{targetType:'text'}).records,c.records);
});
test('ambiguous or invalid dates block the whole conversion; primary identity is protected',()=>{
  for(const value of ['10/5/2026','Oct 5','February 29 2026','2026-04-31','tomorrow',7]){
    const rows=[{id:1,f_name:'A',f_date:'Oct 5 2026'},{id:2,f_name:'B',f_date:value}],before=structuredClone(rows);
    assert.throws(()=>X.editColumn(rows,schema,[],'f_date',{targetType:'date'}),e=>e.clarification===true&&/row #2/.test(e.message));assert.deepEqual(rows,before);
  }
  assert.throws(()=>X.editColumn([],schema,[],'f_name',{targetType:'date'}),/primary/);
});
test('choice to text keeps exact selections and metadata; custom dates persist canonically',()=>{
  const rows=[{id:1,f_name:'A',f_status:'Warm',cf_when:'October 5 2026',history:[]},{id:2,f_name:'B',f_status:'',cf_when:'',history:[]}];
  const custom=[{id:'cf_when',name:'When',type:'text'}];
  const c=X.editColumn(rows,schema,custom,'f_status',{targetType:'text',options:null});assert.deepEqual(c.records,rows);assert.equal(c.after.role,'status');assert.deepEqual(c.after.options,[]);
  const d=X.editColumn(rows,schema,custom,'cf_when',{targetType:'date'});assert.deepEqual(d.customFields,[{id:'cf_when',name:'When',type:'date'}]);
  assert.equal(Core.create(d.tableSchema).customValues(d.records[0],d.customFields).cf_when,'2026-10-05');assert.equal(Core.customValues(d.records[0],d.customFields).cf_when,'2026-10-05');
  assert.throws(()=>Core.create(d.tableSchema).customValues({...d.records[0],cf_when:'no date'},d.customFields));
});
