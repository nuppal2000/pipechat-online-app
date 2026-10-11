(function(root, factory) {
  const actions = typeof module === 'object' && module.exports ? require('./business-actions') : root.PipeChatBusinessActions;
  const api = factory(actions);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PipeChatWorkflowUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Actions) {
  'use strict';
  const esc = Actions.escapeHtml;
  const copy = value => JSON.parse(JSON.stringify(value));
  const reason = value => ({ task_created: 'Task created', inactive: 'Workflow not active', before_activation: 'Before activation',
    trigger_not_matched: 'Trigger not matched', record_missing: 'Record unavailable', record_no_longer_matches: 'Record changed',
    open_task_exists: 'Qualifying open task exists', schema_changed: 'Trigger field changed', task_id_conflict: 'Task ID conflict',
    board_capacity: 'Task board is full', due_date_out_of_range: 'Due date out of range' })[value] || String(value || '');
  const date = value => value ? new Date(value).toLocaleString() : '';

  function review(proposal, { saving = false, error = '', attempted = false, refresh = false } = {}) {
    const p = proposal.preview, operation = proposal.operation;
    const label = operation === 'create' ? 'Save draft' : operation === 'activation' ? proposal.action.active ? 'Activate workflow' : 'Pause workflow' : 'Confirm retry';
    return `<style>${styles}</style><section class="workflow-review"><h3>${esc(p.title)}</h3>
      <dl><dt>Trigger</dt><dd>${esc(p.trigger)}</dd><dt>Condition</dt><dd>${esc(p.condition)}</dd>
      <dt>Task</dt><dd>${esc(p.task.nextAction)}</dd>${p.task.notes ? `<dt>Notes</dt><dd>${esc(p.task.notes)}</dd>` : ''}
      <dt>Due</dt><dd>${esc(p.due)}</dd><dt>Status</dt><dd>${esc(operation === 'create' ? 'Draft' : operation === 'activation' ? `${p.previousStatus} to ${proposal.action.active ? 'active' : 'paused'}` : p.status)}</dd></dl>
      ${operation === 'retry' ? `<p>Record #${esc(p.event.recordId)} / ${esc(p.event.from ?? 'Not set')} to ${esc(p.event.to)}</p>
      <p>Event: ${esc(p.event.occurredAt)} / ${esc(reason(p.reason))} / ${esc(p.attempts)} attempts</p>
      ${p.status !== 'active' ? '<p class="error">This workflow is not active. Retrying will skip and consume this event.</p>' : ''}` : ''}
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
      <div class="proposal-actions"><button class="primary" data-confirm ${saving || refresh ? 'disabled' : ''}>${saving ? 'Saving...' : attempted && error && !refresh ? 'Retry same save' : label}</button>
      ${refresh ? `<button class="secondary" id="workflowReviewRefresh" ${saving ? 'disabled' : ''}>Refresh and review</button>` : ''}
      <button class="secondary" data-cancel ${saving ? 'disabled' : ''}>Cancel</button></div></section>`;
  }

  function create({ element, S, api, icon = () => '', prepare, retry, refreshWorkspace, onError = () => {} }) {
    let snapshot = null, histories = new Map(), loading = false, error = '', epoch = 0;
    let owner = S.user?.id, generation = S.generation;
    const locked = () => loading || S.saving || S.busy || S.pending || S.failedEdit || S.resetting;
    const current = (ticket, user, gen) => ticket === epoch && S.user?.id === user && S.generation === gen;
    function clear() { epoch++; snapshot = null; histories = new Map(); loading = false; error = ''; element.innerHTML = ''; }
    function setSnapshot(value) {
      if (!Array.isArray(value?.workflows) || !(value.updatedAt === null || typeof value.updatedAt === 'string')) throw new Error('Invalid workflow list.');
      for (const w of value.workflows) {
        if (!Actions.workflowId(w.id) || !['draft', 'active', 'paused'].includes(w.status) ||
          !Number.isSafeInteger(w.revision) || w.revision < 1 || !Array.isArray(w.history) || !Array.isArray(w.executions)) throw new Error('Invalid saved workflow.');
        Actions.validateWorkflowSpec(w.spec);
      }
      snapshot = copy(value); histories = new Map(); owner = S.user?.id; generation = S.generation; error = ''; draw();
    }
    function historyMarkup(w) {
      const h = histories.get(w.id); if (!h) return '';
      return `<section class="wf-history" aria-label="${esc(w.spec.name)} history"><h4>Saved history</h4>
        ${h.history.length ? h.history.map(entry => `<div class="wf-history-row"><time>${esc(date(entry.at))}</time><span>${esc(entry.type === 'execution' ? reason(entry.reason) : entry.type === 'trigger_renamed' ? `Trigger renamed: ${entry.change.from} to ${entry.change.to}` : entry.type)}</span><span>${esc(entry.status)}${entry.attempt ? ' / attempt ' + esc(entry.attempt) : ''}</span></div>`).join('') : '<p>No executions yet.</p>'}
        ${h.executions.filter(e => e.status === 'failed').map(e => `<div class="wf-failure"><span>Record #${esc(e.event.recordId)} / ${esc(reason(e.reason))}</span>
          <button type="button" class="secondary" data-wf-retry="${esc(w.id)}" data-event="${esc(e.event.eventId)}" ${locked() ? 'disabled' : ''}>${icon('RotateCcw')}Review retry</button></div>`).join('')}
        ${h.history.length >= 50 && h.history.length < 200 ? `<button type="button" class="secondary" data-wf-history="${esc(w.id)}" data-limit="200">Older history</button>` : ''}</section>`;
    }
    function draw() {
      if (owner !== S.user?.id || generation !== S.generation) { clear(); return; }
      const stale = snapshot && snapshot.updatedAt !== S.updatedAt;
      element.innerHTML = `<style>${styles}</style><div class="wf-toolbar"><h2>Workflows</h2><button type="button" class="icon-btn" data-wf-refresh title="Refresh workflows" aria-label="Refresh workflows" ${loading || S.saving ? 'disabled' : ''}>${icon('RotateCcw')}</button></div>
        ${loading ? '<p role="status">Loading workflows...</p>' : ''}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
        ${stale ? `<p class="wf-stale">The workspace has changed. <button type="button" class="secondary" data-wf-workspace ${locked() ? 'disabled' : ''}>Refresh workspace</button></p>` : ''}
        ${snapshot?.workflows.length ? snapshot.workflows.map(w => `<article class="wf-row"><div class="wf-summary"><h3>${esc(w.spec.name)}</h3>
          <p>${esc(w.spec.trigger.field)} changes to ${esc(w.spec.trigger.to)}</p><p>${esc(w.spec.action.nextAction)}</p>
          <p>Event date + ${esc(w.spec.action.due.offsetDays)} days / ${esc(w.spec.timezone)}</p></div>
          <div class="wf-controls"><span class="wf-status wf-${esc(w.status)}">${esc(w.status)}</span>
          <label class="wf-toggle"><input type="checkbox" role="switch" data-wf-activation="${esc(w.id)}" aria-label="Activate ${esc(w.spec.name)}" ${w.status === 'active' ? 'checked' : ''} ${locked() || stale ? 'disabled' : ''}>Active</label>
          <button type="button" class="icon-btn" data-wf-history="${esc(w.id)}" title="View saved history" aria-label="History for ${esc(w.spec.name)}" ${loading ? 'disabled' : ''}>${icon('Eye')}</button></div>${historyMarkup(w)}</article>`).join('') : !loading && !error ? '<p>No saved workflows.</p>' : ''}`;
    }
    async function load() {
      const ticket = ++epoch, user = S.user?.id, gen = S.generation;
      owner = user; generation = gen; snapshot = null; histories = new Map(); error = ''; loading = true; draw();
      try {
        const result = await api('/api/workflows');
        if (current(ticket, user, gen)) { loading = false; setSnapshot(result); return result; }
      } catch (e) { if (current(ticket, user, gen)) error = e.message; }
      finally { if (current(ticket, user, gen)) { loading = false; draw(); } }
      return null;
    }
    async function history(id, limit = 50) {
      const ticket = epoch, user = S.user?.id, gen = S.generation;
      if (!snapshot?.workflows.some(w => w.id === id)) throw new Error('Workflow unavailable. Refresh workflows.');
      const result = await api('/api/workflows/history?workflowId=' + encodeURIComponent(id) + '&limit=' + limit);
      if (!current(ticket, user, gen)) return;
      if (result.workflowId !== id || !Array.isArray(result.history) || !Array.isArray(result.executions)) throw new Error('Invalid saved history.');
      histories.set(id, result); draw(); return result;
    }
    async function click(event) {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      try {
        if (button.hasAttribute('data-wf-refresh')) return await load();
        if (button.hasAttribute('data-wf-workspace')) { if (!locked()) { await refreshWorkspace(); await load(); } return; }
        if (button.dataset.wfHistory) return await history(button.dataset.wfHistory, Number(button.dataset.limit || 50));
        if (button.dataset.wfRetry && !locked()) return await retry(button.dataset.wfRetry, button.dataset.event);
      } catch (e) { error = e.message; draw(); onError(e); }
    }
    async function change(event) {
      const input = event.target, id = input.dataset.wfActivation; if (!id) return;
      const w = snapshot?.workflows.find(w => w.id === id); if (!w) return;
      const active = input.checked; input.checked = w.status === 'active';
      if (locked()) return;
      try { await prepare({ action: 'set_workflow_activation', workflowId: id, active }); draw(); }
      catch (e) { error = e.message; draw(); onError(e); }
    }
    element.addEventListener('click', click); element.addEventListener('change', change);
    return { load, history, setSnapshot, draw, clear, getSnapshot: () => snapshot && copy(snapshot),
      destroy() { clear(); element.removeEventListener('click', click); element.removeEventListener('change', change); } };
  }
  const styles = `.wf-toolbar,.wf-controls,.wf-failure{display:flex;align-items:center;gap:12px;justify-content:space-between}.wf-toolbar{padding:12px 0}.wf-toolbar h2{font-size:18px;margin:0}.wf-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;border-bottom:1px solid #d7ddd9;padding:18px 0;overflow-wrap:anywhere}.wf-row h3{font-size:15px;margin:0 0 8px}.wf-row p{margin:5px 0;font-size:13px}.wf-controls{align-self:start;flex-wrap:wrap;justify-content:flex-end}.wf-controls svg,.wf-failure svg{width:16px;height:16px}.wf-toggle{display:flex;align-items:center;gap:6px;font-size:13px}.wf-toggle input{width:18px;height:18px;min-height:18px;margin:0}.wf-status{text-transform:capitalize;font-size:12px;font-weight:600}.wf-active{color:#187549}.wf-paused{color:#825912}.wf-draft{color:#51595f}.wf-history{grid-column:1/-1;min-width:0}.wf-history h4{margin:4px 0 10px;font-size:13px}.wf-history-row{display:grid;grid-template-columns:minmax(130px,1fr) minmax(0,2fr) minmax(80px,1fr);gap:12px;font-size:12px;padding:8px 0;border-top:1px solid #e8ece9}.wf-failure{margin-top:10px;font-size:13px}.workflow-review dl{margin:0}.workflow-review dt{font-size:12px;color:#5b6660;margin-top:12px}.workflow-review dd{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}.workflow-review h3{font-size:16px;overflow-wrap:anywhere}@media(max-width:700px){.wf-row{grid-template-columns:minmax(0,1fr)}.wf-controls{justify-content:flex-start}.wf-history-row{grid-template-columns:minmax(0,1fr);gap:4px}.wf-failure{align-items:flex-start;flex-wrap:wrap}}`;
  return { create, review, reason };
});
