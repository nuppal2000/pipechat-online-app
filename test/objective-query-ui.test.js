'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(require.resolve('playwright',{paths:[__dirname,path.resolve(path.dirname(process.execPath),'..')]}));
const F=require('./fixtures/objective-query-acceptance.cjs'),D=require('../public/dashboard-board.js'),C=require('../public/pipeline-core.js');
let browser;
test.before(async()=>{
  try{browser=await chromium.launch({headless:true});}
  catch(error){if(process.platform!=='win32'||!error.message.includes("Executable doesn't exist"))throw error;browser=await chromium.launch({channel:'msedge',headless:true});}
});
test.after(async()=>{await browser?.close();});
async function pageFor(t,html,width=1640){
  const page=await browser.newPage({viewport:{width,height:1000},timezoneId:'America/New_York'}),errors=[];
  t.after(async()=>{await page.close();assert.deepEqual(errors,[],'No browser errors');});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.abort());
  await page.setContent(html);
  await page.addStyleTag({path:path.join(__dirname,'../public/pipechat.css')});
  for(const file of ['table-schema.js','pipeline-core.js','report-engine.js','dashboard-board.js','report-ui.js','vendor/chart.umd.min.js'])await page.addScriptTag({path:path.join(__dirname,'../public',file)});
  return page;
}
async function boardPage(t,width){
  const w=F.workspace(),result=D.apply(null,{action:'dashboard_plan',operations:[
    {op:'add',id:'volume',spec:F.spec('count')},
    {op:'add',id:'amount',spec:F.spec('sum',{scope:'visible'})},
    {op:'add',id:'stages',spec:F.spec('percentage',{title:'Stages <all>',chart:'stage',groupBy:'f_stage'})},
    {op:'set_shared_filter',id:'alex',targets:['volume','amount'],where:[[F.where('f_owner','equals','Alex')]]}
  ],questions:[]},w.records,C.create(w.tableSchema),w.customFields,{...F.options,visibleIds:[41,55,101,12]});
  const page=await pageFor(t,'<main><div id="board" class="dashboard-elements"></div></main>',width);
  await page.evaluate(({board,views,records})=>{
    const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
    const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
    window.app=freeze({board,views,records});window.original=JSON.stringify(window.app);window.events=[];window.charts=[];
    window.drawBoard=views=>{
      window.charts.forEach(chart=>chart.destroy());
      window.charts=PipeChatReportsUI.drawBoard({host:document.getElementById('board'),views:views||app.views,board:app.board,document,Chart,
        esc,icon:()=>'',onSelect:id=>events.push(['select',id]),onRemove:id=>events.push(['remove',id])});
    };
    drawBoard();window.initialSections=[...document.querySelectorAll('[data-element-id]')];
  },{board:result.board,views:result.views,records:w.records});
  return page;
}
const boardState=page=>page.evaluate(()=>({unchanged:JSON.stringify(app)===original,events,focus:document.getElementById('board').dataset.focusId||null,
  sections:[...document.querySelectorAll('[data-element-id]')].map(el=>({id:el.dataset.elementId,hidden:el.hidden,pressed:el.querySelector('[data-focus-report]').getAttribute('aria-pressed'),scope:el.querySelector('.dashboard-element-scope').textContent}))}));

test('objective 11 UI: graph focus/unfocus is read-only and retains sibling nodes, identities and scopes',async t=>{
  const page=await boardPage(t),before=await boardState(page);
  await page.locator('[data-element-id="amount"] [data-focus-report]').click();
  const focused=await boardState(page);assert.equal(focused.focus,'amount');assert.equal(focused.unchanged,true);assert.deepEqual(focused.events,[]);
  assert.deepEqual(focused.sections.map(s=>[s.id,s.hidden,s.pressed]),[['volume',true,'false'],['amount',false,'true'],['stages',true,'false']]);
  assert.deepEqual(focused.sections.map(s=>s.scope),before.sections.map(s=>s.scope));
  assert.equal(await page.locator('[data-element-id="amount"] [data-focus-report]').getAttribute('aria-label'),'Show all graphs');
  await page.locator('[data-element-id="amount"] [data-focus-report]').click();
  assert.deepEqual(await boardState(page),before);
  assert(await page.evaluate(()=>initialSections.every(el=>el===document.querySelector(`[data-element-id="${el.dataset.elementId}"]`))));
});

test('objective 11 UI: local focus survives redraw and clears when its graph disappears without removing siblings',async t=>{
  const page=await boardPage(t);
  await page.locator('[data-element-id="volume"] [data-focus-report]').click();await page.evaluate(()=>drawBoard());
  assert.equal((await boardState(page)).focus,'volume');assert.equal(await page.locator('[data-element-id]:visible').count(),1);
  await page.locator('[data-element-id="volume"] [data-edit-report]').click();
  await page.locator('[data-element-id="volume"] [data-remove-report]').click();
  assert.deepEqual((await boardState(page)).events,[['select','volume'],['remove','volume']]);
  await page.evaluate(()=>drawBoard(app.views.filter(view=>view.id!=='volume')));
  const remaining=await boardState(page);assert.equal(remaining.focus,null);assert.equal(remaining.unchanged,true);
  assert.deepEqual(remaining.sections.map(s=>[s.id,s.hidden]),[['amount',false],['stages',false]]);
  await page.evaluate(()=>drawBoard([]));assert.equal(await page.locator('#board').textContent(),'No graphs.');assert.equal((await boardState(page)).focus,null);
});

