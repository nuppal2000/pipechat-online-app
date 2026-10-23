(function(root,factory){
  const api=typeof module==='object'&&module.exports?factory(require('./pipeline-core.js'),require('./report-engine.js'),require('./todo-core.js'),require('./todo-actions.js'),require('./dashboard-board.js'),require('./inspector-core.js')):factory(root.PipelineCore,root.PipeChatReports,root.PipeChatTodo,root.PipeChatTodoActions,root.PipeChatDashboard,root.PipeChatInspector);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatPlan=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Core,Reports,Todo,TaskActions,Dashboard,Inspector){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const supportedOps=new Set(['select_records','add_field','rename_choice_option','update_records','add_todos','add_unlinked_task','update_tasks','read_records','read_history','report','dashboard']);
  const reasonCodes=new Set(['plan_validation','date_invalid','date_offset_invalid','current_date_unavailable','field_unavailable','selection_dependency','focus_unavailable','record_selection_stale','numeric_field_required','unsupported_operation',
    'task_validation','task_reference_ambiguous','task_reference_missing','task_focus_unavailable','task_selection_stale','task_selection_empty','task_write_conflict','task_no_changes']);
  const fail=(message,reasonCode='plan_validation')=>{const error=new Error(message);error.clarification=true;error.reasonCode=reasonCode;throw error;};
  const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const str={type:'string'},scalar={type:['string','number']};
  function responseSchema(core=Core.create(null),custom=[],focus=null){
    const definitions=core.definitions(custom),fieldIds=definitions.map(field=>field.id);
    const createdField={type:'string',pattern:'^@[a-z][a-z0-9_]{0,39}$'};
    const fieldRef={anyOf:[...(fieldIds.length?[{type:'string',enum:fieldIds}]:[]),createdField]};
    const optionalField={anyOf:[...fieldRef.anyOf,{type:'null'}]};
    const numericIds=definitions.filter(field=>['number','currency'].includes(field.type)).map(field=>field.id);
    const outputs={anyOf:[
      object({kind:{type:'string',enum:['count','names']},field:{type:'null'}}),
      object({kind:{type:'string',enum:['fields','distinct']},field:fieldRef}),
      ...(numericIds.length?[object({kind:{type:'string',enum:['sum','average','median','min','max']},field:{type:'string',enum:numericIds}})]:[])
    ]};
    const date=object({dateMode:{type:'string',enum:['literal','calendar_days','business_days']},date:{type:['string','null']},offset:{type:['integer','null']}});
    const condition=object({field:fieldRef,operator:{type:'string',enum:Reports.operators},value:{type:['string','number','null']},values:{type:'array',items:{type:['string','number','null']}}});
    const step=(op,properties)=>object({op:{type:'string',enum:[op]},id:str,label:str,...properties});
    return object({action:{type:'string',enum:['workspace_plan']},version:{type:'integer',enum:[1]},title:str,
      unmappedFacts:{type:'array',maxItems:40,items:object({text:str,source:str,reason:str})},
      goals:{type:'array',minItems:1,maxItems:20,items:object({description:str,stepIds:{type:'array',minItems:1,items:str}})},
      steps:{type:'array',minItems:1,maxItems:30,items:{anyOf:[
        step('select_records',{source:str,where:{type:'array',items:{type:'array',items:condition}},orderBy:optionalField,direction:{type:'string',enum:['asc','desc']},limit:{type:['integer','null']},relatedTasks:{type:'string',enum:['any','none','exists']}}),
        step('add_field',{name:str,type:{type:'string',enum:['text','choice','date']},options:{type:'array',items:str}}),
        step('rename_choice_option',{field:fieldRef,from:str,to:str}),
        step('update_records',{selection:str,assignments:{type:'array',minItems:1,maxItems:40,items:object({field:fieldRef,operation:{type:'string',enum:['set','append']},value:{anyOf:[scalar,date]}})}}),
        step('add_todos',{selection:str,status:{type:'string',enum:Todo.statuses},nextAction:str,notes:str,dueDate:{anyOf:[{type:'null'},date]}}),
        step('add_unlinked_task',{customTitle:str,status:{type:'string',enum:Todo.statuses},nextAction:str,notes:str,dueDate:{anyOf:[{type:'null'},date]}}),
        step('update_tasks',{selection:TaskActions.actionSchemas(focus)[1].properties.updates.items.properties.selection,changes:{type:'array',minItems:1,maxItems:4,items:object({field:{type:'string',enum:['status','nextAction','notes','dueDate']},operation:{type:'string',enum:['set','append']},value:{anyOf:[str,date]}})}}),
        step('read_records',{selection:str,showTable:{type:'boolean'},outputs:{type:'array',minItems:1,maxItems:40,items:outputs}}),
        step('read_history',{selection:str,kind:{type:'string',enum:['all','note','activity']},from:{type:['string','null']},to:{type:['string','null']},limit:{type:'integer',minimum:1,maximum:500}}),
        step('report',{selection:{type:['string','null'],description:'A preceding select_records step ID, or null for an independent report population.'},spec:Reports.responseSchema(core,custom).anyOf[1],questions:Dashboard.schemas(core,custom)[1].properties.questions,showDashboard:{type:'boolean'}}),
        step('dashboard',{plan:Dashboard.schemas(core,custom)[0]})
      ]}}
    });
  }
  function dateValue(spec,today){
    if(!spec||typeof spec!=='object'||Array.isArray(spec))fail('Please specify a complete date or an offset from today.','date_invalid');
    const core=Core.create(null);
    if(spec.dateMode==='literal'){
      const parsed=core.date(spec.date);
      if(!parsed||spec.offset!==null)fail('Please specify a complete, valid calendar date.','date_invalid');
      const value=parsed.toISOString().slice(0,10);
      return {value,explanation:'Date: '+value};
    }
    if(!['calendar_days','business_days'].includes(spec.dateMode)||spec.date!==null||!Number.isInteger(spec.offset)||Math.abs(spec.offset)>366)fail('Choose a date offset of up to 366 days.','date_offset_invalid');
    const base=core.date(today);
    if(!base)fail('The current date is unavailable. Please specify an exact due date.','current_date_unavailable');
    const business=spec.dateMode==='business_days',dates=[],direction=Math.sign(spec.offset);
    for(let left=Math.abs(spec.offset);left;){
      base.setUTCDate(base.getUTCDate()+direction);
      if(!business||![0,6].includes(base.getUTCDay())){left--;dates.push(base.toISOString().slice(0,10));}
    }
    const value=base.toISOString().slice(0,10);
    return {value,explanation:`${today} ${spec.offset<0?'-':'+'} ${Math.abs(spec.offset)} ${business?'business':'calendar'} days = ${value}${business?' (Monday-Friday; weekends skipped, holidays not excluded)':''}.${business&&dates.length<=10?' Counted: '+(dates.join(', ')||'today'):''}`};
  }
  function snapshot(workspace){return JSON.stringify([workspace.records,workspace.customFields,workspace.tableSchema,workspace.todoCards]);}
  function prepare(workspace,action,{today,nonce,now=Date.now(),visibleIds=[],focus=null,dashboard=null,timezone='UTC'}={}){
    if(action?.action!=='workspace_plan'||action.version!==1||!Array.isArray(action.steps)||!action.steps.length||action.steps.length>30)fail('Please provide a complete plan with at most 30 steps.');
    if(!/^[a-z0-9_]{1,36}$/.test(nonce||''))throw new Error('A unique plan identifier is required.');
    if(typeof action.title!=='string'||!action.title.trim()||action.title.length>300)fail('Please name the complete plan.');
    const ids=new Set();
    for(const step of action.steps){
      if(!step||! /^[a-z][a-z0-9_]{0,39}$/.test(step.id)||step.id==='all'||ids.has(step.id))fail('Each plan step needs a unique identifier.');
      if(typeof step.label!=='string'||!step.label.trim()||step.label.length>500)fail('Each step needs a clear description.');
      ids.add(step.id);
    }
    if(!Array.isArray(action.goals)||!action.goals.length||action.goals.length>20)fail('Please list every requested outcome in the plan.');
    const covered=new Set();
    for(const goal of action.goals){
      if(typeof goal?.description!=='string'||!goal.description.trim()||goal.description.length>1000||!Array.isArray(goal.stepIds)||!goal.stepIds.length)fail('Every requested outcome needs a description and at least one compiled step ID.');
      if(goal.stepIds.some(id=>!ids.has(id)))fail(`Every requested outcome must refer to valid plan steps. Unrecognized references: ${goal.stepIds.filter(id=>!ids.has(id)).join(', ')}. Available steps: ${[...ids].join(', ')}.`);
      goal.stepIds.forEach(id=>covered.add(id));
    }
    if([...ids].some(id=>!covered.has(id)))fail('Some plan steps are not included in the requested-outcomes review.');
    const unmappedFacts=action.unmappedFacts??[];
    if(!Array.isArray(unmappedFacts)||unmappedFacts.length>40||unmappedFacts.some(f=>!f||['text','source','reason'].some(key=>typeof f[key]!=='string'||!f[key].trim()||f[key].length>4000)))fail('Every unmapped fact needs its original source and a clear reason.');
    const before=snapshot(workspace),next=clone(workspace),selections=new Map(),fields=new Map(),review=[],calculations=new Set(),addedFields=[],schemaChanges=[],addedCards=[],answers=[],effects=[],queryResults=[];
    let core=Core.create(next.tableSchema),eligibility=clone(workspace.records);
    let board=clone(dashboard||Dashboard.empty());const taskUpdates=[];
    const resolve=reference=>{
      const id=reference?.startsWith('@')?fields.get(reference.slice(1)):reference;
      if(!core.definitions(next.customFields).some(field=>field.id===id))fail('A step refers to an unavailable field. Create the field first, then reference @step_id.','field_unavailable');
      return id;
    };
    const selected=reference=>{if(!selections.has(reference))fail('Select records before using that selection in another step.',reference==='focus'?'focus_unavailable':'selection_dependency');return selections.get(reference);};
    const materialize=value=>{
      if(value&&typeof value==='object'){const result=dateValue(value,today);calculations.add(result.explanation);return result.value;}
      if(!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))fail('Each edit needs a literal value. Use an empty string to explicitly clear a cell.');
      return value;
    };
    for(const [index,step]of action.steps.entries()){
      try{
        if(step.op==='select_records'){
          const sourceIds=step.source==='all'?null:step.source==='visible'?visibleIds:step.source==='focus'&&focus?.kind==='table'&&Array.isArray(focus.ids)?focus.ids:selected(step.source);
          if(sourceIds&&sourceIds.some(id=>!workspace.records.some(row=>row.id===id)))fail('A selected record no longer exists. Please select the records again.','record_selection_stale');
          // Eligibility reads the original snapshot, even if an earlier step updates a predicate field.
          const rows=next.records.map(row=>({...row,...eligibility.find(r=>r.id===row.id)})).filter(row=>sourceIds===null||sourceIds.includes(row.id));
          if(!Array.isArray(step.where))fail('Please supply the selection conditions.');
          const where=step.where.map(group=>{if(!Array.isArray(group))fail('Selection conditions must be grouped.');return group.map(condition=>({...condition,field:resolve(condition.field)}));});
          const spec={version:1,title:step.label,chart:'kpi',scope:'all',groupBy:null,bucket:'none',splitBy:null,measures:[{label:'Count',metric:'count',field:null,where:[]}],where,sort:'label_asc',limit:null};
          let matched=Reports.execute(rows,spec,core,next.customFields,{today}).rows.slice();
          if(!['any','none','exists'].includes(step.relatedTasks??'any'))fail('Choose any, none or exists for the linked-task condition.');
          if(step.relatedTasks&&step.relatedTasks!=='any')matched=matched.filter(row=>workspace.todoCards.some(card=>card.recordId===row.id)===(step.relatedTasks==='exists'));
          if(sourceIds)matched.sort((a,b)=>sourceIds.indexOf(a.id)-sourceIds.indexOf(b.id));
          const count=matched.length;
          if(!['asc','desc'].includes(step.direction)||step.limit!==null&&(!Number.isInteger(step.limit)||step.limit<1||step.limit>2000))fail('Use a valid selection order and limit.');
          let orderField=null;
          if(step.orderBy!==null){
            orderField=core.definitions(next.customFields).find(f=>f.id===resolve(step.orderBy));
            const empty=v=>v==null||v==='';
            matched.sort((a,b)=>{
              const x=a[orderField.id],y=b[orderField.id];
              if(empty(x)||empty(y))return empty(x)===empty(y)?a.id-b.id:empty(x)?1:-1;
              const compared=['number','currency'].includes(orderField.type)?Number(x)-Number(y):String(x).localeCompare(String(y),undefined,{numeric:orderField.type!=='date'});
              return (step.direction==='desc'?-compared:compared)||a.id-b.id;
            });
          }
          if(step.limit!==null)matched=matched.slice(0,step.limit);
          selections.set(step.id,matched.map(row=>row.id));
          review.push({id:step.id,label:step.label,op:step.op,matched:count,filter:Reports.describe(spec,core,next.customFields)+(step.relatedTasks&&step.relatedTasks!=='any'?`; Linked tasks: ${step.relatedTasks}`:''),source:step.source,order:orderField?`${orderField.name}, ${step.direction==='desc'?'highest first':'lowest first'}; ties by record ID`:'Saved row order',limit:step.limit,records:matched.map(row=>({id:row.id,name:String(row[core.role('primary')]||'Unnamed record #'+row.id),value:orderField?row[orderField.id]:null}))});
        }else if(step.op==='add_field'){
          if(!['text','choice','date'].includes(step.type)||!Array.isArray(step.options)||step.type!=='choice'&&step.options.length)fail('Choose a text, date or dropdown field with the appropriate options.');
          const field={id:`cf_${nonce}_${index}`,name:step.name,type:step.type,...(step.type==='choice'?{options:step.options}:{})};
          next.customFields=core.validateCustomFields([...next.customFields,field]);
          next.records=next.records.map(row=>({...row,[field.id]:''}));fields.set(step.id,field.id);addedFields.push(field);
          review.push({id:step.id,op:step.op,label:step.label,field});
        }else if(step.op==='rename_choice_option'){
          const field=resolve(step.field),definition=core.definitions(next.customFields).find(f=>f.id===field);
          if(definition.type!=='choice'||!definition.options.includes(step.from)||typeof step.to!=='string'||!step.to.trim()||step.to!==step.to.trim()||step.to.length>100||definition.options.some(value=>value!==step.from&&value.toLowerCase()===step.to.toLowerCase()))fail('Choose an existing dropdown option and a distinct nonempty replacement.');
          const replace=definition=>definition.id===field?{...definition,options:definition.options.map(v=>v===step.from?step.to:v)}:definition;
          if(next.tableSchema?.status==='ready')next.tableSchema.fields=next.tableSchema.fields.map(replace);
          next.customFields=next.customFields.map(replace);core=Core.create(next.tableSchema);
          if(next.tableSchema?.kpis)next.tableSchema.kpis=next.tableSchema.kpis.map(kpi=>({...kpi,conditions:kpi.conditions.map(condition=>condition.field===field&&condition.value===step.from?{...condition,value:step.to}:condition)}));
          next.customFields=core.validateCustomFields(next.customFields);
          next.records=next.records.map(row=>row[field]===step.from?{...row,[field]:step.to}:row);
          eligibility=eligibility.map(row=>row[field]===step.from?{...row,[field]:step.to}:row);
          const renamePredicates=groups=>(groups||[]).map(group=>group.map(c=>c.field!==field?c:{...c,value:c.value===step.from?step.to:c.value,values:(c.values||[]).map(v=>v===step.from?step.to:v)}));
          board.elements=(board.elements||[]).map(element=>({...element,spec:{...element.spec,where:renamePredicates(element.spec.where),measures:element.spec.measures.map(m=>({...m,where:renamePredicates(m.where)}))}}));
          board.sharedFilters=(board.sharedFilters||[]).map(filter=>({...filter,where:renamePredicates(filter.where)}));
          if(board.elements.length)effects.push({kind:'dashboard',board:clone(board),preserveView:true});
          const change={field:definition.name,fieldId:field,before:step.from,after:step.to};schemaChanges.push(change);review.push({id:step.id,op:step.op,label:step.label,change});
        }else if(step.op==='update_records'){
          const targetIds=selected(step.selection);
          if(!Array.isArray(step.assignments)||!step.assignments.length||step.assignments.length>40)fail('An update needs 1 to 40 field assignments.');
          const assignments=step.assignments.map(a=>{
            const field=resolve(a.field),value=materialize(a.value),definition=core.definitions(next.customFields).find(f=>f.id===field);
            if(!['set','append'].includes(a.operation)||a.operation==='append'&&definition.type!=='text')fail('Appending is only supported for text fields.');
            return {field,value:core.validateStoredValue(field,value,next.customFields),operation:a.operation};
          });
          let changes=0;
          next.records=next.records.map(row=>{
            if(!targetIds.includes(row.id))return row;
            const copy={...row};
            for(const a of assignments){const value=a.operation==='append'?[copy[a.field],a.value].filter(v=>v!==''&&v!=null).join('\n'):a.value;const checked=core.validateStoredValue(a.field,value,next.customFields);if(copy[a.field]!==checked)changes++;copy[a.field]=checked;}
            return copy;
          });
          review.push({id:step.id,op:step.op,label:step.label,count:targetIds.length,changes});
        }else if(step.op==='add_todos'){
          const targetIds=selected(step.selection),dueDate=step.dueDate===null?'':materialize(step.dueDate);
          if(targetIds.length>200)fail('Create at most 200 tasks in one plan. Narrow the selection.');
          if(typeof step.nextAction!=='string'||!step.nextAction.trim())fail('What should the selected records\' tasks say?');
          const cards=targetIds.map((recordId,i)=>({...Todo.create(`todo_${nonce}_${index}_${i}`,recordId),status:step.status,nextAction:step.nextAction,notes:step.notes,dueDate}));
          // Validate even an empty conditional branch; malformed task instructions must not disappear.
          if(!Todo.statuses.includes(step.status)||typeof step.notes!=='string'||step.notes.length>16000||step.nextAction.length>12000)fail('Specify a supported board status and task text.');
          next.todoCards=Todo.validate([...next.todoCards,...cards],next.records,next.tableSchema,next.customFields);addedCards.push(...cards);
          review.push({id:step.id,op:step.op,label:step.label,count:cards.length});
        }else if(step.op==='add_unlinked_task'){
          const card={...Todo.create(`todo_${nonce}_${index}`,null,step.customTitle),status:step.status,nextAction:step.nextAction,notes:step.notes,dueDate:step.dueDate===null?'':materialize(step.dueDate)};
          next.todoCards=Todo.validate([...next.todoCards,card],next.records,next.tableSchema,next.customFields);addedCards.push(card);review.push({id:step.id,op:step.op,label:step.label,count:1});
        }else if(step.op==='update_tasks'){
          const changes=step.changes.map(change=>({...change,value:materialize(change.value)}));
          taskUpdates.push({selection:step.selection,changes});
          // An unchanged prefix is valid; later steps can still contribute writes.
          const result=TaskActions.plan(workspace.todoCards,next.records,next.tableSchema,{action:'update_todos',updates:taskUpdates},focus,{allowUnchanged:true});
          const selectedTasks=TaskActions.select(workspace.todoCards,next.records,next.tableSchema,step.selection,focus);
          next.todoCards=[...result.cards,...addedCards];review.push({id:step.id,op:step.op,label:step.label,count:selectedTasks.length,targets:selectedTasks.map(c=>({taskId:c.id,recordId:c.recordId,task:c.nextAction,title:Todo.project(c,next.records,next.tableSchema,next.customFields).title}))});
        }else if(step.op==='read_records'){
          const recordIds=selected(step.selection),rows=recordIds.map(id=>next.records.find(row=>row.id===id));
          if(!Array.isArray(step.outputs)||!step.outputs.length||step.outputs.length>40||typeof step.showTable!=='boolean')fail('Specify the requested read outputs and whether to show the table.');
          const name=row=>String(row[core.role('primary')]||'Unnamed record #'+row.id);
          const projected=[];
          const lines=step.outputs.map(output=>{
            if(output.kind==='count'&&output.field===null)return `Record count: ${rows.length}.`;
            if(output.kind==='names'&&output.field===null)return 'Accounts (selection order):\n'+(rows.map(row=>`- ${name(row)} (#${row.id})`).join('\n')||'None.');
            if(!['fields','sum','average','median','distinct','min','max'].includes(output.kind))fail('Choose supported fields, count, names or calculated outputs.');
            const field=resolve(output.field),def=core.definitions(next.customFields).find(f=>f.id===field);
            if(output.kind==='fields'){
              projected.push(...rows.map(row=>({recordId:row.id,name:name(row),fieldId:field,fieldName:def.name,value:row[field]??'',source:'current_record'})));
              return `${def.name}:\n`+(rows.map(row=>`- ${name(row)} (#${row.id}): ${row[field]===''||row[field]==null?'(blank)':String(row[field])}`).join('\n')||'No matching records.');
            }
            if(output.kind==='distinct')return `Distinct ${def.name}: ${new Set(rows.map(row=>row[field]).filter(v=>v!==null&&v!==undefined&&v!=='')).size}.`;
            if(!['number','currency'].includes(def.type))fail('Choose a numeric field for calculations.','numeric_field_required');
            const values=rows.filter(row=>typeof row[field]==='number'&&Number.isFinite(row[field])),sum=values.reduce((n,row)=>n+row[field],0);
            const ordered=values.map(row=>row[field]).sort((a,b)=>a-b),mid=Math.floor(ordered.length/2);
            const value=output.kind==='sum'?sum:!values.length?null:output.kind==='average'?sum/values.length:output.kind==='median'?ordered.length%2?ordered[mid]:(ordered[mid-1]+ordered[mid])/2:output.kind==='min'?Math.min(...ordered):Math.max(...ordered);
            const formatted=value===null?'Not set':new Intl.NumberFormat('en-US',{maximumFractionDigits:2,...(def.type==='currency'?{style:'currency',currency:'USD'}:{})}).format(value);
            return `${{sum:'Total',average:'Average',median:'Median',min:'Lowest',max:'Highest'}[output.kind]} ${def.name}: ${formatted}${['min','max'].includes(output.kind)&&value!==null?' ('+values.filter(row=>row[field]===value).map(name).join(', ')+')':''}. ${values.length} numeric values across ${rows.length} records. Blank/non-numeric values excluded; zeroes included.`;
          });
          queryResults.push({id:step.id,selection:step.selection,recordIds:recordIds.slice(),projected,viewEffect:step.showTable?'show_table':'answer_only'});
          answers.push(lines.join('\n'));effects.push({kind:'table',show:step.showTable,ids:recordIds});review.push({id:step.id,op:step.op,label:step.label,count:rows.length});
        }else if(step.op==='read_history'){
          const recordIds=selected(step.selection),rows=recordIds.map(id=>next.records.find(row=>row.id===id));
          const history=Inspector.query(rows,core.role('primary'),{kind:step.kind,from:step.from,to:step.to,limit:step.limit,timezone});
          queryResults.push({id:step.id,selection:step.selection,recordIds:recordIds.slice(),history,viewEffect:'answer_only'});
          answers.push(history.answer);effects.push({kind:'table',show:false,ids:recordIds.slice()});
          review.push({id:step.id,op:step.op,label:step.label,count:rows.length,entries:history.total,omitted:history.omitted});
        }else if(step.op==='report'){
          const selection=Object.hasOwn(step,'selection')?step.selection:null;
          if(selection!==null&&typeof selection!=='string')fail('A report selection must reference a prior select_records step or be null.');
          const reportIds=selection===null?visibleIds.slice():selected(selection).slice();
          if(!['all','visible'].includes(step.spec?.scope))fail('Choose all or visible for the report scope.');
          const spec=clone(step.spec);
          // Persist the selected cohort as visible scope so later evaluation cannot broaden it.
          if(selection!==null)spec.scope='visible';
          const reportBoard={version:1,elements:[{id:step.id,spec,visibleIds:reportIds}],sharedFilters:[],activeId:step.id};
          const views=Dashboard.evaluate(reportBoard,next.records,core,next.customFields,{today});
          answers.push(Dashboard.analyze(step.questions,views));
          if(step.showDashboard){board=reportBoard;effects.push({kind:'dashboard',board});}
          const recordIds=views[0].snapshot.recordIds.slice();
          if(!step.showDashboard)effects.push({kind:'table',show:false,ids:recordIds.slice()});
          queryResults.push({id:step.id,selection,recordIds,viewEffect:step.showDashboard?'show_dashboard':'answer_only'});
          review.push({id:step.id,op:step.op,label:step.label,count:views[0].snapshot.recordCount,selection,recordIds:recordIds.slice()});
        }else if(step.op==='dashboard'){
          const result=Dashboard.apply(board,step.plan,next.records,core,next.customFields,{today,visibleIds});board=result.board;
          answers.push(result.answer);effects.push({kind:'dashboard',board});review.push({id:step.id,op:step.op,label:step.label,count:step.plan.operations.length});
        }else fail('That operation cannot be combined in this plan yet. Please clarify the complete request; no partial changes were prepared.','unsupported_operation');
      }catch(error){
        const ErrorType=error instanceof TypeError?TypeError:error instanceof RangeError?RangeError:error instanceof SyntaxError?SyntaxError:Error;
        const wrapped=new ErrorType(`Step ${index+1} (${step.label}): ${error?.message} The entire plan is unchanged.`,{cause:error});
        wrapped.clarification=true;
        // Only static classes may enter diagnostics; labels, values and causes stay out.
        if(supportedOps.has(step.op))wrapped.compilerStep=step.op;
        wrapped.reasonCode=reasonCodes.has(error?.reasonCode)?error.reasonCode:error instanceof TypeError?'type_error':'step_validation';
        throw wrapped;
      }
    }
    const definitions=core.definitions(next.customFields),patches=[];
    for(const row of next.records){const original=workspace.records.find(r=>r.id===row.id),changes=[];for(const f of definitions){const old=original[f.id]??'',value=row[f.id]??'';if(old!==value)changes.push({field:f.name,before:old,after:value});}if(changes.length)patches.push({id:row.id,name:String(row[core.role('primary')]||'Unnamed record #'+row.id),changes});}
    const taskPatches=next.todoCards.filter(card=>!addedCards.some(c=>c.id===card.id)&&JSON.stringify(card)!==JSON.stringify(workspace.todoCards.find(c=>c.id===card.id))).map(card=>({before:workspace.todoCards.find(c=>c.id===card.id),after:card}));
    return {kind:'workspace-plan',phase:'proposed',title:action.title,goals:clone(action.goals),unmappedFacts:clone(unmappedFacts),review,calculations:[...calculations],addedFields,schemaChanges,addedCards,taskPatches,answers,queryResults,effects,mutates:snapshot(next)!==before,patches,next,before,count:patches.length,createdAt:now};
  }
  function render(plan,esc,saving){
    const text=value=>esc(value===''||value==null?'(blank)':String(value));
    const diff=change=>`<div class="field-diff"><span>${esc(change.field)}</span><div class="diff-values"><span class="diff-before">${text(change.before)}</span><span aria-label="to">&rarr;</span><span class="diff-after">${text(change.after)}</span></div></div>`;
    const section=(title,body)=>`<section class="proposal-record"><h3>${esc(title)}</h3>${body}</section>`;
    const summary=step=>step.op==='select_records'?`Select ${step.records.length} of ${step.matched} matching records`:step.op==='add_field'?`Add ${step.field.name} column`:step.op==='rename_choice_option'?`Rename ${step.change.field} option ${step.change.before} to ${step.change.after}`:step.op==='update_records'?`Update ${step.changes} cells across ${step.count} selected records`:step.op==='update_tasks'?`Update ${step.count} tasks`:step.op==='read_records'?`Answer from ${step.count} selected records`:step.op==='read_history'?`Read ${step.entries} history entries across ${step.count} selected records`:step.op==='report'?'Calculate requested report':step.op==='dashboard'?`Apply ${step.count} dashboard operations`:`Create ${step.count} ${step.op==='add_todos'?'linked ':'standalone '}tasks`;
    const selections=plan.review.map(step=>{
      let body;
      if(step.op==='select_records')body=`<p>${step.matched} matching; ${step.records.length} selected. ${esc(step.order)}</p><p>${esc(step.filter)}</p><p>Source: ${esc(step.source)}</p><ol>${step.records.map(r=>`<li>${esc(r.name)} (#${r.id})${r.value!==null&&r.value!==undefined?' / '+text(r.value):''}</li>`).join('')}</ol>`;
      else if(step.op==='add_field')body=`<p>${esc(step.field.name)} / ${esc(step.field.type)}${step.field.options?' / '+step.field.options.map(esc).join(', '):''}. Other cells remain blank unless listed below.</p>`;
      else body=`<p>${esc(summary(step))}${step.count===0?' (no matching records; no changes in this step)':''}.</p>`;
      return section(summary(step),body);
    }).join('');
    const cells=plan.patches.map(p=>section(`${p.name} (#${p.id})`,p.changes.map(diff).join(''))).join('');
    const cards=plan.addedCards.map(card=>section(Todo.project(card,plan.next.records,plan.next.tableSchema,plan.next.customFields).title,`<p>${esc(card.status)} / ${esc(card.nextAction)}</p><p>Due: ${text(card.dueDate)}</p>${card.notes?`<p>${esc(card.notes)}</p>`:''}`)).join('');
    const edits=plan.taskPatches.map(p=>section(Todo.project(p.after,plan.next.records,plan.next.tableSchema,plan.next.customFields).title,['status','nextAction','notes','dueDate'].filter(field=>p.before[field]!==p.after[field]).map(field=>diff({field,before:p.before[field],after:p.after[field]})).join(''))).join('');
    const goals=[...new Set(plan.goals.map(g=>g.stepIds.map(id=>summary(plan.review.find(s=>s.id===id))).join('; ')))];
    const unmapped=(plan.unmappedFacts||[]).length?'<h3>Facts needing a destination</h3>'+plan.unmappedFacts.map(f=>section(f.text,`<p>${esc(f.reason)}</p><blockquote>${esc(f.source)}</blockquote>`)).join(''):'';
    return `<h3>Complete workspace plan</h3><p>One confirmation: ${plan.addedFields.length} new columns, ${plan.patches.length} changed records, ${plan.addedCards.length} new tasks, ${plan.taskPatches.length} updated tasks.</p><h3>Requested outcomes</h3><ul>${goals.map(g=>`<li>${esc(g)}</li>`).join('')}</ul>${unmapped}<h3>Selection and steps</h3>${selections}${plan.calculations.length?'<h3>Date calculations</h3>'+plan.calculations.map(c=>`<p>${esc(c)}</p>`).join(''):''}<h3>Table changes</h3>${cells||'<p>No cell changes.</p>'}<h3>Task additions</h3>${cards||'<p>No new cards.</p>'}${edits?'<h3>Task edits</h3>'+edits:''}${plan.answers.length?'<h3>Calculated answers</h3>'+plan.answers.map(a=>`<p class="preserve-lines">${esc(a)}</p>`).join(''):''}<div class="proposal-actions"><button class="primary" data-confirm ${saving?'disabled':''}>Confirm entire plan</button><button class="secondary" data-cancel ${saving?'disabled':''}>Cancel entire plan</button></div>`;
  }
  return {responseSchema,prepare,dateValue,snapshot,render};
});
