// Search (design/screens/search.html): one search bar, source switch (YouTube Music · Your
// library), result-type chips (All · Songs · Albums · Artists), Top result card, song rows
// with Play (stream) / Download (live ring, queued, retry) / Like / ⋯, Albums tiles and
// Artist rows. States: recent searches (empty query), loading skeleton with elapsed time,
// no results (shorter query offered), error (retry), offline (library matches + banner).
// Styles: styles/views/search.css.
//
// YouTube Music search returns songs only (docs/API-v2.md youtube_search), so Albums and
// Artists are grouped from the song results (DECISIONS D34). Library mode uses
// list_tracks / list_albums / list_artists.
// Review switch (browser preview only): ?state=loading|error|offline.

import { api, isTauri } from '../api.js';
import { ytShape } from '../components/actions.js';
import { artHTML } from '../components/art.js';
import { bindTrackList } from '../components/tracks.js';
import { downloadFor, downloadSummary, downloads, itemKey, online, pokeDownloads, rememberDownload } from '../components/store.js';
import { needsStream, player } from '../player.js';
import { debounce, emptyState, esc, fmtAgo, fmtDuration, fmtEta, fmtNum, guard, icon, isPhone, on, plural, toast } from '../ui.js';

const PREVIEW_STATE = !isTauri ? new URLSearchParams(location.search).get('state') : null;
const RECENT_KEY = 'search.recent';
const RECENT_MAX = 12;
const OVERVIEW_SONGS = 6;
const YT_LIMIT = 30;

const isOnline = () => PREVIEW_STATE !== 'offline' && online.value !== false;
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const primaryArtist = (a) => String(a || '').split(/,|&| feat\.? | x /i)[0].trim();
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'}`;

// ---- recent searches (per-viewer convenience → localStorage) ----
function readRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function writeRecent(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch {} }
function pushRecent(entry) {
  const key = (e) => `${e.type}:${norm(e.title)}:${norm(e.sub || '')}`;
  const list = readRecent().filter((e) => key(e) !== key(entry));
  writeRecent([{ ...entry, at: Math.floor(Date.now() / 1000) }, ...list]);
}

/** Merges each YouTube result with its library row (liked / downloaded / path) when one exists. */
async function withLibrary(list) {
  const localId = (r) => r.local_track_id || downloadFor(r)?.track_id || null;
  const ids = [...new Set(list.map(localId).filter(Boolean))];
  const rows = await Promise.all(ids.map((id) => api.track(id).catch(() => null)));
  const byId = new Map(rows.filter(Boolean).map((t) => [t.id, t]));
  return list.map((r) => {
    const t = byId.get(localId(r));
    if (t) return { ...r, ...t, video_id: t.video_id || r.video_id, thumbnail: t.thumbnail || r.thumbnail, explicit: r.explicit };
    return { ...r, id: null, path: null, downloaded: false, liked: false, kind: 'music', source: 'youtube' };
  });
}

/** Albums and artists grouped from song results (YouTube) — each keeps its songs. */
function groupSongs(songs) {
  const albums = new Map();
  const artists = new Map();
  for (const s of songs) {
    const a = primaryArtist(s.artist);
    if (s.album) {
      const k = `${norm(s.album)}\u0000${norm(a)}`;
      if (!albums.has(k)) albums.set(k, { kind: 'album', name: s.album, artist: a, songs: [], artwork: s.thumbnail || null });
      albums.get(k).songs.push(s);
    }
    if (a) {
      const k = norm(a);
      if (!artists.has(k)) artists.set(k, { kind: 'artist', name: a, songs: [], artwork: null });
      artists.get(k).songs.push(s);
    }
  }
  const byCount = (x, y) => y.songs.length - x.songs.length;
  return { albums: [...albums.values()].sort(byCount), artists: [...artists.values()].sort(byCount) };
}

/** Top result: an artist or album the query names, else the first song. */
function pickTop(q, songs, albums, artists) {
  const nq = norm(q);
  if (!nq || !songs.length) return songs[0] ? { kind: 'song', item: songs[0] } : null;
  const artist = artists.find((a) => norm(a.name) === nq || (nq.length > 3 && norm(a.name).startsWith(nq)));
  if (artist && artist.songs.length >= 2) return artist;
  const album = albums.find((a) => norm(a.name) === nq || norm(`${a.name} ${a.artist}`) === nq || (nq.length > 3 && norm(a.name).startsWith(nq)));
  if (album) return album;
  return { kind: 'song', item: songs[0] };
}

const isDl = (it) => !!(it.path || it.downloaded);
const busyDl = (d) => d && (d.state === 'active' || d.state === 'queued' || d.state === 'paused');

// ------------------------------------------------------------------ markup

