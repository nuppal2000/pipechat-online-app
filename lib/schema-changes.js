'use strict';
const { isDeepStrictEqual } = require('node:util');
const Actions = require('../public/business-actions');
const fail = () => { throw new Error('Invalid explicit choice rename. Review the schema change again.'); };

function validate(input) {
  if (!Array.isArray(input) || input.length > 64) fail();
  const sources = new Set(), targets = new Set();
  const result = input.map(change => {
    if (!Actions.exact(change, ['kind', 'fieldId', 'from', 'to']) || change.kind !== 'rename_choice_option' ||
      typeof change.fieldId !== 'string' || !/^[a-z][a-z0-9_]{0,64}$/.test(change.fieldId) ||
      ['constructor', 'prototype', '__proto__'].includes(change.fieldId) ||
      ![change.from, change.to].every(value => Actions.text(value, 80) && !/[\r\n\t]/.test(value)) || change.from === change.to) fail();
    const source = JSON.stringify([change.fieldId, change.from]), target = JSON.stringify([change.fieldId, change.to]);
    if (sources.has(source) || targets.has(target)) fail();
    sources.add(source); targets.add(target);
    return { kind: change.kind, fieldId: change.fieldId, from: change.from, to: change.to };
  });
  // A batch is simultaneous, never an inferred or order-dependent rename chain.
  if ([...sources].some(key => targets.has(key))) fail();
  return result;
}

function transition(before, after, input) {
  const changes = validate(input);
  const fields = value => [...(value.tableSchema?.fields || []), ...(value.customFields || [])];
  const oldFields = fields(before), newFields = fields(after), records = new Map(after.deals.map(row => [row.id, row]));
  for (const change of changes) {
    const previous = oldFields.find(field => field.id === change.fieldId), next = newFields.find(field => field.id === change.fieldId);
    if (!previous || !next || previous.type !== 'choice' || next.type !== 'choice' ||
      !previous.options.includes(change.from) || previous.options.includes(change.to)) fail();
    const { options: oldOptions, ...oldDefinition } = previous, { options: newOptions, ...newDefinition } = next;
    const mapped = oldOptions.map(option => changes.find(c => c.fieldId === change.fieldId && c.from === option)?.to ?? option);
    if (!isDeepStrictEqual(oldDefinition, newDefinition) || !isDeepStrictEqual(mapped, newOptions)) fail();
    for (const row of before.deals) {
      if (row[change.fieldId] === change.from && records.get(row.id)?.[change.fieldId] !== change.to) fail();
    }
  }
  return changes;
}
module.exports = { validate, transition };
