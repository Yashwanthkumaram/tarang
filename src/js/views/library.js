// Library (design/screens/library.html): Playlists · Liked · Downloads · Albums · Artists · Device.
// Route: #library[?tab=liked|downloads|albums|artists|device][&q=search text]
//
// Data: one list_tracks('music') call feeds every song tab (filtered/sorted here so tab counts
// are exact and switching tabs is instant), list_recent feeds "Recently played", list_playlists
// + get_playlist feed the cards (cover mosaic from the first four songs), list_albums /
// list_artists the tiles, list_folder_rules + last_scan + scan://progress the Device pane.
// Song rows use the design's Library anatomy (select box, download-state indicator in the
// subtitle on desktop and in its own 44 px column on phone) and are wired by bindTrackList.

import { api, listen } from '../api.js';
import { createPlaylistDialog, download, openPlaylistPicker, toggleLike } from '../components/actions.js';
import { artHTML, mosaicCellHTML } from '../components/art.js';
import { downloadFor, downloads, itemKey, online, playlists as plStore, pokeDownloads } from '../components/store.js';
import { bindTrackList } from '../components/tracks.js';
import { player } from '../player.js';
import { banner, confirmDialog, debounce, emptyState, esc, fmtAgo, fmtBytes, fmtDuration, fmtNum, guard, icon, isPhone, openMenu, plural, toast } from '../ui.js';

const TABS = [
  ['playlists', 'Playlists'], ['liked', 'Liked'], ['downloads', 'Downloads'],
  ['albums', 'Albums'], ['artists', 'Artists'], ['device', 'Device'],
];
const PAGE = 100;

/** "2 h 51 m" (cards, toolbars) */
function hm(secs) {
  secs = Math.round(secs || 0);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h ? `${h} h ${m} m` : `${m} min`;
}

// ---- Sorting -------------------------------------------------------------------
const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
const SORTS = {
  played:   { label: 'Last played', short: 'Played', fn: (a, b) => (b.last_played_at || 0) - (a.last_played_at || 0) },
  added:    { label: 'Recently added', short: 'Added', fn: (a, b) => (b.added_at || 0) - (a.added_at || 0) },
  liked:    { label: 'Recently liked', short: 'Recent', fn: (a, b) => (b.added_at || 0) - (a.added_at || 0) },
  dl:       { label: 'Recently downloaded', short: 'Recent', fn: (a, b) => (b.modified_at || 0) - (a.modified_at || 0) },
  title:    { label: 'Title', short: 'Title', fn: (a, b) => cmp(a.title, b.title) },
  artist:   { label: 'Artist', short: 'Artist', fn: (a, b) => cmp(a.artist, b.artist) || cmp(a.album, b.album) },
  album:    { label: 'Album', short: 'Album', fn: (a, b) => cmp(a.album, b.album) || cmp(a.title, b.title) },
  duration: { label: 'Duration', short: 'Length', fn: (a, b) => (a.duration_secs || 0) - (b.duration_secs || 0) },
  size:     { label: 'Size', short: 'Size', fn: (a, b) => (b.size_bytes || 0) - (a.size_bytes || 0) },
  folder:   { label: 'Folder', short: 'Folder', fn: (a, b) => cmp(a.path, b.path) },
};
const TAB_SORTS = {
  recent: ['played', 'added', 'title', 'artist', 'album', 'duration'],
  liked: ['liked', 'title', 'artist', 'album', 'duration'],
  downloads: ['dl', 'title', 'artist', 'album', 'size'],
  device: ['folder', 'added', 'title', 'artist', 'album'],
};
const PL_SORTS = { updated: ['Recently updated', (a, b) => b.updated_at - a.updated_at], created: ['Recently added', (a, b) => b.created_at - a.created_at], name: ['Name A–Z', (a, b) => cmp(a.name, b.name)] };
const ALBUM_SORTS = { name: ['Album A–Z', (a, b) => cmp(a.name, b.name)], artist: ['Artist A–Z', (a, b) => cmp(a.artist, b.artist) || cmp(a.name, b.name)], count: ['Most songs', (a, b) => b.track_count - a.track_count] };
const ARTIST_SORTS = { name: ['Name A–Z', (a, b) => cmp(a.name, b.name)], count: ['Most songs', (a, b) => b.track_count - a.track_count] };

// ---- Download state of a song ------------------------------------------------------
const isDevice = (t) => t.source === 'local' && !!t.path;
const isDownloaded = (t) => !!(t.downloaded && t.path) && t.source !== 'local';
const playable = (t) => !!(t.path || t.downloaded);

function dlState(t) {
  if (isDevice(t)) return { k: 'device' };
  if (t.downloaded || t.path) return { k: 'done' };
  const d = downloadFor(t);
  if (d && (d.state === 'active' || d.state === 'queued' || d.state === 'paused')) return { k: 'prog', d, p: d.progress || 0 };
  if (d && d.state === 'error') return { k: 'fail', d };
  if (t.video_id) return { k: 'get' };
  return { k: 'none' };
}
const ringSvg = (p) => `<svg class="ring dl__ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="ring__bg" cx="18" cy="18" r="15.5"/><circle class="ring__fg" cx="18" cy="18" r="15.5" pathLength="100" style="--p:${Math.round(p * 100)}"/></svg>`;

/** Indicator in the subtitle line (desktop). */
function subDl(s, t) {
  switch (s.k) {
    case 'done': return `<i class="dl dl--done" title="Downloaded" role="img" aria-label="Downloaded">${icon('check-fill', 'dl__icon')}</i>`;
    case 'device': return `<i class="dl dl--device" title="On this device" role="img" aria-label="On this device">${icon('device', 'dl__icon')}</i>`;
    case 'prog': return `<i class="dl dl--prog" role="img" aria-label="Downloading, ${Math.round(s.p * 100)}%">${ringSvg(s.p)}<b class="dl__pct num">${s.d.state === 'queued' ? 'Queued' : `${Math.round(s.p * 100)}%`}</b></i>`;
    case 'fail': return `<i class="dl dl--fail" data-act="retry" title="${esc(s.d.error || 'Download failed')}"><button class="dl__retry" type="button" data-act="retry" aria-label="Retry download of ${esc(t.title)}" title="Retry">${icon('refresh', 'dl__icon')}</button><b class="dl__failtxt">Failed — tap to retry</b></i>`;
    case 'get': return `<button class="dl dl--get" type="button" data-act="download" aria-label="Download ${esc(t.title)}" title="Download">${icon('dl-circle', 'dl__icon')}</button>`;
    default: return '';
  }
}
/** Indicator in its own column (phone). */
function cellDl(s, t) {
  switch (s.k) {
    case 'done': return `<span class="dl-cell__done" title="Downloaded" role="img" aria-label="Downloaded">${icon('check-fill', 'dl__icon')}</span>`;
    case 'device': return `<span class="dl-cell__device" title="On this device" role="img" aria-label="On this device">${icon('device', 'dl__icon')}</span>`;
    case 'prog': return `<span class="dl-cell__prog" role="img" aria-label="Downloading, ${Math.round(s.p * 100)}%">${ringSvg(s.p)}<b class="dl__pct num">${Math.round(s.p * 100)}%</b></span>`;
    case 'fail': return `<button class="btn btn--icon btn--sm dl-cell__btn dl-cell__btn--fail" type="button" data-act="retry" aria-label="Retry download of ${esc(t.title)}">${icon('refresh', 'dl__icon')}</button>`;
    case 'get': return `<button class="btn btn--icon btn--sm dl-cell__btn" type="button" data-act="download" aria-label="Download ${esc(t.title)}">${icon('dl-circle', 'dl__icon')}</button>`;
    default: return '';
  }
}

