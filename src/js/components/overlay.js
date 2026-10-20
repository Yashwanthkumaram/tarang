// Overlays built from system.css: .scrim + .modal (dialogs), .scrim--sheet + .sheet
// (phone bottom sheets), .menu (desktop popovers; on phone every menu becomes a sheet).
// Escape, scrim click and the browser back gesture (hash change) close the top overlay.

import { esc, icon, isPhone } from '../ui.js';

const stack = [];

function mount(scrim, panel, onClose) {
  const prevFocus = document.activeElement;
  document.body.appendChild(scrim);
  const entry = {
    scrim, panel,
    close() {
      const i = stack.indexOf(entry);
      if (i < 0) return;
      stack.splice(i, 1);
      scrim.remove();
      onClose?.();
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.({ preventScroll: true });
    },
  };
  stack.push(entry);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) entry.close(); });
  requestAnimationFrame(() => (panel.querySelector('[autofocus], input, select, textarea, button:not([disabled])') || panel).focus?.({ preventScroll: true }));
  return entry;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) { e.preventDefault(); e.stopPropagation(); stack[stack.length - 1].close(); }
}, true);
window.addEventListener('hashchange', () => closeOverlays());

/** Closes every open overlay. */
export function closeOverlays() { while (stack.length) stack[stack.length - 1].close(); }

function setBody(container, body) {
  if (body == null) return;
  if (typeof body === 'string') container.insertAdjacentHTML('beforeend', body);
  else container.appendChild(body);
}

/**
 * Modal dialog. actions: [{ label, kind: 'primary'|'secondary'|'ghost'|'danger', run(close) → false keeps it open }]
 * Returns { el, close }.
 */
