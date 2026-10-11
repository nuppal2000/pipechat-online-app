'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseBackend, BackendError } = require('../lib/supabase-backend');

const workspaceId = '00000000-0000-4000-8000-000000000001';
const entityId = 'ent_00000000-0000-4000-8000-000000000002';
const viewId = 'view_00000000-0000-4000-8000-000000000003';
const input = { workspaceId, email: 'qa-recipient@example.invalid', scope: 'record',
  resourceId: entityId, role: 'viewer', expectedVersion: 7 };

function fixture(result) {
  const calls = [], auth = [];
  const backend = createSupabaseBackend({
    url: 'https://offline-sharing.supabase.co', publishableKey: 'sb_publishable_offline_sharing_123456789',
    fetch: async () => { throw new Error('Network is prohibited in this test.'); },
    createClient: () => ({ rpc: async () => { throw new Error('Unexpected health request.'); } }),
    createServerClient: () => ({
      auth: { getUser: async () => {
        auth.push('getUser');
        return { data: { user: { id: 'qa-owner', email: 'qa-owner@example.invalid' } }, error: null };
      } },
      rpc: async (name, args) => { calls.push({ name, args }); return result; }
    })
  });
  const adapter = backend.forRequest({ headers: {} }, { setHeader() {}, getHeader() {} });
  return { adapter, calls, auth };
}

for (const revoke of [false, true]) {
  for (const [label, scope, resourceId] of [
    ['typed record', 'record', entityId], ['primary record', 'record', `legacy:${workspaceId}:1`],
    ['saved view', 'view', viewId], ['workspace', 'workspace', null]
  ]) {
    test(`business adapter ${revoke ? 'revokes' : 'grants'} ${label} using the SQL scope contract`, async () => {
      const receipt = { workspaceId, version: 8, ...(revoke ? { revoked: true } : { emailSent: false }) };
      const f = fixture({ data: receipt, error: null });
      const request = { ...input, scope, resourceId, ...(scope === 'workspace' ? { role: 'editor' } : {}) };
      assert.deepEqual(await f.adapter.shareBusiness(request, revoke), receipt);
      assert.deepEqual(f.auth, ['getUser']);
      assert.deepEqual(f.calls, [{ name: revoke ? 'business_workspace_revoke' : 'business_workspace_share', args: {
        p_workspace: workspaceId, p_email: input.email, p_scope: scope, p_resource_id: resourceId,
        ...(!revoke ? { p_role: request.role } : {}), p_expected_version: input.expectedVersion
      } }]);
    });
  }

  test(`business adapter rejects unsupported scopes before ${revoke ? 'revocation' : 'sharing'} RPC dispatch`, async () => {
    const f = fixture({ data: {}, error: null });
    for (const scope of ['entity', 'Record', 'public', '', null, undefined]) {
      await assert.rejects(() => f.adapter.shareBusiness({ ...input, scope }, revoke),
        error => error instanceof BackendError && error.status === 400);
    }
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.auth, []);
  });

  for (const status of [401, 403, 409]) {
    test(`record ${revoke ? 'revocation' : 'sharing'} preserves SQL ${status} failures`, async () => {
      const f = fixture({ data: null, error: { code: `PT${status}`, message: 'Private SQL details' } });
      await assert.rejects(() => f.adapter.shareBusiness(input, revoke), error => {
        assert(error instanceof BackendError);
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /Private SQL details/);
        return true;
      });
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].args.p_scope, 'record');
    });
  }
}
