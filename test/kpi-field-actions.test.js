const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Schema=require('../public/table-schema'),Core=require('../public/pipeline-core'),X=require('../public/workspace-customization');
const Reports=require('../public/report-engine'),Dashboard=require('../public/dashboard-board');
const field=(id,type='text',role='none',options=[])=>({id,name:id,type,role,options});
const schema={status:'ready',useCase:'Other',title:'KPI field actions',description:'',recordLabel:'record',fields:[
  field('f_name','text','primary'),field('f_owner','text','owner'),field('f_value','currency'),
  field('f_date','date','followup'),field('f_when'),field('f_status','choice','status',['Warm','Won'])
]};
const custom=[{id:'cf_source',name:'Source',type:'text'}],today='2026-10-26';
const records=[0,100,200].map((value,i)=>({id:i+1,f_name:'Account '+i,f_owner:'Lee',f_value:value,f_date:i===0?'':'2026-10-05',f_when:['October 5 2026','2026/10/6',''][i],f_status:i===2?'Won':'Warm',cf_source:'Referral',history:[],activity:'',health:''}));
const c=(field,operator,value=null)=>({field,operator,value});
const count=(id,extra={})=>({id:'kpi_user_'+id,title:id,metric:'count',field:null,conditions:[],...extra});
const percentage=(id,where=[],denominatorWhere=[])=>count(id,{metric:'percentage',where,denominatorWhere});
const reload=s=>Schema.validate(JSON.parse(JSON.stringify(s)));
const calculate=(k,rows=records,s=schema,fields=custom)=>X.calculate(k,rows,s,fields,today);

test('column deletion removes whole KPIs referenced by metric, legacy AND, OR, numerator or denominator without broadening survivors',()=>{
  for(const id of ['f_value','f_date','cf_source','f_name']){
    const kpis=[
      count('metric',{metric:'average',field:'f_value'}),
      count('legacy',{conditions:[c(id,'is_not_blank')]}),
      count('union',{where:[[c(id,'is_not_blank')],[c('f_owner','equals','Lee')]]}),
      percentage('numerator',[[c(id,'is_blank')]]),
      percentage('denominator',[[c('f_owner','equals','Lee')]],[[c(id,'is_not_blank')],[c('f_owner','equals','Lee')]]),
      count('unrelated',{where:[[c('f_owner','equals','Lee')]]})
    ];
    const initial={...schema,kpis,hiddenKpis:['kpi_records']},before=structuredClone({initial,records,custom});
    const change=Core.create(initial).deleteColumn(records,id,custom,id==='f_name'?{field:'f_owner'}:null);
    assert.deepEqual(change.tableSchema.kpis,kpis.filter(k=>k.id==='kpi_user_unrelated'||k.id==='kpi_user_metric'&&id!=='f_value'));
    assert.deepEqual(change.tableSchema.hiddenKpis,initial.hiddenKpis);
    assert(change.records.every(row=>!Object.hasOwn(row,id)));
    assert.deepEqual({initial,records,custom},before);
    assert.doesNotThrow(()=>X.kpis(reload(change.tableSchema),change.customFields));
    assert.equal(calculate(change.tableSchema.kpis.at(-1),change.records,change.tableSchema,change.customFields).value,3);
  }
});

test('legacy schemas also remove grouped denominator references when deleting a custom column',()=>{
  const kpi=percentage('custom',[],[[c('cf_source','is_not_blank')]]),s={...Schema.legacySchema(),kpis:[kpi]};
  const rows=[{id:1,account:'A',owner:'',stage:'Warm',value:0,close:'',follow:'',next:'',notes:'',history:[],cf_source:'Referral'}];
  const changed=Core.create(s).deleteColumn(rows,'cf_source',custom);
  assert.deepEqual(changed.tableSchema.kpis,[]);assert.deepEqual(changed.customFields,[]);
  assert(changed.tableSchema.legacy);assert.equal(changed.records[0].value,0);
});

test('header renames preserve grouped predicates by field ID and refresh their preview labels',()=>{
  for(const id of ['f_date','cf_source']){
    const k=percentage('renamed',[[c(id,'is_blank')]],[[c('f_owner','equals','Lee')]]),s={...schema,kpis:[k]};
    const change=X.editColumn(records,s,custom,id,{name:'Renamed field'});
    assert.deepEqual(change.tableSchema.kpis,[k]);assert.deepEqual(change.records,records);
    assert.deepEqual(calculate(k),calculate(k,change.records,change.tableSchema,change.customFields));
    assert.match(X.summarize(k,change.records,change.tableSchema,change.customFields,today).definition,/Renamed field is blank/);
    assert.deepEqual(reload(change.tableSchema).kpis,[k]);
  }
});

