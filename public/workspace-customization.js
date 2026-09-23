(function(root,factory){
  const api=typeof module==='object'&&module.exports?factory(require('./table-schema.js'),require('./pipeline-core.js')):factory(root.PipeChatSchema,root.PipelineCore);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatCustomize=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Schema,Core){
  'use strict';
  const copy=value=>JSON.parse(JSON.stringify(value));
  const condition=(field,operator,value=null)=>({field,operator,value});
  function defaults(schema,customFields=[]){
    const core=Core.create(schema),defs=core.definitions(customFields),follow=core.role('followup'),owner=core.role('owner');
    const legacy=!schema||schema.legacy;
    const open=legacy&&defs.some(f=>f.id==='stage')?[condition('stage','not_equals','Won'),condition('stage','not_equals','Lost')]:[];
    const result=[{id:'kpi_records',title:legacy?'Open deals':'Records',metric:'count',field:null,conditions:open}];
    for(const f of defs.filter(f=>['number','currency'].includes(f.type)))result.push({id:'kpi_'+f.id,title:legacy&&f.id==='value'?'Open pipeline value':'Total '+f.name,metric:'sum',field:f.id,conditions:legacy&&f.id==='value'?open:[]});
    if(follow)result.push({id:'kpi_followup',title:core.fields[follow]+' today',metric:'count',field:null,conditions:[condition(follow,'equals','today')]});
    if(owner)result.push({id:'kpi_owner',title:'Missing '+core.fields[owner],metric:'count',field:null,conditions:[condition(owner,'is_blank')]});
    return result;
  }
  function validateReferences(kpi,core,customFields=[]){
    const defs=core.definitions(customFields),get=id=>defs.find(f=>f.id===id);
    if(kpi.metric==='count'&&kpi.field!==null||kpi.metric!=='count'&&!['number','currency'].includes(get(kpi.field)?.type))throw new Error('Totals and averages need a numeric column; counts have no numeric field.');
    for(const c of kpi.conditions){
      const f=get(c.field);if(!f)throw new Error('A KPI references a missing column.');
      if(['is_blank','is_not_blank'].includes(c.operator)){if(c.value!==null)throw new Error('Blank checks need no value.');continue;}
      if(['before_today','older_than_days'].includes(c.operator)){
        if(f.type!=='date'&&!(core.role('followup')===f.id&&f.type==='text'))throw new Error('Stale-date conditions need a date column.');
        if(c.operator==='before_today'&&c.value!==null||c.operator==='older_than_days'&&(!Number.isInteger(c.value)||c.value<0||c.value>36500))throw new Error('Choose a valid number of stale days.');
      }else if(['gt','gte','lt','lte'].includes(c.operator)){
        if(!['number','currency','date'].includes(f.type)||f.type==='date'&&!core.date(c.value)||f.type!=='date'&&(typeof c.value!=='number'||!Number.isFinite(c.value)))throw new Error('Choose a valid comparison value for this column.');
      }else if(c.value===null)throw new Error('Specify a comparison value.');
    }
    return kpi;
  }
  function kpis(schema,customFields=[]){
    const core=Core.create(schema),result=defaults(schema,customFields),overrides=Schema.validateKpis(schema?.kpis||[]);
    for(const k of overrides){validateReferences(k,core,customFields);const index=result.findIndex(d=>d.id===k.id);if(index<0)result.push(k);else result[index]=k;}
    return result;
  }
  function calculate(kpi,records,schema,customFields=[],today=new Date().toISOString().slice(0,10)){
    const core=Core.create(schema);validateReferences(kpi,core,customFields);
    const defs=new Map(core.definitions(customFields).map(f=>[f.id,f]));
    const now=core.date(today);if(!now)throw new Error('Invalid current date.');
    const rows=records.filter(row=>kpi.conditions.every(c=>{
      const value=row[c.field],blank=value==null||String(value).trim()==='',f=defs.get(c.field);
      if(c.operator==='is_blank')return blank;if(c.operator==='is_not_blank')return !blank;
      const actual=core.normalize(value),expected=core.normalize(c.value);
      if(['equals','not_equals'].includes(c.operator)){const match=expected==='today'&&(f.type==='date'||core.role('followup')===f.id)?actual==='today'||value===today:actual===expected;return c.operator==='equals'?match:!match;}
      if(blank)return false;
      if(['before_today','older_than_days'].includes(c.operator)){const d=core.date(value);return Boolean(d&&d.getTime()<now.getTime()-(c.operator==='older_than_days'?c.value:0)*86400000);}
      const a=f.type==='date'?core.date(value)?.getTime():Number(value),b=f.type==='date'?core.date(c.value)?.getTime():c.value;
      return Number.isFinite(a)&&({gt:a>b,gte:a>=b,lt:a<b,lte:a<=b})[c.operator];
    }));
    const type=defs.get(kpi.field)?.type;
    const values=rows.map(r=>r[kpi.field]).filter(v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v)));
    const total=values.reduce((sum,v)=>sum+(type==='currency'?Math.round(Number(v)*100):Number(v)),0)/(type==='currency'?100:1);
    return {value:kpi.metric==='count'?rows.length:values.length?total/(kpi.metric==='average'?values.length:1):null,type:kpi.metric==='count'?'number':type,count:rows.length};
  }
  function configure(schema,customFields,id,input){
    const existing=kpis(schema,customFields).find(k=>k.id===id);if(!existing)throw new Error('Which dashboard KPI should I change?');
    const after=Schema.validateKpis([{...input,id}])[0];validateReferences(after,Core.create(schema),customFields);
    const next=copy(schema||Schema.legacySchema());next.kpis=[...(next.kpis||[]).filter(k=>k.id!==id),after];
    return {tableSchema:Schema.validate(next),before:existing,after};
  }
  function editColumn(records,schema,customFields,id,{name,options}={}){
    const core=Core.create(schema),defs=core.definitions(customFields),old=defs.find(f=>f.id===id);
    if(!old)throw new Error('This column no longer exists.');
    let nextSchema=copy(schema||Schema.legacySchema()),nextFields=copy(customFields),field=nextSchema.fields.find(f=>f.id===id)||nextFields.find(f=>f.id===id);
    const issues=[],next=copy(records),conversion=options!==undefined;
    if(conversion){
      if(!Array.isArray(options)||!options.length)throw new Error('What options would you like the dropdown menu to have?');
      if(options.length>30||options.some(v=>typeof v!=='string'||!v.trim()||v.trim().length>80||/[\x00-\x1f\x7f]/.test(v))||new Set(options.map(core.normalize)).size!==options.length)throw new Error('Provide 1 to 30 distinct dropdown options of at most 80 characters.');
      field.type='choice';field.options=options.map(v=>v.trim());if(field.role==='followup')field.role='none';
      for(const row of next){const raw=row[id];if(raw==null||raw===''){row[id]='';continue;}const option=field.options.find(v=>core.normalize(v)===core.normalize(String(raw)));row[id]=option??'';if(option===undefined)issues.push({id:row.id,record:String(row[core.role('primary')]||'#'+row.id),value:raw});}
    }else{
      if(typeof name!=='string'||!name.trim()||name.trim().length>60||/[\x00-\x1f\x7f]/.test(name))throw new Error('Enter a header of 1 to 60 readable characters.');
      name=name.trim();if(defs.some(f=>f.id!==id&&core.normalize(f.name)===core.normalize(name)))throw new Error('A column already uses that name.');
      field.name=name;
    }
    // Remove only KPI overrides whose typed references cannot survive conversion.
    const dropped=[];
    if(conversion&&nextSchema.kpis){const nextCore=Core.create(nextSchema);nextSchema.kpis=nextSchema.kpis.filter(k=>{try{validateReferences(k,nextCore,nextFields);return true;}catch{dropped.push(k.title);return false;}});}
    nextSchema=Schema.transition(schema,nextSchema,next);nextFields=Core.create(nextSchema).validateCustomFields(nextFields);
    kpis(nextSchema,nextFields);
    return {records:next,tableSchema:nextSchema,customFields:nextFields,before:old,after:field,issues,dropped};
  }
  return {defaults,kpis,calculate,configure,editColumn,validateReferences};
});
