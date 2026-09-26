(function(root,factory){
  const api=typeof module==='object'&&module.exports?factory(require('./pipeline-core.js'),require('./report-engine.js'),require('./todo-core.js')):factory(root.PipelineCore,root.PipeChatReports,root.PipeChatTodo);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatPlan=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Core,Reports,Todo){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const fail=message=>{const error=new Error(message);error.clarification=true;throw error;};
  const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const str={type:'string'},scalar={type:['string','number']};
  function responseSchema(){
    const date=object({dateMode:{type:'string',enum:['literal','calendar_days','business_days']},date:{type:['string','null']},offset:{type:['integer','null']}});
    const condition=object({field:str,operator:{type:'string',enum:Reports.operators},value:{type:['string','number','null']},values:{type:'array',items:{type:['string','number','null']}}});
    const step=(op,properties)=>object({op:{type:'string',enum:[op]},id:str,label:str,...properties});
    return object({action:{type:'string',enum:['workspace_plan']},version:{type:'integer',enum:[1]},title:str,
      goals:{type:'array',minItems:1,maxItems:20,items:object({description:str,stepIds:{type:'array',minItems:1,items:str}})},
      steps:{type:'array',minItems:1,maxItems:30,items:{anyOf:[
        step('select_records',{source:str,where:{type:'array',items:{type:'array',items:condition}},orderBy:{type:['string','null']},direction:{type:'string',enum:['asc','desc']},limit:{type:['integer','null']}}),
        step('add_field',{name:str,type:{type:'string',enum:['text','choice','date']},options:{type:'array',items:str}}),
        step('update_records',{selection:str,assignments:{type:'array',minItems:1,maxItems:40,items:object({field:str,operation:{type:'string',enum:['set','append']},value:{anyOf:[scalar,date]}})}}),
        step('add_todos',{selection:str,status:{type:'string',enum:Todo.statuses},nextAction:str,notes:str,dueDate:{anyOf:[{type:'null'},date]}})
      ]}}
    });
  }
  function dateValue(spec,today){
    if(!spec||typeof spec!=='object'||Array.isArray(spec))fail('Please specify a complete date or an offset from today.');
    const core=Core.create(null),base=core.date(today);
    if(!base)fail('The current date is unavailable. Please specify an exact due date.');
    if(spec.dateMode==='literal'){
      if(!core.date(spec.date)||spec.offset!==null)fail('Please specify a complete, valid calendar date.');
      return {value:spec.date,explanation:'Date: '+spec.date};
    }
    if(!['calendar_days','business_days'].includes(spec.dateMode)||spec.date!==null||!Number.isInteger(spec.offset)||Math.abs(spec.offset)>366)fail('Choose a date offset of up to 366 days.');
    const business=spec.dateMode==='business_days',dates=[],direction=Math.sign(spec.offset);
    for(let left=Math.abs(spec.offset);left;){
      base.setUTCDate(base.getUTCDate()+direction);
      if(!business||![0,6].includes(base.getUTCDay())){left--;dates.push(base.toISOString().slice(0,10));}
    }
    const value=base.toISOString().slice(0,10);
    return {value,explanation:`${today} ${spec.offset<0?'-':'+'} ${Math.abs(spec.offset)} ${business?'business':'calendar'} days = ${value}${business?' (Monday-Friday; weekends skipped, holidays not excluded)':''}.${business&&dates.length<=10?' Counted: '+(dates.join(', ')||'today'):''}`};
  }
  function snapshot(workspace){return JSON.stringify([workspace.records,workspace.customFields,workspace.tableSchema,workspace.todoCards]);}
  function prepare(workspace,action,{today,nonce,now=Date.now()}={}){
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
      if(typeof goal?.description!=='string'||!goal.description.trim()||goal.description.length>1000||!Array.isArray(goal.stepIds)||!goal.stepIds.length||goal.stepIds.some(id=>!ids.has(id)))fail('Every requested outcome must refer to valid plan steps.');
      goal.stepIds.forEach(id=>covered.add(id));
    }
    if([...ids].some(id=>!covered.has(id)))fail('Some plan steps are not included in the requested-outcomes review.');
    const before=snapshot(workspace),next=clone(workspace),core=Core.create(next.tableSchema),selections=new Map(),fields=new Map(),review=[],calculations=new Set(),addedFields=[],addedCards=[];
    const resolve=reference=>{
      const id=reference?.startsWith('@')?fields.get(reference.slice(1)):reference;
      if(!core.definitions(next.customFields).some(field=>field.id===id))fail('A step refers to an unavailable field. Create the field first, then reference @step_id.');
      return id;
    };
    const selected=reference=>{if(!selections.has(reference))fail('Select records before using that selection in another step.');return selections.get(reference);};
    const materialize=value=>{
      if(value&&typeof value==='object'){const result=dateValue(value,today);calculations.add(result.explanation);return result.value;}
      if(!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))fail('Each edit needs a literal value. Use an empty string to explicitly clear a cell.');
      return value;
    };
    for(const [index,step]of action.steps.entries()){
      try{
        if(step.op==='select_records'){
          const rows=step.source==='all'?next.records:next.records.filter(row=>selected(step.source).includes(row.id));
          if(!Array.isArray(step.where))fail('Please supply the selection conditions.');
          const where=step.where.map(group=>{if(!Array.isArray(group))fail('Selection conditions must be grouped.');return group.map(condition=>({...condition,field:resolve(condition.field)}));});
          const spec={version:1,title:step.label,chart:'kpi',scope:'all',groupBy:null,bucket:'none',splitBy:null,measures:[{label:'Count',metric:'count',field:null,where:[]}],where,sort:'label_asc',limit:null};
          let matched=Reports.execute(rows,spec,core,next.customFields,{today}).rows.slice();
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
          review.push({id:step.id,label:step.label,op:step.op,matched:count,filter:Reports.describe(spec,core,next.customFields),source:step.source,order:orderField?`${orderField.name}, ${step.direction==='desc'?'highest first':'lowest first'}; ties by record ID`:'Saved row order',limit:step.limit,records:matched.map(row=>({id:row.id,name:String(row[core.role('primary')]||'Unnamed record #'+row.id),value:orderField?row[orderField.id]:null}))});
        }else if(step.op==='add_field'){
          if(!['text','choice','date'].includes(step.type)||!Array.isArray(step.options)||step.type!=='choice'&&step.options.length)fail('Choose a text, date or dropdown field with the appropriate options.');
          const field={id:`cf_${nonce}_${index}`,name:step.name,type:step.type,...(step.type==='choice'?{options:step.options}:{})};
          next.customFields=core.validateCustomFields([...next.customFields,field]);
          next.records=next.records.map(row=>({...row,[field.id]:''}));fields.set(step.id,field.id);addedFields.push(field);
          review.push({id:step.id,op:step.op,label:step.label,field});
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
        }else fail('That operation cannot be combined in this plan yet. Please clarify the complete request; no partial changes were prepared.');
      }catch(error){fail(`Step ${index+1} (${step.label}): ${error.message} The entire plan is unchanged.`);}
    }
    const definitions=core.definitions(next.customFields),patches=[];
    for(const row of next.records){const original=workspace.records.find(r=>r.id===row.id),changes=[];for(const f of definitions){const old=original[f.id]??'',value=row[f.id]??'';if(old!==value)changes.push({field:f.name,before:old,after:value});}if(changes.length)patches.push({id:row.id,name:String(row[core.role('primary')]||'Unnamed record #'+row.id),changes});}
    return {kind:'workspace-plan',title:action.title,goals:clone(action.goals),review,calculations:[...calculations],addedFields,addedCards,patches,next,before,count:patches.length,createdAt:now};
  }
  function render(plan,esc,saving){
    const text=value=>esc(value===''||value==null?'(blank)':String(value));
    return `<h3>${esc(plan.title)}</h3><p>One confirmation: ${plan.addedFields.length} new columns, ${plan.patches.length} changed records, ${plan.addedCards.length} new To Do cards.</p><h3>Requested outcomes</h3><ul>${plan.goals.map(g=>`<li>${esc(g.description)}</li>`).join('')}</ul><h3>Selection and steps</h3>${plan.review.map(step=>`<section class="proposal-record"><h3>${esc(step.label)}</h3>${step.op==='select_records'?`<p>${step.matched} matching; ${step.records.length} selected${step.limit!==null?' (limit '+step.limit+')':''}. ${esc(step.order)}</p><p>${esc(step.filter)}</p><p>Source: ${esc(step.source==='all'?'Entire table':step.source)}</p><ol>${step.records.map(r=>`<li>${esc(r.name)} (#${r.id})${r.value!==null&&r.value!==undefined?' / '+text(r.value):''}</li>`).join('')}</ol>`:step.op==='add_field'?`<p>Add ${esc(step.field.name)} / ${esc(step.field.type)}${step.field.options?' / '+step.field.options.map(esc).join(', '):''}. Other cells remain blank unless listed below.</p>`:`<p>${step.count} records${step.op==='update_records'?' / '+step.changes+' cell changes':' / '+step.count+' new cards'}${step.count===0?' (no matching records; no changes in this step)':''}.</p>`}</section>`).join('')}${plan.calculations.length?'<h3>Date calculations</h3>'+plan.calculations.map(c=>`<p>${esc(c)}</p>`).join(''):''}<h3>Table changes</h3>${plan.patches.map(p=>`<section class="proposal-record"><h3>${esc(p.name)} (#${p.id})</h3>${p.changes.map(c=>`<div class="field-diff"><span>${esc(c.field)}</span><div class="diff-values"><span class="diff-before">${text(c.before)}</span><span aria-label="to">&rarr;</span><span class="diff-after">${text(c.after)}</span></div></div>`).join('')}</section>`).join('')||'<p>No cell changes.</p>'}<h3>To Do additions</h3>${plan.addedCards.map(card=>`<section class="proposal-record"><h3>${esc(Todo.project(card,plan.next.records,plan.next.tableSchema,plan.next.customFields).title)}</h3><p>${esc(card.status)} / ${esc(card.nextAction)}</p><p>Due: ${text(card.dueDate)}</p>${card.notes?`<p>${esc(card.notes)}</p>`:''}</section>`).join('')||'<p>No new cards.</p>'}<div class="proposal-actions"><button class="primary" data-confirm ${saving?'disabled':''}>Confirm entire plan</button><button class="secondary" data-cancel ${saving?'disabled':''}>Cancel entire plan</button></div>`;
  }
  return {responseSchema,prepare,dateValue,snapshot,render};
});
