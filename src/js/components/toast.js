// Toasts (system.css .toast-host / .toast). Bottom-centre, above the player bar
// (desktop) or the mini player + tab bar (phone).
//
//   toast('Added to Gym 2026', { kind: 'ok', action: { label: 'Undo', run: () => … } })
//   toast('Could not play', { kind: 'danger', sub: 'File not found' })

import { esc, icon } from '../ui.js';

const KIND_ICON = { ok: 'check', danger: 'alert', info: 'info' };

/**
 * Shows a toast. Options: kind ('ok'|'danger'|'info'|null), sub (second line),
 * action { label, run }, ms (auto-dismiss, default 3200; 0 keeps it until dismissed).
 * Legacy `{ error: true }` maps to kind 'danger'. Returns { close, update(text) }.
 */
export function toast(message, opts = {}) {
  const kind = opts.kind || (opts.error ? 'danger' : null);
  const ms = opts.ms ?? (kind === 'danger' ? 5000 : 3200);
  let host = document.getElementById('toast-host');
  if (!host) { host = document.createElement('div'); host.id = 'toast-host'; host.className = 'toast-host'; document.body.appendChild(host); }
  while (host.children.length >= 3) host.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast${kind ? ' toast--' + kind : ''}`;
  el.setAttribute('role', kind === 'danger' ? 'alert' : 'status');
  el.innerHTML = `${kind ? icon(KIND_ICON[kind] || 'info') : ''}<div class="toast__text"><span class="toast__msg">${esc(message)}</span>${opts.sub ? `<span class="toast__sub">${esc(opts.sub)}</span>` : ''}</div>${opts.action ? `<button class="btn btn--sm btn--ghost" type="button">${esc(opts.action.label)}</button>` : ''}`;
  host.appendChild(el);
  let timer = null;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (opts.action) el.querySelector('button').addEventListener('click', () => { close(); opts.action.run?.(); });
  if (ms) timer = setTimeout(close, ms);
  return { close, update: (text) => { el.querySelector('.toast__msg').textContent = text; } };
}
