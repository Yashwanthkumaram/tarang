// Hash router + views registry. Routes look like  #name[/id][?key=value…]
//   #home  #search?q=bon%20iver  #library?tab=liked  #playlist/3  #now-playing  #onboarding
//
// Each view is a module in js/views/<name>.js, loaded on first visit, exporting
// (default export, or a named export equal to the view name):
//   {
//     title: 'Library' | (params) => string,          phone top-bar title + document title
//     render(root, params, ctx) → cleanup | Promise<cleanup>
//     css?: string                                     screen-only CSS, injected once
//     tab?, nav?, back?, trail?, shell?, topbarSearch?  override the registry defaults below
//   }
// ctx: { setTitle(text), setTrail(html | Element | null), setBack(href | null), params, route }
// Views re-render from scratch on every visit; cleanup runs before the next view renders.
// A missing or broken module renders a placeholder, so the shell always works.

import { closeOverlays } from './components/overlay.js';
import { emptyState, icon } from './ui.js';

/** Shell defaults per view. tab = phone tab kept active; nav = sidebar item; back = top-bar back link. */
export const REGISTRY = {
  home:        { title: 'Home', tab: 'home', nav: 'home', trail: 'settings' },
  search:      { title: 'Search', tab: 'search', nav: 'search', trail: 'settings', topbarSearch: false },
  library:     { title: 'Library', tab: 'library', nav: 'library', trail: 'settings' },
  playlist:    { title: 'Playlist', tab: 'library', nav: (p) => `playlist:${p.id ?? ''}`, back: '#library', trail: null },
  downloads:   { title: 'Downloads', tab: 'downloads', nav: 'downloads', trail: 'settings' },
  voice:       { title: 'Voice recordings', tab: 'library', nav: 'voice', back: '#library', trail: null },
  device:      { title: 'Scan & folders', tab: 'home', nav: 'settings', back: '#settings', trail: null },
  settings:    { title: 'Settings', tab: 'home', nav: 'settings', back: '#home', backPhoneOnly: true, trail: null },
  onboarding:  { title: 'Set up', shell: 'setup' },
  'now-playing': { title: 'Now playing', tab: null, nav: null, back: null, trail: null, nowPlaying: true },
};

const modules = new Map();
let currentCleanup = null;
let renderToken = 0;
let current = { name: null, params: {} };
let lastPage = '#home';         // last non-Now-Playing route (Now Playing collapses back to it)
let lastTab = 'home';
const listeners = new Set();
let inAppNavs = 0;              // hash changes since boot (history.back() stays inside the app when > 0)
let shell = null;               // hooks provided by app.js

/** Parses a hash into { name, params }. */
export function parse(hash = location.hash) {
  const h = String(hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const [name, ...rest] = path.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(query));
  if (rest.length) params.id = decodeURIComponent(rest.join('/'));
  return { name: name || 'home', params };
}

/** Builds a hash: href('playlist', { id: 3 }) → '#playlist/3'. */
export function href(name, params = {}) {
  const { id, ...q } = params;
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== '')).toString();
  return `#${name}${id != null && id !== '' ? `/${encodeURIComponent(id)}` : ''}${qs ? `?${qs}` : ''}`;
}

/** Navigates (adds a history entry). */
export function go(name, params = {}) {
  const target = href(name, params);
  if (location.hash === target) render(); else location.hash = target;
}
/** Re-renders the current view. */
export function refresh() { render(); }
export const currentRoute = () => ({ ...current });
export const lastPageHref = () => lastPage;
export const lastTabName = () => lastTab;
/** True when history.back() returns to a screen of this app (not the page before it). */
export const canGoBack = () => inAppNavs > 0;
/** Subscribe to route changes: fn({ name, params, meta }). */
export function onRoute(fn) { listeners.add(fn); return () => listeners.delete(fn); }