/** Download state cell: Download · ring with % · Queued · Nth · Retry · Downloaded / On device. */
function stateCell(it) {
  if (it.kind === 'voice') return '';
  if (isDl(it)) {
    return it.source === 'local'
      ? `<span class="btn btn--secondary btn--sm btn-dl is-done is-static" role="img" aria-label="On this device, plays offline">${icon('device', 'icon--16')}<span class="btn-dl__label">On device</span></span>`
      : `<button class="btn btn--secondary btn--sm btn-dl is-done" type="button" data-act="dl-done" aria-label="Downloaded, plays offline">${icon('check', 'icon--16')}<span class="btn-dl__label">Downloaded</span></button>`;
  }
  const d = downloadFor(it);
  if (d && d.state === 'queued') {
    const pos = downloads.value.filter((x) => x.state === 'queued').findIndex((x) => x.id === d.id) + 1;
    return `<button class="btn btn--ghost btn--sm btn-dl btn-queued" type="button" data-act="dl-goto" aria-label="${esc(it.title)} is queued${pos ? `, ${ordinal(pos)} in line` : ''}">${icon('clock', 'icon--16')}<span class="btn-dl__label num">Queued${pos ? ` · ${ordinal(pos)}` : ''}</span></button>`;
  }
  if (d && (d.state === 'active' || d.state === 'paused')) {
    const p = Math.round((d.progress || 0) * 100);
    const paused = d.state === 'paused';
    return `<button class="dl-ring${paused ? ' is-paused' : ''}" type="button" data-act="dl-toggle" data-dl="${esc(d.id)}" data-state="${d.state}" aria-label="${paused ? 'Paused' : 'Downloading'} ${esc(it.title)}, ${p} percent. Tap to ${paused ? 'resume' : 'pause'}"><svg class="ring${paused ? ' ring--paused' : ''}" viewBox="0 0 36 36" aria-hidden="true"><circle class="ring__bg" cx="18" cy="18" r="15.5"/><circle class="ring__fg" cx="18" cy="18" r="15.5" pathLength="100" style="--p:${p}"/></svg><span class="dl-ring__label">${paused ? icon('pause', 'icon--fill dl-ring__glyph') : `${p}<small>%</small>`}</span></button>`;
  }
  if (d && d.state === 'error') return `<button class="btn btn--ghost btn--sm btn-dl btn-retry" type="button" data-act="dl-retry" data-dl="${esc(d.id)}" aria-label="Download failed: ${esc(d.error || '')}. Retry">${icon('refresh', 'icon--16')}<span class="btn-dl__label">Retry</span></button>`;
  if (!it.video_id) return '';
  return `<button class="btn btn--secondary btn--sm btn-dl" type="button" data-act="download" aria-label="Download ${esc(it.title)}"${isOnline() ? '' : ' disabled'}>${icon('download', 'icon--16')}<span class="btn-dl__label">Download</span></button>`;
}

function songRow(it, i) {
  const dl = isDl(it);
  const playing = player.current && itemKey(player.current) === itemKey(it);
  const blocked = !dl && !isOnline() && needsStream(it);
  const glyph = dl ? (it.source === 'local' ? `<i class="badge sub-dl badge--device">${icon('device')}On device</i>` : icon('check', 'sg sg--dl', 'Downloaded')) : '';
  return `<div class="row row--result song${dl ? ' is-dl' : ''}${playing ? ' is-playing' : ''}" data-idx="${i}" data-key="${esc(itemKey(it))}">
    ${artHTML(it)}
    <div class="row__main"><div class="row__title">${playing ? '<span class="eq" aria-label="Playing"><i></i><i></i><i></i></span>' : ''}${esc(it.title)}</div><div class="row__sub">${glyph}<span class="row__text">${esc(it.artist || 'Unknown artist')}${it.album ? `<span class="sub-album"> · ${esc(it.album)}</span>` : ''}</span></div></div>
    <div class="row__dur">${fmtDuration(it.duration_secs)}</div>
    <div class="row__actions">
      <span class="act act--play"><button class="btn btn--icon btn--sm row__play" type="button" data-act="play" aria-label="${playing && player.state.playing ? 'Pause' : dl ? 'Play' : 'Stream'} ${esc(it.title)}"${blocked ? ' disabled' : ''}>${icon(playing && player.state.playing ? 'pause' : 'play', 'icon--16 icon--fill')}</button></span>
      <span class="act act--state">${stateCell(it)}</span>
      <span class="act act--like"><button class="btn btn--icon btn--sm like${it.liked ? ' is-liked' : ''}" type="button" data-act="like" aria-pressed="${!!it.liked}" aria-label="${it.liked ? 'Liked' : 'Like'}">${icon('heart', 'icon--16')}</button></span>
      <span class="act act--more"><button class="btn btn--icon btn--sm row__menu" type="button" data-act="menu" aria-haspopup="menu" aria-label="More for ${esc(it.title)}">${icon('more', 'icon--16')}</button></span>
    </div>
  </div>`;
}

function groupStats(g) {
  const n = g.songs.length;
  const dl = g.songs.filter(isDl).length;
  const todo = g.songs.filter((s) => !isDl(s) && s.video_id && !busyDl(downloadFor(s)));
  return { n, dl, todo };
}

/** Top-result download button while busy — same wording as the song-row state cell. */
function topBusyBtn(d, p) {
  if (d.state === 'queued') {
    const pos = downloads.value.filter((x) => x.state === 'queued').findIndex((x) => x.id === d.id) + 1;
    return `<button class="btn btn--secondary" type="button" disabled>${icon('clock')}<span class="num">Queued${pos ? ` · ${ordinal(pos)}` : ''}</span></button>`;
  }
  if (d.state === 'paused') return `<button class="btn btn--secondary" type="button" disabled>${icon('pause', 'icon--fill')}<span class="num">Paused</span></button>`;
  return `<button class="btn btn--secondary" type="button" disabled><span class="spinner"></span><span class="num">Downloading ${p}%</span></button>`;
}

