'use strict';
const {BackendError}=require('./backend-contract.js');
const MAX_BYTES=5000000;
function exportUrl(value){
  if(typeof value!=='string'||value.length>2048)throw new BackendError('Enter a Google Sheets document link.',400);
  let url;try{url=new URL(value);}catch{throw new BackendError('Enter a valid Google Sheets link.',400);}
  const match=/^\/spreadsheets\/d\/(e\/)?([A-Za-z0-9_-]{10,200})(?:\/(?:edit|view|preview|export|pubhtml|pub))?\/?$/.exec(url.pathname);
  if(url.protocol!=='https:'||url.hostname!=='docs.google.com'||url.port||url.username||url.password||!match)throw new BackendError('Use an HTTPS docs.google.com/spreadsheets document link.',400);
  const gid=url.searchParams.get('gid')??new URLSearchParams(url.hash.slice(1)).get('gid');
  if(gid!==null&&!/^\d{1,16}$/.test(gid))throw new BackendError('Invalid worksheet ID in the link.',400);
  const result=new URL('https://docs.google.com/spreadsheets/d/'+(match[1]||'')+match[2]+(match[1]?'/pub':'/export'));
  result.searchParams.set(match[1]?'output':'format','csv');
  if(gid!==null)result.searchParams.set('gid',gid);
  const resourceKey=url.searchParams.get('resourcekey');
  if(resourceKey){if(!/^[A-Za-z0-9_-]{1,200}$/.test(resourceKey))throw new BackendError('Invalid Google Sheets link.',400);result.searchParams.set('resourcekey',resourceKey);}
  return result;
}
function safeRedirect(url){
  return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&
    (url.hostname==='docs.google.com'&&url.pathname.startsWith('/spreadsheets/')||/^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/.test(url.hostname));
}
function createSheetsReader({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=20000}={}){
  const attempts=new Map();let active=0;
  return async function readSheets(userId,value){
    let url=exportUrl(value);const time=now();
    for(const [id,b] of attempts)if(time-b.start>=60000)attempts.delete(id);
    const bucket=attempts.get(userId)||{start:time,count:0};
    if(bucket.count>=6||active>=4||attempts.size>=10000&&!attempts.has(userId))throw new BackendError('Spreadsheet downloads are busy. Try again in a minute.',429);
    bucket.count++;attempts.set(userId,bucket);active++;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      for(let hop=0;hop<=3;hop++){
        const response=await fetchImpl(url.href,{redirect:'manual',signal:controller.signal,headers:{Accept:'text/csv'},credentials:'omit'});
        if([301,302,303,307,308].includes(response.status)){
          const location=response.headers.get('location');await response.body?.cancel();
          if(!location)throw new Error('redirect');
          const next=new URL(location,url);
          if(!safeRedirect(next))throw new BackendError('This sheet needs Google sign-in. Download it as Excel or CSV and upload the file instead.',422);
          url=next;continue;
        }
        if(!response.ok){await response.body?.cancel();throw new BackendError(response.status===429?'Google is limiting downloads. Try again shortly.':'Unable to access this sheet. For private sheets, download Excel or CSV and upload the file.',response.status===429?429:422);}
        if(Number(response.headers.get('content-length'))>MAX_BYTES||/text\/html/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw new BackendError('The link did not return a CSV smaller than 5 MB. Download and upload the worksheet instead.',422);}
        const chunks=[];let size=0;const reader=response.body.getReader();
        try{while(true){const {done,value:chunk}=await reader.read();if(done)break;size+=chunk.length;if(size>MAX_BYTES)throw new BackendError('The worksheet exceeds 5 MB. Upload a smaller worksheet.',413);chunks.push(chunk);}}finally{await reader.cancel();}
        const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
        if(!text||/^\s*(?:<!doctype html|<html)/i.test(text))throw new BackendError('No spreadsheet data was returned. Download Excel or CSV and upload it instead.',422);
        return {name:'Google Sheets.csv',text};
      }
      throw new Error('redirect limit');
    }catch(error){if(error instanceof BackendError)throw error;throw new BackendError('Google Sheets could not be downloaded. Try again or upload an Excel/CSV export.',502);}
    finally{clearTimeout(timer);active--;}
  };
}
module.exports={exportUrl,safeRedirect,createSheetsReader};
