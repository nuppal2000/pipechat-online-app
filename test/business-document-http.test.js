const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events'),net=require('node:net');
test('authenticated proposal preview/download is canonical, isolated, inert and stale-safe',{timeout:20000},async()=>{
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const directory=await fs.mkdtemp(path.join(__dirname,'document-data-'));
  const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),PIPECHAT_STORAGE_PROVIDER:'json',PIPECHAT_DATA_DIR:directory,OPENAI_API_KEY:''}});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  async function call(route,method='GET',body,cookie=''){
    const response=await fetch(`http://127.0.0.1:${port}`+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,headers:response.headers,text:await response.text(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  try{
    for(let i=0;i<80;i++){try{await call('/api/health');break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
    assert.equal((await call('/api/documents/proposal','POST',{recordId:1,download:false})).status,401,output);
    const a=await call('/api/auth/signup','POST',{name:'Document QA A',email:'doc-a@example.invalid',password:'local-test-only-123'});
    const b=await call('/api/auth/signup','POST',{name:'Document QA B',email:'doc-b@example.invalid',password:'local-test-only-456'});
    let initial=JSON.parse((await call('/api/crm-data','GET',null,a.cookie)).text);
    const setup=await call('/api/crm-data','PUT',{deals:[],customFields:[],tableSchema:require('../public/table-schema').legacySchema(),todoCards:[],expectedUpdatedAt:initial.updatedAt},a.cookie);
    assert.equal(setup.status,200,setup.text);initial=JSON.parse(setup.text);
    // Use the established legacy shape here; document generation supports either schema.
    const saved=await call('/api/crm-data','PUT',{deals:[{id:1,account:'QA proposal <script>bad()</script>',owner:'QA Contact',stage:'Discovery',value:13000,close:'',next:'',follow:'',notes:'Saved facts only'}],customFields:[],tableSchema:require('../public/table-schema').legacySchema(),todoCards:[],expectedUpdatedAt:initial.updatedAt},a.cookie);
    assert.equal(saved.status,200,saved.text);const snapshot=JSON.parse(saved.text);
    const request={recordId:1,expectedUpdatedAt:snapshot.updatedAt,download:false};
    const preview=await call('/api/documents/proposal','POST',request,a.cookie);assert.equal(preview.status,200,preview.text);
    const prepared=JSON.parse(preview.text);assert.equal(prepared.preview.recordId,1);assert(prepared.preview.facts.some(f=>f.value==='QA Contact'));
    assert.equal(prepared.preview.terms.find(t=>t.key==='paymentTerms').value,'Unknown');
    const artifact=await call('/api/documents/proposal','POST',{...request,download:true},a.cookie);
    assert.equal(artifact.status,200);assert.match(artifact.headers.get('content-disposition'),/attachment/);assert.match(artifact.text,/&lt;script&gt;/);assert(!artifact.text.includes('<script>bad()'));
    assert.equal((await call('/api/documents/proposal','POST',{...request,expectedUpdatedAt:'stale'},a.cookie)).status,409);
    assert.equal((await call('/api/documents/proposal','POST',{...request,expectedUpdatedAt:null},b.cookie)).status,400);
    assert.equal((await call('/api/documents/proposal','POST',{...request,body:'invented terms'},a.cookie)).status,400);
    assert.deepEqual(JSON.parse((await call('/api/crm-data','GET',null,a.cookie)).text),{...snapshot,seedDemoData:false});
    assert.equal(JSON.parse((await call('/api/chat-usage','GET',null,a.cookie)).text).used,0);
  }finally{
    child.kill();await once(child,'exit').catch(()=>{});
    if(path.dirname(directory)===__dirname&&path.basename(directory).startsWith('document-data-'))await fs.rm(directory,{recursive:true,force:true});
  }
});
