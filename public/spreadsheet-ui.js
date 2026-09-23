(function(root){
  'use strict';
  const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  root.PipeChatSpreadsheetUI=function(api){
    let session=null;
    function cancelWork(){if(!session)return;session.version++;session.abort?.abort();session.worker?.terminate();session.worker=null;session.reject?.(new Error('Cancelled'));session.reject=null;}
    function close(result=null){if(!session)return;const done=session.resolve;cancelWork();session=null;$('spreadsheetDialog').close();$('spreadsheetFile').value='';$('googleSheetUrl').value='';$('sheetPreview').innerHTML='';done(result);}
    function pane(link){if(!session)return;cancelWork();session.matrix=null;session.file=null;$('sheetReview').hidden=true;$('sheetContinueBtn').disabled=true;$('sheetStatus').textContent='';$('sheetFilePane').hidden=link;$('sheetLinkForm').hidden=!link;$('sheetFileTab').classList.toggle('active',!link);$('sheetLinkTab').classList.toggle('active',link);$('sheetFileTab').setAttribute('aria-pressed',String(!link));$('sheetLinkTab').setAttribute('aria-pressed',String(link));}
    function show(result){
      session.matrix=result.matrix;session.name=result.selected||session.file?.name||'Google Sheets';
      $('sheetReview').hidden=!result.names?.length;$('sheetSelect').innerHTML=(result.names||[]).map(n=>`<option>${esc(n)}</option>`).join('');$('sheetSelect').value=result.selected||'';$('sheetSelect').disabled=result.names?.length<2;
      $('sheetStatus').textContent=result.error||'';$('sheetContinueBtn').disabled=!result.matrix;
      if(!result.matrix){$('sheetPreview').innerHTML='';$('sheetSummary').textContent='';return;}
      const [headers,...rows]=result.matrix;
      $('sheetPrimary').innerHTML=headers.map((h,i)=>`<option value="${i}">${i+1}: ${esc(h||'(blank header)')}</option>`).join('');
      $('sheetSummary').textContent=`${rows.length} rows / ${headers.length} columns${rows.length>20?' / first 20 rows shown':''}`;
      $('sheetPreview').innerHTML='<table><thead><tr>'+headers.map(h=>`<th>${esc(h)}</th>`).join('')+'</tr></thead><tbody>'+rows.slice(0,20).map(row=>'<tr>'+row.map(value=>`<td>${esc(value)}</td>`).join('')+'</tr>').join('')+'</tbody></table>';
    }
    async function file(file,sheet){
      if(!session||!file)return;cancelWork();const current=session,version=current.version;
      current.file=file;current.matrix=null;$('sheetContinueBtn').disabled=true;$('sheetReview').hidden=true;$('sheetStatus').textContent='Reading spreadsheet...';
      try{
        if(file.size>root.PipeChatSheets.maxBytes)throw new Error('Choose a file smaller than 5 MB.');
        const buffer=await file.arrayBuffer();if(current!==session||version!==current.version)return;
        const result=await new Promise((resolve,reject)=>{
          const worker=new Worker('/spreadsheet-worker.js');current.worker=worker;
          const timer=setTimeout(()=>finish(new Error('This workbook took too long to read. Export a smaller worksheet.')),20000);
          function finish(error,value){clearTimeout(timer);worker.terminate();current.worker=null;current.reject=null;error?reject(error):resolve(value);}
          current.reject=error=>finish(error);worker.onmessage=e=>finish(null,e.data);worker.onerror=()=>finish(new Error('Unable to read this workbook. Try an Excel or CSV export.'));worker.postMessage({buffer,name:file.name,sheet},[buffer]);
        });
        if(current===session&&version===current.version)show(result);
      }catch(error){if(current===session&&version===current.version)$('sheetStatus').textContent=error.message;}
    }
    $('spreadsheetFile').onchange=()=>{const selected=$('spreadsheetFile').files[0];$('spreadsheetFile').value='';file(selected);};
    $('sheetSelect').onchange=()=>file(session?.file,$('sheetSelect').value);
    $('sheetFileTab').onclick=()=>pane(false);$('sheetLinkTab').onclick=()=>pane(true);
    $('sheetCancelBtn').onclick=()=>close();$('sheetCloseBtn').onclick=()=>close();$('spreadsheetDialog').oncancel=event=>{event.preventDefault();close();};
    $('sheetLinkForm').onsubmit=async event=>{
      event.preventDefault();if(!session)return;cancelWork();const current=session,version=current.version;
      current.file=null;current.matrix=null;current.abort=new AbortController();$('sheetContinueBtn').disabled=true;$('sheetReview').hidden=true;$('sheetStatus').textContent='Loading Google Sheets...';
      try{const result=await api('/api/import/google-sheet',{method:'POST',body:JSON.stringify({url:$('googleSheetUrl').value}),signal:current.abort.signal});if(current!==session||version!==current.version)return;show({names:['Google Sheets'],selected:'Google Sheets',matrix:root.PipeChatSheets.fromCsv(result.text,Papa)});}
      catch(error){if(current===session&&version===current.version)$('sheetStatus').textContent=error.message;}
    };
    $('sheetContinueBtn').onclick=()=>{if(session?.matrix)close({matrix:session.matrix,name:session.name,primary:Number($('sheetPrimary').value)});};
    return {open(mode){if(session)return Promise.resolve(null);return new Promise(resolve=>{session={resolve,version:0,matrix:null,file:null};pane(false);$('spreadsheetTitle').textContent=mode==='setup'?'Build from a spreadsheet':'Import CSV or spreadsheet';$('primaryColumnLabel').hidden=mode!=='setup';$('sheetContinueBtn').textContent=mode==='setup'?'Review table':'Analyze column mapping';$('spreadsheetDialog').showModal();$('spreadsheetFile').focus();});},close};
  };
})(window);