/** Library song row (design anatomy). */
function libRow(t, i, { selected = false } = {}) {
  const s = dlState(t);
  const cls = ['row', 'song', 'row--select', s.k === 'fail' ? 'is-failed' : '', selected ? 'is-selected' : '', !online.value && !playable(t) ? 'is-unavailable' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}" role="listitem" data-idx="${i}" data-key="${esc(itemKey(t))}">
    <label class="check row__check"><input type="checkbox" data-sel${selected ? ' checked' : ''} aria-label="Select ${esc(t.title)}"></label>
    <div class="row__num"><span>${i + 1}</span><button class="btn btn--icon btn--sm" type="button" data-act="play" aria-label="Play ${esc(t.title)}">${icon('play', 'icon--16 icon--fill')}</button></div>
    ${artHTML(t)}
    <div class="row__main"><div class="row__title">${esc(t.title)}</div><div class="row__sub">${subDl(s, t)}<span class="row__by">${esc(t.artist || 'Unknown artist')}<span class="row__pdur num"> · ${fmtDuration(t.duration_secs)}</span></span></div></div>
    <div class="row__album">${esc(t.album || '')}</div>
    <div class="row__dur">${fmtDuration(t.duration_secs)}</div>
    <div class="lib-dlcell">${cellDl(s, t)}</div>
    <button class="btn btn--icon btn--sm like row__like${t.liked ? ' is-liked' : ''}" type="button" data-act="like" aria-pressed="${!!t.liked}" aria-label="${t.liked ? 'Liked' : 'Like'}">${icon('heart', 'icon--16')}</button>
    <button class="btn btn--icon btn--sm row__menu" type="button" data-act="menu" aria-haspopup="menu" aria-label="More options for ${esc(t.title)}">${icon('more', 'icon--16')}</button>
  </div>`;
}
const headRow = () => `<div class="row row--head row--select"><label class="check row__check"><input type="checkbox" data-sel-all aria-label="Select all"></label><div class="row__num">#</div><div></div><div>Title</div><div>Album</div><div class="row__dur" aria-label="Duration">${icon('clock', 'icon--16')}</div><div class="lib-dlcell"></div><div aria-label="Liked"></div><div aria-label="More"></div></div>`;

const skeleton = (n = 7) => `<div class="list lib-shimmer" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) => `<div class="skel-row lib-skel-row"><span class="skel skel--art"></span><div class="stack"><span class="skel skel--title" style="width:${[46, 38, 55, 32, 48, 41, 52][i % 7]}%"></span><span class="skel skel--text" style="width:${[28, 22, 30, 18, 26, 24, 20][i % 7]}%"></span></div><span class="skel skel--text"></span></div>`).join('')}</div>`;

// ---- Playlist cards ---------------------------------------------------------------
function likedArt() {
  return `<div class="art art--1 liked-art" aria-hidden="true"><svg viewBox="0 0 100 100"><circle cx="82" cy="14" r="30" fill="currentColor" fill-opacity=".10"/><circle cx="10" cy="92" r="34" fill="currentColor" fill-opacity=".08"/></svg><span class="liked-art__glyph">${icon('heart-solid', 'liked-art__heart')}</span></div>`;
}
/** Cover mosaic from the first four songs (generated art per cell when there's no thumbnail). */
function mosaicArt(p, tracks) {
  if (tracks.length >= 4) {
    return `<div class="art mosaic" aria-hidden="true">${tracks.slice(0, 4).map((t) => mosaicCellHTML(t)).join('')}</div>`;
  }
  if (tracks.length) return artHTML(tracks[0], { size: 'fill' });
  return artHTML(p, { kind: 'playlist', size: 'fill' });
}
function plCard(p, tracks) {
  const art = p.is_liked ? likedArt() : mosaicArt(p, tracks || []);
  const allDl = p.track_count > 0 && p.downloaded_count >= p.track_count;
  const sub = p.is_liked
    ? `<div class="pl-card__sub num pl-card__sub--one"><span>${plural(p.track_count, 'song')} ·</span><i class="pl-card__dl" title="${p.downloaded_count} songs downloaded" role="img" aria-label="${p.downloaded_count} downloaded">${icon('check-fill')}</i><span>${fmtNum(p.downloaded_count)}</span></div>`
    : `<div class="pl-card__sub num">${allDl ? `<i class="pl-card__dl" title="All songs downloaded" role="img" aria-label="All downloaded">${icon('check-fill')}</i>` : ''}<span>${plural(p.track_count, 'song')}${p.track_count ? ` · ${hm(p.total_secs)}` : ''}</span></div>`;
  const origin = p.imported_from ? `<div class="pl-card__origin">Imported from ${{ spotify: 'Spotify', youtube: 'YouTube Music', soundcloud: 'SoundCloud' }[p.imported_from] || p.imported_from}</div>` : '';
  return `<a class="pl-card${p.is_liked ? ' pl-card--liked' : ''}" href="#playlist/${p.id}" data-pl="${p.id}"><div class="pl-card__art">${art}${p.track_count ? `<span class="art__play" role="button" tabindex="0" data-act="play-pl" aria-label="Play ${esc(p.name)}">${icon('play', 'icon--fill')}</span>` : ''}</div><div class="pl-card__title">${esc(p.name)}</div>${sub}${origin}</a>`;
}
const newCard = () => `<button class="pl-card pl-card--new" type="button" data-act="new-pl" aria-haspopup="dialog"><div class="pl-card__art"><span class="pl-new__art">${icon('plus')}</span></div><div class="pl-card__title">New playlist</div><div class="pl-card__sub"><span>Name it, add songs later</span></div></button>`;

export default {
  title: 'Library',
  async render(root, params, ctx) {
    // ---------------------------------------------------------------- state
    let tab = TABS.some(([k]) => k === params.tab) ? params.tab : 'playlists';
    let query = params.q || '';
    const sortBy = { recent: 'played', liked: 'liked', downloads: 'dl', device: 'folder', playlists: 'updated', albums: 'name', artists: 'name' };
    let filter = 'all';                         // Recently played / Liked: all | downloaded | streaming | device
    let shown = PAGE;
    let all = [], recent = [], pls = [], plTracks = new Map(), albums = null, artists = null, stats = null;
    let items = [];                             // the song list currently on screen (data-idx indexes it)
    let ctxPlay = null;
    const selected = new Set();
    let lastSel = -1;
    let loadError = null, loaded = false;
    let scan = null;                            // live scan://progress report
    const cleanups = [];

    root.innerHTML = `<div class="page">
      <div class="page-head lib-head">
        <div><h1>Library</h1><div class="page-head__sub num" data-sub>&nbsp;</div></div>
        <div class="page-head__actions lib-head__actions" data-head-actions>
          <button class="btn btn--ghost lib-head__order" type="button" data-act="play-all" aria-label="Play in order">${icon('play', 'icon--fill')}<span class="lib-head__lbl">Play in order</span></button>
          <button class="btn btn--primary" type="button" data-act="shuffle-all">${icon('shuffle')}Shuffle all</button>
        </div>
      </div>
      <div class="lib-body" data-body></div>
      <button class="lib-fab" type="button" data-act="shuffle-all" aria-label="Shuffle">${icon('shuffle')}</button>
    </div>`;
    const body = root.querySelector('[data-body]');
    const subEl = root.querySelector('[data-sub]');
    const fab = root.querySelector('.lib-fab');

    // ---------------------------------------------------------------- derived lists
    const sorted = (list, key) => list.slice().sort(SORTS[key].fn);
    const filtered = (list) => list.filter((t) => filter === 'all' || (filter === 'downloaded' && isDownloaded(t)) || (filter === 'streaming' && !playable(t)) || (filter === 'device' && isDevice(t)));
    const liked = () => all.filter((t) => t.liked);
    const dlSongs = () => all.filter(isDownloaded);
    const devSongs = () => all.filter(isDevice);
    const counts = (list) => ({ all: list.length, downloaded: list.filter(isDownloaded).length, streaming: list.filter((t) => !playable(t)).length, device: list.filter(isDevice).length });
    const inProgress = () => downloads.value.filter((d) => d.state === 'active' || d.state === 'queued' || d.state === 'paused');

    function tabCount(k) {
      if (!loaded) return '';
      return { playlists: pls.length, liked: liked().length, downloads: dlSongs().length, albums: albums?.length ?? '', artists: artists?.length ?? '', device: devSongs().length }[k];
    }

    // ---------------------------------------------------------------- data
    async function load() {
      loadError = null;
      try {
        const [tracks, rec, list, st] = await Promise.all([api.tracks('music', { sort: 'recent' }), api.recent(200), api.playlists(), api.stats()]);
        all = tracks; recent = rec.filter((t) => t.kind === 'music'); pls = list; stats = st;
        loaded = true;
        // Albums / artists are cheap; fetch them in the background for the tab counts.
        Promise.all([api.albums(), api.artists()]).then(([al, ar]) => { albums = al; artists = ar; renderTabs(); if (tab === 'albums' || tab === 'artists') renderBody(); }).catch(() => {});
        loadMosaics();
      } catch (e) {
        loadError = e;
      }
    }
    async function loadMosaics() {
      const need = pls.filter((p) => !p.is_liked && p.track_count && !plTracks.has(p.id)).slice(0, 48);
      await Promise.all(need.map(async (p) => {
        try { const d = await api.playlist(p.id); plTracks.set(p.id, d.entries.slice(0, 4).map((e) => e.track)); } catch { plTracks.set(p.id, []); }
      }));
      if (need.length && tab === 'playlists') body.querySelectorAll('[data-pl]').forEach((card) => {
        const p = pls.find((x) => String(x.id) === card.dataset.pl);
        if (p && !p.is_liked) card.outerHTML = plCard(p, plTracks.get(p.id));
      });
    }

    // ---------------------------------------------------------------- header
    function renderHead() {
      if (!stats) return;
      const dl = all.filter(isDownloaded).length;
      subEl.textContent = `${plural(stats.music, 'song')} · ${fmtNum(dl)} downloaded · ${fmtBytes(stats.total_bytes)}`;
      root.querySelector('[data-head-actions]').hidden = !all.length;
    }

    // ---------------------------------------------------------------- body
    function tabsHTML() {
      return `<div class="tabs lib-tabs" role="tablist" aria-label="Library sections" data-tabs>${TABS.map(([k, label]) => `<button class="tabs__item${k === tab ? ' is-active' : ''}" type="button" role="tab" aria-selected="${k === tab}" data-tab="${k}">${label}<span class="tabs__count num">${tabCount(k)}</span></button>`).join('')}</div>`;
    }
    function renderTabs() {
      const el = body.querySelector('[data-tabs]');
      if (el) el.outerHTML = tabsHTML();
    }
    function sortBtn(key, labels) {
      const lbl = labels ? labels[sortBy[key]][0] : SORTS[sortBy[key]].label;
      const short = labels ? lbl : SORTS[sortBy[key]].short;
      return `<button class="btn btn--secondary btn--sm lib-sort" type="button" data-act="sort" data-sort="${key}" aria-haspopup="menu" aria-label="Sort: ${esc(lbl)}">${icon('sort', 'icon--16')}<span class="lib-sort__k lib-sort__k--sort">Sort:</span><span class="lib-sort__full"> ${esc(lbl)}</span><span class="lib-sort__short">${esc(short)}</span>${icon('chevron-down', 'icon--16')}</button>`;
    }
    function chipsHTML(list) {
      const c = counts(list);
      const chip = (k, label, ic) => `<button class="chip${filter === k ? ' is-selected' : ''}" type="button" data-filter="${k}" aria-pressed="${filter === k}">${ic ? icon(ic, 'icon--16') : ''}${label}<span class="chip__count num">${fmtNum(c[k])}</span></button>`;
      return `<div class="chips chips--scroll lib-tools__chips desktop-only" role="group" aria-label="Filter by download state">${chip('all', 'All')}${chip('downloaded', 'Downloaded', 'check-fill')}${chip('streaming', 'Streaming only', 'cloud')}${chip('device', 'On device', 'device')}</div>`;
    }
    const filterLabel = () => ({ all: 'All', downloaded: 'Downloaded', streaming: 'Streaming', device: 'On device' }[filter]);
    const sourceBtn = () => `<button class="btn btn--secondary btn--sm lib-source phone-only" type="button" data-act="show" aria-haspopup="dialog" aria-label="Show: ${filterLabel()}">${icon('filter', 'icon--16')}<span class="lib-sort__k">Show:</span> ${filterLabel()}${icon('chevron-down', 'icon--16')}</button>`;

    function offlineBanner(list, what) {
      if (online.value) return '';
      const ok = list.filter(playable).length;
      return banner({ kind: 'warn', icon: 'offline', title: 'Offline — only downloaded songs play', text: `${fmtNum(ok)} of ${plural(list.length, what)} are playable now. The rest stream again when you’re back online.`, action: filter === 'all' && ok < list.length ? `<button class="btn btn--secondary btn--sm" type="button" data-act="playable-only">${icon('check-fill', 'icon--16')}Show playable only</button>` : '' });
    }

    function songList(list, context, { foot = true } = {}) {
      items = list; ctxPlay = context;
      for (const k of [...selected]) if (!list.some((t) => itemKey(t) === k)) selected.delete(k);
      const rows = list.slice(0, shown).map((t, i) => libRow(t, i, { selected: selected.has(itemKey(t)) })).join('');
      const more = list.length > shown ? `<div class="lib-more"><button class="btn btn--ghost btn--sm" type="button" data-act="more">Show ${fmtNum(Math.min(PAGE * 2, list.length - shown))} more${icon('chevron-down', 'icon--16')}</button></div>` : '';
      const footer = foot && list.length ? `<div class="lib-foot num"><span>${list.length > shown ? `Showing ${fmtNum(shown)} of ${fmtNum(list.length)}` : plural(list.length, 'song')} · ${hm(list.reduce((s, t) => s + (t.duration_secs || 0), 0))}</span><span class="lib-foot__hint">Shift-click selects a range · Ctrl A selects all</span></div>` : '';
      return `<div class="select-bar desktop-only" role="toolbar" data-selbar hidden></div><div class="list lib-list" role="list" data-list>${headRow()}${rows}</div>${more}${footer}`;
    }

    function renderBody() {
      if (!loaded) {
        body.innerHTML = loadError
          ? `<div class="card">${emptyState({ icon: 'alert', error: true, title: 'Couldn’t read your library', text: loadError.message || String(loadError), actions: `<button class="btn btn--primary" type="button" data-act="reload">${icon('refresh')}Try again</button>` })}</div>`
          : `${tabsHTML()}<div class="lib-section"><div class="lib-tools"><span class="t-13 muted">Loading your library…</span></div><div class="lib-skel-grid lib-shimmer" aria-hidden="true">${'<span class="skel"></span>'.repeat(6)}</div>${skeleton(6)}</div>`;
        return;
      }
      renderHead();
      if (!all.length && pls.length <= 1 && !query) {
        body.innerHTML = `${tabsHTML()}<div class="card card--flush">${emptyState({ icon: 'music', title: 'Your library is empty', text: 'Search YouTube Music to stream, like or download songs — or scan folders on this device for music you already have.', actions: `<a class="btn btn--primary" href="#search">${icon('search')}Search YouTube Music</a><a class="btn btn--secondary" href="#device">${icon('scan')}Scan device folders</a>` })}</div>`;
        items = [];
        return;
      }
      items = []; ctxPlay = null;
      if (query) { renderSearch(); return; }
      const html = { playlists: playlistsTab, liked: likedTab, downloads: downloadsTab, albums: albumsTab, artists: artistsTab, device: deviceTab }[tab]();
      body.innerHTML = tabsHTML() + html;
      syncSelection();
      if (tab === 'device') hydrateDevice();
    }

    function playlistsTab() {
      const list = pls.slice().sort((a, b) => (b.is_liked - a.is_liked) || PL_SORTS[sortBy.playlists][1](a, b));
      const base = filtered(recent);
      const c = counts(recent);
      const recentHTML = recent.length ? `<section class="lib-section" aria-labelledby="recent-h">
          <div class="lib-section__head lib-section__head--stack"><h3 id="recent-h">Recently played</h3><span class="t-13 num">Last played first<span class="phone-only"> · ${plural(recent.length, 'song')}</span></span></div>
          ${offlineBanner(recent, 'song')}
          <div class="lib-tools">${chipsHTML(recent)}<div class="lib-tools__right">${sourceBtn()}<span class="t-13 muted num lib-tools__count">${plural(base.length, 'song')} · ${hm(base.reduce((s, t) => s + t.duration_secs, 0))}</span>${sortBtn('recent')}</div></div>
          ${base.length ? songList(sorted(base, sortBy.recent), { type: 'library', name: 'Recently played' }) : emptyState({ icon: 'filter', compact: true, title: `No ${filterLabel().toLowerCase()} songs here`, text: `${fmtNum(c.all)} songs played recently; none match this filter.`, actions: '<button class="btn btn--secondary btn--sm" type="button" data-filter="all">Show all</button>' })}
        </section>` : '';
      if (!recent.length) items = [];
      const none = pls.filter((p) => !p.is_liked).length === 0;
      return `<section class="lib-section" aria-label="Playlists">
          <div class="lib-tools"><span class="t-13 muted num">${plural(pls.length, 'playlist')}<span class="desktop-only"> · Liked songs updates itself</span></span><div class="lib-tools__right">${sortBtn('playlists', PL_SORTS)}</div></div>
          <div class="pl-grid">${list.map((p) => plCard(p, plTracks.get(p.id))).join('')}${newCard()}</div>
          ${none ? emptyState({ icon: 'playlist', compact: true, title: 'Make your first playlist', text: 'Group songs for a drive, a workout or a quiet evening. Streamed and downloaded songs can share a playlist.', actions: `<button class="btn btn--primary" type="button" data-act="new-pl">${icon('plus')}New playlist</button>` }) : ''}
        </section>${recentHTML}`;
    }

    function likedTab() {
      const src = liked();
      if (!src.length) { items = []; return emptyState({ icon: 'heart', compact: true, title: 'No liked songs yet', text: 'Tap the heart on any song, in search results or in the player, and it collects here.', actions: `<a class="btn btn--primary" href="#search">${icon('search')}Find songs to like</a>` }); }
      const base = filtered(src);
      const toGet = src.filter((t) => !playable(t) && t.video_id && !downloadFor(t)).length;
      return `${offlineBanner(src, 'liked song')}<div class="lib-tools lib-tools--liked">${chipsHTML(src)}<div class="lib-tools__right">${toGet ? `<button class="btn btn--secondary btn--sm lib-dlall" type="button" data-act="dl-liked"${online.value ? '' : ' disabled'}>${icon('dl-circle', 'icon--16')}Download all <span class="num">${fmtNum(toGet)}</span></button>` : ''}${sourceBtn()}<span class="t-13 muted num lib-tools__count">${plural(base.length, 'song')} · ${hm(base.reduce((s, t) => s + t.duration_secs, 0))}</span>${sortBtn('liked')}</div></div>
        ${base.length ? songList(sorted(base, sortBy.liked), { type: 'liked', id: 0, name: 'Liked songs' }) : emptyState({ icon: 'filter', compact: true, title: 'Nothing matches this filter', actions: '<button class="btn btn--secondary btn--sm" type="button" data-filter="all">Show all</button>' })}`;
    }

    function downloadsTab() {
      const done = dlSongs();
      const live = inProgress().concat(downloads.value.filter((d) => d.state === 'error'));
      const liveTracks = live.map((d) => all.find((t) => t.id === d.track_id)).filter((t) => t && !t.path);
      const busy = inProgress().length;
      if (!done.length && !liveTracks.length) {
        items = [];
        const likedToGet = liked().filter((t) => !playable(t) && t.video_id).length;
        return emptyState({ icon: 'download', compact: true, title: 'Nothing downloaded yet', text: 'Download songs to play them with no connection. Look for the arrow next to any song.', actions: `<a class="btn btn--primary" href="#search">${icon('search')}Search YouTube Music</a>${likedToGet ? `<button class="btn btn--ghost" type="button" data-act="dl-liked">${icon('heart')}Download liked songs</button>` : ''}` });
      }
      const bytes = done.reduce((s, t) => s + (t.size_bytes || 0), 0);
      const list = [...new Set(liveTracks)].concat(sorted(done, sortBy.downloads));
      return `<div class="lib-tools lib-tools--dl"><span class="t-13 muted num lib-tools__meta">${plural(done.length, 'song')} · ${fmtBytes(bytes)} on this device</span><div class="lib-tools__right"><a class="btn btn--ghost btn--sm" href="#downloads">Open queue${busy ? ` <span class="num">(${busy})</span>` : ''}${icon('chevron-right', 'icon--16')}</a><span class="t-13 muted num lib-tools__count"></span>${sortBtn('downloads')}</div></div>
        ${songList(list, { type: 'downloads', name: 'Downloads' })}`;
    }

    function albumDone(a) {
      const songs = all.filter((t) => t.album === a.name && (!a.artist || t.artist === a.artist));
      return songs.length > 0 && songs.every(playable);
    }
    function albumsTab() {
      items = [];
      if (!albums) return `<div class="lib-tools"><span class="t-13 muted">Loading albums…</span></div><div class="lib-skel-grid lib-shimmer" aria-hidden="true">${'<span class="skel"></span>'.repeat(6)}</div>`;
      if (!albums.length) return emptyState({ icon: 'disc', compact: true, title: 'No albums yet', text: 'Albums appear as you like, download or scan songs that have album tags.', actions: `<a class="btn btn--primary" href="#search">${icon('search')}Search YouTube Music</a>` });
      const list = albums.slice().sort(ALBUM_SORTS[sortBy.albums][1]);
      return `<div class="lib-tools"><span class="t-13 muted num">${plural(list.length, 'album')}</span><div class="lib-tools__right">${sortBtn('albums', ALBUM_SORTS)}</div></div>
        <div class="tile-grid">${list.map((a) => {
          const i = albums.indexOf(a);
          const art = artHTML(a, { kind: 'album', size: 'tile' }).replace(/<\/div>$/, `<span class="art__play" role="button" tabindex="0" data-act="play-album" data-album="${i}" aria-label="Play ${esc(a.name)}">${icon('play', 'icon--fill')}</span></div>`);
          return `<a class="tile" href="#search?q=${encodeURIComponent(`${a.name} ${a.artist || ''}`.trim())}" data-album="${i}">${art}<div><div class="tile__title">${esc(a.name)}</div><div class="tile__sub num">${albumDone(a) ? `<i class="pl-card__dl" title="Downloaded" role="img" aria-label="Downloaded">${icon('check-fill')}</i>` : ''}${a.artist ? `<span class="tile__by">${esc(a.artist)} · </span>` : ''}<span>${plural(a.track_count, 'song')}</span></div></div></a>`;
        }).join('')}</div>`;
    }
    function artistsTab() {
      items = [];
      if (!artists) return `<div class="lib-tools"><span class="t-13 muted">Loading artists…</span></div><div class="lib-skel-grid lib-shimmer" aria-hidden="true">${'<span class="skel"></span>'.repeat(6)}</div>`;
      if (!artists.length) return emptyState({ icon: 'user', compact: true, title: 'No artists yet', text: 'Artists appear as you like, download or scan songs.', actions: `<a class="btn btn--primary" href="#search">${icon('search')}Search YouTube Music</a>` });
      const albumsBy = new Map();
      for (const t of all) if (t.artist && t.album) { if (!albumsBy.has(t.artist)) albumsBy.set(t.artist, new Set()); albumsBy.get(t.artist).add(t.album); }
      const list = artists.slice().sort(ARTIST_SORTS[sortBy.artists][1]);
      return `<div class="lib-tools"><span class="t-13 muted num">${plural(list.length, 'artist')}</span><div class="lib-tools__right">${sortBtn('artists', ARTIST_SORTS)}</div></div>
        <div class="tile-grid">${list.map((a) => {
          const i = artists.indexOf(a);
          const n = albumsBy.get(a.name)?.size || 0;
          const art = artHTML(a, { kind: 'artist', size: 'tile', round: true }).replace(/<\/div>$/, `<span class="art__play" role="button" tabindex="0" data-act="play-artist" data-artist="${i}" aria-label="Play ${esc(a.name)}">${icon('play', 'icon--fill')}</span></div>`);
          return `<a class="tile tile--artist" href="#search?q=${encodeURIComponent(a.name)}" data-artist="${i}">${art}<div><div class="tile__title">${esc(a.name)}</div><div class="tile__sub num"><span>${plural(a.track_count, 'song')}${n ? ` · ${plural(n, 'album')}` : ''}</span></div></div></a>`;
        }).join('')}</div>`;
    }

    function deviceTab() {
      const src = devSongs();
      const list = sorted(src, sortBy.device);
      return `<div class="card dev-pane" data-dev>
          <div class="dev-pane__icon">${icon('folder')}</div>
          <div><div class="dev-pane__title num" data-dev-title>${plural(src.length, 'song')} on this device</div><div class="dev-pane__sub num" data-dev-sub>&nbsp;</div></div>
          <a class="btn btn--secondary btn--sm" href="#device">${icon('settings', 'icon--16')}Manage folders</a>
          <div class="dev-pane__scan">
            <div data-scan></div>
            <div class="dev-pane__note desktop-only">${icon('mic', 'icon--16')}<span class="num">Voice recordings are kept separately — ${fmtNum(stats?.voice || 0)} in <a href="#voice">Voice recordings</a>.</span></div>
            <a class="dev-pane__note dev-pane__note--link phone-only" href="#voice">${icon('mic', 'icon--16')}<span class="num">Voice recordings are kept separately (${fmtNum(stats?.voice || 0)})</span>${icon('chevron-right', 'icon--16 dev-pane__chev')}</a>
          </div>
        </div>
        ${src.length ? `<div class="lib-tools"><span class="t-13 muted num">${plural(src.length, 'song')} · ${hm(src.reduce((s, t) => s + t.duration_secs, 0))}</span><div class="lib-tools__right">${sortBtn('device')}</div></div>${songList(list, { type: 'library', name: 'On this device' })}`
          : (items = [], emptyState({ icon: 'folder', compact: true, title: 'No songs from device folders', text: 'Add the folders where your music lives and scan them. Files stay where they are.', actions: `<a class="btn btn--primary" href="#device">${icon('scan')}Scan device folders</a>` }))}`;
    }
    async function hydrateDevice() {
      const [rules, last, scanning] = await Promise.all([api.rules().catch(() => []), api.lastScan().catch(() => null), api.isScanning().catch(() => false)]);
      const folders = rules.filter((r) => r.enabled && r.rule !== 'exclude');
      const names = folders.map((r) => r.path.split('/').filter(Boolean).slice(-2).join('/'));
      const title = body.querySelector('[data-dev-title]');
      if (!title) return;
      title.textContent = `${plural(devSongs().length, 'song')} from ${plural(folders.length, 'folder')}${last ? ` · last scan ${fmtAgo(last[0])}` : ' · never scanned'}`;
      body.querySelector('[data-dev-sub]').textContent = names.join(' · ') || 'No folders chosen yet';
      if (!scanning && !(scan && !scan.finished)) scan = null;
      renderScan();
    }
    function renderScan() {
      const el = body.querySelector('[data-scan]');
      if (!el) return;
      if (!scan || scan.finished) {
        el.innerHTML = `<div class="dev-pane__note">${icon('scan', 'icon--16')}<span>New files appear here after a scan.</span><button class="btn btn--ghost btn--sm" type="button" data-act="scan">Scan now</button></div>`;
        return;
      }
      const p = scan.files_seen ? Math.min(99, Math.round((scan.audio_found / Math.max(scan.files_seen, 1)) * 100)) : 0;
      el.innerHTML = `<div class="progress-line scan-line"><div class="progress-line__meta scan-line__meta"><strong class="scan-line__count">Scanning… ${fmtNum(scan.files_seen)} files · ${fmtNum(scan.audio_found)} audio</strong><span class="scan-line__eta">${fmtNum(scan.added)} new</span><span class="scan-line__path" title="${esc(scan.current_path)}">Reading ${esc(scan.current_path || '…')}</span></div><div class="progress progress--indeterminate" style="--p:${p}%"><i></i></div></div>`;
    }

    // ---------------------------------------------------------------- search within library
    function renderSearch() {
      const q = query.toLowerCase();
      const m = (s) => String(s || '').toLowerCase().includes(q);
      const songs = all.filter((t) => m(t.title) || m(t.artist) || m(t.album));
      const plHits = pls.filter((p) => m(p.name)).length;
      const alHits = new Set(songs.filter((t) => m(t.album)).map((t) => t.album)).size;
      const arHits = new Set(songs.filter((t) => m(t.artist)).map((t) => t.artist)).size;
      const field = `<div class="search">${icon('search')}<input class="search__input" data-q value="${esc(query)}" aria-label="Search your library" autocomplete="off"><button class="btn btn--icon btn--sm search__clear" type="button" data-act="clear-q" aria-label="Clear search">${icon('x', 'icon--16')}</button></div>`;
      if (!songs.length) {
        items = [];
        body.innerHTML = field + emptyState({ icon: 'search', compact: true, title: `Nothing in your library matches “${query}”`, text: 'Check the spelling, or search YouTube Music to stream or download it.', actions: `<a class="btn btn--primary" href="#search?q=${encodeURIComponent(query)}">${icon('search')}Search YouTube Music</a><button class="btn btn--ghost" type="button" data-act="clear-q">Clear search</button>` });
      } else {
        const link = (n, one, t) => n ? `<span class="sep desktop-only"></span><a class="desktop-only" href="#library?tab=${t}" data-tab-link="${t}">${plural(n, one)}</a>` : '';
        const chip = (n, label, t) => n ? `<a class="chip" href="#library?tab=${t}" data-tab-link="${t}">${label}<span class="chip__count">${n}</span></a>` : '';
        body.innerHTML = `${field}<div class="between lib-search-meta"><div class="meta"><span class="strong">${plural(songs.length, 'song')}</span><span>match “${esc(query)}”</span>${link(plHits, 'playlist', 'playlists')}${link(alHits, 'album', 'albums')}${link(arHits, 'artist', 'artists')}</div></div>
          ${plHits || alHits || arHits ? `<div class="lib-search-chips phone-only" aria-label="Other matches in your library">${chip(plHits, 'Playlists', 'playlists')}${chip(alHits, 'Albums', 'albums')}${chip(arHits, 'Artists', 'artists')}</div>` : ''}
          ${songList(songs, { type: 'search', name: `“${query}” in your library` })}`;
        syncSelection();
      }
      const input = body.querySelector('[data-q]');
      input.addEventListener('input', debounce(() => { setQuery(input.value.trim(), true); }, 150));
      if (document.activeElement === document.body || !document.activeElement) input.focus({ preventScroll: true });
    }
    function setQuery(q, keepFocus) {
      query = q; shown = PAGE;
      updateUrl();
      const pos = keepFocus ? body.querySelector('[data-q]')?.selectionStart : null;
      renderBody();
      if (keepFocus && query) { const inp = body.querySelector('[data-q]'); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); } }
    }
    function updateUrl() {
      const qs = new URLSearchParams();
      if (tab !== 'playlists') qs.set('tab', tab);
      if (query) qs.set('q', query);
      const s = qs.toString();
      history.replaceState(history.state, '', `#library${s ? `?${s}` : ''}`);
    }

    // ---------------------------------------------------------------- selection (desktop)
    function syncSelection() {
      const bar = body.querySelector('[data-selbar]');
      const list = body.querySelector('[data-list]');
      if (!list) return;
      list.querySelectorAll('.row.song').forEach((row) => {
        const on = selected.has(row.dataset.key);
        row.classList.toggle('is-selected', on);
        const cb = row.querySelector('[data-sel]'); if (cb) cb.checked = on;
      });
      const head = list.querySelector('[data-sel-all]');
      if (head) { head.checked = selected.size > 0 && selected.size >= items.length; head.classList.toggle('is-mixed', selected.size > 0 && selected.size < items.length); }
      if (!bar) return;
      bar.hidden = selected.size === 0;
      if (!selected.size) { bar.innerHTML = ''; return; }
      const sel = items.filter((t) => selected.has(itemKey(t)));
      const getN = sel.filter((t) => !playable(t) && t.video_id).length;
      bar.setAttribute('aria-label', `${sel.length} songs selected`);
      bar.innerHTML = `<div class="select-bar__count"><span class="badge badge--count">${sel.length}</span><span class="strong">selected</span><span class="t-13 num">· ${fmtDuration(sel.reduce((s, t) => s + t.duration_secs, 0))}</span></div>
        <button class="btn btn--secondary btn--sm" type="button" data-act="sel-playlist" aria-haspopup="menu">${icon('plus', 'icon--16')}<span>Add to playlist</span></button>
        ${getN ? `<button class="btn btn--secondary btn--sm" type="button" data-act="sel-download">${icon('dl-circle', 'icon--16')}<span>Download (${getN})</span></button>` : ''}
        ${tab === 'liked' && !query ? `<button class="btn btn--danger btn--sm" type="button" data-act="sel-remove" aria-haspopup="dialog">${icon('trash', 'icon--16')}Remove…</button>` : ''}
        <button class="btn btn--icon btn--secondary btn--sm" type="button" data-act="sel-more" aria-label="More: Play next, Add to queue, Like" aria-haspopup="menu" title="Play next · Add to queue · Like">${icon('more', 'icon--16')}</button>
        <span class="select-bar__spacer"></span>
        <button class="btn btn--ghost btn--sm" type="button" data-act="sel-clear">Clear<span class="kbd">Esc</span></button>`;
    }
    const selItems = () => items.filter((t) => selected.has(itemKey(t)));
    function clearSel() { selected.clear(); lastSel = -1; syncSelection(); }

    // ---------------------------------------------------------------- live download indicators
    function patchDl() {
      body.querySelectorAll('[data-list] .row.song').forEach((row) => {
        const t = items[Number(row.dataset.idx)];
        if (!t) return;
        const s = dlState(t);
        const sub = subDl(s, t), cell = cellDl(s, t);
        const subEl2 = row.querySelector('.row__sub');
        const first = subEl2.firstElementChild?.classList.contains('dl') ? subEl2.firstElementChild : null;
        const sig = `${s.k}:${s.p ?? ''}:${s.d?.state ?? ''}`;
        if (row.dataset.dl === sig) return;
        row.dataset.dl = sig;
        if (first) first.outerHTML = sub; else subEl2.insertAdjacentHTML('afterbegin', sub);
        row.querySelector('.lib-dlcell').innerHTML = cell;
        row.classList.toggle('is-failed', s.k === 'fail');
      });
    }

    // ---------------------------------------------------------------- menus
    function sortMenu(anchor, key) {
      const opts = key === 'playlists' ? PL_SORTS : key === 'albums' ? ALBUM_SORTS : key === 'artists' ? ARTIST_SORTS : null;
      const entries = opts ? Object.entries(opts).map(([k, [label]]) => [k, label]) : TAB_SORTS[key].map((k) => [k, SORTS[k].label]);
      openMenu(anchor, [{ head: '<span class="eyebrow">Sort by</span>' }, ...entries.map(([k, label]) => ({ label, checked: sortBy[key] === k, run: () => { sortBy[key] = k; shown = PAGE; renderBody(); } }))], { title: 'Sort by', className: 'lib-menu', label: 'Sort' });
    }
    function showMenu(anchor) {
      const src = tab === 'liked' ? liked() : recent;
      const c = counts(src);
      const it = (k, label, ic) => ({ label, icon: ic, hint: fmtNum(c[k]), checked: filter === k, run: () => { filter = k; shown = PAGE; renderBody(); } });
      openMenu(anchor, [it('all', 'All', 'music'), it('downloaded', 'Downloaded', 'check-fill'), it('streaming', 'Streaming only', 'cloud'), it('device', 'On device', 'device')], { title: 'Show songs', className: 'lib-menu', label: 'Show songs' });
    }

    // ---------------------------------------------------------------- actions
    async function playTiles(kind, i) {
      const src = kind === 'album' ? albums[i] : artists[i];
      if (!src) return;
      const songs = all.filter((t) => (kind === 'album' ? t.album === src.name && (!src.artist || t.artist === src.artist) : t.artist === src.name));
      if (!songs.length) { toast('No songs from it are in your library yet', { kind: 'info' }); return; }
      player.play(kind === 'album' ? songs.slice().sort((a, b) => cmp(a.title, b.title)) : songs, 0, { type: kind, name: src.name });
    }
    async function playPlaylist(id) {
      const d = await guard(() => api.playlist(id));
      if (!d?.entries.length) return;
      player.play(d.entries.map((e) => e.track), 0, { type: id === 0 ? 'liked' : 'playlist', id, name: d.playlist.name });
    }
    /** What the header Play / Shuffle act on: the visible song list, or everything on the card tabs. */
    function currentSongs() {
      if (!query && (tab === 'playlists' || tab === 'albums' || tab === 'artists')) return [all, { type: 'library', name: 'Library' }];
      return [items, ctxPlay || { type: 'library', name: 'Library' }];
    }
    async function downloadLiked() {
      const ids = await guard(() => api.downloadPlaylist(0));
      if (ids) { pokeDownloads(); toast(ids.length ? `Downloading ${plural(ids.length, 'liked song')}` : 'Every liked song is already downloaded', { kind: ids.length ? 'info' : 'ok', action: ids.length ? { label: 'View', run: () => { location.hash = '#downloads'; } } : null }); }
    }

    root.addEventListener('click', async (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) { tab = tabBtn.dataset.tab; filter = 'all'; shown = PAGE; clearSel(); updateUrl(); renderBody(); return; }
      const tabLink = e.target.closest('[data-tab-link]');
      if (tabLink) { e.preventDefault(); tab = tabLink.dataset.tabLink; query = ''; updateUrl(); renderBody(); return; }
      const f = e.target.closest('[data-filter]');
      if (f) { filter = f.dataset.filter; shown = PAGE; renderBody(); return; }
      const act = e.target.closest('[data-act]');
      if (!act || !root.contains(act)) return;
      switch (act.dataset.act) {
        case 'play-all': { const [l, c] = currentSongs(); if (l.length) player.play(l, 0, c); break; }
        case 'shuffle-all': { const [l, c] = currentSongs(); if (l.length) player.shufflePlay(l, c); break; }
        case 'reload': loaded = false; renderBody(); await load(); renderBody(); break;
        case 'new-pl': e.preventDefault(); { const p = await createPlaylistDialog(); if (p) location.hash = `#playlist/${p.id}`; } break;
        case 'play-pl': e.preventDefault(); e.stopPropagation(); playPlaylist(Number(act.closest('[data-pl]').dataset.pl)); break;
        case 'play-album': e.preventDefault(); e.stopPropagation(); playTiles('album', Number(act.dataset.album)); break;
        case 'play-artist': e.preventDefault(); e.stopPropagation(); playTiles('artist', Number(act.dataset.artist)); break;
        case 'sort': sortMenu(act, act.dataset.sort); break;
        case 'show': showMenu(act); break;
        case 'more': shown += PAGE * 2; renderBody(); break;
        case 'playable-only': filter = 'downloaded'; renderBody(); break;
        case 'dl-liked': act.disabled = true; await downloadLiked(); break;
        case 'clear-q': setQuery('', false); break;
        case 'scan': act.disabled = true; await guard(() => api.startScan()); break;
        case 'retry': {
          e.stopPropagation();
          const row = act.closest('[data-idx]');
          const t = row && items[Number(row.dataset.idx)];
          const d = t && downloadFor(t);
          if (d) { await guard(() => api.retryDownload(d.id)); pokeDownloads(); toast(`Retrying “${t.title}”`, { kind: 'info' }); }
          break;
        }
        case 'sel-clear': clearSel(); break;
        case 'sel-playlist': openPlaylistPicker(act, selItems()); break;
        case 'sel-download': {
          const todo = selItems().filter((t) => !playable(t) && t.video_id);
          for (const t of todo) await download(t);
          clearSel();
          break;
        }
        case 'sel-remove': {
          const sel = selItems();
          const ok = await confirmDialog({ title: `Remove ${plural(sel.length, 'song')} from Liked songs?`, text: `${sel.slice(0, 3).map((t) => t.title).join(', ')}${sel.length > 3 ? ` and ${sel.length - 3} more` : ''} will be unliked. Downloads and playlists are not touched.`, confirm: `Remove ${plural(sel.length, 'song')}`, danger: true });
          if (!ok) break;
          await guard(async () => { for (const t of sel) await api.setLiked(t.id, false); });
          clearSel(); plStore.refresh(); refresh();
          toast(`Removed ${plural(sel.length, 'song')} from Liked songs`, { kind: 'ok' });
          break;
        }
        case 'sel-more': {
          const sel = selItems();
          openMenu(act, [
            { label: 'Play next', icon: 'play-next', run: () => { player.playNext(sel); toast(`${plural(sel.length, 'song')} play next`, { kind: 'ok' }); } },
            { label: 'Add to queue', icon: 'queue', run: () => { player.addToQueue(sel); toast(`Added ${plural(sel.length, 'song')} to the queue`, { kind: 'ok' }); } },
            { label: `Like all ${sel.length}`, icon: 'heart', run: async () => { for (const t of sel.filter((x) => !x.liked)) await toggleLike(t); } },
          ], { title: `${plural(sel.length, 'song')}`, className: 'lib-menu' });
          break;
        }
      }
    });
    root.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.art__play[role="button"]')) { e.preventDefault(); e.target.click(); }
    });
    // Checkboxes (desktop multi-select). Shift-click selects a range.
    root.addEventListener('click', (e) => {
      const cb = e.target.closest('[data-sel], [data-sel-all]');
      if (!cb) return;
      e.stopPropagation();
      if (cb.matches('[data-sel-all]')) {
        if (selected.size >= items.length) selected.clear(); else items.forEach((t) => selected.add(itemKey(t)));
      } else {
        const row = cb.closest('[data-idx]');
        const idx = Number(row.dataset.idx);
        if (e.shiftKey && lastSel >= 0) {
          const [a, b] = [Math.min(lastSel, idx), Math.max(lastSel, idx)];
          for (let i = a; i <= b; i++) if (items[i]) selected.add(itemKey(items[i]));
        } else if (cb.checked) selected.add(row.dataset.key); else selected.delete(row.dataset.key);
        lastSel = idx;
      }
      syncSelection();
    }, true);
    const onKey = (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]') && !e.target.matches('[data-sel], [data-sel-all]')) return;
      if (e.key === 'Escape' && selected.size && !document.querySelector('.scrim, .popover-scrim')) { clearSel(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && items.length && !isPhone()) { e.preventDefault(); items.forEach((t) => selected.add(itemKey(t))); syncSelection(); }
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));

    // Rows: play / like / download / ⋯ via the shared binder (bound once to the body).
    cleanups.push(bindTrackList(body, { items: () => items, player, get context() { return ctxPlay; } }));

    // ---------------------------------------------------------------- live updates
    const refresh = debounce(async () => { await load(); renderTabs(); if (loaded) { const y = document.getElementById('main')?.scrollTop; renderBody(); if (y != null) document.getElementById('main')?.scrollTo({ top: y }); } }, 250);
    addEventListener('library:changed', refresh);
    addEventListener('track:updated', refresh);
    cleanups.push(() => { removeEventListener('library:changed', refresh); removeEventListener('track:updated', refresh); });
    cleanups.push(downloads.subscribe(() => { if (loaded) { patchDl(); if (tab === 'downloads' && !query) { /* live rows join/leave the top */ const n = inProgress().length; if (body.dataset.busy !== String(n)) { body.dataset.busy = String(n); renderBody(); } } } }));
    cleanups.push(online.subscribe(() => { if (loaded) renderBody(); }));
    listen('scan://progress', (r) => { scan = r; if (tab === 'device') { renderScan(); if (r.finished) refresh(); } }).then((un) => cleanups.push(un));

    // Phone: Shuffle follows the thumb once the header actions scroll away.
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(([en]) => fab.classList.toggle('is-shown', !en.isIntersecting && all.length > 0));
      io.observe(root.querySelector('[data-head-actions]'));
      cleanups.push(() => io.disconnect());
    }

    // ---------------------------------------------------------------- first paint
    renderBody();
    await load();
    renderBody();
    return () => cleanups.forEach((fn) => { try { fn(); } catch {} });
  },
};
