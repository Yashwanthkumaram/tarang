// Quick-search palette. Opened by Ctrl+K, by focusing the desktop top-bar search field,
// or by the `ui://quick-search` event the shell emits when launched with --quick-search
// (Super+M on the desktop, D19). Library songs play instantly; the last row opens the
// Search screen (YouTube Music + library) with the query filled in.

import { api, listen } from '../api.js';
import { player } from '../player.js';
import { debounce, esc, fmtDuration, icon } from '../ui.js';
import { artHTML } from './art.js';
import { openModal } from './overlay.js';
import { stateGlyph } from './tracks.js';

let open = null;

export function openQuickSearch(initial = '') {
  if (open) { open.input.focus(); return; }
  let items = [], selected = 0;
  const body = document.createElement('div');
  body.className = 'qs';
  body.innerHTML = `
    <div class="search search--lg">${icon('search')}<input class="search__input" placeholder="Search your library or YouTube Music" aria-label="Quick search" autocomplete="off" value="${esc(initial)}"><span class="search__kbd">Esc</span></div>
    <div class="qs__list list" role="listbox" aria-label="Results"></div>
    <div class="qs__foot t-12 faint"><span><span class="kbd">↑</span> <span class="kbd">↓</span> to move</span><span><span class="kbd">Enter</span> to play</span></div>`;
  const input = body.querySelector('input');
  const list = body.querySelector('.qs__list');

  const render = (q) => {
    if (!items.length) { list.innerHTML = `<div class="qs__empty t-13 muted">${q ? 'No songs in your library match — try YouTube Music.' : 'Type to search'}</div>`; return; }
    list.innerHTML = items.map((it, i) => it.kind === 'track'
      ? `<div class="qs__row${i === selected ? ' is-active' : ''}" role="option" aria-selected="${i === selected}" data-i="${i}">${artHTML(it.track)}<div class="row__main"><div class="row__title">${esc(it.track.title)}</div><div class="row__sub">${stateGlyph(it.track)}<span>${esc(it.track.artist || 'Unknown artist')}${it.track.album ? ` · ${esc(it.track.album)}` : ''}</span></div></div><span class="t-13 muted num">${fmtDuration(it.track.duration_secs)}</span></div>`
      : `<div class="qs__row${i === selected ? ' is-active' : ''}" role="option" aria-selected="${i === selected}" data-i="${i}"><span class="src-mark src-mark--ytm">${icon('search')}</span><div class="row__main"><div class="row__title">${esc(it.label)}</div><div class="row__sub"><span>Songs, albums and artists · stream or download</span></div></div><span class="t-12 faint">Enter</span></div>`).join('');
  };
  const refresh = async (q) => {
    const tracks = await api.tracks('music', { query: q || null, limit: q ? 8 : 6, sort: 'recent' }).catch(() => []);
    if (input.value.trim() !== q) return;
    items = tracks.map((t) => ({ kind: 'track', track: t, tracks }));
    if (q) items.push({ kind: 'search', label: `Search YouTube Music for “${q}”`, q });
    selected = 0;
    render(q);
  };
  const select = (i) => {
    if (!items.length) return;
    selected = (i + items.length) % items.length;
    list.querySelectorAll('.qs__row').forEach((r, k) => { r.classList.toggle('is-active', k === selected); r.setAttribute('aria-selected', String(k === selected)); });
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  };
  const activate = (i) => {
    const it = items[i];
    if (!it) { const q = input.value.trim(); if (q) { m.close(); location.hash = `#search?q=${encodeURIComponent(q)}`; } return; }
    m.close();
    if (it.kind === 'track') player.play(it.tracks, it.tracks.indexOf(it.track), { type: 'search', name: 'Your library' });
    else location.hash = `#search?q=${encodeURIComponent(it.q)}`;
  };

  const m = openModal({ body, wide: true, label: 'Quick search', onClose: () => { open = null; } });
  m.el.classList.add('qs-modal');
  m.el.parentElement.classList.add('qs-scrim');
  open = { input, close: m.close };
  const deb = debounce(() => refresh(input.value.trim()), 120);
  input.addEventListener('input', deb);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(selected); }
  });
  list.addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) activate(Number(r.dataset.i)); });
  list.addEventListener('mousemove', (e) => { const r = e.target.closest('[data-i]'); if (r && Number(r.dataset.i) !== selected) select(Number(r.dataset.i)); });
  requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  refresh(initial.trim());
}

export async function initQuickSearch() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openQuickSearch(); }
  });
  await listen('ui://quick-search', () => openQuickSearch());
}
