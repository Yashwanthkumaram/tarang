// Song rows (system.css .row anatomy) + one delegated binder that wires play, like,
// download and the "⋯" menu for any list of rows, and keeps playing / liked / download
// state live. Views render rows with trackRow()/resultRow() and call bindTrackList().
//
//   root.innerHTML = `<div class="list">${items.map((t, i) => trackRow(t, { index: i })).join('')}</div>`;
//   const unbind = bindTrackList(root, { items: () => items, context: { type: 'playlist', id, name } });
//   return () => unbind();   // in the view's cleanup

import { esc, fmtDuration, icon, isPhone, ring } from '../ui.js';
import { download, openTrackMenu, toggleLike } from './actions.js';
import { artHTML } from './art.js';
import { downloadFor, downloads, itemKey } from './store.js';

/** Row-level state glyph: check = on this device (plays offline), waveform = streams. */
export function stateGlyph(item) {
  if (!item || item.kind === 'voice') return '';
  return item.path || item.downloaded
    ? icon('check', 'sg sg--dl', 'Downloaded')
    : item.video_id ? icon('stream', 'sg sg--st', 'Streams') : '';
}

/** Download control for the optional Download column / result actions. */
export function downloadCell(item, { compact = false } = {}) {
  if (item.kind === 'voice') return '';
  if (item.path || item.downloaded) return `<span class="btn-dl btn-dl--done" title="Downloaded" role="img" aria-label="Downloaded">${icon('check-circle', 'icon--16')}${compact ? '' : '<span class="btn-dl__label">Downloaded</span>'}</span>`;
  if (!item.video_id) return '';
  const d = downloadFor(item);
  if (d && (d.state === 'active' || d.state === 'queued')) {
    const p = Math.round((d.progress || 0) * 100);
    return `<button class="btn btn--ghost btn--sm btn-dl is-busy" type="button" data-act="downloads" aria-label="Downloading, ${p} percent">${ring(d.progress)}${compact ? '' : `<span class="btn-dl__label num">${d.state === 'queued' ? 'Queued' : `${p}%`}</span>`}</button>`;
  }
  return `<button class="btn btn--secondary btn--sm btn-dl" type="button" data-act="download" aria-label="Download ${esc(item.title)}">${icon('download', 'icon--16')}${compact ? '' : '<span class="btn-dl__label">Download</span>'}</button>`;
}

const likeBtn = (item) => `<button class="btn btn--icon btn--sm like row__like${item.liked ? ' is-liked' : ''}" type="button" data-act="like" aria-pressed="${!!item.liked}" aria-label="${item.liked ? 'Liked' : 'Like'}">${icon('heart', 'icon--16')}</button>`;
const menuBtn = (item) => `<button class="btn btn--icon btn--sm row__menu" type="button" data-act="menu" aria-haspopup="menu" aria-label="More options for ${esc(item.title)}">${icon('more', 'icon--16')}</button>`;

/**
 * Standard song row. opts: { index (0-based, shown as index+1), dl (adds the Download column),
 * album (default true), playing, selected, cls }.
 */
export function trackRow(item, opts = {}) {
  const i = opts.index ?? 0;
  const cls = ['row', 'song', opts.dl ? 'row--dl' : '', opts.playing ? 'is-playing' : '', opts.selected ? 'is-selected' : '', opts.cls || ''].filter(Boolean).join(' ');
  const sub = [item.artist, item.kind === 'voice' ? null : null].filter(Boolean).join(' · ');
  return `<div class="${cls}" data-idx="${i}" data-key="${esc(itemKey(item))}">
    <div class="row__num">${opts.playing ? '<span class="eq" aria-label="Playing"><i></i><i></i><i></i></span>' : `<span>${i + 1}</span>`}<button class="btn btn--icon btn--sm" type="button" data-act="play" aria-label="Play ${esc(item.title)}">${icon('play', 'icon--16 icon--fill')}</button></div>
    ${artHTML(item)}
    <div class="row__main"><div class="row__title">${esc(item.title)}</div><div class="row__sub">${stateGlyph(item)}<span>${esc(sub || 'Unknown artist')}</span></div></div>
    <div class="row__album">${opts.album === false ? '' : esc(item.album || '')}</div>
    <div class="row__dur">${fmtDuration(item.duration_secs)}</div>
    ${opts.dl ? `<div class="row__dl">${downloadCell(item)}</div>` : ''}
    ${likeBtn(item)}
    ${menuBtn(item)}
  </div>`;
}

/**
 * Search-result row (.row--result): art · title/artist · duration · [play] [download] [like] [⋯].
 * opts: { index, playing }.
 */
export function resultRow(item, opts = {}) {
  const i = opts.index ?? 0;
  return `<div class="row row--result song${opts.playing ? ' is-playing' : ''}" data-idx="${i}" data-key="${esc(itemKey(item))}">
    ${artHTML(item)}
    <div class="row__main"><div class="row__title">${esc(item.title)}</div><div class="row__sub">${stateGlyph(item)}<span>${esc(item.artist || 'Unknown artist')}${item.album ? ` · ${esc(item.album)}` : ''}</span></div></div>
    <div class="row__dur">${fmtDuration(item.duration_secs)}</div>
    <div class="row__actions">
      <button class="btn btn--icon btn--sm row__play" type="button" data-act="play" aria-label="Play ${esc(item.title)}">${icon('play', 'icon--16 icon--fill')}</button>
      <span class="row__dl">${downloadCell(item, { compact: true })}</span>
      ${likeBtn(item)}
      ${menuBtn(item)}
    </div>
  </div>`;
}

