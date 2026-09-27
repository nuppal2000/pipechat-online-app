(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatReports=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const metrics=['count','sum','average','min','max','median','count_distinct','percentage'];
  const buckets=['none','day','week','month','quarter','year'];
  const operators=['equals','not_equals','in','not_in','contains','not_contains','is_blank','is_not_blank','gt','gte','lt','lte','between','before_today','older_than_days'];
  const refinementFields=['title','chart','scope','groupBy','bucket','splitBy','measures','sort','limit'];
  const refinementModes=['add_filter','replace_filter','remove_filter'];
  const names={count:'Record count',sum:'Total',average:'Average',min:'Minimum',max:'Maximum',median:'Median',count_distinct:'Distinct count',percentage:'Percentage'};
  const blank=v=>v==null||typeof v==='string'&&!v.trim();
  const norm=v=>String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
  const fail=message=>{throw new Error(message);};
  const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  function responseSchema(core,custom=[]){
    const ids=core.definitions(custom).map(f=>f.id),nullable={type:['string','null'],enum:[...ids,null]};
    const scalar={type:['string','number','null']};
    const conditions={type:'array',maxItems:12,items:{type:'array',minItems:1,maxItems:20,items:object({field:{type:'string',enum:ids},operator:{type:'string',enum:operators},value:scalar,values:{type:'array',maxItems:2000,items:scalar}})}};
    return {anyOf:[{type:'null'},object({version:{type:'integer',enum:[1]},title:{type:'string'},chart:{type:'string',enum:['bar','line','stage','kpi']},scope:{type:'string',enum:['all','visible']},groupBy:nullable,bucket:{type:'string',enum:buckets},splitBy:nullable,measures:{type:'array',minItems:1,maxItems:6,items:object({label:{type:'string'},metric:{type:'string',enum:metrics},field:nullable,where:conditions})},where:conditions,sort:{type:'string',enum:['label_asc','label_desc','value_asc','value_desc']},limit:{type:['integer','null']}})]};
  }
  function refinementSchema(core,custom=[]){
    const properties=responseSchema(core,custom).anyOf[1].properties,ids=core.definitions(custom).map(f=>f.id);
    return object({action:{type:'string',enum:['refine_report']},mode:{type:'string',enum:refinementModes},where:properties.where,replaceFields:{type:'array',maxItems:20,items:{type:'string',enum:ids}},changes:{type:'array',minItems:1,maxItems:refinementFields.length,items:{anyOf:refinementFields.map(field=>object({field:{type:'string',enum:[field]},value:properties[field]}))}}});
  }
  function filteringSchema(core,custom=[]){
    const {mode,where,replaceFields}=refinementSchema(core,custom).properties;
    const selectionMode={...mode,description:'Use replace_filter to set categorical selections, including short follow-ups naming different owners, stages or accounts. It replaces only the fields in where and keeps unrelated filters. Use add_filter for extra constraints or an explicit intersection, not for switching one category to another. Use remove_filter to clear named fields.'};
    return object({action:{type:'string',enum:['filter_records']},target:{type:'string',enum:['context','report','pipeline_table']},mode:selectionMode,where,removeFields:replaceFields});
  }
  function readActionSchemas(core,custom=[]){
    const p=responseSchema(core,custom).anyOf[1].properties,ids=core.definitions(custom).map(f=>f.id);
    return [
      object({action:{type:'string',enum:['query_records'],description:'Show individual records in Pipeline, not a chart. A fresh search starts from the full table and combines filtering and optional sorting in one read-only action.'},where:p.where,orderBy:{type:['string','null'],enum:[...ids,null]},direction:{type:['string','null'],enum:['asc','desc',null]}}),
      object({action:{type:'string',enum:['show_kpi'],description:'Temporary numerical answer, never a saved dashboard card. Use for show, count, total, average and one-off KPI questions.'},title:p.title,scope:p.scope,where:p.where,measures:p.measures}),
      object({action:{type:'string',enum:['audit_records'],description:'Read-only counts and affected record names for each requested group. The app evaluates every group independently against the complete scoped table; never count from sampled rows or generate names in assistantMessage.'},scope:p.scope,where:p.where,groups:{type:'array',minItems:1,maxItems:20,items:object({label:{type:'string',minLength:1,maxLength:120},where:{...p.where,minItems:1}})}})
    ];
  }
  function readShape(action,name,keys){
    if(!action||action.action!==name||keys.some(key=>!Object.hasOwn(action,key))||Object.keys(action).some(key=>!keys.includes(key)))fail(`Supply a complete ${name} request using only supported properties.`);
  }
  function readPredicate(where,core,custom,records,today){
    // Reuse the same strict predicate contract as reports and contextual refinements.
    filteringRefinement({action:'filter_records',target:'pipeline_table',mode:'add_filter',where,removeFields:[]});
    return tableMatches({where},core,custom,records,today);
  }
  function queryRecords(records,action,core,custom=[],options={}){
    readShape(action,'query_records',['action','where','orderBy','direction']);
    if(!Array.isArray(records))fail('Supply the complete authorized table.');
    const defs=core.definitions(custom);
    if(action.orderBy===null?action.direction!==null:!defs.some(f=>f.id===action.orderBy)||!['asc','desc'].includes(action.direction))fail('Choose an existing sort column and ascending or descending order, or leave both blank.');
    const matches=readPredicate(action.where,core,custom,records,options.today),sort=action.orderBy===null?null:{field:action.orderBy,direction:action.direction};
    return {rows:core.sortRecords(records.filter(matches),sort,custom,options.today?core.date(options.today):new Date()),filter:action.where.length?{where:JSON.parse(JSON.stringify(action.where))}:null,sort};
  }
  function kpiReport(action){
    readShape(action,'show_kpi',['action','title','scope','where','measures']);
    return JSON.parse(JSON.stringify({version:1,title:action.title,chart:'kpi',scope:action.scope,groupBy:null,bucket:'none',splitBy:null,where:action.where,measures:action.measures,sort:'label_asc',limit:null}));
  }
  function auditRecords(records,action,core,custom=[],options={}){
    readShape(action,'audit_records',['action','scope','where','groups']);
    if(!Array.isArray(records)||!['all','visible'].includes(action.scope))fail('Choose the full table or the current pipeline view for the audit.');
    if(!Array.isArray(action.groups)||!action.groups.length||action.groups.length>20)fail('Choose between one and twenty audit groups.');
    const visible=new Set(options.visibleIds||[]),base=readPredicate(action.where,core,custom,records,options.today);
    const rows=records.filter(row=>(action.scope==='all'||visible.has(row.id))&&base(row)),labels=new Set(),primary=core.role('primary');
    const groups=action.groups.map(group=>{
      if(!group||Object.keys(group).some(k=>!['label','where'].includes(k))||typeof group.label!=='string'||!group.label.trim()||group.label.length>120||labels.has(norm(group.label))||!Array.isArray(group.where)||!group.where.length)fail('Each audit group needs a distinct label and explicit matching conditions.');
      labels.add(norm(group.label));
      const matches=readPredicate(group.where,core,custom,records,options.today),selected=rows.filter(matches);
      return {label:group.label.trim(),count:selected.length,records:selected.map(row=>({id:row.id,name:blank(row[primary])?`Unnamed record #${row.id}`:String(row[primary])}))};
    });
    return {total:rows.length,scope:action.scope,groups};
  }
  function describeAudit(result){
    return `Read-only audit: ${result.total} records from ${result.scope==='all'?'the full table':'the current pipeline view'}. Counts and names calculated from table data. Records can appear in multiple groups.\n\n`+result.groups.map(group=>`${group.label} (${group.count})\n${group.records.length?group.records.map(row=>`- ${row.name} (#${row.id})`).join('\n'):'- None'}`).join('\n\n')+'\n\nNo records or saved KPI cards were changed.';
  }
  function filteringRefinement(action){
    const keys=['action','target','mode','where','removeFields'];
    if(!action||action.action!=='filter_records'||!['context','report','pipeline_table'].includes(action.target)||!refinementModes.includes(action.mode)||keys.some(key=>!Object.hasOwn(action,key))||Object.keys(action).some(key=>!keys.includes(key)))fail('Use filter_records with target, mode, where and removeFields.');
    if(!Array.isArray(action.removeFields)||action.removeFields.length>20||action.removeFields.some(field=>typeof field!=='string'||!field.trim())||new Set(action.removeFields).size!==action.removeFields.length)fail('Choose up to 20 distinct fields to remove.');
    if(!Array.isArray(action.where)||action.where.length>12)fail('Use at most 12 alternative filter groups.');
    const fields=new Set(),scalar=value=>value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value);
    for(const group of action.where){
      if(!Array.isArray(group)||!group.length||group.length>20)fail('Each filter group needs 1 to 20 conditions.');
      for(const c of group){
        const conditionKeys=['field','operator','value','values'];
        if(!c||conditionKeys.some(key=>!Object.hasOwn(c,key))||Object.keys(c).some(key=>!conditionKeys.includes(key))||typeof c.field!=='string'||!c.field.trim()||!operators.includes(c.operator)||!scalar(c.value)||!Array.isArray(c.values)||c.values.length>2000||c.values.some(value=>!scalar(value)))fail('Supply complete typed filter conditions with scalar value and values.');
        const membership=['in','not_in','between'].includes(c.operator);
        if(membership?c.value!==null||!c.values.length:c.values.length)fail('Use values for membership/ranges with value null; use a single value for other comparisons.');
        if(c.operator==='between'&&c.values.length!==2)fail('A between filter needs exactly two values.');
        fields.add(c.field);
      }
    }
    if(action.mode==='remove_filter'?(action.where.length||!action.removeFields.length):action.removeFields.length)fail('Only remove_filter uses nonempty removeFields, and its where must be empty.');
    if(action.mode==='replace_filter'&&(!fields.size||fields.size>20))fail('Replacement conditions must identify between 1 and 20 fields.');
    const replaceFields=action.mode==='remove_filter'?action.removeFields:action.mode==='replace_filter'?[...fields]:[];
    // Schema-independent shape validation happens here; field/type validation stays in refinement.
    return JSON.parse(JSON.stringify({action:'refine_report',mode:action.mode,where:action.where,replaceFields,changes:[]}));
  }
  function compileConditions(groups,defs,core,today,records=[]){
    if(!Array.isArray(groups)||groups.length>12)fail('Use at most 12 alternative filter groups. Which conditions matter most?');
    const choices=new Map();
    const compiled=groups.map(group=>{
      if(!Array.isArray(group)||!group.length||group.length>20)fail('Each filter group needs 1 to 20 conditions. Which conditions should apply together?');
      return group.map(c=>{
        const f=defs.get(c?.field);if(!f||!operators.includes(c.operator))fail('A filter refers to an unavailable field or comparison. Which current column should I use?');
        const numeric=['number','currency'].includes(f.type),dated=f.type==='date';
        const convert=v=>blank(v)?null:numeric?typeof v==='number'&&Number.isFinite(v)?v:typeof v==='string'&&Number.isFinite(Number(v))?Number(v):null:dated?core.date(v)?.getTime()??null:norm(v);
        const {operator:op}=c;
        if(!Array.isArray(c.values)||c.values.length>2000)fail('Supply a valid list of filter values.');
        const scalar=v=>v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v);
        if(!scalar(c.value)||c.values.some(v=>!scalar(v)))fail('Filter values must be text, finite numbers, or null.');
        const membership=['in','not_in','between'].includes(op);
        if(membership?c.value!==null:c.values.length)fail('Use values for membership/ranges with value null; use a single value for other comparisons.');
        if(f.type==='choice'&&['contains','not_contains'].includes(op))fail(`Use equals or in with a values array for ${f.name}; choice filters need exact options, not contains.`);
        if(f.type==='choice'&&['equals','not_equals','in','not_in'].includes(op)){
          if(!choices.has(f.id))choices.set(f.id,new Set([...(f.options||[]),...records.map(row=>row[f.id])].filter(v=>typeof v==='string'&&!blank(v)).map(norm)));
          const literals=membership?c.values:[c.value];
          if(literals.some(v=>typeof v!=='string'||!choices.get(f.id).has(norm(v))))fail(`Which ${f.name} options did you mean? Use defined choices or values present in the table.`);
        }
        if(['contains','not_contains'].includes(op)&&(numeric||dated||typeof c.value!=='string'||!c.value.trim()))fail(`What text should ${f.name} contain? Text matching needs a text column.`);
        if(['gt','gte','lt','lte','between'].includes(op)&&!numeric&&!dated)fail(`Should ${f.name} be interpreted as a number or a date? Its current column type is text.`);
        if(['before_today','older_than_days'].includes(op)&&!dated)fail(`Which date column should define the age instead of ${f.name}?`);
        if(op==='older_than_days'&&(!Number.isInteger(c.value)||c.value<0||c.value>36500))fail('How many days old should a record be?');
        const list=['in','not_in','between'].includes(op)?c.values.map(convert):[];
        if(['in','not_in'].includes(op)&&(!list.length||list.some(v=>v===null)))fail('Which nonblank values should be included or excluded?');
        if(op==='between'&&(list.length!==2||list.some(v=>v===null)||list[0]>list[1]))fail(`Choose an ordered start and end for ${f.name}.`);
        const value=convert(c.value);
        if(['equals','not_equals','gt','gte','lt','lte'].includes(op)&&value===null)fail(`What value should ${f.name} be compared with? Use a blank check for missing data.`);
        return row=>{
          const v=convert(row[f.id]);if(op==='is_blank')return blank(row[f.id]);if(op==='is_not_blank')return !blank(row[f.id]);
          if(v===null)return false;
          switch(op){case 'equals':return v===value;case 'not_equals':return v!==value;case 'in':return list.includes(v);case 'not_in':return !list.includes(v);case 'contains':return v.includes(norm(c.value));case 'not_contains':return !v.includes(norm(c.value));case 'gt':return v>value;case 'gte':return v>=value;case 'lt':return v<value;case 'lte':return v<=value;case 'between':return v>=list[0]&&v<=list[1];case 'before_today':return v<today;case 'older_than_days':return v<today-c.value*86400000;default:return false;}
        };
      });
    });
    // OR across groups; AND within a group. An empty outer array means no filter.
    return row=>!compiled.length||compiled.some(group=>group.every(matches=>matches(row)));
  }
  function refineWhere(current,action,defs,core,today,records){
    if(!refinementModes.includes(action.mode))fail('Choose add_filter, replace_filter or remove_filter.');
    if(!Array.isArray(records))fail('Supply table records when validating filters.');
    if(!Array.isArray(action.replaceFields)||action.replaceFields.length>20||new Set(action.replaceFields).size!==action.replaceFields.length||action.replaceFields.some(field=>!defs.has(field)))fail('Choose distinct existing columns whose report filters should be replaced or removed.');
    compileConditions(action.where,defs,core,today,records);
    if(action.mode==='add_filter'&&action.replaceFields.length||action.mode!=='add_filter'&&!action.replaceFields.length)fail('Only replace_filter and remove_filter use a nonempty replaceFields list.');
    if(action.mode==='remove_filter'&&action.where.length)fail('remove_filter must have an empty where list.');
    if(action.mode==='replace_filter'&&(!action.where.length||action.where.flat().some(c=>!action.replaceFields.includes(c.field))||action.replaceFields.some(field=>!action.where.flat().some(c=>c.field===field))))fail('Supply replacement conditions for exactly the columns in replaceFields.');
    let where=current;
    // Validate structure before removing predicates, without blocking repairs of invalid literals.
    if(!Array.isArray(where)||where.length>12||where.some(group=>!Array.isArray(group)||!group.length||group.length>20||group.some(c=>!c||!defs.has(c.field))))fail('The current filter has invalid groups. Please clarify which conditions should apply.');
    if(action.mode!=='add_filter'){
      where=where.map(group=>group.filter(c=>!action.replaceFields.includes(c.field)));
      // An empty AND branch is true, so it makes the entire OR expression unrestricted.
      if(where.some(group=>!group.length))where=[];
    }
    if(action.where.length){
      if(where.length*action.where.length>12)fail('The combined filters exceed 12 alternative groups. Which conditions matter most?');
      where=where.length?where.flatMap(left=>action.where.map(right=>[...left,...right])):action.where;
    }
    compileConditions(where,defs,core,today,records);
    return where;
  }
  // options.records supplies observed choice values; the returned report is an independent clone.
  function refine(current,action,core,custom=[],options={}){
    if(!current||current.version!==1)fail('There is no current smart report to refine. Use show_report for a new report.');
    const keys=['action','mode','where','replaceFields','changes'];
    if(!action||action.action!=='refine_report'||!refinementModes.includes(action.mode)||keys.some(key=>!Object.hasOwn(action,key))||Object.keys(action).some(key=>!keys.includes(key)))fail('Use an explicit refine_report action and supported filter mode; use show_report for a new report.');
    const defs=new Map(core.definitions(custom).map(f=>[f.id,f])),records=options.records||[],today=core.date(options.today||new Date().toISOString().slice(0,10))?.getTime();
    if(!Array.isArray(action.changes)||action.changes.length>refinementFields.length)fail('Supply a bounded list of report property changes.');
    const next={...current},changed=new Set();
    for(const change of action.changes){
      if(!change||!refinementFields.includes(change.field)||changed.has(change.field)||!Object.hasOwn(change,'value')||Object.keys(change).some(key=>!['field','value'].includes(key)))fail('Change each supported report property at most once, with an explicit value.');
      changed.add(change.field);next[change.field]=change.value;
    }
    if(!changed.has('title')&&(changed.has('measures')||changed.has('groupBy')))next.title='';
    next.where=refineWhere(current.where,action,defs,core,today,records);
    if(action.mode!=='add_filter')for(const [key,role]of [['owners','owner'],['accounts','primary']])if(action.replaceFields.includes(core.role(role)))next[key]=null;
    execute(records,next,core,custom,options);
    return JSON.parse(JSON.stringify(next));
  }
  function tableWhere(filter,core,custom,today){
    if(filter==null)return [];
    if(typeof filter!=='object'||Array.isArray(filter))fail('Supply a legacy filter or an object containing typed where conditions.');
    if(Object.hasOwn(filter,'where')){
      if(Object.keys(filter).some(key=>key!=='where'))fail('Do not combine legacy and typed table filters.');
      return filter.where;
    }
    if(Object.keys(filter).some(key=>!['field','operator','value'].includes(key))||!Object.hasOwn(filter,'value'))fail('The legacy table filter is incomplete or has unsupported properties.');
    if(filter.operator==='month_equals')fail('The legacy month_equals filter needs an explicit date range before it can be refined. No filters were discarded.');
    if(!['equals','contains','is_blank','gt','gte','lt','lte'].includes(filter.operator))fail('That legacy table comparison cannot be converted safely. Please clarify the filter.');
    const field=core.fieldName(filter.field,custom),def=core.definitions(custom).find(f=>f.id===field);
    if(!def)fail('A table filter refers to an unavailable field. Which current column should I use?');
    const c={field,operator:filter.operator,value:filter.operator==='is_blank'?null:filter.value,values:[]};
    if(c.operator==='equals'&&norm(c.value)==='today'&&(def.type==='date'||field==='follow')){
      const date=core.date(today||new Date().toISOString().slice(0,10));if(!date)fail('Supply today as a complete valid calendar date.');
      const literal={...c,value:date.toISOString().slice(0,10)};
      return def.type==='date'?[[literal]]:[[c],[literal]];
    }
    return [[c]];
  }
  // The caller resolves conversational context before choosing this table-only helper.
  function refineTableFilter(currentFilter,action,core,custom=[],records=[],today){
    const canonical=filteringRefinement(action);
    if(action.target==='report')fail('Use filter_records targeting pipeline_table or a context already resolved to the table.');
    const defs=new Map(core.definitions(custom).map(f=>[f.id,f])),day=core.date(today||new Date().toISOString().slice(0,10))?.getTime();
    const where=refineWhere(tableWhere(currentFilter,core,custom,today),canonical,defs,core,day,records);
    return {where:JSON.parse(JSON.stringify(where))};
  }
  function tableMatches(filter,core,custom=[],records=[],today){
    if(!Array.isArray(records))fail('Supply table records when validating filters.');
    const defs=new Map(core.definitions(custom).map(f=>[f.id,f])),day=core.date(today||new Date().toISOString().slice(0,10))?.getTime();
    return compileConditions(tableWhere(filter,core,custom,today),defs,core,day,records);
  }
  function describeConditions(groups,fields){
    return groups.map(and=>and.map(c=>`${fields[c.field]||c.field} ${c.operator.replaceAll('_',' ')} ${['in','not_in','between'].includes(c.operator)?c.values.join(', '):c.value??''}`).join(' AND ')).map(s=>'('+s+')').join(' OR ');
  }
  function tableFilterDescription(filter,core,custom=[]){
    const where=tableWhere(filter,core,custom),fields=core.fieldsFor(custom);
    // Formatting needs no row snapshot; matching/refinement validate categorical literals.
    if(!Array.isArray(where)||where.length>12||where.some(group=>!Array.isArray(group)||!group.length||group.length>20||group.some(c=>!c||!Object.hasOwn(fields,c.field)||!operators.includes(c.operator)||!Array.isArray(c.values)||c.values.length>2000)))fail('The table filter cannot be described until its conditions are valid.');
    return describeConditions(where,fields);
  }
  function dateBucket(value,bucket,core){
    const date=core.date(value);if(!date)return null;
    if(bucket==='week')date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
    const iso=date.toISOString().slice(0,10);
    if(bucket==='month')return iso.slice(0,7);
    if(bucket==='quarter')return iso.slice(0,4)+'-Q'+(Math.floor(date.getUTCMonth()/3)+1);
    return bucket==='year'?iso.slice(0,4):iso;
  }
  function execute(records,spec,core,custom=[],options={}){
    const defs=new Map(core.definitions(custom).map(f=>[f.id,f])),today=core.date(options.today||new Date().toISOString().slice(0,10))?.getTime();
    if(!spec||spec.version!==1||!['bar','line','stage','kpi'].includes(spec.chart)||!['all','visible'].includes(spec.scope)||!buckets.includes(spec.bucket)||!['label_asc','label_desc','value_asc','value_desc'].includes(spec.sort))fail('Which chart and grouping would you like? This report definition is not supported.');
    if(typeof spec.title!=='string'||spec.title.length>200)fail('Please give the report a shorter title.');
    for(const id of [spec.groupBy,spec.splitBy])if(id!==null&&!defs.has(id))fail('A report column no longer exists. Which current column should replace it?');
    if(spec.bucket!=='none'&&defs.get(spec.groupBy)?.type!=='date')fail('Which date column should be used for the time grouping?');
    if(spec.limit!==null&&(!Number.isInteger(spec.limit)||spec.limit<1||spec.limit>2000))fail('Choose a report limit from 1 to 2,000 groups, or no limit.');
    if(!Array.isArray(spec.measures)||!spec.measures.length||spec.measures.length>6)fail('Choose between one and six measures for this chart.');
    const labels=new Set(),measures=spec.measures.map(m=>{
      if(!m||!metrics.includes(m.metric)||typeof m.label!=='string'||!m.label.trim()||m.label.length>120||labels.has(norm(m.label)))fail('Each measure needs a distinct name and supported aggregation.');labels.add(norm(m.label));
      const field=defs.get(m.field),numeric=['number','currency'].includes(field?.type);
      if(['count','percentage'].includes(m.metric)?m.field!==null:!field)fail('Choose a valid measure column, or no column for record count/percentage.');
      if(!['count','percentage','count_distinct'].includes(m.metric)&&!numeric)fail(`Which numeric column should I use for ${m.label}?`);
      if(m.metric==='percentage'&&!m.where?.length)fail(`Which records should count toward ${m.label}, and what should they be compared against?`);
      return {...m,fieldDef:field,matches:compileConditions(m.where,defs,core,today,records),type:m.metric==='percentage'?'percent':['count','count_distinct'].includes(m.metric)?'number':field.type};
    });
    if(spec.chart==='stage'&&(measures.length!==1||spec.splitBy))fail('A stage chart needs one measure and no split series. Which measure should I use, or would you prefer a bar chart?');
    if(spec.chart!=='kpi'&&new Set(measures.map(m=>m.type)).size>1)fail('These measures have different units. Use separate KPI cards or choose measures with the same units for one chart.');
    const matches=compileConditions(spec.where,defs,core,today,records),visible=new Set(options.visibleIds||[]);
    const selections=[['owners',core.role('owner')],['accounts',core.role('primary')]].map(([key,field])=>{
      const values=spec[key];if(values!=null&&(!field||!Array.isArray(values)||values.length>2000||values.some(v=>typeof v!=='string')))fail('Choose valid record or owner selections.');return {field,values:values==null?null:new Set(values.map(norm))};
    });
    // Shared non-percentage filters describe the report cohort, not empty categories.
    // Keep percentage denominators and intentionally different measure cohorts intact.
    const sharedMeasureFilter=measures.every(m=>m.metric!=='percentage'&&m.where.length&&JSON.stringify(m.where)===JSON.stringify(measures[0].where))?measures[0].matches:()=>true;
    const rows=records.filter(r=>(spec.scope==='all'||visible.has(r.id))&&matches(r)&&sharedMeasureFilter(r)&&selections.every(s=>s.values===null||s.values.has(norm(r[s.field]))));
    const groups=new Map(),series=new Map();let undated=0;
    for(const row of rows){
      const bucket=spec.bucket!=='none'?dateBucket(row[spec.groupBy],spec.bucket,core):null;
      if(spec.bucket!=='none'&&bucket===null){undated++;continue;}
      const raw=spec.groupBy===null?'All records':bucket??row[spec.groupBy],label=blank(raw)?'Not set':String(raw),key=spec.groupBy===null?'all':blank(raw)?'blank:':'value:'+norm(raw);
      const split=spec.splitBy?row[spec.splitBy]:null,seriesKey=spec.splitBy?(blank(split)?'blank:':'value:'+norm(split)):'all';
      if(!series.has(seriesKey))series.set(seriesKey,spec.splitBy?(blank(split)?'Not set':String(split)):null);
      if(!groups.has(key))groups.set(key,{label,raw,rows:[],parts:new Map()});
      const g=groups.get(key);g.rows.push(row);if(!g.parts.has(seriesKey))g.parts.set(seriesKey,[]);g.parts.get(seriesKey).push(row);
    }
    if(spec.groupBy===null&&!groups.size)groups.set('all',{label:'All records',rows:[],parts:new Map()});
    // Keep calendar intervals evenly spaced; empty intervals contain no invented amounts.
    if(spec.bucket!=='none'&&groups.size){
      const labels=[...groups.values()].map(g=>g.label).sort(),first=labels[0],last=labels.at(-1);
      const start=spec.bucket==='quarter'?`${first.slice(0,4)}-${String((Number(first.at(-1))-1)*3+1).padStart(2,'0')}-01`:spec.bucket==='year'?first+'-01-01':spec.bucket==='month'?first+'-01':first;
      const cursor=core.date(start);let steps=0;
      while(cursor){
        const label=dateBucket(cursor.toISOString().slice(0,10),spec.bucket,core);if(label>last)break;
        if(++steps>4000)fail('This date range has more than 4,000 intervals. Would you prefer a shorter range or a larger time bucket?');
        const key='value:'+norm(label);if(!groups.has(key))groups.set(key,{label,raw:label,rows:[],parts:new Map()});
        if(spec.bucket==='year')cursor.setUTCFullYear(cursor.getUTCFullYear()+1);
        else if(['month','quarter'].includes(spec.bucket))cursor.setUTCMonth(cursor.getUTCMonth()+(spec.bucket==='quarter'?3:1));
        else cursor.setUTCDate(cursor.getUTCDate()+(spec.bucket==='week'?7:1));
      }
    }
    if(!spec.splitBy&&!series.size)series.set('all',null);
    if(series.size*measures.length>24)fail('This would create more than 24 series. Which categories or measures should I compare?');
    function aggregate(part,m){
      const selected=part.filter(m.matches);if(m.metric==='count')return selected.length;
      if(m.metric==='percentage')return part.length?selected.length/part.length*100:null;
      const values=selected.map(r=>r[m.field]).filter(v=>!blank(v));
      if(m.metric==='count_distinct')return new Set(values.map(norm)).size;
      const nums=values.filter(v=>(typeof v==='number'||typeof v==='string')&&Number.isFinite(Number(v))).map(Number);
      if(!nums.length)return null;
      if(m.metric==='min')return Math.min(...nums);if(m.metric==='max')return Math.max(...nums);
      if(m.metric==='median'){nums.sort((a,b)=>a-b);const mid=Math.floor(nums.length/2);return nums.length%2?nums[mid]:(nums[mid-1]+nums[mid])/2;}
      const total=nums.reduce((sum,v)=>sum+(m.type==='currency'?Math.round(v*100):v),0)/(m.type==='currency'?100:1);
      return total/(m.metric==='average'?nums.length:1);
    }
    let data=[...groups.values()].map(g=>({...g,value:aggregate(g.rows,measures[0])}));
    const compare=(a,b)=>typeof a.raw==='number'&&typeof b.raw==='number'?a.raw-b.raw:a.label.localeCompare(b.label,undefined,{numeric:true,sensitivity:'base'});
    data.sort((a,b)=>spec.sort.startsWith('label')?compare(a,b)*(spec.sort==='label_desc'?-1:1):a.value==null?b.value==null?compare(a,b):1:b.value==null?-1:(a.value-b.value)*(spec.sort==='value_desc'?-1:1)||compare(a,b));
    const totalGroups=data.length;if(spec.limit)data=data.slice(0,spec.limit);
    if(data.length*Math.max(1,series.size)*measures.length>4000)fail('This chart would have more than 4,000 points. Which date range, categories or top groups should I show?');
    const datasets=[],table=[];
    for(const [key,seriesLabel]of series)for(const m of measures){
      const label=seriesLabel===null?m.label:`${seriesLabel} / ${m.label}`;
      const values=data.map(g=>{const part=g.parts.get(key)||[],value=aggregate(part,m);table.push({group:g.label,series:label,value,count:part.filter(m.matches).length,type:m.type});return value;});
      if(spec.chart==='stage'&&values.some(v=>v!==null&&v<0))fail('A stage chart cannot represent negative values. Would you like a bar chart instead?');
      datasets.push({label,values,type:m.type});
    }
    const represented=data.flatMap(g=>g.rows);
    return {labels:data.map(g=>g.label),datasets,table,rows,count:rows.length,representedIds:represented.map(r=>r.id),summaries:measures.map(m=>({label:m.label,metric:m.metric,field:m.field,type:m.type,value:aggregate(represented,m),count:represented.filter(m.matches).length})),undated,totalGroups,shownGroups:data.length,description:describe(spec,core,custom),title:spec.title.trim()||measures.map(m=>m.label).join(' / ')+(spec.groupBy?' by '+defs.get(spec.groupBy).name:'')};
  }
  function describe(spec,core,custom=[]){
    const fields=core.fieldsFor(custom),groups=g=>describeConditions(g,fields);
    const parts=[spec.scope==='all'?'All table records':'Current pipeline view'];
    if(spec.where.length)parts.push(groups(spec.where));
    for(const m of spec.measures)if(m.where.length)parts.push(`${m.label}: ${groups(m.where)}${m.metric==='percentage'?' / all matching records in each group':''}`);
    for(const [key,role]of [['owners','owner'],['accounts','primary']])if(spec[key]!=null)parts.push(`${fields[core.role(role)]}: ${spec[key].join(', ')||'none'}`);
    if(spec.bucket!=='none')parts.push(`${spec.bucket} by ${fields[spec.groupBy]}`);
    if(spec.splitBy)parts.push('Split by '+fields[spec.splitBy]);
    if(spec.limit)parts.push(`First ${spec.limit} groups (${spec.sort.replaceAll('_',' ')})`);
    return parts.join('; ');
  }
  function selections(spec,core){
    const next=JSON.parse(JSON.stringify(spec));
    for(const [key,role]of [['owners','owner'],['accounts','primary']]){
      const field=core.role(role);if(!field||!next.where.length||next[key]!=null)continue;
      const found=next.where.map(group=>group.find(c=>c.field===field&&['equals','in'].includes(c.operator)));
      if(found.some(c=>!c))continue;
      const values=c=>c.operator==='in'?c.values:[c.value],signature=c=>JSON.stringify(values(c).map(norm).sort());
      if(found.some(c=>signature(c)!==signature(found[0])))continue;
      if(values(found[0]).some(v=>typeof v!=='string'))continue;
      next[key]=values(found[0]);next.where=next.where.map((g,i)=>g.filter(c=>c!==found[i]));
      if(next.where.some(g=>!g.length))next.where=[];
    }
    return next;
  }
  return {execute,responseSchema,refinementSchema,filteringSchema,filteringRefinement,readActionSchemas,queryRecords,kpiReport,auditRecords,describeAudit,refine,refineTableFilter,tableMatches,tableFilterDescription,describe,selections,metrics,buckets,operators,names};
});
