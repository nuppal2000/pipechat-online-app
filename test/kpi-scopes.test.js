const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const Schema=require('../public/table-schema'),Core=require('../public/pipeline-core'),X=require('../public/workspace-customization');

const schema={status:'ready',useCase:'Sales',title:'KPI regression',recordLabel:'record',description:'',fields:[
  {id:'f_name',name:'Name',type:'text',role:'primary',options:[]},
  {id:'f_value',name:'Value',type:'currency',role:'none',options:[]},
  {id:'f_score',name:'Score',type:'number',role:'none',options:[]},
  {id:'f_follow',name:'Follow-up',type:'date',role:'followup',options:[]},
  {id:'f_status',name:'Status',type:'choice',role:'status',options:['Open','Won']}
]};
const core=Core.create(schema),today='2026-10-26';
const c=(field,operator,value=null)=>({field,operator,value});
const names=['North Alpha','North Beta','North Gamma','North Delta'];
const records=[10000,20000,0,4000].map((value,i)=>({id:i+1,f_name:names[i],f_value:value,f_score:value,f_follow:'',f_status:'Open',history:[],activity:'',health:''}));
const namedWhere=names.map(name=>[c('f_name','equals',name)]);
const average={id:'kpi_user_average',title:'Average selected value',metric:'average',field:'f_value',conditions:[],where:namedWhere};
const percentage={id:'kpi_user_percentage',title:'Missing follow-up percentage',metric:'percentage',field:null,conditions:[],where:[[c('f_follow','is_blank')]],denominatorWhere:[]};
const fortyNine=Array.from({length:49},(_,i)=>({...records[i%4],id:i+1,f_name:'Record '+(i+1),f_follow:i<25?'':'2026-11-01'}));
const calculate=(k,rows=records,s=schema,custom=[])=>X.calculate(k,rows,s,custom,today);
const reload=value=>Schema.validate(JSON.parse(JSON.stringify(value)));
const dateSpaces=[' ','\t','\n','\r','\v','\f','\u00a0','\u1680','\u2000','\u2001','\u2002','\u2003','\u2004','\u2005','\u2006','\u2007','\u2008','\u2009','\u200a','\u2028','\u2029','\u202f','\u205f','\u3000','\ufeff'];

function invalidDefinitions(){
  const leaf=c('f_name','equals','North Alpha');
  const scoped=(where,extra={})=>({...average,where,...extra});
  const cases=[
    null,[],{...average,metric:'eval'},{...average,id:'kpi_user_x;drop table records'},
    {...average,title:''},{...average,title:'x'.repeat(121)},{...average,title:'x\ny'},
    {...average,field:1},{...average,field:'__proto__'},{...average,expression:'return 1'},
    {...average,conditions:null},{...average,conditions:[leaf]},
    scoped(null),scoped({or:[leaf]}),scoped([leaf]),scoped([[]]),scoped([null]),
    scoped(Array.from({length:13},()=>[leaf])),scoped([Array(21).fill(leaf)]),
    scoped([[{...leaf,operator:'contains'}]]),scoped([[{...leaf,operator:'in',values:['North Alpha']}]]),
    scoped([[{...leaf,value:true}]]),scoped([[{...leaf,value:[]}]]),scoped([[{...leaf,value:{sql:'1=1'}}]]),
    scoped([[{...leaf,value:'x'.repeat(12001)}]]),scoped([[{...leaf,value:1e12+1}]]),
    scoped([[{field:'f_name',operator:'equals'}]]),scoped([[{...leaf,or:true}]]),
    scoped([[{...leaf,field:'f_name;drop table x'}]]),scoped([[null]]),scoped([[[leaf]]]),
    {...average,denominatorWhere:[]},{...percentage,field:'f_value'},
    {...percentage,denominatorWhere:null},{...percentage,denominatorWhere:[[]]},
    {...percentage,numeratorCount:25},{...percentage,value:100},
    JSON.parse('{"id":"kpi_user_x","title":"X","metric":"count","field":null,"conditions":[],"__proto__":{"polluted":true}}')
  ];
  for(const key of ['where','denominatorWhere','conditions','field']){const bad={...percentage};delete bad[key];cases.push(bad);}
  for(const key of ['id','title','metric']){const bad={...average};delete bad[key];cases.push(bad);}
  cases.push({...average,id:'kpi_'+'x'.repeat(101)},{...average,title:'\ud83d\ude00'.repeat(61)},
    {...average,where:[[c('f_'+'x'.repeat(64),'equals','x')]]},
    {id:'kpi_legacy',title:'Legacy',metric:'count',field:null,conditions:Array(11).fill(leaf)});
  for(const key of ['field','operator','value']){const bad={...leaf};delete bad[key];cases.push(scoped([[bad]]));}
  return cases;
}
function invalidReferences(){
  return [
    {...average,field:'missing'}, {...average,field:'f_name'},
    {...average,metric:'count'},
    ...[
      c('missing','equals','x'),c('constructor','equals','x'),c('f_follow','is_blank',''),
      c('f_follow','before_today',1),c('f_name','before_today'),c('f_status','older_than_days',2),
      c('f_follow','older_than_days',-1),c('f_follow','older_than_days',1.5),c('f_follow','older_than_days',36501),
      c('f_follow','older_than_days','2'),c('f_value','gt','100'),c('f_name','gt',1),
      c('f_follow','lt','2026-02-30'),c('f_follow','lt','Oct 32, 2026'),c('f_follow','lt',null),
      ...['gt','gte','lt','lte'].flatMap(op=>['October\u00851\u00852026','October\u180e1\u180e2026','October\u200b1\u200b2026',
        '2026 -10-01','0099-01-01','0000-01-01','February 29 2026',0,''].map(value=>c('f_follow',op,value))),
      c('f_name','equals'),c('f_name','starts_with',''),c('f_name','starts_with','\u00a0\t'),c('f_name','starts_with','\u0301'),
      c('f_name','starts_with',10),c('f_value','starts_with','1'),c('f_follow','starts_with','2026')
    ].map(leaf=>({...average,where:[[leaf]]})),
    {...percentage,denominatorWhere:[[c('missing','is_not_blank')]]},
    {...percentage,denominatorWhere:[[c('f_value','gt','1 OR 1=1')]]}
  ];
}

