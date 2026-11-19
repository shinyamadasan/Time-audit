// sop-ui.js — My Day "execution task" view over SOP-linked Execution V1 (sop-model.js / sop-repository.js).
//
// A My Day plan item linked to an SOP shows its run (progress + next step) and opens a checklist.
// Unlinked plan items render exactly as before: every hook here returns '' for them.
// Never writes plan items: completing the task stays the row's existing done/doneAt checkbox.
// No timer, Focus, accounting, sync or Firebase involvement. Device-local, room-scoped storage only.
import { createSop, upsertSop, deleteSop, linkSop, unlinkSop, setStepChecked, sopRunView } from './sop-model.js';
import { createSopRepository } from './sop-repository.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** Pure: the one-line run summary for a linked item, or null. Exported for node tests. */
export function runSummary(view) {
  if (!view) return null;
  return `SOP ${view.done}/${view.total} · ${view.complete ? 'All steps done' : `Next: ${view.nextStep.text}`}`;
}

/** Pure: My Day plan tasks that can be offered for linking (not done, not already linked). */
export function linkableTasks(tasks, state) {
  return tasks.filter(task => !task.done && !state.links[task.itemId]);
}

const randomId = () => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return (uuid ? uuid.replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24);
};

export function createSopUi({ repository = createSopRepository(), root = () => document.getElementById('sop-execution'), refreshMyDay = () => globalThis.refreshMyDayTimeline?.() } = {}) {
  let tasks = [];          // [{ itemId, dayId, title, done }] from the rendered My Day
  let tasksLoaded = false; // My Day has handed over its rows at least once
  let editable = false;
  let openItemId = null;
  let error = '';
  let panelOpen = false; // the section is a closed <details> unless the user opens it or opens a run

  const read = () => { try { return repository.read(); } catch (e) { error = e.message; return null; } };
  const change = fn => {
    try { repository.update(fn); error = ''; } catch (e) { error = e.message; }
    render(); refreshMyDay();
  };

  function badgeHtml(itemId) {
    const state = read();
    const summary = state && runSummary(sopRunView(state, itemId));
    if (!summary) return '';
    return `<div class="sop-badge">${escape(summary)} <button type="button" class="btn sm ghost" data-sop-open="${escape(itemId)}">Open SOP</button></div>`;
  }

  // Every panel render also refreshes My Day's "Today's work" tile (read-only).
  function render() { renderPanel(); globalThis.DailyCommandCenter?.refreshWork?.(); }
  function renderPanel() {
    const el = root();
    if (!el) return;
    const state = read();
    if (!state) { el.innerHTML = `<details class="sop-panel" open><summary>Procedures (SOPs)</summary><p class="routine-error" role="alert">${escape(error)}</p></details>`; return; }
    let html = '';
    const open = openItemId && sopRunView(state, openItemId);
    if (open) {
      const task = tasks.find(t => t.itemId === openItemId);
      html += `<div class="sop-run" data-sop-run="${escape(openItemId)}"><strong>${escape(task?.title || 'Task')}</strong> · ${escape(open.title)} · ${open.done}/${open.total}`
        + `<ol>${open.steps.map(step => `<li><label><input type="checkbox" data-sop-step="${escape(step.id)}"${step.done ? ' checked' : ''}> ${escape(step.text)}</label></li>`).join('')}</ol>`
        + `<p class="routine-meta">${open.complete ? 'All steps done. ' : ''}Mark the task done with its own checkbox in My Day; SOP steps never complete it.</p>`
        + (editable ? `<button type="button" class="btn sm ghost" data-sop-unlink="${escape(openItemId)}">Unlink SOP</button> ` : '')
        + '<button type="button" class="btn sm ghost" data-sop-close>Close</button></div>';
    }
    const offer = editable ? linkableTasks(tasks, state) : [];
    if (offer.length && state.sops.length) {
      html += `<form class="sop-link-form"><label>Task <select name="itemId">${offer.map(t => `<option value="${escape(t.itemId)}">${escape(t.title)}</option>`).join('')}</select></label>`
        + ` <label>SOP <select name="sopId">${state.sops.map(s => `<option value="${escape(s.id)}">${escape(s.title)}</option>`).join('')}</select></label>`
        + ' <button type="submit" class="btn sm">Link SOP</button></form>';
    }
    html += '<details class="sop-new"><summary>New SOP</summary><form class="sop-create-form">'
      + '<label>Title <input name="sop-title" maxlength="200" required></label>'
      + '<label>Steps (one per line) <textarea name="steps" rows="4" required></textarea></label>'
      + '<button type="submit" class="btn sm">Save SOP</button></form></details>';
    if (state.sops.length) {
      html += `<details class="sop-list"><summary>All SOPs (${state.sops.length})</summary><ul>${state.sops.map(s => `<li>${escape(s.title)} · ${s.steps.length} steps <button type="button" class="btn sm ghost" data-sop-delete="${escape(s.id)}">Delete</button></li>`).join('')}</ul></details>`;
    }
    if (error) html += `<p class="routine-error" role="alert">${escape(error)}</p>`;
    const linked = Object.keys(state.links).length;
    el.innerHTML = `<details class="sop-panel"${panelOpen || open || error ? ' open' : ''}><summary>Procedures (SOPs)${linked ? ` · ${linked} linked` : ''}</summary>${html}</details>`;
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const openBtn = target.closest('[data-sop-open]');
    if (openBtn) { event.preventDefault(); openItemId = openBtn.dataset.sopOpen; panelOpen = true; error = ''; render(); root()?.scrollIntoView?.({ block: 'nearest' }); return; }
    if (!root()?.contains(target)) return;
    const summary = target.closest('summary');
    if (summary && summary.parentElement?.classList.contains('sop-panel')) { panelOpen = !summary.parentElement.open; if (!panelOpen) openItemId = null; return; }
    if (target.closest('[data-sop-close]')) { openItemId = null; render(); return; }
    const unlink = target.closest('[data-sop-unlink]');
    if (unlink && editable) { const id = unlink.dataset.sopUnlink; openItemId = null; change(s => unlinkSop(s, id)); return; }
    const del = target.closest('[data-sop-delete]');
    if (del && globalThis.confirm?.('Delete this SOP? Tasks linked to it are unlinked; the tasks themselves are kept.') !== false) {
      const id = del.dataset.sopDelete; change(s => deleteSop(s, id));
    }
  }
  function onChange(event) {
    const box = event.target;
    if (!(box instanceof Element) || !box.matches('[data-sop-step]') || !openItemId || !root()?.contains(box)) return;
    const itemId = openItemId;
    change(s => setStepChecked(s, itemId, box.dataset.sopStep, box.checked));
  }
  function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof Element) || !root()?.contains(form)) return;
    event.preventDefault();
    const data = new FormData(form);
    if (form.classList.contains('sop-create-form')) {
      try {
        const sop = createSop(String(data.get('sop-title') || ''), String(data.get('steps') || '').split('\n'), { randomId });
        change(s => upsertSop(s, sop));
      } catch (e) { error = e.message; render(); }
    } else if (form.classList.contains('sop-link-form') && editable) {
      const itemId = String(data.get('itemId') || ''), sopId = String(data.get('sopId') || '');
      if (!tasks.some(t => t.itemId === itemId)) { error = 'That task is no longer on this My Day.'; render(); return; }
      openItemId = itemId;
      change(s => linkSop(s, itemId, sopId));
    }
  }

  return {
    badgeHtml,
    render,
    /** My Day Command Center V1: read-only counts over today's My Day tasks; null until My Day has rendered or SOP storage is unreadable. */
    summary() {
      if (!tasksLoaded) return null;
      const state = read();
      if (!state) return null;
      const runs = tasks.map(t => sopRunView(state, t.itemId)).filter(Boolean);
      return { tasks: { total: tasks.length, done: tasks.filter(t => t.done).length }, sop: { linked: runs.length, complete: runs.filter(r => r.complete).length } };
    },
    /** Called by index.html each time My Day's plan rows are rendered. */
    setMyDayTasks(rows, isEditable) {
      tasks = (Array.isArray(rows) ? rows : []).filter(row => row && row.itemId && row.sourceType !== 'commitment')
        .map(row => ({ itemId: String(row.itemId), dayId: String(row.dayId || ''), title: String(row.title || ''), done: !!row.done }));
      editable = !!isEditable;
      tasksLoaded = true;
      if (openItemId && !tasks.some(t => t.itemId === openItemId)) openItemId = null;
      render();
    },
    open(itemId) { openItemId = itemId; render(); },
    /** Today's work > Show: open the (closed by default) panel, keeping any open run, and bring it into view. */
    reveal() { panelOpen = true; render(); root()?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); },
    attach(doc = document) {
      doc.addEventListener('click', onClick);
      doc.addEventListener('change', onChange);
      doc.addEventListener('submit', onSubmit);
    }
  };
}

if (typeof document !== 'undefined' && !globalThis.SopUI) {
  const ui = createSopUi();
  ui.attach();
  globalThis.SopUI = ui;
  ui.render();
  globalThis.refreshMyDayTimeline?.();
}
