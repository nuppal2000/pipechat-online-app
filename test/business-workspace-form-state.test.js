'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../public/business-workspace');
const UI = require('../public/business-workspace-ui');

const workspaceId = '00000000-0000-4000-8000-000000000001';
const entityId = 'ent_00000000-0000-4000-8000-000000000002';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settled = () => new Promise(resolve => setImmediate(resolve));
function snapshot(values = { name: 'QA contact' }, required = false) {
  const state = Core.empty();
  state.entityTypes = [{ id: 'contact', name: 'Contact', fields: [
    { id: 'name', name: 'Name', type: 'text', required: true, options: [] },
    { id: 'consent', name: 'Consent', type: 'boolean', required, options: [] }
  ] }];
  state.entities = [{ id: entityId, typeId: 'contact', values }];
  return { workspaceId, version: 0, role: 'owner', scope: 'workspace', state,
    access: { memberships: [], grants: [] },
    primary: { records: [], tableSchema: null, customFields: [], updatedAt: null } };
}

// Only the DOM surface used by this module; no browser, network, or persistence.
class Element {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.nodeType = 1;
    this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {};
    this.handlers = {}; this.disabled = false; this.checked = false; this.open = false;
    this.classList = { add() {}, toggle() {} }; this._text = ''; this._value = undefined;
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set value(value) { this._value = String(value); }
  get value() {
    if (this.tagName !== 'select') return this._value ?? '';
    if (this._value === undefined) return this.children[0]?.value ?? '';
    return this.children.some(option => option.value === this._value) ? this._value : '';
  }
  get selectedOptions() { return this.children.filter(option => option.value === this.value); }
  get isConnected() { return this.root === true || Boolean(this.parentNode?.isConnected); }
  append(...children) {
    for (const child of children) {
      if (child.tagName === 'fragment') { this.append(...child.children.slice()); continue; }
      child.remove(); child.parentNode = this; this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this._text = '';
    if (this.tagName === 'select') this._value = undefined;
    this.append(...children);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
  async fire(name) {
    const event = { target: this, preventDefault() {} };
    for (const handler of this.handlers[name] || []) await handler(event);
    if (this['on' + name]) await this['on' + name](event);
  }
  querySelectorAll(selector) {
    const matches = element => selector === '[data-business-status]' ? Object.hasOwn(element.dataset, 'businessStatus') :
      selector.split(',').includes(element.tagName);
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function harness(seed = snapshot(), overrides = {}, confirm = () => true) {
  const document = { createElement: tag => new Element(tag, document), createDocumentFragment: () => new Element('fragment', document) };
  const element = document.createElement('main'); element.root = true;
  const commits = [], reads = [], shares = [], changes = [];
  let saved = structuredClone(seed);
  const api = {
    read: async id => { reads.push(id); return structuredClone(saved); },
    commit: async plan => { commits.push(plan); saved = { ...saved, version: saved.version + 1, state: plan.next }; return structuredClone(saved); },
    share: async (...args) => { shares.push(args); return {}; },
    ...overrides
  };
  const ui = UI.mount({ element, api, confirm, onChange: value => changes.push(value) });
  ui.setSnapshot(seed);
  function button(label) {
    const found = element.querySelectorAll('button').find(item => item.attributes['aria-label'] === label);
    assert(found, 'Missing button: ' + label); return found;
  }
  function control(label) {
    const root = element.querySelector('dialog') || element;
    const caption = root.querySelectorAll('label').find(item => item.textContent === label);
    assert(caption, 'Missing label: ' + label);
    const found = root.querySelectorAll('input,select,textarea').find(item => item.id === caption.htmlFor);
    assert(found, 'Missing control: ' + label); return found;
  }
  const submit = () => element.querySelector('form').fire('submit');
  return { ui, api, element, button, control, submit, commits, reads, shares, changes };
}

for (const [label, stored] of [['missing', {}], ['null', { consent: null }], ['blank', { consent: '' }],
  ['false', { consent: false }], ['true', { consent: true }]]) {
  test(`unrelated entity edit preserves an optional Boolean stored as ${label}`, async () => {
    const seed = snapshot({ name: 'QA contact', ...stored }), h = harness(seed);
    await h.button('Edit QA contact').fire('click');
    const consent = h.control('Consent');
    assert.equal(consent.tagName, 'select');
    assert.deepEqual(consent.children.map(option => [option.value, option.textContent]), [['', 'Not set'], ['true', 'True'], ['false', 'False']]);
    assert.equal(consent.value, typeof stored.consent === 'boolean' ? String(stored.consent) : '');
    assert.equal(consent.required, false);
    h.control('Name').value = 'QA renamed'; await h.submit();
    assert.equal(h.commits.length, 1);
    assert.deepEqual(h.ui.getSnapshot().state.entities[0].values, { name: 'QA renamed', ...stored });
    assert.deepEqual(seed.state.entities[0].values, { name: 'QA contact', ...stored });
  });
}

for (const [before, selected, after] of [[null, 'true', true], [null, 'false', false],
  [true, 'false', false], [false, 'true', true], [true, '', null], [false, '', null]]) {
  test(`optional Boolean explicitly changes ${before} to ${selected || 'not set'}`, async () => {
    const h = harness(snapshot({ name: 'QA contact', consent: before }));
    await h.button('Edit QA contact').fire('click');
    h.control('Consent').value = selected; await h.submit();
    assert.deepEqual(h.ui.getSnapshot().state.entities[0].values, { name: 'QA contact', consent: after });
  });
}

for (const selected of ['', 'true', 'false']) {
  test(`new optional Boolean stores ${selected || 'no inferred value'}`, async () => {
    const h = harness(); await h.button('New entity').fire('click');
    h.control('Name').value = 'QA new'; h.control('Consent').value = selected; await h.submit();
    const created = h.ui.getSnapshot().state.entities.find(entity => entity.values.name === 'QA new');
    assert.deepEqual(created.values, { name: 'QA new', ...(selected ? { consent: selected === 'true' } : {}) });
  });
}

test('required Boolean remains binary and accepts false on edit and creation', async () => {
  const h = harness(snapshot({ name: 'QA contact', consent: true }, true));
  await h.button('Edit QA contact').fire('click');
  assert.equal(h.control('Consent').type, 'checkbox');
  assert.equal(Boolean(h.control('Consent').required), false, 'required checkbox would incorrectly forbid false');
  h.control('Consent').checked = false; await h.submit();
  assert.equal(h.ui.getSnapshot().state.entities[0].values.consent, false);
  await h.button('New entity').fire('click'); h.control('Name').value = 'QA new'; await h.submit();
  assert.equal(h.ui.getSnapshot().state.entities[1].values.consent, false);
});

test('cancelling an optional Boolean edit makes no write', async () => {
  const seed = snapshot({ name: 'QA contact', consent: null }), h = harness(seed);
  await h.button('Edit QA contact').fire('click'); h.control('Consent').value = 'true';
  await h.button('Cancel').fire('click');
  assert.equal(h.commits.length, 0); assert.deepEqual(h.ui.getSnapshot(), seed);
});

test('clear resets private snapshot, dialog, workspace target, filters, tab and pagination', async () => {
  const seed = snapshot();
  seed.state.entities = Array.from({ length: 101 }, (_, index) => ({
    id: `ent_00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
    typeId: 'contact', values: { name: `QA contact ${index}` }
  }));
  const h = harness(seed);
  h.control('Entity type').value = 'contact'; await h.control('Entity type').fire('change');
  const search = h.element.querySelectorAll('input').find(input => input.type === 'search');
  search.value = 'QA contact'; await search.fire('input'); await h.button('Load more records').fire('click');
  h.ui.show('Sharing'); await h.button('Grant access').fire('click');
  h.control('Existing account email').value = 'qa-private@example.invalid';
  h.ui.clear();
  assert.equal(h.ui.getSnapshot(), null); assert.equal(h.element.querySelector('dialog'), null);
  assert.doesNotMatch(h.element.textContent, /QA contact|qa-private/);
  assert.equal(h.element.querySelector('h2').textContent, 'Entities');
  assert.equal(h.element.querySelector('section').attributes['aria-busy'], 'false');
  assert.match(h.element.textContent, /No workspace loaded/);
  assert.equal(h.reads.length, 0); assert.equal(h.commits.length, 0); assert.equal(h.changes.length, 0);
  await h.ui.load(); assert.deepEqual(h.reads, [null]);
  assert.equal(h.control('Entity type').value, 'all');
  assert.equal(h.element.querySelectorAll('input').find(input => input.type === 'search').value, '');
  assert.equal(h.element.querySelectorAll('tbody')[0].children.length, 100);
  assert(h.button('Load more records'));
});

for (const fail of [false, true]) {
  test(`clear discards a late read ${fail ? 'failure' : 'success'} and permits a fresh load`, async () => {
    const old = deferred(), fresh = snapshot({ name: 'QA fresh' });
    const h = harness(snapshot(), { read: () => old.promise });
    const pending = h.ui.load(workspaceId); h.ui.clear();
    assert.equal(h.ui.getSnapshot(), null);
    h.api.read = async id => { assert.equal(id, null); return fresh; };
    await h.ui.load();
    if (fail) old.reject(new Error('Old account failure')); else old.resolve(snapshot({ name: 'QA stale private' }));
    await pending;
    assert.deepEqual(h.ui.getSnapshot(), fresh);
    assert.doesNotMatch(h.element.textContent, /QA stale private|Old account failure|Saving/);
  });
}

test('clear alone prevents a late read from reviving an empty panel', async () => {
  const old = deferred(), h = harness(snapshot(), { read: () => old.promise });
  const pending = h.ui.load(workspaceId); h.ui.clear(); old.resolve(snapshot()); await pending;
  assert.equal(h.ui.getSnapshot(), null); assert.doesNotMatch(h.element.textContent, /QA contact/);
  assert.equal(h.button('Reload workspace').disabled, false);
});

for (const fail of [false, true]) {
  test(`clear invalidates pending history ${fail ? 'revocation' : 'data'} without changing the next snapshot`, async () => {
    const history = deferred(), h = harness(snapshot(), { history: () => history.promise });
    h.ui.inspect(entityId); const oldDialog = h.element.querySelector('dialog');
    h.ui.clear(); assert.equal(oldDialog.open, false); assert.equal(oldDialog.isConnected, false);
    const fresh = snapshot({ name: 'QA fresh' }); h.ui.setSnapshot(fresh);
    if (fail) history.reject(Object.assign(new Error('Old history revoked'), { status: 403 }));
    else history.resolve({ workspaceId, entityId, events: [{ id: '1', kind: 'create', at: '2026-10-10T12:00:00Z',
      before: null, after: { values: { name: 'QA stale private' } } }], nextAfter: null });
    await settled();
    assert.deepEqual(h.ui.getSnapshot(), fresh);
    assert.doesNotMatch(h.element.textContent, /QA stale private|Old history revoked/);
    assert.equal(h.element.querySelector('dialog'), null);
  });
}

test('clear invalidates an outstanding delete confirmation', async () => {
  const confirmation = deferred(), h = harness(snapshot(), {}, () => confirmation.promise);
  const pending = h.button('Delete QA contact').fire('click'); h.ui.clear();
  h.ui.setSnapshot(snapshot({ name: 'QA fresh' })); confirmation.resolve(true); await pending;
  assert.equal(h.commits.length, 0);
  assert.equal(h.ui.getSnapshot().state.entities[0].values.name, 'QA fresh');
});

test('clear discards a late confirmation failure instead of exposing it in the new account', async () => {
  const confirmation = deferred(), h = harness(snapshot(), {}, () => confirmation.promise);
  const pending = h.button('Delete QA contact').fire('click'); h.ui.clear();
  const fresh = snapshot({ name: 'QA fresh' }); h.ui.setSnapshot(fresh);
  confirmation.reject(new Error('QA old private confirmation')); await pending;
  assert.equal(h.commits.length, 0); assert.deepEqual(h.ui.getSnapshot(), fresh);
  assert.doesNotMatch(h.element.textContent, /QA old private confirmation/);
});

test('clear invalidates an outstanding sharing confirmation and closes its dialog', async () => {
  const confirmation = deferred(), h = harness(snapshot(), {}, () => confirmation.promise);
  h.ui.show('Sharing'); await h.button('Grant access').fire('click');
  h.control('Existing account email').value = 'qa-recipient@example.invalid';
  const pending = h.submit(); h.ui.clear(); confirmation.resolve(true); await pending;
  assert.equal(h.shares.length, 0); assert.equal(h.element.querySelector('dialog'), null);
  assert.equal(h.ui.getSnapshot(), null);
});

test('clear ignores a late commit acknowledgement and does not notify the parent', async () => {
  const commit = deferred(), h = harness(snapshot(), { commit: () => commit.promise });
  await h.button('Edit QA contact').fire('click'); h.control('Name').value = 'QA stale saved';
  const pending = h.submit(); h.ui.clear();
  const fresh = snapshot({ name: 'QA fresh' }); h.ui.setSnapshot(fresh);
  commit.resolve(snapshot({ name: 'QA stale saved' })); await pending;
  assert.deepEqual(h.ui.getSnapshot(), fresh); assert.equal(h.changes.length, 0);
  assert.equal(h.button('New entity').disabled, false);
  assert.doesNotMatch(h.element.textContent, /QA stale saved/);
});

function contactManagementSnapshot() {
  const seed = snapshot({ name: 'QAE Morgan Lane', consent: false, email: 'morgan@example.com' });
  seed.state.entityTypes[0].fields.push(...['email', 'phone', 'temporary'].map(id => ({ id, name: id === 'temporary' ? 'QAE Temporary' : id, type: 'text', required: false, options: [] })));
  seed.state.entities.push({ id: 'ent_00000000-0000-4000-8000-000000000003', typeId: 'contact', values: { name: 'QAE Morgan Duplicate', phone: '555-0107', consent: true } });
  return seed;
}

test('merge UI previews keep-survivor policy, fills Phone and commits only after explicit confirmation', async () => {
  const seed = contactManagementSnapshot(), h = harness(seed);
  await h.button('Merge entities').fire('click');
  const source = h.element.querySelectorAll('input').find(input => input.type === 'checkbox');
  source.checked = true; await source.fire('change');
  assert(h.element.querySelectorAll('label').some(label => label.textContent === 'Name'));
  const policy = h.control('Merge policy'); policy.value = 'keep_survivor_fill_blanks'; await policy.fire('change');
  assert(h.element.textContent.includes('555-0107'));assert.equal(h.commits.length, 0);
  assert.equal(h.element.querySelectorAll('label').some(label => label.textContent === 'Name'), false);
  await h.submit();assert.equal(h.commits.length, 1);
  const survivor = h.commits[0].next.entities[0];
  assert.equal(survivor.id, entityId);assert.deepEqual(survivor.values, { name: 'QAE Morgan Lane', consent: false, email: 'morgan@example.com', phone: '555-0107' });
  assert.equal(h.commits[0].next.entities.length, 1);h.ui.destroy();
});

test('merge UI cancellation and stale confirmation never apply the policy', async () => {
  for (const stale of [false, true]) {
    const confirmation = deferred(), h = harness(contactManagementSnapshot(), {}, () => confirmation.promise);
    await h.button('Merge entities').fire('click');
    const source = h.element.querySelectorAll('input').find(input => input.type === 'checkbox');source.checked = true;await source.fire('change');
    const policy = h.control('Merge policy');policy.value = 'keep_survivor_fill_blanks';await policy.fire('change');
    const saving = h.submit();if (stale) h.ui.clear();confirmation.resolve(stale);await saving;
    assert.equal(h.commits.length, 0);h.ui.destroy();
  }
});

test('entity type UI exposes unused-field removal preview and keeps all other Contact data', async () => {
  const seed = contactManagementSnapshot(), before = structuredClone(seed), h = harness(seed);
  const type = h.control('Entity type');type.value = 'contact';await type.fire('change');
  await h.button('Edit entity type').fire('click');await h.button('Remove QAE Temporary field').fire('click');
  assert(h.element.textContent.includes('no saved nonblank values'));assert.equal(h.commits.length, 0);
  await h.submit();assert.equal(h.commits.length, 1);
  const expected = structuredClone(seed.state);expected.entityTypes[0].fields.pop();
  assert.deepEqual(h.commits[0].next, expected);assert.deepEqual(seed, before);h.ui.destroy();
});

test('entity field removal UI explains dependencies and cancellation never saves', async () => {
  for (const label of ['email', 'Name', 'QAE Temporary']) {
    const h = harness(contactManagementSnapshot()), type = h.control('Entity type');type.value = 'contact';await type.fire('change');
    await h.button('Edit entity type').fire('click');await h.button('Remove ' + label + ' field').fire('click');
    if (label !== 'QAE Temporary') {
      assert.equal(h.element.querySelector('form'), null);assert.match(h.element.textContent, /contains saved values|identifying field/);
    }
    await h.button('Cancel').fire('click');assert.equal(h.commits.length, 0);h.ui.destroy();
  }
});
