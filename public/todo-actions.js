(function(root,factory){
  const T=typeof module==='object'&&module.exports?require('./todo-core.js'):root.PipeChatTodo;
  const C=typeof module==='object'&&module.exports?require('./pipeline-core.js'):root.PipelineCore;
  const R=typeof module==='object'&&module.exports?require('./report-engine.js'):root.PipeChatReports;
  const api=factory(T,C,R);if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatTodoActions=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(T,Core,Reports){
  'use strict';
  const fields=['title','status','nextAction','notes','dueDate'];
  const operators=['equals','not_equals','in','not_in','contains','starts_with','is_blank','is_not_blank','before','after'];
  const editable=['status','nextAction','notes','dueDate'];
  const norm=v=>String(v??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
  const fail=(message,reasonCode='task_validation')=>{const error=new Error(message);error.reasonCode=reasonCode;throw error;};
  const obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(v,k));
  const str=(v,max=16000)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
  const queryProofs=new WeakMap();
  const querySnapshot=(cards,records,schema,custom)=>JSON.stringify({cards,records,schema,custom});
  const queryValue=value=>JSON.stringify(['kind','result','count','cards','records','linkedRecordIds','answer','taskReadEvidence'].map(k=>value[k]));
  const queryInstructions='Task reads keep linked-record conditions separate from card conditions. Use source linked_records and where for conditions on CRM fields, including the primary name and account follow-up date. Cards join those rows by recordId; a task title/notes mentioning an account is not a relationship. Use conditions for status, dueDate, nextAction or task notes. Overdue tasks have a nonblank dueDate before the current local date AND status not_equals Done. A CRM follow-up date never substitutes for card dueDate. Use result records for which accounts have matching tasks (deduplicated by record ID); use result tasks for the tasks themselves. Both are read-only and evaluated over the entire saved board, not just visible cards or a sampled model list.';
  function actionSchemas(focus=null,core=null,custom=[]){
    const conditions={type:'array',maxItems:12,items:obj({field:{type:'string',enum:fields},operator:{type:'string',enum:operators},value:{type:['string','null']},values:{type:'array',maxItems:2000,items:{type:'string'}}})};
    const ids={type:'array',maxItems:2000,items:{type:'string'}},emptyIds={...ids,maxItems:0};
    const variants=[obj({source:{type:'string',enum:['all']},ids:emptyIds,focusId:{type:'null'},conditions}),obj({source:{type:'string',enum:['ids']},ids:{...ids,minItems:1},focusId:{type:'null'},conditions}),
      obj({source:{type:'string',enum:['references']},references:{type:'array',minItems:1,maxItems:200,items:obj({taskName:{type:['string','null']},recordName:{type:['string','null']}})},conditions})];
    // Bind model references to this request's saved selection; never ask it to invent or retype an ID.
    if(focus?.kind==='todos'&&str(focus.id,100)&&focus.id&&Array.isArray(focus.ids)&&focus.ids.length<=2000)variants.push(obj({source:{type:'string',enum:['focus']},ids:emptyIds,focusId:{type:'string',enum:[focus.id]},conditions}));
    const selection={anyOf:variants},readVariants=[...variants];
    if(core)readVariants.push(obj({source:{type:'string',enum:['linked_records']},where:linkedWhereSchema(core,custom),conditions}));
    const read=obj({action:{type:'string',enum:['query_todos'],description:queryInstructions},selection:{anyOf:readVariants},...(core?{result:{type:'string',enum:['tasks','records']}}:{})});
    return [read,obj({action:{type:'string',enum:['update_todos']},updates:{type:'array',minItems:1,maxItems:200,items:obj({selection,changes:{type:'array',minItems:1,maxItems:4,items:obj({field:{type:'string',enum:editable},operation:{type:'string',enum:['set','append']},value:{type:'string'}})}})}})];
  }
  function linkedWhereSchema(core,custom=[]){
    const where=Core.clone(Reports.responseSchema(core,custom).anyOf[1].properties.where);
    where.items.items.properties.operator.enum=where.items.items.properties.operator.enum.filter(op=>!['before_today','older_than_days'].includes(op));
    return where;
  }
  function linkedRows(records,schema,where,custom=[]){
    const core=Core.create(schema),defs=new Map(core.definitions(custom).map(f=>[f.id,f]));
    Reports.filteringRefinement({action:'filter_records',target:'pipeline_table',mode:'add_filter',where,removeFields:[]});
    for(const c of where.flat()){
      const field=defs.get(c.field),blank=['is_blank','is_not_blank'].includes(c.operator);
      if(!field||['before_today','older_than_days'].includes(c.operator))fail('Use a current CRM field and an explicit date in the linked-record selection.');
      if(blank){if(c.value!==null||c.values.length)fail('Blank linked-record conditions cannot contain a comparison value.');continue;}
      const literals=['in','not_in','between'].includes(c.operator)?c.values:[c.value];
      if(literals.some(value=>['number','currency'].includes(field.type)?typeof value!=='number'||!Number.isFinite(value):field.type==='date'?typeof value!=='string'||!value||!T.validDate(value):!str(value)||!value.trim()))fail('Linked-record comparisons must use the current column type and a complete literal value.');
    }
    return Reports.queryRecords(records,{action:'query_records',where,orderBy:null,direction:null},core,custom).rows;
  }
  function select(cards,records,schema,selection,focus=null,{customFields=[]}={}){
    const all=T.validate(cards,records);
    if(selection?.source==='linked_records'){
      if(!exact(selection,['source','where','conditions']))fail('Keep CRM field conditions in where and task conditions in conditions.');
      const ids=new Set(linkedRows(records,schema,selection.where,customFields).map(r=>r.id));
      // Join by saved record ID, never by card text or a duplicated display name.
      const matching=select(all,records,schema,{source:'all',ids:[],focusId:null,conditions:selection.conditions},focus,{customFields});
      return matching.filter(card=>card.recordId!==null&&ids.has(card.recordId));
    }
    if(selection?.source==='references'){
      if(!exact(selection,['source','references','conditions'])||!Array.isArray(selection.references)||!selection.references.length||selection.references.length>200)fail('Please identify each task by its task text or linked record name.');
      const resolved=[];
      for(const reference of selection.references){
        if(!exact(reference,['taskName','recordName'])||[reference.taskName,reference.recordName].some(v=>v!==null&&(!str(v)||!v.trim()))||!reference.taskName&&!reference.recordName)fail('A task reference needs its task text or linked record name.');
        const matches=all.filter(card=>{const view=T.project(card,records,schema);return (!reference.taskName||norm(card.nextAction)===norm(reference.taskName))&&(!reference.recordName||norm(view.title)===norm(reference.recordName));});
        if(matches.length!==1)fail(matches.length?`More than one task matches ${reference.taskName||reference.recordName}. Please choose a task; no cards were changed.`:`No task matches ${reference.taskName||reference.recordName}. Please check its task text and linked record; no cards were changed.`,matches.length?'task_reference_ambiguous':'task_reference_missing');
        resolved.push(matches[0].id);
      }
      return select(all,records,schema,{source:'ids',ids:[...new Set(resolved)],focusId:null,conditions:selection.conditions},focus,{customFields});
    }
    if(!exact(selection,['source','ids','focusId','conditions'])||!['all','focus','ids'].includes(selection.source)||!Array.isArray(selection.ids)||selection.ids.length>2000||!Array.isArray(selection.conditions)||selection.conditions.length>12)fail('Please specify the complete card selection.');
    let ids=null;
    if(selection.source==='focus'){
      if(selection.ids.length||!focus||focus.kind!=='todos'||!str(focus.id,100)||!selection.focusId||selection.focusId!==focus.id||!Array.isArray(focus.ids)||focus.ids.length>2000)fail('Which cards do you mean? Please list or select them again; the previous card selection is unavailable.','task_focus_unavailable');
      ids=focus.ids;
    }else{
      if(selection.focusId!==null)fail('A new card selection must not reuse a previous selection reference.');
      if(selection.source==='ids'){if(!selection.ids.length)fail('Please identify the cards to edit.');ids=selection.ids;}
      else if(selection.ids.length)fail('Choose all matching cards or explicit IDs, not both.');
    }
    if(ids&&(new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!all.some(c=>c.id===id))))fail('A previously selected card no longer exists. Please select the cards again; no partial changes were made.','task_selection_stale');
    const predicates=selection.conditions.map(c=>{
      if(!exact(c,['field','operator','value','values'])||!fields.includes(c.field)||!operators.includes(c.operator)||!Array.isArray(c.values)||c.values.length>2000)fail('That card condition is not supported. Please clarify the selection.');
      const blank=['is_blank','is_not_blank'].includes(c.operator),list=['in','not_in'].includes(c.operator);
      if(blank?(c.value!==null||c.values.length):list?(c.value!==null||!c.values.length||c.values.some(v=>!str(v)||!v.trim())):(!str(c.value)||!c.value.trim()||c.values.length))fail('Please supply the correct comparison value or list for the card condition.');
      if(['before','after'].includes(c.operator)&&(c.field!=='dueDate'||!T.validDate(c.value)))fail('Card date comparisons need a complete calendar date.');
      if(c.field==='status'&&!blank){const values=list?c.values:[c.value];if(values.some(v=>!T.statuses.some(s=>norm(s)===norm(v))))fail('Choose To Do, In Progress or Done as the board status.');}
      return view=>{
        const value=norm(view[c.field]),wanted=norm(c.value),values=c.values.map(norm);
        switch(c.operator){case'is_blank':return !value;case'is_not_blank':return !!value;case'equals':return value===wanted;case'not_equals':return value!==wanted;case'in':return values.includes(value);case'not_in':return !values.includes(value);case'contains':return value.includes(wanted);case'starts_with':return value.startsWith(wanted);case'before':return !!value&&value<wanted;case'after':return !!value&&value>wanted;default:return false;}
      };
    });
    const selected=ids?new Set(ids):null;
    return all.filter(c=>(!selected||selected.has(c.id))&&predicates.every(test=>test(T.project(c,records,schema))));
  }
  function plan(cards,records,schema,action,focus=null,{allowUnchanged=false}={}){
    if(!exact(action,['action','updates'])||action.action!=='update_todos'||!Array.isArray(action.updates)||!action.updates.length||action.updates.length>200)fail('Provide all requested card edits in one review.');
    const all=T.validate(cards,records),byId=new Map(all.map(c=>[c.id,c])),selectedIds=new Set(),writes=new Map();
    // Every selector uses the same original snapshot; earlier edits cannot shrink a later cohort.
    for(const item of action.updates){
      if(!exact(item,['selection','changes'])||!Array.isArray(item.changes)||!item.changes.length||item.changes.length>4)fail('A card edit needs at least one supported field change.');
      const seen=new Set();
      for(const change of item.changes){
        if(!exact(change,['field','operation','value'])||!editable.includes(change.field)||!['set','append'].includes(change.operation)||!str(change.value)||seen.has(change.field)||change.operation==='append'&&!['notes','nextAction'].includes(change.field))fail('Choose each card field once, with a valid value. Only card text can be appended.');
        seen.add(change.field);
      }
      const matches=select(all,records,schema,item.selection,focus);
      if(!matches.length)fail('No cards match that selection. Please check the conditions; no partial changes were made.','task_selection_empty');
      for(const card of matches){
        selectedIds.add(card.id);const patch=writes.get(card.id)||{};
        for(const {field,operation,value}of item.changes){
          if(Object.hasOwn(patch,field))fail(`Two edits target the same card field ${field} on task ${card.id} (${card.nextAction||T.project(card,records,schema).title}). Resolve the task references independently or clarify conflicting values. No cards were changed.`,'task_write_conflict');
          patch[field]=operation==='append'?[card[field],value].filter(Boolean).join('\n'):value;
        }
        writes.set(card.id,patch);
      }
    }
    const next=T.validate(all.map(card=>({...card,...writes.get(card.id)})),records),updates=[];
    for(const after of next){const before=byId.get(after.id),changes=editable.filter(field=>before[field]!==after[field]);if(changes.length)updates.push({before,after,fields:changes});}
    if(!updates.length&&!allowUnchanged)fail('Every selected card already has the requested values. No changes are needed.','task_no_changes');
    return {kind:'todo',cards:next,updates,selectedIds:[...selectedIds],selectedCount:selectedIds.size,count:updates.length,before:null,after:null,recordId:null};
  }
  function remember(matches,id){return {kind:'todos',id,ids:matches.map(c=>c.id)};}
  function describe(matches,records,schema){
    if(!matches.length)return 'No tasks match those conditions. No cards were changed.';
    return `${matches.length} matching ${matches.length===1?'task':'tasks'}:\n`+matches.map(c=>{const v=T.project(c,records,schema);return `- ${v.title} - ${v.nextAction||'No task text'} (${v.status}); due ${v.dueDate||'not set'}`;}).join('\n')+'\nNo cards were changed.';
  }
  function query(cards,records,schema,action,focus=null,options={}){
    const keys=action&&Object.hasOwn(action,'result')?['action','selection','result']:['action','selection'];
    if(!exact(action,keys)||action.action!=='query_todos'||action.result!==undefined&&!['tasks','records'].includes(action.result))fail('Supply a complete read-only task query.');
    const matches=select(cards,records,schema,action.selection,focus,options),result=action.result||'tasks';
    const views=matches.map(card=>T.project(card,records,schema)),ids=new Set(matches.map(c=>c.recordId).filter(id=>id!==null));
    const core=Core.create(schema),primary=core.role('primary'),linked=records.filter(r=>ids.has(r.id));
    let answer=describe(matches,records,schema);
    if(result==='records'){
      if(matches.some(c=>c.recordId===null))fail('A record relationship cannot include standalone tasks. Use a linked-record selection.');
      const defs=new Map(core.definitions(options.customFields||[]).map(f=>[f.id,f]));
      const shownFields=[...new Set((action.selection.where||[]).flat().map(c=>c.field))].filter(id=>id!==primary);
      answer=linked.length?`${linked.length} matching linked ${linked.length===1?'record':'records'} (${matches.length} matching ${matches.length===1?'task':'tasks'}):\n`+linked.map(row=>{
        const details=shownFields.map(id=>`${defs.get(id).name}: ${row[id]??'not set'}`);
        const tasks=views.filter(c=>c.recordId===row.id).map(c=>`${c.nextAction||'No task text'} (${c.status}); due ${c.dueDate||'not set'}`);
        return `- ${String(row[primary]??'').trim()||`Unnamed record #${row.id}`}: ${[...details,...tasks].join('; ')}`;
      }).join('\n')+'\nNo records or cards were changed.':'No linked records have tasks matching those conditions. No records or cards were changed.';
    }
    const notes=views.filter(card=>card.notes).map(card=>`- ${card.title} - ${card.nextAction||'No task text'}: ${card.notes}`);
    if(notes.length)answer+='\n\nSaved task notes:\n'+notes.join('\n');
    const proof={selection:Core.clone(action.selection),result,taskIds:matches.map(c=>c.id),recordIds:linked.map(r=>r.id)};
    const computed={kind:'task-read',result,count:result==='records'?linked.length:matches.length,cards:matches,records:views,
      linkedRecordIds:linked.map(r=>r.id),answer,taskReadEvidence:proof};
    queryProofs.set(proof,{action:JSON.stringify(action),value:queryValue(computed),
      snapshot:querySnapshot(cards,records,schema,options.customFields||[])});
    return computed;
  }
  function checkedQueryEvidence(computed,action,pipeline){
    const proof=computed?.taskReadEvidence,stored=proof&&queryProofs.get(proof);
    if(!stored||stored.action!==JSON.stringify(action)||stored.value!==queryValue(computed)||
      stored.snapshot!==querySnapshot(pipeline.todoCards,pipeline.records,pipeline.tableSchema,pipeline.customFields||[]))return null;
    return proof;
  }
  return {actionSchemas,select,plan,remember,describe,query,queryInstructions,linkedWhereSchema,linkedRows,checkedQueryEvidence};
});