test('numeric-to-choice conversion drops incompatible aggregate and grouped comparisons but preserves blank checks and unrelated KPIs',()=>{
  const kpis=[count('total',{metric:'sum',field:'f_value'}),
    count('union_number',{where:[[c('f_value','gte',0)],[c('f_owner','equals','Lee')]]}),
    percentage('denominator_number',[],[[c('f_value','gt',0)]]),
    percentage('blank',[[c('f_value','is_blank')]],[[c('f_owner','equals','Lee')]]),
    count('zero',{where:[[c('f_value','equals',0)]]})];
  const changed=X.editColumn(records,{...schema,kpis},custom,'f_value',{targetType:'choice',options:['0','100','200']});
  assert.deepEqual(changed.dropped,['total','union_number','denominator_number']);
  assert.deepEqual(changed.tableSchema.kpis,kpis.slice(3));
  assert.equal(calculate(changed.tableSchema.kpis[0],changed.records,changed.tableSchema).value,0);
  assert.equal(calculate(changed.tableSchema.kpis[1],changed.records,changed.tableSchema).value,1);
  assert.deepEqual(reload(changed.tableSchema).kpis,kpis.slice(3));
});

test('text-to-date conversion canonicalizes legacy, numerator and denominator equality literals without changing group logic',()=>{
  const kpis=[count('legacy_date',{conditions:[c('f_when','equals','October 5 2026')]}),
    percentage('dates',[[c('f_when','equals','October 5 2026')],[c('f_when','is_blank')]],[[c('f_when','not_equals','2026/10/6')]]),
    count('dynamic_today',{where:[[c('f_when','equals','today')]]}),
    count('invalid_date_literal',{where:[[c('f_when','equals','later')],[c('f_owner','equals','Lee')]]}),
    percentage('invalid_prefix',[],[[c('f_when','starts_with','October')]])];
  const s={...schema,kpis},before=structuredClone({s,records});
  const changed=X.editColumn(records,s,custom,'f_when',{targetType:'date'});
  assert.deepEqual(changed.dropped,['invalid_date_literal','invalid_prefix']);
  assert.deepEqual(changed.tableSchema.kpis[0].conditions,[c('f_when','equals','2026-10-05')]);
  assert.deepEqual(changed.tableSchema.kpis[1].where,[[c('f_when','equals','2026-10-05')],[c('f_when','is_blank')]]);
  assert.deepEqual(changed.tableSchema.kpis[1].denominatorWhere,[[c('f_when','not_equals','2026-10-06')]]);
  assert.deepEqual(changed.tableSchema.kpis[2],kpis[2]);
  for(let i=0;i<2;i++)assert.equal(calculate(changed.tableSchema.kpis[i],changed.records,changed.tableSchema).value,calculate(kpis[i]).value);
  assert.deepEqual({s,records},before);
  const revertedType=X.editColumn(changed.records,reload(changed.tableSchema),custom,'f_when',{targetType:'text'});
  assert.deepEqual(revertedType.tableSchema.kpis,changed.tableSchema.kpis);
  assert.deepEqual(revertedType.records,changed.records);
});

test('date-to-text conversion drops grouped relative-date references but retains type-independent predicates',()=>{
  const kpis=[percentage('old_denominator',[],[[c('f_date','before_today')]]),
    percentage('old_numerator',[[c('f_date','older_than_days',2)]]),
    percentage('blank',[[c('f_date','is_blank')]])];
  const changed=X.editColumn(records,{...schema,kpis},custom,'f_date',{targetType:'text'});
  assert.deepEqual(changed.dropped,['old_denominator','old_numerator']);assert.deepEqual(changed.tableSchema.kpis,[kpis[2]]);
  assert.equal(calculate(kpis[2],changed.records,changed.tableSchema).value,1/3*100);
});

