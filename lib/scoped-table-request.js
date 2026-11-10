'use strict';

// A compact model-facing syntax. The browser, reviewer and database receive only
// ordinary workspace plans, never a second implementation of CRM operations.
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const literal=value=>({type:'string',enum:[value]});
const inverse={lt:'gte',lte:'gt',gt:'lte',gte:'lt'};

function schema(plan){
  if(!plan.properties.steps?.items?.anyOf)return null;
  const steps=plan.properties.steps.items.anyOf.map(step=>step.properties);
  const find=name=>steps.find(step=>step.op.enum.includes(name));
  const select=find('select_records'),read=find('read_records'),update=find('update_records');
  const transform=update.assignments.items.anyOf.find(branch=>branch.properties.operation.enum.includes('shift_date'));
  const numeric=update.assignments.items.anyOf.find(branch=>branch.properties.operation.enum.includes('adjust_percent'));
  const op=(name,props)=>object({kind:literal(name),...props});
  const field=select.orderBy.anyOf.find(x=>x.enum?.length);
  if(!field)return null;
  return object({
    action:literal('scoped_table_request'),title:{type:'string'},
    source:{type:'string',enum:['all','visible','focus']},where:{...select.where,description:'OR of AND groups. Put a cohort prefix and the owner or stage restriction in the same group. Use in for several allowed values of one field.'},
    operation:{anyOf:[
      op('show_rows',{orderBy:select.orderBy,direction:select.direction,outputs:read.outputs}),
      ...(numeric?[op('classify_number',{numberField:numeric.properties.field,operator:{type:'string',enum:Object.keys(inverse)},threshold:{type:'number'},
        targetField:field,whenTrue:{type:['number','string']},otherwise:{type:['number','string']},whenBlank:literal('unchanged')})]:[]),
      ...(transform?[op('shift_saved_dates',{field:transform.properties.field,...transform.properties.value.properties})]:[])
    ]}
  });
}

function compile(request){
  if(request?.action!=='scoped_table_request')return request;
  const {operation:o,where,source,title}=request;
  if(!o||!Array.isArray(where)||!['all','visible','focus'].includes(source))throw new Error('Choose a record population and table operation.');
  const select=(id,label,source,where)=>({op:'select_records',id,label,source,where,orderBy:null,direction:'asc',limit:null,relatedTasks:'any'});
  const rows=select('population','Select matching records',source,where);
  const steps=[rows];
  const update=(id,label,selection,field,operation,value)=>({op:'update_records',id,label,selection,assignments:[{field,operation,value}]});
  if(o.kind==='show_rows'){
    rows.orderBy=o.orderBy;rows.direction=o.direction;
    if(!Array.isArray(o.outputs)||!o.outputs.length)throw new Error('Choose the outputs for the table selection.');
    const outputs=o.outputs.some(item=>item.kind==='names')?o.outputs:[{kind:'names',field:null},...o.outputs];
    steps.push({op:'read_records',id:'display',label:'Show the selected rows',selection:rows.id,showTable:true,outputs});
  }else if(o.kind==='classify_number'){
    if(!Object.hasOwn(inverse,o.operator)||!Number.isFinite(o.threshold)||o.whenBlank!=='unchanged')throw new Error('Choose a numeric comparison and missing-value policy.');
    for(const [id,operator,value] of [['match',o.operator,o.whenTrue],['otherwise',inverse[o.operator],o.otherwise]]){
      // Complementary numeric comparisons exclude null from BOTH branches; a
      // fallback over all remaining IDs would accidentally include unknowns.
      steps.push(select(id,'Select '+id+' branch',rows.id,[[{field:o.numberField,operator,value:o.threshold,values:[]}]]),
        update('apply_'+id,'Apply '+id+' branch',id,o.targetField,'set',value));
    }
  }else if(o.kind==='shift_saved_dates'){
    steps.push(update('reschedule','Shift each original saved date',rows.id,o.field,'shift_date',{dateMode:o.dateMode,offset:o.offset,blankPolicy:o.blankPolicy}));
  }else throw new Error('Unknown scoped table operation.');
  return {action:'workspace_plan',version:1,title,steps,unmappedFacts:[],goals:steps.filter(step=>step.op!=='select_records').map(step=>({description:step.label,stepIds:[step.id]}))};
}

const instructions='For a simple record list, numeric if/otherwise edit leaving unknowns alone, or relative change to saved dates, prefer scoped_table_request. It compiles into reviewed select/read/update steps. Interpret possessive owner wording as a condition on the actual owner field, not a primary record name. Combine the owner and any name/cohort predicate in one AND group; use in for alternatives on one field. An independent list starts at all, not the last visible cohort. show_rows opens the table and returns the same ordered names; request any additional calculations in outputs. classify_number compares the original numeric cells and skips unknowns in both branches. shift_saved_dates moves each original date, not today; a working/business day means Mon-Fri. For more complex requests keep using workspace_plan.';
module.exports={schema,compile,instructions};
