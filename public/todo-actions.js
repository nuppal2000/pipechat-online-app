(function(root,factory){
  const T=typeof module==='object'&&module.exports?require('./todo-core.js'):root.PipeChatTodo;
  const api=factory(T);if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatTodoActions=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(T){
  'use strict';
  const fields=['title','status','nextAction','notes','dueDate'];
  const operators=['equals','not_equals','in','not_in','contains','starts_with','is_blank','is_not_blank','before','after'];
  const editable=['status','nextAction','notes','dueDate'];
  const norm=v=>String(v??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
  const fail=message=>{throw new Error(message);};
  const obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(v,k));
  const str=(v,max=16000)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
  function actionSchemas(focus=null){
    const conditions={type:'array',maxItems:12,items:obj({field:{type:'string',enum:fields},operator:{type:'string',enum:operators},value:{type:['string','null']},values:{type:'array',maxItems:2000,items:{type:'string'}}})};
    const ids={type:'array',maxItems:2000,items:{type:'string'}},emptyIds={...ids,maxItems:0};
    const variants=[obj({source:{type:'string',enum:['all']},ids:emptyIds,focusId:{type:'null'},conditions}),obj({source:{type:'string',enum:['ids']},ids:{...ids,minItems:1},focusId:{type:'null'},conditions})];
    // Bind model references to this request's saved selection; never ask it to invent or retype an ID.
    if(focus?.kind==='todos'&&str(focus.id,100)&&focus.id&&Array.isArray(focus.ids)&&focus.ids.length<=2000)variants.push(obj({source:{type:'string',enum:['focus']},ids:emptyIds,focusId:{type:'string',enum:[focus.id]},conditions}));
    const selection={anyOf:variants};
    return [obj({action:{type:'string',enum:['query_todos']},selection}),obj({action:{type:'string',enum:['update_todos']},updates:{type:'array',minItems:1,maxItems:200,items:obj({selection,changes:{type:'array',minItems:1,maxItems:4,items:obj({field:{type:'string',enum:editable},operation:{type:'string',enum:['set','append']},value:{type:'string'}})}})}})];
  }
  function select(cards,records,schema,selection,focus=null){
    const all=T.validate(cards,records);
    if(!exact(selection,['source','ids','focusId','conditions'])||!['all','focus','ids'].includes(selection.source)||!Array.isArray(selection.ids)||selection.ids.length>2000||!Array.isArray(selection.conditions)||selection.conditions.length>12)fail('Please specify the complete card selection.');
    let ids=null;
    if(selection.source==='focus'){
      if(selection.ids.length||!focus||focus.kind!=='todos'||!str(focus.id,100)||!selection.focusId||selection.focusId!==focus.id||!Array.isArray(focus.ids)||focus.ids.length>2000)fail('Which cards do you mean? Please list or select them again; the previous card selection is unavailable.');
      ids=focus.ids;
    }else{
      if(selection.focusId!==null)fail('A new card selection must not reuse a previous selection reference.');
      if(selection.source==='ids'){if(!selection.ids.length)fail('Please identify the cards to edit.');ids=selection.ids;}
      else if(selection.ids.length)fail('Choose all matching cards or explicit IDs, not both.');
    }
    if(ids&&(new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!all.some(c=>c.id===id))))fail('A previously selected card no longer exists. Please select the cards again; no partial changes were made.');
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
  function plan(cards,records,schema,action,focus=null){
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
      if(!matches.length)fail('No cards match that selection. Please check the conditions; no partial changes were made.');
      for(const card of matches){
        selectedIds.add(card.id);const patch=writes.get(card.id)||{};
        for(const {field,operation,value}of item.changes){
          if(Object.hasOwn(patch,field))fail('Two edits target the same card field. Which value should it have? No cards were changed.');
          patch[field]=operation==='append'?[card[field],value].filter(Boolean).join('\n'):value;
        }
        writes.set(card.id,patch);
      }
    }
    const next=T.validate(all.map(card=>({...card,...writes.get(card.id)})),records),updates=[];
    for(const after of next){const before=byId.get(after.id),changes=editable.filter(field=>before[field]!==after[field]);if(changes.length)updates.push({before,after,fields:changes});}
    if(!updates.length)fail('Every selected card already has the requested values. No changes are needed.');
    return {kind:'todo',cards:next,updates,selectedIds:[...selectedIds],selectedCount:selectedIds.size,count:updates.length,before:null,after:null,recordId:null};
  }
  function remember(matches,id){return {kind:'todos',id,ids:matches.map(c=>c.id)};}
  function describe(matches,records,schema){
    if(!matches.length)return 'No To Do cards match those conditions. No cards were changed.';
    return `${matches.length} matching To Do ${matches.length===1?'card':'cards'}:\n`+matches.map(c=>{const v=T.project(c,records,schema);return `- ${v.title} - ${v.nextAction||'No To Do text'} (${v.status}); due ${v.dueDate||'not set'}`;}).join('\n')+'\nNo cards were changed.';
  }
  return {actionSchemas,select,plan,remember,describe};
});
