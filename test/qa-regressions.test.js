const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../public/pipeline-core'),I=require('../public/csv-import'),S=require('../public/table-schema'),R=require('../public/report-engine'),Sheet=require('../public/spreadsheet-import'),Papa=require('../public/vendor/papaparse.min');
const csv=name=>Papa.parse(fs.readFileSync(path.join(__dirname,'fixtures/pipechat-qa-'+name+'.csv'),'utf8'),{header:true,skipEmptyLines:true});
const field=(id,name,type='text',role='none',options=[])=>({id:'f_'+id,name,type,role,options});
const oldSales=S.validate({status:'ready',useCase:'Sales',description:'',title:'Sales pipeline',recordLabel:'opportunity',fields:[
  field('name','Opportunity Name','text','primary'),field('company','Account / Customer'),field('contact','Primary Contact'),field('email','Email / Phone'),
  field('stage','Deal Stage','choice','status',['Prospecting','Qualified','Proposal Sent','Negotiation','Closed Won','Closed Lost']),
  field('close','Expected Close Date','date'),field('value','Deal Value (USD)','currency'),field('probability','Win Probability (%)','number'),
  field('source','Lead Source','choice','none',['Inbound','Outbound','Referral','Partner','Event','Other']),field('next','Next Step'),field('owner','Deal Owner','text','owner'),field('contacted','Last Contacted','date'),field('notes','Notes')
]});
const oldMapping={columnMap:{f_company:'Company',f_owner:'Sales Rep',f_stage:'Deal Stage',f_value:'Deal Value USD',f_close:'Expected Close',f_contacted:'Follow-up Date',f_contact:'Contact',f_notes:'Notes'},choiceMappings:[]};

test('F01 exact Sales import cannot reinterpret Follow-up Date as Last Contacted',()=>{
  const source=csv('sales'),before=structuredClone(source.data),review=I.forTable(oldSales).build(source.meta.fields,source.data,oldMapping);
  assert.equal(review.records.length,12);assert.equal(review.mapping.f_contacted,null);
  assert(review.records.every(r=>r.f_contacted===''));assert(review.ignored.includes('Follow-up Date'));
  assert(review.warnings.some(w=>/different business events/.test(w)));assert.deepEqual(source.data,before);
  const matching={...oldSales,fields:oldSales.fields.map(f=>f.id==='f_contacted'?{...f,name:'Next Follow-up',role:'followup'}:f)};
  const safe=I.forTable(matching).build(source.meta.fields,source.data,oldMapping);
  assert.equal(safe.records[1].f_contacted,'2026-09-24');assert.equal(safe.records[4].f_contacted,'');
});

test('F02 missing primary names are identified, then actual CSV names support the original row-move request',()=>{
  const source=csv('sales'),importer=I.forTable(oldSales),blocked=importer.build(source.meta.fields,source.data,oldMapping);
  assert.equal(blocked.missingPrimary.length,12);
  const fixed=importer.build(source.meta.fields,source.data,{...oldMapping,columnMap:{...oldMapping.columnMap,f_company:null,f_name:'Company'}});
  assert.deepEqual(fixed.missingPrimary,[]);
  const rows=fixed.records.map((r,i)=>({...r,id:i+1})),move=C.create(oldSales).moveRecord(rows,{recordMatch:'Alder Labs',toPosition:2});
  assert.equal(move.records[1].f_name,'Alder Labs');assert.equal(move.records[1].f_value,12000);
  const partial=importer.build(['Company','Deal Value USD'],[{Company:'', 'Deal Value USD':'12'}],{columnMap:{f_name:'Company',f_value:'Deal Value USD'}});
  assert.deepEqual(partial.missingPrimary,[2]);
  assert.throws(()=>Sheet.build([['Company','Value'],['','12']],{useCase:'Sales'}),/blank names.*2/);
});

test('F03 exact sales stages propose safe equivalents and retain ambiguous stages as visible issues',()=>{
  const source=csv('sales'),analysis={...oldMapping,choiceMappings:[{field:'f_stage',source:'Won',target:'Closed Won'},{field:'f_stage',source:'Lost',target:'Closed Lost'},{field:'f_stage',source:'Proposal',target:'Proposal Sent'},{field:'f_stage',source:'Warm',target:null}]};
  const result=I.forTable(oldSales).build(source.meta.fields,source.data,analysis);
  assert.equal(result.records[1].f_stage,'Proposal Sent');assert.equal(result.records[4].f_stage,'Closed Won');assert.equal(result.records[5].f_stage,'Closed Lost');
  assert.equal(result.records[2].f_stage,'Negotiation');assert.equal(result.records[0].f_stage,'');assert.equal(result.records[3].f_stage,'');
  assert.equal(result.translations.length,5);assert(result.translations.every(t=>t.row>=2&&t.source&&t.target));
  assert(result.issues.some(i=>i.raw==='Discovery'));assert(result.issues.some(i=>i.raw==='Warm'));
  const invalid=I.forTable(oldSales).build(source.meta.fields,source.data,{...analysis,choiceMappings:[{field:'f_stage',source:'Won',target:'INVENTED'},{field:'f_stage',source:'Proposal',target:'Proposal Sent'},{field:'f_stage',source:'Proposal',target:'Qualified'},{field:'f_name',source:'Alder Labs',target:'Anything'}]});
  assert.equal(invalid.records[4].f_stage,'');assert.equal(invalid.records[1].f_stage,'');assert.equal(invalid.translations.length,0);
});