test('F06 explicit name unions and normalized prefixes both average 8500 from four values, including zero',()=>{
  const rows=[...records,{...records[0],id:5,f_name:'Other',f_value:90000}];
  for(const where of [namedWhere,[[c('f_name','starts_with',' north ')]],[...namedWhere,namedWhere[0]],[[c('f_name','starts_with','North')],namedWhere[0]]]){
    const k={...average,where},result=calculate(k,rows);
    assert.deepEqual(result,{value:8500,type:'currency',count:4,numericCount:4});
    const preview=X.summarize(k,rows,schema,[],today);
    assert.equal(preview.displayValue,'$8,500');assert.match(preview.summary,/4 matching records; 4 numeric values/);
    assert.match(preview.definition,/Name/);
  }
  const saved=X.addKpi(schema,[],average.id,average);
  const loaded=X.kpis(reload(saved.tableSchema)).find(k=>k.id===average.id);
  assert.deepEqual(loaded,average);assert.deepEqual(calculate(loaded,rows),calculate(average,rows));
  assert.equal(schema.kpis,undefined);assert.equal(records[2].f_value,0);
});

test('AND stays AND, OR branches retain local constraints, and prefix is literal rather than a regular expression',()=>{
  const legacy={...average,conditions:[c('f_name','equals',names[0]),c('f_name','equals',names[1])]};delete legacy.where;
  assert.equal(calculate(legacy).count,0);assert.equal(calculate(legacy).value,null);
  assert.equal(calculate({...average,where:[legacy.conditions]}).count,0);
  const where=[[c('f_name','starts_with','North'),c('f_value','lte',4000)],[c('f_name','equals',names[0]),c('f_status','equals','Open')]];
  assert.equal(calculate({...average,where}).count,3);
  assert.equal(calculate({...average,where}).value,14000/3);
  for(const prefix of ['.*','North%','North_','x\'); drop table x; --'])assert.equal(calculate({...average,where:[[c('f_name','starts_with',prefix)]]}).count,0);
  const edited=X.configure(X.addKpi(schema,[],average.id,average).tableSchema,[],average.id,{...average,where:[[c('f_name','starts_with','North')]]});
  assert.equal(calculate(X.kpis(reload(edited.tableSchema)).find(k=>k.id===average.id)).value,8500);
});

test('averages distinguish zero from missing or invalid numeric values and expose both row and numeric counts',()=>{
  const rows=[...records,...[null,undefined,'','   ',false,[],{},'bad',Infinity].map((value,i)=>({...records[0],id:10+i,f_value:value}))];
  assert.deepEqual(calculate(average,rows),{value:8500,type:'currency',count:13,numericCount:4});
  assert.equal(calculate({...average,field:'f_score'}).value,8500);
  assert.equal(calculate(average,[{...records[0],f_value:'0'}]).value,0);
  assert.equal(calculate(average,[{...records[0],f_value:null}]).value,null);
  assert.equal(X.summarize(average,[],schema,[],today).displayValue,'Not set');
  assert.equal(calculate({...average,metric:'sum'},[{...records[0],f_value:0}]).value,0);
  assert.equal(calculate({...average,metric:'sum'},[]).value,null);
});

