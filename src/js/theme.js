// Theme switching. system.css defines tokens for :root (light) and :root[data-theme="dark"];
// this module resolves the "system" preference to one of them, follows OS changes, and
// persists the choice to settings (ui.theme) and localStorage (so index.html can paint the
// right theme before any module loads).

import { api } from './api.js';

const KEY = 'ui.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
let preference = 'system';

function apply() {
  const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  const page = getComputedStyle(document.documentElement).getPropertyValue('--page').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', page);
  dispatchEvent(new CustomEvent('theme:changed', { detail: { preference, resolved } }));
}

/** 'light' | 'dark' | 'system' */
export function currentTheme() { return preference; }
/** 'light' | 'dark' (what is on screen) */
export function resolvedTheme() { return document.documentElement.dataset.theme; }

export async function setTheme(value, { persist = true } = {}) {
  preference = ['light', 'dark', 'system'].includes(value) ? value : 'system';
  apply();
  try { localStorage.setItem(KEY, preference); } catch {}
  if (persist) api.setSetting(KEY, preference).catch(() => {});
}

export function initTheme(settingsValue) {
  let v = settingsValue;
  if (!v) { try { v = localStorage.getItem(KEY); } catch {} }
  // ?theme=dark|light overrides for review screenshots (same switch as the design files).
  let q = null;
  try { q = new URLSearchParams(location.search).get('theme'); } catch {}
  preference = ['light', 'dark', 'system'].includes(q || v) ? (q || v) : 'system';
  if (!q) { try { localStorage.setItem(KEY, preference); } catch {} }
  apply();
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
}
