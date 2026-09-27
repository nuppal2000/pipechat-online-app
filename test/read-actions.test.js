const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../public/report-engine'),C=require('../public/pipeline-core');
const custom=[{id:'cf_detailed',name:'Detailed Notes',type:'text'},{id:'cf_contact',name:'Primary Contact',type:'text'}];
const condition=(field,operator,value=null,values=[])=>({field,operator,value,values});
const query=(extra={})=>({action:'query_records',where:[],orderBy:null,direction:null,...extra});
const audit=(extra={})=>({action:'audit_records',scope:'all',where:[],groups:['stage','owner','cf_contact','follow'].map(field=>({label:'Missing '+field,where:[[condition(field,'is_blank')]]})),...extra});
const rows=Array.from({length:42},(_,i)=>({id:i+1,account:'Account '+(i+1),stage:i%7===0?'':i%2?'Proposal Sent':'Warm',owner:i%10===0?' ':i%2?'Sarah':'Neelam',cf_contact:i%6===0?null:'Contact '+i,follow:i%3===0?'':'2026-10-10',value:i*100,notes:i%5===0?'Uses spreadsheets':'',cf_detailed:i%4===0?'Needs help importing data':''}));
test('42-row missing-field audit computes independent overlapping groups from full data',()=>{
 const before=JSON.stringify(rows),r=R.auditRecords(rows,audit(),C,custom,{visibleIds:[2]});
 assert.equal(r.total,42);assert.deepEqual(r.groups.map(g=>g.count),[6,5,7,14]);
 assert.deepEqual(r.groups[0].records.map(r=>r.id),[1,8,15,22,29,36]);
 assert.deepEqual(r.groups[3].records.map(r=>r.id),[1,4,7,10,13,16,19,22,25,28,31,34,37,40]);
 assert(r.groups.every(g=>g.records.some(r=>r.id===1)));assert.equal(JSON.stringify(rows),before);
 assert.match(R.describeAudit(r),/Missing stage \(6\)/);assert.match(R.describeAudit(r),/Account 40 \(#40\)/);
});
test('multi-field audit equals individual audits including zero groups and visible/base scope',()=>{
 const action=audit(),all=R.auditRecords(rows,action,C,custom);
 all.groups.forEach((group,i)=>assert.deepEqual(R.auditRecords(rows,{...action,groups:[action.groups[i]]},C,custom).groups[0],group));
 const visible=R.auditRecords(rows,{...action,scope:'visible'},C,custom,{visibleIds:[1,2,3]});assert.equal(visible.total,3);assert.deepEqual(visible.groups.map(g=>g.count),[1,1,1,1]);
 const narrowed=R.auditRecords(rows,{...action,where:[[condition('owner','equals','Sarah')]]},C,custom);assert.equal(narrowed.total,21);assert.equal(narrowed.groups[1].count,0);
 const empty=R.auditRecords([],{...action},C,custom);assert(empty.groups.every(g=>g.count===0));assert.match(R.describeAudit(empty),/- None/);
});
test('blank checks include null/missing/whitespace but not numeric zero or text zero',()=>{
 const r=R.auditRecords([{id:1,account:'A',value:0},{id:2,account:'B',value:'0'},{id:3,account:'C',value:' '},{id:4,account:'D',value:null},{id:5,account:'E'}],audit({groups:[{label:'Missing value',where:[[condition('value','is_blank')]]}]}),C);
 assert.deepEqual(r.groups[0].records.map(r=>r.id),[3,4,5]);
});
test('audits use the effective primary column and preserve duplicate names with distinct IDs',()=>{
 const schema=require('../public/table-schema').legacySchema();schema.columnOrder=['owner',...schema.fields.map(f=>f.id).filter(id=>id!=='owner')];const core=C.create(schema);
 const r=R.auditRecords([{id:1,owner:'Same',stage:''},{id:2,owner:'Same',stage:''}],audit({groups:[{label:'Missing stage',where:[[condition('stage','is_blank')]]}]}),core);
 assert.deepEqual(r.groups[0].records,[{id:1,name:'Same'},{id:2,name:'Same'}]);
});
test('audits reject an invalid later group atomically instead of returning partial counts',()=>{
 for(const bad of [{label:'Bad',where:[[condition('unknown','is_blank')]]},{label:'Bad',where:[]},{label:'Missing stage',where:[[condition('owner','is_blank')]]},{label:'Bad',where:[[condition('value','is_blank',null,[])]] , extra:true}]){
  assert.throws(()=>R.auditRecords(rows,audit({groups:[audit().groups[0],bad]}),C,custom));
 }
 assert.throws(()=>R.auditRecords(rows,audit({scope:'sample'}),C,custom));
 assert.throws(()=>R.auditRecords(rows,audit({groups:Array.from({length:21},(_,i)=>({label:String(i),where:[[condition('owner','is_blank')]]}))}),C,custom));
});
test('record search ORs two note fields and alternatives without losing matched records',()=>{
 const where=['notes','cf_detailed'].flatMap(field=>['spreadsheets','importing data'].map(value=>[condition(field,'contains',value)]));
 const before=JSON.stringify(rows),r=R.queryRecords(rows,query({where}),C,custom);
 assert.deepEqual(r.rows.map(r=>r.id),rows.filter(r=>r.notes.includes('spreadsheets')||r.cf_detailed.includes('importing data')).map(r=>r.id));
 assert.equal(JSON.stringify(rows),before);assert.equal(r.sort,null);
});
test('fresh query combines stage AND either owner with numeric descending sort',()=>{
 const r=R.queryRecords(rows,query({where:[[condition('stage','equals','Proposal Sent'),condition('owner','in',null,['Sarah','Neelam'])]],orderBy:'value',direction:'desc'}),C,custom);
 const expected=rows.filter(r=>r.stage==='Proposal Sent'&&['Sarah','Neelam'].includes(r.owner)).sort((a,b)=>b.value-a.value);
 assert.deepEqual(r.rows,expected);assert.deepEqual(r.sort,{field:'value',direction:'desc'});
});
test('query sorting validates fields and preserves chronological/numeric/text semantics',()=>{
 const data=[{id:1,account:'Z',value:2,close:'2026-10-02'},{id:2,account:'A',value:100,close:'2026-09-10'}];
 for(const [orderBy,ids]of [['account',[2,1]],['value',[1,2]],['close',[2,1]]])assert.deepEqual(R.queryRecords(data,query({orderBy,direction:'asc'}),C).rows.map(r=>r.id),ids);
 for(const bad of [{orderBy:'unknown',direction:'asc'},{orderBy:'value',direction:null},{direction:'desc'},{where:[[condition('owner','contains','')]]},{unexpected:'write'}])assert.throws(()=>R.queryRecords(rows,query(bad),C,custom));
});
test('temporary KPI has no grouping or persistent definition and supports distinct independent measures',()=>{
 const action={action:'show_kpi',title:'Missing information',scope:'all',where:[],measures:['stage','owner','cf_contact','follow'].map(field=>({label:field,metric:'count',field:null,where:[[condition(field,'is_blank')]]}))};
 const spec=R.kpiReport(action),result=R.execute(rows,spec,C,custom);
 assert.equal(spec.chart,'kpi');assert.equal(spec.groupBy,null);assert.equal(spec.splitBy,null);assert.equal(result.count,42);
 assert.equal(result.labels.length,1);assert.deepEqual(result.datasets.map(d=>d.values[0]),[6,5,7,14]);
 assert.throws(()=>R.kpiReport({...action,kpiId:'saved'}));
});
test('all read-only schemas are strict and field enums are request-local',()=>{
 const schemas=R.readActionSchemas(C,custom),visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual(node.required.sort(),Object.keys(node.properties).sort());}for(const v of Object.values(node))if(v&&typeof v==='object')visit(v);};schemas.forEach(visit);
 const first=schemas[0];assert(first.properties.orderBy.enum.includes('cf_detailed'));assert(!R.readActionSchemas(C)[0].properties.orderBy.enum.includes('cf_detailed'));
 assert.equal(schemas[2].properties.groups.maxItems,20);assert.equal(schemas[1].properties.measures.maxItems,6);
});
