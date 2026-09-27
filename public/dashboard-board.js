(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./report-engine'):root.PipeChatReports);if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatDashboard=api;})(typeof globalThis!=='undefined'?globalThis:this,function(R){
  'use strict';
  const clone=v=>JSON.parse(JSON.stringify(v)),bad=m=>{throw new Error(m);};
  const obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const id={type:'string',pattern:'^[a-z][a-z0-9_-]{0,47}$'},ids={type:'array',minItems:1,maxItems:12,items:id};
  const identifier=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(v);
  function shape(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))bad('Please use complete, supported dashboard properties.');}
  function list(values){if(!Array.isArray(values)||!values.length||values.length>12||values.some(v=>!identifier(v))||new Set(values).size!==values.length)bad('Choose distinct dashboard element IDs.');return values;}
  function schemas(core,custom=[]){
    const spec=R.responseSchema(core,custom).anyOf[1],refine=R.refinementSchema(core,custom),p=refine.properties;
    const measure={type:'integer',minimum:0,maximum:5};
    const reference={anyOf:[obj({elementId:id,measure,stat:{type:'string',enum:['records','aggregate','maximum','minimum_nonzero']}}),obj({elementId:id,measure,stat:{type:'string',enum:['group']},group:{type:'string',maxLength:300},series:{type:['string','null'],maxLength:300}})]};
    const question={anyOf:[obj({kind:{type:'string',enum:['summary']},elementIds:ids}),obj({kind:{type:'string',enum:['groups']},elementId:id,measure}),obj({kind:{type:'string',enum:['value']},label:{type:'string',maxLength:200},reference}),obj({kind:{type:'string',enum:['difference','percentage']},label:{type:'string',maxLength:200},left:reference,right:reference})]};
    const questions={type:'array',maxItems:20,items:question};
    return [obj({action:{type:'string',enum:['dashboard_plan']},operations:{type:'array',minItems:1,maxItems:24,items:{anyOf:[
      obj({op:{type:'string',enum:['clear']}}),
      obj({op:{type:'string',enum:['add']},id,spec}),
      obj({op:{type:'string',enum:['update']},ids,mode:p.mode,where:p.where,replaceFields:p.replaceFields,changes:{...p.changes,minItems:0}}),
      obj({op:{type:'string',enum:['remove']},ids}),
      obj({op:{type:'string',enum:['set_shared_filter']},id,targets:ids,where:spec.properties.where}),
      obj({op:{type:'string',enum:['remove_shared_filter']},id})
    ]}},questions}),obj({action:{type:'string',enum:['analyze_dashboard']},questions:{...questions,minItems:1}})];
  }
  function empty(){return {version:1,elements:[],sharedFilters:[],activeId:null};}
  function validate(board){
    shape(board,['version','elements','sharedFilters','activeId']);
    if(board.version!==1||!Array.isArray(board.elements)||board.elements.length>12||!Array.isArray(board.sharedFilters)||board.sharedFilters.length>12||JSON.stringify(board).length>24000)bad('Keep this dashboard to twelve elements and twelve shared filters.');
    const seen=new Set();for(const e of board.elements){shape(e,['id','spec','visibleIds']);if(!identifier(e.id)||seen.has(e.id)||!Array.isArray(e.visibleIds)||e.visibleIds.length>2000||e.visibleIds.some(id=>!Number.isSafeInteger(id)||id<1))bad('The dashboard has an invalid or duplicated element ID.');seen.add(e.id);}
    const filters=new Set();for(const f of board.sharedFilters){shape(f,['id','targets','where']);if(!identifier(f.id)||filters.has(f.id)||list(f.targets).some(id=>!seen.has(id)))bad('A shared filter refers to an unavailable dashboard element.');filters.add(f.id);}
    if(board.activeId!==null&&!seen.has(board.activeId))bad('Choose an existing active dashboard element.');
    return board;
  }
  function intersect(left,right){if(!right.length)return clone(left);if(!left.length)return clone(right);if(left.length*right.length>12)bad('The combined dashboard filter is too complex. Please simplify the alternatives.');return left.flatMap(a=>right.map(b=>[...a,...b]));}
  function evaluate(board,records,core,custom=[],options={}){
    validate(board);
    // Validate every filter even when no graph currently has matching records.
    for(const f of board.sharedFilters)R.tableMatches({where:f.where},core,custom,records,options.today);
    return board.elements.map(e=>{
      let spec=clone(e.spec);const filters=board.sharedFilters.filter(f=>f.targets.includes(e.id));
      for(const f of filters)spec.where=intersect(spec.where,f.where);
      const {rows:unusedRows,...result}=R.execute(records,spec,core,custom,{...options,visibleIds:e.visibleIds});
      const snapshot={id:e.id,title:result.title,chart:spec.chart,groupBy:spec.groupBy?core.fieldsFor(custom)[spec.groupBy]:'All records',bucket:spec.bucket,scope:result.description,sharedFilters:filters.map(f=>({id:f.id,description:R.tableFilterDescription({where:f.where},core,custom)})),matchingCount:result.count,recordCount:result.representedIds.length,recordIds:result.representedIds,undated:result.undated,shownGroups:result.shownGroups,totalGroups:result.totalGroups,table:result.table,summaries:result.summaries};
      return {id:e.id,spec,result,snapshot};
    });
  }
  function format(value,type='number'){return value===null?'Not set':new Intl.NumberFormat('en-US',{maximumFractionDigits:2,...(type==='currency'?{style:'currency',currency:'USD'}:{})}).format(value)+(type==='percent'?'%':'');}
  function context(board,views){
    if(!board)return null;
    return {board:clone(board),displayed:views.map(v=>{const {recordIds,table,...s}=v.snapshot;return {...s,series:[...new Set(table.map(r=>r.series))],extrema:extrema(table),table:table.length<=120?table:undefined,tableOmitted:table.length>120};}),analysisRule:'Select structured questions against these element IDs. The app computes from its cached displayed results; do not calculate or rebuild a graph to answer.'};
  }
  function extrema(table){return [...new Set(table.map(row=>row.series))].map(series=>{const rows=table.filter(r=>r.series===series&&Number.isFinite(r.value)),positive=rows.filter(r=>r.value>0),max=rows.length?Math.max(...rows.map(r=>r.value)):null,min=positive.length?Math.min(...positive.map(r=>r.value)):null;return {series,maximum:max,largest:rows.filter(r=>r.value===max).map(r=>r.group),minimumNonzero:min,smallestNonzero:positive.filter(r=>r.value===min).map(r=>r.group)};});}
  function readReference(ref,views){
    shape(ref,ref?.stat==='group'?['elementId','measure','stat','group','series']:['elementId','measure','stat']);const v=views.find(v=>v.id===ref.elementId),s=v?.snapshot;
    if(!s||!Number.isInteger(ref.measure)||ref.measure<0||ref.measure>=s.summaries.length||!['records','aggregate','maximum','minimum_nonzero','group'].includes(ref.stat))bad('Which displayed graph and measure should I analyze?');
    const m=s.summaries[ref.measure],summary=`${s.title} [${s.id}], ${s.recordCount} records, grouped by ${s.groupBy}${s.bucket==='none'?'':' / '+s.bucket}`;
    if(ref.stat==='records')return {value:s.recordCount,type:'number',unit:'records',detail:summary,ids:s.recordIds};
    if(ref.stat==='aggregate')return {value:m.value,type:m.type,unit:m.metric+':'+m.field,detail:`${m.label}: ${summary}`,ids:s.recordIds};
    // Dataset indices are explicit. A split report uses the same ordering as the rendered series.
    const series=v.result.datasets.filter((_,i)=>i%s.summaries.length===ref.measure);if(!series.length)bad('Choose a displayed series.');
    if(ref.stat==='group'){
      if(typeof ref.group!=='string'||ref.group.length>300||ref.series!==null&&(typeof ref.series!=='string'||ref.series.length>300))bad('Choose a displayed group and series.');
      const matches=s.table.filter(row=>row.group===ref.group&&series.some(d=>d.label===row.series)&&(ref.series===null||row.series===ref.series));
      if(matches.length!==1)bad('That group or series is missing or ambiguous in the displayed graph. Which plotted group should I use?');
      const row=matches[0];return {value:row.value,type:row.type,unit:m.metric+':'+m.field,detail:`${row.group} / ${row.series}, ${row.count} records in this group (${summary})`,ids:s.recordIds};
    }
    const rows=s.table.filter(row=>series.some(d=>d.label===row.series)&&Number.isFinite(row.value)&&(ref.stat!=='minimum_nonzero'||row.value!==0));
    const value=rows.length?(ref.stat==='maximum'?Math.max:Math.min)(...rows.map(r=>r.value)):null;
    return {value,type:m.type,unit:m.metric+':'+m.field,detail:`${rows.filter(r=>r.value===value).map(r=>r.group+(series.length>1?' / '+r.series:'')).join(', ')||'No qualifying group'} (${summary}; ${ref.stat==='maximum'?'largest':'smallest nonzero'} ${m.label})`,ids:s.recordIds};
  }
  function analyze(questions,views){
    if(!Array.isArray(questions)||questions.length>20)bad('Ask up to twenty dashboard questions at once.');
    const lines=[];
    for(const q of questions){
      if(q.kind==='summary'){
        shape(q,['kind','elementIds']);for(const id of list(q.elementIds)){const s=views.find(v=>v.id===id)?.snapshot;if(!s)bad('A requested report is not currently displayed.');lines.push(`${s.title} [${id}]: ${s.recordCount} records represented${s.matchingCount!==s.recordCount?` (${s.matchingCount} matched before date/group exclusions)`:''}. ${s.summaries.map(m=>`${m.label}: ${format(m.value,m.type)}`).join('; ')}. Scope: ${s.scope}.`);}
      }else if(q.kind==='groups'){
        shape(q,['kind','elementId','measure']);const v=views.find(v=>v.id===q.elementId);if(!v||!Number.isInteger(q.measure)||q.measure<0||q.measure>=v.snapshot.summaries.length)bad('Choose a displayed graph and measure for the group report.');
        const series=v.result.datasets.filter((_,i)=>i%v.snapshot.summaries.length===q.measure),rows=v.snapshot.table.filter(row=>series.some(d=>d.label===row.series));
        lines.push(`${v.snapshot.title} [${v.id}]: ${v.snapshot.recordCount} records represented. Scope: ${v.snapshot.scope}.\n${rows.map(row=>`- ${row.group}${series.length>1?' / '+row.series:''}: ${format(row.value,row.type)} (${row.count} records).`).join('\n')||'No groups.'}`);
      }else if(q.kind==='value'){
        shape(q,['kind','label','reference']);if(typeof q.label!=='string'||q.label.length>200)bad('Use a short analysis label.');const a=readReference(q.reference,views);lines.push(`${q.label}: ${format(a.value,a.type)}. ${a.detail}.`);
      }else if(['difference','percentage'].includes(q.kind)){
        shape(q,['kind','label','left','right']);if(typeof q.label!=='string'||q.label.length>200)bad('Use a short analysis label.');const a=readReference(q.left,views),b=readReference(q.right,views);
        if(a.type!==b.type||a.unit!==b.unit)bad('These statistics have different units or aggregations. Which comparable measures should I use?');
        if(q.kind==='percentage'&&q.left.stat==='records'&&a.ids.some(id=>!b.ids.includes(id)))bad('The numerator is not a subset of the denominator. Which population should define this percentage?');
        const value=a.value===null||b.value===null||q.kind==='percentage'&&b.value===0?null:q.kind==='difference'?a.value-b.value:a.value/b.value*100;
        lines.push(`${q.label}: ${format(value,q.kind==='percentage'?'percent':a.type)} (${format(a.value,a.type)} ${q.kind==='difference'?'-':'/'} ${format(b.value,b.type)}${q.kind==='percentage'?' x 100':''}).\n- ${a.detail}.\n- ${b.detail}.`);
        const left=views.find(v=>v.id===q.left.elementId).snapshot,right=views.find(v=>v.id===q.right.elementId).snapshot;
        const grouping=left.groupBy!==right.groupBy||left.bucket!==right.bucket,coverage=a.ids.length!==b.ids.length||a.ids.some(id=>!b.ids.includes(id));
        if(grouping||coverage)lines.push(`These graphs use ${grouping?'different groupings':''}${grouping&&coverage?' and ':''}${coverage?`different record coverage (${a.ids.length} versus ${b.ids.length} records)`:''}.`);
      }else bad('Which supported dashboard statistic should I calculate?');
    }
    return lines.join('\n\n')+'\n\nCalculated from the displayed graph results. No CRM data or saved KPI cards were changed.';
  }
  function apply(current,action,records,core,custom=[],options={}){
    shape(action,['action','operations','questions']);if(action.action!=='dashboard_plan'||!Array.isArray(action.operations)||!action.operations.length||action.operations.length>24)bad('Supply a bounded dashboard plan.');
    const next=clone(current||empty());validate(next);
    for(const op of action.operations){
      if(op.op==='clear'){shape(op,['op']);next.elements=[];next.sharedFilters=[];next.activeId=null;}
      else if(op.op==='add'){
        shape(op,['op','id','spec']);if(!identifier(op.id)||next.elements.some(e=>e.id===op.id))bad('Each new graph needs a new unique ID.');
        R.execute(records,op.spec,core,custom,options);next.elements.push({id:op.id,spec:clone(op.spec),visibleIds:op.spec.scope==='visible'?[...(options.visibleIds||[])]:[]});next.activeId=op.id;
      }else if(op.op==='update'){
        shape(op,['op','ids','mode','where','replaceFields','changes']);for(const id of list(op.ids)){const e=next.elements.find(e=>e.id===id);if(!e)bad('Choose an existing graph to update.');e.spec=R.refine(e.spec,{action:'refine_report',mode:op.mode,where:op.where,replaceFields:op.replaceFields,changes:op.changes},core,custom,{...options,records,visibleIds:e.visibleIds});}
      }else if(op.op==='remove'){
        shape(op,['op','ids']);if(list(op.ids).some(id=>!next.elements.some(e=>e.id===id)))bad('Choose existing graphs to remove.');next.elements=next.elements.filter(e=>!op.ids.includes(e.id));next.sharedFilters=next.sharedFilters.map(f=>({...f,targets:f.targets.filter(id=>!op.ids.includes(id))})).filter(f=>f.targets.length);if(op.ids.includes(next.activeId))next.activeId=next.elements[0]?.id||null;
      }else if(op.op==='set_shared_filter'){
        shape(op,['op','id','targets','where']);if(!identifier(op.id)||!op.where?.length||list(op.targets).some(id=>!next.elements.some(e=>e.id===id)))bad('Choose existing elements and explicit conditions for the shared filter.');R.tableMatches({where:op.where},core,custom,records,options.today);
        const f={id:op.id,targets:clone(op.targets),where:clone(op.where)},index=next.sharedFilters.findIndex(f=>f.id===op.id);if(index<0)next.sharedFilters.push(f);else next.sharedFilters[index]=f;
      }else if(op.op==='remove_shared_filter'){
        shape(op,['op','id']);if(!next.sharedFilters.some(f=>f.id===op.id))bad('That shared filter is not active.');next.sharedFilters=next.sharedFilters.filter(f=>f.id!==op.id);
      }else bad('That dashboard operation is not supported.');
      validate(next);
    }
    const views=evaluate(next,records,core,custom,options);
    const questions=action.questions.length?action.questions:next.elements.length?[{kind:'summary',elementIds:next.elements.map(e=>e.id)}]:[];
    const answer=analyze(questions,views);
    return {board:next,views,answer};
  }
  return {empty,validate,schemas,evaluate,apply,analyze,context,format};
});
