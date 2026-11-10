'use strict';

// A compact model-facing syntax. The browser, reviewer and database receive only
// ordinary workspace plans, never a second implementation of CRM operations.
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const literal=value=>({type:'string',enum:[value]});
const inverse={lt:'gte',lte:'gt',gt:'lte',gte:'lt'};
const comparison={lt:'<',lte:'<=',gt:'>',gte:'>='};
const isLiteral=value=>typeof value==='string'||Number.isFinite(value);
const {normalize}=require('../public/pipeline-core');
const {isDeepStrictEqual}=require('node:util');
// One add plus two steps per target must fit the 30-step workspace-plan limit.
const maxNamedNumbers=14;

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
      op('add_named_numbers',{name:{type:'string',minLength:1,maxLength:60},entries:{type:'array',minItems:1,maxItems:maxNamedNumbers,
        items:object({recordName:{type:'string',minLength:1,maxLength:12000},value:{type:'number',minimum:-1e12,maximum:1e12}})}}),
      op('show_rows',{orderBy:select.orderBy,direction:select.direction,outputs:read.outputs}),
      ...(numeric?[op('classify_number',{numberField:numeric.properties.field,operator:{type:'string',enum:Object.keys(inverse),description:'True branch: at least / and above = gte; above = gt; at most = lte; below = lt. The compiler supplies the exact complementary branch.'},threshold:{type:'number'},
        targetField:field,whenTrue:{type:['number','string']},otherwise:{type:['number','string']},whenBlank:literal('unchanged')})]:[]),
      ...(transform?[op('shift_saved_dates',{field:transform.properties.field,...transform.properties.value.properties})]:[])
    ]}
  });
}

// Both model syntaxes reach this point before ordinary plan validation. Add a
// review witness only for a complete partition; never repair a missing write.
function withClassificationWitness(plan){
  const {steps,goals}=plan;
  if(!Array.isArray(steps)||![4,5].includes(steps.length)||!Array.isArray(goals)||goals.length>=20||
    plan.unmappedFacts?.length||steps.some(s=>!s||!['select_records','update_records'].includes(s.op)))return plan;
  const writes=steps.filter(s=>s.op==='update_records'),selects=steps.filter(s=>s.op==='select_records');
  const sources=['all','focus','visible'];
  if(writes.length!==2||writes.some(w=>w.assignments?.length!==1||w.assignments[0]?.operation!=='set'||!isLiteral(w.assignments[0].value))||
    writes[0].selection===writes[1].selection||writes[0].assignments[0].field!==writes[1].assignments[0].field)return plan;
  const [first,second]=writes.map(w=>selects.find(s=>s.id===w.selection));
  const unrestricted=s=>s&&s.limit===null&&(s.relatedTasks??'any')==='any';
  if(!unrestricted(first)||!unrestricted(second)||first.source!==second.source||
    ![first,second].every(s=>Array.isArray(s.where)&&s.where.length===1&&Array.isArray(s.where[0])&&s.where[0].length<=20))return plan;
  const parent=selects.find(s=>s!==first&&s!==second);
  if(parent?first.source!==parent.id||!unrestricted(parent)||!sources.includes(parent.source):!sources.includes(first.source))return plan;
  // A shared scope may itself be an OR. For independent branch selections,
  // match conjuncts irrespective of order. Exactly one comparison must differ.
  const remaining=second.where[0].slice(),different=first.where[0].filter(c=>{
    const i=remaining.findIndex(other=>isDeepStrictEqual(c,other));
    if(i===-1)return true;
    remaining.splice(i,1);return false;
  });
  const [a]=different,[b]=remaining;
  if(different.length!==1||remaining.length!==1||!a||!b||!Object.hasOwn(inverse,a.operator)||inverse[a.operator]!==b.operator||
    !Number.isFinite(a.value)||a.value!==b.value||a.field!==b.field||a.values?.length!==0||b.values?.length!==0)return plan;
  const id='known_values';
  if(steps.some(s=>s.id===id)||goals.some(g=>!Array.isArray(g?.stepIds)||g.stepIds.includes(id)))return plan;
  // This non-displaying selection does not feed either write. Its review rows
  // expose original numeric cells (including zero/no-ops); the existing
  // final-state constraint proves entire records outside it were unchanged.
  const witness={op:'select_records',id,label:'Check known source values for both branches',source:first.source,
    where:[first.where[0],second.where[0]],orderBy:a.field,direction:'asc',limit:null,relatedTasks:'any'};
  return {...plan,steps:[...steps,witness],goals:[...goals,{description:'Check preservation outside the known-value selection',stepIds:[id]}]};
}

