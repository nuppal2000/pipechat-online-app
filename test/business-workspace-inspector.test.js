'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
let playwright;
try { playwright = require('playwright'); } catch {
  try { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); } catch { /* Optional browser runtime. */ }
}

test('primary inspector relationship callbacks: navigation, escaping, refresh, errors and stale auth/record responses',
  { timeout: 60000, skip: !playwright && 'Playwright is not installed.' }, async t => {
    const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const source = await fs.readFile(path.join(__dirname, '../public/index.html'), 'utf8');
    const dialog = source.match(/<dialog id="inspectorDialog"[\s\S]*?<\/dialog>/)[0];
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('https://pipechat.test/**', route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + dialog + '</body></html>' }));
    await page.goto('https://pipechat.test');
    for (const name of ['pipechat.css', 'inspector.css']) await page.addStyleTag({ path: path.join(__dirname, '../public', name) });
    for (const name of ['icons.js', 'table-schema.js', 'pipeline-core.js', 'inspector-core.js', 'inspector-ui.js']) await page.addScriptTag({ path: path.join(__dirname, '../public', name) });
    await page.evaluate(() => {
      window.S = { user: { id: 'owner', email: 'owner@example.test' }, loaded: true, generation: 1, customFields: [],
        records: [{ id: 1, account: 'Primary one', history: [] }, { id: 2, account: 'Primary two', history: [] }] };
      window.calls = []; window.selections = []; window.pending = [];
      window.relations = [{ workspaceId: crypto.randomUUID(), entityId: 'ent_' + crypto.randomUUID(), typeId: 'item',
        name: '<img src=x onerror="window.relatedXss=true">', relationshipId: 'lnk_' + crypto.randomUUID(), relationshipName: 'Uses' }];
      const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      window.ui = PipeChatInspectorUI.create({ S: window.S, esc, icon: () => '', rowName: row => row.account,
        persist: async () => true, refresh: async () => {}, editRecord: async () => true, toast() {},
        onLoadRelationships: async request => {
          window.calls.push(request);
          if (window.defer) return new Promise(resolve => window.pending.push(resolve));
          if (window.failure) throw new Error('Server detail must not become HTML');
          return window.relations;
        }, onRelationships: item => { window.selections.push(item); }
      });
      window.ui.open(1);
    });
    const section = page.locator('[data-inspector-relationships]');
    await section.getByRole('button').waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls), [{ recordId: 1 }]);
    assert.equal(await section.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.relatedXss)), false);
    await section.getByRole('button').click();
    assert.deepEqual(await page.evaluate(() => window.selections), await page.evaluate(() => window.relations));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const screenshot = path.join(process.env.BUSINESS_UI_SCREENSHOT_DIR || os.tmpdir(), 'pipechat-primary-related-mobile.png');
    await page.screenshot({ path: screenshot, fullPage: true }); t.diagnostic(screenshot);
    await page.evaluate(() => { window.failure = true; return window.ui.reloadRelationships(); });
    assert.equal(await section.getByRole('button', { name: 'Retry', exact: true }).count(), 1);
    assert.equal(await section.getByText('Uses:', { exact: true }).count(), 0);
    await page.evaluate(() => { window.failure = false; });
    await section.getByRole('button', { name: 'Retry', exact: true }).click();
    await section.getByText('Uses:', { exact: true }).waitFor();
    await page.evaluate(() => { window.defer = true; window.ui.open(1); window.ui.open(2); });
    await page.evaluate(async () => { window.pending[0]([{ ...window.relations[0], name: 'Stale first record' }]); await Promise.resolve(); });
    assert.equal(await section.getByText('Stale first record', { exact: true }).count(), 0);
    await page.evaluate(async () => { window.pending[1]([{ ...window.relations[0], name: 'Current second record' }]); await Promise.resolve(); });
    await section.getByRole('button', { name: 'Current second record', exact: true }).waitFor();
    await page.evaluate(() => { window.ui.reloadRelationships(); window.S.generation++; window.S.user = null; window.ui.clear(); window.pending[2](window.relations); });
    assert.equal(await page.locator('[data-inspector-relationships]').count(), 0);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate(() => { window.S.user = { id: 'other', email: 'other@example.test' }; window.defer = false; window.relations = []; window.ui.open(1); });
    await section.getByText('No related entities', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    assert.equal(await page.locator('[data-inspector-relationships]').count(), 0);
    assert.deepEqual(errors, []);
  });
