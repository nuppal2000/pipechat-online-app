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
const maxClassificationRules=8;
const currentValueDescription='Read current saved cell values for the requested existing fields, including complete text and line breaks. This is a read-only chat answer, even when no table change is requested. No history lookup, summarization, calculation or table navigation; the executor supplies values, not assistant prose.';
const numericOperators=[...Object.keys(inverse),'equals'];
const numericRuleSchema=()=>object({conditions:{type:'array',minItems:1,maxItems:2,items:object({operator:{type:'string',enum:numericOperators},value:{type:'number'}})},value:{type:['number','string']}});

// Canonical intervals make rule order irrelevant and prove boundaries without
// sampling the current rows (which may not contain a value at a bad boundary).
function numericConditions(conditions){
  if(!Array.isArray(conditions)||!conditions.length||conditions.length>40)throw new Error('Provide a bounded numeric range or equality.');
  let lower=-Infinity,upper=Infinity,lowerClosed=false,upperClosed=false;
  for(const c of conditions){
    if(!c||Object.keys(c).some(k=>!['operator','value'].includes(k))||!numericOperators.includes(c.operator)||!Number.isFinite(c.value))throw new Error('Numeric rules need finite boundaries and numeric comparisons.');
    if(['gt','gte','equals'].includes(c.operator)){
      const closed=c.operator!=='gt';
      if(c.value>lower){lower=c.value;lowerClosed=closed;}else if(c.value===lower)lowerClosed=lowerClosed&&closed;
    }
    if(['lt','lte','equals'].includes(c.operator)){
      const closed=c.operator!=='lt';
      if(c.value<upper){upper=c.value;upperClosed=closed;}else if(c.value===upper)upperClosed=upperClosed&&closed;
    }
  }
  if(lower>upper||lower===upper&&!(lowerClosed&&upperClosed))throw new Error('A numeric rule has an empty or contradictory range.');
  const canonical=lower===upper?[{operator:'equals',value:lower}]:[
    ...(Number.isFinite(lower)?[{operator:lowerClosed?'gte':'gt',value:lower}]:[]),
    ...(Number.isFinite(upper)?[{operator:upperClosed?'lte':'lt',value:upper}]:[])
  ];
  return {lower,upper,lowerClosed,upperClosed,conditions:canonical};
}
function classificationRules(rules){
  if(!Array.isArray(rules)||rules.length<2||rules.length>maxClassificationRules)throw new Error('Provide 2 to '+maxClassificationRules+' explicit numeric branches.');
  const ranges=rules.map(rule=>{
    if(!rule||Object.keys(rule).some(k=>!['conditions','value'].includes(k))||!isLiteral(rule.value)||!Array.isArray(rule.conditions)||rule.conditions.length>2)throw new Error('Each numeric branch needs one range and one literal assignment.');
    return {...numericConditions(rule.conditions),value:rule.value};
  }).sort((a,b)=>a.lower-b.lower||a.upper-b.upper);
  for(let i=1;i<ranges.length;i++){
    const a=ranges[i-1],b=ranges[i];
    if(a.upper>b.lower||a.upper===b.lower&&a.upperClosed&&b.lowerClosed)throw new Error('Numeric classification branches overlap. Make each boundary belong to exactly one branch.');
    if(a.upper<b.lower||a.upper===b.lower&&!a.upperClosed&&!b.lowerClosed)throw new Error('Numeric classification has a gap between branches. Specify every range boundary.');
  }
  return ranges.map(({conditions,value})=>({conditions,value}));
}