function topCard(top) {
  if (top.kind === 'song') {
    const it = top.item;
    const d = !isDl(it) && downloadFor(it);
    const busy = busyDl(d);
    const p = busy ? Math.round((d.progress || 0) * 100) : 0;
    return `<div class="card top-card" data-top="song">
      <div class="top-card__head">${artHTML(it, { size: 'xl', cls: 'top-card__art' })}
        <div class="top-card__id"><div class="cluster"><span class="badge">Song</span>${it.explicit ? '<span class="badge badge--outline">E</span>' : ''}</div><div class="top-card__title">${esc(it.title)}</div>
          <div class="meta"><span>${esc(it.artist || 'Unknown artist')}</span>${it.album ? `<span class="sep meta__extra"></span><span class="meta__extra">${esc(it.album)}</span>` : ''}<span class="sep"></span><span class="num">${fmtDuration(it.duration_secs)}</span></div></div>
      </div>
      ${busy ? `<div class="progress-line"><div class="progress-line__meta"><span><strong>${d.state === 'queued' ? 'Queued' : d.state === 'paused' ? `Paused at ${p}%` : `Downloading ${p}%`}</strong></span><span>${d.eta_secs != null && d.state === 'active' ? `${fmtEta(d.eta_secs)} left` : ''}</span></div><div class="progress" style="--p:${p}%"><i></i></div></div>` : ''}
      <div class="top-card__actions">
        <button class="btn btn--primary" type="button" data-top-act="play"${!isDl(it) && !isOnline() ? ' disabled' : ''}>${icon('play', 'icon--fill')}Play</button>
        ${isDl(it) ? `<button class="btn btn--secondary" type="button" disabled>${icon('check')}<span>Downloaded</span></button>`
          : busy ? topBusyBtn(d, p)
          : `<button class="btn btn--secondary" type="button" data-top-act="download"${isOnline() ? '' : ' disabled'}>${icon('download')}<span>Download</span></button>`}
      </div>
    </div>`;
  }
  const { n, dl, todo } = groupStats(top);
  const art = artHTML({ name: top.name, artist: top.kind === 'album' ? top.artist : '', artwork: top.artwork }, { kind: top.kind, size: 'xl', round: top.kind === 'artist', cls: 'top-card__art' });
  const meta = top.kind === 'album'
    ? `<span>${esc(top.artist)}</span><span class="sep"></span><span>${plural(n, 'song')}</span><span class="sep meta__extra"></span><span class="meta__extra num">${fmtDuration(top.songs.reduce((s, t) => s + (t.duration_secs || 0), 0))}</span>`
    : `<span>${plural(n, 'song')}</span><span class="sep"></span><span>${plural(new Set(top.songs.map((s) => s.album).filter(Boolean)).size, 'album')}</span>`;
  return `<div class="card top-card" data-top="${top.kind}">
    <div class="top-card__head">${art}
      <div class="top-card__id"><div class="cluster"><span class="badge">${top.kind === 'album' ? 'Album' : 'Artist'}</span></div><div class="top-card__title">${esc(top.name)}</div><div class="meta">${meta}</div></div>
    </div>
    <div class="progress-line">
      <div class="progress-line__meta"><span><strong>${dl} of ${n}</strong> downloaded</span><span>${todo.length ? `${todo.length} to download` : dl === n ? 'All offline' : 'Rest downloading'}</span></div>
      <div class="progress" style="--p:${n ? Math.round((dl / n) * 100) : 0}%"><i></i></div>
    </div>
    <div class="top-card__actions">
      <button class="btn btn--primary" type="button" data-top-act="play"${!isOnline() && !dl ? ' disabled' : ''}>${icon('play', 'icon--fill')}Play</button>
      <button class="btn btn--secondary" type="button" data-top-act="download-all"${todo.length && isOnline() ? '' : ' disabled'}>${icon(todo.length ? 'download' : 'check')}<span class="lbl-long">${todo.length ? `Download ${plural(todo.length, 'song')}` : 'Downloaded'}</span><span class="lbl-short">${todo.length ? 'Download' : 'Downloaded'}</span></button>
    </div>
  </div>`;
}

function albumTile(g, i) {
  const { n, dl } = groupStats(g);
  const art = artHTML({ name: g.name, artist: g.artist, artwork: g.artwork }, { kind: 'album', size: 'tile' })
    .replace(/<\/div>$/, `<span class="art__play" data-act-album="play" aria-hidden="true">${icon('play', 'icon--fill')}</span></div>`);
  return `<button class="tile" type="button" data-album="${i}" aria-label="${esc(g.name)} by ${esc(g.artist)}">${art}<div class="tile__title">${esc(g.name)}</div><div class="tile__foot"><div class="tile__sub num">${esc(g.artist)}${n ? ` · ${plural(n, 'song')}` : ''}</div><div class="tile__badges">${dl ? `<span class="badge badge--done num">${icon('check')}${dl} / ${n} downloaded</span>` : ''}</div></div></button>`;
}

function artistRow(g, i) {
  const { n, dl } = groupStats(g);
  const sub = g.songs.length ? (dl ? `Artist · ${plural(dl, 'song')} downloaded` : `Artist · ${plural(n, 'song')}`) : `Artist · ${plural(g.track_count || 0, 'song')}`;
  return `<button class="artist-row" type="button" data-artist="${i}">${artHTML({ name: g.name, artwork: g.artwork }, { kind: 'artist', round: true })}<div class="artist-row__text"><div class="artist-row__name">${esc(g.name)}</div><div class="artist-row__sub">${esc(sub)}</div></div>${icon('chevron-right')}</button>`;
}

const skelSongs = (n = 6) => Array.from({ length: n }, (_, i) => `<div class="skel-row skel-row--result" aria-hidden="true"><i class="skel skel--art"></i><div class="stack"><i class="skel skel--text skel-w${[70, 55, 80, 45, 60, 50][i % 6]}"></i><i class="skel skel--text skel-w${[40, 30, 45, 30, 40, 30][i % 6]}"></i></div><i class="skel skel--text skel-dur"></i><div class="skel-act"><i class="skel skel--circle"></i><i class="skel skel--btn"></i><i class="skel skel--circle"></i><i class="skel skel--circle"></i></div></div>`).join('');

