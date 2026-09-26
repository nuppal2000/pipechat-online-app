const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const pipelineCore=require('../public/pipeline-core.js'),tableSchemaCore=require('../public/table-schema.js'),customization=require('../public/workspace-customization.js');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const context={pipelineCore,tableSchemaCore,customization,structuredClone,todoCore:require('../public/todo-core.js'),reportEngine:require('../public/report-engine.js')};
vm.runInNewContext(source.slice(source.indexOf('const actionSchema ='),source.indexOf('function sendJson('))+'\nthis.getSchema=responseSchema;',context);
test('new AI actions retain strict schema and per-request KPI/field IDs without cross-user mutation',()=>{
  const schema=tableSchemaCore.legacySchema(),request=context.getSchema([],schema),action=request.properties.crmAction.anyOf[1];
  for(const name of ['rename_field','convert_field','configure_kpi','add_kpi','delete_kpi','move_record','move_field','sort_table','delete_records','propose_field','add_records','add_todos'])assert(action.properties.action.enum.includes(name));
  for(const name of ['fromPosition','toPosition','orderScope','sortDirection'])assert(action.required.includes(name));
  assert.deepEqual([...action.properties.orderScope.enum],['visible','all',null]);
  assert(action.properties.kpiId.enum.includes('kpi_value'));assert(action.required.includes('dropdownOptions'));assert(action.required.includes('kpi'));
  assert.deepEqual([...action.properties.targetType.enum],['choice','date','text',null]);assert(action.required.includes('targetType'));
  const visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());}for(const value of Object.values(node))if(value&&typeof value==='object')visit(value);};visit(request);
  const other={...schema,fields:schema.fields.map(f=>f.id==='value'?{...f,id:'f_score',name:'Score',type:'number'}:f)};
  const second=context.getSchema([],other).properties.crmAction.anyOf[1];assert(second.properties.kpiId.enum.includes('kpi_f_score'));assert(!second.properties.kpiId.enum.includes('kpi_value'));assert(action.properties.kpiId.enum.includes('kpi_value'));
});

test('AI guidance creates typed fields, complete task batches and CRM previews independent of current view',()=>{
  const action=context.getSchema([],null).properties.crmAction.anyOf[1];assert(action.required.includes('todos'));
  assert(action.properties.action.enum.includes('move_todos'));assert(action.required.includes('todoMoves'));assert.equal(action.properties.todoMoves.anyOf[1].maxItems,2000);assert(action.required.includes('clarificationOptions'));assert(action.required.includes('todoSelection'));assert.equal(action.properties.todoSelection.anyOf[1].properties.conditions.maxItems,12);
  assert.match(source,/clarificationAnswer:clarificationContext.resolve\(pendingClarification,userCommand\)/);assert.match(source,/MULTIPLE existing cards use move_todos/);
  const todos=action.properties.todos.anyOf[1];assert.equal(todos.maxItems,200);assert.equal(todos.items.additionalProperties,false);assert(todos.items.required.includes('recordMatch'));assert(todos.items.required.includes('todoDueDate'));
  assert.match(source,/targetType choice, dropdownOptions \[hot, medium, cold\]/);assert.match(source,/Never downgrade an explicitly requested dropdown/);
  assert.match(source,/TWO OR MORE cards use add_todos/);assert.match(source,/containing EVERY requested task/);assert.match(source,/current local date/);
  assert.match(source,/currentView is navigation context, NOT a restriction/);assert.match(source,/automatically opens Pipeline/);assert(!source.includes('While currentView is todo, only propose card changes'));
});

test('creation contract describes real field labels/types and includes custom fields in single and batch records',()=>{
  const {schema}=require('./fixtures/record-additions.cjs'),custom=[{id:'cf_email',name:'Email',type:'text'}];
  for(const table of [schema,null]){
    const action=context.getSchema(custom,table).properties.crmAction.anyOf[1];
    assert.equal(action.properties.records.anyOf[1].maxItems,2000);
    for(const record of [action.properties.record.anyOf[1],action.properties.records.anyOf[1].items]){
      assert(record.required.includes('cf_email'));assert.equal(record.additionalProperties,false);
      if(table){assert.match(record.properties.f_deal.description,/Deal \/ Account Name.*primary/);assert(!record.required.includes('account'));assert.deepEqual([...record.properties.f_value.type],['number','null']);}
    }
  }
  assert.match(source,/add_records with records for TWO OR MORE/);assert.match(source,/user never needs the hidden key/);assert.match(source,/complete corrected add_records action/);
});
test('model guidance distinguishes KPI changes from charts and requires dropdown/stale clarifications',()=>{
  assert.match(source,/What options would you like the dropdown menu to have\?/);assert.match(source,/Stale is ambiguous/);assert.match(source,/dashboardKpis:customization.kpis/);
  assert.match(source,/persistent top dashboard card, not show_report/);assert.match(source,/KPI changes must never alter row data/);
  assert.match(source,/Never use configure_kpi for an add request/);assert.match(source,/delete only that card, never a table field or records/);
  assert.match(source,/supportedActions: actionSchema.properties.action.enum/);assert.match(source,/Positions are one-based/);assert.match(source,/never edit primary names to simulate movement/);assert.match(source,/Database flexibility does not grant arbitrary SQL/);assert.match(source,/one confirmed step at a time/);
});

