(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatUndoReview=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  // Presentation only. `changes` are already inverse changes from the journal.
  // sections() returns plain text; render() escapes it and adds no action buttons.
  const own=(value,key)=>value!=null&&Object.prototype.hasOwnProperty.call(value,key);
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const absent=()=>({exists:false});
  const slot=(value,key)=>own(value,key)?{exists:true,value:value[key]}:absent();
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const human=value=>String(value||'Setting').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
  const clip=(value,max=20000)=>{
    const text=String(value);return text.length<=max?text:text.slice(0,max)+'... ('+(text.length-max)+' more characters)';
  };
  const count=(n,singular,plural=singular+'s')=>n+' '+(n===1?singular:plural);
  function equal(a,b){
    if(a===b)return true;
    if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((value,i)=>equal(value,b[i]));
    if(object(a)&&object(b))return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>own(b,key)&&equal(a[key],b[key]));
    return false;
  }
  const legacy=[['account','Company','text','primary'],['stage','Stage','choice','status'],['value','Value','currency'],
    ['close','Close date','date'],['owner','Owner','text','owner'],['next','Next step','text'],['follow','Follow-up','text','followup'],['notes','Notes','text']]
    .map(([id,name,type,role='none'])=>({id,name,type,role}));
  const fieldTypes={text:'Text',number:'Number',currency:'Currency',date:'Date',choice:'Dropdown'};
  const taskLabels={recordId:'Linked record',customTitle:'Custom title',title:'Title',status:'Board status',nextAction:'Task',dueDate:'Due date',notes:'Notes'};
  const internalRecord=new Set(['id','health','activity']);
  const internalWorkflow=new Set(['id','version','revision','createdAt','updatedAt','activatedAt']);

  function context(proposal,workspace){
    const changes=Array.isArray(proposal?.changes)?proposal.changes:[];
    const schemaSlot=(key,side)=>changes.find(change=>change.path?.[0]==='schema'&&change.path[2]===key)?.[side]||slot(workspace,key);
    const definitions=side=>{
      const schema=schemaSlot('tableSchema',side).value;
      const fields=[...(Array.isArray(schema?.fields)?schema.fields:schema?.status==='pending'?[]:legacy),
        ...(schemaSlot('customFields',side).value||[])].filter(field=>object(field)&&typeof field.id==='string');
      const order=Array.isArray(schema?.columnOrder)?schema.columnOrder:[];
      const rank=new Map(order.map((id,index)=>[id,index]));
      return {schema,fields:fields.slice().sort((a,b)=>(rank.get(a.id)??order.length)-(rank.get(b.id)??order.length)),
        primary:order[0]||fields.find(field=>field.role==='primary')?.id||fields[0]?.id||'account'};
    };
    const before=definitions('before'),after=definitions('after');
    const allFields=new Map([...before.fields,...after.fields].map(field=>[field.id,field]));
    const recordMap=new Map((workspace.records||workspace.deals||[]).map(row=>[String(row.id),row]));
    const taskMap=new Map((workspace.todoCards||[]).map(card=>[String(card.id),card]));
    const whole=(collection,id,side)=>changes.find(change=>change.path?.length===2&&change.path[0]===collection&&String(change.path[1])===String(id))?.[side];
    const saved=(collection,id,side)=>whole(collection,id,side)?.value||whole(collection,id,side==='after'?'before':'after')?.value||
      (collection==='records'?recordMap:taskMap).get(String(id));
    const cell=(collection,id,key,side)=>changes.find(change=>change.path?.length===3&&change.path[0]===collection&&String(change.path[1])===String(id)&&change.path[2]===key)?.[side]||slot(saved(collection,id,side),key);
    const fieldName=id=>allFields.get(id)?.name||(/^(?:f_|cf_)/.test(String(id))?'Saved field':human(id));
    const recordName=(id,side='after')=>{
      const primary=(side==='after'?after:before).primary;
      const value=cell('records',id,primary,side).value;
      return value!==null&&value!==undefined&&String(value).trim()?clip(value,180):'Record'+(id!==undefined&&id!==null?' #'+id:'');
    };
    const taskName=(id,side='after')=>{
      const custom=cell('tasks',id,'customTitle',side).value,action=cell('tasks',id,'nextAction',side).value;
      const recordId=cell('tasks',id,'recordId',side).value;
      return clip(custom||action||(recordId!=null?recordName(recordId,side):'Task'),180);
    };
    return {changes,before,after,allFields,fieldName,recordName,taskName,saved,cell};
  }

  function display(value,ctx,key='',depth=0){
    if(value===null||value===undefined)return 'Not set';
    if(typeof value==='string')return value===''?'Blank':clip(key==='field'?ctx.fieldName(value):value);
    if(typeof value==='number')return Number.isFinite(value)?value.toLocaleString('en-US',{maximumFractionDigits:20}):'Invalid number';
    if(typeof value==='boolean')return value?'Yes':'No';
    if(Array.isArray(value)){
      if(['history','executions'].includes(key))return count(value.length,key==='history'?'history entry':'execution',key==='history'?'history entries':'executions');
      if(!value.length)return 'None';
      if(depth>=3)return count(value.length,'item');
      const limit=value.every(item=>item===null||typeof item!=='object')?120:8;
      const shown=value.slice(0,limit).map(item=>display(item,ctx,key,depth+1));
      return shown.join('; ')+(value.length>limit?'; '+count(value.length-limit,'additional item'):'');
    }
    if(object(value)){
      const keys=Object.keys(value).filter(key=>key!=='id');
      if(depth>=3)return count(keys.length,'setting')+' (contents change)';
      return keys.slice(0,8).map(key=>human(key)+': '+display(value[key],ctx,key,depth+1)).join('; ')+
        (keys.length>8?'; '+count(keys.length-8,'additional setting'):'')||'No settings';
    }
    return 'Saved value';
  }
  const valueText=(entry,ctx,key)=>!entry?.exists?'Not present':display(entry.value,ctx,key);
  const operation=change=>!change.before?.exists?'Restore':!change.after?.exists?'Remove':'Update';
  function addRow(section,label,before,after,ctx,key){
    section.rows.push({label:clip(label,240),before:valueText(before,ctx,key),after:valueText(after,ctx,key)});
  }
  function configuration(section,left,right,ctx,prefix='',depth=0){
    if(equal(left,right))return;
    if(depth<4&&(Array.isArray(left.value)||Array.isArray(right.value))&&
      [...(Array.isArray(left.value)?left.value:[]),...(Array.isArray(right.value)?right.value:[])].some(value=>value&&typeof value==='object')){
      const a=Array.isArray(left.value)?left.value:[],b=Array.isArray(right.value)?right.value:[];
      const keyed=[...a,...b].every(item=>object(item)&&typeof item.id==='string')&&
        [a,b].every(items=>new Set(items.map(item=>item.id)).size===items.length);
      const old=new Map(a.map((item,index)=>[keyed?item.id:index,item])),next=new Map(b.map((item,index)=>[keyed?item.id:index,item]));
      for(const key of new Set([...old.keys(),...next.keys()])){
        const l=old.has(key)?{exists:true,value:old.get(key)}:absent(),r=next.has(key)?{exists:true,value:next.get(key)}:absent();
        const label=r.value?.title||r.value?.name||l.value?.title||l.value?.name||'Item '+((keyed?[...new Set([...old.keys(),...next.keys()])].indexOf(key):key)+1);
        configuration(section,l,r,ctx,prefix+' / '+clip(label,180),depth+1);
      }
      if(keyed&&!equal(a.map(item=>item.id),b.map(item=>item.id)))section.details.push(prefix+' ordering or membership will be restored.');
    }else if(depth<4&&(object(left.value)||object(right.value))){
      const keys=[...new Set([...Object.keys(object(left.value)?left.value:{}),...Object.keys(object(right.value)?right.value:{})])].filter(key=>key!=='id');
      for(const key of keys)configuration(section,slot(left.value,key),slot(right.value,key),ctx,prefix?prefix+' / '+human(key):human(key),depth+1);
    }else addRow(section,prefix||'Configuration',left,right,ctx,prefix.split(' / ').at(-1)?.toLowerCase());
  }
  function fieldDefinitions(section,left,right,ctx){
    const a=new Map((Array.isArray(left)?left:[]).map(field=>[field.id,field])),b=new Map((Array.isArray(right)?right:[]).map(field=>[field.id,field]));
    for(const id of new Set([...a.keys(),...b.keys()])){
      if(equal(a.get(id),b.get(id)))continue;
      const previous=a.get(id),next=b.get(id),label=next?.name||previous?.name||'Field';
      section.details.push((!previous?'Restore ':!next?'Remove ':'Update ')+'field: '+clip(label,180));
      for(const key of new Set([...Object.keys(previous||{}),...Object.keys(next||{})]))if(key!=='id'&&!equal(slot(previous,key),slot(next,key))){
        const format=value=>key==='type'?fieldTypes[value]||human(value):value;
        const l=slot(previous,key),r=slot(next,key);
        addRow(section,label+' / '+human(key),l.exists?{exists:true,value:format(l.value)}:l,r.exists?{exists:true,value:format(r.value)}:r,ctx,key);
      }
    }
  }

  function sections(proposal,workspace={}){
    const ctx=context(proposal,workspace),result=[],groups=new Map();
    function group(key,kind,title,index){
      let section=groups.get(key);
      if(!section){section={kind,title,summary:'',rows:[],details:[],changeIndexes:[]};groups.set(key,section);result.push(section);}
      section.changeIndexes.push(index);return section;
    }
    ctx.changes.forEach((change,index)=>{
      const [collection,id,key]=Array.isArray(change.path)?change.path:[];
      const left=change.before||absent(),right=change.after||absent();
      if(collection==='records'||collection==='tasks'){
        const isRecord=collection==='records',side=right.exists?'after':'before';
        const name=isRecord?ctx.recordName(id,side):ctx.taskName(id,side);
        const section=group(collection+':'+id,isRecord?'record':'task',(key?'Update':operation(change))+' '+(isRecord?'':'task: ')+name,index);
        const row=(field,l,r)=>{
          if(isRecord&&internalRecord.has(field)){
            if(field!=='id'&&!section.details.includes('Associated system metadata is included.'))section.details.push('Associated system metadata is included.');
            return;
          }
          if(field==='id')return;
          if(!isRecord&&field==='recordId'){
            const linked=(entry,which)=>!entry.exists?entry:{exists:true,value:entry.value==null?'Standalone task':ctx.recordName(entry.value,which)};
            addRow(section,'Linked record',linked(l,'before'),linked(r,'after'),ctx);return;
          }
          addRow(section,field==='history'?'Activity history':isRecord?ctx.fieldName(field):taskLabels[field]||human(field),l,r,ctx,field);
          if(field==='history')section.details.push(r.exists?'Saved history content and its ordering will be restored with this record.':'Saved history will be removed with this change.');
        };
        if(key)row(key,left,right);
        else{
          const known=isRecord?[...ctx.after.fields,...ctx.before.fields].map(field=>field.id):Object.keys(taskLabels);
          const keys=[...new Set([...known,...Object.keys(object(left.value)?left.value:{}),...Object.keys(object(right.value)?right.value:{})])];
          for(const field of keys)if(own(left.value,field)||own(right.value,field))row(field,slot(left.value,field),slot(right.value,field));
          section.summary=operation(change)+' this '+(isRecord?'record':'task')+' with its saved fields.';
        }
      }else if(collection==='order'){
        const isRecord=key==='records',noun=isRecord?'record':'task',a=Array.isArray(left.value)?left.value:[],b=Array.isArray(right.value)?right.value:[];
        const section=group('order:'+key,'order',isRecord?'Record order':'Task order',index);
        section.summary='Restore the saved '+noun+' order.';
        const old=new Set(a.map(String)),next=new Set(b.map(String)),added=b.filter(id=>!old.has(String(id))),removed=a.filter(id=>!next.has(String(id)));
        addRow(section,human(noun)+' count',{exists:true,value:a.length},{exists:true,value:b.length},ctx);
        section.details.push(count(added.length,noun)+' added to the order; '+count(removed.length,noun)+' removed from the order.');
        const commonA=a.filter(id=>next.has(String(id))).map(String),commonB=b.filter(id=>old.has(String(id))).map(String);
        section.details.push(equal(commonA,commonB)?'Existing '+noun+'s keep their relative order.':'The relative order of existing '+noun+'s will change.');
        const oldPositions=new Map(a.map((id,i)=>[String(id),i+1]));
        const moved=b.map((id,i)=>({id,from:oldPositions.get(String(id)),to:i+1})).filter(item=>item.from!==item.to);
        moved.slice(0,10).forEach(item=>addRow(section,isRecord?ctx.recordName(item.id):ctx.taskName(item.id),
          item.from?{exists:true,value:'Position '+item.from}:absent(),{exists:true,value:'Position '+item.to},ctx));
        if(moved.length>10)section.details.push(count(moved.length-10,'additional position change')+' included.');
      }else if(collection==='schema'){
        const section=group('schema','schema','Table configuration',index);
        section.summary='Restore the saved table configuration shown below.';
        if(key==='customFields')fieldDefinitions(section,left.value,right.value,ctx);
        else if(key==='tableSchema'){
          fieldDefinitions(section,left.value?.fields,right.value?.fields,ctx);
          const keys=new Set([...Object.keys(left.value||{}),...Object.keys(right.value||{})]);
          for(const property of keys)if(property!=='fields'&&!equal(slot(left.value,property),slot(right.value,property))){
            if(property==='columnOrder'){
              const labels=(entry,side)=>!entry.exists?entry:{exists:true,value:entry.value.map(id=>(side==='before'?ctx.before:ctx.after).fields.find(f=>f.id===id)?.name||ctx.fieldName(id))};
              addRow(section,'Column order',labels(slot(left.value,property),'before'),labels(slot(right.value,property),'after'),ctx);
            }else configuration(section,slot(left.value,property),slot(right.value,property),ctx,human(property));
          }
          if(ctx.before.primary!==ctx.after.primary)addRow(section,'Primary field',{exists:true,value:ctx.fieldName(ctx.before.primary)},{exists:true,value:ctx.fieldName(ctx.after.primary)},ctx);
        }else configuration(section,left,right,ctx,human(key));
      }else if(collection==='workflows'){
        const label=right.value?.spec?.name||right.value?.spec?.title||right.value?.name||left.value?.spec?.name||left.value?.spec?.title||left.value?.name||'workflow';
        const section=group('workflow:'+id,'workflow',operation(change)+' workflow: '+clip(label,180),index);
        section.summary=operation(change)+' the saved workflow state; this preview does not execute the workflow.';
        for(const property of new Set([...Object.keys(left.value||{}),...Object.keys(right.value||{})])){
          if(equal(slot(left.value,property),slot(right.value,property)))continue;
          if(internalWorkflow.has(property)){if(!section.details.length)section.details.push('Workflow lifecycle metadata will also be restored.');continue;}
          if(['history','executions'].includes(property))addRow(section,human(property),slot(left.value,property),slot(right.value,property),ctx,property);
          else configuration(section,slot(left.value,property),slot(right.value,property),ctx,human(property));
        }
      }else{
        const section=group('other:'+index,'other','Other saved change',index);
        section.summary='This saved configuration change is included in the undo.';
        configuration(section,left,right,ctx,'Saved setting');
      }
    });
    return result;
  }

  function render(proposal,workspace,esc=escape,icon){
    const arrow=typeof icon==='function'?icon('ArrowRight'):'<span aria-hidden="true">&rarr;</span>';
    const value=text=>text.length>240?'<details><summary>'+esc(clip(text,200))+'</summary><span style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(text)+'</span></details>':
      '<span style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(text)+'</span>';
    return sections(proposal,workspace).map(section=>'<section class="proposal-record"><h3>'+esc(section.title)+'</h3>'+
      (section.summary?'<p>'+esc(section.summary)+'</p>':'')+section.rows.map(row=>'<div><strong>'+esc(row.label)+'</strong><div class="diff-values"><div class="diff-before">'+value(row.before)+'</div>'+arrow+'<div class="diff-after">'+value(row.after)+'</div></div></div>').join('')+
      section.details.map(detail=>'<p>'+esc(detail)+'</p>').join('')+'</section>').join('');
  }
  return {sections,render};
});
