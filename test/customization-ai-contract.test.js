const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const pipelineCore=require('../public/pipeline-core.js'),tableSchemaCore=require('../public/table-schema.js'),customization=require('../public/workspace-customization.js');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const context={pipelineCore,tableSchemaCore,customization,structuredClone,todoCore:require('../public/todo-core.js'),todoActions:require('../public/todo-actions.js'),reportEngine:require('../public/report-engine.js'),dashboardBoard:require('../public/dashboard-board.js'),workspacePlan:require('../public/workspace-plan.js'),businessActions:require('../public/business-actions.js'),businessCompiler:require('../lib/business-compiler.js')};
context.viewActions=require('../public/view-actions.js');
vm.runInNewContext(source.slice(source.indexOf('const actionSchema ='),source.indexOf('function sendJson('))+'\nthis.getSchema=responseSchema;',context);

function assertStrictSchema(node){
  if(!node||typeof node!=='object')return;
  if(node.type==='object'||Array.isArray(node.type)&&node.type.includes('object')){
    assert.equal(node.additionalProperties,false);
    assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());
  }
  if(node.anyOf)assert(Array.isArray(node.anyOf)&&node.anyOf.length>0);
  for(const value of Object.values(node))if(value&&typeof value==='object')assertStrictSchema(value);
}
test('new AI actions retain strict schema and per-request KPI/field IDs without cross-user mutation',()=>{
  const schema=tableSchemaCore.legacySchema(),request=context.getSchema([],schema),action=request.properties.crmAction.anyOf[1];
  for(const name of ['rename_field','convert_field','configure_kpi','add_kpi','delete_kpi','move_record','move_field','sort_table','delete_records','propose_field','add_records','add_todos'])assert(action.properties.action.enum.includes(name));
  for(const name of ['fromPosition','toPosition','orderScope','sortDirection'])assert(action.required.includes(name));
  assert.deepEqual([...action.properties.orderScope.enum],['visible','all',null]);
  assert(action.properties.kpiId.enum.includes('kpi_value'));assert(action.required.includes('dropdownOptions'));assert(action.required.includes('kpi'));
  assert.deepEqual([...action.properties.targetType.enum],['choice','date','text',null]);assert(action.required.includes('targetType'));
  assertStrictSchema(request);
  const other={...schema,fields:schema.fields.map(f=>f.id==='value'?{...f,id:'f_score',name:'Score',type:'number'}:f)};
  const second=context.getSchema([],other).properties.crmAction.anyOf[1];assert(second.properties.kpiId.enum.includes('kpi_f_score'));assert(!second.properties.kpiId.enum.includes('kpi_value'));assert(action.properties.kpiId.enum.includes('kpi_value'));
});

