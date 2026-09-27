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
  function drawBoard({host,views,board,esc,Chart,document,onSelect,onRemove,icon}){
    const charts=[];
    host.innerHTML='';
    const ordered=[...views.filter(v=>v.spec.chart==='kpi'),...views.filter(v=>v.spec.chart!=='kpi')];
    for(const v of ordered){
      const s=v.snapshot,section=document.createElement('section');section.className='dashboard-element'+(v.spec.chart==='kpi'?' dashboard-element-kpi':'');section.dataset.elementId=v.id;
      section.innerHTML=`<header><div><h4>${esc(s.title)}</h4><span class="subtle">${esc(v.id)} / ${esc(v.spec.chart)} / ${s.recordCount} records</span></div><div class="dashboard-element-actions"><button type="button" class="icon-btn" data-edit-report title="Edit graph controls" aria-label="Edit ${esc(s.title)} controls">${icon('ListFilter')}</button><button type="button" class="icon-btn" data-remove-report title="Remove graph" aria-label="Remove ${esc(s.title)}">${icon('X')}</button></div></header><p class="dashboard-element-scope">${esc(s.scope)}</p>${s.sharedFilters.map(f=>`<p class="dashboard-shared-filter">Shared filter ${esc(f.id)}: ${esc(f.description)}</p>`).join('')}${s.undated?`<p class="subtle">${s.undated} blank dates excluded from date groups.</p>`:''}<div class="dashboard-element-visual"></div><details class="dashboard-element-data"><summary>Data / ${s.recordCount} records</summary><div class="report-table-wrap"><table><thead><tr><th>${esc(s.groupBy)}</th><th>Measure</th><th>Value</th><th>Records</th></tr></thead><tbody>${s.table.map(r=>`<tr><td>${esc(r.group)}</td><td>${esc(r.series)}</td><td>${esc(root.PipeChatDashboard.format(r.value,r.type))}</td><td>${r.count}</td></tr>`).join('')}</tbody></table></div></details>`;
      section.querySelector('[data-edit-report]').onclick=()=>onSelect(v.id);section.querySelector('[data-remove-report]').onclick=()=>onRemove(v.id);
      host.append(section);
      const visual=section.querySelector('.dashboard-element-visual');
      if(v.spec.chart==='kpi')visual.innerHTML=s.table.map(r=>`<div class="dashboard-kpi-result"><span>${esc(r.series)}</span><strong>${esc(root.PipeChatDashboard.format(r.value,r.type))}</strong></div>`).join('');
      else{
        const canvas=document.createElement('canvas');canvas.setAttribute('role','img');canvas.setAttribute('aria-label',s.title+'. '+s.table.map(r=>`${r.group}, ${r.series}: ${root.PipeChatDashboard.format(r.value,r.type)}`).join('; '));visual.append(canvas);
        visual.style.height=(v.spec.chart==='bar'?Math.min(12000,Math.max(260,v.result.labels.length*Math.max(30,v.result.datasets.length*16)+65)):320)+'px';
        if(Chart){const colors=['#287e76','#417bbe','#b37c21','#cb6179','#7465cb','#78923a'],horizontal=v.spec.chart==='bar';charts.push(new Chart(canvas,{type:v.spec.chart==='stage'?'doughnut':v.spec.chart,data:{labels:v.result.labels,datasets:v.result.datasets.map((d,i)=>({label:d.label,data:d.values,backgroundColor:v.spec.chart==='stage'?colors:colors[i%colors.length],borderColor:colors[i%colors.length],borderWidth:horizontal?0:2,borderRadius:horizontal?3:0,maxBarThickness:30,tension:0,spanGaps:false,pointRadius:3}))},options:{responsive:true,maintainAspectRatio:false,animation:false,indexAxis:horizontal?'y':'x',plugins:{legend:{display:v.spec.chart==='stage'||v.result.datasets.length>1,position:'bottom'},tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${root.PipeChatDashboard.format(c.raw,v.result.datasets[c.datasetIndex].type)}`}}},...(v.spec.chart==='stage'?{cutout:'60%'}:{scales:{x:{beginAtZero:true,ticks:{autoSkip:!horizontal}},y:{beginAtZero:true,ticks:{autoSkip:false}}}})}}));}
      }
    }
    if(!views.length)host.innerHTML='<p class="subtle">No graphs.</p>';
    return charts;
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
  root.PipeChatReportsUI={draw,control,drawBoard};
})(typeof globalThis!=='undefined'?globalThis:this);
