'use strict';

const Core = require('../public/pipeline-core');
const Actions = require('../public/business-actions');

function factBundle(snapshot, recordId) {
  const records = snapshot.deals || snapshot.records || [];
  const row = records.find(record => record.id === recordId);
  if (!row) throw new Error('That record no longer exists. Choose a current record.');
  const core = Core.create(snapshot.tableSchema), definitions = core.definitions(snapshot.customFields || []);
  const facts = definitions.map(field => ({id:field.id, label:field.name, value:row[field.id] ?? null}));
  // Only an exact dedicated label supplies a commercial term. Ambiguous labels stay Unknown.
  const labels = {provider:['provider'],scope:['scope','scope and deliverables'],price:['price','quoted price'],currency:['currency'],
    paymentTerms:['payment terms'],timeline:['delivery timeline'],validUntil:['proposal valid until'],taxes:['taxes'],exclusions:['exclusions']};
  const terms = Object.fromEntries(Object.entries(labels).map(([key, aliases]) => {
    const matches = facts.filter(fact => aliases.includes(fact.label.trim().toLowerCase()));
    return [key, matches.length === 1 ? matches[0].id : null];
  }));
  return Actions.validateFactBundle({recordId, recordName:String(row[core.role('primary')] || `Record #${recordId}`),
    revision:String(snapshot.updatedAt || snapshot.workspaceVersion || 'unversioned'), facts, terms});
}

module.exports = {factBundle};
