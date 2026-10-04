const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Core=require('../public/pipeline-core'),T=require('../public/todo-core');
function harness(storage=new Map()){
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,attrs:{},classList:{toggle(){}},append(){},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this[k]=fn;},focus(){},showModal(){this.open=true;},close(){this.open=false;this.closeEvent?.();}});return nodes.get(id);};
  const S={loaded:true,user:{id:'A'},health:{storageProvider:'supabase'},records:[{id:1,account:'<script>Acme</script>',stage:'Warm',follow:'2026-10-04',history:[]}],customFields:[],todoCards:[{...T.create('todo_a',1),nextAction:'Call <img>',dueDate:'2026-10-04'}],revision:1,generation:1};
  const calls=[];let blocked=false,fail=false;
  const window={PipeChatNotifications:require('../public/notifications'),PipeChatInspector:require('../public/inspector-core')};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/notifications-ui'),'utf8'),{window,setInterval(){},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},document:{getElementById:node,querySelector:node,createElement:()=>node('created'+nodes.size),body:{append(){}},addEventListener(){}}});
  const ui=window.PipeChatNotificationsUI.create({S,esc:s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'),icon:()=>'',core:()=>Core,localDate:()=> '2026-10-04',toast:m=>calls.push(['toast',m]),refresh:async()=>{calls.push(['refresh']);if(fail)throw new Error('Offline');},openRecord:(...args)=>calls.push(['record',...args]),openTask:id=>calls.push(['task',id]),completeTask:id=>calls.push(['complete',id]),prepare:a=>calls.push(['prepare',a]),blocked:()=>blocked});
  const click=(selector,dataset)=>node('notificationsBody').onclick({target:{closest:s=>s===selector?{dataset}:null}});
  return {ui,S,node,calls,storage,click,block:v=>blocked=v,fail:v=>fail=v};
}
test('notification actions are scoped, escaped, and create previews rather than saving',()=>{
  const h=harness();h.ui.draw();const html=h.node('notificationsBody').innerHTML;assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));
  h.click('[data-complete-task]',{completeTask:'task:todo_a'});assert.deepEqual(h.calls[0],['complete','todo_a']);assert.equal(h.S.todoCards[0].status,'To Do');
  h.click('[data-notification]',{notification:'task:todo_a'});assert.deepEqual(h.calls[1],['task','todo_a']);
  h.click('[data-reschedule]',{reschedule:'record:1:follow'});h.node('notificationDate').value='2026-10-09';h.node('notificationDateForm').onsubmit({preventDefault(){}});
  const action=h.calls.find(c=>c[0]==='prepare')[1];assert.equal(action.ids[0],1);assert.equal(action.field,'follow');assert.equal(action.value,'2026-10-09');assert.equal(h.S.records[0].follow,'2026-10-04');
});
test('pending work and stale date dialogs cannot overwrite records; failed refresh is reported',async()=>{
  const h=harness();h.ui.draw();h.click('[data-reschedule]',{reschedule:'record:1:follow'});h.S.revision++;h.node('notificationDateForm').onsubmit({preventDefault(){}});
  assert.match(h.node('notificationDateError').textContent,/workspace changed/);assert(!h.calls.some(c=>c[0]==='prepare'));
  h.block(true);h.click('[data-complete-task]',{completeTask:'task:todo_a'});assert(!h.calls.some(c=>c[0]==='complete'));
  h.block(false);h.fail(true);await h.node('refreshNotifications').onclick();assert(h.calls.some(c=>c[0]==='toast'&&c[1]==='Offline'));
});
test('collapse preference is account scoped and live status removes completed tasks',()=>{
  const h=harness();h.ui.draw();h.node('hideNotifications').onclick();assert.equal(h.node('notificationsPane').hidden,true);
  const saved=harness(h.storage);saved.ui.draw();assert.equal(saved.node('notificationsPane').hidden,true);
  saved.S.user={id:'B'};saved.ui.draw();assert.equal(saved.node('notificationsPane').hidden,false);
  saved.S.todoCards[0].status='Done';saved.ui.draw();assert(!saved.node('notificationsBody').innerHTML.includes('data-complete-task'));
  saved.ui.clear();assert.equal(saved.node('notificationsBody').innerHTML,'');
});
