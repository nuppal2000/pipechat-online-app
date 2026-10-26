const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../public/report-engine'),Core=require('../public/pipeline-core'),Plan=require('../public/workspace-plan');
const field=(id,type='text',role='none',options=[])=>({id,name:id,type,role,options});
const schema={status:'ready',useCase:'Sales',title:'Prefix tests',recordLabel:'record',description:'',fields:[
  field('f_name','text','primary'),field('f_owner','text','owner'),field('f_value','currency'),field('f_score','number'),
  field('f_date','date','followup'),field('f_stage','choice','status',['Open','Won'])
]};
const core=Core.create(schema),today='2026-10-26';
const c=(field,operator,value=null,values=[])=>({field,operator,value,values});
const prefix=c('f_name','starts_with',' north '),where=[[prefix]];
const rows=['North Alpha','north Beta','  N\u00f3rth Gamma  ','NORTH Delta','South North','East North Alpha'].map((name,i)=>({id:i+1,f_name:name,f_owner:i===2?'Sam':'Lee',f_value:[10000,20000,0,4000,90000,100000][i],f_score:i,f_date:'',f_stage:'Open',history:[],activity:'',health:''}));
const measure=(metric='average',field='f_value',where=[])=>({label:metric,metric,field,where});
const spec=(extra={})=>({version:1,title:'Prefix average',chart:'kpi',scope:'all',groupBy:null,bucket:'none',splitBy:null,where,measures:[measure()],sort:'label_asc',limit:null,...extra});
const run=(extra={},records=rows)=>R.execute(records,spec(extra),core,[],{today});
const ids=(conditions,records=rows)=>records.filter(R.tableMatches({where:conditions},core,[],records,today)).map(r=>r.id);

test('F06 report prefix equals the explicit named union and averages 8500 of four, never embedded occurrences',()=>{
  const before=structuredClone(rows),result=run();
  assert.equal(result.count,4);assert.equal(result.summaries[0].value,8500);assert.equal(result.table[0].count,4);
  assert.deepEqual(result.representedIds,[1,2,3,4]);
  assert.deepEqual(run({where:rows.slice(0,4).map(row=>[c('f_name','equals',row.f_name)])}).summaries,result.summaries);
  assert.deepEqual(ids([[c('f_name','contains','North')]]),[1,2,3,4,5,6]);
  assert.match(result.description,/starts with/);assert.deepEqual(rows,before);
  const action={action:'show_kpi',title:'Average North names',scope:'all',where,measures:[measure()]};
  assert.equal(R.execute(rows,R.kpiReport(action),core,[],{today}).summaries[0].value,8500);
});

test('prefix normalization matches existing case, accents and spacing rules, with literal punctuation and blank exclusion',()=>{
  const variants=['  N\u00f3rth\t  Team Alpha','north team','Other North Team','',null,undefined];
  const input=variants.map((name,i)=>({...rows[0],id:i+1,f_name:name}));
  assert.deepEqual(ids([[c('f_name','starts_with',' NORTH   T\u00c9AM ')]],input),[1,2]);
  for(const literal of ['North.*','North%','North_','North[','North|South','x\'); DROP TABLE records; --']){
    const input=[literal+' A','Embedded '+literal,'North anything'].map((name,i)=>({...rows[0],id:i+1,f_name:name}));
    assert.deepEqual(ids([[c('f_name','starts_with',literal)]],input),[1],literal);
  }
  const custom=[{id:'cf_notes',name:'Notes',type:'text'}],customRows=[{...rows[0],cf_notes:'North memo'},{...rows[1],cf_notes:'Memo North'}];
  assert.deepEqual(customRows.filter(R.tableMatches({where:[[c('cf_notes','starts_with','North')]]},core,custom,customRows,today)).map(r=>r.id),[1]);
});

test('prefix predicates reach F01 record selections, queries, audits and refinements without broadening the cohort',()=>{
  const query={action:'query_records',where,orderBy:null,direction:null};
  assert.deepEqual(R.queryRecords(rows,query,core,[],{today}).rows.map(r=>r.id),[1,2,3,4]);
  const audit=R.auditRecords(rows,{action:'audit_records',scope:'all',where:[],groups:[{label:'Prefix',where}]},core,[],{today});
  assert.deepEqual(audit.groups[0].records.map(r=>r.id),[1,2,3,4]);
  const action={action:'filter_records',target:'pipeline_table',mode:'add_filter',where,removeFields:[]};
  const base={where:[[c('f_owner','equals','Lee')]]};
  const next=R.refineTableFilter(base,action,core,[],rows,today);
  assert.deepEqual(rows.filter(R.tableMatches(next,core,[],rows,today)).map(r=>r.id),[1,2,4]);
  const report=R.refine(spec({where:base.where}),R.filteringRefinement(action),core,[],{today,records:rows});
  assert.deepEqual(R.execute(rows,report,core,[],{today}).representedIds,[1,2,4]);
  assert.match(R.tableFilterDescription(next,core),/starts with/);
  const workspace={records:rows,tableSchema:schema,customFields:[],todoCards:[],dashboard:null,visibleIds:rows.map(r=>r.id)};
  const plan={action:'workspace_plan',version:1,title:'Prefix selection',goals:[{description:'Read prefixed names',stepIds:['read']}],steps:[
    {op:'select_records',id:'selected',label:'Prefix',source:'all',where,orderBy:null,direction:'asc',limit:null,relatedTasks:'any'},
    {op:'read_records',id:'read',label:'Read selected names',selection:'selected',showTable:true,outputs:[{kind:'count',field:null},{kind:'names',field:null}]}
  ]};
  const before=structuredClone(workspace),prepared=Plan.prepare(workspace,plan,{today,nonce:'prefix_qa'});
  assert.deepEqual(prepared.review[0].records.map(r=>r.id),[1,2,3,4]);assert.equal(prepared.mutates,false);assert.deepEqual(workspace,before);
});

