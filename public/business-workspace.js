(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PipeChatBusinessWorkspace = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const uuid = new RegExp('^' + UUID + '$');
  const entityId = new RegExp('^ent_' + UUID + '$');
  const linkId = new RegExp('^lnk_' + UUID + '$');
  const viewId = new RegExp('^view_' + UUID + '$');
  const identifier = /^[a-z][a-z0-9_]{0,63}$/;
  const forbidden = ['__proto__', 'prototype', 'constructor'];
  const cardinalities = ['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many'];
  const fieldTypes = ['text', 'number', 'boolean', 'date', 'choice'];
  function fail(message) { const error = new Error(message); error.code = 'BUSINESS_INVALID'; throw error; }
  function clone(value, depth = 0) {
    if (depth > 20) fail('Business data is nested too deeply.');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) {
      fail('Business data must contain only JSON values.');
    }
    if (Array.isArray(value)) return Array.from(value, item => clone(item, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item, depth + 1)]));
  }
  function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
      fail('Invalid business workspace object.');
    }
  }
  function text(value, max = 120) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid label.');
  }
  function id(value) {
    if (typeof value !== 'string' || !identifier.test(value) || forbidden.includes(value) || value === 'primary') fail('Invalid schema ID.');
  }
  function array(value, max) { if (!Array.isArray(value) || value.length > max) fail('Invalid collection size.'); }
  function unique(values) { if (new Set(values).size !== values.length) fail('Duplicate identifier or value.'); }
  function legacyId(workspaceId, recordId) {
    if (typeof workspaceId !== 'string' || !uuid.test(workspaceId) || !Number.isSafeInteger(recordId) || recordId < 1) fail('Invalid primary record identity.');
    return 'legacy:' + workspaceId + ':' + recordId;
  }
  function primaryRecordId(workspaceId, reference) {
    if (typeof workspaceId !== 'string' || !uuid.test(workspaceId) || typeof reference !== 'string' || !reference.startsWith('legacy:' + workspaceId + ':')) return null;
    const tail = reference.slice(44);
    const n = Number(tail);
    return /^[1-9][0-9]*$/.test(tail) && Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  function empty() {
    return { formatVersion: 1, primary: { typeId: 'primary', source: 'crm_records' },
      entityTypes: [], relationshipTypes: [], entities: [], relationships: [], views: [] };
  }
  function validateType(type) {
    object(type, ['id', 'name', 'fields']); id(type.id); text(type.name); array(type.fields, 40);
    unique(type.fields.map(field => field.id));
    for (const field of type.fields) {
      object(field, ['id', 'name', 'type', 'required', 'options']); id(field.id); text(field.name);
      if (!fieldTypes.includes(field.type) || typeof field.required !== 'boolean') fail('Invalid field type.');
      array(field.options, 100); unique(field.options);
      if ((field.type === 'choice') !== (field.options.length > 0)) fail('Only choice fields require options.');
      field.options.forEach(option => text(option));
    }
  }
  function validCell(field, value) {
    if (value === undefined || value === null || value === '') {
      if (field.required) fail('A required field is empty: ' + field.id);
      return;
    }
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12)) fail('Invalid number.');
    if (field.type === 'boolean' && typeof value !== 'boolean') fail('Invalid boolean.');
    if (['text', 'choice', 'date'].includes(field.type) && (typeof value !== 'string' || value.length > 12000 || value.includes('\0'))) fail('Invalid text.');
    if (field.type === 'choice' && !field.options.includes(value)) fail('Invalid choice.');
    if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0100-01-01' ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail('Invalid date.');
  }
  // Legacy values never enter canonical state. Supply IDs from the authorized GET
  // envelope when staging, so references cannot accidentally cross workspaces.
  function validate(state, { workspaceId, legacyRecordIds } = {}) {
    object(state, ['formatVersion', 'primary', 'entityTypes', 'relationshipTypes', 'entities', 'relationships', 'views']);
    object(state.primary, ['typeId', 'source']);
    if (state.formatVersion !== 1 || state.primary.typeId !== 'primary' || state.primary.source !== 'crm_records') fail('Unsupported workspace format.');
    array(state.entityTypes, 40); array(state.relationshipTypes, 80); array(state.entities, 5000);
    array(state.relationships, 10000); array(state.views, 100);
    for (const key of ['entityTypes', 'relationshipTypes', 'entities', 'relationships', 'views']) unique(state[key].map(item => item.id));
    state.entityTypes.forEach(validateType);
    const types = new Map(state.entityTypes.map(type => [type.id, type]));
    const entities = new Map();
    for (const entity of state.entities) {
      object(entity, ['id', 'typeId', 'values']);
      if (!entityId.test(entity.id) || !types.has(entity.typeId)) fail('Invalid entity identity or type.');
      const fields = types.get(entity.typeId).fields;
      if (!entity.values || typeof entity.values !== 'object' || Array.isArray(entity.values) ||
          Object.keys(entity.values).some(key => !fields.some(field => field.id === key))) fail('Unknown entity field.');
      fields.forEach(field => validCell(field, entity.values[field.id])); entities.set(entity.id, entity.typeId);
    }
    const legacy = legacyRecordIds === undefined ? null : new Set(legacyRecordIds);
    const resolve = reference => {
      if (entities.has(reference)) return entities.get(reference);
      const n = primaryRecordId(workspaceId, reference);
      if (n !== null && (!legacy || legacy.has(n))) return 'primary';
      fail('An entity reference is missing or belongs to another workspace.');
    };
    const definitions = new Map();
    for (const relation of state.relationshipTypes) {
      object(relation, ['id', 'name', 'fromType', 'toType', 'cardinality']); id(relation.id); text(relation.name);
      if (![relation.fromType, relation.toType].every(type => type === 'primary' || types.has(type)) ||
          !cardinalities.includes(relation.cardinality)) fail('Invalid relationship type.');
      definitions.set(relation.id, relation);
    }
    const pairs = new Set(), froms = new Set(), tos = new Set();
    for (const relation of state.relationships) {
      object(relation, ['id', 'typeId', 'fromId', 'toId']);
      const def = definitions.get(relation.typeId);
      if (!linkId.test(relation.id) || !def || resolve(relation.fromId) !== def.fromType || resolve(relation.toId) !== def.toType) fail('Invalid relationship endpoints.');
      const from = def.id + ':' + relation.fromId, to = def.id + ':' + relation.toId, pair = from + ':' + relation.toId;
      if (pairs.has(pair) || ['one_to_one', 'many_to_one'].includes(def.cardinality) && froms.has(from) ||
          ['one_to_one', 'one_to_many'].includes(def.cardinality) && tos.has(to)) fail('Relationship cardinality exceeded.');
      pairs.add(pair); froms.add(from); tos.add(to);
    }
    for (const view of state.views) {
      object(view, ['id', 'name', 'entityIds']);
      if (!viewId.test(view.id)) fail('Invalid view ID.');
      text(view.name); array(view.entityIds, 7000); unique(view.entityIds); view.entityIds.forEach(resolve);
    }
    return clone(state);
  }
  function transition(before, next) {
    for (const type of before.entityTypes) {
      const after = next.entityTypes.find(item => item.id === type.id);
      if (!after || type.fields.some(field => !after.fields.some(f => f.id === field.id && f.type === field.type))) fail('Removing or retyping existing schema is not supported.');
    }
    for (const relation of before.relationshipTypes) {
      const after = next.relationshipTypes.find(item => item.id === relation.id);
      if (!after || ['fromType', 'toType', 'cardinality'].some(key => after[key] !== relation[key])) fail('Existing relationship contracts are immutable.');
    }
    for (const entity of before.entities) {
      const after = next.entities.find(item => item.id === entity.id);
      if (after && after.typeId !== entity.typeId) fail('Entity IDs cannot change type.');
    }
    for (const link of before.relationships) {
      const after = next.relationships.find(item => item.id === link.id);
      if (after && ['typeId', 'fromId', 'toId'].some(key => after[key] !== link[key])) fail('Unlink and create a new link to change endpoints.');
    }
  }
  function compileSchemaProposal(proposal) {
    object(proposal, ['version', 'entityTypes', 'relationshipTypes']);
    if (proposal.version !== 1) fail('Unsupported schema proposal.');
    array(proposal.entityTypes, 40); array(proposal.relationshipTypes, 80);
    proposal.entityTypes.forEach(validateType);
    // Final cross-type validation occurs against the staged existing schema.
    for (const relation of proposal.relationshipTypes) {
      object(relation, ['id', 'name', 'fromType', 'toType', 'cardinality']); id(relation.id); text(relation.name);
      if (!cardinalities.includes(relation.cardinality)) fail('Invalid relationship cardinality.');
    }
    unique(proposal.entityTypes.map(type => type.id)); unique(proposal.relationshipTypes.map(type => type.id));
    return clone([...proposal.entityTypes.map(type => ({ op: 'put_type', type })),
      ...proposal.relationshipTypes.map(type => ({ op: 'put_relationship_type', type }))]);
  }
  function mergePlan(state, survivorId, sourceIds) {
    array(sourceIds, 100); unique(sourceIds);
    if (!sourceIds.length || sourceIds.includes(survivorId)) fail('Choose distinct merge sources and one survivor.');
    const survivor = state.entities.find(entity => entity.id === survivorId);
    const sources = sourceIds.map(id => state.entities.find(entity => entity.id === id));
    if (!survivor || sources.some(entity => !entity)) fail('Merge requires existing typed entities. Primary records are read-only.');
    if (sources.some(entity => entity.typeId !== survivor.typeId)) fail('Merged entities must have the same type.');
    const removed = new Set(sourceIds), fields = state.entityTypes.find(type => type.id === survivor.typeId).fields;
    const candidates = fields.map(field => ({ id: field.id, name: field.name,
      values: [...new Set([survivor, ...sources].map(entity => entity.values[field.id]).filter(value =>
        value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())))] }));
    const mapped = state.relationships.map(link => ({ ...link,
      fromId: removed.has(link.fromId) ? survivorId : link.fromId,
      toId: removed.has(link.toId) ? survivorId : link.toId,
      redirected: removed.has(link.fromId) || removed.has(link.toId) }));
    // Prefer an existing survivor edge, then deterministic source-edge order.
    const ordered = [...mapped.filter(link => !link.redirected), ...mapped.filter(link => link.redirected).sort((a, b) => a.id.localeCompare(b.id))];
    const pairs = new Set(), relationships = [];
    for (const link of ordered) {
      const key = JSON.stringify([link.typeId, link.fromId, link.toId]);
      if (!pairs.has(key)) { pairs.add(key); relationships.push(link); }
    }
    return { survivor, removed, candidates, relationships };
  }
  // IDs are allocated by the caller before review, keeping staging deterministic
  // and existing link identities immutable. Source-only grants never transfer.
  // merge_entities: {survivorId,sourceIds,fieldResolutions:{fieldId:existingValue},
  // replacementLinkIds:{oldLinkId:freshLinkId}}. Preview lists every oldLinkId
  // needing replacement; only fields with multiple nonblank values need a choice.
  function mergePreview(state, { survivorId, sourceIds }) {
    const plan = mergePlan(state, survivorId, sourceIds);
    return clone({ typeId: plan.survivor.typeId, fields: plan.candidates,
      redirectedLinkIds: plan.relationships.filter(link => link.redirected).map(link => link.id),
      affectedViewIds: state.views.filter(view => view.entityIds.some(id => plan.removed.has(id))).map(view => view.id) });
  }
  function mergeEntities(state, command) {
    object(command, ['op', 'survivorId', 'sourceIds', 'fieldResolutions', 'replacementLinkIds']);
    const plan = mergePlan(state, command.survivorId, command.sourceIds);
    const resolutions = clone(command.fieldResolutions), replacements = clone(command.replacementLinkIds);
    if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions) ||
      Object.keys(resolutions).some(id => !plan.candidates.some(field => field.id === id))) fail('Invalid merge field resolutions.');
    const redirectedIds = plan.relationships.filter(link => link.redirected).map(link => link.id);
    object(replacements, redirectedIds); unique(Object.values(replacements));
    for (const id of Object.values(replacements)) {
      if (typeof id !== 'string' || !linkId.test(id) || state.relationships.some(link => link.id === id)) fail('Redirected relationships require fresh link IDs.');
    }
    for (const field of plan.candidates) {
      const explicit = Object.hasOwn(resolutions, field.id);
      if (explicit && !field.values.includes(resolutions[field.id])) fail('Choose an existing nonblank value for ' + field.name + '.');
      if (field.values.length > 1 && !explicit) fail('Choose a value for conflicting field: ' + field.name);
      if (field.values.length) plan.survivor.values[field.id] = explicit ? resolutions[field.id] : field.values[0];
    }
    state.entities = state.entities.filter(entity => !plan.removed.has(entity.id));
    state.relationships = plan.relationships.map(({ redirected, ...link }) => ({ ...link, id: redirected ? replacements[link.id] : link.id }));
    // Substituting a survivor into a source-only shared view would expand access.
    // Preserve existing survivor membership; otherwise require an explicit share.
    state.views.forEach(view => { view.entityIds = view.entityIds.filter(id => !plan.removed.has(id)); });
  }
  function stage(state, commands, context) {
    array(commands, 200);
    const next = clone(state);
    const upsert = (key, value) => {
      const index = next[key].findIndex(item => item.id === value.id);
      if (index === -1) next[key].push(clone(value)); else next[key][index] = clone(value);
    };
    for (const command of commands) {
      switch (command?.op) {
        case 'merge_entities': mergeEntities(next, command); break;
        case 'put_type': case 'put_relationship_type':
          object(command, ['op', 'type']); upsert(command.op === 'put_type' ? 'entityTypes' : 'relationshipTypes', command.type); break;
        case 'create_entity':
          object(command, ['op', 'entity']);
          if (next.entities.some(entity => entity.id === command.entity.id)) fail('Entity already exists.');
          next.entities.push(clone(command.entity)); break;
        case 'update_entity': {
          object(command, ['op', 'id', 'values']);
          const entity = next.entities.find(entity => entity.id === command.id);
          if (!entity) fail('Entity not found. Primary records are read-only through this API.');
          if (!command.values || typeof command.values !== 'object' || Array.isArray(command.values)) fail('Invalid values.');
          entity.values = { ...entity.values, ...clone(command.values) }; break;
        }
        case 'delete_entity':
          object(command, ['op', 'id']);
          if (!next.entities.some(entity => entity.id === command.id)) fail('Entity not found.');
          next.entities = next.entities.filter(entity => entity.id !== command.id);
          next.relationships = next.relationships.filter(link => link.fromId !== command.id && link.toId !== command.id);
          next.views.forEach(view => { view.entityIds = view.entityIds.filter(id => id !== command.id); }); break;
        case 'link':
          object(command, ['op', 'relationship']);
          if (next.relationships.some(link => link.id === command.relationship.id)) fail('Link already exists.');
          next.relationships.push(clone(command.relationship)); break;
        case 'unlink':
          object(command, ['op', 'id']);
          if (!next.relationships.some(link => link.id === command.id)) fail('Link not found.');
          next.relationships = next.relationships.filter(link => link.id !== command.id); break;
        case 'put_view': object(command, ['op', 'view']); upsert('views', command.view); break;
        case 'delete_view':
          object(command, ['op', 'id']);
          if (!next.views.some(view => view.id === command.id)) fail('View not found.');
          next.views = next.views.filter(view => view.id !== command.id); break;
        default: fail('Unsupported business command. Sharing is a separate explicit user action.');
      }
    }
    transition(state, next);
    return { next: validate(next, context), changes: commands.map(command => command.op) };
  }
  function prepare(snapshot, commands) {
    if (snapshot?.scope !== 'workspace' || !['owner', 'editor'].includes(snapshot.role)) fail('This snapshot is read-only.');
    if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0) fail('Invalid workspace version.');
    const result = stage(snapshot.state, commands, { workspaceId: snapshot.workspaceId,
      legacyRecordIds: snapshot.primary.records.map(record => record.recordId) });
    if (snapshot.role !== 'owner' && ['entityTypes', 'relationshipTypes', 'views'].some(key =>
      JSON.stringify(result.next[key]) !== JSON.stringify(snapshot.state[key]))) fail('Only the owner can change schema or shared views.');
    return { ...result, workspaceId: snapshot.workspaceId, expectedVersion: snapshot.version,
      expectedPrimaryUpdatedAt: snapshot.primary.updatedAt };
  }
  return { empty, validate, transition, legacyId, primaryRecordId, compileSchemaProposal, mergePreview, stage, prepare, cardinalities, fieldTypes };
});
