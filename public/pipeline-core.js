(function (root, factory) {
  const schemaApi = typeof module === 'object' && module.exports ? require('./table-schema.js') : root.PipeChatSchema;
  const api = factory(null,schemaApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PipelineCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function factory(schema,schemaApi) {
  'use strict';
  const fields = schema ? Object.fromEntries(schema.fields.map(f=>[f.id,f.name])) : { account: 'Company', stage: 'Stage', value: 'Value', close: 'Close date', owner: 'Owner', next: 'Next step', follow: 'Follow-up', notes: 'Notes' };
  const role = name => schema ? schema.fields.find(f=>f.role===name)?.id : ({primary:'account',owner:'owner',status:'stage',followup:'follow'})[name];
  const primary=role('primary');
  const stages = schema ? schema.fields.find(f=>f.role==='status')?.options||[] : ['Discovery', 'Warm', 'Proposal Sent', 'Negotiation', 'At Risk', 'Won', 'Lost'];
  const definitions = customFields => schema ? [...schema.fields,...validateCustomFields(customFields)] : [...Object.entries(fields).map(([id,name])=>({id,name,type:id==='value'?'currency':id==='close'?'date':id==='stage'?'choice':'text',role:Object.entries({primary:'account',owner:'owner',status:'stage',followup:'follow'}).find(([,key])=>key===id)?.[0]||'none',options:id==='stage'?stages:[]})),...validateCustomFields(customFields)];
  const operators = ['equals', 'contains', 'is_blank', 'gt', 'gte', 'lt', 'lte', 'month_equals'];
  const normalize = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
  const clone = value => JSON.parse(JSON.stringify(value));
  function validateCustomFields(input = []) {
    if (!Array.isArray(input) || input.length > 20) throw new Error('A CRM supports up to 20 custom text fields.');
    const ids = new Set(), names = new Set(Object.values(fields).map(normalize));
    return input.map(field => {
      if (!field || typeof field.id !== 'string' || !/^cf_[a-z0-9_]{1,60}$/.test(field.id) || ids.has(field.id) || Object.hasOwn(fields,field.id) || field.type !== 'text') throw new Error('Invalid custom field definition.');
      if (typeof field.name !== 'string') throw new Error('Enter a field name.');
      const name = field.name.trim(), key = normalize(name);
      if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Field names must contain 1 to 60 readable characters.');
      if (names.has(key) || [...Object.keys(fields),'id','activity','health','history','__proto__','prototype','constructor'].includes(fieldName(name))) throw new Error('A field with that name already exists or is reserved.');
      ids.add(field.id); names.add(key);
      return {id:field.id,name,type:'text'};
    });
  }
  function fieldsFor(customFields = []) {
    return {...fields,...Object.fromEntries(validateCustomFields(customFields).map(field=>[field.id,field.name]))};
  }
  function customValues(record, customFields = []) {
    const definitions=validateCustomFields(customFields), allowed=new Set([...Object.keys(fields),...definitions.map(field=>field.id)]);
    if (Object.keys(record).some(key=>key.startsWith('cf_')&&!allowed.has(key))) throw new Error('Unknown custom field. Refresh before saving.');
    return Object.fromEntries(definitions.map(field=>[field.id,validateStoredValue(field.id,record[field.id]??'',definitions)]));
  }
  function fieldName(value, customFields = []) {
    if(schema){const found=definitions(customFields).find(f=>f.id===value||normalize(f.name)===normalize(value));return found?.id||String(value);}
    const custom = customFields.find(field=>field.id===value || normalize(field.name)===normalize(value));
    if (custom) return custom.id;
    const key = normalize(value).replace(/[\s-]+/g, '_');
    const aliases={ company:'account', name:'account', status:'stage', amount:'value', close_date:'close', next_step:'next', follow_up:'follow', note:'notes', rep:'owner', salesperson:'owner' };
    return Object.hasOwn(aliases,key)?aliases[key]:key;
  }
  function date(value) {
    const text = String(value || '').trim();
    let parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (parts) {
      const d = new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3]));
      return d.toISOString().slice(0, 10) === text ? d : null;
    }
    parts = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text);
    if (!parts) return null;
    const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(parts[1].slice(0,3).toLowerCase());
    const d = new Date(Date.UTC(+parts[3], month, +parts[2]));
    return d.getUTCMonth() === month && d.getUTCDate() === +parts[2] ? d : null;
  }
  function validateValue(field, value, customFields = []) {
    const labels=fieldsFor(customFields);
    if (!Object.hasOwn(labels, field)) throw new Error('This table does not contain that field.');
    if(schema){
      const def=definitions(customFields).find(f=>f.id===field);
      if(value==null||value==='')return ['number','currency'].includes(def.type)?null:'';
      if(['number','currency'].includes(def.type)){
        if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))||Math.abs(Number(value))>1e12)throw new Error('Enter a valid number between -1 trillion and 1 trillion.');
        if(schema.legacy&&field==='value'&&Number(value)<0)throw new Error('Value must not be negative.');
        return def.type==='currency'?Math.round(Number(value)*100)/100:Number(value);
      }
      if(typeof value!=='string'||value.length>12000)throw new Error('Enter text of at most 12,000 characters.');
      const text=value.trim();
      if(def.type==='date'){const parsed=date(text);if(!parsed)throw new Error('Enter a complete, valid date.');return parsed.toISOString().slice(0,10);}
      if(def.type==='choice'){const option=def.options.find(v=>normalize(v)===normalize(text));if(!option)throw new Error('Choose one of this field\'s options.');return option;}
      return text;
    }
    if (value === null || value === undefined) throw new Error(`Specify a value for ${labels[field]}.`);
    if (field.startsWith('cf_') && typeof value !== 'string') throw new Error('Custom text fields require text.');
    if (field === 'value') {
      if (String(value).trim() === '' || typeof value === 'boolean' || typeof value === 'object') throw new Error('Enter a valid deal value.');
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new Error('Value must be a number between 0 and 1 trillion.');
      return Math.round(amount * 100) / 100;
    }
    let text = String(value).trim();
    if (text.length > 12000) throw new Error('This field is too long.');
    if (field === 'account' && !text) throw new Error('Company name is required.');
    if (field === 'stage') {
      const aliases = { proposal:'Proposal Sent', quote:'Proposal Sent', 'closed won':'Won', 'closed lost':'Lost' };
      text = aliases[normalize(text)] || stages.find(stage => normalize(stage) === normalize(text));
      if (!text) throw new Error('Choose one of the existing stages.');
    }
    if (field === 'close' && text) {
      const parsed = date(text);
      if (!parsed) throw new Error('Use a complete, valid close date, including its year.');
      text = parsed.toISOString().slice(0, 10);
    }
    return text;
  }
  function predicate(filter, customFields = []) {
    if (!filter) return () => true;
    const field = fieldName(filter.field,customFields);
    if (![...Object.keys(fieldsFor(customFields)), 'health', 'activity'].includes(field) || !operators.includes(filter.operator)) throw new Error('That filter is not supported.');
    const value = filter.value;
    if(schema){
      const def=definitions(customFields).find(f=>f.id===field);
      if(!def)throw new Error('Unknown filter field.');
      if(filter.operator==='is_blank')return row=>row[field]==null||row[field]==='';
      let expected=value;
      if(def.type==='date'&&normalize(value)==='today'){const d=new Date();expected=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
      if(filter.operator==='equals'){
        if(schema.legacy&&field==='follow'&&normalize(expected)==='today'){const d=new Date(),today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;return row=>normalize(row[field])==='today'||row[field]===today;}
        expected=validateStoredValue(field,expected,customFields);return row=>normalize(row[field])===normalize(expected);
      }
      if(filter.operator==='contains'&&normalize(value))return row=>normalize(row[field]).includes(normalize(value));
      if(filter.operator==='month_equals'&&def.type==='date'&&Number.isInteger(Number(value))&&Number(value)>=1&&Number(value)<=12)return row=>date(row[field])?.getUTCMonth()+1===Number(value);
      if(['number','currency'].includes(def.type)&&['gt','gte','lt','lte'].includes(filter.operator)&&value!=null&&value!==''&&Number.isFinite(Number(value)))return row=>row[field]!=null&&row[field]!==''&&({gt:row[field]>Number(value),gte:row[field]>=Number(value),lt:row[field]<Number(value),lte:row[field]<=Number(value)})[filter.operator];
      throw new Error('Unsupported filter for this field type.');
    }
    if (filter.operator === 'is_blank') return record => record[field] === '' || record[field] == null;
    if (value === null || value === undefined || (filter.operator === 'contains' && !normalize(value))) throw new Error('Specify the filter value.');
    if (filter.operator === 'equals') {
      const expected = normalize(field === 'stage' ? validateValue(field, value) : value);
      if (field === 'follow' && expected === 'today') {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        return record => normalize(record.follow) === 'today' || record.follow === today;
      }
      return record => normalize(record[field]) === expected;
    }
    if (filter.operator === 'contains') return record => normalize(record[field]).includes(normalize(value));
    if (filter.operator === 'month_equals') {
      if (field !== 'close' || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 12) throw new Error('Choose a close-date month from 1 to 12.');
      return record => date(record.close)?.getUTCMonth() + 1 === Number(value);
    }
    if (field !== 'value' || !Number.isFinite(Number(value))) throw new Error('Numeric comparisons require the value field.');
    return record => record.value !== null && record.value !== '' && record.value !== undefined && ({ gt: Number(record.value) > Number(value), gte: Number(record.value) >= Number(value), lt: Number(record.value) < Number(value), lte: Number(record.value) <= Number(value) })[filter.operator];
  }
  function validateStoredValue(field, value, customFields = []) {
    if (field === 'value' && (value === null || value === '')) return null;
    if (['account','stage'].includes(field) && value === '') return '';
    return validateValue(field,value,customFields);
  }
  function candidates(records, reference) {
    const query = normalize(reference);
    if (!query) return [];
    const exact = records.filter(record => normalize(record[primary]) === query);
    return exact.length ? exact : records.filter(record => normalize(record[primary]).includes(query));
  }
  function targets(records, action, allowMany, customFields = []) {
    // Names take precedence over model-supplied IDs so an ambiguous name cannot silently select an arbitrary record.
    if (action.recordMatch) {
      const found = candidates(records, action.recordMatch);
      if (found.length > 1) return { candidates:found };
      if (!found.length) throw new Error(`No company matches "${action.recordMatch}".`);
      return { records:found };
    }
    if (action.filter) {
      if (!allowMany) throw new Error('A single-record change needs a specific company.');
      return { records:records.filter(predicate(action.filter,customFields)) };
    }
    if (Array.isArray(action.ids) && action.ids.length) {
      const ids = [...new Set(action.ids.map(Number))];
      const found = ids.map(id => records.find(record => record.id === id));
      if (found.some(record => !record)) throw new Error('A selected record no longer exists.');
      if (!allowMany && found.length > 1) return { candidates:found };
      return { records:found };
    }
    throw new Error('Which company should I update?');
  }
  function plan(records, action, customFields = []) {
    const changes = action.action === 'update_records' ? action.changes : [{ ...action, operation:action.operation || 'set' }];
    if (!Array.isArray(changes) || !changes.length || changes.length > 200) throw new Error('No valid changes were provided.');
    const patches = new Map();
    for (const [index, change] of changes.entries()) {
      const field = fieldName(change.field,customFields);
      const selection = targets(records, change, action.action === 'bulk_update' || Boolean(change.filter),customFields);
      if (selection.candidates) return { clarification:{action:clone(action), changeIndex:action.action === 'update_records' ? index : null, candidates:selection.candidates.map(record => ({id:record.id,account:record[primary],owner:record[role('owner')],stage:record[role('status')]}))} };
      if (!selection.records.length) throw new Error('No records match this request.');
      const value = validateStoredValue(field, change.value,customFields);
      if (change.operation && !['set','append'].includes(change.operation)) throw new Error('Unsupported change operation.');
      if (change.operation === 'append' && (schema?definitions(customFields).find(f=>f.id===field)?.type!=='text':field!=='notes')) throw new Error('Only text notes support append.');
      for (const record of selection.records) {
        const patch = patches.get(record.id) || { id:record.id, account:record[primary], before:{}, after:{} };
        if (!Object.hasOwn(patch.before, field)) patch.before[field] = record[field] === undefined ? '' : record[field];
        const previous = patch.after[field] ?? record[field];
        patch.after[field] = change.operation === 'append' ? [previous, value].filter(Boolean).join('\n') : value;
        patches.set(record.id, patch);
      }
    }
    const result = [...patches.values()].map(patch => {
      for (const field of Object.keys(patch.after)) if (patch.after[field] === patch.before[field]) { delete patch.after[field]; delete patch.before[field]; }
      return patch;
    }).filter(patch => Object.keys(patch.after).length);
    if (!result.length) throw new Error('Those records already have the requested values.');
    return { kind:'update', title:action.title || 'Proposed changes', patches:result, count:result.length, createdAt:Date.now() };
  }
  function apply(records, proposal, actor, now = new Date(), customFields = []) {
    const labels=fieldsFor(customFields);
    if (now.getTime() - proposal.createdAt > 30 * 60 * 1000) throw new Error('This preview has expired. Ask PipeChat to prepare it again.');
    for (const patch of proposal.patches) {
      const record = records.find(item => item.id === patch.id);
      if (!record || Object.entries(patch.before).some(([field, value]) => (record[field] === undefined ? '' : record[field]) !== value)) throw new Error('A record changed after this preview. Prepare a new preview before confirming.');
    }
    const result = clone(records);
    for (const patch of proposal.patches) {
      const record = result.find(item => item.id === patch.id);
      Object.assign(record, patch.after, {activity:'just now',health:'updated'});
      record.history = record.history || [];
      for (const [field, value] of Object.entries(patch.after)) record.history.unshift(`${now.toISOString()} | ${actor}: ${labels[field]} changed from "${patch.before[field]}" to "${value}".`);
    }
    return result;
  }
  function report(records, spec, customFields = []) {
    if(schema||customFields.some(f=>f.id===spec?.groupBy))return contextualReport(records,spec,customFields);
    if (!spec || !['sum','count','average'].includes(spec.metric) || !['owner','account','stage','close_month','none'].includes(spec.groupBy) || !['bar','line','stage','kpi'].includes(spec.chart)) throw new Error('Choose a supported metric, grouping, and chart.');
    if (spec.metric !== 'count' && spec.field !== 'value') throw new Error('Sum and average reports use the value field.');
    const selections = [['owners','owner'],['accounts','account']].map(([key,field]) => {
      const values=spec[key];
      if (values == null) return {key,field,names:null};
      if (!Array.isArray(values) || values.length>2000 || values.some(value=>typeof value!=='string'||value.length>12000)) throw new Error(`Choose a valid list of ${key}.`);
      return {key,field,names:new Map(values.map(value=>[normalize(value),value.trim()]))};
    });
    const start = spec.from ? date(spec.from) : null, end = spec.to ? date(spec.to) : null;
    if ((spec.from && !start) || (spec.to && !end) || (start && end && start > end)) throw new Error('Choose a valid date range.');
    const rows = records.filter(predicate(spec.filter,customFields)).filter(record => selections.every(({field,names})=>names===null||names.has(normalize(record[field])))).filter(record => {
      if (!start && !end) return true;
      const d = date(record.close); return d && (!start || d >= start) && (!end || d <= end);
    });
    const groups = new Map(); let undated = 0;
    for (const record of rows) {
      const d = date(record.close);
      if (spec.groupBy === 'close_month' && !d) { undated++; continue; }
      const label = spec.groupBy === 'none' ? 'All deals' : spec.groupBy === 'close_month' ? d.toISOString().slice(0,7) : String(record[spec.groupBy] || '').trim() || (spec.groupBy==='account'?'Unnamed account':'Unassigned');
      const key = ['owner','account'].includes(spec.groupBy) ? normalize(record[spec.groupBy]) : label;
      const group = groups.get(key) || {label,count:0,cents:0,known:0};
      group.count++;
      if (record.value !== null && record.value !== '' && record.value !== undefined) { group.known++; group.cents += Math.round((Number(record.value) || 0) * 100); }
      groups.set(key,group);
    }
    let data = [...groups.values()].map(group=>({label:group.label,value:spec.metric==='count'?group.count:!group.known?null:Math.round(group.cents/(spec.metric==='average'?group.known:1))/100,count:group.count}));
    data.sort((a,b)=>spec.groupBy==='close_month'?a.label.localeCompare(b.label):b.value-a.value||a.label.localeCompare(b.label));
    // Missing months are zero-filled so the line's spacing represents calendar time.
    if (spec.groupBy === 'close_month' && data.length) {
      const first = date(data[0].label+'-01'), last = date(data.at(-1).label+'-01');
      const months = (last.getUTCFullYear()-first.getUTCFullYear())*12+last.getUTCMonth()-first.getUTCMonth();
      if (months > 240) throw new Error('Limit monthly charts to a 20-year date range.');
      const byMonth = new Map(data.map(item=>[item.label,item])); data=[];
      for(let d=new Date(first);d<=last;d.setUTCMonth(d.getUTCMonth()+1)) { const label=d.toISOString().slice(0,7);data.push(byMonth.get(label)||{label,value:0,count:0}); }
    }
    const result={data,count:rows.length,undated};
    for (const {key,field,names} of selections) if(names!==null) {
      const present=new Set(rows.map(record=>normalize(record[field])));
      result[key==='owners'?'missingOwners':'missingAccounts']=[...names].filter(([name])=>!present.has(name)).map(([,label])=>label);
    }
    return result;
  }
  function share(records, selectedFields) {
    const allowed = schema ? Object.keys(fields) : ['account','stage','value','close','owner'];
    if (!Array.isArray(selectedFields) || selectedFields.some(field=>!allowed.includes(field))) throw new Error('Only public preview fields may be shared.');
    return records.map(record=>Object.fromEntries(selectedFields.map(field=>[field,record[field]])));
  }
  function tableValues(record,customFields=[]){
    const allowed=new Set(Object.keys(fieldsFor(customFields)));
    if(Object.keys(record).some(key=>key.startsWith('f_')&&!allowed.has(key)))throw new Error('Unknown table field. Reload before saving.');
    return Object.fromEntries([...allowed].map(key=>[key,validateStoredValue(key,record[key]??(['number','currency'].includes(definitions(customFields).find(f=>f.id===key)?.type)?null:''),customFields)]));
  }
  function reportOptions(customFields=[]){
    const defs=definitions(customFields);
    return {metrics:defs.filter(f=>['number','currency'].includes(f.type)),groups:defs.map(f=>({id:f.id,name:f.name})).concat(defs.filter(f=>f.type==='date').map(f=>({id:f.id+'_month',name:f.name+' month'})))};
  }
  function sortRecords(records,sort,customFields=[]){
    const def=definitions(customFields).find(f=>f.id===sort?.field);
    if(!def||!['asc','desc'].includes(sort.direction))return [...records];
    const collator=new Intl.Collator(undefined,{sensitivity:'base'}),direction=sort.direction==='asc'?1:-1;
    const key=value=>value==null||value===''?null:['number','currency'].includes(def.type)?Number.isFinite(Number(value))?Number(value):null:def.type==='date'?date(value)?.getTime()??null:String(value);
    return records.map((record,index)=>({record,index,key:key(record[def.id])})).sort((a,b)=>{
      if(a.key===null||b.key===null)return a.key===b.key?a.index-b.index:a.key===null?1:-1;
      const order=typeof a.key==='number'?a.key-b.key:collator.compare(a.key,b.key);
      return direction*order||a.index-b.index;
    }).map(item=>item.record);
  }
  function deleteColumn(records,fieldId,customFields=[],replacement=null){
    const defs=definitions(customFields),field=defs.find(f=>f.id===fieldId);
    if(!field)throw new Error('This column no longer exists.');
    const isPrimary=field.id===primary;
    if(!isPrimary&&replacement)throw new Error('Only the primary field needs a replacement.');
    let nextSchema=schema?clone(schema):field.id.startsWith('cf_')?null:schemaApi.legacySchema();
    let nextFields=customFields.filter(f=>f.id!==field.id),next=records.map(record=>{const copy={...record};delete copy[field.id];return copy;}),selected=null;
    if(isPrimary){
      if(!replacement||Boolean(replacement.field)===Boolean(replacement.name))throw new Error('Choose an existing text field or name a new primary field.');
      if(replacement.field){
        selected=defs.find(f=>f.id===fieldName(replacement.field,customFields));
        if(!selected||selected.id===field.id||selected.type!=='text')throw new Error('Choose a different existing text field.');
      }else{
        const candidate={id:'cf_primary_candidate',name:replacement.name,type:'text'};
        validateCustomFields([...customFields,candidate]);
        if(!/^f_[a-z0-9_]{1,60}$/.test(replacement.id||'')||defs.some(f=>f.id===replacement.id))throw new Error('Invalid replacement field ID.');
        selected={id:replacement.id,name:candidate.name.trim(),type:'text',role:'primary',options:[]};
        next=next.map(record=>({...record,[selected.id]:''}));
      }
      selected={...selected,role:'primary',options:[]};
      const index=nextSchema.fields.findIndex(f=>f.id===field.id);
      nextSchema.fields=nextSchema.fields.filter(f=>f.id!==field.id&&f.id!==selected.id);
      nextSchema.fields.splice(Math.max(0,index),0,selected);
      nextSchema.recordLabel=selected.name;
      nextFields=nextFields.filter(f=>f.id!==selected.id);
    }else if(nextSchema)nextSchema.fields=nextSchema.fields.filter(f=>f.id!==field.id);
    nextSchema=schemaApi.transition(schema,nextSchema,next);
    const nextCore=nextSchema?factory(nextSchema,schemaApi):factory(null,schemaApi);
    nextCore.validateCustomFields(nextFields);
    for(const row of next)nextSchema?nextCore.tableValues(row,nextFields):nextCore.customValues(row,nextFields);
    return {records:next,customFields:nextFields,tableSchema:nextSchema,field,replacement:selected,replacementIsNew:Boolean(replacement?.name)};
  }
  function reconcileReport(spec,customFields=[]){
    const options=reportOptions(customFields),next={...spec};
    if(!['sum','average','count'].includes(next.metric))next.metric='count';
    if(!options.metrics.some(f=>f.id===next.field)){next.field=options.metrics[0]?.id||null;if(!next.field)next.metric='count';}
    if(!options.groups.some(f=>f.id===next.groupBy)&&next.groupBy!=='none')next.groupBy=role('status')||role('owner')||'none';
    if(!['bar','line','stage','kpi'].includes(next.chart))next.chart='bar';
    if(next.filter&&!Object.hasOwn(fieldsFor(customFields),fieldName(next.filter.field,customFields)))next.filter=null;
    if(!role('owner'))next.owners=null;
    if(schema&&(!next.dateField||!definitions(customFields).some(f=>f.id===next.dateField&&f.type==='date'))){next.dateField=null;next.from=null;next.to=null;}
    return next;
  }
  function contextualReport(records,spec,customFields=[]){
    const options=reportOptions(customFields),defs=definitions(customFields);
    if(!spec||!['sum','average','count'].includes(spec.metric)||!['bar','line','stage','kpi'].includes(spec.chart)||spec.groupBy!=='none'&&!options.groups.some(f=>f.id===spec.groupBy))throw new Error('Choose a metric and grouping from this table.');
    const metric=options.metrics.find(f=>f.id===spec.field);
    if(spec.metric!=='count'&&!metric)throw new Error('Sum and average require a numeric field.');
    const dateField=schema?spec.dateField:'close',start=spec.from?date(spec.from):null,end=spec.to?date(spec.to):null;
    if((spec.from||spec.to)&&(!defs.some(f=>f.id===dateField&&f.type==='date')||spec.from&&!start||spec.to&&!end||start&&end&&start>end))throw new Error('Choose a valid date field and range.');
    const selections=[['owners',role('owner')],['accounts',primary]].map(([key,field])=>{
      const list=spec[key];if(list!=null&&(!field||!Array.isArray(list)||list.length>2000||list.some(v=>typeof v!=='string'||v.length>12000)))throw new Error('Invalid comparison selection.');
      return {key,field,names:list==null?null:new Map(list.map(v=>[normalize(v),v]))};
    });
    const rows=records.filter(predicate(spec.filter,customFields)).filter(row=>selections.every(s=>s.names===null||s.names.has(normalize(row[s.field])))).filter(row=>!start&&!end||date(row[dateField])&&(!start||date(row[dateField])>=start)&&(!end||date(row[dateField])<=end));
    const monthly=defs.some(f=>f.type==='date'&&f.id+'_month'===spec.groupBy),groupField=monthly?spec.groupBy.slice(0,-6):spec.groupBy,groups=new Map();let undated=0;
    for(const row of rows){
      if(monthly&&!date(row[groupField])){undated++;continue;}
      const label=spec.groupBy==='none'?'All records':monthly?date(row[groupField]).toISOString().slice(0,7):String(row[groupField]??'').trim()||'Not set',key=normalize(label);
      const group=groups.get(key)||{label,count:0,total:0,known:0};group.count++;
      if(row[spec.field]!=null&&row[spec.field]!==''&&Number.isFinite(Number(row[spec.field]))){group.known++;group.total+=metric?.type==='currency'?Math.round(Number(row[spec.field])*100):Number(row[spec.field]);}
      groups.set(key,group);
    }
    const data=[...groups.values()].map(g=>({label:g.label,count:g.count,value:spec.metric==='count'?g.count:!g.known?null:g.total/(spec.metric==='average'?g.known:1)/(metric?.type==='currency'?100:1)})).sort((a,b)=>monthly?a.label.localeCompare(b.label):b.value-a.value||a.label.localeCompare(b.label));
    const result={data,count:rows.length,undated};
    for(const s of selections)if(s.names)result[s.key==='owners'?'missingOwners':'missingAccounts']=[...s.names].filter(([key])=>!rows.some(row=>normalize(row[s.field])===key)).map(([,name])=>name);
    return result;
  }
  return {fields,stages,operators,normalize,fieldName,date,validateValue,validateStoredValue,validateCustomFields,fieldsFor,customValues,predicate,candidates,targets,plan,apply,report,share,clone,definitions,role,tableValues,reportOptions,reconcileReport,contextualReport,sortRecords,deleteColumn,create:input=>{const validated=schemaApi.validate(input);return validated?.status==='ready'?factory(validated,schemaApi):factory(null,schemaApi);}};
});
