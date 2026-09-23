(function(root){
  'use strict';
  root.PipeChatTodoUI={create};
  function create({S,esc,icon,fieldInput,manualEdit,persist,prepare,render,toast,localDate}){
    const T=root.PipeChatTodo,$=id=>document.getElementById(id);
    let expanded=null,dragged=null,dialogVersion=null;
    const disabled=()=>S.saving||S.busy||Boolean(S.failedEdit)||!S.loaded;
    const defs=()=>root.PipelineCore.create(S.tableSchema).definitions(S.customFields);
    const name=id=>{const C=root.PipelineCore.create(S.tableSchema),row=S.records.find(r=>r.id===id);return row?.[C.role('primary')]||`Unnamed record #${id}`;};
    const statuses=value=>T.statuses.map(s=>`<option ${s===value?'selected':''}>${s}</option>`).join('');
    function draw(){
      const cards=T.reconcile(S.todoCards,S.records,S.tableSchema,S.customFields);
      $('todoView').innerHTML=T.statuses.map((status,i)=>`<section class="todo-lane" data-lane="${status}" aria-label="${status}"><header><span class="todo-dot todo-dot-${i}"></span><h3>${status}</h3><span>${cards.filter(c=>c.status===status).length}</span></header><div class="todo-lane-cards">${cards.filter(c=>c.status===status).map(card=>{
        const view=T.project(card,S.records,S.tableSchema,S.customFields),record=S.records.find(r=>r.id===card.recordId),open=expanded===card.id;
        return `<article class="todo-card" data-card="${card.id}" draggable="${!disabled()&&!open}"><div class="todo-card-heading"><button class="todo-title" data-todo-open="${card.id}" aria-expanded="${open}" ${disabled()?'disabled':''}>${esc(view.title)}${icon(open?'ChevronUp':'ChevronDown')}</button><button class="icon-btn todo-remove" data-todo-delete="${card.id}" aria-label="Delete card for ${esc(view.title)}" title="Delete card" ${disabled()?'disabled':''}>${icon('X')}</button></div><div class="todo-next"><span>Next action</span><p>${esc(view.nextAction||'Not set')}</p></div><footer><span class="todo-owner">${icon('User')}${esc(view.owner||'Unassigned')}</span><span class="todo-due ${view.dueDate&&T.validDate(view.dueDate)&&view.dueDate<localDate()&&status!=='Done'?'overdue':''}">${esc(view.dueDate||'No due date')}</span></footer>${open?`<div class="todo-details"><label>Board status<select data-todo-status="${card.id}" ${disabled()?'disabled':''}>${statuses(card.status)}</select></label><button class="text-btn" data-todo-config="${card.id}" ${disabled()?'disabled':''}>Edit card settings</button><div class="todo-record-fields" data-id="${record.id}">${defs().map(f=>`<label>${esc(f.name)}${fieldInput(f,record[f.id])}</label>`).join('')}</div></div>`:''}</article>`;
      }).join('')||'<p class="todo-empty">No cards</p>'}</div></section>`).join('');
      $('todoView').querySelectorAll('.todo-record-fields input,.todo-record-fields textarea,.todo-record-fields select').forEach(el=>el.disabled=disabled());
      $('todoView').querySelectorAll('.todo-record-fields textarea').forEach(el=>{el.style.height='auto';el.style.height=Math.max(70,el.scrollHeight+2)+'px';});
      $('addTodoBtn').disabled=disabled()||!S.records.length;
      const id=(S.todoSuggestions||[]).find(id=>S.records.some(r=>r.id===id)&&!S.todoCards.some(c=>c.recordId===id&&c.status!=='Done'));
      $('todoSuggestion').hidden=!id;
      if(id){$('todoSuggestionText').textContent=`Add ${name(id)} to To Do?`;$('todoSuggestYes').dataset.record=String(id);$('todoSuggestNo').dataset.record=String(id);}
    }
    function openForm(cardId=null,recordId=null){
      if(disabled())return;
      if(S.pending||S.clarification){toast('Confirm or cancel the current proposal first.');return;}
      const card=S.todoCards.find(c=>c.id===cardId),defaultId=card?.recordId||recordId||S.records[0]?.id;
      if(!defaultId){toast('Add a record to the table first.');return;}
      const draft=card||T.create('todo_preview',defaultId,S.tableSchema,S.customFields);
      dialogVersion=S.revision;$('todoDialog').dataset.card=card?.id||'';
      $('todoDialogTitle').textContent=card?'Edit card':'New To Do card';
      $('todoRecord').innerHTML=S.records.map(r=>`<option value="${r.id}" ${r.id===defaultId?'selected':''}>${esc(name(r.id))} / #${r.id}</option>`).join('');$('todoRecord').disabled=Boolean(card);
      $('todoStatus').innerHTML=statuses(draft.status);
      for(const [id,key,types] of [['todoNextSource','nextField',['text','choice']],['todoDueSource','followField',['text','choice','date']],['todoOwnerSource','ownerField',['text','choice']]]){
        $(id).innerHTML=`<option value="">${key==='ownerField'?'Unassigned':'Card only'}</option>`+defs().filter(f=>types.includes(f.type)).map(f=>`<option value="${f.id}" ${f.id===draft[key]?'selected':''}>${esc(f.name)}</option>`).join('');$(id).value=draft[key]||'';
      }
      $('todoNext').value=draft.nextAction;$('todoDue').value=draft.dueDate;$('todoFormError').textContent='';syncSources();$('todoDialog').showModal();
    }
    function syncSources(){
      const record=S.records.find(r=>r.id===Number($('todoRecord').value));
      for(const [source,input,key] of [['todoNextSource','todoNext','nextAction'],['todoDueSource','todoDue','dueDate']]){
        $(input+'Label').hidden=Boolean($(source).value);
        $(input+'Linked').hidden=!$(source).value;
        $(input+'Linked').textContent=$(source).value?String(record?.[$(source).value]||'Not set'):'';
      }
    }
    function closeForm(){if($('todoDialog').open)$('todoDialog').close();dialogVersion=null;}
    $('todoForm').addEventListener('submit',event=>{
      event.preventDefault();if(disabled())return;
      try{
        if(dialogVersion!==S.revision)throw new Error('The workspace changed. Close and reopen this form.');
        const id=$('todoDialog').dataset.card||'todo_'+crypto.randomUUID().replaceAll('-',''),before=S.todoCards.find(c=>c.id===id)||null;
        const after={id,recordId:Number($('todoRecord').value),status:$('todoStatus').value,nextAction:$('todoNext').value,dueDate:$('todoDue').value,nextField:$('todoNextSource').value||null,followField:$('todoDueSource').value||null,ownerField:$('todoOwnerSource').value||null};
        const cards=T.validate(before?S.todoCards.map(c=>c.id===id?after:c):[...S.todoCards,after],S.records,S.tableSchema,S.customFields);
        closeForm();S.pending={kind:'todo',cards,before,after,recordId:after.recordId,count:1,revision:S.revision,createdAt:Date.now()};S.sourceAction=null;render();
      }catch(error){$('todoFormError').textContent=error.message;}
    });
    $('todoCancel').addEventListener('click',closeForm);
    $('todoDialog').addEventListener('cancel',()=>{dialogVersion=null;});
    for(const id of ['todoRecord','todoNextSource','todoDueSource'])$(id).addEventListener('change',syncSources);
    $('addTodoBtn').addEventListener('click',()=>openForm());
    $('todoView').addEventListener('click',event=>{
      const open=event.target.closest('[data-todo-open]'),del=event.target.closest('[data-todo-delete]'),config=event.target.closest('[data-todo-config]');
      if(disabled())return;
      if(open){expanded=expanded===open.dataset.todoOpen?null:open.dataset.todoOpen;draw();}
      if(del){if(S.pending||S.clarification){toast('Confirm or cancel the current proposal first.');return;}prepare({action:'delete_todo',todoId:del.dataset.todoDelete});}
      if(config)openForm(config.dataset.todoConfig);
    });
    async function move(id,status){
      if(disabled())return;
      if(S.pending||S.clarification){toast('Confirm or cancel the current proposal before moving a card.');draw();return;}
      const card=S.todoCards.find(c=>c.id===id);if(!card||card.status===status)return;
      await persist(S.records,'Card moved to '+status,{todoCards:S.todoCards.map(c=>c.id===id?{...c,status}:c)});
    }
    $('todoView').addEventListener('change',event=>{if(event.target.dataset.todoStatus)move(event.target.dataset.todoStatus,event.target.value);else if(event.target.dataset.field)manualEdit(event.target);});
    $('todoView').addEventListener('input',event=>{const el=event.target;if(el.tagName==='TEXTAREA'){el.style.height='auto';el.style.height=Math.max(70,el.scrollHeight+2)+'px';}});
    $('todoView').addEventListener('dragstart',event=>{const card=event.target.closest('[data-card]');if(!card||disabled()||event.target.closest('input,textarea,select')){event.preventDefault();return;}dragged=card.dataset.card;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',dragged);card.classList.add('dragging');});
    $('todoView').addEventListener('dragover',event=>{const lane=event.target.closest('[data-lane]');if(!lane||!dragged||disabled())return;event.preventDefault();event.dataTransfer.dropEffect='move';$('todoView').querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));lane.classList.add('drop-target');});
    $('todoView').addEventListener('drop',event=>{const lane=event.target.closest('[data-lane]');event.preventDefault();if(lane&&dragged)move(dragged,lane.dataset.lane);dragged=null;draw();});
    $('todoView').addEventListener('dragend',()=>{dragged=null;draw();});
    $('todoSuggestNo').addEventListener('click',event=>{S.todoSuggestions=S.todoSuggestions.filter(id=>id!==Number(event.currentTarget.dataset.record));draw();});
    $('todoSuggestYes').addEventListener('click',event=>{if(disabled()||S.pending||S.clarification){toast('Confirm or cancel the current proposal first.');return;}const id=Number(event.currentTarget.dataset.record);S.todoSuggestions=S.todoSuggestions.filter(x=>x!==id);prepare({action:'add_todo',ids:[id]});});
    function preview(p){
      const before=p.before?T.project(p.before,S.records,S.tableSchema,S.customFields):null,after=p.after?T.project(p.after,S.records,S.tableSchema,S.customFields):null;
      $('trustTitle').textContent=!after?'Delete To Do card':before?'Update To Do card':'Add To Do card';$('trustStatus').textContent='No card changes saved. Review and confirm.';
      $('trustBody').innerHTML=`<h3>${esc(name(p.recordId))}</h3>${!after?'<p class="error">Remove this card? The linked CRM record and all its information will be kept.</p>':`<div class="field-diff"><span>Board status</span><div>${before?esc(before.status)+' &rarr; ':''}${esc(after.status)}</div></div><div class="field-diff"><span>Next action</span><div>${esc(after.nextAction||'Not set')}${p.after.nextField?' (linked)':''}</div></div><div class="field-diff"><span>Due</span><div>${esc(after.dueDate||'No due date')}${p.after.followField?' (linked)':''}</div></div><div class="field-diff"><span>Owner / contact</span><div>${esc(after.owner||'Unassigned')}</div></div>`}<div class="proposal-actions"><button class="${after?'primary':'danger'}" data-confirm ${S.saving?'disabled':''}>${after?'Confirm card':'Delete card'}</button><button class="secondary" data-cancel ${S.saving?'disabled':''}>Cancel</button></div>`;
    }
    function clear(){expanded=null;dragged=null;closeForm();}
    return {draw,preview,clear};
  }
})(window);
