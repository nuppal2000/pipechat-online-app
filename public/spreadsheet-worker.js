'use strict';
importScripts('/vendor/xlsx.full.min.js','/vendor/papaparse.min.js','/table-schema.js','/spreadsheet-import.js');
self.onmessage=event=>{
  try{
    const {buffer,name,sheet}=event.data;
    if(!(buffer instanceof ArrayBuffer)||buffer.byteLength>PipeChatSheets.maxBytes)throw new Error('Choose a file smaller than 5 MB.');
    if(/\.csv$/i.test(name)){
      self.postMessage({names:[name],selected:name,matrix:PipeChatSheets.fromCsv(new TextDecoder('utf-8',{fatal:true}).decode(buffer),Papa)});return;
    }
    if(!/\.(xlsx|xls)$/i.test(name))throw new Error('Upload an Excel workbook (.xlsx or .xls) or a CSV exported from Google Sheets.');
    const names=XLSX.read(buffer,{type:'array',bookSheets:true}).SheetNames;
    if(!names.length||names.length>100)throw new Error('Choose a workbook containing between 1 and 100 worksheets.');
    const selected=sheet??names[0];if(!names.includes(selected))throw new Error('That worksheet is not in this workbook.');
    let matrix=null,error=null;
    try{
      const workbook=XLSX.read(buffer,{type:'array',sheets:selected,sheetRows:2002,cellText:true,cellFormula:true,cellHTML:false,cellDates:false,bookVBA:false,bookDeps:false});
      matrix=PipeChatSheets.fromWorkbook(workbook,selected,XLSX);
    }catch(e){error=e.message;}
    self.postMessage({names,selected,matrix,error});
  }catch(error){self.postMessage({error:error.message||'Unable to read this spreadsheet.'});}
};
