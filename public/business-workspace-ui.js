(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./business-workspace.js'));
  else root.PipeChatBusinessWorkspaceUI = factory(root, root.PipeChatBusinessWorkspace);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, Core) {
  'use strict';

  /* Mount contract:
   * mount({ element, api, workspaceId?, icon?, onChange?, onInspectPrimary?, confirm? })
   * api.read(workspaceId|null) -> canonical GET envelope
   * api.commit(Core.prepare(snapshot, commands)) -> committed GET envelope
   * api.share(snapshot, {email,scope,resourceId,role}) -> share receipt
   * api.revoke(snapshot, {email,scope,resourceId}) -> revoke receipt
   * Optional api.history(workspaceId, entityId, after='0') -> {workspaceId,
   *   entityId,events:[{id,version,kind,at,actorId,before,after,relationship}],nextAfter}
   * Audit IDs/cursors are decimal strings, chronological and server-generated.
   * Callbacks use the current authenticated parent API; this module has no URLs,
   * token storage, model authority, subscriptions, or legacy write path.
   * Optional icon(name) returns trusted existing Lucide markup. icons.js also works.
   * onInspectPrimary({workspaceId,entityId,recordId}) fires only on explicit owner
   * navigation. Parent must also match workspaceId to its own CRM workspace.
   * Shared viewers AND workspace editors inspect read-only primary values here;
   * neither can invoke the parent's legacy inspector through this callback.
   * Returns {load,setSnapshot,clear,show,inspect,getSnapshot,destroy}; mount does not fetch.
   * clear() invalidates pending UI work and resets private state without fetching.
   */
  function mount({ element, api, workspaceId = null, icon, onChange = () => {}, onInspectPrimary,
    confirm = message => root.confirm(message) } = {}) {
    if (!element?.ownerDocument || !Core || !api || typeof api.read !== 'function' || typeof api.commit !== 'function') {
      throw new TypeError('A mount element, business core and authenticated API callbacks are required.');
    }
    const document = element.ownerDocument;
    let snapshot = null, tab = 'Entities', busy = false, destroyed = false, epoch = 0, error = '', notice = '';
    let selectedType = 'all', query = '', limit = 100, dialog = null, sequence = 0;
    const componentId = 'pc-business-' + root.crypto.randomUUID();
    const shell = document.createElement('section'); shell.className = 'pc-business'; element.append(shell);
    const style = document.createElement('style'); style.textContent = styles; shell.append(style);
    const body = document.createElement('div'); shell.append(body);
    const node = (tag, text, className) => {
      const el = document.createElement(tag); if (text !== undefined && text !== null) el.textContent = String(text);
      if (className) el.className = className; return el;
    };
    const writable = () => snapshot?.scope === 'workspace' && ['owner', 'editor'].includes(snapshot.role);
    const owner = () => snapshot?.role === 'owner' && snapshot.scope === 'workspace';
    const newId = prefix => prefix + '_' + root.crypto.randomUUID();
    const schemaId = prefix => prefix + '_' + root.crypto.randomUUID().replace(/-/g, '');
    const copy = value => JSON.parse(JSON.stringify(value));
    function button(label, action, glyph, compact = false) {
      const b = node('button'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.disabled = busy;
      const markup = glyph && (icon ? icon(glyph) : root.PipeChatIcons?.[glyph]);
      if (markup) { const symbol = node('span', null, 'pc-business-icon'); symbol.innerHTML = markup; b.append(symbol); }
      if (!compact || !markup) b.append(node('span', label));
      if (compact && markup) b.classList.add('pc-business-icon-button');
      b.addEventListener('click', action); return b;
    }
    function input(type = 'text', value = '') {
      const el = node('input'); el.type = type; el.value = value ?? ''; return el;
    }
    function select(options, value) {
      const el = node('select');
      for (const [id, name] of options) { const option = node('option', name); option.value = id; el.append(option); }
      if (value !== undefined) el.value = value; return el;
    }
    function field(label, control) {
      const wrapper = node('div', null, 'pc-business-field'); control.id ||= componentId + '-' + (++sequence);
      const caption = node('label', label); caption.htmlFor = control.id; wrapper.append(caption, control); return wrapper;
    }
    function table(headers) {
      const wrapper = node('div', null, 'pc-business-scroll'), grid = node('table'), head = node('thead'), row = node('tr'), rows = node('tbody');
      for (const title of headers) { const cell = node('th', title); cell.scope = 'col'; row.append(cell); }
      head.append(row); grid.append(head, rows); wrapper.append(grid); return { wrapper, rows };
    }
    function tableRow(rows, values) {
      const row = node('tr');
      for (const value of values) { const cell = node('td'); if (value?.nodeType) cell.append(value); else cell.textContent = String(value ?? ''); row.append(cell); }
      rows.append(row); return row;
    }
    function types() { return [{ id: 'primary', name: snapshot.primary.tableSchema?.title || 'Primary records' }, ...snapshot.state.entityTypes]; }
    function records() {
      return [...snapshot.primary.records.map(r => ({ id: r.entityId, recordId: r.recordId, typeId: 'primary', values: r.values })), ...snapshot.state.entities];
    }
    function definitions(record) {
      return record.typeId === 'primary' ? [...(snapshot.primary.tableSchema?.fields || []), ...snapshot.primary.customFields] :
        snapshot.state.entityTypes.find(type => type.id === record.typeId)?.fields || [];
    }
    function recordName(record) {
      const fields = definitions(record), primary = fields.find(f => f.role === 'primary') || fields.find(f => f.type === 'text') || fields[0];
      const value = primary && record.values[primary.id];
      return String(value !== undefined && value !== null && value !== '' ? value :
        Object.values(record.values).find(v => typeof v === 'string' && v.trim()) || record.id);
    }
    function recordButton(id) {
      const record = records().find(r => r.id === id);
      if (!record) return node('span', 'Unavailable record');
      const b = button(recordName(record), () => inspect(id)); b.classList.add('pc-business-link'); return b;
    }
    function closeDialog() { if (dialog) { dialog.close(); dialog.remove(); dialog = null; } }
    function openDialog(title) {
      closeDialog(); dialog = node('dialog'); const heading = node('h3', title); heading.id = componentId + '-dialog';
      dialog.setAttribute('aria-labelledby', heading.id); const bar = node('header', null, 'pc-business-bar');
      bar.append(heading, button('Close', () => { if (!busy) closeDialog(); }, 'X', true));
      const content = node('div'); dialog.append(bar, content); dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
      shell.append(dialog); dialog.showModal(); return content;
    }
    function form(title, submitLabel, save) {
      const content = openDialog(title), form = node('form'), fields = node('div', null, 'pc-business-form-fields');
      const alert = node('p', '', 'pc-business-error'); alert.setAttribute('role', 'alert');
      const footer = node('footer', null, 'pc-business-bar'); const submit = button(submitLabel, () => {}, 'Check'); submit.type = 'submit'; submit.classList.add('pc-business-primary');
      footer.append(button('Cancel', closeDialog), submit); form.append(fields, alert, footer); content.append(form);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (busy || destroyed) return; alert.textContent = '';
        try { await save(); } catch (e) { if (form.isConnected) alert.textContent = e.message || 'Request failed.'; }
      });
      return fields;
    }
    function controls(disabled) {
      shell.setAttribute('aria-busy', String(disabled));
      for (const el of shell.querySelectorAll('button,input,select,textarea')) {
        if (disabled) { el.dataset.businessDisabled = String(el.disabled); el.disabled = true; }
        else if (el.dataset.businessDisabled !== undefined) { el.disabled = el.dataset.businessDisabled === 'true'; delete el.dataset.businessDisabled; }
      }
    }
    function changed() { try { Promise.resolve(onChange(copy(snapshot))).catch(() => {}); } catch { /* Parent rendering must not retry a committed save. */ } }
    function validateSnapshot(value) {
      if (!value || !['owner', 'editor', 'viewer'].includes(value.role) || !['workspace', 'shared'].includes(value.scope) ||
          value.scope === 'shared' && value.role !== 'viewer' || !Number.isSafeInteger(value.version) || value.version < 0 || !Array.isArray(value.primary?.records)) throw new Error('Invalid workspace response.');
      Core.legacyId(value.workspaceId, 1);
      Core.validate(value.state, { workspaceId: value.workspaceId, legacyRecordIds: value.primary.records.map(r => r.recordId) });
      return copy(value);
    }
    async function mutate(action, message = 'Saved') {
      if (busy || !snapshot) return;
      const generation = epoch; busy = true; controls(true); error = ''; notice = '';
      try {
        const result = validateSnapshot(await action());
        if (destroyed || generation !== epoch) return;
        snapshot = result; notice = message; busy = false; closeDialog(); draw(); changed();
      } catch (e) {
        if (destroyed || generation !== epoch) return;
        if ([401, 403].includes(e.status)) { snapshot = null; busy = false; closeDialog(); error = 'Workspace access is unavailable.'; draw(); }
        throw e;
      } finally { if (!destroyed && generation === epoch) { busy = false; controls(false); drawStatus(); } }
    }
    async function commit(commands) {
      const prepared = Core.prepare(snapshot, commands);
      return mutate(() => api.commit(prepared));
    }
    async function access(action) {
      const current = snapshot;
      return mutate(async () => { await action(current); return api.read(current.workspaceId); }, 'Access updated');
    }
    async function confirmed(message, action) {
      if (busy) return;
      const generation = epoch, current = snapshot;
      try { if (await confirm(message) && generation === epoch && current === snapshot && !destroyed) await action(); }
      catch (e) {
        if (!destroyed && generation === epoch && current === snapshot) { error = e.message || 'Request failed.'; drawStatus(); }
      }
    }
    async function load(id = workspaceId) {
      if (destroyed) return;
      const generation = ++epoch; workspaceId = id; snapshot = null; busy = true; error = ''; notice = ''; closeDialog(); draw();
      try {
        const result = validateSnapshot(await api.read(id));
        if (destroyed || generation !== epoch) return;
        snapshot = result; workspaceId = result.workspaceId;
      } catch (e) { if (generation === epoch && !destroyed) error = e.message || 'Workspace could not be loaded.'; }
      finally { if (generation === epoch && !destroyed) { busy = false; draw(); } }
      return snapshot ? copy(snapshot) : null;
    }
    function setSnapshot(value) {
      const validated = value === null ? null : validateSnapshot(value);
      ++epoch; busy = false; closeDialog(); snapshot = validated; workspaceId = value?.workspaceId ?? null; error = ''; notice = ''; draw();
    }
    function clear() {
      if (destroyed) return;
      ++epoch; busy = false; closeDialog(); snapshot = null; workspaceId = null;
      tab = 'Entities'; selectedType = 'all'; query = ''; limit = 100; error = ''; notice = '';
      shell.setAttribute('aria-busy', 'false'); draw();
    }
    function drawStatus() {
      const status = body.querySelector('[data-business-status]');
      if (status) { status.textContent = error || (busy ? 'Saving...' : notice); status.classList.toggle('pc-business-error', Boolean(error)); }
    }
    function draw() {
      body.replaceChildren(); const top = node('header', null, 'pc-business-bar');
      const title = node('h2', tab), actions = node('div', null, 'pc-business-actions');
      if (snapshot) actions.append(node('span', snapshot.role[0].toUpperCase() + snapshot.role.slice(1) + (snapshot.scope === 'shared' ? ' / Shared records' : ''), 'pc-business-role'));
      actions.append(button('Reload workspace', () => load(), 'RotateCcw', true)); top.append(title, actions); body.append(top);
      const status = node('p', error || notice, 'pc-business-status'); status.dataset.businessStatus = ''; status.setAttribute('role', 'status'); body.append(status);
      if (!snapshot) { body.append(node('p', busy ? 'Loading workspace...' : error ? '' : 'No workspace loaded.')); return; }
      if (tab === 'Sharing' && !owner()) tab = 'Entities';
      title.textContent = tab;
      const tabs = node('nav', null, 'pc-business-tabs'); tabs.setAttribute('aria-label', 'Business workspace');
      for (const name of owner() ? ['Entities', 'Relationships', 'Sharing'] : ['Entities', 'Relationships']) {
        const b = button(name, () => { tab = name; draw(); }); b.setAttribute('aria-current', String(tab === name)); tabs.append(b);
      }
      body.append(tabs);
      if (tab === 'Entities') drawEntities(); else if (tab === 'Relationships') drawRelationships(); else drawSharing();
    }
    function drawEntities() {
      const bar = node('div', null, 'pc-business-bar');
      const filter = select([['all', 'All types'], ...types().map(t => [t.id, t.name])], selectedType);
      if (!filter.value) { selectedType = 'all'; filter.value = 'all'; }
      const search = input('search', query); search.setAttribute('aria-label', 'Search records'); search.placeholder = 'Search records';
      bar.append(field('Entity type', filter), search);
      if (owner()) bar.append(button('New entity type', () => typeForm(), 'Plus'));
      if (writable() && snapshot.state.entityTypes.length) bar.append(button('New entity', () => entityForm(), 'Plus'));
      if (writable() && snapshot.state.entityTypes.some(type => snapshot.state.entities.filter(entity => entity.typeId === type.id).length > 1)) {
        bar.append(button('Merge entities', () => mergeForm(), 'ArrowRight'));
      }
      if (owner() && selectedType !== 'all' && selectedType !== 'primary') bar.append(button('Edit entity type', () => typeForm(snapshot.state.entityTypes.find(t => t.id === selectedType)), 'Settings', true));
      body.append(bar);
      const listing = node('div'); body.append(listing);
      const refresh = () => {
        listing.replaceChildren(); const all = records().filter(r => (selectedType === 'all' || r.typeId === selectedType) && recordName(r).toLowerCase().includes(query.toLowerCase()));
        const counts = new Map(); for (const r of snapshot.state.relationships) { counts.set(r.fromId, (counts.get(r.fromId) || 0) + 1); counts.set(r.toId, (counts.get(r.toId) || 0) + 1); }
        const { wrapper, rows } = table(['Record', 'Type', 'Relationships', 'Actions']);
        for (const record of all.slice(0, limit)) {
          const actions = node('div', null, 'pc-business-actions');
          if (writable() && record.typeId !== 'primary') {
            actions.append(button('Edit ' + recordName(record), () => entityForm(record), 'Settings', true));
            actions.append(button('Delete ' + recordName(record), () => confirmed('Delete ' + recordName(record) + ' and its relationships?', () => commit([{ op: 'delete_entity', id: record.id }])), 'Trash2', true));
          }
          tableRow(rows, [recordButton(record.id), types().find(t => t.id === record.typeId)?.name, counts.get(record.id) || 0, actions]);
        }
        listing.append(wrapper, node('p', all.length + ' records', 'pc-business-muted'));
        if (all.length > limit) listing.append(button('Load more records', () => { limit += 100; refresh(); }));
      };
      search.oninput = () => { query = search.value; limit = 100; refresh(); };
      filter.onchange = () => { selectedType = filter.value; limit = 100; draw(); }; refresh();
    }
    function typeForm(existing) {
      if (!owner()) return;
      const name = input('text', existing?.name); name.required = true; name.maxLength = 120;
      const rows = [], container = node('div');
      const fields = form(existing ? 'Edit entity type' : 'New entity type', 'Save type', () => commit(Core.compileSchemaProposal({ version: 1,
        entityTypes: [{ id: existing?.id || schemaId('et'), name: name.value.trim(), fields: rows.map(row => ({ id: row.id, name: row.name.value.trim(),
          type: row.type.value, required: row.required.checked, options: row.type.value === 'choice' ? row.options.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean) : [] })) }], relationshipTypes: [] })));
      function add(def) {
        if (rows.length >= 40) return;
        const row = { id: def?.id || schemaId('f'), name: input('text', def?.name), type: select(Core.fieldTypes.map(t => [t, t]), def?.type || 'text'),
          required: input('checkbox'), options: node('textarea') };
        row.name.required = true; row.name.maxLength = 120; row.type.disabled = Boolean(def); row.required.checked = def?.required ?? false;
        row.options.value = (def?.options || []).join('\n'); row.options.rows = 3;
        const section = node('div', null, 'pc-business-field-definition'), grid = node('div', null, 'pc-business-field-grid');
        grid.append(field('Field name', row.name), field('Field type', row.type), field('Required', row.required));
        if (!def) grid.append(button('Remove field', () => { rows.splice(rows.indexOf(row), 1); section.remove(); }, 'Trash2', true));
        const choices = field('Choices (one per line)', row.options); choices.hidden = row.type.value !== 'choice'; row.type.onchange = () => { choices.hidden = row.type.value !== 'choice'; };
        section.append(grid, choices); container.append(section); rows.push(row);
      }
      fields.append(field('Type name', name), container, button('Add field', () => add(), 'Plus'));
      if (existing) existing.fields.forEach(add); else add();
    }
    function entityForm(existing) {
      if (!writable()) return;
      const choice = select(snapshot.state.entityTypes.map(t => [t.id, t.name]), existing?.typeId || (selectedType !== 'primary' && selectedType !== 'all' ? selectedType : snapshot.state.entityTypes[0]?.id));
      choice.disabled = Boolean(existing); let values = [];
      const container = node('div');
      const fields = form(existing ? 'Edit entity' : 'New entity', 'Save entity', () => {
        // An untouched optional Boolean keeps its original null/blank/missing value.
        const data = Object.fromEntries(values.filter(({ def, control, initialValue }) =>
          def.type !== 'boolean' || def.required || control.value !== initialValue).map(({ def, control }) =>
          [def.id, def.type === 'boolean' ? def.required ? control.checked : control.value === '' ? null : control.value === 'true' :
            def.type === 'number' ? control.value === '' ? null : Number(control.value) : control.value]));
        return commit([existing ? { op: 'update_entity', id: existing.id, values: data } :
          { op: 'create_entity', entity: { id: newId('ent'), typeId: choice.value, values: data } }]);
      });
      const drawFields = () => {
        container.replaceChildren(); values = [];
        for (const def of snapshot.state.entityTypes.find(t => t.id === choice.value)?.fields || []) {
          const value = existing?.values[def.id];
          const control = def.type === 'boolean' && !def.required ? select([['', 'Not set'], ['true', 'True'], ['false', 'False']], typeof value === 'boolean' ? String(value) : '') :
            def.type === 'choice' ? select([['', 'Not set'], ...def.options.map(v => [v, v])], value || '') :
            input(def.type === 'boolean' ? 'checkbox' : def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text', value);
          if (def.type === 'boolean' && def.required) control.checked = value === true; else control.required = def.required;
          if (def.type === 'number') { control.step = 'any'; control.min = '-1000000000000'; control.max = '1000000000000'; }
          if (def.type === 'text') control.maxLength = 12000;
          container.append(field(def.name, control)); values.push({ def, control, initialValue: control.value });
        }
      };
      choice.onchange = drawFields; fields.append(field('Entity type', choice), container); drawFields();
    }
    function mergeForm() {
      if (!writable()) return;
      const eligible = snapshot.state.entityTypes.filter(type => snapshot.state.entities.filter(entity => entity.typeId === type.id).length > 1);
      if (!eligible.length) return;
      const type = select(eligible.map(t => [t.id, t.name]), eligible.some(t => t.id === selectedType) ? selectedType : eligible[0].id);
      const survivor = select([]), sources = node('div', null, 'pc-business-checklist'), preview = node('div');
      let selected = new Set(), choices = [], plan = null;
      const fields = form('Merge entities', 'Merge selected entities', async () => {
        if (!plan || !selected.size) throw new Error('Select at least one source entity.');
        const fieldResolutions = Object.fromEntries(choices.filter(choice => choice.control.value !== '').map(choice => [choice.id, choice.values[Number(choice.control.value)]]));
        const command = { op: 'merge_entities', survivorId: survivor.value, sourceIds: [...selected], fieldResolutions,
          replacementLinkIds: Object.fromEntries(plan.redirectedLinkIds.map(id => [id, newId('lnk')])) };
        const current = snapshot, generation = epoch, prepared = Core.prepare(current, [command]);
        const target = current.state.entities.find(entity => entity.id === survivor.value);
        const message = 'Merge ' + selected.size + ' source entities into ' + recordName(target) + '? Sources will be deleted. Source record grants will be revoked, not transferred. Source IDs will be removed from saved views; existing survivor access remains. This merge has no undo.';
        if (await confirm(message) && !destroyed && generation === epoch && current === snapshot) {
          await mutate(() => api.commit(prepared), 'Entities merged');
        }
      });
      function showPreview() {
        preview.replaceChildren(); choices = []; plan = null;
        if (!selected.size) return;
        try {
          plan = Core.mergePreview(snapshot.state, { survivorId: survivor.value, sourceIds: [...selected] });
          preview.append(node('h4', 'Merged values'));
          for (const candidate of plan.fields) {
            if (candidate.values.length > 1) {
              const long = candidate.values.some(value => String(value).length > 160);
              const control = select([['', 'Choose a value'], ...candidate.values.map((value, index) => [String(index), (long ? (index + 1) + '. ' : '') + String(value).slice(0, 160)])], '');
              control.required = true; choices.push({ ...candidate, control }); preview.append(field(candidate.name, control));
              if (long) {
                const details = node('details'), values = node('ol', null, 'pc-business-merge-options');
                for (const value of candidate.values) values.append(node('li', value, 'pc-business-merge-value'));
                details.append(node('summary', candidate.name + ' / Full values'), values); preview.append(details);
              }
            } else {
              const value = node('p', candidate.values.length ? String(candidate.values[0]) : 'Not set', 'pc-business-merge-value');
              preview.append(node('h4', candidate.name), value);
            }
          }
          preview.append(node('p', plan.redirectedLinkIds.length + ' redirected relationships; ' + plan.affectedViewIds.length + ' affected views', 'pc-business-muted'));
        } catch (e) { preview.append(node('p', e.message, 'pc-business-error')); }
      }
      function showSources() {
        selected = new Set(); sources.replaceChildren();
        for (const entity of snapshot.state.entities.filter(entity => entity.typeId === type.value && entity.id !== survivor.value)) {
          const checkbox = input('checkbox'); checkbox.onchange = () => {
            if (checkbox.checked) selected.add(entity.id); else selected.delete(entity.id); showPreview();
          };
          sources.append(field(recordName(entity) + ' (' + entity.id.slice(-8) + ')', checkbox));
        }
        showPreview();
      }
      function showSurvivors() {
        survivor.replaceChildren();
        for (const entity of snapshot.state.entities.filter(entity => entity.typeId === type.value)) {
          const option = node('option', recordName(entity) + ' (' + entity.id.slice(-8) + ')'); option.value = entity.id; survivor.append(option);
        }
        showSources();
      }
      type.onchange = showSurvivors; survivor.onchange = showSources;
      fields.append(field('Entity type', type), field('Surviving entity', survivor), node('h4', 'Source entities'), sources, preview); showSurvivors();
    }
    function inspect(id) {
      if (!snapshot || busy) return;
      const record = records().find(r => r.id === id); if (!record) return;
      const content = openDialog(recordName(record)), values = node('dl', null, 'pc-business-details');
      if (record.typeId === 'primary') content.append(node('p', 'Primary record / Read-only', 'pc-business-muted'));
      const definitionsList = definitions(record);
      for (const [key, value] of Object.entries(record.values)) {
        values.append(node('dt', definitionsList.find(f => f.id === key)?.name || key), node('dd', value === null || value === '' ? 'Not set' : String(value)));
      }
      content.append(values, node('p', record.id, 'pc-business-identity'), node('h4', 'Relationships'));
      const related = snapshot.state.relationships.filter(r => r.fromId === id || r.toId === id);
      for (const relation of related) {
        const row = node('div', null, 'pc-business-bar'); row.append(node('span', snapshot.state.relationshipTypes.find(t => t.id === relation.typeId)?.name), recordButton(relation.fromId === id ? relation.toId : relation.fromId)); content.append(row);
      }
      if (!related.length) content.append(node('p', 'No relationships', 'pc-business-muted'));
      if (record.typeId === 'primary' && owner() && onInspectPrimary) content.append(button('Open primary record', () => {
        closeDialog(); onInspectPrimary({ workspaceId: snapshot.workspaceId, entityId: record.id, recordId: record.recordId });
      }, 'ArrowUpRight'));
      inspectHistory(content, record);
    }
    function inspectHistory(content, record) {
      content.append(node('h4', 'History'));
      const list = node('ol', null, 'pc-business-history'), status = node('p', '', 'pc-business-muted');
      status.setAttribute('role', 'status'); content.append(list, status);
      if (typeof api.history !== 'function') { status.textContent = 'History unavailable'; return; }
      const current = snapshot, generation = epoch, modal = dialog, defs = definitions(record);
      const more = button('Load more history', () => fetchPage()), retry = button('Retry history', () => fetchPage());
      more.hidden = true; retry.hidden = true; content.append(more, retry);
      let cursor = '0', fetching = false;
      const active = () => !destroyed && generation === epoch && snapshot === current && dialog === modal && modal.open && content.isConnected;
      const display = value => value === undefined || value === null || value === '' ? 'Not set' : String(value);
      async function fetchPage() {
        if (fetching || !active()) return;
        fetching = true; more.hidden = true; retry.hidden = true; status.textContent = 'Loading history...'; list.setAttribute('aria-busy', 'true');
        try {
          const page = await api.history(current.workspaceId, record.id, cursor);
          if (!active()) return;
          let previous = BigInt(cursor);
          if (page?.workspaceId !== current.workspaceId || page?.entityId !== record.id || !Array.isArray(page.events) || page.events.length > 50) throw new Error('Invalid history response.');
          for (const event of page.events) {
            if (typeof event.id !== 'string' || !/^[1-9][0-9]*$/.test(event.id) || BigInt(event.id) <= previous ||
                !['create', 'update', 'delete', 'link', 'unlink'].includes(event.kind) || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid history response.');
            previous = BigInt(event.id);
          }
          if (page.nextAfter !== null && (typeof page.nextAfter !== 'string' || !page.events.length || page.nextAfter !== page.events.at(-1).id)) throw new Error('Invalid history cursor.');
          const fragment = document.createDocumentFragment();
          for (const event of page.events) {
            const item = node('li'), header = node('header', null, 'pc-business-bar');
            header.append(node('strong', { create: 'Entity created', update: 'Entity updated', delete: 'Entity deleted', link: 'Records linked', unlink: 'Records unlinked' }[event.kind]));
            const time = node('time', new Date(event.at).toLocaleString()); time.dateTime = event.at; header.append(time); item.append(header);
            if (event.kind === 'link' || event.kind === 'unlink') {
              const relation = event.relationship;
              if (!relation || ![relation.fromId, relation.toId].includes(record.id)) throw new Error('Invalid relationship history.');
              item.append(node('p', current.state.relationshipTypes.find(t => t.id === relation.typeId)?.name || relation.typeId), recordButton(relation.fromId === record.id ? relation.toId : relation.fromId));
            } else {
              const before = event.before?.values || {}, after = event.after?.values || {}, changes = node('dl', null, 'pc-business-details');
              for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
                if (before[key] === after[key]) continue;
                changes.append(node('dt', defs.find(f => f.id === key)?.name || key),
                  node('dd', event.kind === 'create' ? display(after[key]) : event.kind === 'delete' ? display(before[key]) : display(before[key]) + ' -> ' + display(after[key])));
              }
              item.append(changes);
            }
            fragment.append(item);
          }
          list.append(fragment); cursor = page.nextAfter || page.events.at(-1)?.id || cursor;
          more.hidden = page.nextAfter === null; status.textContent = list.children.length ? '' : 'No history recorded';
        } catch (e) {
          if (!active()) return;
          if ([401, 403].includes(e.status)) { setSnapshot(null); error = 'Workspace access is unavailable.'; draw(); return; }
          status.textContent = e.message || 'History could not be loaded.'; retry.hidden = false;
        } finally { fetching = false; if (active()) list.setAttribute('aria-busy', 'false'); }
      }
      fetchPage();
    }
    function drawRelationships() {
      const bar = node('div', null, 'pc-business-bar');
      if (owner()) bar.append(button('New relationship type', relationshipTypeForm, 'Plus'));
      if (writable() && snapshot.state.relationshipTypes.length) bar.append(button('Link records', linkForm, 'Plus'));
      body.append(bar);
      const { wrapper, rows } = table(['Relationship', 'From', 'To', 'Actions']);
      for (const link of snapshot.state.relationships) {
        tableRow(rows, [snapshot.state.relationshipTypes.find(t => t.id === link.typeId)?.name, recordButton(link.fromId), recordButton(link.toId),
          writable() ? button('Unlink records', () => confirmed('Remove this relationship?', () => commit([{ op: 'unlink', id: link.id }])), 'X', true) : '']);
      }
      body.append(wrapper, node('h3', 'Relationship types'));
      const definitions = table(['Name', 'From type', 'To type', 'Cardinality']);
      for (const def of snapshot.state.relationshipTypes) tableRow(definitions.rows, [def.name, types().find(t => t.id === def.fromType)?.name,
        types().find(t => t.id === def.toType)?.name, def.cardinality.replace(/_/g, ' ')]);
      body.append(definitions.wrapper);
    }
    function relationshipTypeForm() {
      if (!owner()) return;
      const name = input(), from = select(types().map(t => [t.id, t.name])), to = select(types().map(t => [t.id, t.name]));
      const cardinality = select(Core.cardinalities.map(c => [c, c.replace(/_/g, ' ')]), 'many_to_many'); name.required = true; name.maxLength = 120;
      const fields = form('New relationship type', 'Save relationship type', () => commit(Core.compileSchemaProposal({ version: 1, entityTypes: [],
        relationshipTypes: [{ id: schemaId('rel'), name: name.value.trim(), fromType: from.value, toType: to.value, cardinality: cardinality.value }] })));
      fields.append(field('Relationship name', name), field('From type', from), field('To type', to), field('Cardinality', cardinality));
    }
    function linkForm() {
      if (!writable()) return;
      const type = select(snapshot.state.relationshipTypes.map(t => [t.id, t.name])), from = select([]), to = select([]); from.required = true; to.required = true;
      const fill = () => {
        const def = snapshot.state.relationshipTypes.find(t => t.id === type.value);
        for (const [control, typeId] of [[from, def.fromType], [to, def.toType]]) {
          control.replaceChildren(); for (const record of records().filter(r => r.typeId === typeId)) { const opt = node('option', recordName(record)); opt.value = record.id; control.append(opt); }
        }
      };
      const fields = form('Link records', 'Create link', () => commit([{ op: 'link', relationship: { id: newId('lnk'), typeId: type.value, fromId: from.value, toId: to.value } }]));
      type.onchange = fill; fields.append(field('Relationship type', type), field('From record', from), field('To record', to)); fill();
    }
    function viewForm(existing) {
      if (!owner()) return;
      const name = input('text', existing?.name); name.required = true; name.maxLength = 120;
      const selected = new Set(existing?.entityIds || []), options = node('div', null, 'pc-business-checklist');
      for (const record of records()) {
        const checkbox = input('checkbox'); checkbox.checked = selected.has(record.id);
        checkbox.onchange = () => { if (checkbox.checked) selected.add(record.id); else selected.delete(record.id); };
        options.append(field(recordName(record), checkbox));
      }
      const fields = form(existing ? 'Edit saved view' : 'New saved view', 'Save view', () => commit([{ op: 'put_view', view: { id: existing?.id || newId('view'), name: name.value.trim(), entityIds: [...selected] } }]));
      fields.append(field('View name', name), options);
    }
    function shareForm() {
      if (!owner() || typeof api.share !== 'function') return;
      const email = input('email'); email.required = true; email.maxLength = 320; email.autocomplete = 'off';
      const scope = select([['workspace', 'Workspace'], ['record', 'Record'], ['view', 'Saved view']]);
      const resource = select([]), role = select([['viewer', 'Viewer'], ['editor', 'Editor']]);
      const resourceField = field('Shared resource', resource);
      const fill = () => {
        resource.replaceChildren(); resourceField.hidden = scope.value === 'workspace'; resource.required = scope.value !== 'workspace';
        role.disabled = scope.value !== 'workspace'; if (role.disabled) role.value = 'viewer';
        const items = scope.value === 'view' ? snapshot.state.views.map(v => [v.id, v.name]) : records().map(r => [r.id, recordName(r)]);
        for (const [id, label] of items) { const option = node('option', label); option.value = id; resource.append(option); }
      };
      const fields = form('Grant access', 'Grant access', async () => {
        const generation = epoch, current = snapshot;
        const request = { email: email.value.trim(), scope: scope.value, resourceId: scope.value === 'workspace' ? null : resource.value, role: role.value };
        const target = request.scope === 'workspace' ? 'this workspace' : resource.selectedOptions[0]?.textContent;
        if (await confirm('Grant ' + request.role + ' access to ' + target + ' for ' + request.email + '? Existing access remains. No email will be sent.') &&
            generation === epoch && current === snapshot && !destroyed) {
          await access(current => api.share(current, request));
        }
      });
      fields.append(field('Existing account email', email), field('Scope', scope), resourceField, field('Role', role)); scope.onchange = fill; fill();
    }
    function drawSharing() {
      const bar = node('div', null, 'pc-business-bar');
      if (api.share) bar.append(button('Grant access', shareForm, 'Share2'));
      bar.append(button('New saved view', () => viewForm(), 'Plus')); body.append(bar, node('h3', 'Workspace members'));
      const members = table(['Account', 'Role', 'Actions']);
      for (const member of snapshot.access?.memberships || []) {
        const role = select([['viewer', 'Viewer'], ['editor', 'Editor']], member.role); role.setAttribute('aria-label', 'Role for ' + member.email);
        const actions = node('div', null, 'pc-business-actions');
        if (api.share) actions.append(button('Update role for ' + member.email, () => confirmed('Set ' + member.email + ' to ' + role.value + '?', () => access(current => api.share(current,
          { email: member.email, scope: 'workspace', resourceId: null, role: role.value }))), 'Check', true));
        if (api.revoke) actions.append(button('Revoke all access for ' + member.email, () => confirmed('Revoke all workspace, record and view access for ' + member.email + '?', () => access(current => api.revoke(current,
          { email: member.email, scope: 'workspace', resourceId: null }))), 'Trash2', true));
        tableRow(members.rows, [member.email, role, actions]);
      }
      body.append(members.wrapper, node('h3', 'Record and view grants'));
      const grants = table(['Account', 'Scope', 'Resource', 'Actions']);
      for (const grant of snapshot.access?.grants || []) {
        const resource = grant.scope === 'view' ? snapshot.state.views.find(v => v.id === grant.resourceId)?.name : recordButton(grant.resourceId);
        tableRow(grants.rows, [grant.email, grant.scope, resource,
          api.revoke ? button('Revoke ' + grant.scope + ' access for ' + grant.email, () => confirmed('Revoke this ' + grant.scope + ' grant for ' + grant.email + '?', () => access(current => api.revoke(current,
            { email: grant.email, scope: grant.scope, resourceId: grant.resourceId }))), 'Trash2', true) : '']);
      }
      body.append(grants.wrapper, node('h3', 'Saved views'));
      const views = table(['View', 'Records', 'Actions']);
      for (const view of snapshot.state.views) {
        const actions = node('div', null, 'pc-business-actions'); actions.append(button('Edit ' + view.name, () => viewForm(view), 'Settings', true),
          button('Delete ' + view.name, () => confirmed('Delete ' + view.name + ' and revoke its grants?', () => commit([{ op: 'delete_view', id: view.id }])), 'Trash2', true));
        tableRow(views.rows, [view.name, view.entityIds.length, actions]);
      }
      body.append(views.wrapper);
    }
    draw();
    return { load, setSnapshot, clear, inspect,
      show(name) { if (!['Entities', 'Relationships', 'Sharing'].includes(name)) throw new Error('Unknown business view.'); tab = name; draw(); },
      getSnapshot() { return snapshot ? copy(snapshot) : null; },
      destroy() { destroyed = true; ++epoch; snapshot = null; closeDialog(); shell.remove(); }
    };
  }

  const styles = `
    .pc-business{color:#20272d;background:#fff;font:14px/1.45 system-ui,sans-serif;min-width:0;letter-spacing:0}
    .pc-business *{box-sizing:border-box;letter-spacing:0}.pc-business [hidden]{display:none!important}
    .pc-business h2{font-size:22px;margin:0}.pc-business h3{font-size:16px;margin:20px 0 12px;overflow-wrap:anywhere;min-width:0}.pc-business h4{font-size:14px}
    .pc-business button,.pc-business input,.pc-business select,.pc-business textarea{font:inherit;color:inherit;max-width:100%}
    .pc-business button{display:inline-flex;gap:7px;align-items:center;justify-content:center;min-height:36px;padding:7px 10px;border:1px solid #cbd3d8;border-radius:5px;background:#fff;cursor:pointer;white-space:normal;overflow-wrap:anywhere;text-align:left}
    .pc-business button:hover{background:#f0f5f4}.pc-business button:disabled{opacity:.55;cursor:default}
    .pc-business :focus-visible{outline:2px solid #08796e;outline-offset:2px}.pc-business input,.pc-business select,.pc-business textarea{border:1px solid #bbc5cc;border-radius:4px;padding:8px;width:100%;min-height:36px;background:#fff}
    .pc-business input[type=checkbox]{width:18px;min-height:18px;height:18px;accent-color:#08796e}
    .pc-business-icon{display:inline-flex;flex:none}.pc-business-icon svg{width:17px;height:17px}.pc-business .pc-business-icon-button{width:36px;height:36px;flex:none;padding:8px}
    .pc-business .pc-business-primary{background:#08796e;color:#fff;border-color:#08796e}
    .pc-business-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between;margin:12px 0}
    .pc-business-bar>h3{margin:0}.pc-business-bar>input{width:220px;flex:1;min-width:140px}.pc-business-bar>.pc-business-field{min-width:150px;max-width:260px;flex:1}
    .pc-business-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pc-business-role,.pc-business-muted{color:#52616b;font-size:13px}
    .pc-business-tabs{display:flex;gap:18px;border-bottom:1px solid #dce2e6;margin:8px 0 18px;flex-wrap:wrap}
    .pc-business-tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:10px 0;background:none}
    .pc-business-tabs [aria-current=true]{border-color:#08796e;color:#06665d;font-weight:600}
    .pc-business-status{min-height:20px;margin:6px 0;color:#06665d}.pc-business-error{color:#a72336;overflow-wrap:anywhere}
    .pc-business-scroll{overflow:auto;max-width:100%}.pc-business table{border-collapse:collapse;width:100%;table-layout:fixed;min-width:480px}
    .pc-business th{font-size:12px;color:#51616c;background:#f3f5f7;text-align:left}.pc-business td,.pc-business th{padding:10px 12px;border-bottom:1px solid #e1e6e9;overflow-wrap:anywhere;vertical-align:middle}
    .pc-business .pc-business-link{border:0;padding:0;min-height:30px;color:#086e68;background:none;justify-content:flex-start}
    .pc-business dialog{color:inherit;width:min(640px,calc(100vw - 24px));max-height:85vh;padding:20px;border:1px solid #ccd4da;border-radius:8px;overflow:auto;box-shadow:0 12px 40px #20272d24;background:white}
    .pc-business dialog::backdrop{background:#18242d66}.pc-business-form-fields{display:grid;gap:16px}.pc-business-field{display:grid;gap:5px;min-width:0}.pc-business-field label{font-size:13px;font-weight:600;overflow-wrap:anywhere}
    .pc-business-field-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(100px,130px) 65px 36px;gap:10px;align-items:end}
    .pc-business-field-definition{border-top:1px solid #dde4e9;padding:14px 0}.pc-business-checklist{display:grid;gap:12px;max-height:300px;overflow:auto}
    .pc-business-checklist .pc-business-field{display:flex;flex-direction:row-reverse;justify-content:flex-end;align-items:center;gap:10px}
    .pc-business-details{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,2fr);gap:12px}.pc-business-details dt{color:#52616b}.pc-business-details dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
    .pc-business-identity{font-size:12px;color:#61717a;overflow-wrap:anywhere}
    .pc-business-history{list-style:none;padding:0;margin:0}.pc-business-history>li{border-top:1px solid #dce2e6;padding:8px 0;overflow-wrap:anywhere}
    .pc-business-history time{font-size:12px;color:#52616b}.pc-business-history .pc-business-bar{margin:4px 0}.pc-business-history dl{font-size:13px}
    .pc-business-merge-value{overflow-wrap:anywhere;white-space:pre-wrap}.pc-business-form-fields>div>.pc-business-field{margin-bottom:12px}
    .pc-business-merge-options{max-height:240px;overflow:auto;padding-left:24px}.pc-business-merge-options>li{margin:10px 0}
    @media(max-width:520px){.pc-business h2{font-size:20px}.pc-business dialog{padding:14px}.pc-business-field-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.pc-business .pc-business-bar{gap:8px}.pc-business td,.pc-business th{padding:8px}}
  `;
  return { mount };
});
