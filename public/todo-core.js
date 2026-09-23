(function(root,factory){
  const core=typeof module==='object'&&module.exports?require('./pipeline-core.js'):root.PipelineCore;
  const api=factory(core);if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatTodo=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Core){
  'use strict';
  const statuses=['To Do','In Progress','Done'],keys=['id','recordId','status','nextAction','notes','dueDate'];
  const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
  function validDate(v){if(v==='')return true;if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v.startsWith('0000-'))return false;const d=new Date(v+'T00:00:00Z');return !isNaN(d)&&d.toISOString().slice(0,10)===v;}
  function validate(input,records){
    if(input===undefined)return [];
    if(!Array.isArray(input)||input.length>2000)throw new Error('A To Do board supports up to 2,000 cards.');
    const ids=new Set(),recordIds=new Set(records.map(r=>r.id));
    return input.map(c=>{
      if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(c,k))||typeof c.id!=='string'||!/^todo_[a-z0-9_]{1,60}$/.test(c.id)||ids.has(c.id)||!Number.isSafeInteger(c.recordId)||!recordIds.has(c.recordId)||!statuses.includes(c.status)||!text(c.nextAction,12000)||!text(c.notes,16000)||!validDate(c.dueDate))throw new Error('Invalid To Do card. Reload the app or check its linked record, text and date.');
      ids.add(c.id);return Object.fromEntries(keys.map(k=>[k,c[k]]));
    });
  }
  function reconcile(cards,records){const ids=new Set(records.map(r=>r.id));return validate((cards||[]).filter(c=>ids.has(c.recordId)),records);}
  // One-time local JSON upgrade. Hosted cards are frozen by migration 007.
  function migrate(cards,records){return reconcile((cards||[]).map(c=>{
    if(Object.hasOwn(c,'notes'))return c;
    const row=records.find(r=>r.id===c.recordId),action=String(c.nextField?row?.[c.nextField]||'':c.nextAction||''),due=String(c.followField?row?.[c.followField]||'':c.dueDate||'');
    return {id:c.id,recordId:c.recordId,status:c.status,nextAction:action,notes:validDate(due)?'':`Previous due information: ${due}`,dueDate:validDate(due)?due:''};
  }),records);}
  function create(id,recordId){return {id,recordId,status:'To Do',nextAction:'',notes:'',dueDate:''};}
  function project(card,records,schema){
    const C=Core.create(schema),record=records.find(r=>r.id===card.recordId);if(!record)throw new Error('The linked record no longer exists.');
    return {...card,title:String(record[C.role('primary')]||`Unnamed record #${record.id}`)};
  }
  function plan(cards,records,schema,custom,action,newId){
    let next=validate(cards,records),before=null,after=null;
    if(action.action==='add_todo'){
      const selected=Core.create(schema).targets(records,action,false,custom);
      if(selected.candidates)return {clarification:{action,changeIndex:null,candidates:selected.candidates}};
      if(selected.records.length!==1)throw new Error('Choose one record for the To Do card.');
      after=create(newId,selected.records[0].id);next=[...next,after];
    }else{
      const selected=action.todoId?null:Core.create(schema).targets(records,action,false,custom);
      if(selected?.candidates)return {clarification:{action,changeIndex:null,candidates:selected.candidates}};
      const candidates=action.todoId?next.filter(c=>c.id===action.todoId):next.filter(c=>selected.records.some(r=>r.id===c.recordId));
      if(candidates.length!==1)throw new Error('Specify the card ID when a record has more than one card, or choose an existing card.');
      before=candidates[0];
      if(action.action==='delete_todo')next=next.filter(c=>c.id!==before.id);
      else if(action.action==='update_todo'){after={...before};next=next.map(c=>c.id===before.id?after:c);}
      else throw new Error('Unknown To Do action.');
    }
    if(after)for(const [key,prop]of [['todoStatus','status'],['todoNextAction','nextAction'],['todoNotes','notes'],['todoDueDate','dueDate']])if(action[key]!=null)after[prop]=action[key];
    return {kind:'todo',cards:validate(next,records),before,after,count:1,recordId:(after||before).recordId};
  }
  return {statuses,validate,reconcile,migrate,create,project,plan,validDate};
});