function schema(plan){
  if(!plan.properties.steps?.items?.anyOf)return null;
  const steps=plan.properties.steps.items.anyOf.map(step=>step.properties);
  const find=name=>steps.find(step=>step.op.enum.includes(name));
  const select=find('select_records'),read=find('read_records'),update=find('update_records');
  const transform=update.assignments.items.anyOf.find(branch=>branch.properties.operation.enum.includes('shift_date'));
  const numeric=update.assignments.items.anyOf.find(branch=>branch.properties.operation.enum.includes('adjust_percent'));
  const op=(name,props)=>object({kind:literal(name),...props});
  const field=select.orderBy.anyOf.find(x=>x.enum?.length);
  const readField=read.outputs.items.anyOf.find(output=>output.properties.kind.enum.includes('fields'))?.properties.field.anyOf.find(x=>x.enum?.length);
  if(!field)return null;
  return {...object({
    action:{...literal('scoped_table_request'),description:'A compact typed table read or change. Choose read_values for current saved cell contents, including text-only answers with no changes.'},title:{type:'string'},
    source:{type:'string',enum:['all','visible','focus']},where:{...select.where,description:'OR of AND groups. Put a cohort prefix and the owner or stage restriction in the same group. Use in for several allowed values of one field.'},
    operation:{anyOf:[
      ...(readField?[{...op('read_values',{fields:{type:'array',minItems:1,maxItems:20,items:readField,
        description:'Existing field IDs to read exactly from current saved cells. This is a chat-only projection, not a history lookup, calculation or table-view change.'}}),description:currentValueDescription}]:[]),
      op('add_named_numbers',{name:{type:'string',minLength:1,maxLength:60},entries:{type:'array',minItems:1,maxItems:maxNamedNumbers,
        items:object({recordName:{type:'string',minLength:1,maxLength:12000},value:{type:'number',minimum:-1e12,maximum:1e12}})}}),
      op('show_rows',{orderBy:select.orderBy,direction:select.direction,outputs:read.outputs}),
      ...(numeric?[op('classify_number',{numberField:numeric.properties.field,operator:{type:'string',enum:Object.keys(inverse),description:'True branch: at least / and above = gte; above = gt; at most = lte; below = lt. The compiler supplies the exact complementary branch.'},threshold:{type:'number'},
        targetField:field,whenTrue:{type:['number','string']},otherwise:{type:['number','string']},whenBlank:literal('unchanged')}),
      op('classify_number_rules',{numberField:numeric.properties.field,targetField:field,
        rules:{type:'array',minItems:2,maxItems:maxClassificationRules,items:numericRuleSchema(),description:'Every requested branch, with disjoint adjacent ranges or equality. Use two conditions for a bounded interval. Do not widen a range to fill a missing branch.'},
        whenBlank:literal('unchanged'),whenUnmatched:literal('unchanged')})]:[]),
      ...(transform?[op('shift_saved_dates',{field:transform.properties.field,...transform.properties.value.properties})]:[])
    ]}
  }),description:'Use read_values for current field contents, show_rows for a table list, or the matching typed operation for an explicit change. Read-only requests still need an action. Compound work uses workspace_plan.'};
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
  if(o.kind==='read_values'){
    if(Object.keys(request).some(key=>!['action','title','source','where','operation'].includes(key))||
      Object.keys(o).some(key=>!['kind','fields'].includes(key))||!Array.isArray(o.fields)||!o.fields.length||o.fields.length>20||
      o.fields.some(field=>typeof field!=='string'||!field.trim()||field.length>120||field.startsWith('@'))||new Set(o.fields).size!==o.fields.length)
      throw new Error('Choose one to twenty distinct existing fields for a current-cell answer. Use a complete plan for additional work.');
    steps.push({op:'read_records',id:'current_values',label:'Read current saved cells',selection:rows.id,showTable:false,
      outputs:o.fields.map(field=>({kind:'fields',field}))});
  }else if(o.kind==='add_named_numbers'){
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
  }else if(o.kind==='classify_number_rules'){
    const keys=['kind','numberField','targetField','rules','whenBlank','whenUnmatched'];
    if(Object.keys(request).some(key=>!['action','title','source','where','operation'].includes(key))||
      Object.keys(o).some(key=>!keys.includes(key))||![o.numberField,o.targetField].every(f=>typeof f==='string'&&f.trim())||
      o.whenBlank!=='unchanged'||o.whenUnmatched!=='unchanged')throw new Error('Numeric rule lists must preserve missing values and values outside the declared ranges.');
    for(const [index,branch] of classificationRules(o.rules).entries()){
      const id='branch_'+index,rule=branch.conditions.map(c=>o.numberField.slice(0,80)+' '+(comparison[c.operator]||'=')+' '+c.value).join(' and ');
      steps.push(select(id,'Select known values: '+rule,rows.id,[branch.conditions.map(c=>({field:o.numberField,...c,values:[]}))]),
        update('apply_'+id,'When '+rule+', set '+o.targetField.slice(0,80)+' to '+String(branch.value).slice(0,100),id,o.targetField,'set',branch.value));
    }
    const witness=select('known_values','Check values covered by every declared branch',rows.id,steps.filter(s=>s.op==='select_records'&&s.id!==rows.id).flatMap(s=>s.where));
    witness.orderBy=o.numberField;steps.push(witness);
  }else if(o.kind==='shift_saved_dates'){
    steps.push(update('reschedule','Shift each original saved date',rows.id,o.field,'shift_date',{dateMode:o.dateMode,offset:o.offset,blankPolicy:o.blankPolicy}));
  }else throw new Error('Unknown scoped table operation.');
  const plan={action:'workspace_plan',version:1,title,steps,unmappedFacts:[],goals:steps.filter(step=>step.op!=='select_records').map(step=>({description:step.label,stepIds:[step.id]}))};
  if(o.kind==='classify_number_rules')plan.goals.push({description:'Check preservation outside the declared numeric ranges',stepIds:['known_values']});
  return o.kind==='classify_number'?withClassificationWitness(plan):plan;
}