test('AI guidance creates typed fields, complete task batches and CRM previews independent of current view',()=>{
  const action=context.getSchema([],null).properties.crmAction.anyOf[1];assert(action.required.includes('todos'));
  assert(!action.properties.action.enum.includes('move_todos'));assert(!action.properties.action.enum.includes('update_todo'));assert(action.required.includes('todoMoves'));assert.equal(action.properties.todoMoves.anyOf[1].maxItems,2000);assert(action.required.includes('clarificationOptions'));assert(action.required.includes('todoSelection'));assert.equal(action.properties.todoSelection.anyOf[1].properties.conditions.maxItems,12);
  assert.match(source,/clarificationAnswer:clarificationContext.resolve\(pendingClarification,userCommand\)/);assert.match(source,/moving multiple cards use update_todos/);
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
  assert.match(source,/supportedActions:modelResponseSchema/);assert.match(source,/Positions are one-based/);assert.match(source,/never edit primary names to simulate movement/);assert.match(source,/Database flexibility does not grant arbitrary SQL/);assert.match(source,/save atomically with one Undo/);
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
  assert.match(source,/compact update_records action for standalone/);assert.match(source,/filter.value is only the selection threshold/);
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

test('card edits, saved focus and chart refinements have compact typed contracts rather than legacy lossy actions',()=>{
  for(const table of [null,require('./fixtures/record-additions.cjs').schema]){
    const branches=context.getSchema([],table).properties.crmAction.anyOf;
    const find=name=>branches.find(b=>b.properties?.action.enum.includes(name));
    const query=find('query_todos'),edit=find('update_todos'),report=find('show_report'),refine=find('refine_report');
    assert(query&&edit&&report&&refine);assert.deepEqual([...query.required],['action','selection']);assert.deepEqual([...edit.required],['action','updates']);
    assert.deepEqual([...report.required],['action','smartReport']);assert.equal(find('update_todo'),undefined);assert.equal(find('move_todos'),undefined);
    assert.deepEqual([...edit.properties.updates.items.properties.changes.items.properties.field.enum],['status','nextAction','notes','dueDate']);
    assert.deepEqual([...query.properties.selection.anyOf].map(s=>s.properties.source.enum[0]),['all','ids','references']);
    const references=query.properties.selection.anyOf.find(s=>s.properties.source.enum[0]==='references');
    assert.deepEqual([...references.required],['source','references','conditions']);assert.equal(references.properties.references.minItems,1);assert.equal(references.properties.references.maxItems,200);
    assert.deepEqual([...references.properties.references.items.required],['taskName','recordName']);
    for(const field of ['taskName','recordName'])assert.deepEqual([...references.properties.references.items.properties[field].type],['string','null']);
    const focused=context.getSchema([],table,{kind:'todos',id:'current-selection',ids:['todo_1','todo_2']}).properties.crmAction.anyOf.find(b=>b.properties?.action.enum.includes('update_todos')).properties.updates.items.properties.selection.anyOf;
    assert.deepEqual([...focused.find(s=>s.properties.source.enum[0]==='focus').properties.focusId.enum],['current-selection']);
    const filtering=find('filter_records');assert(filtering);assert.deepEqual([...filtering.properties.target.enum],['context','report','pipeline_table']);assert(filtering.required.includes('removeFields'));assert(!filtering.properties.replaceFields);assert.equal(refine.properties.changes.minItems,1);
    assert.equal(find('filter_view'),undefined);assert.equal(find('clear_view'),undefined);assert(find('clear_table_view'));
  }
  assert.match(source,/ENTIRE saved card set/);assert.match(source,/NOT an instruction to set or move status/);assert.match(source,/refine_report action, not a rebuilt show_report/);
});

test('read intent distinguishes fresh lists, refinements, temporary KPIs, persistent cards and audits',()=>{
 const branches=context.getSchema([],require('./fixtures/record-additions.cjs').schema).properties.crmAction.anyOf;
 for(const name of ['query_records','show_kpi','audit_records'])assert(branches.some(b=>b.properties?.action.enum.includes(name)));
 assert.match(source,/fresh request to find\/show\/list individual records/);assert.match(source,/short refinement of the active chart stays on Dashboard/);
 assert.match(source,/word KPI alone does not authorize/);assert.match(source,/Use add_kpi ONLY for an explicit request/);assert.match(source,/Each|EVERY requested field\/cohort/);
 assert(!source.includes('Never infer a switch to Pipeline from words'));
 assert.match(source,/never.*count samples/i);assert.match(source,/not a filter or assumed answer/);
 const ui=fs.readFileSync(path.join(__dirname,'../public/todo-ui.js'),'utf8');assert.match(ui,/<label>Task<input name="nextAction"/);assert(!ui.includes('<label>To Do<input name="nextAction"'));assert.match(ui,/<span>Task<\/span>/);
});

test('live model contract uses one plan path while legacy actions remain interpretable',()=>{
  const Review=require('../lib/action-review'),legacy=context.getSchema([],require('./fixtures/record-additions.cjs').schema),before=JSON.stringify(legacy),compiled=Review.modelSchema(legacy);
  const names=compiled.properties.crmAction.anyOf.flatMap(b=>b.properties?.action?.enum||[]);
  for(const name of ['update_records','add_todo','add_todos','update_todos','query_records','filter_records','show_kpi','show_report','refine_report'])assert(!names.includes(name),name);
  for(const name of ['workspace_plan','query_todos','audit_records','dashboard_plan','analyze_dashboard','add_records','delete_records','rename_field','clear_table_view'])assert(names.includes(name),name);
  assert.equal(JSON.stringify(legacy),before);
  assert.match(source,/schema:modelResponseSchema/);assert.match(source,/supportedActions:modelResponseSchema/);
});

test('model action union stays strict and within supported actions including business operations',()=>{
  const Review=require('../lib/action-review.js'),Business=require('../public/business-workspace.js');
  const blocked=new Set(['update_records','add_todo','add_todos','update_todos','query_records','filter_records','show_kpi','show_report','refine_report']);
  const businessNames=['create_document','create_workflow','set_workflow_activation','workflow_history','business_plan','query_business'];
  for(const table of [null,tableSchemaCore.legacySchema(),require('./fixtures/record-additions.cjs').schema]){
    const legacy=context.getSchema([{id:'cf_contract',name:'Contract',type:'text'}],table),before=JSON.stringify(legacy),model=Review.modelSchema(legacy);
    assertStrictSchema(model);
    const branches=model.properties.crmAction.anyOf,names=branches.flatMap(branch=>branch.properties?.action?.enum||[]);
    const supported=legacy.properties.crmAction.anyOf.flatMap(branch=>branch.properties?.action?.enum||[]);
    assert.equal(branches.filter(branch=>branch.type==='null').length,1);
    for(const branch of branches.filter(branch=>branch.type!=='null')){
      assert.equal(branch.type,'object');assert.equal(branch.properties.action.type,'string');
      assert(branch.required.includes('action'));assert(branch.properties.action.enum.length>0);
    }
    assert.equal(new Set(names).size,names.length,'Action discriminators must not overlap');
    assert.deepEqual([...names].sort(),supported.filter(name=>!blocked.has(name)).sort());
    for(const name of [...businessNames,'undo_action'])assert(names.includes(name),name);
    for(const expected of [...context.businessActions.actionSchemas(),...context.businessCompiler.schemas()]){
      assert.deepEqual(branches.find(branch=>branch.properties?.action.enum[0]===expected.properties.action.enum[0]),expected);
    }
    const operations=branches.find(branch=>branch.properties?.action.enum[0]==='business_plan').properties.operations;
    assert.equal(operations.maxItems,200);
    assert.deepEqual(operations.items.anyOf.map(branch=>branch.properties.op.enum[0]),['put_type','put_relationship_type','upsert_entity','update_entity','delete_entity','remove_field','merge_entities','link','unlink']);
    assert.deepEqual(operations.items.anyOf.find(branch=>branch.properties.op.enum[0]==='remove_field'),{
      type:'object',additionalProperties:false,
      properties:{op:{type:'string',enum:['remove_field']},typeId:{type:'string'},fieldId:{type:'string'}},
      required:['op','typeId','fieldId']
    });
    assert.deepEqual(operations.items.anyOf[0].properties.type.properties.fields.items.properties.type.enum,Business.fieldTypes);
    assert.deepEqual(operations.items.anyOf[1].properties.type.properties.cardinality.enum,Business.cardinalities);
    assert.equal(JSON.stringify(legacy),before,'Compiling model actions must not mutate the request schema');
  }
});

function modelAction(name,table,custom=[]){
  const request=context.getSchema(custom,table),before=JSON.stringify(request);
  const model=require('../lib/action-review').modelSchema(request);
  assert.equal(JSON.stringify(request),before);
  const matches=model.properties.crmAction.anyOf.filter(branch=>branch.properties?.action.enum.includes(name));
  assert.equal(matches.length,1,name+' must have one live model discriminator');
  return matches[0];
}
const contractTables=[null,tableSchemaCore.legacySchema(),require('./fixtures/record-additions.cjs').schema];

for(const name of ['save_view','open_view','export_records'])test(name+' retains the strict app-owned selection contract in the live model schema',()=>{
  for(const table of contractTables){
    const action=modelAction(name,table,[{id:'cf_contract',name:'Contract',type:'text'}]);
    const expected=context.viewActions.actionSchemas().find(branch=>branch.properties.action.enum[0]===name);
    assert.deepEqual(action,expected);assertStrictSchema(action);
    const selections=action.properties.selection.anyOf;
    assert.deepEqual(selections.map(branch=>branch.properties.source.enum[0]),name==='open_view'?['saved_view','saved_view']:['visible','all','saved_view','saved_view']);
    for(const selection of selections){
      assert(!selection.properties.recordIds);assert(!selection.properties.where);assert(!selection.properties.count);
      if(selection.properties.source.enum[0]==='saved_view')assert.equal(['viewId','viewName'].filter(key=>selection.properties[key]).length,1);
    }
    if(name==='save_view'){assert.equal(action.properties.name.minLength,1);assert.equal(action.properties.name.maxLength,120);}
    if(name==='export_records'){
      assert.deepEqual(action.properties.format.enum,['csv']);
      const columns=action.properties.columns.anyOf;
      assert.deepEqual(columns.map(branch=>branch.properties.source.enum[0]),['all','selected']);
      assert.equal(columns[1].properties.columnIds.minItems,1);assert.equal(columns[1].properties.columnIds.maxItems,200);
    }
    for(const key of ['csv','body','records','values','workspaceId','newViewId','status','receipt'])assert(!action.properties[key],key+' must not be model-supplied');
  }
});

test('live workspace plans bind saved-cell transforms to distinct bounded operand and field types',()=>{
  const custom=[{id:'cf_saved_date',name:'Saved date',type:'date'}];
  for(const table of contractTables){
    const plan=modelAction('workspace_plan',table,custom);
    const edit=plan.properties.steps.items.anyOf.find(step=>step.properties.op.enum[0]==='update_records');
    const assignments=edit.properties.assignments,branches=assignments.items.anyOf;
    assert.equal(assignments.minItems,1);assert.equal(assignments.maxItems,40);assertStrictSchema(assignments);
    assert.deepEqual(branches.map(branch=>branch.properties.operation.enum),[['set','append'],['adjust_percent'],['shift_date']]);
    const percent=branches[1],shift=branches[2],definitions=pipelineCore.create(table).definitions(custom);
    assert.deepEqual(percent.properties.field.enum,definitions.filter(field=>['number','currency'].includes(field.type)).map(field=>field.id));
    assert.deepEqual(shift.properties.field.anyOf.filter(branch=>branch.enum).flatMap(branch=>branch.enum),definitions.filter(field=>field.type==='date').map(field=>field.id));
    assert(shift.properties.field.anyOf.some(branch=>branch.pattern==='^@[a-z][a-z0-9_]{0,39}$'));
    assert.deepEqual(percent.properties.value.required,['percent','blankPolicy']);
    assert.deepEqual(percent.properties.value.properties.percent,{type:'number',minimum:-10000,maximum:10000});
    assert.deepEqual(shift.properties.value.required,['dateMode','offset','blankPolicy']);
    assert.deepEqual(shift.properties.value.properties.offset,{type:'integer',minimum:-366,maximum:366});
    assert.deepEqual(shift.properties.value.properties.dateMode.enum,['calendar_days','business_days']);
    for(const branch of [percent,shift]){
      assert.equal(branch.properties.value.additionalProperties,false);
      assert.deepEqual(branch.properties.value.properties.blankPolicy.enum,['error','skip']);
      assert.match(branch.properties.value.properties.blankPolicy.description,/explicitly asks to skip/);
      for(const key of ['formula','base','baseDate','replacement','result','date'])assert(!branch.properties.value.properties[key]);
    }
    const absolute=branches[0].properties.value.anyOf;
    assert.deepEqual(absolute[0].type,['string','number']);
    assert.deepEqual(absolute[1].properties.dateMode.enum,['literal','calendar_days','business_days']);
    assert.match(assignments.items.description,/original saved value/);assert.match(assignments.items.description,/not today/);
  }
});

test('transform field restrictions stay request-local and never expose numeric operations without numeric columns',()=>{
  const original=require('./fixtures/record-additions.cjs').schema;
  const table={...original,fields:original.fields.filter(field=>!['number','currency'].includes(field.type))};
  const variants=value=>modelAction('workspace_plan',value).properties.steps.items.anyOf.find(step=>step.properties.op.enum[0]==='update_records').properties.assignments.items.anyOf;
  assert.deepEqual(variants(table).map(branch=>branch.properties.operation.enum),[['set','append'],['shift_date']]);
  assert(variants(original).some(branch=>branch.properties.operation.enum.includes('adjust_percent')));
  assert(!variants(null).flatMap(branch=>branch.properties.field.enum||[]).includes('f_value'));
});

test('both model passes receive relative-versus-absolute and original-snapshot transform instructions',()=>{
  const Review=require('../lib/action-review');
  assert(source.split(/\r?\n/).some(line=>/body\.instructions\s*\+=/.test(line)&&line.includes('actionReview.compilerInstructions')));
  assert.match(source,/instructions:actionReview\.instructions/);
  for(const instructions of [Review.compilerInstructions,Review.instructions]){
    assert(instructions.includes(Review.transformInstructions));
    assert.match(instructions,/Never replace a requested saved-cell transform with set/);
    assert.match(instructions,/original authorized snapshot/);
    assert.match(instructions,/Reject\/repair that mismatch even if the resulting constants look correct/);
    assert.match(instructions,/skip is allowed only when the user explicitly asks/);
  }
});

test('live KPI schemas preserve legacy conditions and explicit twelve-group numerator and denominator scopes',()=>{
  for(const table of contractTables){
    const action=modelAction('add_kpi',table),variants=action.properties.kpi.anyOf;
    for(const name of ['add_kpi','configure_kpi','delete_kpi'])assert(action.properties.action.enum.includes(name));
    assert.equal(variants.length,4);assert.equal(variants[0].type,'null');assertStrictSchema(action.properties.kpi);
    const [legacy,scoped,percentage]=variants.slice(1);
    assert.deepEqual([...legacy.required],['title','metric','field','conditions']);
    assert.deepEqual([...legacy.properties.metric.enum],['count','sum','average']);
    assert.equal(legacy.properties.conditions.maxItems,10);
    assert(!legacy.properties.where);assert(!legacy.properties.denominatorWhere);
    assert.deepEqual([...scoped.properties.metric.enum],['count','sum','average']);
    assert(!scoped.properties.denominatorWhere);
    assert.deepEqual([...percentage.properties.metric.enum],['percentage']);assert.equal(percentage.properties.field.type,'null');
    assert(percentage.required.includes('where'));assert(percentage.required.includes('denominatorWhere'));
    for(const branch of [scoped,percentage]){
      assert.equal(branch.properties.title.maxLength,120);
      assert.equal(branch.properties.conditions.maxItems,0);assert(branch.required.includes('where'));
      for(const key of ['where',...(branch===percentage?['denominatorWhere']:[])]){
        const where=branch.properties[key];assert.equal(where.type,'array');assert.equal(where.maxItems,12);assert.equal(where.minItems??0,0);
        assert.equal(where.items.type,'array');assert.equal(where.items.minItems,1);assert.equal(where.items.maxItems,20);
        const condition=where.items.items;
        assert.deepEqual([...condition.required],['field','operator','value']);assert.equal(condition.additionalProperties,false);
        assert.deepEqual([...condition.properties.operator.enum],tableSchemaCore.kpiOperators);
        assert(condition.properties.operator.enum.includes('starts_with'));
        assert.equal(condition.properties.field.maxLength,65);
        assert.deepEqual(JSON.parse(JSON.stringify(condition.properties.value.anyOf)),[{type:'null'},{type:'string',maxLength:12000},{type:'number',minimum:-1e12,maximum:1e12}]);
      }
      for(const key of ['value','numericCount','numeratorCount','denominatorCount','formula','records'])assert(!branch.properties[key]);
    }
  }
});

test('KPI compiler accepts schema-sized twelve-group unions and rejects thirteen groups or malformed scope branches atomically',()=>{
  const schema=require('./fixtures/record-additions.cjs').schema;
  const condition={field:'f_deal',operator:'equals',value:'North'};
  const groups=Array.from({length:12},()=>[{...condition}]);
  const input={title:'Contract population',metric:'percentage',field:null,conditions:[],where:groups,denominatorWhere:groups};
  const before=structuredClone({schema,input});
  const change=customization.addKpi(schema,[],'kpi_user_contract',input);
  assert.equal(change.after.where.length,12);assert.equal(change.after.denominatorWhere.length,12);
  const all=customization.addKpi(schema,[],'kpi_user_all',{...input,where:[],denominatorWhere:[]});
  assert.deepEqual(all.after.where,[]);assert.deepEqual(all.after.denominatorWhere,[]);
  for(const key of ['where','denominatorWhere']){
    for(const invalid of [[...groups,[condition]],[[]],[Array.from({length:21},()=>condition)],[[{...condition,formula:'x'}]]]){
      assert.throws(()=>customization.addKpi(schema,[],'kpi_user_bad',{...input,[key]:invalid}));
    }
  }
  assert.throws(()=>customization.addKpi(schema,[],'kpi_user_bad',{...input,conditions:[condition]}));
  assert.throws(()=>customization.addKpi(schema,[],'kpi_user_bad',{...input,metric:'count'}));
  assert.deepEqual({schema,input},before);
});
