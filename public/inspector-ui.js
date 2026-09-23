(function(root){
  'use strict';
  // Lucide Pencil, ISC license; see vendor/lucide-LICENSE.
  root.PipeChatIcons.Pencil='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.623l4.353-1.32a2 2 0 0 0 .83-.498z"/><path d="m15 5 4 4"/></svg>';
  root.PipeChatInspectorUI={create};
  function create({S,esc,icon,rowName,persist,refresh,toast}){
    const H=root.PipeChatInspector,$=id=>document.getElementById(id),dialog=$('inspectorDialog'),key='pipechat.inspector-drafts.v1';
    let recordId=null,returnFocus=null,limit=100,error='',needsReview=false,drafts={},identity='';
    function scope(){return S.user?JSON.stringify([S.user.id,S.user.email,S.health?.storageProvider]):'';}
    function loadDrafts(){
      if(identity===scope())return;identity=scope();drafts={};
      try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');if(saved?.identity===identity&&saved.drafts&&typeof saved.drafts==='object'){
        for(const [id,d] of Object.entries(saved.drafts))if(/^\d+$/.test(id)&&typeof d?.text==='string'&&d.text.length<=H.maxNote&&typeof d?.id==='string')drafts[id]=d;
      }}catch{}
    }
    function store(){try{sessionStorage.setItem(key,JSON.stringify({identity,drafts}));return true;}catch{return false;}}
    function input(){
      if(recordId==null)return;
      const text=$('inspectorNote').value;
      if(text)drafts[recordId]={text,id:drafts[recordId]?.id||crypto.randomUUID()};else delete drafts[recordId];
      const kept=store();$('inspectorNoteStatus').textContent=text?(kept?'Draft kept in this tab':'Draft not backed up; keep this page open'):'';controls();
    }
    function controls(){
      const locked=S.saving||S.resetting||!S.loaded||Boolean(S.failedEdit);
      $('inspectorSave').disabled=locked||needsReview||!$('inspectorNote').value.trim();$('inspectorNote').disabled=S.saving;
      $('inspectorReload').disabled=locked;$('inspectorReload').hidden=!needsReview;
      $('inspectorError').textContent=error;
    }
    function timeline(){
      const row=S.records.find(r=>r.id===recordId);if(!row)return;
      let items;try{items=H.entries(row.history,{from:$('inspectorFrom').value,to:$('inspectorTo').value,kind:$('inspectorKind').value});}
      catch(e){$('inspectorTimeline').innerHTML=`<p class="error" role="alert">${esc(e.message)}</p>`;return;}
      $('inspectorCount').textContent=`${items.length} ${items.length===1?'entry':'entries'}`;
      let last=null;
      $('inspectorTimeline').innerHTML=items.slice(0,limit).map(e=>{
        const date=e.at?H.day(e.at):'';let heading='';
        if(date!==last){last=date;heading=`<h3 class="history-day">${e.at?(date===H.day(new Date())?'Today':'')+(date===H.day(new Date())?' / ':'')+esc(new Date(e.at).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'})):'Undated activity'}</h3>`;}
        return `${heading}<article class="history-entry ${e.type}"><span class="history-symbol">${icon(e.type==='note'?'FileText':'RotateCcw')}</span><div class="history-content"><header><strong>${e.type==='note'?'Note added':'Record updated'}</strong>${e.at?`<time datetime="${esc(e.at)}">${esc(new Date(e.at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}))}</time>`:''}</header>${e.type==='note'?`<span class="history-author">${esc(e.actor)}</span>`:''}<p>${esc(e.text)}</p></div></article>`;
      }).join('')||'<p class="history-empty">No notes or activity for these dates.</p>';
      $('inspectorMore').hidden=items.length<=limit;
    }
    function draw(){
      if(!dialog.open)return;
      const row=S.records.find(r=>r.id===recordId);if(!row||!S.user){clear();return;}
      $('inspectorTitle').textContent=rowName(row);$('inspectorRecordType').textContent=root.PipelineCore.create(S.tableSchema).fieldsFor(S.customFields)[root.PipelineCore.create(S.tableSchema).role('primary')]||'Record';
      $('inspectorNote').placeholder=`Enter a note about ${rowName(row)}`;controls();timeline();
    }
    function open(id,trigger){
      if(!S.loaded||S.saving||!S.records.some(r=>r.id===id))return;
      loadDrafts();recordId=id;returnFocus=trigger;limit=100;error='';needsReview=false;
      $('inspectorFrom').value='';$('inspectorTo').value='';$('inspectorKind').value='all';
      $('inspectorNote').value=drafts[id]?.text||'';$('inspectorNoteStatus').textContent=drafts[id]?'Unsaved draft restored':'';
      if(!dialog.open)dialog.showModal();draw();$('inspectorTitle').focus();
    }
    function close(){if(S.saving)return;if(dialog.open)dialog.close();returnFocus?.isConnected&&returnFocus.focus();recordId=null;}
    function clear(){if(dialog.open)dialog.close();recordId=null;drafts={};identity='';$('inspectorNote').value='';$('inspectorTimeline').innerHTML='';try{sessionStorage.removeItem(key);}catch{}}
    async function save(event){
      event.preventDefault();if($('inspectorSave').disabled||recordId==null)return;
      if(S.pending||S.clarification){error='Confirm or cancel the current proposed changes before saving a note.';controls();return;}
      input();const id=recordId,draft=drafts[id],generation=S.generation;
      try{
        const next=H.addNote(S.records,id,draft.text,S.user.name||S.user.email,draft.id);
        if(await persist(next,'Note saved',{undo:false,verifyHistory:true})){
          if(generation!==S.generation)return;
          delete drafts[id];store();$('inspectorNote').value='';error='';$('inspectorNoteStatus').textContent='Note saved';draw();
        }else if(generation===S.generation){needsReview=true;error='Note save was not confirmed. Your draft is retained. Reload the latest history before retrying.';controls();}
      }catch(e){error=e.message;controls();}
    }
    $('inspectorForm').addEventListener('submit',save);$('inspectorNote').addEventListener('input',input);
    $('inspectorClose').onclick=close;dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    for(const id of ['inspectorFrom','inspectorTo','inspectorKind'])$(id).addEventListener('change',()=>{limit=100;timeline();});
    $('inspectorClearDates').onclick=()=>{$('inspectorFrom').value='';$('inspectorTo').value='';limit=100;timeline();};
    $('inspectorMore').onclick=()=>{limit+=100;timeline();};
    $('inspectorReload').onclick=async()=>{
      const generation=S.generation,id=recordId;
      try{await refresh();if(generation!==S.generation||id!==recordId)return;needsReview=false;error='';
        const draft=drafts[id],row=S.records.find(r=>r.id===id);
        if(draft&&row?.history.some(item=>H.parse(item).id===draft.id)){delete drafts[id];store();$('inspectorNote').value='';$('inspectorNoteStatus').textContent='Note was already saved';}
        else $('inspectorNoteStatus').textContent='Latest history loaded. Review your draft, then save.';
        draw();
      }catch(e){error=e.message;controls();}
    };
    window.addEventListener('beforeunload',event=>{if(Object.values(drafts).some(d=>d.text)&&!store()){event.preventDefault();event.returnValue='';}});
    return {open,draw,clear};
  }
})(window);