const instructions='For current saved field contents, a simple record list, numeric if/otherwise edit leaving unknowns alone, or relative change to saved dates, prefer scoped_table_request. It compiles into reviewed select/read/update steps. read_values returns the complete requested current cells in chat without changing the view or data; use it even for a text-only question or an explicit do-not-change request. Interpret possessive owner wording as a condition on the actual owner field, not a primary record name. Combine the owner and any name/cohort predicate in one AND group; use in for alternatives on one field. An independent list starts at all, not the last visible cohort. show_rows opens the table and returns the same ordered names; request any additional calculations in outputs. classify_number compares the original numeric cells and skips unknowns in both branches. shift_saved_dates moves each original date, not today; a working/business day means Mon-Fri. For more complex requests keep using workspace_plan.';
const namedNumberInstructions='For an explicitly requested new number column plus literal values for up to 14 individually named existing records, prefer scoped_table_request with source all, where [], operation {kind:add_named_numbers,name,entries:[{recordName,value}]}. Copy every supplied name and numeric value as a pair; do not generate field IDs, selections or goals. The app resolves each exact current primary name and previews all assignments together. Missing or ambiguous names require clarification, never a partial field creation or a guessed match. Standalone add_field remains a blank column; cohort/conditional updates still use their regular operations.';
const classificationInstructions='For a complete two-way classification by a saved numeric value, use scoped_table_request/classify_number. For multiple explicit ranges or equality branches use classify_number_rules with rules:[{conditions:[{operator,value}],value}], one existing numberField and targetField, whenBlank:unchanged and whenUnmatched:unchanged. Include EVERY requested branch (2 to 8); equality is equals, and a bounded interval uses two conjunctive conditions. Branches must be disjoint and adjacent with each shared boundary assigned exactly once; values outside the declared outer range remain unchanged. Rule order does not create precedence. Never replace a bounded middle range with an otherwise branch, invent a missing range, or drop a zero/equality rule. Put ONLY the common cohort in where (for a name prefix use starts_with on the primary field), not the branch thresholds. A missing amount is not zero. Treat additional requested work as a compound plan, never discard it to fit this form.';
const currentValueInstructions='CURRENT SAVED CELL READS: a request for the current contents of an existing field, including exact/verbatim/multiline text, requires a typed current-record projection, not an unsupported request or a prose-only answer. Prefer scoped_table_request with operation {kind:read_values,fields:[existing field IDs]}, source all for an independently named record/cohort and exact typed where predicates. Use visible/focus only when explicitly referring to that population. It compiles to select_records plus read_records fields with showTable false; it does not open Pipeline, read history, calculate, edit, or summarize. Field labels such as Notes, Comments or Instructions are ordinary current columns; never infer a history lookup from their names. Copy no cell values into the plan: the executor reads the current saved snapshot and preserves line breaks and punctuation. Do not change anything and do not use history are preservation constraints, not extra requested actions. Other requested outputs/actions need the complete workspace_plan, not a partial read_values result.';
module.exports={schema,compile,numericConditions,classificationRules,numericRuleSchema,maxClassificationRules,instructions:[currentValueInstructions,instructions,namedNumberInstructions,classificationInstructions].join('\n')};
