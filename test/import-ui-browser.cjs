// Local-only visual regression harness. No application server or live APIs run.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PIPECHAT_PLAYWRIGHT||'C:/Users/nuppa/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fixture=require('./fixtures/import-ui-fixture.cjs');
const root=path.resolve(__dirname,'../public'),output=path.resolve(__dirname,'outputs/import-ui');
const boot=`wire();
  const fixture=${JSON.stringify(fixture)};
  useSchema(fixture.schema);Object.assign(S,{records:fixture.records,user:{id:'local-qa',name:'Local QA',email:'local@example.invalid'},loaded:true,updatedAt:'v1',usage:{used:0,remaining:100,limit:100},health:{aiConfigured:false},chatReady:true});
  document.body.classList.remove('auth-locked');$('authScreen').hidden=true;render();
  const input=window.PipeChatSheets.mappingSource(fixture.matrix);
  const draft={kind:'csv-import',name:'objective9.xlsx',...input,revision:S.revision,generation:S.generation};S.pending=draft;
  previewCsvImport(draft,fixture.analysis,'AI-assisted mapping.');
  window.localImportTest={S,receipts:[]};const basePersist=persist;
  persist=(next,label,options)=>{window.localImportTest.receipts.push(options.importReceipt);return basePersist(next,label,options);};`;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method!=='GET'||url.pathname.startsWith('/api/')){res.writeHead(403);res.end('Local fixture: API disabled');return;}
  const target=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
  if(!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{
    let body=fs.readFileSync(target);
    if(target.endsWith(path.sep+'pipechat.js'))body=body.toString().replace(/\r\n/g,'\n').replace('  wire();\n  restoreSession();',boot);
    res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.html')?'text/html':'application/octet-stream');res.end(body);
  }catch{res.writeHead(404);res.end();}
});
(async()=>{
  let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({channel:'msedge',headless:true});}
    fs.mkdirSync(output,{recursive:true});
    for(const [name,viewport] of [['desktop',{width:1440,height:1100}],['mobile',{width:390,height:844}]]){
      const page=await browser.newPage({viewport}),errors=[],writes=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.origin!==origin){await route.abort();return;}
        if(url.pathname.startsWith('/api/')){
          if(url.pathname==='/api/crm-data'&&request.method()==='PUT'){
            const payload=request.postDataJSON();writes.push(payload);
            await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...payload,updatedAt:'v2'})});
          }else await route.abort();
          return;
        }
        await route.continue();
      });
      await page.goto(origin,{waitUntil:'networkidle'});
      assert.deepEqual(errors,[],'Local fixture startup errors');
      await page.screenshot({path:path.join(output,name+'-startup.png'),fullPage:true});
      await page.locator('[data-import-duplicates="merge"]').click();
      await page.locator('.trust-body').evaluate(el=>el.scrollTop=0);
      assert.match(await page.locator('#trustBody').innerText(),/2 invalid cells \/ 1 blank cells/);
      await page.screenshot({path:path.join(output,name+'-review.png'),fullPage:true});
      const errorCell=page.locator('.proposal-record').filter({has:page.locator('textarea')}).filter({hasText:'Deal Value'});
      await errorCell.locator('textarea').fill('USD 75.25');await errorCell.locator('[data-import-correct]').click();
      await page.locator('[data-import-blank]').check();
      const conflicts=page.locator('[data-import-conflict]');
      await conflicts.first().selectOption('incoming');await page.locator('[data-import-conflict]').last().selectOption('existing');
      const confirm=page.locator('#trustBody [data-confirm]');assert.equal(await confirm.isEnabled(),true);
      assert.equal(writes.length,0);
      const overflow=await page.locator('#trustBody').evaluate(el=>el.scrollWidth>el.clientWidth+1);
      assert.equal(overflow,false,name+' import review overflows horizontally');
      await confirm.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,name+'-approved-preview.png'),fullPage:true});
      await confirm.click();await page.waitForFunction(()=>window.localImportTest.S.pending===null);
      assert.equal(writes.length,1);assert.equal(writes[0].deals.length,4);assert.equal(writes[0].deals.find(row=>row.id===42).f_amount,13000);
      const receipts=await page.evaluate(()=>window.localImportTest.receipts);assert.match(receipts[0].digest,/^[a-f0-9]{64}$/);
      assert.deepEqual(errors,[]);await page.close();
      console.log(name+': review, correction, conflict choices, confirmation, receipt and overflow checks passed');
    }
    console.log('Screenshots: '+output);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
