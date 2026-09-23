(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatDashboardPDF=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const palette=['#edf5f3','#f0edfa','#fff4df','#f9edf1'];
  const text=value=>String(value??'');
  function definition(snapshot){
    // All customer content is literal text, never a pdfmake node, URL or file path.
    const kpis=(snapshot.kpis||[]).map(k=>({label:text(k.label),value:text(k.value)}));
    const content=[{text:'PipeChat',fontSize:12,bold:true,color:'#287e76'},{text:text(snapshot.workspace)+' | Dashboard',style:'title'},
      {text:'Exported '+text(snapshot.exportedAt),style:'muted',margin:[0,0,0,8]},
      ...(snapshot.filters||[]).map(f=>({text:text(f),style:'muted',margin:[0,0,0,3]}))];
    if(kpis.length){
      const body=[];
      for(let i=0;i<kpis.length;i+=3)body.push(Array.from({length:3},(_,j)=>kpis[i+j]?{fillColor:palette[(i+j)%palette.length],margin:[7,7,7,7],stack:[{text:kpis[i+j].label,fontSize:10,color:'#495366'},{text:kpis[i+j].value,fontSize:19,bold:true,margin:[0,4,0,0]}]}:{text:''}));
      content.push({table:{widths:['*','*','*'],body},layout:'noBorders',margin:[0,12,0,14]});
    }
    content.push({text:text(snapshot.title),style:'heading',margin:[0,6,0,8]});
    if(snapshot.chart){
      if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(snapshot.chart))throw new Error('Invalid dashboard chart image.');
      content.push({image:snapshot.chart,fit:[760,190],alignment:'center',margin:[0,0,0,12]});
    }
    if(snapshot.chartKpis?.length)content.push({table:{widths:['*','auto'],body:snapshot.chartKpis.map(k=>[{text:text(k.label)},{text:text(k.value),bold:true}])},layout:'lightHorizontalLines',margin:[0,0,0,12]});
    content.push({text:text(snapshot.caption),style:'muted',margin:[0,0,0,10]});
    const headings=(snapshot.headings||[]).map(text),rows=(snapshot.rows||[]).map(r=>headings.map((_,i)=>({text:text(r[i]),margin:[0,4,0,4]})));
    if(headings.length)content.push({table:{headerRows:1,widths:headings.map((_,i)=>i===0?'*':145),body:[headings.map(h=>({text:h,bold:true,fillColor:'#eaf0f4',margin:[0,5,0,5]})),...rows]},layout:'lightHorizontalLines'});
    return {pageSize:'A4',pageOrientation:'landscape',pageMargins:[36,30,36,36],info:{title:text(snapshot.workspace)+' dashboard',creator:'PipeChat'},defaultStyle:{font:'Roboto',fontSize:10,color:'#1d2939'},styles:{title:{fontSize:22,bold:true,margin:[0,5,0,4]},heading:{fontSize:14,bold:true},muted:{fontSize:9,color:'#596579'}},content,footer:(page,total)=>({text:`PipeChat  |  ${page} / ${total}`,alignment:'right',fontSize:8,color:'#596579',margin:[36,10,36,0]})};
  }
  function capture(doc,filters=[],now=new Date()){
    const $=id=>doc.getElementById(id),cards=selector=>Array.from(doc.querySelectorAll(selector),el=>({label:el.querySelector('span')?.textContent||'',value:el.querySelector('strong')?.textContent||''}));
    if($('dashboardView').hidden)throw new Error('Open the dashboard before exporting.');
    return {workspace:$('workspaceTitle').textContent,title:$('reportTitle').textContent,exportedAt:now.toLocaleString(),filters:[...filters],kpis:cards('.metrics > div'),chart:$('chartContainer').hidden?null:$('reportCanvas').toDataURL('image/png'),chartKpis:$('reportKpis').hidden?[]:cards('#reportKpis > div'),caption:$('reportCaption').textContent,headings:Array.from(doc.querySelectorAll('.report-table th'),el=>el.textContent),rows:Array.from($('reportRows').querySelectorAll('tr'),tr=>Array.from(tr.cells,td=>td.textContent))};
  }
  let library;
  function load(doc){
    if(!library)library=(async()=>{
      for(const src of ['/vendor/pdfmake-0.3.11.min.js','/vendor/pdfmake-0.3.11-fonts.js'])await new Promise((resolve,reject)=>{
        const script=doc.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('PDF tools could not load. Please try again.'));};doc.head.appendChild(script);
      });
    })().catch(error=>{library=null;throw error;});
    return library;
  }
  async function download(snapshot,stillSignedIn=()=>true){
    await load(document);
    const blob=await window.pdfMake.createPdf(definition(snapshot)).getBlob();
    if(!stillSignedIn())return false;
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='pipechat-dashboard-'+new Date().toISOString().slice(0,10)+'.pdf';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);return true;
  }
  return {definition,capture,download};
});