export function openModal({ title, text = '', body = null, actions = [], wide = false, onMount, onClose, label } = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const modal = document.createElement('div');
  modal.className = `modal${wide ? ' modal--wide' : ''}`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', label || title || 'Dialog');
  modal.tabIndex = -1;
  modal.innerHTML = `${title ? `<div class="modal__title">${esc(title)}</div>` : ''}${text ? `<div class="modal__text">${esc(text)}</div>` : ''}`;
  setBody(modal, body);
  if (actions.length) {
    const bar = document.createElement('div');
    bar.className = 'modal__actions';
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn--${a.kind || 'secondary'}`;
      b.innerHTML = `${a.icon ? icon(a.icon) : ''}${esc(a.label)}`;
      b.addEventListener('click', async () => { const keep = await a.run?.(entry.close, modal); if (keep !== false) entry.close(); });
      bar.appendChild(b);
    });
    modal.appendChild(bar);
  }
  scrim.appendChild(modal);
  const entry = mount(scrim, modal, onClose);
  onMount?.(modal, entry.close);
  return { el: modal, close: entry.close };
}

/** Phone bottom sheet. Returns { el, close }. */
export function openSheet({ title = '', sub = '', head = '', body = null, onMount, onClose, label } = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim scrim--sheet';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', label || title || 'Options');
  sheet.tabIndex = -1;
  sheet.innerHTML = `<div class="sheet__grab"></div>${title || head ? `<div class="between"><div class="grow">${title ? `<div class="sheet__title truncate">${esc(title)}</div>` : ''}${sub ? `<div class="t-13 muted truncate num">${esc(sub)}</div>` : ''}</div>${head}</div>` : ''}`;
  setBody(sheet, body);
  scrim.appendChild(sheet);
  const entry = mount(scrim, sheet, onClose);
  onMount?.(sheet, entry.close);
  return { el: sheet, close: entry.close };
}

/**
 * Anchored popover on desktop (a transparent scrim catches outside clicks); a bottom
 * sheet on phone. `body` is HTML or an Element; the popover panel gets `className`.
 */
export function openPopover(anchor, body, { className = 'menu', title = '', sub = '', onMount, onClose, label } = {}) {
  if (isPhone() || !anchor) {
    const panel = document.createElement('div');
    panel.className = className;
    setBody(panel, body);
    return openSheet({ title, sub, body: panel, onMount: (el, close) => onMount?.(panel, close), onClose, label });
  }
  const scrim = document.createElement('div');
  scrim.className = 'popover-scrim';
  const panel = document.createElement('div');
  panel.className = `${className} popover`;
  panel.setAttribute('role', 'menu');
  if (label || title) panel.setAttribute('aria-label', label || title);
  panel.tabIndex = -1;
  setBody(panel, body);
  scrim.appendChild(panel);
  const entry = mount(scrim, panel, onClose);
  place(panel, anchor);
  onMount?.(panel, entry.close);
  return { el: panel, close: entry.close };
}

function place(panel, anchor) {
  const r = anchor.getBoundingClientRect();
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  const vw = innerWidth, vh = innerHeight, gap = 4;
  let left = Math.min(Math.max(8, r.right - pw), vw - pw - 8);
  if (r.left + pw <= vw - 8 && r.right - pw < 8) left = r.left;
  let top = r.bottom + gap;
  if (top + ph > vh - 8) top = Math.max(8, r.top - ph - gap);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

/**
 * Action menu. items: [{ label, icon, hint, danger, checked, disabled, run }] | { sep: true } | { head: html }.
 * Desktop: popover under `anchor`; phone: bottom sheet titled `title`.
 */
export function openMenu(anchor, items, { title = '', sub = '', className = '', label } = {}) {
  const frag = document.createDocumentFragment();
  const handlers = [];
  items.filter(Boolean).forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu__sep'; frag.appendChild(s); return; }
    if (it.head) { const d = document.createElement('div'); d.className = 'menu__head'; d.innerHTML = it.head; frag.appendChild(d); return; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `menu__item${it.danger ? ' menu__item--danger' : ''}${it.checked ? ' is-checked' : ''}`;
    b.setAttribute('role', it.checked != null ? 'menuitemradio' : 'menuitem');
    if (it.checked != null) b.setAttribute('aria-checked', String(!!it.checked));
    b.disabled = !!it.disabled;
    b.innerHTML = `${it.icon ? icon(it.icon) : ''}<span class="grow truncate">${esc(it.label)}</span>${it.hint ? `<span class="menu__hint">${esc(it.hint)}</span>` : ''}${it.checked ? icon('check') : ''}`;
    handlers.push([b, it]);
    frag.appendChild(b);
  });
  const res = openPopover(anchor, frag, { className: `menu ${className}`, title, sub, label: label || title });
  handlers.forEach(([b, it]) => b.addEventListener('click', () => { res.close(); it.run?.(); }));
  return res;
}

/** Yes/no dialog. Resolves true when confirmed. */
export function confirmDialog({ title, text = '', confirm = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    openModal({
      title, text,
      actions: [
        { label: cancel, kind: 'ghost' },
        { label: confirm, kind: danger ? 'danger' : 'primary', run: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

/** Single text field dialog. Resolves the trimmed value, or null when cancelled. */
export function promptDialog({ title, text = '', label = '', value = '', placeholder = '', confirm = 'Save', multiline = false, extra = null }) {
  return new Promise((resolve) => {
    let result = null;
    const field = document.createElement('label');
    field.className = 'field';
    field.innerHTML = `${label ? `<span class="label">${esc(label)}</span>` : ''}<input class="input" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value)}">`;
    const input = field.querySelector('input');
    const submit = () => { const v = input.value.trim(); if (!v) { input.classList.add('is-error'); input.focus(); return false; } result = v; return true; };
    const m = openModal({
      title, text, body: field,
      actions: [{ label: 'Cancel', kind: 'ghost' }, { label: confirm, kind: 'primary', run: () => (submit() ? undefined : false) }],
      onClose: () => resolve(result),
    });
    if (extra) m.el.insertBefore(typeof extra === 'string' ? Object.assign(document.createElement('div'), { innerHTML: extra }) : extra, m.el.querySelector('.modal__actions'));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline && submit()) m.close(); });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}
