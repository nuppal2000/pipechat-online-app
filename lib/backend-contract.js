const core = require('../public/pipeline-core.js');
const schemaCore=require('../public/table-schema.js');

class BackendError extends Error {
  constructor(message, status = 503, usage) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.usage = usage;
  }
}

function usageResult(input) {
  const usage = input?.usage ?? input;
  for (const key of ['used', 'limit', 'reserved']) {
    if (!Number.isSafeInteger(usage?.[key]) || usage[key] < 0) {
      throw new BackendError('The storage backend returned invalid usage data.');
    }
  }
  const remaining = Math.max(usage.limit - usage.used - usage.reserved, 0);
  if (usage.remaining !== remaining) throw new BackendError('The storage backend usage totals are inconsistent.');
  return { used: usage.used, limit: usage.limit, reserved: usage.reserved, remaining,
    paymentRequired: remaining === 0, updatedAt: usage.updatedAt ?? null };
}

function snapshotResult(input) {
  if (!input || !Array.isArray(input.deals) || input.deals.length > 2000 ||
      !(input.updatedAt === null || (typeof input.updatedAt === 'string' && input.updatedAt.length > 0))) {
    throw new BackendError('The storage backend returned invalid CRM data. Nothing has been replaced locally.');
  }
  let customFields,tableSchema,table;
  try {tableSchema=schemaCore.validate(input.tableSchema);table=core.create(tableSchema);customFields=table.validateCustomFields(input.customFields);}
  catch {throw new BackendError('The storage backend returned invalid custom field definitions.');}
  const ids = new Set();
  const deals = input.deals.map(record => {
    if (!record || !Number.isSafeInteger(record.id) || record.id < 1 || ids.has(record.id)) {
      throw new BackendError('The storage backend returned invalid or duplicate deal IDs.');
    }
    ids.add(record.id);
    const result = { id: record.id };
    try {
      if(tableSchema?.status==='ready')Object.assign(result,table.tableValues(record,customFields));
      else for (const field of Object.keys(core.fields)) result[field] = core.validateStoredValue(field, record[field]);
      Object.assign(result,table.customValues(record,customFields));
      if (!Array.isArray(record.history) || record.history.some(item => typeof item !== 'string')) throw new Error('Invalid history');
      result.history = record.history;
      result.activity = typeof record.activity === 'string' ? record.activity : '';
      result.health = typeof record.health === 'string' ? record.health : '';
    } catch {
      throw new BackendError('The storage backend returned a deal that does not match the PipeChat schema.');
    }
    return result;
  });
  // Do not leak internal backend IDs, credentials or fields through the proxy.
  if(tableSchema?.status==='pending'&&deals.length)throw new BackendError('Unconfigured workspace contains records.');
  return { deals, updatedAt: input.updatedAt, ...(Object.hasOwn(input,'customFields')?{customFields}:{}),...(tableSchema?{tableSchema}:{}) };
}

module.exports = { BackendError, snapshotResult, usageResult };