test('explicit option-rename helper follows normalized equality references in every scope but preserves prefixes and other fields',()=>{
  const kpis=[count('legacy',{conditions:[c('f_status','equals',' warm '),c('f_name','not_equals','Warm')]}),
    count('grouped',{where:[[c('f_status','equals','WARM'),c('f_owner','equals','Lee')],[c('f_status','equals','Won')]]}),
    percentage('ratio',[[c('f_status','equals','warm')]],[[c('f_status','not_equals','Warm')],[c('f_status','equals','Won')]]),
    count('prefix',{where:[[c('f_status','starts_with','Warm')]]})];
  const before=structuredClone(kpis),renamed=kpis.map(k=>Core.renameKpiChoiceOption(k,'f_status','Warm','Engaged'));
  assert.deepEqual(renamed[0].conditions,[c('f_status','equals','Engaged'),c('f_name','not_equals','Warm')]);
  assert.deepEqual(renamed[1].where,[[c('f_status','equals','Engaged'),c('f_owner','equals','Lee')],[c('f_status','equals','Won')]]);
  assert.deepEqual(renamed[2].where,[[c('f_status','equals','Engaged')]]);
  assert.deepEqual(renamed[2].denominatorWhere,[[c('f_status','not_equals','Engaged')],[c('f_status','equals','Won')]]);
  assert.deepEqual(renamed[3],kpis[3]);assert.deepEqual(kpis,before);
  const changedRows=records.map(row=>({...row,f_status:row.f_status==='Warm'?'Engaged':row.f_status}));
  const changedSchema=reload({...schema,fields:schema.fields.map(f=>f.id==='f_status'?{...f,options:['Engaged','Won']}:f),kpis:renamed});
  for(let i=0;i<3;i++)assert.deepEqual(calculate(renamed[i],changedRows,changedSchema),calculate(kpis[i]));
  assert.equal(Core.create(schema).renameKpiChoiceOption(kpis[0],'f_status','Warm','Engaged').conditions[0].value,'Engaged');
  assert.equal(Core.renameKpiChoiceOption(count('zero',{conditions:[c('f_status','equals',0)]}),'f_status','0','Zero').conditions[0].value,'Zero');
});

test('KPI walkers validate malformed groups and mapper results; invalid rename inputs do not mutate definitions',()=>{
  const k=percentage('safe',[[c('f_status','equals','Warm')]],[[c('f_owner','equals','Lee')]]),before=structuredClone(k);
  for(const id of ['f_status','f_owner'])assert(Schema.kpiReferencesField(k,id));
  assert(!Schema.kpiReferencesField(k,'f_value'));
  assert(Schema.kpiReferencesField(count('total',{metric:'sum',field:'f_value'}),'f_value'));
  assert.throws(()=>Schema.kpiReferencesField({...k,denominatorWhere:[[]]},'f_status'));
  for(const result of [null,{...c('f_status','equals','Warm'),execute:'bad'},c('f_status','eval','bad')])assert.throws(()=>Schema.mapKpiConditions(k,()=>result));
  for(const args of [['bad;field','Warm','Hot'],['f_status','','Hot'],['f_status','Warm',''],['f_status','Warm','x'.repeat(81)],['f_status','Warm','Hot\n'],['f_status',true,'Hot']])assert.throws(()=>Core.renameKpiChoiceOption(k,...args));
  assert.deepEqual(k,before);
});

test('report percentage KPI rendering already supplies percent suffixes and explicit Not set for a zero denominator',()=>{
  const core=Core.create(schema),leaf={...c('f_date','is_blank'),values:[]};
  const spec={version:1,title:'Follow-up percentage',chart:'kpi',scope:'all',groupBy:null,bucket:'none',splitBy:null,where:[],measures:[{label:'Missing follow-up',metric:'percentage',field:null,where:[[leaf]]}],sort:'label_asc',limit:null};
  const rows=Array.from({length:49},(_,i)=>({...records[0],id:i+1,f_date:i<25?'':'2026-10-27'}));
  const root={PipeChatReports:Reports},nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',setAttribute(key,value){this[key]=value;}});return nodes.get(id);};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/report-ui'),'utf8'),{globalThis:root});
  for(const [population,expected,display] of [[rows,25/49*100,'51.0204%'],[rows.map(r=>({...r,f_date:'2026-10-27'})),0,'0%'],[[],null,'Not set']]){
    const result=Reports.execute(population,spec,core,[],{today});
    assert.equal(result.table[0].value,expected);assert.equal(result.table[0].type,'percent');
    root.PipeChatReportsUI.draw({spec,result,core,custom:[],document:{getElementById:node,querySelector:node},esc:String});
    assert(node('reportKpis').innerHTML.includes('<strong>'+display+'</strong>'));
    assert.equal(Dashboard.format(expected,'percent'),expected===null?'Not set':expected===0?'0%':'51.02%');
  }
});
