(function(root){
  'use strict';
  root.PipeChatNotificationsUI={create};
  function create({S,esc,icon,core,localDate,toast,refresh,openRecord,openTask,completeTask,prepare,blocked}){
    const $=id=>document.getElementById(id);
    let items=[],collapsed=false,identity=null,edit=null,refreshing=false,signature='';
    const toggle=document.createElement('button');toggle.id='showNotifications';toggle.className='icon-btn';toggle.type='button';
    toggle.title='Open notifications';toggle.setAttribute('aria-label','Open notifications');toggle.setAttribute('aria-controls','notificationsPane');
    toggle.innerHTML=icon('ArrowRight')+'<span id="notificationBadge" hidden></span>';
    document.querySelector('.toolbar').append(toggle);
    const key=()=>`pipechat.notifications.collapsed:${S.health?.storageProvider}:${S.user?.id}`;
    function layout(){
      document.querySelector('.workspace').classList.toggle('notifications-collapsed',collapsed);
      $('notificationsPane').hidden=collapsed;toggle.hidden=!collapsed;
      toggle.setAttribute('aria-expanded',String(!collapsed));$('hideNotifications').setAttribute('aria-expanded',String(!collapsed));
    }
    function setCollapsed(value){collapsed=value;try{localStorage.setItem(key(),String(value));}catch{}layout();(value?toggle:$('hideNotifications')).focus();}
    toggle.onclick=()=>setCollapsed(false);$('hideNotifications').onclick=()=>setCollapsed(true);
    function draw(){
      if(!S.loaded||!S.user)return;
      if(identity!==key()){identity=key();collapsed=false;try{collapsed=localStorage.getItem(key())==='true';}catch{}signature='';}
      layout();
      items=root.PipeChatNotifications.collect({records:S.records,cards:S.todoCards,core:core(),customFields:S.customFields,today:localDate(),history:root.PipeChatInspector});
      const count=items.filter(i=>i.section!=='upcoming').length;
      $('notificationBadge').textContent=count;$('notificationBadge').hidden=!count;
      toggle.setAttribute('aria-label',`Open notifications${count?` (${count} need attention)`:''}`);
      const titles={overdue:'Overdue',today:'Due today',upcoming:'Next 7 days',stale:'Needs attention'};
      const disabled=blocked()||refreshing,html=items.length?`<p class="notification-summary">${count} need attention / ${localDate()}</p>`+Object.entries(titles).map(([section,label])=>{
        const group=items.filter(i=>i.section===section);if(!group.length)return '';
        return `<section class="notification-section" data-section="${section}"><h3>${label}<span>${group.length}</span></h3>${group.map(item=>`<article class="notification-item"><div><button class="notification-title" data-notification="${esc(item.key)}" ${disabled?'disabled':''}>${esc(item.title)}</button><p>${esc(item.detail)}</p><time datetime="${item.date}">${section==='stale'?'Last activity: ':''}${item.date}</time></div>${item.kind==='task'?`<button class="icon-btn" data-complete-task="${esc(item.key)}" title="Mark task Done" aria-label="Mark ${esc(item.detail)} Done" ${disabled?'disabled':''}>${icon('CircleCheck')}</button>`:item.field?`<button class="icon-btn" data-reschedule="${esc(item.key)}" title="Change reminder date" aria-label="Change ${esc(item.detail)} for ${esc(item.title)}" ${disabled?'disabled':''}>${icon('CalendarDays')||icon('Pencil')}</button>`:''}</article>`).join('')}</section>`;
      }).join(''):'<p class="notifications-empty">Nothing needs attention right now.</p>';
      // Keep keyboard focus and scroll stable when a timer has nothing new to show.
      if(signature!==html){$('notificationsBody').innerHTML=html;signature=html;}
      $('refreshNotifications').disabled=disabled;$('notificationsStatus').textContent=refreshing?'Refreshing...':'Based on saved data';
    }
    function act(callback){if(blocked()||refreshing){toast('Finish the current edit or proposal first.');return;}try{callback();}catch(error){toast(error.message);}}
    $('notificationsBody').onclick=event=>{
      const open=event.target.closest('[data-notification]'),done=event.target.closest('[data-complete-task]'),reschedule=event.target.closest('[data-reschedule]');
      const key=open?.dataset.notification||done?.dataset.completeTask||reschedule?.dataset.reschedule,item=items.find(i=>i.key===key);if(!item)return;
      act(()=>{if(done)completeTask(item.id);else if(reschedule)openDate(item);else if(item.kind==='task')openTask(item.id);else openRecord(item.id,open);});
    };
    const dialog=document.createElement('dialog');dialog.className='field-dialog';dialog.id='notificationDateDialog';dialog.setAttribute('aria-labelledby','notificationDateTitle');
    dialog.innerHTML='<form id="notificationDateForm"><h2 id="notificationDateTitle">Change reminder</h2><p id="notificationDateRecord" class="subtle"></p><label id="notificationDateLabel" for="notificationDate">Date</label><input id="notificationDate" type="date"><p id="notificationDateError" class="error" role="alert"></p><div class="dialog-actions"><button id="notificationDateCancel" type="button" class="secondary">Cancel</button><button type="submit" class="primary">Preview change</button></div></form>';
    document.body.append(dialog);
    function openDate(item){
      const row=S.records.find(r=>r.id===item.id),field=core().definitions(S.customFields).find(f=>f.id===item.field);if(!row||!field)throw new Error('This reminder changed. Refresh notifications.');
      edit={id:row.id,field:field.id,revision:S.revision,generation:S.generation};$('notificationDateTitle').textContent='Change '+field.name;$('notificationDateRecord').textContent=item.title;$('notificationDateLabel').textContent=field.name;
      $('notificationDate').value=item.date;$('notificationDateError').textContent='';dialog.showModal();$('notificationDate').focus();
    }
    $('notificationDateCancel').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{edit=null;});
    $('notificationDateForm').onsubmit=event=>{
      event.preventDefault();if(!edit)return;
      try{
        if(blocked()||edit.revision!==S.revision||edit.generation!==S.generation)throw new Error('The workspace changed. Close this form and reopen the reminder.');
        const action={action:'update_record',ids:[edit.id],field:edit.field,value:$('notificationDate').value};dialog.close();prepare(action,'Change reminder date');
      }catch(error){$('notificationDateError').textContent=error.message;}
    };
    $('refreshNotifications').onclick=async()=>{
      if(blocked()||refreshing)return;refreshing=true;draw();
      try{await refresh();}catch(error){toast(error.message);}finally{refreshing=false;draw();}
    };
    setInterval(()=>{if(!document.hidden)draw();},60000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)draw();});
    return {draw,clear(){items=[];signature='';identity=null;edit=null;dialog.close();$('notificationsBody').innerHTML='';}};
  }
})(window);