test('customized CRM field enums never replace independent card condition fields',()=>{
  const {schema}=require('./fixtures/record-additions.cjs');
  for(const table of [null,tableSchemaCore.legacySchema(),schema]){
    const action=context.getSchema([{id:'cf_email',name:'Email',type:'text'}],table).properties.crmAction.anyOf[1];
    const condition=action.properties.todoSelection.anyOf[1].properties.conditions.items;
    assert.deepEqual([...condition.properties.field.enum],['title','status','nextAction','notes','dueDate']);
    const selection={scope:'matching',destination:'Done',conditions:[{field:condition.properties.field.enum[2],operator:'starts_with',value:'Review'}]};
    const core=pipelineCore.create(table),records=[{id:1,[core.role('primary')]:'Alpha'}],T=context.todoCore;
    const result=T.plan([{...T.create('todo_alpha',1),nextAction:'Review documents'}],records,table,[],{action:'move_todos',todoSelection:selection});
    assert.equal(result.count,1);assert.equal(result.cards[0].status,'Done');
  }
});
test('deleted KPI IDs disappear and added IDs are available only in their owning request schema',()=>{
  const changed=customization.addKpi(tableSchemaCore.legacySchema(),[],'kpi_user_custom',{title:'Custom count',metric:'count',field:null,conditions:[]}).tableSchema;
  const removed=customization.deleteKpi(changed,[],'kpi_records').tableSchema;
  const ids=context.getSchema([],removed).properties.crmAction.anyOf[1].properties.kpiId.enum;
  assert(ids.includes('kpi_user_custom'));assert(!ids.includes('kpi_records'));assert(!context.getSchema([],tableSchemaCore.legacySchema()).properties.crmAction.anyOf[1].properties.kpiId.enum.includes('kpi_user_custom'));
});
test('AI contract explicitly requests predicate-wide deletion and relevant recurring-concept proposals without writes',()=>{
  assert.match(source,/without a client name means is_blank/);assert.match(source,/never only the first match/);assert.match(source,/For an explicit list use ALL matching exact IDs/);
  assert.match(source,/pipeline.primaryField/);assert.match(source,/tableSchema.columnOrder is set, its FIRST field/);
  assert.match(source,/return propose_field/);assert.match(source,/no existing field represents it/);assert.match(source,/Do not interrupt an active clarification/);assert.match(source,/never infer or populate values/);
});

test('bulk table edits use complete predicates for dropdowns, text and dates',()=>{
  const action=context.getSchema([],require('./fixtures/record-additions.cjs').schema).properties.crmAction.anyOf[1];
  assert.match(action.properties.value.description,/separate compact update_records/);assert.match(action.properties.changes.anyOf[1].items.properties.value.description,/Replacement for THIS field edit/);
  assert.match(source,/compact update_records action for EVERY/);assert.match(source,/filter.value is only the selection threshold/);
  assert.match(source,/EVERY change must carry the complete filter/);
  assert.match(source,/Dropdown, text and date fields have the same targeting rules/);
  assert.match(source,/Do not enumerate a sample of matching records/);
  assert.match(source,/genuinely ambiguous singular name still requires clarification/);
});

test('strict model edits require a complete selector and replacement in one compact action',()=>{
  for(const table of [null,tableSchemaCore.legacySchema(),require('./fixtures/record-additions.cjs').schema]){
    const request=context.getSchema([{id:'cf_test',name:'Test',type:'text'}],table),legacy=request.properties.crmAction.anyOf[1],edit=request.properties.crmAction.anyOf[2];
    assert(!legacy.properties.action.enum.some(name=>['update_record','bulk_update','update_records'].includes(name)));assert.deepEqual([...edit.properties.action.enum],['update_records']);assert.deepEqual([...edit.required],['action','changes']);
    const variants=edit.properties.changes.items.anyOf;assert.equal(variants.length,3);
    for(const item of variants){assert(item.required.includes('value'));assert.deepEqual([...item.properties.value.type],['string','number']);assert.equal(['filter','ids','recordMatch'].filter(key=>item.properties[key].type!=='null').length,1);assert.equal(item.additionalProperties,false);}
    const filter=variants[0].properties.filter;assert(filter.properties.field.enum.includes('cf_test'));if(table&&!table.legacy)assert(filter.properties.field.enum.includes('f_value'));assert.equal(variants[1].properties.ids.minItems,1);assert.equal(variants[2].properties.recordMatch.minLength,1);
  }
});