function loadingBody() {
  return `<div class="results" aria-busy="true">
    <section class="group"><div class="section-head"><h3>Top result</h3></div><div class="card top-card top-card--skel"><div class="top-card__head"><i class="skel skel--art"></i><div class="top-card__id"><div class="skel-badges"><i class="skel"></i></div><i class="skel skel--title skel-w80"></i><i class="skel skel--text skel-w60"></i></div></div><i class="skel skel--text"></i><div class="top-card__actions"><i class="skel skel--pill"></i><i class="skel skel--pill"></i></div></div></section>
    <section class="group"><div class="section-head"><h3>Songs</h3></div><div class="list">${skelSongs()}</div></section>
  </div>
  <div class="discog" aria-busy="true">
    <section class="group group--albums"><div class="section-head"><h3>Albums</h3></div><div class="skel-tiles">${Array.from({ length: 4 }, () => '<div class="skel-tile"><i class="skel skel--tile"></i><i class="skel skel--title skel-w80"></i><i class="skel skel--text skel-w50"></i></div>').join('')}</div></section>
    <section class="group group--artists"><div class="section-head"><h3>Artists</h3></div><div class="list">${Array.from({ length: 2 }, () => '<div class="skel-artist"><i class="skel skel--round"></i><div class="stack"><i class="skel skel--text skel-w60"></i><i class="skel skel--text skel-w40"></i></div></div>').join('')}</div></section>
  </div>`;
}

// ------------------------------------------------------------------ view