test('F07 saved percentages count blank follow-ups out of all 49 and recalculate after date edits and reload',()=>{
  const before=structuredClone(fortyNine),saved=X.addKpi(schema,[],percentage.id,percentage);
  const loaded=X.kpis(reload(saved.tableSchema)).find(k=>k.id===percentage.id);
  const first=calculate(loaded,fortyNine);
  assert.deepEqual(first,{value:25/49*100,type:'percentage',count:25,numeratorCount:25,denominatorCount:49});
  const summary=X.summarize(loaded,fortyNine,saved.tableSchema,[],today);
  assert.equal(summary.displayValue,'51.02%');assert.match(summary.summary,/25 \/ 49 records/);assert.match(summary.definition,/Denominator: all records/);
  const changed=fortyNine.map((row,i)=>i<3?{...row,f_follow:'2026-10-27'}:row);
  assert.equal(calculate(loaded,changed).value,22/49*100);
  assert.equal(calculate(loaded,changed.map(row=>({...row,f_follow:'2026-10-27'}))).value,0);
  assert.deepEqual(fortyNine,before);assert.deepEqual(loaded,percentage);
  assert.deepEqual(calculate(loaded,changed),calculate(X.kpis(reload(saved.tableSchema)).find(k=>k.id===percentage.id),changed));
});

test('percentage denominator defines its population; numerator refines it, unions deduplicate, and zero denominator is Not set',()=>{
  const rows=[...records,{...records[0],id:5,f_name:'Other',f_follow:''}],k={...percentage,denominatorWhere:[[c('f_name','starts_with','North')],[c('f_name','equals',names[0])]]};
  rows[0].f_follow='2026-10-27';rows[1].f_follow='2026-10-28';
  assert.deepEqual(calculate(k,rows),{value:50,type:'percentage',count:2,numeratorCount:2,denominatorCount:4});
  assert.equal(calculate({...k,where:[[c('f_name','equals','Other')]]},rows).value,0);
  const empty={...k,denominatorWhere:[[c('f_value','gt',1e9)]]};
  for(const result of [calculate(empty,rows),calculate(percentage,[])]){
    assert.equal(result.value,null);assert.equal(result.denominatorCount,0);assert.equal(result.numeratorCount,0);
  }
  const preview=X.summarize(empty,rows,schema,[],today);
  assert.equal(preview.displayValue,'Not set');assert.match(preview.summary,/0 \/ 0 records \(zero denominator\)/);
  assert.equal(calculate({...percentage,where:[]},rows).value,100);
  const blanks=[null,undefined,'','  ',0].map((value,i)=>({...records[0],id:i+1,f_follow:value}));
  assert.equal(calculate(percentage,blanks).value,80);
});

test('legacy defaults, dynamic today, custom columns, date comparisons and stored AND definitions remain compatible',()=>{
  const legacy=[{id:1,account:'A',stage:'Warm',value:0,follow:'Today'},{id:2,account:'B',stage:'Won',value:50,follow:'2026-10-26'}];
  assert.equal(calculate(X.kpis(null).find(k=>k.id==='kpi_records'),legacy,null).value,1);
  assert.equal(calculate(X.kpis(null).find(k=>k.id==='kpi_value'),legacy,null).value,0);
  assert.equal(calculate(X.kpis(null).find(k=>k.id==='kpi_followup'),legacy,null).value,2);
  const stale={id:'kpi_user_stale',title:'Stale',metric:'count',field:null,conditions:[c('f_follow','older_than_days',7),c('f_status','not_equals','Won')]};
  const rows=[{...records[0],f_follow:'2026-10-01'},{...records[1],f_follow:'2026-10-25'},{...records[2],f_follow:'2026-10-01',f_status:'Won'},records[3]];
  assert.equal(calculate(stale,rows).value,1);assert.deepEqual(Schema.validateKpis([stale]),[stale]);
  assert.equal(calculate({...stale,conditions:[c('f_follow','lt','October 20, 2026')]},rows).value,2);
  const custom=[{id:'cf_team',name:'Team',type:'text'}],k={...percentage,denominatorWhere:[[c('cf_team','starts_with','A')]]};
  assert.equal(calculate(k,[{...records[0],cf_team:'Alpha'}, {...records[1],cf_team:'Beta'}],schema,custom).denominatorCount,1);
  const renamed=X.editColumn(records,X.addKpi(schema,[],percentage.id,percentage).tableSchema,[],'f_follow',{name:'Next contact'});
  assert.match(X.summarize(percentage,records,renamed.tableSchema,[],today).definition,/Next contact/);
  const converted=X.editColumn(records,X.addKpi(schema,[],average.id,{...average,where:[[c('f_follow','before_today')]]}).tableSchema,[],'f_follow',{targetType:'text'});
  assert.deepEqual(converted.dropped,[average.title]);
});