async function loadModule(name) {
  if (modules.has(name)) return modules.get(name);
  let view = null;
  try {
    const mod = await import(`./views/${name}.js`);
    view = mod.default || mod[name] || mod[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())] || mod.view || null;
    if (view && typeof view.render !== 'function') view = null;
    if (view?.css && !document.querySelector(`style[data-view-css="${name}"]`)) {
      const st = document.createElement('style');
      st.dataset.viewCss = name;
      st.textContent = view.css;
      document.head.appendChild(st);
    }
  } catch (e) {
    console.warn(`[router] view "${name}" unavailable:`, e);
  }
  view = view || placeholder(name);
  modules.set(name, view);
  return view;
}

function placeholder(name) {
  const title = REGISTRY[name]?.title || name;
  return {
    title,
    render(root) {
      root.innerHTML = `<div class="page"><div class="card">${emptyState({ icon: 'grid', title, text: `This screen is being rebuilt for v2. Everything else keeps working.`, actions: `<a class="btn btn--secondary" href="#home">${icon('home')}Go home</a>` })}</div></div>`;
    },
  };
}

async function render() {
  const token = ++renderToken;
  let { name, params } = parse();
  if (!REGISTRY[name]) { name = 'home'; params = {}; }
  const guard = shell?.guard?.(name);
  if (guard && guard !== name) { location.replace(href(guard)); return; }
  closeOverlays();
  const view = await loadModule(name);
  if (token !== renderToken) return;

  if (typeof currentCleanup === 'function') { try { currentCleanup(); } catch (e) { console.error(e); } }
  currentCleanup = null;

  const reg = REGISTRY[name];
  const pick = (k) => { const v = view[k] !== undefined ? view[k] : reg[k]; return typeof v === 'function' && k !== 'render' ? v(params) : v; };
  const meta = {
    name, params,
    title: pick('title') || reg.title,
    tab: reg.nowPlaying ? lastTab : pick('tab'),
    nav: pick('nav'),
    back: pick('back') ?? null,
    backPhoneOnly: pick('backPhoneOnly') ?? false,
    trail: pick('trail') ?? null,
    shell: pick('shell') || 'app',
    topbarSearch: pick('topbarSearch') ?? true,
    nowPlaying: !!reg.nowPlaying,
  };
  if (meta.nowPlaying) meta.back = lastPage;
  else { lastPage = location.hash || '#home'; if (meta.tab) lastTab = meta.tab; }
  current = { name, params, meta };

  const root = document.getElementById('view');
  root.innerHTML = '';
  root.className = `view view--${name}`;
  root.dataset.view = name;
  shell?.applyMeta(meta);
  listeners.forEach((fn) => { try { fn(current); } catch (e) { console.error(e); } });
  document.getElementById('main')?.scrollTo({ top: 0 });
  document.title = meta.title && name !== 'home' ? `${meta.title} · Tarang` : 'Tarang';

  const ctx = {
    route: name, params,
    setTitle: (t) => shell?.setTitle(t),
    setTrail: (x) => shell?.setTrail(x),
    setBack: (h) => shell?.setBack(h),
  };
  try {
    const cleanup = await view.render(root, params, ctx);
    if (token !== renderToken) { if (typeof cleanup === 'function') cleanup(); return; }
    currentCleanup = cleanup;
  } catch (e) {
    console.error(e);
    if (token === renderToken) root.innerHTML = `<div class="page"><div class="card">${emptyState({ icon: 'alert', error: true, title: 'This screen hit an error', text: e?.message || String(e), actions: `<button class="btn btn--secondary" type="button" onclick="location.reload()">${icon('refresh')}Reload</button>` })}</div></div>`;
  }
}

/**
 * Starts routing. hooks (from app.js): { applyMeta(meta), setTitle, setTrail, setBack,
 * guard(name) → redirect view name or null }.
 */
export function initRouter(hooks) {
  shell = hooks;
  addEventListener('hashchange', () => { inAppNavs++; render(); });
  render();
}

