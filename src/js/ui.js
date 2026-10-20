// Small DOM and formatting helpers shared by every view. Markup follows
// design/system.css class names; nothing here hard-codes a colour or size.

export { toast } from './components/toast.js';
export { openModal, openSheet, openMenu, confirmDialog, promptDialog, closeOverlays } from './components/overlay.js';
import { toast } from './components/toast.js';

/** Escapes text for safe interpolation into HTML strings. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Inline SVG icon from the sprite in index.html: icon('heart'), icon('play', 'icon--16 icon--fill'). */
export const icon = (name, cls = '', label = '') => label
  ? `<svg class="icon ${cls}" role="img" aria-label="${esc(label)}"><use href="#i-${name}"/></svg>`
  : `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Event delegation: on(root, 'click', '[data-act]', (e, el) => …). Returns an unsubscribe function. */
export function on(root, event, selector, handler, opts) {
  const fn = (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  };
  root.addEventListener(event, fn, opts);
  return () => root.removeEventListener(event, fn, opts);
}

/** Builds an element from an HTML string (first element). */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---- Formatting ----
/** 3:58 · 1:02:07 */
export function fmtDuration(secs) {
  if (secs == null || !isFinite(secs)) return '--:--';
  secs = Math.max(0, Math.floor(secs));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
/** Negative remaining time: -2:34 */
export const fmtRemaining = (pos, dur) => (dur ? `-${fmtDuration(Math.max(0, dur - pos))}` : '--:--');

/** 1 h 24 min · 38 min · 45 s */
export function fmtLongDuration(secs) {
  secs = Math.max(0, Math.round(secs || 0));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  if (m) return `${m} min`;
  return `${secs} s`;
}

export function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
  return `${b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}
export const fmtSpeed = (bps) => `${fmtBytes(bps)}/s`;
/** ETA in the compact form used by the download pill: 1:40 */
export const fmtEta = (secs) => (secs == null ? '' : fmtDuration(secs));

export function fmtAgo(unix) {
  if (!unix) return 'never';
  const d = Math.floor(Date.now() / 1000 - unix);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 2) return 'yesterday';
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} days ago`;
  return new Date(unix * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
/** 23:05 (local clock time) */
export const fmtClock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
export const pct = (x) => `${Math.round((x || 0) * 100)}%`;
export const plural = (n, one, many = one + 's') => `${fmtNum(n)} ${n === 1 ? one : many}`;

/** Greeting for the Home title: Good morning / afternoon / evening. */
export function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ---- Markup snippets (system.css components) ----

/** Empty state: emptyState({ icon, title, text, actions: '<button …>' , compact, error }) */
export function emptyState({ icon: ic = 'music', title, text = '', actions = '', compact = false, error = false }) {
  return `<div class="empty${compact ? ' empty--compact' : ''}${error ? ' empty--error' : ''}">
    <div class="empty__icon">${icon(ic)}</div>
    <div class="empty__title">${esc(title)}</div>
    ${text ? `<div class="empty__text">${esc(text)}</div>` : ''}
    ${actions ? `<div class="empty__actions">${actions}</div>` : ''}
  </div>`;
}

/** Inline banner: banner({ kind: info|warn|danger|ok, icon, title, text, action: '<button…>' }) */
export function banner({ kind = 'info', icon: ic = 'info', title, text = '', action = '' }) {
  return `<div class="banner banner--${kind}">${icon(ic)}<div class="banner__body"><div class="banner__title">${esc(title)}</div>${text ? `<div class="banner__text">${esc(text)}</div>` : ''}</div>${action}</div>`;
}

/** Loading skeleton rows (song list). */
export const skeletonRows = (n = 6) => Array.from({ length: n }, (_, i) => `<div class="skel-row" aria-hidden="true"><i class="skel skel--art"></i><div class="stack"><i class="skel skel--text ${i % 2 ? 'w-80' : 'w-40'}"></i><i class="skel skel--text w-40"></i></div><i class="skel skel--text w-100"></i></div>`).join('');

/** Progress bar with numbers. */
export const progressBar = (p, cls = '') => `<div class="progress ${cls}" style="--p:${Math.round((p || 0) * 100)}%"><i></i></div>`;

/** Progress ring (0..1). */
export const ring = (p, cls = 'ring--sm') => `<span class="ring-wrap"><svg class="ring ${cls}" viewBox="0 0 36 36" aria-hidden="true"><circle class="ring__bg" cx="18" cy="18" r="15.5"/><circle class="ring__fg" cx="18" cy="18" r="15.5" pathLength="100" style="--p:${Math.round((p || 0) * 100)}"/></svg></span>`;

/** Deterministic waveform bars: <div class="wave …">…</div> (same generator as the designs). */
export function waveform({ bars = 48, seed = 1, played = 0, cls = '' } = {}) {
  let s = seed * 9301 + 49297;
  const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  let out = '';
  for (let i = 0; i < bars; i++) {
    const env = 0.35 + 0.65 * Math.abs(Math.sin((i / bars) * Math.PI * 2.3 + r()));
    const hgt = Math.round(18 + 82 * env * (0.55 + 0.45 * r()));
    out += `<i style="--h:${hgt}%"${(i / bars) * 100 < played ? ' class="is-played"' : ''}></i>`;
  }
  return `<div class="wave ${cls}" style="--p:${played}%">${out}</div>`;
}

/** Stable small integer from a string (artwork palettes, waveform seeds). */
export function hashStr(s) {
  let h = 2166136261;
  for (const c of String(s || '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Runs an async action; shows failures as a danger toast and success (optional) as an ok toast. */
export async function guard(fn, okMessage) {
  try {
    const r = await fn();
    if (okMessage) toast(okMessage, { kind: 'ok' });
    return r;
  } catch (e) {
    toast(e?.message || String(e), { kind: 'danger', ms: 5000 });
    return undefined;
  }
}

/** True when the phone layout (≤ 820 px, system.css breakpoint) is active. */
export const isPhone = () => matchMedia('(max-width: 820px)').matches;

/** Debounce helper. */
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
