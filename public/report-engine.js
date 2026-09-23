(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatReports=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const metrics=['count','sum','average','min','max','median','count_distinct','percentage'];
  const buckets=['none','day','week','month','quarter','year'];
  const operators=['equals','not_equals','in','not_in','contains','not_contains','is_blank','is_not_blank','gt','gte','lt','lte','between','before_today','older_than_days'];
  const names={count:'Record count',sum:'Total',average:'Average',min:'Minimum',max:'Maximum',median:'Median',count_distinct:'Distinct count',percentage:'Percentage'};
  const blank=v=>v==null||typeof v==='string'&&!v.trim();
  const norm=v=>String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
  const fail=message=>{throw new Error(message);};
  const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  function responseSchema(core,custom=[]){
    const ids=core.definitions(custom).map(f=>f.id),nullable={type:['string','null'],enum:[...ids,null]};
    const scalar={type:['string','number','null']};
    const conditions={type:'array',items:{type:'array',items:object({field:{type:'string',enum:ids},operator:{type:'string',enum:operators},value:scalar,values:{type:'array',items:scalar}})}};
    return {anyOf:[{type:'null'},object({version:{type:'integer',enum:[1]},title:{type:'string'},chart:{type:'string',enum:['bar','line','stage','kpi']},scope:{type:'string',enum:['all','visible']},groupBy:nullable,bucket:{type:'string',enum:buckets},splitBy:nullable,measures:{type:'array',items:object({label:{type:'string'},metric:{type:'string',enum:metrics},field:nullable,where:conditions})},where:conditions,sort:{type:'string',enum:['label_asc','label_desc','value_asc','value_desc']},limit:{type:['integer','null']}})]};
  }
  function compileConditions(groups,defs,core,today){
    if(!Array.isArray(groups)||groups.length>12)fail('Use at most 12 alternative filter groups. Which conditions matter most?');
    const compiled=groups.map(group=>{
      if(!Array.isArray(group)||!group.length||group.length>20)fail('Each filter group needs 1 to 20 conditions. Which conditions should apply together?');
      return group.map(c=>{
        const f=defs.get(c?.field);if(!f||!operators.includes(c.operator))fail('A filter refers to an unavailable field or comparison. Which current column should I use?');
        const numeric=['number','currency'].includes(f.type),dated=f.type==='date';
        const convert=v=>blank(v)?null:numeric?typeof v==='number'&&Number.isFinite(v)?v:typeof v==='string'&&Number.isFinite(Number(v))?Number(v):null:dated?core.date(v)?.getTime()??null:norm(v);
        const {operator:op}=c;
        if(!Array.isArray(c.values)||c.values.length>2000)fail('Supply a valid list of filter values.');
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
      return {...m,fieldDef:field,matches:compileConditions(m.where,defs,core,today),type:m.metric==='percentage'?'percent':['count','count_distinct'].includes(m.metric)?'number':field.type};
    });
    if(spec.chart==='stage'&&(measures.length!==1||spec.splitBy))fail('A stage chart needs one measure and no split series. Which measure should I use, or would you prefer a bar chart?');
    if(spec.chart!=='kpi'&&new Set(measures.map(m=>m.type)).size>1)fail('These measures have different units. Use separate KPI cards or choose measures with the same units for one chart.');
    const matches=compileConditions(spec.where,defs,core,today),visible=new Set(options.visibleIds||[]);
    const selections=[['owners',core.role('owner')],['accounts',core.role('primary')]].map(([key,field])=>{
      const values=spec[key];if(values!=null&&(!field||!Array.isArray(values)||values.length>2000||values.some(v=>typeof v!=='string')))fail('Choose valid record or owner selections.');return {field,values:values==null?null:new Set(values.map(norm))};
    });
    const rows=records.filter(r=>(spec.scope==='all'||visible.has(r.id))&&matches(r)&&selections.every(s=>s.values===null||s.values.has(norm(r[s.field]))));
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
    return {labels:data.map(g=>g.label),datasets,table,rows,count:rows.length,undated,totalGroups,shownGroups:data.length,description:describe(spec,core,custom),title:spec.title.trim()||measures.map(m=>m.label).join(' / ')+(spec.groupBy?' by '+defs.get(spec.groupBy).name:'')};
  }
  function describe(spec,core,custom=[]){
    const fields=core.fieldsFor(custom),groups=g=>g.map(and=>and.map(c=>`${fields[c.field]||c.field} ${c.operator.replaceAll('_',' ')} ${['in','not_in','between'].includes(c.operator)?c.values.join(', '):c.value??''}`).join(' AND ')).map(s=>'('+s+')').join(' OR ');
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
      const field=core.role(role);if(!field||!next.where.length)continue;
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
  return {execute,responseSchema,describe,selections,metrics,buckets,operators,names};
});
