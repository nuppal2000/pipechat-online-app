'use strict';

const core = require('../public/business-workspace.js');
const { BackendError } = require('./backend-contract.js');
const { isDeepStrictEqual } = require('node:util');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const timestamp = value => value === null || typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));

/* Parent integration (not wired here):
 * Within createSupabaseBackend.forRequest, after its authenticated rpc closure:
 *   adapter.business = createBusinessWorkspace({ rpc });
 * Mount authenticated, no-store GET/CAS/share/revoke handlers separately from
 * legacy CRM routes, preserving the server's CSRF/origin and body-size checks.
 * rpc must be that request's verified-session, bounded RPC helper, never a
 * service-role client. No method accepts an acting user ID, role or owner.
 *
 * Review flow: read -> core.prepare -> user confirmation -> commit(prepared).
 * Schema proposals compile to core commands, not access-control operations.
 * share/revoke are explicit user controls, NOT model-executable commands.
 * Share is additive; workspace revoke removes membership AND scoped grants.
 * read().access lists memberships/grants for owners only (null for recipients).
 * Share receipts include effectiveRole/effectiveScope so a narrower new grant
 * cannot be mistaken for a downgrade of an existing workspace membership.
 * A view is an explicit saved set of entity IDs, not a predicate or graph walk.
 * Owner alone changes schemas/views. Editors change entities and links; deletion
 * of an entity used by a saved view needs owner review because it changes a view.
 */
function createBusinessWorkspace({ rpc } = {}) {
  if (typeof rpc !== 'function') throw new TypeError('An authenticated request RPC helper is required.');
  const bad = () => new BackendError('Invalid business workspace response. Reload before continuing.', 503);
  function snapshot(value) {
    if (!value || !uuid(value.workspaceId) || !Number.isSafeInteger(value.version) || value.version < 0 ||
        !['owner', 'editor', 'viewer'].includes(value.role) || !['workspace', 'shared'].includes(value.scope) ||
        value.scope === 'shared' && value.role !== 'viewer' || !Array.isArray(value.primary?.records) ||
        !timestamp(value.primary.updatedAt) || !Array.isArray(value.primary.customFields)) throw bad();
    try {
      core.validate(value.state, { workspaceId: value.workspaceId, legacyRecordIds: value.primary.records.map(record => {
        if (record.entityId !== core.legacyId(value.workspaceId, record.recordId) || !record.values || typeof record.values !== 'object' || Array.isArray(record.values)) throw bad();
        return record.recordId;
      }) });
    } catch { throw bad(); }
    return value;
  }
  function inputError(task) {
    try { return task(); } catch (error) { throw new BackendError(error.message, 400); }
  }
  const api = {
    async read(workspaceId = null) {
      if (workspaceId !== null && !uuid(workspaceId)) throw new BackendError('Invalid workspace ID.', 400);
      return snapshot(await rpc('business_workspace_get', { p_workspace: workspaceId }));
    },
    async list() {
      const result = await rpc('business_workspace_list', {});
      if (!Array.isArray(result) || result.some(item => !item || !uuid(item.workspaceId) ||
        !['owner', 'editor', 'viewer'].includes(item.role) || !['workspace', 'shared'].includes(item.scope))) throw bad();
      return result;
    },
    prepare(current, commands) { return inputError(() => core.prepare(current, commands)); },
    async commit(prepared) {
      if (!prepared || !uuid(prepared.workspaceId) || !Number.isSafeInteger(prepared.expectedVersion) || prepared.expectedVersion < 0 ||
          !timestamp(prepared.expectedPrimaryUpdatedAt)) throw new BackendError('A reviewed workspace version is required.', 400);
      inputError(() => core.validate(prepared.next, { workspaceId: prepared.workspaceId }));
      const result = snapshot(await rpc('business_workspace_cas', { p_workspace: prepared.workspaceId,
        p_expected_version: prepared.expectedVersion, p_state: prepared.next,
        p_expected_primary_updated_at: prepared.expectedPrimaryUpdatedAt }));
      if (result.workspaceId !== prepared.workspaceId || result.version !== prepared.expectedVersion + 1 ||
          !isDeepStrictEqual(result.state, prepared.next)) throw bad();
      return result;
    },
    async share(current, { email, scope, resourceId = null, role } = {}) {
      const result = await rpc('business_workspace_share', { p_workspace: current.workspaceId, p_email: email,
        p_scope: scope, p_resource_id: resourceId, p_role: role, p_expected_version: current.version });
      if (result?.workspaceId !== current.workspaceId || result.version !== current.version + 1 || result.emailSent !== false) throw bad();
      return result;
    },
    async revoke(current, { email, scope, resourceId = null } = {}) {
      const result = await rpc('business_workspace_revoke', { p_workspace: current.workspaceId, p_email: email,
        p_scope: scope, p_resource_id: resourceId, p_expected_version: current.version });
      if (result?.workspaceId !== current.workspaceId || result.version !== current.version + 1 || result.revoked !== true) throw bad();
      return result;
    }
  };
  return api;
}

module.exports = { ...core, createBusinessWorkspace };