/**
 * Wires a rendered list. opts:
 *   items: () => Item[]            the array the rows were rendered from (data-idx indexes it)
 *   context: { type, id?, name }   passed to player.play
 *   player                         the player (import { player } from '../player.js')
 *   menuExtra: (item, idx) => [menu items]   extra entries for the ⋯ menu (e.g. Remove from playlist)
 *   onPlay: (item, idx) => bool    return true to handle play yourself
 *   playOnRowClick: true           phone: tap a row to play; desktop: double-click
 *   rowFor: (item, idx) => html    re-renders a row in place after a change (default: keeps markup, patches state)
 * Returns an unbind function.
 */
export function bindTrackList(root, opts) {
  const { player } = opts;
  const items = () => opts.items() || [];
  const rowEl = (el) => el.closest('[data-idx]');
  const itemAt = (row) => items()[Number(row.dataset.idx)];

  function play(row) {
    const idx = Number(row.dataset.idx);
    const list = items();
    if (opts.onPlay?.(list[idx], idx)) return;
    const cur = player?.current;
    if (cur && itemKey(cur) === row.dataset.key && player.state.index >= 0) { player.toggle(); return; }
    player?.play(list, idx, opts.context || null);
  }

  const onClick = async (e) => {
    const act = e.target.closest('[data-act]');
    const row = rowEl(e.target);
    if (!row || !root.contains(row)) return;
    const item = itemAt(row);
    if (!item) return;
    if (!act) { if ((opts.playOnRowClick ?? true) && isPhone() && !e.target.closest('a, button, input, label')) play(row); return; }
    switch (act.dataset.act) {
      case 'play': e.stopPropagation(); play(row); break;
      case 'like': {
        e.stopPropagation();
        const t = await toggleLike(item);
        if (t) { Object.assign(item, { liked: t.liked, id: item.id || t.id }); patchRow(row, item); }
        break;
      }
      case 'download': e.stopPropagation(); await download(item); refreshDl(); break;
      case 'downloads': e.stopPropagation(); location.hash = '#downloads'; break;
      case 'menu': e.stopPropagation(); openTrackMenu(act, item, { player, extra: opts.menuExtra?.(item, Number(row.dataset.idx)) || [] }); break;
    }
  };
  const onDbl = (e) => { const row = rowEl(e.target); if (row && root.contains(row) && !e.target.closest('button, a, input') && !isPhone() && (opts.playOnRowClick ?? true)) play(row); };

  function patchRow(row, item) {
    if (opts.rowFor) { const fresh = document.createElement('template'); fresh.innerHTML = opts.rowFor(item, Number(row.dataset.idx)).trim(); row.replaceWith(fresh.content.firstElementChild); return; }
    const like = row.querySelector('[data-act="like"]');
    if (like) { like.classList.toggle('is-liked', !!item.liked); like.setAttribute('aria-pressed', String(!!item.liked)); like.setAttribute('aria-label', item.liked ? 'Liked' : 'Like'); }
  }

  function refreshDl() {
    root.querySelectorAll('[data-idx]').forEach((row) => {
      const cell = row.querySelector('.row__dl');
      const item = itemAt(row);
      if (!cell || !item) return;
      const compact = row.classList.contains('row--result');
      const html = downloadCell(item, { compact });
      if (cell.dataset.html !== html) { cell.dataset.html = html; cell.innerHTML = html; }
    });
  }

  function refreshPlaying() {
    const cur = player?.current;
    const key = cur ? itemKey(cur) : '';
    const playing = player?.state.playing;
    root.querySelectorAll('[data-idx]').forEach((row) => {
      const on = !!key && row.dataset.key === key;
      if (row.classList.contains('is-playing') === on && row.dataset.pp === String(playing)) return;
      row.dataset.pp = String(playing);
      row.classList.toggle('is-playing', on);
      const num = row.querySelector('.row__num');
      if (num) {
        const idx = Number(row.dataset.idx);
        const btn = num.querySelector('[data-act="play"]');
        num.firstElementChild.outerHTML = on ? '<span class="eq" aria-label="Playing"><i></i><i></i><i></i></span>' : `<span>${idx + 1}</span>`;
        if (btn) { btn.innerHTML = icon(on && playing ? 'pause' : 'play', 'icon--16 icon--fill'); btn.setAttribute('aria-label', on && playing ? 'Pause' : 'Play'); }
      }
    });
  }

  const onTrackUpdated = (e) => {
    const { before, track } = e.detail || {};
    root.querySelectorAll('[data-idx]').forEach((row) => {
      const item = itemAt(row);
      if (!item || !before) return;
      const same = (item.id && (item.id === before.id || item.id === track?.id)) || (item.video_id && item.video_id === before.video_id);
      if (same) { item.liked = track.liked; if (!item.id && track.id && !item.local_track_id) item.local_track_id = track.id; patchRow(row, item); }
    });
  };

  root.addEventListener('click', onClick);
  root.addEventListener('dblclick', onDbl);
  addEventListener('track:updated', onTrackUpdated);
  const unsubDl = downloads.subscribe(refreshDl);
  const unsubPlayer = player?.subscribe(refreshPlaying);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('dblclick', onDbl);
    removeEventListener('track:updated', onTrackUpdated);
    unsubDl(); unsubPlayer?.();
  };
}