test('malformed, ambiguous, unbounded and malicious definitions fail before evaluation or persistence',()=>{
  for(const bad of invalidDefinitions()){
    assert.throws(()=>Schema.validateKpis([bad]),undefined,JSON.stringify(bad));
    assert.throws(()=>calculate(bad),undefined,JSON.stringify(bad));
  }
  for(const bad of invalidReferences())assert.throws(()=>calculate(bad),undefined,JSON.stringify(bad));
  for(const value of [NaN,Infinity,-Infinity,()=>1])assert.throws(()=>calculate({...average,where:[[c('f_value','gt',value)]]}));
  assert.throws(()=>Schema.validateKpis([average,average]));assert.throws(()=>Schema.validateKpis(Array(121).fill(average)));
  assert.throws(()=>calculate({...average,where:undefined}));
  assert.throws(()=>calculate(average,{}));
  assert.throws(()=>X.calculate(average,records,schema,[],'bad date'));
  assert.equal({}.polluted,undefined);
});

test('024 full local migration chain preserves saved KPIs and ACLs, validates JS/SQL symmetrically, and persists dynamic scopes',{timeout:180000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const run=async name=>db.exec(await fs.readFile(path.join(__dirname,'../db',name),'utf8'));
  await run('tests/mock-supabase.sql');
  const files=(await fs.readdir(path.join(__dirname,'../db/migrations'))).filter(name=>/^\d{3}-.*\.sql$/.test(name)).sort();
  assert(files.includes('024-kpi-scopes.sql'));
  for(const name of files.filter(name=>name<'024-'))await run('migrations/'+name);
  const aclSql="select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) args, p.proacl::text acl, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('pipechat','public') order by 1,2,3";
  const beforeAcl=(await db.query(aclSql)).rows;
  const user={id:randomUUID(),session:randomUUID()};
  await db.query('insert into auth.users(id) values ($1)',[user.id]);
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2)',[user.session,user.id]);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user.id,session_id:user.session,role:'authenticated'})]);
  async function rpc(sql,args=[]){await db.exec('set role authenticated');try{return (await db.query(sql,args)).rows[0]?.result;}finally{await db.exec('reset role');}}
  const read=()=>rpc('select public.pipechat_read_crm() result');
  const write=(rows,s,revision)=>rpc('select public.pipechat_write_crm($1::jsonb,$2::jsonb,$3::jsonb,$4) result',[JSON.stringify(rows),'[]',JSON.stringify(s),revision]);
  const legacy={id:'kpi_user_legacy',title:'Existing average',metric:'average',field:'f_value',conditions:[c('f_status','not_equals','Won')]};
  const oldSchema={...schema,kpis:[legacy]};
  let saved=await write([],oldSchema,null);
  saved=await write(fortyNine,oldSchema,saved.updatedAt);
  const before=await read();
  await run('migrations/024-kpi-scopes.sql');
  assert.deepEqual((await db.query(aclSql)).rows,beforeAcl);assert.deepEqual(await read(),before);
  await run('migrations/024-kpi-scopes.sql');
  assert.deepEqual((await db.query(aclSql)).rows,beforeAcl);assert.deepEqual(await read(),before);
  for(const name of files.filter(name=>name>'024-kpi-scopes.sql'))await run('migrations/'+name);
  await run('tests/security.sql');
  const sqlValidate=async (definitions,defs=null)=>(await db.query('select pipechat.validate_kpis($1::jsonb,$2::jsonb) result',[JSON.stringify(definitions),defs===null?null:JSON.stringify(defs)])).rows[0].result;
  const defs=core.definitions([]),valid=[legacy,average,percentage,{...average,where:[[c('f_name','starts_with','North')]]},
    {...percentage,denominatorWhere:[[c('f_status','equals','Open')]]},
    {...legacy,conditions:[c('f_follow','lt','October 20, 2026')]},
    {...average,where:[[c('f_name','equals',"x'); drop table auth.users; --")]]},
    {...average,where:[]}, {...average,where:Array.from({length:12},()=>Array.from({length:20},()=>c('f_value','gte',0)))},
    {...legacy,title:'  Trim me  ',conditions:[c('f_value','gt',1e12)]},
    {...legacy,id:'kpi_'+'x'.repeat(100),title:'x'.repeat(120),conditions:Array(10).fill(c('f_value','gte',-1e12))},
    {...average,title:'\ud83d\ude00'.repeat(60),where:[[c('f_name','equals','x'.repeat(12000))]]}
  ];
  for(const leaf of [c('f_status','starts_with','Op'),c('f_value','equals',0),c('f_value','not_equals',0),
    c('f_name','is_blank'),c('f_follow','is_not_blank'),c('f_follow','before_today'),c('f_follow','older_than_days',0),
    c('f_follow','older_than_days',36500),c('f_value','gt',0),c('f_value','gte',0),c('f_value','lt',0),c('f_value','lte',0),
    c('f_follow','gt','2026-10-26'),c('f_follow','equals','today')]){
    valid.push({...legacy,conditions:[leaf]},{...percentage,denominatorWhere:[[leaf]]});
  }
  for(const op of ['gt','gte','lt','lte'])for(const space of dateSpaces){
    valid.push({...percentage,denominatorWhere:[[c('f_follow',op,space+'October'+space+'20,'+space+'2026'+space)]]});
  }
  for(const value of ['0100-01-01','9999-12-31','2024-02-29','January 1 0099'])valid.push({...legacy,conditions:[c('f_follow','gt',value)]});
  for(const k of valid){
    const canonical=Schema.validateKpis([k]);
    assert.deepEqual(await sqlValidate([k]),canonical);
    assert.deepEqual(await sqlValidate([k],defs),[X.validateReferences(k,core)]);
  }
  const atCapacity=Array.from({length:120},(_,i)=>({...average,id:'kpi_capacity_'+i}));
  assert.deepEqual(await sqlValidate(atCapacity,defs),Schema.validateKpis(atCapacity));
  for(const k of invalidDefinitions()){
    assert.throws(()=>Schema.validateKpis([k]));
    await assert.rejects(()=>sqlValidate([k]),e=>e.code==='PT400',JSON.stringify(k));
  }
  for(const k of invalidReferences()){
    assert.throws(()=>X.validateReferences(k,core));
    await assert.rejects(()=>sqlValidate([k],defs),e=>e.code==='PT400',JSON.stringify(k));
  }
  await assert.rejects(()=>sqlValidate([average,average]),e=>e.code==='PT400');
  await assert.rejects(()=>sqlValidate(Array(121).fill(average)),e=>e.code==='PT400');
  const next=X.addKpi(X.addKpi(saved.tableSchema,[],average.id,average).tableSchema,[],percentage.id,percentage).tableSchema;
  saved=await write(saved.deals,next,saved.updatedAt);
  const loaded=await read();assert.deepEqual(loaded.tableSchema,next);assert.deepEqual(loaded.deals,before.deals);
  const card=X.kpis(loaded.tableSchema).find(k=>k.id===percentage.id);
  assert.equal(calculate(card,loaded.deals).value,25/49*100);
  const edited=loaded.deals.map((row,i)=>i<4?{...row,f_follow:'2026-10-27'}:row);
  saved=await write(edited,loaded.tableSchema,loaded.updatedAt);
  assert.equal(calculate(card,(await read()).deals).value,21/49*100);
  const fourRows=[...records];saved=await write(fourRows,saved.tableSchema,saved.updatedAt);
  const averageLoaded=X.kpis((await read()).tableSchema).find(k=>k.id===average.id);
  assert.equal(calculate(averageLoaded,(await read()).deals).value,8500);
  const beforeRejectedWrite=await read();
  await assert.rejects(()=>write(saved.deals,{...saved.tableSchema,kpis:[{...percentage,denominatorWhere:[[c('missing','is_blank')]]}]},saved.updatedAt),e=>e.code==='PT400');
  assert.deepEqual(await read(),beforeRejectedWrite);
  const deleted=Core.create(saved.tableSchema).deleteColumn(saved.deals,'f_follow');
  assert(!deleted.tableSchema.kpis.some(k=>k.id===percentage.id));
  saved=await write(deleted.records,deleted.tableSchema,saved.updatedAt);
  assert.deepEqual((await read()).tableSchema,deleted.tableSchema);
  assert.equal(calculate(X.kpis(saved.tableSchema).find(k=>k.id===average.id),saved.deals,saved.tableSchema).value,8500);
  await assert.rejects(()=>rpc("select pipechat.validate_kpis('[]'::jsonb) result"),e=>e.code==='42501');
  assert.equal((await db.query('select used from pipechat.usage_counters where user_id=$1',[user.id])).rows[0].used,0);
});
