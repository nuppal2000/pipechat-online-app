const test=require('node:test'),assert=require('node:assert/strict');
const X=require('../public/workspace-customization.js'),Core=require('../public/pipeline-core.js'),Schema=require('../public/table-schema.js');
const schema=Schema.legacySchema(),spec={title:'Total number of follow-ups',metric:'count',field:null,conditions:[{field:'follow',operator:'is_not_blank',value:null}]};
test('added KPIs append to defaults and edited cards; deletion survives reload and allows an empty dashboard',()=>{
  const configured=X.configure(schema,[],'kpi_value',{title:'Average value',metric:'average',field:'value',conditions:[]}).tableSchema;
  const before=X.kpis(configured),added=X.addKpi(configured,[],'kpi_user_one',spec);
  assert.deepEqual(X.kpis(added.tableSchema).slice(0,-1),before);assert.equal(X.kpis(added.tableSchema).at(-1).id,'kpi_user_one');
  assert.equal(X.calculate(added.after,[{follow:'Today'},{follow:''},{follow:'Tomorrow'},{follow:'  '}],added.tableSchema).value,2);
  let next=X.deleteKpi(added.tableSchema,[],'kpi_value').tableSchema;
  assert(!X.kpis(Schema.validate(next)).some(k=>k.id==='kpi_value'));assert.deepEqual(next.hiddenKpis,['kpi_value']);
  next=X.deleteKpi(next,[],'kpi_user_one').tableSchema;assert.equal(next.kpis.length,0);assert.deepEqual(next.hiddenKpis,['kpi_value']);
  for(const card of X.kpis(next))next=X.deleteKpi(next,[],card.id).tableSchema;
  assert.deepEqual(X.kpis(Schema.validate(next)),[]);assert.throws(()=>X.configure(next,[],'kpi_records',spec));
  assert.equal(X.kpis(X.addKpi(next,[],'kpi_user_again',spec).tableSchema).length,1);
});
test('KPI additions reject duplicate titles, invalid references, collisions and malformed deletion metadata',()=>{
  assert.throws(()=>X.addKpi(schema,[],'kpi_records',spec));
  assert.throws(()=>X.addKpi(schema,[],'kpi_user_a',{...spec,title:'Open deals'}));
  assert.throws(()=>X.addKpi(schema,[],'kpi_user_a',{...spec,conditions:[{field:'missing',operator:'is_not_blank',value:null}]}));
  for(const hiddenKpis of [null,{},['kpi_records','kpi_records'],[null],['not_an_id'],Array(121).fill('kpi_records')])assert.throws(()=>Schema.validate({...schema,hiddenKpis}));
  const added=X.addKpi(schema,[],'kpi_user_a',spec).tableSchema;assert.throws(()=>X.addKpi(added,[],'kpi_user_a',{...spec,title:'Other'}));
});
function sorter(options){return Core.create({...schema,fields:schema.fields.map(f=>f.id==='stage'?{...f,name:'Follow ups',options}:f)});}
test('timing dropdowns sort chronologically in both directions, with stable ties and blanks last',()=>{
  const core=sorter(['Next month','Tomorrow','Today','Next week','Not scheduled']);
  const rows=['Next month','Tomorrow','Today','Next week','','Today','Not scheduled'].map((stage,i)=>({id:i+1,stage}));
  const today=new Date(2026,8,23);
  assert.deepEqual(core.sortRecords(rows,{field:'stage',direction:'asc'},[],today).map(r=>r.id),[3,6,2,4,1,5,7]);
  assert.deepEqual(core.sortRecords(rows,{field:'stage',direction:'desc'},[],today).map(r=>r.id),[1,4,2,3,6,5,7]);
  assert.equal(rows[0].stage,'Next month');
});
test('date dropdowns and relative intervals use dates; ordinary or mixed dropdowns retain alphabetical sorting',()=>{
  const today=new Date(2026,8,30),core=sorter(['Next week','Next month','Today','2026-10-03','In 2 days']);
  const rows=core.stages.map((stage,i)=>({id:i,stage}));
  assert.deepEqual(core.sortRecords(rows,{field:'stage',direction:'asc'},[],today).map(r=>r.stage),['Today','Next month','In 2 days','2026-10-03','Next week']);
  const mixed=sorter(['Tomorrow','Won','Today']);assert.deepEqual(mixed.sortRecords([{stage:'Won'},{stage:'Tomorrow'},{stage:'Today'}],{field:'stage',direction:'asc'}).map(r=>r.stage),['Today','Tomorrow','Won']);
  const cf=[{id:'cf_time',name:'When',type:'choice',options:['Next month','Today','Tomorrow']}];
  assert.deepEqual(Core.sortRecords([{cf_time:'Next month'},{cf_time:'Today'}],{field:'cf_time',direction:'asc'},cf,today).map(r=>r.cf_time),['Today','Next month']);
});
