(function(root){
  'use strict';
  root.PipeChatTodoUI={create};
  function create({S,esc,icon,persistTodo,prepare,render,toast,localDate}){
    const T=root.PipeChatTodo,$=id=>document.getElementById(id);
    let expanded=null,dragged=null,dialogVersion=null,draft=null;
    const disabled=()=>S.saving||S.busy||Boolean(S.failedEdit)||!S.loaded;
    const statuses=value=>T.statuses.map(s=>`<option ${s===value?'selected':''}>${s}</option>`).join('');
    const busyAttr=()=>disabled()?'disabled':'';
    function draw(){
      const cards=T.reconcile(S.todoCards,S.records);
      if(draft&&!cards.some(c=>c.id===draft.card.id)){draft=null;expanded=null;}
      $('todoView').innerHTML=T.statuses.map((status,i)=>`<section class="todo-lane" data-lane="${status}" aria-label="${status}"><header><span class="todo-dot todo-dot-${i}"></span><h3>${status}</h3><span>${cards.filter(c=>c.status===status).length}</span></header><div class="todo-lane-cards">${cards.filter(c=>c.status===status).map(card=>{
        const view=T.project(card,S.records,S.tableSchema),open=expanded===card.id,edit=draft?.card.id===card.id?draft.card:card;
        return `<article class="todo-card" data-card="${card.id}" draggable="${!disabled()&&!open}"><div class="todo-card-heading"><button class="todo-title" data-todo-open="${card.id}" aria-expanded="${open}" ${busyAttr()}>${esc(view.title)}${icon(open?'ChevronUp':'ChevronDown')}</button><button class="icon-btn todo-remove" data-todo-delete="${card.id}" aria-label="Delete card for ${esc(view.title)}" title="Delete card" ${busyAttr()}>${icon('X')}</button></div><div class="todo-next"><span>To Do</span><p>${esc(card.nextAction||'Not set')}</p></div><footer><span class="todo-due ${card.dueDate&&card.dueDate<localDate()&&status!=='Done'?'overdue':''}">${esc(card.dueDate||'No due date')}</span></footer>${open?`<form class="todo-details" data-todo-edit="${card.id}"><label>Board status<select name="status" ${busyAttr()}>${statuses(edit.status)}</select></label><label>To Do<input name="nextAction" value="${esc(edit.nextAction)}" maxlength="12000" ${busyAttr()}></label><label>Due date<input name="dueDate" type="date" value="${esc(edit.dueDate)}" ${busyAttr()}></label><label>Notes<textarea name="notes" rows="5" maxlength="16000" ${busyAttr()}>${esc(edit.notes)}</textarea></label>${draft?.error?`<p class="error" role="alert">${esc(draft.error)}</p>`:''}<div class="todo-edit-actions"><button class="primary" type="submit" ${busyAttr()}>Preview changes</button><button class="secondary" type="button" data-todo-cancel ${busyAttr()}>Cancel</button></div></form>`:''}</article>`;
      }).join('')||'<p class="todo-empty">No cards</p>'}</div></section>`).join('');
      $('addTodoBtn').disabled=disabled();$('todoSuggestion').hidden=true;
    }
    function openForm(){
      if(disabled())return;
      if(S.pending||S.clarification||draft?.dirty){toast('Preview or cancel the current card edit or proposal first.');return;}
      dialogVersion=S.revision;$('todoDialogTitle').textContent='New To Do card';
      $('todoCustomTitle').value='';renderRecordOptions(S.records.length?'':'custom');toggleCustomTitle();
      $('todoStatus').innerHTML=statuses('To Do');$('todoNext').value='';$('todoNotes').value='';$('todoDue').value='';$('todoFormError').textContent='';$('todoDialog').showModal();
    }
    function renderRecordOptions(selected=$('todoRecord').value){
      const matches=T.recordOptions(S.records,S.tableSchema,'',selected);
      $('todoRecord').innerHTML='<option value="">Choose a record or custom title</option><option value="custom">Custom title</option>'+matches.map(r=>`<option value="${r.id}">${esc(r.title)} / #${r.id}</option>`).join('');
      $('todoRecord').value=selected;
    }
    function toggleCustomTitle(){const custom=$('todoRecord').value==='custom';$('todoCustomTitleLabel').hidden=!custom;$('todoCustomTitle').disabled=!custom;$('todoCustomTitle').required=custom;}
    $('todoRecord').addEventListener('change',()=>{toggleCustomTitle();if($('todoRecord').value==='custom')$('todoCustomTitle').focus();});
    function closeForm(){if($('todoDialog').open)$('todoDialog').close();dialogVersion=null;}
    function propose(after,before,revision){
      if(S.pending||S.clarification)throw new Error('Confirm or cancel the current proposal first.');
      if(revision!==S.revision)throw new Error('The workspace changed. Cancel this edit and reopen the card.');
      const cards=T.validate(before?S.todoCards.map(c=>c.id===after.id?after:c):[...S.todoCards,after],S.records);
      S.pending={kind:'todo',cards,before,after,recordId:after.recordId,count:1,revision:S.revision,createdAt:Date.now()};S.sourceAction=null;
    }
    $('todoForm').addEventListener('submit',event=>{
      event.preventDefault();if(disabled())return;
      try{
        const selection=$('todoRecord').value;if(!selection)throw new Error('Choose a linked record or custom title.');
        const card={...T.create('todo_'+crypto.randomUUID().replaceAll('-',''),selection==='custom'?null:Number(selection),$('todoCustomTitle').value.trim()),status:$('todoStatus').value,nextAction:$('todoNext').value,notes:$('todoNotes').value,dueDate:$('todoDue').value};
        propose(card,null,dialogVersion);closeForm();render();
      }catch(error){$('todoFormError').textContent=error.message;}
    });
    $('todoCancel').addEventListener('click',closeForm);$('todoDialog').addEventListener('cancel',()=>{dialogVersion=null;});
    $('addTodoBtn').addEventListener('click',openForm);
    $('todoView').addEventListener('click',event=>{
      if(disabled())return;
      const open=event.target.closest('[data-todo-open]'),del=event.target.closest('[data-todo-delete]'),cancel=event.target.closest('[data-todo-cancel]');
      const openId=open?.dataset.todoOpen||(!event.target.closest('button,form,input,textarea,select')&&event.target.closest('[data-card]')?.dataset.card);
      if(openId){
        if(draft?.dirty&&draft.card.id!==openId){toast('Preview or cancel the current card edit first.');return;}
        expanded=expanded===openId?null:openId;
        if(expanded&&draft?.card.id!==expanded)draft={card:{...S.todoCards.find(c=>c.id===expanded)},revision:S.revision,dirty:false};draw();
      }
      if(cancel){draft=null;expanded=null;draw();}
      if(del){if(S.pending||S.clarification||draft?.dirty){toast('Preview or cancel the current card edit or proposal first.');return;}prepare({action:'delete_todo',todoId:del.dataset.todoDelete});}
    });
    $('todoView').addEventListener('input',event=>{
      const form=event.target.closest('[data-todo-edit]');if(!form||!draft||form.dataset.todoEdit!==draft.card.id)return;
      if(['status','nextAction','notes','dueDate'].includes(event.target.name)){draft.card[event.target.name]=event.target.value;draft.dirty=true;}
    });
    $('todoView').addEventListener('change',event=>{
      const form=event.target.closest('[data-todo-edit]');if(form&&draft&&['status','dueDate'].includes(event.target.name)){draft.card[event.target.name]=event.target.value;draft.dirty=true;}
    });
    $('todoView').addEventListener('submit',event=>{
      if(!event.target.matches('[data-todo-edit]'))return;event.preventDefault();if(disabled()||!draft)return;
      try{propose({...draft.card},S.todoCards.find(c=>c.id===draft.card.id),draft.revision);draft=null;expanded=null;render();}catch(error){draft.error=error.message;draw();}
    });
    async function move(id,status){
      if(disabled())return;
      if(S.pending||S.clarification||draft?.dirty){toast('Finish the current card edit or proposal first.');draw();return;}
      const card=S.todoCards.find(c=>c.id===id);if(!card||card.status===status)return;
      await persistTodo(S.todoCards.map(c=>c.id===id?{...c,status}:c),'Card moved to '+status);
    }
    $('todoView').addEventListener('dragstart',event=>{const card=event.target.closest('[data-card]');if(!card||disabled()||event.target.closest('input,textarea,select')||expanded===card.dataset.card){event.preventDefault();return;}dragged=card.dataset.card;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',dragged);card.classList.add('dragging');});
    $('todoView').addEventListener('dragover',event=>{const lane=event.target.closest('[data-lane]');if(!lane||!dragged||disabled())return;event.preventDefault();event.dataTransfer.dropEffect='move';$('todoView').querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));lane.classList.add('drop-target');});
    $('todoView').addEventListener('drop',event=>{const lane=event.target.closest('[data-lane]');event.preventDefault();if(lane&&dragged)move(dragged,lane.dataset.lane);dragged=null;draw();});
    $('todoView').addEventListener('dragend',()=>{dragged=null;draw();});
    function preview(p){
      if(p.additions){
        $('trustTitle').textContent='Add To Do cards';$('trustStatus').textContent='Card-only changes. CRM fields stay unchanged.';
        $('trustBody').innerHTML=`<p>${p.count} cards to add. Existing cards will be kept.</p>${p.additions.map(card=>`<section class="proposal-record"><h3>${esc(T.project(card,S.records,S.tableSchema).title)}</h3>${[['Board status',card.status],['To Do',card.nextAction],['Notes',card.notes],['Due date',card.dueDate]].map(([label,value])=>`<div class="field-diff"><span>${label}</span><div class="todo-preview-value">${esc(value||'Not set')}</div></div>`).join('')}</section>`).join('')}<div class="proposal-actions"><button class="primary" data-confirm ${S.saving?'disabled':''}>Confirm ${p.count} cards</button><button class="secondary" data-cancel ${S.saving?'disabled':''}>Cancel</button></div>`;
        return;
      }
      const after=p.after;
      $('trustTitle').textContent=!after?'Delete To Do card':p.before?'Update To Do card':'Add To Do card';$('trustStatus').textContent='Card-only changes. CRM fields stay unchanged.';
      $('trustBody').innerHTML=`<h3>${esc(T.project(after||p.before,S.records,S.tableSchema).title)}</h3>${!after?'<p class="error">Remove this card? No CRM records will be changed.</p>':[['Board status',after.status],['To Do',after.nextAction],['Notes',after.notes],['Due date',after.dueDate]].map(([label,value])=>`<div class="field-diff"><span>${label}</span><div class="todo-preview-value">${esc(value||'Not set')}</div></div>`).join('')}<div class="proposal-actions"><button class="${after?'primary':'danger'}" data-confirm ${S.saving?'disabled':''}>${after?'Confirm card':'Delete card'}</button><button class="secondary" data-cancel ${S.saving?'disabled':''}>Cancel</button></div>`;
    }
    function clear(){expanded=null;dragged=null;draft=null;closeForm();}
    window.addEventListener('beforeunload',event=>{if(draft?.dirty){event.preventDefault();event.returnValue='';}});
    return {draw,preview,clear};
  }
})(window);
