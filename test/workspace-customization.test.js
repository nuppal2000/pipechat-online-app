const test=require('node:test'),assert=require('node:assert/strict');
const X=require('../public/workspace-customization.js'),Core=require('../public/pipeline-core.js'),Schema=require('../public/table-schema.js');
const schema={status:'ready',useCase:'Sales',title:'Opportunities',recordLabel:'deal',description:'',fields:[
  {id:'f_name',name:'Account',type:'text',role:'primary',options:[]},
  {id:'f_status',name:'Deal status',type:'text',role:'status',options:[]},
  {id:'f_score',name:'Score',type:'number',role:'none',options:[]},
  {id:'f_follow',name:'Follow-up date',type:'date',role:'followup',options:[]},
  {id:'f_owner',name:'Owner',type:'text',role:'owner',options:[]}
]};
const rows=[{id:1,f_name:'A',f_status:' warm ',f_score:0,f_follow:'2026-09-01',f_owner:'Ravi',history:['Keep'],activity:'old',health:''},{id:2,f_name:'B',f_status:'Won',f_score:20,f_follow:'2026-09-01',f_owner:'Sarah',history:[]},{id:3,f_name:'C',f_status:'d',f_score:null,f_follow:'',f_owner:'',history:[]}];
test('rename preserves every cell, ID, role, row order and history, including the primary column',()=>{
  for(const f of schema.fields){const next=X.editColumn(rows,schema,[],f.id,{name:'New label'});assert.deepEqual(next.records,rows);assert.equal(next.after.id,f.id);assert.equal(next.after.role,f.role);assert.equal(next.tableSchema.recordLabel,'deal');}
  assert.equal(schema.fields[0].name,'Account');assert.throws(()=>X.editColumn(rows,schema,[],'f_name',{name:'Owner'}));
  const changed=X.editColumn(rows,schema,[{id:'cf_source',name:'Source',type:'text'}],'cf_source',{name:'Origin'});assert.equal(changed.customFields[0].name,'Origin');
});
test('dropdown maps canonical options, blanks only mismatches and preserves every other cell',()=>{
  const next=X.editColumn(rows,schema,[],'f_status',{options:['Warm','Won']});
  assert.deepEqual(next.records.map(r=>r.f_status),['Warm','Won','']);assert.deepEqual(next.issues,[{id:3,record:'C',value:'d'}]);
  for(let i=0;i<rows.length;i++){const {f_status,...other}=next.records[i],{f_status:old,...original}=rows[i];assert.deepEqual(other,original);}
  assert.equal(Core.create(next.tableSchema).validateStoredValue('f_status','warm'),'Warm');assert.throws(()=>Core.create(next.tableSchema).validateStoredValue('f_status','d'));
  assert.deepEqual(Schema.transition(next.tableSchema,schema,rows),schema);
  for(const options of [null,[],['A','a'],[''],['a'.repeat(81)],Array(31).fill('x')])assert.throws(()=>X.editColumn(rows,schema,[],'f_status',{options}));
});
test('primary, owner, numeric and custom columns support dropdown conversion and zero remains valid',()=>{
  for(const field of ['f_name','f_owner'])assert.equal(X.editColumn(rows,schema,[],field,{options:[rows[0][field]]}).after.role,schema.fields.find(f=>f.id===field).role);
  assert.equal(X.editColumn(rows,schema,[],'f_score',{options:['0','20']}).records[0].f_score,'0');
  const custom=[{id:'cf_source',name:'Source',type:'text'}],next=X.editColumn([{...rows[0],cf_source:'referral'}],schema,custom,'cf_source',{options:['Referral']});
  assert.equal(next.customFields[0].type,'choice');assert.equal(next.records[0].cf_source,'Referral');
  assert.equal(Core.create(next.tableSchema).tableValues(next.records[0],next.customFields).cf_source,'Referral');
});
test('KPI customization persists definitions, computes averages excluding blanks and includes zero',()=>{
  const spec={title:'Average score',metric:'average',field:'f_score',conditions:[]};
  const changed=X.configure(schema,[],'kpi_f_score',spec);assert.equal(X.calculate(changed.after,rows,schema,[],'2026-09-23').value,10);
  assert.equal(X.kpis(Schema.validate(changed.tableSchema)).find(k=>k.id==='kpi_f_score').metric,'average');
  assert.equal(X.calculate(changed.after,[],schema,[],'2026-09-23').value,null);
  assert.deepEqual(rows[0].history,['Keep']);assert.throws(()=>X.configure(schema,[],'unknown',spec));
});
test('stale KPIs combine explicit date cutoffs and status exclusions; blank/future dates never count',()=>{
  const input={title:'Stale deals',metric:'count',field:null,conditions:[{field:'f_follow',operator:'older_than_days',value:7},{field:'f_status',operator:'not_equals',value:'Won'}]};
  const changed=X.configure(schema,[],'kpi_followup',input);assert.equal(X.calculate(changed.after,rows,schema,[],'2026-09-23').value,1);
  assert.throws(()=>X.configure(schema,[],'kpi_followup',{...input,conditions:[{field:'f_name',operator:'before_today',value:null}]}));
  assert.throws(()=>X.configure(schema,[],'kpi_followup',{...input,conditions:[{field:'f_follow',operator:'older_than_days',value:-1}]}));
});
test('schema changes recontextualize defaults and remove only incompatible KPI overrides; undo restores',()=>{
  const tuned=X.configure(schema,[],'kpi_f_score',{title:'Average score',metric:'average',field:'f_score',conditions:[]}).tableSchema;
  const converted=X.editColumn(rows,tuned,[],'f_score',{options:['0','20']});assert.deepEqual(converted.dropped,['Average score']);assert(!X.kpis(converted.tableSchema).some(k=>k.field==='f_score'));
  const renamed=X.editColumn(rows,schema,[],'f_score',{name:'Rating'});assert.equal(X.kpis(renamed.tableSchema).find(k=>k.field==='f_score').title,'Total Rating');
  const deleted=Core.create(tuned).deleteColumn(rows,'f_score');assert.deepEqual(deleted.tableSchema.kpis,[]);assert(!X.kpis(deleted.tableSchema).some(k=>k.field==='f_score'));
  assert.equal(X.kpis(tuned).find(k=>k.field==='f_score').metric,'average');
});
test('legacy conversion preserves default KPI semantics and unrelated original row values',()=>{
  const legacy={id:1,account:'A',value:0,stage:'Warm',follow:'Today',close:'',owner:'',notes:'Keep',next:'',history:[]};
  const renamed=X.editColumn([legacy],null,[],'account',{name:'Customer'});assert.deepEqual(renamed.records,[legacy]);assert(renamed.tableSchema.legacy);
  assert.equal(X.calculate(X.kpis(null).find(k=>k.id==='kpi_value'),[legacy],null,[],'2026-09-23').value,0);
});
module.exports={schema,rows};