test('prefix scopes retain OR/AND, visible scope, conditional numerator and empty-result semantics',()=>{
  assert.deepEqual(ids([[prefix,c('f_owner','equals','Sam')],[c('f_name','equals','South North')]]),[3,5]);
  assert.deepEqual(ids([[prefix,c('f_name','equals','South North')]]),[]);
  assert.deepEqual(R.execute(rows,spec({scope:'visible'}),core,[],{today,visibleIds:[2,5]}).representedIds,[2]);
  assert.equal(run({where:[],measures:[measure('percentage',null,where)]}).summaries[0].value,4/6*100);
  const empty=run({where:[[c('f_name','starts_with','Unmatched')]]});assert.equal(empty.count,0);assert.equal(empty.summaries[0].value,null);
});

test('prefix rejects choice, numeric/date fields and invalid operands instead of degrading to contains or all rows',()=>{
  for(const field of ['f_stage','f_value','f_score','f_date'])assert.throws(()=>run({where:[[c(field,'starts_with','1')]]}),field==='f_stage'?/exact options/:/text column/);
  for(const value of [null,0,true,{},[],NaN,Infinity,'',' \t\n ','\u0301'])assert.throws(()=>run({where:[[c('f_name','starts_with',value)]]}));
  for(const invalid of [{...prefix,values:['North']},{...prefix,values:null},{...prefix,value:undefined},{...prefix,field:'missing'},{...prefix,operator:'regex'}]){
    assert.throws(()=>run({where:[[invalid]]}));
    assert.throws(()=>R.queryRecords(rows,{action:'query_records',where:[[invalid]],orderBy:null,direction:null},core,[],{today}));
  }
  const custom=[{id:'cf_choice',name:'Custom choice',type:'choice',options:['North']}];
  assert.throws(()=>R.tableMatches({where:[[c('cf_choice','starts_with','North')]]},core,custom,[],today),/exact options/);
});

test('all request schemas inherit starts_with without losing existing operators',()=>{
  const old=['equals','not_equals','in','not_in','contains','not_contains','is_blank','is_not_blank','gt','gte','lt','lte','between','before_today','older_than_days'];
  assert.deepEqual([...R.operators].sort(),[...old,'starts_with'].sort());
  const enums=node=>!node||typeof node!=='object'?[]:[...(node.properties?.operator?.enum?[node.properties.operator.enum]:[]),...Object.values(node).flatMap(enums)];
  for(const s of [R.responseSchema(core),R.refinementSchema(core),R.filteringSchema(core),...R.readActionSchemas(core),Plan.responseSchema(core)]){
    const found=enums(s);assert(found.length);for(const values of found)assert(values.includes('starts_with'));
  }
});

test('every preexisting predicate keeps its matching and blank semantics',()=>{
  const input=['Alpha','Beta Alpha','Beta',''].map((name,i)=>({...rows[0],id:i+1,f_name:name,f_value:[0,10,20,null][i],f_stage:['Open','Won','','Open'][i],f_date:['2026-10-01','2026-10-26','2026-10-30',''][i]}));
  for(const [condition,expected] of [
    [c('f_name','equals','Alpha'),[1]],[c('f_name','not_equals','Alpha'),[2,3]],
    [c('f_name','in',null,['Beta']),[3]],[c('f_name','not_in',null,['Alpha']),[2,3]],
    [c('f_name','contains','Alpha'),[1,2]],[c('f_name','not_contains','Alpha'),[3]],
    [c('f_value','is_blank'),[4]],[c('f_value','is_not_blank'),[1,2,3]],
    [c('f_value','gt',10),[3]],[c('f_value','gte',10),[2,3]],[c('f_value','lt',10),[1]],[c('f_value','lte',10),[1,2]],
    [c('f_value','between',null,[0,10]),[1,2]],[c('f_date','before_today'),[1]],[c('f_date','older_than_days',7),[1]],
    [c('f_stage','equals','Open'),[1,4]],[c('f_stage','in',null,['Open','Won']),[1,2,4]]
  ])assert.deepEqual(ids([[condition]],input),expected,condition.operator);
  for(const operator of ['contains','not_contains'])assert.throws(()=>run({where:[[c('f_stage',operator,'Open')]]}),/exact options/);
});