test('objective 11 UI: comparison uses two columns on large screens, one on mobile, with real stage doughnuts',async t=>{
  const page=await boardPage(t);
  const geometry=()=>page.locator('[data-element-id]').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,right:r.right};}));
  const wide=await geometry();assert(Math.abs(wide[0].y-wide[1].y)<1);assert(wide[0].right<=wide[1].x);assert(Math.abs(wide[0].width-wide[1].width)<1);
  const rendered=await page.evaluate(()=>charts.map(chart=>({type:chart.config.type,labels:chart.data.labels,values:chart.data.datasets[0].data,
    nonblank:chart.ctx.getImageData(0,0,chart.canvas.width,chart.canvas.height).data.some((value,index)=>index%4===3&&value>0)})));
  assert.deepEqual(rendered.map(chart=>chart.type),['bar','bar','doughnut']);assert(rendered.every(chart=>chart.nonblank));
  assert(Math.abs(rendered[2].values.reduce((total,value)=>total+value,0)-100)<1e-9);
  assert.equal(await page.locator('[data-element-id="stages"] h4').textContent(),'Stages <all>');
  await page.locator('[data-element-id="amount"] [data-focus-report]').click();
  assert((await geometry())[1].width>wide[1].width*1.9);
  await page.locator('[data-element-id="amount"] [data-focus-report]').click();await page.setViewportSize({width:390,height:844});
  const narrow=await geometry();assert(narrow[1].y>narrow[0].y);assert(Math.abs(narrow[0].x-narrow[1].x)<1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal((await boardState(page)).unchanged,true);
});

async function notificationsPage(t){
  const page=await pageFor(t,'<div class="workspace"><div class="toolbar"></div><aside id="notificationsPane"><button id="hideNotifications">Hide</button><button id="refreshNotifications">Refresh</button><span id="notificationsStatus"></span><div id="notificationsBody"></div></aside></div>');
  await page.clock.install({time:new Date('2026-10-11T03:59:30Z')});
  for(const file of ['inspector-core.js','notifications.js','notifications-ui.js'])await page.addScriptTag({path:path.join(__dirname,'../public',file)});
  await page.evaluate(w=>{
    window.S={...w,loaded:true,user:{id:'objective_qa'},health:{storageProvider:'supabase'},revision:1,generation:1};
    window.original=JSON.stringify(w);window.calls=[];
    window.ui=PipeChatNotificationsUI.create({S,esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),icon:()=>'',core:()=>PipelineCore.create(S.tableSchema),
      localDate:()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');},
      toast:message=>calls.push(['toast',message]),refresh:async()=>calls.push(['refresh']),openRecord:id=>calls.push(['record',id]),openTask:id=>calls.push(['task',id]),
      completeTask:id=>calls.push(['complete',id]),prepare:action=>calls.push(['prepare',action]),blocked:()=>false});
    ui.draw();
  },F.notifications());
  return page;
}

test('controlled-clock UI: midnight updates overdue/today/future buckets without writes or completed tasks',async t=>{
  const page=await notificationsPage(t);
  const counts=()=>page.locator('.notification-section').evaluateAll(sections=>Object.fromEntries(sections.map(s=>[s.dataset.section,s.querySelectorAll('article').length])));
  assert.deepEqual(await counts(),{overdue:2,today:3,upcoming:4});assert.equal(await page.locator('#notificationBadge').textContent(),'5');
  assert.equal(await page.locator('[data-notification="task:todo_done"]').count(),0);assert.equal(await page.locator('[data-notification="task:todo_orphan"]').count(),0);
  await page.clock.runFor(60000);
  assert.deepEqual(await counts(),{overdue:5,today:2,upcoming:4});assert.equal(await page.locator('#notificationBadge').textContent(),'7');
  assert((await page.locator('.notification-summary').textContent()).includes('2026-10-11'));
  const unchanged=await page.evaluate(()=>({calls,unchanged:JSON.stringify({records:S.records,customFields:S.customFields,tableSchema:S.tableSchema,todoCards:S.todoCards})===original}));
  assert.equal(unchanged.unchanged,true);assert.deepEqual(unchanged.calls,[]);
  await page.evaluate(()=>{window.beforeTick=document.querySelector('[data-notification="task:todo_1"]');});
  await page.clock.runFor(60000);assert(await page.evaluate(()=>beforeTick===document.querySelector('[data-notification="task:todo_1"]')));
});

test('notification UI: completion is a proposal callback and refresh reflects only confirmed task state',async t=>{
  const page=await notificationsPage(t);
  await page.locator('[data-complete-task="task:todo_2"]').click();
  assert.deepEqual(await page.evaluate(()=>calls),[['complete','todo_2']]);
  assert.equal(await page.evaluate(()=>S.todoCards.find(card=>card.id==='todo_2').status),'To Do');
  await page.evaluate(()=>{S.todoCards.find(card=>card.id==='todo_2').status='Done';S.revision++;ui.draw();});
  assert.equal(await page.locator('[data-notification="task:todo_2"]').count(),0);
  assert.equal(await page.locator('[data-notification="record:2:f_follow"]').count(),1);assert.equal(await page.locator('#notificationBadge').textContent(),'4');
  await page.locator('[data-reschedule="record:2:f_follow"]').click();await page.locator('#notificationDate').fill('2026-10-20');
  await page.locator('#notificationDateForm button[type="submit"]').click();
  const action=(await page.evaluate(()=>calls)).find(call=>call[0]==='prepare')[1];assert.deepEqual(action,{action:'update_record',ids:[2],field:'f_follow',value:'2026-10-20'});
  assert.equal(await page.evaluate(()=>S.records.find(row=>row.id===2).f_follow),'2026-10-10');
});