function compile(request){
  if(request?.action==='workspace_plan')return withClassificationWitness(request);
  if(request?.action!=='scoped_table_request')return request;
  const {operation:o,where,source,title}=request;
  if(!o||!Array.isArray(where)||!['all','visible','focus'].includes(source))throw new Error('Choose a record population and table operation.');
  const select=(id,label,source,where)=>({op:'select_records',id,label,source,where,orderBy:null,direction:'asc',limit:null,relatedTasks:'any'});
  const rows=select('population','Select matching records',source,where);
  const steps=o.kind==='add_named_numbers'?[]:[rows];
  const update=(id,label,selection,field,operation,value)=>({op:'update_records',id,label,selection,assignments:[{field,operation,value}]});
  if(o.kind==='add_named_numbers'){
    if(source!=='all'||where.length)throw new Error('Use the named records directly, without an additional view or filter.');
    if(!Array.isArray(o.entries)||!o.entries.length||o.entries.length>maxNamedNumbers)throw new Error('Provide 1 to '+maxNamedNumbers+' named numeric assignments in one proposal.');
    const add={op:'add_field',id:'new_number',label:'Add number column',name:o.name,type:'number',options:[]};
    steps.push(add);
    const seen=new Set();
    for(const [index,entry] of o.entries.entries()){
      if(typeof entry?.recordName!=='string'||entry.recordName.length>12000||!normalize(entry.recordName))throw new Error('Each numeric value needs an exact saved record name.');
      const key=normalize(entry.recordName);
      if(seen.has(key))throw new Error('Provide one numeric assignment per named record.');
      if(!Number.isFinite(entry.value)||Math.abs(entry.value)>1e12)throw new Error('Provide a finite number between -1 trillion and 1 trillion for each named record.');
      seen.add(key);
      const row=select('target_'+index,'Resolve named record',{kind:'exact_primary',name:entry.recordName},[]);
      steps.push(row,update('set_'+index,'Set '+entry.value+' for '+entry.recordName.slice(0,200),row.id,'@'+add.id,'set',entry.value));
    }
  }else if(o.kind==='show_rows'){
    rows.orderBy=o.orderBy;rows.direction=o.direction;
    if(!Array.isArray(o.outputs)||!o.outputs.length)throw new Error('Choose the outputs for the table selection.');
    const outputs=[...o.outputs];
    // The ordered table and its answer share the same rows. Show the actual sort
    // keys as well, without displacing requested outputs at the plan-size limit.
    const needsNames=!outputs.some(item=>item.kind==='names');
    if(o.orderBy&&outputs.length+Number(needsNames)<40&&!outputs.some(item=>item.kind==='fields'&&item.field===o.orderBy)){
      outputs.unshift({kind:'fields',field:o.orderBy});
    }
    if(needsNames)outputs.unshift({kind:'names',field:null});
    steps.push({op:'read_records',id:'display',label:'Show the selected rows',selection:rows.id,showTable:true,outputs});
  }else if(o.kind==='classify_number'){
    if(!Object.hasOwn(inverse,o.operator)||!Number.isFinite(o.threshold)||o.whenBlank!=='unchanged')throw new Error('Choose a numeric comparison and missing-value policy.');
    const keys=['kind','numberField','operator','threshold','targetField','whenTrue','otherwise','whenBlank'];
    if(Object.keys(request).some(key=>!['action','title','source','where','operation'].includes(key))||
      Object.keys(o).some(key=>!keys.includes(key))||![o.numberField,o.targetField].every(f=>typeof f==='string'&&f.trim())||
      ![o.whenTrue,o.otherwise].every(isLiteral))throw new Error('Provide exactly one target field and a literal assignment for both numeric branches.');
    for(const [id,operator,value] of [['match',o.operator,o.whenTrue],['otherwise',inverse[o.operator],o.otherwise]]){
      // Complementary numeric comparisons exclude null from BOTH branches; a
      // fallback over all remaining IDs would accidentally include unknowns.
      const rule=o.numberField.slice(0,80)+' '+comparison[operator]+' '+o.threshold;
      steps.push(select(id,'Select known values: '+rule,rows.id,[[{field:o.numberField,operator,value:o.threshold,values:[]}]]),
        update('apply_'+id,'When '+rule+', set '+o.targetField.slice(0,80)+' to '+String(value).slice(0,100),id,o.targetField,'set',value));
    }
  }else if(o.kind==='shift_saved_dates'){
    steps.push(update('reschedule','Shift each original saved date',rows.id,o.field,'shift_date',{dateMode:o.dateMode,offset:o.offset,blankPolicy:o.blankPolicy}));
  }else throw new Error('Unknown scoped table operation.');
  const plan={action:'workspace_plan',version:1,title,steps,unmappedFacts:[],goals:steps.filter(step=>step.op!=='select_records').map(step=>({description:step.label,stepIds:[step.id]}))};
  return o.kind==='classify_number'?withClassificationWitness(plan):plan;
}

const instructions='For a simple record list, numeric if/otherwise edit leaving unknowns alone, or relative change to saved dates, prefer scoped_table_request. It compiles into reviewed select/read/update steps. Interpret possessive owner wording as a condition on the actual owner field, not a primary record name. Combine the owner and any name/cohort predicate in one AND group; use in for alternatives on one field. An independent list starts at all, not the last visible cohort. show_rows opens the table and returns the same ordered names; request any additional calculations in outputs. classify_number compares the original numeric cells and skips unknowns in both branches. shift_saved_dates moves each original date, not today; a working/business day means Mon-Fri. For more complex requests keep using workspace_plan.';
const namedNumberInstructions='For an explicitly requested new number column plus literal values for up to 14 individually named existing records, prefer scoped_table_request with source all, where [], operation {kind:add_named_numbers,name,entries:[{recordName,value}]}. Copy every supplied name and numeric value as a pair; do not generate field IDs, selections or goals. The app resolves each exact current primary name and previews all assignments together. Missing or ambiguous names require clarification, never a partial field creation or a guessed match. Standalone add_field remains a blank column; cohort/conditional updates still use their regular operations.';
const classificationInstructions='For a complete two-way classification by a saved numeric value, use scoped_table_request/classify_number in preference to hand-written workspace_plan steps. Put ONLY the common cohort in where (for a name prefix use starts_with on the primary field); do not put the numeric threshold there. Supply the numeric field, true comparison, boundary, one target field and both literal assignments. A missing amount is not zero. Treat additional requested work as a compound plan, never discard it to fit this form.';
module.exports={schema,compile,instructions:[instructions,namedNumberInstructions,classificationInstructions].join('\n')};
