(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatNotifications=api;
})(typeof window==='object'?window:this,function(){
  'use strict';
  const dayMs=86400000;
  function day(value){
    const text=String(value||'').trim();if(!/^\d{4}-\d\d-\d\d$/.test(text))return null;
    const time=Date.parse(text+'T00:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===text?time:null;
  }
  function due(value,today){
    const key=String(value||'').trim().toLowerCase();
    if(key==='today')return day(today);if(key==='tomorrow')return day(today)+dayMs;
    // Do not invent a specific day for imprecise values such as "next week".
    return day(value);
  }
  function collect({records=[],cards=[],core,customFields=[],today,history}){
    const now=day(today);if(now===null)return [];
    const defs=core.definitions(customFields),primary=core.role('primary'),status=core.role('status'),follow=core.role('followup');
    const dates=defs.filter(f=>f.id===follow||f.type==='date'&&/\b(?:follow.?up|reminder|appointment|interview|renewal|deadline|due)\b/i.test(f.name));
    const contacts=defs.filter(f=>f.type==='date'&&/\b(?:last contacted|last contact|last activity)\b/i.test(f.name));
    const items=[],names=new Map(records.map(r=>[r.id,String(r[primary]??'').trim()||'Unnamed record #'+r.id]));
    const group=time=>time<now?'overdue':time===now?'today':time<=now+7*dayMs?'upcoming':null;
    const stamp=time=>new Date(time).toISOString().slice(0,10);
    for(const card of cards){
      if(card.status==='Done'||card.recordId!==null&&!names.has(card.recordId))continue;
      const time=day(card.dueDate),section=time===null?null:group(time);if(!section)continue;
      items.push({key:'task:'+card.id,kind:'task',id:card.id,title:card.recordId===null?card.customTitle:names.get(card.recordId),detail:card.nextAction||'Task',date:stamp(time),section});
    }
    for(const row of records){
      if(/^(?:(?:closed[ -])?(?:won|lost)|done|completed|rejected|hired|cancelled|canceled)$/i.test(String(row[status]||'').trim()))continue;
      let scheduled=false;
      for(const field of dates){
        const time=due(row[field.id],today),section=time===null?null:group(time);if(time!==null)scheduled=true;if(!section)continue;
        items.push({key:`record:${row.id}:${field.id}`,kind:'record',id:row.id,field:field.id,title:names.get(row.id),detail:field.name,date:stamp(time),section});
      }
      const times=(row.history||[]).map(raw=>history?.parse(raw)?.time).filter(t=>Number.isFinite(t));
      for(const field of contacts){const time=day(row[field.id]);if(time!==null)times.push(time);}
      const latest=times.length?Math.max(...times):null;
      if(!scheduled&&latest!==null&&latest<=now-14*dayMs){
        items.push({key:'stale:'+row.id,kind:'record',id:row.id,field:null,title:names.get(row.id),detail:'No recorded activity for '+Math.floor((now-latest)/dayMs)+' days; no dated reminder',date:stamp(latest),section:'stale'});
      }
    }
    const order={overdue:0,today:1,upcoming:2,stale:3};
    return items.sort((a,b)=>order[a.section]-order[b.section]||a.date.localeCompare(b.date)||String(a.title).localeCompare(String(b.title))||a.key.localeCompare(b.key));
  }
  return {day,due,collect};
});