export default {
  title: 'Search',
  topbarSearch: false,

  async render(root, params) {
    const cleanups = [];
    let alive = true;
    let query = (params.q || '').trim();
    let source = params.src === 'library' || !isOnline() ? 'library' : 'youtube';
    let filter = ['songs', 'albums', 'artists'].includes(params.show) ? params.show : 'all';
    let status = query ? 'loading' : 'idle';   // idle | loading | ok | empty | error
    let errorMsg = '';
    let songs = [];            // what the rows index (current source)
    let ytSongs = [], libSongs = [], albums = [], artists = [], top = null;
    let libCount = 0;
    let token = 0;
    let startedAt = 0;
    let elapsedTimer = null;

    root.innerHTML = `<div class="page">
      <div class="search-head">
        <form class="search-row" data-form role="search">
          <div class="search search--lg">${icon('search')}<input class="search__input" data-q type="search" enterkeyhint="search" value="${esc(query)}" placeholder="Songs, albums or artists" aria-label="Search YouTube Music and your library" autocomplete="off" spellcheck="false"><button class="btn btn--icon search__clear" type="button" data-clear aria-label="Clear search"${query ? '' : ' hidden'}>${icon('x', 'icon--16')}</button></div>
          <a class="btn btn--ghost btn--sm desktop-only dl-status" data-pill href="#downloads" hidden></a>
        </form>
        <div data-scope></div>
      </div>
      <div class="search-body" data-body></div>
    </div>`;
    const input = root.querySelector('[data-q]');
    const scopeEl = root.querySelector('[data-scope]');
    const body = root.querySelector('[data-body]');
    const clearBtn = root.querySelector('[data-clear]');
    if (!isPhone() && !query) setTimeout(() => input.focus(), 0);

    function setUrl() {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (source === 'library' && isOnline()) qs.set('src', 'library');
      if (filter !== 'all') qs.set('show', filter);
      const h = `#search${qs.toString() ? `?${qs}` : ''}`;
      if (location.hash !== h) history.replaceState(history.state, '', h);
    }

    // ---- scope row (source switch + type chips + meta)
    function paintScope() {
      if (!query) { scopeEl.innerHTML = ''; return; }
      const off = !isOnline();
      const counts = { songs: songs.length, albums: albums.length, artists: artists.length };
      const ready = status === 'ok';
      const chip = (v, label) => `<button class="chip${filter === v ? ' is-selected' : ''}" type="button" role="tab" aria-selected="${filter === v}" data-filter="${v}"${ready || v === 'all' ? '' : ' disabled'}>${label}${v !== 'all' && ready ? ` <span class="chip__count">${counts[v]}</span>` : ''}</button>`;
      const dlCount = songs.filter(isDl).length;
      const inLib = source === 'youtube' ? songs.filter((s) => s.id).length : libCount;
      const where = source === 'youtube' ? 'on YouTube Music' : 'in your library';
      const meta = ready ? `<div class="meta"><span><strong class="strong">${[plural(counts.songs, 'song'), counts.albums && plural(counts.albums, 'album'), counts.artists && plural(counts.artists, 'artist')].filter(Boolean).join(' · ')}</strong> ${where}</span>${source === 'youtube' ? `<span class="sep meta__extra"></span><span class="meta__extra">${fmtNum(dlCount)} downloaded · ${fmtNum(inLib)} in your library</span>` : ''}</div>` : '';
      scopeEl.innerHTML = `<div class="scope">
          <div class="seg source-seg" role="tablist" aria-label="Search in">
            <button class="seg__btn${source === 'youtube' ? ' is-active' : ''}" type="button" role="tab" aria-selected="${source === 'youtube'}" data-source="youtube"${off ? ' disabled title="Needs internet"' : ''}>${icon(off ? 'offline' : 'ytm')}YouTube Music</button>
            <button class="seg__btn${source === 'library' ? ' is-active' : ''}" type="button" role="tab" aria-selected="${source === 'library'}" data-source="library">${icon('library')}Your library${libCount != null ? ` <span class="chip__count">${fmtNum(libCount)}</span>` : ''}</button>
          </div>
          ${off ? '' : `<div class="chips chips--scroll" role="tablist" aria-label="Show">${chip('all', 'All')}${chip('songs', 'Songs')}${chip('albums', 'Albums')}${chip('artists', 'Artists')}</div>
          <div class="scope-note t-13 muted">${icon('ytm', 'icon--16')}Play streams it · Download keeps it offline</div>`}
        </div>${off ? '' : meta}`;
    }

    // ---- body
    function paintBody() {
      clearInterval(elapsedTimer);
      if (!query) { paintRecent(); return; }
      if (status === 'loading') {
        const where = source === 'youtube' ? 'YouTube Music' : 'your library';
        body.innerHTML = `<div class="loading-line t-13 muted num"><div class="progress progress--indeterminate progress--thin"><i></i></div><span data-elapsed>Searching ${where} for “${esc(query)}”</span></div>${loadingBody()}`;
        const el = body.querySelector('[data-elapsed]');
        elapsedTimer = setInterval(() => { el.textContent = `Searching ${where} for “${query}” · ${((Date.now() - startedAt) / 1000).toFixed(1)} s`; }, 100);
        return;
      }
      if (status === 'error') {
        body.innerHTML = `<div class="card card--flush">${emptyState({ icon: 'alert', error: true, title: 'YouTube Music didn’t respond', text: `${errorMsg.replace(/\.?$/, '.')} Check the connection, or search your library meanwhile.`, actions: `<button class="btn btn--secondary" type="button" data-retry>${icon('refresh')}Try again</button><button class="btn btn--ghost" type="button" data-source="library">${icon('library')}Search your library</button>` })}</div>`;
        return;
      }
      const off = !isOnline();
      const banner = off ? `<div class="banner banner--warn">${icon('offline')}<div class="banner__body"><div class="banner__title">Search needs internet — showing your library matches</div><div class="banner__text">Streaming and new downloads come back when you reconnect.</div></div><button class="btn btn--secondary btn--sm" type="button" data-retry-online>${icon('refresh', 'icon--16')}Retry</button></div>` : '';
      if (status === 'empty') {
        const words = query.split(/\s+/);
        const shorter = words.length > 1 ? words.slice(0, Math.max(1, Math.ceil(words.length / 3))).join(' ') : '';
        const where = source === 'youtube' ? 'on YouTube Music' : 'in your library';
        const actions = [shorter ? `<button class="btn btn--primary" type="button" data-search="${esc(shorter)}">${icon('search')}Search “${esc(shorter)}”</button>` : '',
          source === 'library' && !off ? `<button class="btn btn--secondary" type="button" data-source="youtube">${icon('ytm')}Search YouTube Music</button>` : ''].join('');
        body.innerHTML = `${banner}<div class="card card--flush">${emptyState({ icon: 'search', title: 'No results', text: `Nothing ${where} matches “${query}”. Check the spelling, or search just the artist or song name.`, actions })}</div>`;
        return;
      }
      if (off || source === 'library') { body.innerHTML = banner + libraryBody(); return; }
      body.innerHTML = youtubeBody();
    }

    function songsSection(list, { title = 'Songs', sub, showAll, playAll } = {}) {
      return `<section class="group" aria-labelledby="h-songs"><div class="section-head"><h3 id="h-songs">${title}<span class="section-head__sub num">${sub}</span></h3>${showAll ? `<button class="btn btn--ghost btn--sm" type="button" data-filter="songs">Show all</button>` : ''}${playAll ? `<button class="btn btn--secondary btn--sm" type="button" data-play-all>${icon('play', 'icon--16 icon--fill')}Play all</button>` : ''}</div>
        <div class="list" data-songs>${list.map((s) => songRow(s, songs.indexOf(s))).join('')}</div></section>`;
    }
    const albumsSection = (list, showAll) => `<section class="group group--albums" aria-labelledby="h-albums"><div class="section-head"><h3 id="h-albums">Albums<span class="section-head__sub num">${plural(albums.length, 'result')}</span></h3>${showAll ? '<button class="btn btn--ghost btn--sm" type="button" data-filter="albums">Show all</button>' : ''}</div><div class="album-grid${filter === 'albums' ? ' album-grid--all' : ''}">${list.map((g) => albumTile(g, albums.indexOf(g))).join('')}</div></section>`;
    const artistsSection = (list, showAll) => `<section class="group group--artists" aria-labelledby="h-artists"><div class="section-head"><h3 id="h-artists">Artists<span class="section-head__sub num">${plural(artists.length, 'result')}</span></h3>${showAll ? '<button class="btn btn--ghost btn--sm" type="button" data-filter="artists">Show all</button>' : ''}</div><div class="artist-list">${list.map((g) => artistRow(g, artists.indexOf(g))).join('')}</div></section>`;

    function youtubeBody() {
      if (filter === 'songs') return songsSection(songs, { sub: plural(songs.length, 'result') });
      if (filter === 'albums') return albums.length ? albumsSection(albums, false) : `<div class="card">${emptyState({ icon: 'disc', compact: true, title: 'No albums in these results' })}</div>`;
      if (filter === 'artists') return artists.length ? artistsSection(artists, false) : `<div class="card">${emptyState({ icon: 'user', compact: true, title: 'No artists in these results' })}</div>`;
      const shown = songs.slice(0, OVERVIEW_SONGS);
      return `<div class="results">
          <section class="group" aria-labelledby="h-top"><div class="section-head"><h3 id="h-top">Top result</h3></div>${top ? topCard(top) : ''}</section>
          ${songsSection(shown, { sub: plural(songs.length, 'result'), showAll: songs.length > OVERVIEW_SONGS })}
        </div>
        ${albums.length || artists.length ? `<div class="discog">${albums.length ? albumsSection(albums.slice(0, 6), albums.length > 4) : ''}${artists.length ? artistsSection(artists.slice(0, 3), artists.length > 3) : ''}</div>` : ''}`;
    }

    function libraryBody() {
      const off = !isOnline();
      if (off || filter === 'songs') return songsSection(songs, { sub: `${fmtNum(songs.length)} in your library`, playAll: songs.length > 1 });
      if (filter === 'albums') return albums.length ? albumsSection(albums, false) : `<div class="card">${emptyState({ icon: 'disc', compact: true, title: 'No albums match' })}</div>`;
      if (filter === 'artists') return artists.length ? artistsSection(artists, false) : `<div class="card">${emptyState({ icon: 'user', compact: true, title: 'No artists match' })}</div>`;
      return `${songsSection(songs.slice(0, 12), { sub: `${fmtNum(songs.length)} in your library`, showAll: songs.length > 12, playAll: songs.length > 1 })}
        ${albums.length || artists.length ? `<div class="discog">${albums.length ? albumsSection(albums.slice(0, 6), albums.length > 4) : ''}${artists.length ? artistsSection(artists.slice(0, 3), artists.length > 3) : ''}</div>` : ''}`;
    }

    function paintRecent() {
      const list = readRecent();
      if (!list.length) {
        body.innerHTML = `<div class="card card--flush recent">${emptyState({ icon: 'search', title: isOnline() ? 'Search YouTube Music' : 'Search your library', text: isOnline() ? 'Find any song, album or artist. Play streams it right away; Download keeps it for offline.' : 'You’re offline, so search looks through the music already on this device.' })}</div>`;
        return;
      }
      body.innerHTML = `<section class="group recent" aria-labelledby="h-recent"><div class="section-head"><h3 id="h-recent">Recent searches</h3><button class="btn btn--ghost btn--sm" type="button" data-recent-clear>Clear all</button></div>
        <div class="list">${list.map((e, i) => {
          const lead = e.type === 'query' ? `<div class="recent-ic">${icon('clock')}</div>`
            : e.type === 'song' ? artHTML(e.item || { title: e.title, artist: e.sub })
              : artHTML({ name: e.title, artist: e.type === 'album' ? e.sub : '' }, { kind: e.type, round: e.type === 'artist' });
          const sub = e.type === 'query' ? `Search · ${fmtAgo(e.at)}` : e.type === 'song' ? `Song · ${e.sub || ''}` : e.type === 'album' ? `Album · ${e.sub || ''}` : 'Artist';
          return `<div class="row row--recent" data-recent="${i}" role="button" tabindex="0">${lead}<div class="row__main"><div class="row__title">${esc(e.title)}</div><div class="row__sub"><span class="row__text">${esc(sub)}</span></div></div><button class="btn btn--icon btn--sm" type="button" data-recent-remove="${i}" aria-label="Remove ${esc(e.title)} from recent searches">${icon('x', 'icon--16')}</button></div>`;
        }).join('')}</div></section>`;
    }

    // ---- searching
    async function run({ record = false } = {}) {
      const my = ++token;
      setUrl();
      clearBtn.hidden = !query;
      if (!query) { status = 'idle'; songs = []; paintScope(); paintBody(); return; }
      if (!isOnline()) source = 'library';
      status = 'loading';
      startedAt = Date.now();
      paintScope();
      paintBody();
      if (PREVIEW_STATE === 'loading') return;
      try {
        // Library matches always load (segment count, offline fallback).
        const libP = Promise.all([api.tracks('music', { query, sort: 'title', limit: 200 }), api.albums(query).catch(() => []), api.artists(query).catch(() => [])]);
        let yt = null;
        if (source === 'youtube') {
          if (PREVIEW_STATE === 'error') { await new Promise((r) => setTimeout(r, 400)); throw new Error('Timed out after 15 s'); }
          yt = await withLibrary(await api.youtubeSearch(query, YT_LIMIT));
        }
        const [lib, libAlbums, libArtists] = await libP;
        if (my !== token || !alive) return;
        libSongs = lib;
        libCount = lib.length;
        if (source === 'youtube') {
          ytSongs = yt;
          songs = ytSongs;
          ({ albums, artists } = groupSongs(songs));
          top = pickTop(query, songs, albums, artists);
          // Resolve stream links for the first streamable results so Play starts at once (D22).
          api.youtubePrefetch(songs.filter((s) => needsStream(s)).slice(0, 3).map((s) => s.video_id));
        } else {
          songs = libSongs;
          const grouped = groupSongs(songs);
          albums = libAlbums.length ? libAlbums.map((a) => ({ kind: 'album', name: a.name, artist: a.artist || '', artwork: a.artwork || null, songs: songs.filter((s) => s.album === a.name && (!a.artist || s.artist === a.artist)), track_count: a.track_count })) : grouped.albums;
          artists = libArtists.length ? libArtists.map((a) => ({ kind: 'artist', name: a.name, artwork: a.artwork || null, songs: songs.filter((s) => primaryArtist(s.artist) === a.name || s.artist === a.name), track_count: a.track_count })) : grouped.artists;
          top = null;
        }
        status = songs.length || albums.length || artists.length ? 'ok' : 'empty';
        if (record && status === 'ok') pushRecent({ type: 'query', title: query });
      } catch (e) {
        if (my !== token || !alive) return;
        status = 'error';
        errorMsg = e?.message || String(e);
      }
      paintScope();
      paintBody();
    }
    const runSoon = debounce(() => run(), 400);

    // ---- events
    root.querySelector('[data-form]').addEventListener('submit', (e) => {
      e.preventDefault();
      query = input.value.trim();
      run({ record: true });
      if (isPhone()) input.blur();
    });
    input.addEventListener('input', () => {
      const v = input.value.trim();
      clearBtn.hidden = !input.value;
      if (v === query) return;
      query = v;
      if (!query) { run(); return; }
      runSoon();
    });
    clearBtn.addEventListener('click', () => { input.value = ''; query = ''; filter = 'all'; run(); input.focus(); });

    cleanups.push(on(root, 'click', '[data-source]', (e, b) => {
      if (b.disabled) return;
      source = b.dataset.source;
      filter = 'all';
      run();
    }));
    cleanups.push(on(root, 'click', '[data-filter]', (e, b) => {
      filter = b.dataset.filter;
      setUrl(); paintScope(); paintBody();
      if (b.closest('.section-head')) root.closest('.main, #main')?.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    cleanups.push(on(root, 'click', '[data-retry]', () => run()));
    cleanups.push(on(root, 'click', '[data-retry-online]', () => {
      if (PREVIEW_STATE !== 'offline' && navigator.onLine) { online.set(true); source = 'youtube'; run(); }
      else toast('Still offline — showing what’s on this device', { kind: 'info' });
    }));
    cleanups.push(on(root, 'click', '[data-search]', (e, b) => { query = b.dataset.search; input.value = query; run({ record: true }); }));
    cleanups.push(on(root, 'click', '[data-play-all]', () => {
      const list = isOnline() ? songs : songs.filter((s) => !needsStream(s));
      if (list.length) player.play(list, 0, { type: 'search', name: `“${query}”` });
    }));

    // Recent searches
    cleanups.push(on(root, 'click', '[data-recent-clear]', () => { writeRecent([]); paintBody(); }));
    cleanups.push(on(root, 'click', '[data-recent-remove]', (e, b) => {
      e.stopPropagation();
      const list = readRecent();
      list.splice(Number(b.dataset.recentRemove), 1);
      writeRecent(list);
      paintBody();
    }));
    cleanups.push(on(root, 'click', '[data-recent]', (e, row) => {
      if (e.target.closest('[data-recent-remove]')) return;
      const entry = readRecent()[Number(row.dataset.recent)];
      if (!entry) return;
      if (entry.type === 'song' && entry.item) {
        const it = entry.item;
        if (!isOnline() && needsStream(it)) { toast('This song streams — it needs internet', { kind: 'info' }); return; }
        pushRecent(entry);
        player.play([it], 0, { type: 'search', name: 'Recent searches' });
        return;
      }
      query = entry.type === 'album' ? `${entry.title} ${entry.sub || ''}`.trim() : entry.title;
      input.value = query;
      run({ record: entry.type === 'query' });
    }));
    cleanups.push(on(root, 'keydown', '[data-recent]', (e, row) => { if (e.key === 'Enter' && e.target === row) row.click(); }));

    // Song rows: play / like / download / ⋯ via the shared binder (rows re-render via rowFor).
    cleanups.push(bindTrackList(body, {
      items: () => songs, player,
      context: null,
      rowFor: (it, i) => songRow(it, i),
      onPlay: (item, idx) => {
        const cur = player.current;
        if (cur && itemKey(cur) === itemKey(item) && player.state.index >= 0) { player.toggle(); return true; }
        if (!isOnline() && needsStream(item)) { toast('This song streams — it needs internet', { kind: 'info' }); return true; }
        pushRecent({ type: 'song', title: item.title, sub: item.artist || '', item: { ...ytShape(item), ...item } });
        const list = isOnline() ? songs : songs.filter((s) => !needsStream(s));
        player.play(list, Math.max(0, list.indexOf(item)), { type: 'search', name: `“${query}”` });
        return true;
      },
    }));
    cleanups.push(on(body, 'click', '[data-act="dl-done"]', (e) => { e.stopPropagation(); toast('Downloaded — plays offline', { kind: 'ok' }); }));
    cleanups.push(on(body, 'click', '[data-act="dl-goto"]', (e) => { e.stopPropagation(); location.hash = '#downloads'; }));
    cleanups.push(on(body, 'click', '[data-act="dl-toggle"]', async (e, b) => {
      e.stopPropagation();
      const id = b.dataset.dl;
      if (b.dataset.state === 'paused') await guard(() => api.resumeDownload(id));
      else await guard(() => api.pauseDownload(id), 'Download paused');
      pokeDownloads();
    }));
    cleanups.push(on(body, 'click', '[data-act="dl-retry"]', async (e, b) => { e.stopPropagation(); await guard(() => api.retryDownload(b.dataset.dl), 'Retrying download'); pokeDownloads(); }));

    // Top result
    async function downloadMany(list) {
      let n = 0;
      for (const it of list) {
        try {
          const id = it.id && it.video_id ? await api.downloadTrack(it.id) : await api.youtubeDownload(ytShape(it));
          rememberDownload(id, it); n++;
        } catch (err) { console.warn('download failed', err); }
      }
      pokeDownloads();
      if (n) toast(`Downloading ${plural(n, 'song')}`, { kind: 'info', action: { label: 'View', run: () => { location.hash = '#downloads'; } } });
      else toast('Couldn’t start the downloads', { kind: 'danger' });
    }
    cleanups.push(on(body, 'click', '[data-top-act]', async (e, b) => {
      if (!top) return;
      const act = b.dataset.topAct;
      const list = top.kind === 'song' ? [top.item] : top.songs;
      const playable = isOnline() ? list : list.filter((s) => !needsStream(s));
      if (act === 'play' && playable.length) {
        pushRecent(top.kind === 'song' ? { type: 'song', title: top.item.title, sub: top.item.artist || '', item: { ...ytShape(top.item), ...top.item } } : { type: top.kind, title: top.name, sub: top.kind === 'album' ? top.artist : '' });
        player.play(playable, 0, top.kind === 'album' ? { type: 'album', name: top.name } : top.kind === 'artist' ? { type: 'artist', name: top.name } : { type: 'search', name: `“${query}”` });
      }
      if (act === 'download') { const { download } = await import('../components/actions.js'); await download(top.item); }
      if (act === 'download-all') { b.disabled = true; await downloadMany(groupStats(top).todo); }
    }));

    // Albums / artists: open = search for them; the tile's play button plays the album songs.
    cleanups.push(on(body, 'click', '[data-album]', (e, t) => {
      const g = albums[Number(t.dataset.album)];
      if (!g) return;
      if (e.target.closest('[data-act-album="play"]') && g.songs.length) {
        const list = isOnline() ? g.songs : g.songs.filter((s) => !needsStream(s));
        if (list.length) player.play(list, 0, { type: 'album', name: g.name });
        return;
      }
      pushRecent({ type: 'album', title: g.name, sub: g.artist });
      query = `${g.name} ${g.artist}`.trim(); input.value = query; filter = 'all'; run();
    }));
    cleanups.push(on(body, 'click', '[data-artist]', (e, t) => {
      const g = artists[Number(t.dataset.artist)];
      if (!g) return;
      pushRecent({ type: 'artist', title: g.name });
      query = g.name; input.value = query; filter = 'all'; run();
    }));

    // ---- live state
    const pill = root.querySelector('[data-pill]');
    function paintPill(list) {
      const s = downloadSummary(list);
      const pct = Math.round(s.progress * 100);
      pill.hidden = !s.count;
      if (!s.count) return;
      const off = !isOnline();
      pill.setAttribute('aria-label', off ? `${s.count} downloads paused until you reconnect` : `${s.count} downloading, ${pct} percent${s.eta ? `, ${fmtEta(s.eta)} left` : ''}`);
      pill.innerHTML = off
        ? `${icon('offline', 'icon--16')}<span><span class="strong">${s.count} paused</span> · resume when online</span><i class="dl-status__bar" style="--p:${pct}%"></i>`
        : `${icon('download', 'icon--16')}<span><span class="strong">${s.count} downloading</span> · ${pct}%${s.eta ? ` · ${fmtEta(s.eta)} left` : ''}</span><i class="dl-status__bar" style="--p:${pct}%"></i>`;
    }
    function patchStates() {
      body.querySelectorAll('[data-songs] .row[data-idx]').forEach((row) => {
        const it = songs[Number(row.dataset.idx)];
        const cell = row.querySelector('.act--state');
        if (!it || !cell) return;
        const html = stateCell(it);
        if (cell.dataset.html !== html) { cell.dataset.html = html; cell.innerHTML = html; }
      });
      const tc = body.querySelector('.top-card');
      if (tc && top && status === 'ok') { const fresh = topCard(top); if (tc.dataset.html !== fresh) { const el = document.createElement('template'); el.innerHTML = fresh.trim(); el.content.firstElementChild.dataset.html = fresh; tc.replaceWith(el.content.firstElementChild); } }
    }
    function patchPlaying() {
      const cur = player.current;
      const key = cur ? itemKey(cur) : '';
      const playing = player.state.playing;
      body.querySelectorAll('[data-songs] .row[data-idx]').forEach((row) => {
        const on2 = !!key && row.dataset.key === key;
        const was = row.dataset.spp;
        const now = `${on2}:${playing}`;
        if (was === now) return;
        row.dataset.spp = now;
        row.classList.toggle('is-playing', on2);
        const title = row.querySelector('.row__title');
        const eq = title.querySelector('.eq');
        if (on2 && !eq) title.insertAdjacentHTML('afterbegin', '<span class="eq" aria-label="Playing"><i></i><i></i><i></i></span>');
        if (!on2 && eq) eq.remove();
        const btn = row.querySelector('[data-act="play"]');
        if (btn) btn.innerHTML = icon(on2 && playing ? 'pause' : 'play', 'icon--16 icon--fill');
      });
    }
    cleanups.push(downloads.subscribe((list) => { paintPill(list); patchStates(); }));
    cleanups.push(player.subscribe(() => patchPlaying()));

    // A finished download / like elsewhere: refresh the library state of the visible results.
    const onLib = async () => {
      if (status !== 'ok' || !songs.length) return;
      if (source === 'youtube') {
        const merged = await withLibrary(songs.map((s) => ({ ...s, local_track_id: s.id || s.local_track_id })));
        if (!alive) return;
        merged.forEach((m, i) => { Object.assign(songs[i], m); });
        paintScope(); paintBody();
      }
    };
    const onNet = () => { source = isOnline() ? 'youtube' : 'library'; run(); };
    addEventListener('library:changed', onLib);
    addEventListener('online:changed', onNet);
    cleanups.push(() => { removeEventListener('library:changed', onLib); removeEventListener('online:changed', onNet); clearInterval(elapsedTimer); });

    paintScope();
    paintBody();
    if (query) run({ record: false });

    return () => { alive = false; token++; cleanups.forEach((fn) => { try { fn?.(); } catch {} }); };
  },
};
