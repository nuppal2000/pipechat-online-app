(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./table-schema.js'):root.PipeChatSchema);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PipeChatSheets=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Schema){
  'use strict';
  const maxBytes=5000000,maxRows=2000,maxColumns=100;
  function withSource(matrix,source){
    // Enumerable metadata survives the existing Web Worker's structured clone.
    if(source)Object.defineProperty(matrix,'source',{value:source,enumerable:true});
    return matrix;
  }
  function checkMatrix(matrix){
    if(!Array.isArray(matrix)||!matrix.length||matrix.length>maxRows+1||matrix.some(row=>!Array.isArray(row)||row.length>maxColumns||row.some(cell=>typeof cell!=='string'||cell.length>12000||cell.includes('\0'))))throw new Error('Choose a sheet with at most 100 columns, 2,000 data rows and 12,000 characters per cell.');
    const width=Math.max(...matrix.map(row=>row.length));
    if(!width)throw new Error('This sheet is empty.');
    return withSource(matrix.map(row=>Array.from({length:width},(_,i)=>row[i]??'')),matrix.source);
  }
  function fromCsv(text,Papa){
    const result=Papa.parse(text,{header:false,dynamicTyping:false,skipEmptyLines:false});
    const error=result.errors.find(e=>e.code!=='UndetectableDelimiter');
    if(error)throw new Error('Invalid CSV: '+error.message);
    const rows=result.data;
    while(rows.length&&rows.at(-1).every(cell=>cell===''))rows.pop();
    return checkMatrix(rows);
  }
  function fromWorkbook(workbook,name,XLSX){
    const sheet=workbook.Sheets[name];
    if(!sheet?.['!ref'])throw new Error('This worksheet is empty. Choose another worksheet.');
    const range=XLSX.utils.decode_range(sheet['!fullref']||sheet['!ref']);
    if(range.e.r-range.s.r>maxRows||range.e.c-range.s.c>=maxColumns)throw new Error('This worksheet exceeds 100 columns or 2,000 data rows. Export a smaller range.');
    const matrix=[],cells=[];let missingFormula=false;
    for(let r=range.s.r;r<=range.e.r;r++){
      const row=[],sources=[];
      for(let c=range.s.c;c<=range.e.c;c++){
        const cell=sheet[XLSX.utils.encode_cell({r,c})];
        if(cell?.f&&cell.v===undefined)missingFormula=true;
        // SheetJS may cache formatted text on the cell; do not mutate the source.
        const display=!cell||cell.t==='z'?'':String(cell.w??XLSX.utils.format_cell({...cell}));
        row.push(display);
        sources.push({row:r+1,column:c+1,address:XLSX.utils.encode_cell({r,c}),sheet:name,rawValue:cell?.v instanceof Date?cell.v.toISOString():cell?.v??null,displayValue:display,cellType:cell?.t??null,formula:cell?.f??null,format:cell?.z??null});
      }
      matrix.push(row);
      cells.push(sources);
    }
    if(missingFormula)throw new Error('A formula has no saved result. Recalculate and save the workbook in Excel or Google Sheets, then upload it again.');
    if(sheet['!merges']?.length)throw new Error('Merged cells cannot be represented as individual CRM cells. Upload an unmerged worksheet.');
    while(matrix.length&&matrix.at(-1).every(cell=>cell===''))matrix.pop();
    if(!matrix.length)throw new Error('This worksheet is empty. Choose another worksheet.');
    const source={sheet:name,sourceRows:matrix.slice(1).map((_,i)=>range.s.r+i+2),sourceColumns:matrix[0].map((_,i)=>range.s.c+i+1),cells:cells.slice(0,matrix.length)};
    return checkMatrix(withSource(matrix,source));
  }
  function build(matrix,{useCase,description='',name='Imported table',primary=0,idPrefix='import'}={}){
    const grid=checkMatrix(matrix),headers=grid[0],rows=grid.slice(1);
    if(!Number.isInteger(primary)||primary<0||primary>=headers.length)throw new Error('Choose the primary column.');
    const unnamed=rows.flatMap((row,index)=>!row[primary].trim()?[index+2]:[]);
    if(unnamed.length)throw new Error(`The primary column has blank names on spreadsheet rows ${unnamed.slice(0,20).join(', ')}${unnamed.length>20?' and more':''}. Choose a populated identifying column or fill these names before importing.`);
    const used=new Set();
    const fields=headers.map((header,i)=>{
      const nonblank=rows.map(r=>r[i]).filter(v=>v!=='');
      // Only canonical numbers become numeric fields: formatted amounts, dates,
      // identifiers and mixed columns stay text so display values are not changed.
      let type=i!==primary&&nonblank.length&&nonblank.every(v=>Number.isFinite(Number(v))&&Math.abs(Number(v))<=1e12&&String(Number(v))===v)?'number':'text';
      const key=header.trim().toLowerCase();
      let role=i===primary?'primary':type==='text'&&/^(owner|recruiter|assigned to|agent)$/.test(key)?'owner':type==='text'&&/^(stage|status|hiring stage|recruiting stage)$/.test(key)?'status':'none';
      if(role!=='none'&&used.has(role))role='none';used.add(role);
      return {id:'f_'+idPrefix+'_'+i,name:header,type,role,options:[]};
    });
    const schema=Schema.validate({status:'ready',source:'spreadsheet',useCase,description,title:name.replace(/\.[^.]+$/,'').trim().slice(0,60)||'Imported table',recordLabel:'record',fields});
    const records=rows.map((row,index)=>({id:index+1,...Object.fromEntries(fields.map((f,i)=>[f.id,f.type==='number'?(row[i]===''?null:Number(row[i])):row[i]])),history:[],activity:'',health:''}));
    if(new TextEncoder().encode(JSON.stringify({deals:records,tableSchema:schema,customFields:[]})).length>12000000)throw new Error('The populated table is too large. Upload a smaller worksheet.');
    return {schema,records};
  }
  function mappingSource(matrix){
    const grid=checkMatrix(matrix),headers=grid[0];
    const keys=headers.map(header=>header.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ').replace(/[_-]+/g,' '));
    if(headers.some(header=>!header.trim())||new Set(keys).size!==headers.length)throw new Error('Mapping requires unique, nonblank source headers. Rename duplicate or blank columns before mapping.');
    const source=grid.source||{sheet:null,sourceRows:grid.slice(1).map((_,i)=>i+2),sourceColumns:headers.map((_,i)=>i+1)};
    return {headers,rows:grid.slice(1).map(row=>Object.fromEntries(headers.map((header,index)=>[header,row[index]]))),source};
  }
  return {maxBytes,maxRows,maxColumns,checkMatrix,fromCsv,fromWorkbook,build,mappingSource};
});
