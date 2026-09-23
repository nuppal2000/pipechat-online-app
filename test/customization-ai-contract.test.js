const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const pipelineCore=require('../public/pipeline-core.js'),tableSchemaCore=require('../public/table-schema.js'),customization=require('../public/workspace-customization.js');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const context={pipelineCore,tableSchemaCore,customization,structuredClone,todoCore:require('../public/todo-core.js'),reportEngine:require('../public/report-engine.js')};
vm.runInNewContext(source.slice(source.indexOf('const actionSchema ='),source.indexOf('function sendJson('))+'\nthis.getSchema=responseSchema;',context);
test('new AI actions retain strict schema and per-request KPI/field IDs without cross-user mutation',()=>{
  const schema=tableSchemaCore.legacySchema(),request=context.getSchema([],schema),action=request.properties.crmAction.anyOf[1];
  for(const name of ['rename_field','convert_field','configure_kpi','add_kpi','delete_kpi'])assert(action.properties.action.enum.includes(name));
  assert(action.properties.kpiId.enum.includes('kpi_value'));assert(action.required.includes('dropdownOptions'));assert(action.required.includes('kpi'));
  const visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());}for(const value of Object.values(node))if(value&&typeof value==='object')visit(value);};visit(request);
  const other={...schema,fields:schema.fields.map(f=>f.id==='value'?{...f,id:'f_score',name:'Score',type:'number'}:f)};
  const second=context.getSchema([],other).properties.crmAction.anyOf[1];assert(second.properties.kpiId.enum.includes('kpi_f_score'));assert(!second.properties.kpiId.enum.includes('kpi_value'));assert(action.properties.kpiId.enum.includes('kpi_value'));
});
test('model guidance distinguishes KPI changes from charts and requires dropdown/stale clarifications',()=>{
  assert.match(source,/What options would you like the dropdown menu to have\?/);assert.match(source,/Stale is ambiguous/);assert.match(source,/dashboardKpis:customization.kpis/);
  assert.match(source,/persistent top dashboard card, not show_report/);assert.match(source,/KPI changes must never alter row data/);
  assert.match(source,/Never use configure_kpi for an add request/);assert.match(source,/delete only that card, never a table field or records/);
});
test('deleted KPI IDs disappear and added IDs are available only in their owning request schema',()=>{
  const changed=customization.addKpi(tableSchemaCore.legacySchema(),[],'kpi_user_custom',{title:'Custom count',metric:'count',field:null,conditions:[]}).tableSchema;
  const removed=customization.deleteKpi(changed,[],'kpi_records').tableSchema;
  const ids=context.getSchema([],removed).properties.crmAction.anyOf[1].properties.kpiId.enum;
  assert(ids.includes('kpi_user_custom'));assert(!ids.includes('kpi_records'));assert(!context.getSchema([],tableSchemaCore.legacySchema()).properties.crmAction.anyOf[1].properties.kpiId.enum.includes('kpi_user_custom'));
});
