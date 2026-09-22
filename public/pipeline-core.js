(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PipelineCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const fields = { account: 'Company', stage: 'Stage', value: 'Value', close: 'Close date', owner: 'Owner', next: 'Next step', follow: 'Follow-up', notes: 'Notes' };
  const stages = ['Discovery', 'Warm', 'Proposal Sent', 'Negotiation', 'At Risk', 'Won', 'Lost'];
  const operators = ['equals', 'contains', 'is_blank', 'gt', 'gte', 'lt', 'lte', 'month_equals'];
  const normalize = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
  const clone = value => JSON.parse(JSON.stringify(value));
  function fieldName(value) {
    const key = normalize(value).replace(/[\s-]+/g, '_');
    return ({ company:'account', name:'account', status:'stage', amount:'value', close_date:'close', next_step:'next', follow_up:'follow', note:'notes', rep:'owner', salesperson:'owner' })[key] || key;
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
  function validateValue(field, value) {
    if (!Object.hasOwn(fields, field)) throw new Error('This prototype does not support that field.');
    if (value === null || value === undefined) throw new Error(`Specify a value for ${fields[field]}.`);
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
  function predicate(filter) {
    if (!filter) return () => true;
    const field = fieldName(filter.field);
    if (![...Object.keys(fields), 'health', 'activity'].includes(field) || !operators.includes(filter.operator)) throw new Error('That filter is not supported.');
    const value = filter.value;
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
  function validateStoredValue(field, value) {
    if (field === 'value' && (value === null || value === '')) return null;
    if (['account','stage'].includes(field) && value === '') return '';
    return validateValue(field,value);
  }
  function candidates(records, reference) {
    const query = normalize(reference);
    if (!query) return [];
    const exact = records.filter(record => normalize(record.account) === query);
    return exact.length ? exact : records.filter(record => normalize(record.account).includes(query));
  }
  function targets(records, action, allowMany) {
    // Names take precedence over model-supplied IDs so an ambiguous name cannot silently select an arbitrary record.
    if (action.recordMatch) {
      const found = candidates(records, action.recordMatch);
      if (found.length > 1) return { candidates:found };
      if (!found.length) throw new Error(`No company matches "${action.recordMatch}".`);
      return { records:found };
    }
    if (action.filter) {
      if (!allowMany) throw new Error('A single-record change needs a specific company.');
      return { records:records.filter(predicate(action.filter)) };
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
  function plan(records, action) {
    const changes = action.action === 'update_records' ? action.changes : [{ ...action, operation:action.operation || 'set' }];
    if (!Array.isArray(changes) || !changes.length || changes.length > 200) throw new Error('No valid changes were provided.');
    const patches = new Map();
    for (const [index, change] of changes.entries()) {
      const field = fieldName(change.field);
      const selection = targets(records, change, action.action === 'bulk_update' || Boolean(change.filter));
      if (selection.candidates) return { clarification:{action:clone(action), changeIndex:action.action === 'update_records' ? index : null, candidates:selection.candidates.map(record => ({id:record.id,account:record.account,owner:record.owner,stage:record.stage}))} };
      if (!selection.records.length) throw new Error('No records match this request.');
      const value = validateStoredValue(field, change.value);
      if (change.operation && !['set','append'].includes(change.operation)) throw new Error('Unsupported change operation.');
      if (change.operation === 'append' && field !== 'notes') throw new Error('Only notes support append.');
      for (const record of selection.records) {
        const patch = patches.get(record.id) || { id:record.id, account:record.account, before:{}, after:{} };
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
  function apply(records, proposal, actor, now = new Date()) {
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
      for (const [field, value] of Object.entries(patch.after)) record.history.unshift(`${now.toISOString()} | ${actor}: ${fields[field]} changed from "${patch.before[field]}" to "${value}".`);
    }
    return result;
  }
  function report(records, spec) {
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
    const rows = records.filter(predicate(spec.filter)).filter(record => selections.every(({field,names})=>names===null||names.has(normalize(record[field])))).filter(record => {
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
    const allowed = ['account','stage','value','close','owner'];
    if (!Array.isArray(selectedFields) || selectedFields.some(field=>!allowed.includes(field))) throw new Error('Only public preview fields may be shared.');
    return records.map(record=>Object.fromEntries(selectedFields.map(field=>[field,record[field]])));
  }
  return {fields,stages,operators,normalize,fieldName,date,validateValue,validateStoredValue,predicate,candidates,targets,plan,apply,report,share,clone};
});
