(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatInspector=api;
})(typeof window==='object'?window:this,function(){
  'use strict';
  const maxNote=6000;
  function day(value){const d=value instanceof Date?value:new Date(value);return Number.isFinite(d.getTime())?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';}
  function parse(raw,index=0){
    const text=String(raw);let entry;
    try{entry=JSON.parse(text);}catch{}
    if(entry?.pipechatHistory===1&&entry.type==='note'&&typeof entry.text==='string'&&typeof entry.actor==='string'&&typeof entry.id==='string'&&typeof entry.at==='string'&&Number.isFinite(Date.parse(entry.at))){
      return {type:'note',id:entry.id,at:entry.at,time:Date.parse(entry.at),actor:entry.actor,text:entry.text,index};
    }
    const match=/^(\d{4}-\d\d-\d\dT[^|]+?)\s*\|\s*([\s\S]*)$/.exec(text);
    const at=match&&Number.isFinite(Date.parse(match[1]))?match[1]:null;
    return {type:'activity',at,time:at?Date.parse(at):null,text:at?match[2]:text,index};
  }
  function entries(history,{from='',to='',kind='all'}={}){
    for(const value of [from,to])if(value&&(!/^\d{4}-\d\d-\d\d$/.test(value)||day(new Date(value+'T12:00:00'))!==value))throw new Error('Choose a valid date.');
    if(from&&to&&from>to)throw new Error('The start date must be on or before the end date.');
    return (history||[]).map(parse).filter(e=>(kind==='all'||e.type===kind)&&(!from&&!to||e.at&&(!from||day(e.at)>=from)&&(!to||day(e.at)<=to))).sort((a,b)=>(b.time??-Infinity)-(a.time??-Infinity)||a.index-b.index);
  }
  function displayText(entry){
    if(entry.type==='note')return entry.text;
    // Only remove the actor prefix from the app's dated legacy event formats.
    const match=entry.at&&/^.+?: ([\s\S]+ changed from "[\s\S]*" to "[\s\S]*"\.|Deal added(?: manually)?\.)$/.exec(entry.text);
    return match?match[1]:entry.text;
  }
  function activity(records,filters={}){
    entries([],filters);
    return records.flatMap(record=>entries(record.history,filters).map(entry=>({...entry,recordId:record.id}))).sort((a,b)=>(b.time??-Infinity)-(a.time??-Infinity));
  }
  function query(records,primary,{kind='all',from=null,to=null,limit=100,timezone='UTC'}={}){
    if(!['all','note','activity'].includes(kind)||!Number.isInteger(limit)||limit<1||limit>500)throw new Error('Choose notes, activity or all history, with a limit from 1 to 500.');
    for(const value of [from,to])if(value!==null&&(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)))throw new Error('Choose a complete history date.');
    entries([],{from:from||'',to:to||''});
    const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
    const localDay=at=>{const parts=Object.fromEntries(calendar.formatToParts(new Date(at)).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}`;};
    const matched=records.flatMap(record=>entries(record.history,{kind}).filter(entry=>{
      if(!from&&!to)return true;
      if(!entry.at)return false;
      const date=localDay(entry.at);return (!from||date>=from)&&(!to||date<=to);
    }).map(entry=>({recordId:record.id,name:String(record[primary]||'Unnamed record #'+record.id),type:entry.type,at:entry.at,text:displayText(entry),index:entry.index})))
      .sort((a,b)=>(b.at?Date.parse(b.at):-Infinity)-(a.at?Date.parse(a.at):-Infinity)||a.recordId-b.recordId||a.index-b.index);
    const clip=(value,max)=>{
      if(value.length<=max)return value;
      const suffix=' [truncated by the per-entry limit]';
      let end=max-suffix.length;
      if(/[\uD800-\uDBFF]/.test(value[end-1]))end--;
      return value.slice(0,end)+suffix;
    };
    const shown=[],lines=[];let size=0;
    for(const entry of matched.slice(0,limit)){
      const bounded={...entry,name:clip(entry.name,400),text:clip(entry.text,6000),
        at:entry.at&&entry.at.length>128?new Date(entry.at).toISOString():entry.at};
      if(bounded.name!==entry.name||bounded.text!==entry.text)bounded.truncated=true;
      const line=`- ${bounded.name} (#${bounded.recordId}) / ${bounded.at||'Date not recorded'} / ${bounded.type==='note'?'Note':'Activity'}: ${bounded.text}`;
      if(size+line.length+1>24000)break;
      shown.push(bounded);lines.push(line);size+=line.length+1;
    }
    const omitted=matched.length-shown.length,truncated=shown.filter(entry=>entry.truncated).length;
    return {recordIds:records.map(row=>row.id),kind,timezone,from,to,total:matched.length,entries:shown,omitted,truncated,
      answer:`Saved ${kind==='note'?'notes':kind==='activity'?'activity':'history'}: ${matched.length} entries across ${records.length} selected records. Newest first; date filters use ${timezone}.\n`+
        (lines.join('\n')||'No entries shown.')+(truncated?`\n${truncated} shown entries contain text or names truncated by the per-entry limit. Open the record history to inspect the full entries.`:'')+
        (omitted?`\nShowing ${shown.length} of ${matched.length} entries; ${omitted} omitted by the response limit. Narrow the date range to inspect more.`:'')+'\nNo changes were made.'};
  }
  function addNote(records,id,text,actor,noteId,now=new Date()){
    if(typeof text!=='string'||!text.trim())throw new Error('Enter a note first.');
    if(text.length>maxNote)throw new Error(`Notes can contain up to ${maxNote} characters.`);
    if(!records.some(r=>r.id===id))throw new Error('This record no longer exists.');
    const note=JSON.stringify({pipechatHistory:1,type:'note',id:noteId,at:now.toISOString(),actor:String(actor||''),text:text.trim()});
    return records.map(row=>{
      if(row.id!==id)return row;
      if((row.history||[]).some(item=>{const e=parse(item);return e.type==='note'&&e.id===noteId;}))return row;
      if((row.history||[]).length>=10000)throw new Error('This record has reached its history limit. Export or archive its history before adding more.');
      return {...row,history:[note,...row.history||[]]};
    });
  }
  // Undo restores cells, not the historical record of what already happened.
  function reconcile(before,next,oldFields,newFields,actor,now=new Date()){
    const previous=new Map(before.map(r=>[r.id,r])),fields=new Map([...oldFields,...newFields].map(f=>[f.id,f.name]));
    return next.map(row=>{
      const old=previous.get(row.id);if(!old)return row;
      const counts=new Map();for(const item of old.history||[])counts.set(item,(counts.get(item)||0)+1);
      const fresh=(row.history||[]).filter(item=>{const count=counts.get(item)||0;if(count){counts.set(item,count-1);return false;}return true;});
      const changes=[];
      if(!fresh.some(item=>parse(item).type==='activity'))for(const [id,label] of fields){
        const a=old[id]??'',b=row[id]??'';
        if(a!==b)changes.push(`${now.toISOString()} | ${actor}: ${label} changed from "${a}" to "${b}".`);
      }
      const history=[...changes,...fresh,...old.history||[]];
      if(history.length>10000||history.some(item=>item.length>32768))throw new Error('This change exceeds the record history limit. No history was discarded.');
      return {...row,history};
    });
  }
  return {maxNote,day,parse,entries,displayText,activity,query,addNote,reconcile};
});
