(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatImportDuplicates=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function key(value){return String(value??'').normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();}
  function review(existing,incoming,primary){
    const saved=new Set(existing.map(row=>key(row[primary])).filter(Boolean)),seen=new Set(),records=[],duplicates=[];
    incoming.forEach((row,index)=>{
      const identity=key(row[primary]),source=identity&&saved.has(identity)?'existing table':identity&&seen.has(identity)?'earlier imported row':null;
      if(source)duplicates.push({index,name:String(row[primary]),source});else records.push(row);
      if(identity)seen.add(identity);
    });
    return {records,duplicates,existingMatches:duplicates.filter(row=>row.source==='existing table').length,fileMatches:duplicates.filter(row=>row.source==='earlier imported row').length};
  }
  return {review};
});
