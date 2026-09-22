const test=require('node:test'),assert=require('node:assert/strict');
const Schema=require('../public/table-schema.js'),Core=require('../public/pipeline-core.js'),Csv=require('../public/csv-import.js');
const {snapshotResult,createXanoBackend}=require('../lib/xano-backend.js');
const schema={status:'ready',useCase:'Recruiting',description:'',title:'Recruiting pipeline',recordLabel:'candidate',fields:[
  {id:'f_name',name:'Candidate name',type:'text',role:'primary',options:[]},
  {id:'f_owner',name:'Recruiter',type:'text',role:'owner',options:[]},
  {id:'f_stage',name:'Recruiting stage',type:'choice',role:'status',options:['Sourced','Interview','Hired']},
  {id:'f_pay',name:'Expected compensation',type:'currency',role:'none',options:[]},
  {id:'f_score',name:'Score',type:'number',role:'none',options:[]},
  {id:'f_due',name:'Follow-up date',type:'date',role:'followup',options:[]}
]};
const core=Core.create(schema),row=(id,name,owner,pay,score)=>({id,...core.tableValues({f_name:name,f_owner:owner,f_pay:pay,f_score:score}),history:[],activity:'',health:''});
const rows=[row(1,'Taylor','Ravi',100,3),row(2,'Morgan','Sarah',200,5),row(3,'Casey','Ravi',null,0),row(4,'Jamie','Daniel',900,9)];
const spec={metric:'sum',field:'f_pay',groupBy:'f_owner',chart:'bar',owners:['Ravi','Sarah'],accounts:null,filter:null,from:null,to:null,dateField:null};
test('a tailored schema replaces sales columns without modifying the default core',()=>{
  assert.deepEqual(Schema.validate(schema),schema);assert(!Object.hasOwn(core.fields,'account'));assert.equal(Core.fields.account,'Company');
  assert.equal(core.role('primary'),'f_name');assert.equal(core.stages.includes('Interview'),true);
  assert.deepEqual(core.tableValues({}),{f_name:'',f_owner:'',f_stage:'',f_pay:null,f_score:null,f_due:''});
});
test('schema validation rejects collisions, invalid types, missing identity and arbitrary object keys',()=>{
  for(const change of [{fields:[]},{fields:[...schema.fields,schema.fields[0]]},{fields:schema.fields.map(f=>({...f,role:'none'}))},{fields:[{...schema.fields[0],id:'__proto__'}]},{fields:[{...schema.fields[0],name:'history'}]}])assert.throws(()=>Schema.validate({...schema,...change}));
  assert.throws(()=>core.validateCustomFields([{id:'cf_recruiter',name:'Recruiter',type:'text'}]));
  assert.throws(()=>core.tableValues({f_missing:'x'}));assert.throws(()=>core.tableValues({f_pay:{bad:true}}));
});
test('setup is empty-only and cannot silently replace an existing CRM',()=>{
  assert.deepEqual(Schema.transition({status:'pending'},schema,[]),schema);
  assert.throws(()=>Schema.transition({status:'pending'},schema,rows));assert.throws(()=>Schema.transition(null,schema,[]));
  assert.throws(()=>Schema.transition(schema,null,[]));assert.throws(()=>Schema.transition(schema,{status:'pending'},[]));
  assert.throws(()=>Schema.transition(schema,{...schema,fields:schema.fields.map(f=>f.id==='f_pay'?{...f,type:'number'}:f)},rows));
});
test('typed validation preserves zero and blanks, accepts workflow choices and rejects sales defaults',()=>{
  assert.equal(core.validateStoredValue('f_pay',''),null);assert.equal(core.validateValue('f_score','0'),0);
  assert.equal(core.validateValue('f_stage','interview'),'Interview');assert.throws(()=>core.validateValue('f_stage','Proposal Sent'));
  assert.equal(core.validateValue('f_due','Nov 30, 2026'),'2026-11-30');assert.throws(()=>core.validateValue('f_due','2026-02-30'));
});
test('chat/manual plans target primary names, retain ambiguity checks and stale-write protection',()=>{
  const plan=core.plan(rows,{action:'update_records',changes:[{recordMatch:'Taylor',field:'Recruiting stage',value:'Interview'},{recordMatch:'Taylor',field:'Expected compensation',value:0}]});
  assert.equal(rows[0].f_stage,'');const next=core.apply(rows,plan,'QA');assert.equal(next[0].f_stage,'Interview');assert.equal(next[0].f_pay,0);
  assert.throws(()=>core.apply(next,plan,'QA'));
  assert(core.plan([...rows,{...rows[0],id:5}],{action:'update_record',recordMatch:'Taylor',ids:[1],field:'f_stage',value:'Hired'}).clarification);
});
test('contextual filters support numbers, workflow statuses, dates and blank values',()=>{
  assert.deepEqual(rows.filter(core.predicate({field:'f_score',operator:'gte',value:3})).map(r=>r.id),[1,2,4]);
  assert.deepEqual(rows.filter(core.predicate({field:'f_pay',operator:'is_blank'})).map(r=>r.id),[3]);
  assert(core.predicate({field:'f_due',operator:'month_equals',value:11})({f_due:'2026-11-30'}));
});
test('contextual reports compare owner and record subsets and exclude unknowns from averages',()=>{
  assert.deepEqual(core.report(rows,spec).data,[{label:'Sarah',value:200,count:1},{label:'Ravi',value:100,count:2}]);
  assert.equal(core.report(rows,{...spec,metric:'average'}).data.find(r=>r.label==='Ravi').value,100);
  assert.equal(core.report(rows,{...spec,groupBy:'f_name',accounts:['Taylor','Morgan']}).data.length,2);
  assert.equal(core.report(rows,{...spec,owners:[]}).count,0);assert.deepEqual(core.report([],spec).data,[]);
  assert.throws(()=>core.report(rows,{...spec,field:'account'}));
});
test('dashboard recontextualizes after schema additions, deletions and undo without phantom charts',()=>{
  const removed={...schema,fields:schema.fields.filter(f=>!['f_pay','f_owner'].includes(f.id))},next=Core.create(removed);
  const report=next.reconcileReport({...spec,filter:{field:'f_pay',operator:'gte',value:1}});
  assert.equal(report.field,'f_score');assert.equal(report.groupBy,'f_stage');assert.equal(report.owners,null);assert.equal(report.filter,null);
  assert.equal(next.reconcileReport({...spec,metric:'count'}).field,'f_score');
  const textOnly=Core.create({...schema,fields:[schema.fields[0]]});assert.equal(textOnly.reconcileReport(spec).metric,'count');
  const extras=[{id:'cf_contact',name:'Contact',type:'text'}];assert(core.reportOptions(extras).groups.some(f=>f.id==='cf_contact'));
  assert(!core.reportOptions().groups.some(f=>f.id==='cf_contact'));assert(core.reportOptions().metrics.some(f=>f.id==='f_pay'));
});
test('contextual CSV maps semantic headers, keeps valid cells and blanks uncertain ones',()=>{
  const importer=Csv.forTable(schema),headers=['Applicant','Assigned consultant','Annual expectation','Interview status','Reminder','Extraneous'];
  const result=importer.build(headers,[{Applicant:'Taylor','Assigned consultant':'Ravi','Annual expectation':'$80,000','Interview status':'Interview',Reminder:'2026-11-30'},{Applicant:'Morgan','Annual expectation':'unclear','Interview status':'Active'}],{columnMap:{f_name:'Applicant',f_owner:'Assigned consultant',f_pay:'Annual expectation',f_stage:'Interview status',f_due:'Reminder'}});
  assert.equal(result.records[0].f_pay,80000);assert.equal(result.records[0].f_stage,'Interview');assert.equal(result.records[1].f_pay,null);assert.equal(result.records[1].f_stage,'');assert.equal(result.issues.length,2);assert(result.ignored.includes('Extraneous'));
  assert(!Object.hasOwn(importer.schema.properties.columnMap.properties,'account'));assert.match(importer.instructions,/business meaning/);
});
test('Xano projection retains only active fields and preserves an empty schema',()=>{
  const data=snapshotResult({deals:rows,customFields:[],tableSchema:schema,updatedAt:'v1'});assert.deepEqual(data.deals,rows);assert.deepEqual(data.tableSchema,schema);
  assert.deepEqual(snapshotResult({...data,deals:[]}).tableSchema,schema);
  assert(!Object.hasOwn(snapshotResult({...data,deals:[{...rows[0],password:'never returned'}]}).deals[0],'password'));
});
test('tailored writes fail before PUT against Xano without schema support',async()=>{
  let puts=0;const backend=createXanoBackend({baseUrl:'https://qa.example/api:qa',serverKey:'x'.repeat(32),fetchImpl:async(url,options)=>{if(options.method==='PUT')puts++;return {ok:true,json:async()=>({deals:[],customFields:[],updatedAt:null})};}});
  await assert.rejects(()=>backend.writeCrm('token',[],null,[],schema),/table-schema support/);assert.equal(puts,0);
});
test('generated Xano helper round-trips tailored cells and blocks schema-stripping transitions',()=>{
  const run=new Function('$input',require('../scripts/build-xano-custom-fields.js').code);
  const saved=run({mode:'write',payload:{tableSchema:schema,customFields:[],deals:rows}});
  assert.equal(saved.ok,true);
  const read=run({mode:'read',payload:{customData:saved.data,deals:rows.map(r=>({id:r.id,history:[],activity:'',health:'',account:''})),updatedAt:'qa'}});
  assert.deepEqual(read.data.deals,rows);assert.deepEqual(read.data.tableSchema,schema);
  assert.equal(run({mode:'transition',payload:{current:saved.data,next:{fields:[],cells:{}},deals:[]}}).data.valid,false);
  assert.equal(run({mode:'transition',payload:{current:{tableSchema:{status:'pending'}},next:saved.data,deals:[]}}).data.valid,true);
  assert.equal(run({mode:'transition',payload:{current:{tableSchema:{status:'pending'}},next:saved.data,deals:rows}}).data.valid,false);
  assert.equal(run({mode:'transition',payload:{current:{},next:saved.data,deals:[]}}).data.valid,false);
  const empty=run({mode:'read',payload:{customData:saved.data,deals:[],updatedAt:'qa'}});
  assert.deepEqual(empty.data.tableSchema,schema);assert.deepEqual(empty.data.deals,[]);
});
module.exports={schema};
