'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const Core = require('../public/business-workspace.js');
let playwright;
try { playwright = require('playwright'); } catch {
  try { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); } catch { /* Optional browser runtime. */ }
}

test('standalone business UI: CRUD, links, inspector, targeted shares, role gating, errors and mobile layout',
  { timeout: 120000, skip: !playwright && 'Playwright is not installed; core and SQL tests remain mandatory.' }, async t => {
    const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // Fulfilled entirely in memory: a secure browser context without any network.
    const origin = 'https://pipechat.test';
    await page.route(origin + '/**', route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:16px"><main id="business"></main></body></html>' }));
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const requests = []; page.on('request', request => requests.push(request.url()));
    await page.goto(origin);
    for (const file of ['icons.js', 'business-workspace.js', 'business-workspace-ui.js']) await page.addScriptTag({ path: path.join(__dirname, '../public', file) });
    const workspaceId = randomUUID();
    const seed = { workspaceId, version: 0, role: 'owner', scope: 'workspace', state: Core.empty(), access: { memberships: [], grants: [] },
      primary: { updatedAt: null, tableSchema: { title: 'Existing table', fields: [{ id: 'f_name', name: 'Name', type: 'text', role: 'primary' }] },
        customFields: [], records: [1, 2].map(recordId => ({ recordId, entityId: Core.legacyId(workspaceId, recordId), values: { f_name: 'Primary ' + recordId } })) } };
    await page.evaluate(seed => {
      window.snapshot = seed; window.calls = []; window.confirmations = []; window.inspected = [];
      const copy = data => JSON.parse(JSON.stringify(data));
      window.api = {
        async read() { if (window.readFailure) throw Object.assign(new Error(window.readFailure.message), { status: window.readFailure.status }); return copy(window.snapshot); },
        async commit(prepared) {
          window.calls.push({ method: 'commit', prepared });
          if (window.commitFailure) throw Object.assign(new Error(window.commitFailure.message), { status: window.commitFailure.status });
          if (prepared.expectedVersion !== window.snapshot.version) throw Object.assign(new Error('Workspace changed. Reload required.'), { status: 409 });
          window.snapshot.state = prepared.next; window.snapshot.version++; return copy(window.snapshot);
        },
        async share(current, request) {
          window.calls.push({ method: 'share', current, request });
          const { email, role, scope, resourceId } = request;
          if (scope === 'workspace') {
            window.snapshot.access.memberships = window.snapshot.access.memberships.filter(m => m.email !== email);
            window.snapshot.access.memberships.push({ email, role, userId: crypto.randomUUID() });
          } else window.snapshot.access.grants.push({ email, role, scope, resourceId, userId: crypto.randomUUID() });
          window.snapshot.version++; return { workspaceId: current.workspaceId, version: window.snapshot.version, emailSent: false };
        },
        async revoke(current, request) {
          window.calls.push({ method: 'revoke', current, request });
          window.snapshot.access.memberships = window.snapshot.access.memberships.filter(m => !(m.email === request.email && request.scope === 'workspace'));
          window.snapshot.access.grants = window.snapshot.access.grants.filter(g => !(g.email === request.email &&
            (request.scope === 'workspace' || g.scope === request.scope && g.resourceId === request.resourceId)));
          window.snapshot.version++; return { workspaceId: current.workspaceId, version: window.snapshot.version, revoked: true };
        }
      };
      window.ui = PipeChatBusinessWorkspaceUI.mount({ element: document.getElementById('business'), api: window.api,
        confirm: message => { window.confirmations.push(message); return true; }, onInspectPrimary: ref => window.inspected.push(ref) });
      return window.ui.load();
    }, seed);

    await t.test('create a custom type and entity; editing accepts numeric zero and no controls remain stuck', async () => {
      await page.getByRole('button', { name: 'New entity type', exact: true }).click();
      await page.getByLabel('Type name', { exact: true }).fill('Asset');
      await page.getByLabel('Field name', { exact: true }).fill('Name');
      await page.getByLabel('Required', { exact: true }).check();
      await page.getByRole('button', { name: 'Add field', exact: true }).click();
      await page.getByLabel('Field name', { exact: true }).nth(1).fill('Cost');
      await page.getByLabel('Field type', { exact: true }).nth(1).selectOption('number');
      await page.getByRole('button', { name: 'Save type', exact: true }).click();
      await page.getByRole('button', { name: 'New entity', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Asset one'); await page.getByLabel('Cost', { exact: true }).fill('25');
      await page.getByRole('button', { name: 'Save entity', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Asset one', exact: true }).click();
      await page.getByLabel('Cost', { exact: true }).fill('0'); await page.getByRole('button', { name: 'Save entity', exact: true }).click();
      assert.equal(await page.evaluate(() => Object.values(window.snapshot.state.entities[0].values).includes(0)), true);
      assert.equal(await page.getByRole('button', { name: 'New entity', exact: true }).isEnabled(), true);
    });

    await t.test('create a typed relationship to a current legacy record and inspect both references', async () => {
      await page.getByRole('button', { name: 'Relationships', exact: true }).click();
      await page.getByRole('button', { name: 'New relationship type', exact: true }).click();
      await page.getByLabel('Relationship name', { exact: true }).fill('Uses');
      await page.getByLabel('From type', { exact: true }).selectOption({ label: 'Existing table' });
      await page.getByLabel('To type', { exact: true }).selectOption({ label: 'Asset' });
      await page.getByLabel('Cardinality', { exact: true }).selectOption('many_to_one');
      await page.getByRole('button', { name: 'Save relationship type', exact: true }).click();
      await page.getByRole('button', { name: 'Link records', exact: true }).click();
      await page.getByLabel('From record', { exact: true }).selectOption({ label: 'Primary 1' });
      await page.getByLabel('To record', { exact: true }).selectOption({ label: 'Asset one' });
      await page.getByRole('button', { name: 'Create link', exact: true }).click();
      await page.getByRole('button', { name: 'Primary 1', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Asset one', exact: true }).click();
      assert.equal(await page.getByRole('dialog').getByRole('button', { name: 'Primary 1', exact: true }).count(), 1);
      await page.getByRole('dialog').getByRole('button', { name: 'Primary 1', exact: true }).click();
      await page.getByRole('button', { name: 'Open primary record', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.inspected), [{ workspaceId, recordId: 1, entityId: Core.legacyId(workspaceId, 1) }]);
    });

    await t.test('saved-view and workspace grants are explicit targeted controls with downgrade/revoke', async () => {
      await page.getByRole('button', { name: 'Sharing', exact: true }).click();
      await page.getByRole('button', { name: 'New saved view', exact: true }).click();
      await page.getByLabel('View name', { exact: true }).fill('Selected assets');
      await page.getByLabel('Asset one', { exact: true }).check(); await page.getByLabel('Primary 1', { exact: true }).check();
      await page.getByRole('button', { name: 'Save view', exact: true }).click();
      await page.getByRole('button', { name: 'Grant access', exact: true }).click();
      await page.getByLabel('Existing account email', { exact: true }).fill('viewer@example.test');
      await page.getByLabel('Scope', { exact: true }).selectOption('view');
      assert.equal(await page.getByLabel('Role', { exact: true }).isDisabled(), true);
      await page.getByRole('dialog').getByRole('button', { name: 'Grant access', exact: true }).click();
      const call = await page.evaluate(() => window.calls.filter(c => c.method === 'share').at(-1));
      assert.equal(call.request.email, 'viewer@example.test'); assert.equal(call.request.scope, 'view'); assert.equal(call.request.role, 'viewer');
      assert.match(await page.evaluate(() => window.confirmations.at(-1)), /No email will be sent/);
      await page.getByRole('button', { name: 'Grant access', exact: true }).click();
      await page.getByLabel('Existing account email', { exact: true }).fill('editor@example.test');
      await page.getByLabel('Role', { exact: true }).selectOption('editor');
      await page.getByRole('dialog').getByRole('button', { name: 'Grant access', exact: true }).click();
      await page.getByLabel('Role for editor@example.test', { exact: true }).selectOption('viewer');
      await page.getByRole('button', { name: 'Update role for editor@example.test', exact: true }).click();
      await page.waitForFunction(() => window.snapshot.access.memberships[0].role === 'viewer');
      await page.getByRole('button', { name: 'Revoke all access for editor@example.test', exact: true }).click();
      await page.waitForFunction(() => window.snapshot.access.memberships.length === 0);
      assert.equal(await page.getByRole('button', { name: 'Revoke view access for viewer@example.test', exact: true }).count(), 1);
    });

    await t.test('entity history is chronological, paged, escaped, retryable and safe against revoked or late responses', async () => {
      await page.evaluate(() => {
        window.historyCalls = [];
        const entity = window.snapshot.state.entities[0], fieldId = Object.keys(entity.values)[0], relation = window.snapshot.state.relationships[0];
        window.historyPage = (id, after) => ({ workspaceId: window.snapshot.workspaceId, entityId: id,
          events: after === '0' ? [{ id: '9007199254740993', version: 1, kind: 'create', at: '2026-10-10T10:00:00Z', actorId: 'private-actor', before: null,
            after: { ...entity, values: { [fieldId]: '<img src=x onerror="window.auditXss=true">' } }, relationship: null }] : [
            { id: '9007199254740994', version: 2, kind: 'update', at: '2026-10-10T10:01:00Z', actorId: 'private-actor',
              before: { ...entity, values: { [fieldId]: 'Before' } }, after: { ...entity, values: { [fieldId]: 'After' } }, relationship: null },
            { id: '9007199254740995', version: 2, kind: 'link', at: '2026-10-10T10:01:00Z', actorId: 'private-actor', before: null, after: null, relationship: relation }
          ], nextAfter: after === '0' ? '9007199254740993' : null });
        window.api.history = async (workspaceId, entityId, after) => {
          window.historyCalls.push({ workspaceId, entityId, after });
          if (window.historyFailure) throw Object.assign(new Error('History unavailable'), { status: window.historyFailure });
          return window.historyPage(entityId, after);
        };
        window.ui.inspect(entity.id);
      });
      await page.getByText('Entity created', { exact: true }).waitFor();
      assert.equal(await page.locator('.pc-business-history img').count(), 0);
      assert.equal(await page.evaluate(() => Boolean(window.auditXss)), false);
      assert.equal(await page.getByRole('dialog').getByText('private-actor', { exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Load more history', exact: true }).click();
      await page.getByText('Entity updated', { exact: true }).waitFor();
      assert.deepEqual(await page.locator('.pc-business-history strong').allTextContents(), ['Entity created', 'Entity updated', 'Records linked']);
      assert.equal(await page.getByText('Before -> After', { exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => window.historyCalls[1].after), '9007199254740993');
      assert.equal(await page.getByRole('button', { name: 'Load more history', exact: true }).isVisible(), false);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const screenshot = path.join(process.env.BUSINESS_UI_SCREENSHOT_DIR || os.tmpdir(), 'pipechat-business-history-mobile.png');
      await page.screenshot({ path: screenshot, fullPage: true }); t.diagnostic(screenshot);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => { window.historyFailure = 500; window.ui.inspect(window.snapshot.state.entities[0].id); });
      await page.getByRole('button', { name: 'Retry history', exact: true }).waitFor();
      await page.evaluate(() => { window.historyFailure = null; });
      await page.getByRole('button', { name: 'Retry history', exact: true }).click();
      await page.getByText('Entity created', { exact: true }).waitFor();
      await page.evaluate(() => { window.savedHistory = window.api.history; window.api.history = () => new Promise(resolve => { window.resolveHistory = resolve; }); window.ui.inspect(window.snapshot.state.entities[0].id); });
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await page.evaluate(() => { window.resolveHistory(window.historyPage(window.snapshot.state.entities[0].id, '0')); });
      assert.equal(await page.locator('.pc-business-history').count(), 0);
      await page.evaluate(() => { window.api.history = window.savedHistory; window.historyFailure = 403; window.ui.inspect(window.snapshot.state.entities[0].id); });
      await page.waitForFunction(() => window.ui.getSnapshot() === null);
      assert.equal(await page.locator('dialog').count(), 0);
      await page.evaluate(() => { window.historyFailure = null; delete window.api.history; window.ui.setSnapshot(window.snapshot); window.ui.show('Entities'); });
    });

    await t.test('failed/stale writes retain the draft; record text cannot execute HTML', async () => {
      await page.getByRole('button', { name: 'Entities', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Asset one', exact: true }).click();
      await page.evaluate(() => { window.commitFailure = { status: 409, message: 'Workspace changed. Reload required.' }; });
      await page.getByLabel('Cost', { exact: true }).fill('9'); await page.getByRole('button', { name: 'Save entity', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Workspace changed' }).waitFor();
      assert.equal(await page.getByLabel('Cost', { exact: true }).inputValue(), '9');
      assert.equal(await page.getByRole('button', { name: 'Save entity', exact: true }).isEnabled(), true);
      await page.evaluate(() => { window.commitFailure = null; });
      await page.getByRole('button', { name: 'Save entity', exact: true }).click();
      await page.getByRole('button', { name: 'New entity', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('<img src=x onerror="window.xss=true">');
      await page.getByRole('button', { name: 'Save entity', exact: true }).click();
      assert.equal(await page.locator('#business img').count(), 0); assert.equal(await page.evaluate(() => Boolean(window.xss)), false);
    });

    await t.test('merge UI requires conflict choices, preserves a failed draft and confirms one atomic save', async () => {
      await page.getByRole('button', { name: 'New entity', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Asset two'); await page.getByLabel('Cost', { exact: true }).fill('12');
      await page.getByRole('button', { name: 'Save entity', exact: true }).click();
      await page.evaluate(async () => {
        const entity = window.snapshot.state.entities.find(e => Object.values(e.values).includes('Asset two'));
        const prepared = PipeChatBusinessWorkspace.prepare(window.snapshot, [{ op: 'link', relationship: {
          id: 'lnk_' + crypto.randomUUID(), typeId: window.snapshot.state.relationshipTypes[0].id,
          fromId: window.snapshot.primary.records[1].entityId, toId: entity.id
        } }]);
        window.ui.setSnapshot(await window.api.commit(prepared)); window.preMergeCalls = window.calls.length;
      });
      await page.getByRole('button', { name: 'Merge entities', exact: true }).click();
      const survivorId = await page.evaluate(() => window.snapshot.state.entities[0].id);
      await page.getByLabel('Surviving entity', { exact: true }).selectOption(survivorId);
      for (const checkbox of await page.getByRole('dialog').getByRole('checkbox').all()) await checkbox.check();
      await page.getByRole('button', { name: 'Merge selected entities', exact: true }).click();
      assert.equal(await page.evaluate(() => window.calls.length === window.preMergeCalls), true);
      await page.getByLabel('Name', { exact: true }).selectOption('0'); await page.getByLabel('Cost', { exact: true }).selectOption('0');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const screenshot = path.join(process.env.BUSINESS_UI_SCREENSHOT_DIR || os.tmpdir(), 'pipechat-business-merge-mobile.png');
      await page.screenshot({ path: screenshot, fullPage: true }); t.diagnostic(screenshot);
      await page.evaluate(() => { window.commitFailure = { status: 409, message: 'Workspace changed. Reload required.' }; });
      await page.getByRole('button', { name: 'Merge selected entities', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Workspace changed' }).waitFor();
      assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), '0');
      assert.equal(await page.getByRole('dialog').getByRole('checkbox').count(), 2);
      await page.evaluate(() => { window.commitFailure = null; });
      await page.getByRole('button', { name: 'Merge selected entities', exact: true }).click();
      await page.waitForFunction(() => window.snapshot.state.entities.length === 1);
      assert.equal(await page.evaluate(() => window.snapshot.state.entities[0].id), survivorId);
      assert.equal(await page.evaluate(() => window.snapshot.state.relationships.every(link => link.toId === window.snapshot.state.entities[0].id)), true);
      assert.match(await page.evaluate(() => window.confirmations.at(-1)), /revoked, not transferred/);
      assert.deepEqual(await page.evaluate(() => window.calls.at(-1).prepared.changes), ['merge_entities']);
      await page.evaluate(() => {
        const temporary = JSON.parse(JSON.stringify(window.snapshot)), entity = temporary.state.entities[0];
        const key = temporary.state.entityTypes[0].fields.find(field => field.name === 'Name').id;
        temporary.state.entities.push({ ...entity, id: 'ent_' + crypto.randomUUID(), values: { ...entity.values, [key]: 'Long value ' + 'x'.repeat(400) } });
        window.ui.setSnapshot(temporary);
      });
      await page.getByRole('button', { name: 'Merge entities', exact: true }).click();
      await page.getByRole('dialog').getByRole('checkbox').check();
      await page.getByText('Name / Full values', { exact: true }).click();
      assert.equal(await page.locator('.pc-business-merge-options').getByText('Long value ' + 'x'.repeat(400), { exact: true }).isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.evaluate(() => { window.ui.setSnapshot(window.snapshot); });
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await t.test('foreign primary ID collisions stay in read-only business inspector for members and scoped viewers', async () => {
      await page.evaluate(() => { window.ownBeforeCollision = window.ui.getSnapshot(); window.inspectCount = window.inspected.length; });
      for (const [role, scope] of [['viewer', 'shared'], ['viewer', 'workspace'], ['editor', 'workspace']]) {
        await page.evaluate(({ role, scope }) => {
          const snapshot = JSON.parse(JSON.stringify(window.ownBeforeCollision)); snapshot.workspaceId = crypto.randomUUID();
          snapshot.role = role; snapshot.scope = scope; snapshot.access = null; snapshot.state = PipeChatBusinessWorkspace.empty();
          snapshot.primary.records = [{ recordId: 1, entityId: PipeChatBusinessWorkspace.legacyId(snapshot.workspaceId, 1), values: { f_name: 'Foreign primary one' } }];
          window.ui.setSnapshot(snapshot); window.ui.inspect(snapshot.primary.records[0].entityId);
        }, { role, scope });
        assert.equal(await page.getByRole('dialog').getByRole('heading', { name: 'Foreign primary one', exact: true }).count(), 1);
        assert.equal(await page.getByRole('dialog').getByText('Primary record / Read-only', { exact: true }).count(), 1);
        assert.equal(await page.getByRole('button', { name: 'Open primary record', exact: true }).count(), 0);
        assert.equal(await page.getByRole('dialog').locator('input,select,textarea').count(), 0);
        assert.equal(await page.evaluate(() => window.inspected.length === window.inspectCount), true);
      }
      await page.evaluate(() => { window.ui.setSnapshot(window.ownBeforeCollision); window.ui.show('Entities'); });
    });

    await t.test('desktop and mobile stay within viewport with usable modal fields', async () => {
      const desktop = path.join(process.env.BUSINESS_UI_SCREENSHOT_DIR || os.tmpdir(), 'pipechat-business-ui-desktop.png'); await page.screenshot({ path: desktop, fullPage: true }); t.diagnostic(desktop);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Relationships', exact: true }).click();
      await page.getByRole('button', { name: 'Link records', exact: true }).click();
      const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth > innerWidth,
        controls: [...document.querySelectorAll('dialog input,dialog select,dialog button')].filter(e => {
          const r = e.getBoundingClientRect(); return r.width > 0 && (r.left < 0 || r.right > innerWidth);
        }).length }));
      assert.deepEqual(overflow, { document: false, controls: 0 });
      const mobile = path.join(process.env.BUSINESS_UI_SCREENSHOT_DIR || os.tmpdir(), 'pipechat-business-ui-mobile.png'); await page.screenshot({ path: mobile, fullPage: true }); t.diagnostic(mobile);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    });

    await t.test('shared viewer has no mutation or primary-inspector authority; revoked reload clears data', async () => {
      await page.evaluate(() => {
        window.ownerSnapshot = JSON.parse(JSON.stringify(window.snapshot));
        window.snapshot.role = 'viewer'; window.snapshot.scope = 'shared'; window.snapshot.access = null;
        window.snapshot.primary = { records: [], tableSchema: null, customFields: [], updatedAt: null };
        window.snapshot.state.entities = window.snapshot.state.entities.slice(0, 1);
        window.snapshot.state.relationships = []; window.snapshot.state.relationshipTypes = []; window.snapshot.state.views = [];
        window.ui.setSnapshot(window.snapshot); window.ui.show('Sharing');
      });
      for (const name of ['New entity', 'New entity type', 'Merge entities', 'Sharing', 'Grant access']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
      assert.equal(await page.getByText('Primary 1', { exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Asset one', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Open primary record', exact: true }).count(), 0);
      await page.evaluate(() => { window.readFailure = { status: 403, message: 'Access denied' }; return window.ui.load(); });
      assert.equal(await page.getByRole('button', { name: 'Asset one', exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.ui.getSnapshot()), null);
      await page.evaluate(async () => {
        window.api.read = () => new Promise(resolve => { window.resolveLate = resolve; });
        const pending = window.ui.load(); window.ui.destroy(); window.resolveLate(window.ownerSnapshot); await pending;
      });
      assert.equal(await page.locator('.pc-business').count(), 0);
    });
    assert.deepEqual(errors, []); assert.ok(requests.every(url => url.startsWith(origin + '/')));
  });