const condition=(field,operator,value=null,values=[])=>({field,operator,value,values});
const report=(where,measures)=>({version:1,title:'QA comparison',chart:'bar',scope:'all',groupBy:'f_name',bucket:'none',splitBy:null,measures,where,sort:'label_asc',limit:null});
test('F05 original two-property report filters its categories even when AI puts the subset inside the measure',()=>{
  const source=csv('real_estate'),core=C.create({...oldSales,fields:[field('name','Property','text','primary'),field('value','Asking Price USD','currency')]}),names=['55 King Street Unit 1','55 King Street Unit 2'];
  const rows=source.data.map((r,i)=>({id:i+1,f_name:r.Property,f_value:r['Asking Price USD']===''?null:Number(r['Asking Price USD'])}));
  const result=R.execute(rows,report([],[{label:'Asking Price',metric:'sum',field:'f_value',where:[[condition('f_name','in',null,names)]]}]),core);
  assert.deepEqual(result.labels,names);assert.deepEqual(result.datasets[0].values,[290000,310000]);assert.equal(result.count,2);
});

test('F05 exact salon two-measure alternative excludes the incomplete row from groups and matching count',()=>{
  const source=csv('nail_salon'),schema={...oldSales,fields:[field('name','Appointment ID','text','primary'),field('price','Service Price USD','currency'),field('deposit','Deposit USD','currency')]},core=C.create(schema);
  const rows=source.data.map((r,i)=>({id:i+1,f_name:r.Appointment,f_price:r['Service Price USD']===''?null:Number(r['Service Price USD']),f_deposit:r['Deposit USD']===''?null:Number(r['Deposit USD'])}));
  const where=[[condition('f_price','is_not_blank'),condition('f_deposit','is_not_blank')]];
  const result=R.execute(rows,report([],['f_price','f_deposit'].map(field=>({label:field,metric:'sum',field,where}))),core);
  assert.equal(result.count,11);assert.equal(result.labels.length,11);assert(!result.labels.includes('SAL-008'));assert(rows.some(r=>r.f_name==='SAL-008'));
  const cohorts=R.execute(rows,report([],[{label:'First',metric:'sum',field:'f_price',where:[[condition('f_name','equals','SAL-001')]]},{label:'Second',metric:'sum',field:'f_price',where:[[condition('f_name','equals','SAL-002')]]}]),core);
  assert.equal(cohorts.count,12,'different cohorts are not incorrectly intersected');
});

test('F06 date/time designs are separated and the original appointment values survive validation',()=>{
  const design=S.normalizeDesign({title:'Appointments',recordLabel:'appointment',fields:[field('name','Appointment ID','text','primary'),field('date','Appointment Date & Time','date'),field('notes','Notes')]});
  assert.deepEqual(design.fields.map(f=>[f.name,f.type]),[['Appointment ID','text'],['Appointment Date','date'],['Notes','text'],['Appointment Time','text']]);
  const schema=S.validate({...design,status:'ready',useCase:'Other',description:'Nail salon',fields:design.fields.map((f,i)=>({...f,id:'f_'+i}))}),core=C.create(schema);
  assert.equal(core.validateValue('f_1','2026-09-24'),'2026-09-24');assert.equal(core.validateValue('f_3','2:30 pm'),'2:30 pm');
  assert.throws(()=>core.validateValue('f_1','2026-09-24T14:30:00'),/cannot store times/);
  const time=S.normalizeDesign({fields:[field('time','Appointment Time','date')]}).fields[0];assert.equal(time.type,'text');
  assert.throws(()=>S.normalizeDesign({fields:Array.from({length:11},(_,i)=>field(String(i),'Field '+i))}),/at most 10/);
  assert.equal(S.designSchema.properties.fields.maxItems,10);assert.match(S.instructions,/6-8 essential/);
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');assert.match(server,/preserve Appointment time:/);assert.match(server,/deposit paid amount does not require/);
});
