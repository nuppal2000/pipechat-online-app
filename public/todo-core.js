(function(root,factory){
  const core=typeof module==='object'&&module.exports?require('./pipeline-core.js'):root.PipelineCore;
  const api=factory(core);if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatTodo=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Core){
  'use strict';
  const statuses=['To Do','In Progress','Done'];
  const keys=['id','recordId','status','nextAction','dueDate','nextField','followField','ownerField'];
  const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
  function validDate(v){if(v==='')return true;if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(v+'T00:00:00Z');return !isNaN(d)&&d.toISOString().slice(0,10)===v;}
  function validate(input,records,schema,custom=[]){
    if(input===undefined)return [];
    if(!Array.isArray(input)||input.length>2000)throw new Error('A To Do board supports up to 2,000 cards.');
    const fields=Core.create(schema).definitions(custom),ids=new Set(),recordIds=new Set(records.map(r=>r.id));
    return input.map(c=>{
      if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(c,k))||typeof c.id!=='string'||!/^todo_[a-z0-9_]{1,60}$/.test(c.id)||ids.has(c.id)||!Number.isSafeInteger(c.recordId)||!recordIds.has(c.recordId)||!statuses.includes(c.status)||!text(c.nextAction,500)||!validDate(c.dueDate))throw new Error('Invalid To Do card or missing linked record.');
      for(const key of ['nextField','followField','ownerField'])if(c[key]!==null&&!fields.some(f=>f.id===c[key]&&['text','choice',...(key==='followField'?['date']:[])].includes(f.type)))throw new Error('Invalid linked To Do field.');
      ids.add(c.id);return Object.fromEntries(keys.map(k=>[k,c[k]]));
    });
  }
  function reconcile(cards,records,schema,custom=[]){
    const ids=new Set(records.map(r=>r.id)),fields=Core.create(schema).definitions(custom);
    return validate((cards||[]).filter(c=>ids.has(c.recordId)).map(c=>({...c,...Object.fromEntries(['nextField','followField','ownerField'].map(k=>[k,fields.some(f=>f.id===c[k]&&['text','choice',...(k==='followField'?['date']:[])].includes(f.type))?c[k]:null]))})),records,schema,custom);
  }
  function bindings(schema,custom=[]){
    const C=Core.create(schema),defs=C.definitions(custom),pick=(role,pattern,types)=>{
      const exact=role!=='none'&&defs.find(f=>f.id===C.role(role)&&types.includes(f.type));
      if(exact)return exact.id;
      const matches=defs.filter(f=>types.includes(f.type)&&pattern.test(Core.normalize(f.name)));return matches.length===1?matches[0].id:null;
    };
    return {nextField:pick('none',/^(next (action|step)|action item|follow[- ]?up (note|notes|action))s?$/,['text','choice']),followField:pick('followup',/^(follow[- ]?up( date| timing)?|due date|next contact date)$/,['text','choice','date']),ownerField:pick('owner',/^(owner|assigned rep|recruiter|contact( name)?|assignee)$/,['text','choice'])};
  }
  function create(id,recordId,schema,custom=[]){return {id,recordId,status:'To Do',nextAction:'',dueDate:'',...bindings(schema,custom)};}
  function project(card,records,schema,custom=[]){
    const C=Core.create(schema),record=records.find(r=>r.id===card.recordId);if(!record)throw new Error('The linked record no longer exists.');
    return {...card,title:String(record[C.role('primary')]||`Unnamed record #${record.id}`),owner:String(card.ownerField?record[card.ownerField]||'':''),nextAction:String(card.nextField?record[card.nextField]||'':card.nextAction),dueDate:String(card.followField?record[card.followField]||'':card.dueDate)};
  }
  function urgentChanges(before,after,cards,schema,custom=[]){
    const linked=new Set(cards.filter(c=>c.status!=='Done').map(c=>c.recordId));
    const fields=Core.create(schema).definitions(custom).filter(f=>['text','choice'].includes(f.type)&&/note|next|follow|action/i.test(f.name));
    return after.filter(row=>!linked.has(row.id)&&fields.some(f=>{
      const old=before.find(r=>r.id===row.id);if(!old||old[f.id]===row[f.id])return false;
      const value=Core.normalize(row[f.id]);
      return !/\b(no need|not needed|do not|don't|must not|need not|already|completed)\b/.test(value)&&/\b(need(s)? to follow[ -]?up|must follow[ -]?up|urgent(ly)?|asap)\b/.test(value);
    })).map(r=>r.id);
  }
  function plan(cards,records,schema,custom,action,newId){
    let next=validate(cards,records,schema,custom),before=null,after=null;
    if(action.action==='add_todo'){
      const selected=Core.create(schema).targets(records,action,false,custom);
      if(selected.candidates)return {clarification:{action,changeIndex:null,candidates:selected.candidates}};
      if(selected.records.length!==1)throw new Error('Choose one record for the To Do card.');
      after=create(newId,selected.records[0].id,schema,custom);
      if(action.todoStatus!=null)after.status=action.todoStatus;
      if(action.todoNextAction!=null){after.nextField=null;after.nextAction=action.todoNextAction;}
      if(action.todoDueDate!=null){after.followField=null;after.dueDate=action.todoDueDate;}
      next=[...next,after];
    }else{
      const selected=action.todoId?null:Core.create(schema).targets(records,action,false,custom);
      if(selected?.candidates)return {clarification:{action,changeIndex:null,candidates:selected.candidates}};
      const candidates=action.todoId?next.filter(c=>c.id===action.todoId):next.filter(c=>selected.records.some(r=>r.id===c.recordId));
      if(candidates.length!==1)throw new Error('Specify the card ID when a record has more than one card, or choose an existing card.');
      before=candidates[0];
      if(action.action==='delete_todo')next=next.filter(c=>c.id!==before.id);
      else if(action.action==='update_todo'){
        after={...before};if(action.todoStatus!=null)after.status=action.todoStatus;
        if(action.todoNextAction!=null){after.nextField=null;after.nextAction=action.todoNextAction;}
        if(action.todoDueDate!=null){after.followField=null;after.dueDate=action.todoDueDate;}
        next=next.map(c=>c.id===before.id?after:c);
      }else throw new Error('Unknown To Do action.');
    }
    return {kind:'todo',cards:validate(next,records,schema,custom),before,after,count:1,recordId:(after||before).recordId};
  }
  return {statuses,validate,reconcile,bindings,create,project,plan,urgentChanges,validDate};
});
