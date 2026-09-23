(function(root){
  'use strict';
  const R=root.PipeChatReports;
  function draw({spec,result,core,custom,document,esc,Chart}){
    const $=id=>document.getElementById(id),defs=core.definitions(custom),first=spec.measures[0];
    const format=(v,type)=>v==null?'Not set':new Intl.NumberFormat('en-US',{maximumFractionDigits:4,...(type==='currency'?{style:'currency',currency:'USD',maximumFractionDigits:2}:{})}).format(v)+(type==='percent'?'%':'');
    $('reportMetric').innerHTML=R.metrics.map(id=>`<option value="${id}">${R.names[id]}</option>`).join('');$('reportMetric').value=first.metric;
    $('reportFieldLabel').hidden=false;
    $('reportField').innerHTML='<option value="">No field</option>'+defs.filter(f=>first.metric==='count_distinct'||['number','currency'].includes(f.type)).map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join('');
    $('reportField').value=first.field||'';$('reportField').disabled=['count','percentage'].includes(first.metric);
    $('reportGroup').innerHTML='<option value="none">All records</option>'+defs.flatMap(f=>[{value:f.id,label:f.name},...(f.type==='date'?R.buckets.filter(b=>b!=='none').map(b=>({value:f.id+'::'+b,label:f.name+' / '+b})):[])]).map(g=>`<option value="${g.value}">${esc(g.label)}</option>`).join('');
    $('reportGroup').value=spec.groupBy?(spec.groupBy+(spec.bucket==='none'?'':'::'+spec.bucket)):'none';$('reportChart').value=spec.chart;
    $('reportTitle').textContent=result.title;$('reportGroupHeading').textContent=spec.groupBy?core.fieldsFor(custom)[spec.groupBy]:'All records';$('reportValueHeading').textContent='Measure / Value';document.querySelector('.report-table th:last-child').textContent='Records';
    $('reportRows').innerHTML=result.table.map(row=>`<tr><td>${esc(row.group)}</td><td>${esc(row.series)}: ${esc(format(row.value,row.type))}</td><td>${row.count}</td></tr>`).join('')||'<tr><td colspan="3">No matching records.</td></tr>';
    $('reportCaption').textContent=`${result.count} matching records. ${result.description}. Missing numeric values are excluded, not treated as zero.${result.undated?' '+result.undated+' undated records excluded from date groups.':''}${result.shownGroups<result.totalGroups?` Showing ${result.shownGroups} of ${result.totalGroups} groups.`:''}`;
    $('chartContainer').hidden=spec.chart==='kpi';$('reportKpis').hidden=spec.chart!=='kpi';
    $('reportKpis').innerHTML=result.table.map(row=>`<div><span>${esc(row.group)} / ${esc(row.series)}</span><strong>${esc(format(row.value,row.type))}</strong></div>`).join('')||'<p>No matching records.</p>';
    $('reportCanvas').setAttribute('aria-label',result.title+'. '+result.table.map(r=>`${r.group}, ${r.series}: ${format(r.value,r.type)}`).join('; '));
    if(spec.chart==='kpi'||!Chart)return null;
    const colors=['#7465cb','#238c78','#b37c21','#cb6179','#417bbe','#78923a','#996ca4','#50757a'];
    const horizontal=spec.chart==='bar';$('chartContainer').style.height=(horizontal?Math.min(12000,Math.max(280,result.labels.length*Math.max(32,result.datasets.length*16)+60)):360)+'px';
    return new Chart($('reportCanvas'),{
      type:spec.chart==='stage'?'doughnut':spec.chart,
      data:{labels:result.labels,datasets:result.datasets.map((s,i)=>({label:s.label,data:s.values,backgroundColor:spec.chart==='stage'?colors:colors[i%colors.length],borderColor:colors[i%colors.length],borderWidth:spec.chart==='line'?2:0,borderRadius:horizontal?3:0,maxBarThickness:30,tension:0,spanGaps:false,pointRadius:3}))},
      options:{responsive:true,maintainAspectRatio:false,animation:false,indexAxis:horizontal?'y':'x',
        plugins:{legend:{display:spec.chart==='stage'||result.datasets.length>1,position:'bottom'},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${format(ctx.raw,result.datasets[ctx.datasetIndex].type)}`}}},
        ...(spec.chart==='stage'?{cutout:'60%'}:{scales:{x:{beginAtZero:true,ticks:{autoSkip:!horizontal,font:{size:11}}},y:{beginAtZero:true,ticks:{autoSkip:false,font:{size:11}}}}})
      }
    });
  }
  function control(spec,id,value,core,custom){
    const next=JSON.parse(JSON.stringify(spec)),m=next.measures[0],defs=core.definitions(custom);
    next.title='';
    if(id==='reportChart')next.chart=value;
    if(id==='reportGroup'){const [field,bucket]=value.split('::');next.groupBy=field==='none'?null:field;next.bucket=bucket||'none';next.sort=next.bucket==='none'?'value_desc':'label_asc';}
    if(id==='reportMetric'){
      m.metric=value;
      if(['count','percentage'].includes(value))m.field=null;
      else if(!defs.some(f=>f.id===m.field&&(value==='count_distinct'||['number','currency'].includes(f.type))))m.field=(value==='count_distinct'?defs[0]:defs.find(f=>['number','currency'].includes(f.type)))?.id||null;
    }
    if(id==='reportField')m.field=value||null;
    if(['reportMetric','reportField'].includes(id))m.label=R.names[m.metric]+(m.field?' '+defs.find(f=>f.id===m.field)?.name:'');
    return next;
  }
  root.PipeChatReportsUI={draw,control};
})(typeof globalThis!=='undefined'?globalThis:this);
