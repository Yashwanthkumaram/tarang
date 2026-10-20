// Home (design/screens/home.html): greeting + one primary action (shuffle), Liked songs /
// Downloads shortcuts with live download progress, Continue listening (live progress for
// the loaded song), Quick picks from YouTube Music (stream / download / like / ⋯),
// Recently played tiles. States: loading skeleton, fresh install, offline (downloads only),
// Quick picks error, missing files. Styles: styles/views/home.css.
//
// Data: get_stats, list_recent, list_playlists (Liked songs counts), storage_info,
// youtube_search (Quick picks, seeded from recently played artists; DECISIONS D33),
// get_track (library state of a pick), list_tracks.
// Review switch (browser preview only): ?state=loading|fresh|offline|error.

import { api, isTauri } from '../api.js';
import { artHTML } from '../components/art.js';
import { tile } from '../components/tiles.js';
import { bindTrackList } from '../components/tracks.js';
import { downloadFor, downloadSummary, downloads, itemKey, online, playlists, pokeDownloads, settings } from '../components/store.js';
import { needsStream, player } from '../player.js';
import { emptyState, esc, fmtAgo, fmtBytes, fmtDuration, fmtLongDuration, fmtNum, greeting, guard, icon, on, plural, ring, toast } from '../ui.js';

const PREVIEW_STATE = !isTauri ? new URLSearchParams(location.search).get('state') : null;
const QP_CACHE = 'home.quickpicks';
const QP_COUNT = 8;              // phone shows 2 pages of 4; desktop shows the first 6 (2 × 3)
const CL_COUNT = 4;
const RP_COUNT = 7;

const isVoice = (t) => t?.kind === 'voice' || t?.kind === 'unsure';
const isOnline = () => PREVIEW_STATE !== 'offline' && online.value !== false;
const ss = (k, v) => { try { if (v === undefined) return JSON.parse(sessionStorage.getItem(k) || 'null'); sessionStorage.setItem(k, JSON.stringify(v)); } catch {} return null; };

/** 6 s · 1:40 — the compact "left" figure used by the design. */
const fmtLeft = (secs) => (secs == null ? '' : secs < 60 ? `${Math.max(0, Math.round(secs))} s` : fmtDuration(secs));
/** 2:34 left · 14 min left — Continue listening's right-hand figure. */
const fmtLeftLong = (secs) => (secs < 600 ? `${fmtDuration(secs)} left` : `${fmtLongDuration(secs)} left`);

/** Merges each YouTube result with its library row (liked / downloaded / path) when one exists. */
async function withLibrary(list) {
  // A pick downloaded since the search has no local_track_id yet; its download knows the row.
  const localId = (r) => r.local_track_id || downloadFor(r)?.track_id || null;
  const ids = [...new Set(list.map(localId).filter(Boolean))];
  const rows = await Promise.all(ids.map((id) => api.track(id).catch(() => null)));
  const byId = new Map(rows.filter(Boolean).map((t) => [t.id, t]));
  return list.map((r) => {
    const t = byId.get(localId(r));
    if (t) return { ...r, ...t, video_id: t.video_id || r.video_id, thumbnail: t.thumbnail || r.thumbnail };
    return { ...r, id: null, path: null, downloaded: false, liked: false, kind: 'music', source: 'youtube' };
  });
}

/** Quick picks: YouTube Music searches seeded with the artists played most recently. */
async function fetchQuickPicks(recent, rotate = 0) {
  const artists = [];
  for (const t of recent) {
    const a = (t.artist || '').split(/,|&| feat\.? /i)[0].trim();
    if (a && !isVoice(t) && !artists.includes(a)) artists.push(a);
  }
  const seeds = artists.length ? artists.slice(rotate % artists.length).concat(artists.slice(0, rotate % artists.length)).slice(0, 3) : [];
  const popular = !seeds.length;
  const batches = await Promise.all((popular ? ['top hits'] : seeds).map((q) => api.youtubeSearch(q, popular ? QP_COUNT : 5)));
  const seen = new Set();
  const out = [];
  // Interleave the seeds so one artist doesn't fill the whole grid.
  for (let i = 0; out.length < QP_COUNT && batches.some((b) => b[i]); i++) {
    for (const b of batches) {
      const r = b[i];
      if (r && !seen.has(r.video_id) && out.length < QP_COUNT) { seen.add(r.video_id); out.push(r); }
    }
  }
  if (out.length < QP_COUNT && !popular) {
    for (const r of await api.youtubeSearch('top hits', QP_COUNT)) {
      if (!seen.has(r.video_id) && out.length < QP_COUNT) { seen.add(r.video_id); out.push(r); }
    }
  }
  return { items: out, popular };
}

// ------------------------------------------------------------------ markup

function skeleton() {
  const skelSc = `<div class="card skel-sc"><span class="skel skel--art"></span><div class="stack"><span class="skel skel--text w-40"></span><span class="skel skel--text w-80"></span></div></div>`;
  const skelCl = (d) => `<div class="card skel-cl${d ? ' desktop-only' : ''}"><div class="skel-cl__top"><span class="skel skel--art"></span><div class="stack"><span class="skel skel--text w-80"></span><span class="skel skel--text w-40"></span></div></div><span class="skel skel-bar"></span></div>`;
  return `<div class="page" aria-busy="true">
    <div class="stack stack--2 skel-head"><span class="skel skel--title" style="width:200px;height:28px"></span><span class="skel skel--text" style="width:260px"></span></div>
    <div class="sc-grid">${skelSc}${skelSc}</div>
    <section><div class="section-head"><h3>Continue listening</h3></div><div class="cl-grid">${skelCl()}${skelCl()}${skelCl(1)}${skelCl(1)}</div></section>
    <section><div class="section-head"><div class="qp-head"><h3>Quick picks</h3><span class="section-head__sub qp-fetch"><span class="spinner"></span>Fetching from YouTube Music…</span></div></div>${qpSkeleton()}</section>
    <section><div class="section-head"><h3>Recently played</h3></div><div class="tile-row rp">${Array.from({ length: 6 }, () => '<div class="stack stack--2 skel-tile"><i class="skel skel--tile"></i><i class="skel skel--title w-80"></i><i class="skel skel--text w-40"></i></div>').join('')}</div></section>
  </div>`;
}

const qpSkeleton = () => `<div class="qp-grid">${Array.from({ length: QP_COUNT }, (_, i) => `<div class="skel-row skel-qp${i >= 6 ? ' qp--page2' : ''}"><span class="skel skel--art"></span><div class="stack"><span class="skel skel--text w-80"></span><span class="skel skel--text w-40"></span></div><span class="skel skel--circle" style="width:24px;height:24px"></span></div>`).join('')}</div>`;

/** Liked songs + Downloads shortcut cards. */
function shortcuts(m) {
  const liked = m.likedPl;
  const likedSub = !liked?.track_count ? 'No songs yet — tap ♥ on any song'
    : `${fmtNum(liked.downloaded_count)} of ${fmtNum(liked.track_count)} offline`;
  const likedBar = liked?.track_count && !m.fresh ? `<span class="sc__progress"><span class="progress progress--thin" style="--p:${Math.round((liked.downloaded_count / liked.track_count) * 100)}%"><i></i></span></span>` : '';
  const dlSub = m.stats.downloaded ? `${plural(m.stats.downloaded, 'song')}${m.storage?.downloads_bytes ? ` · ${fmtBytes(m.storage.downloads_bytes)}` : ''}` : 'Nothing downloaded yet';
  return `<section class="sc-section" aria-label="Shortcuts"><div class="sc-grid">
    <a class="card card--interactive sc" href="#playlist/0">
      <span class="sc__art sc__art--liked">${icon('heart', 'icon--24 icon--fill')}</span>
      <span class="sc__body"><span class="sc__title">Liked songs</span><span class="sc__sub num">${likedSub}</span>${likedBar}</span>
      ${icon('chevron-right', 'icon--16 sc__chev')}
    </a>
    <a class="card card--interactive sc" href="#downloads">
      <span class="sc__art sc__art--dl">${icon('download', 'icon--24')}</span>
      <span class="sc__body"><span class="sc__title">Downloads</span><span class="sc__sub num">${dlSub}</span>${m.stats.downloaded ? '' : '<span class="sc__hint">Tap ↓ on a song to keep it offline</span>'}<span class="sc__live num" data-dl-live hidden></span></span>
      ${icon('chevron-right', 'icon--16 sc__chev')}
    </a>
  </div></section>`;
}

/** The live line under Downloads: "3 downloading · 62% · 1:40 left" / offline "3 paused · waiting for internet". */
function dlLive(list) {
  if (!isOnline()) {
    const waiting = list.filter((d) => d.state === 'active' || d.state === 'queued' || d.state === 'paused');
    if (!waiting.length) return '';
    const p = waiting.reduce((s, d) => s + (d.progress || 0), 0) / waiting.length;
    return `${ring(p, 'ring--sm ring--paused')}<span><strong>${waiting.length} paused</strong> · waiting for internet</span>`;
  }
  const s = downloadSummary(list);
  if (!s.count) return s.failed ? `<span><strong>${s.failed} failed</strong> · tap to retry</span>` : '';
  const p = Math.round(s.progress * 100);
  return `${ring(s.progress)}<span><strong>${s.count} downloading</strong> · ${p}%${s.eta ? ` · ${fmtDuration(s.eta)} left` : ''}</span>`;
}

/** Kind badge(s) on a Continue listening card. */
function clBadges(it, extra = '') {
  if (isVoice(it)) {
    const own = Number((() => { try { return localStorage.getItem(`voice.speed.${it.id}`); } catch { return null; } })()) || Number(settings.value?.['playback.voice_speed']) || 1;
    return `<span class="badge badge--voice">Voice</span>${own !== 1 ? `<span class="badge badge--outline num">${own}×</span>` : ''}`;
  }
  if (it.path && it.downloaded === false) return `<span class="badge badge--danger">File missing</span>`;
  if (needsStream(it)) return isOnline() ? `<span class="badge badge--stream">${icon('stream')}Streaming</span>` : `<span class="badge badge--stream">${icon('offline')}Needs internet</span>`;
  return `<span class="badge badge--ok">${icon('check')}${it.source === 'local' ? 'On this device' : 'Downloaded'}</span>${extra}`;
}

/** Resume info for a song: the player's live state for the loaded song, else player.resumeInfo() when available. */
function resumeOf(it) {
  const cur = player.current;
  if (cur && itemKey(cur) === itemKey(it)) { const s = player.state; return { position: s.position, duration: s.duration || it.duration_secs, live: true }; }
  const r = typeof player.resumeInfo === 'function' ? player.resumeInfo(it) : null;
  return r && r.position > 0 ? { position: r.position, duration: r.duration || it.duration_secs } : null;
}

function clProgress(it, r) {
  const rate = isVoice(it) ? (player.current && itemKey(player.current) === itemKey(it) ? player.state.rate || 1 : 1) : 1;
  if (!r) return `<div class="progress-line"><div class="progress progress--thin" style="--p:0%"><i></i></div><div class="progress-line__meta"><span>${it.last_played_at ? `Played ${fmtAgo(it.last_played_at)}` : 'Not started'}</span><strong>${fmtDuration(it.duration_secs)}</strong></div></div>`;
  const dur = r.duration || it.duration_secs || 0;
  const left = Math.max(0, dur - r.position) / rate;
  return `<div class="progress-line" data-live="${r.live ? 1 : 0}"><div class="progress progress--thin" style="--p:${dur ? Math.round((r.position / dur) * 100) : 0}%"><i></i></div><div class="progress-line__meta num"><span>${fmtDuration(r.position)} / ${fmtDuration(dur)}</span><strong>${fmtLeftLong(left)}${rate !== 1 ? ` at ${rate}×` : ''}</strong></div></div>`;
}

/** One Continue listening card. c = { kind: 'track'|'queue', item, idx, ctx, queue } */
function clCard(c, i) {
  const it = c.item;
  if (c.kind === 'queue') {
    const s = player.state;
    const q = s.queue.map((e) => e.item);
    const leftSecs = q.slice(s.index).reduce((sum, t) => sum + (t.duration_secs || 0), 0) - (s.position || 0);
    const dl = q.filter((t) => t.path).length;
    const name = c.ctx.name || 'Queue';
    return `<article class="card card--interactive cl" data-cl="${i}">
      <div class="cl__top">${artHTML({ name, is_liked: c.ctx.type === 'liked', track_count: q.length, artwork: [] }, { kind: 'playlist', size: 'lg' })}
        <div class="cl__meta"><div class="cl__title">${esc(name)}</div><div class="cl__sub">${c.ctx.type === 'liked' ? 'Auto playlist' : c.ctx.type === 'album' ? 'Album' : 'Playlist'} · ${plural(q.length, 'song')}</div><div class="cl__kind"><span class="badge badge--outline num">${dl} of ${q.length} downloaded</span></div></div>
      </div>
      <div class="cl__bottom"><div class="progress-line" data-live="queue"><div class="progress progress--thin" style="--p:${Math.round(((s.index + (s.duration ? s.position / s.duration : 0)) / q.length) * 100)}%"><i></i></div><div class="progress-line__meta num"><span>Song ${s.index + 1} of ${q.length}</span><strong>${fmtLeftLong(Math.max(0, leftSecs))}</strong></div></div>${clPlayBtn(name, true)}</div>
    </article>`;
  }
  const sub = isVoice(it) ? `Recorded ${it.added_at ? new Date(it.added_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}` : [it.artist, it.album].filter(Boolean).join(' · ') || 'Unknown artist';
  const missing = it.path && it.downloaded === false;
  const unavailable = !missing && !isOnline() && needsStream(it);
  const r = resumeOf(it);
  let bottom;
  if (missing) bottom = `<div class="cl__missing"><span>The file was moved or deleted outside the app</span>${it.video_id ? `<button class="btn btn--ghost btn--sm" type="button" data-cl-act="redownload">Download again</button>` : ''}</div>`;
  else if (unavailable) bottom = `<div class="cl__unavail"><span>Streams only — not downloaded</span><button class="btn btn--icon btn--sm" type="button" disabled aria-label="Resume ${esc(it.title)} (needs internet)">${icon('play', 'icon--16')}</button></div>`;
  else bottom = `<div class="cl__bottom">${clProgress(it, r)}${clPlayBtn(it.title, r?.live)}</div>`;
  return `<article class="card ${missing || unavailable ? '' : 'card--interactive '}cl${missing ? ' is-missing' : ''}${unavailable ? ' is-unavailable' : ''}" data-cl="${i}"${unavailable ? ' aria-disabled="true"' : ''}>
    <div class="cl__top">${artHTML(it, { size: 'lg' })}<div class="cl__meta"><div class="cl__title">${esc(it.title)}</div><div class="cl__sub">${esc(sub)}</div><div class="cl__kind">${clBadges(it)}</div></div></div>
    ${bottom}
  </article>`;
}

function clPlayBtn(title, isCurrent) {
  const playing = isCurrent && player.state.playing;
  return `<button class="btn btn--play" type="button" data-cl-act="play" aria-label="${playing ? 'Pause' : 'Resume'} ${esc(title)}">${icon(playing ? 'pause' : 'play', 'icon--fill')}</button>`;
}

/** Quick pick download control (same 44/32 px slot in every state). */
function qpDl(it) {
  if (it.path || it.downloaded) return `<button class="btn btn--icon btn--sm qp__dl is-done" type="button" data-act="dl-done" aria-label="Downloaded, plays offline">${icon('check', 'icon--16')}</button>`;
  const d = downloadFor(it);
  if (d && (d.state === 'active' || d.state === 'queued' || d.state === 'paused')) {
    const p = Math.round((d.progress || 0) * 100);
    const label = d.state === 'paused' ? `Resume download of ${it.title}, ${p} percent` : d.state === 'queued' ? `${it.title} is queued` : `Pause download of ${it.title}, ${p} percent`;
    return `<button class="btn btn--icon btn--sm qp__dl" type="button" data-act="dl-toggle" data-dl="${esc(d.id)}" data-state="${d.state}" aria-label="${esc(label)}">${ring(d.progress, d.state === 'paused' ? 'ring--sm ring--paused' : 'ring--sm')}</button>`;
  }
  if (!it.video_id) return `<span class="qp__slot"></span>`;
  return `<button class="btn btn--icon btn--sm qp__dl" type="button" data-act="download" aria-label="Download ${esc(it.title)}"${isOnline() ? '' : ' disabled'}>${icon('download', 'icon--16')}</button>`;
}

function qpSub(it) {
  const d = !it.path && downloadFor(it);
  const busy = d && (d.state === 'active' || d.state === 'queued');
  const glyph = it.path || it.downloaded ? icon('check', 'sg sg--dl', 'Downloaded') : icon('stream', 'sg sg--st', 'Streams');
  const liked = it.liked ? icon('heart', 'sg sg--like phone-only', 'Liked') : '';
  if (busy) {
    const text = d.state === 'queued' ? `<span class="qp__busy">Queued</span>` : `<span class="qp__busy"><span class="qp__busy-word">Downloading </span>${Math.round((d.progress || 0) * 100)}%</span>${d.eta_secs != null ? ` · ${fmtLeft(d.eta_secs)} left` : ''}`;
    return `<div class="qp__sub qp__sub--busy">${glyph}${icon('download', 'sg sg--busy phone-only', 'Downloading')}<span>${text}</span></div>`;
  }
  return `<div class="qp__sub">${glyph}${liked}<span>${esc(it.artist || 'Unknown artist')} · ${fmtDuration(it.duration_secs)}</span></div>`;
}

/** Playing state of a quick pick: '' (not current), 'is-playing' or 'is-playing is-paused'. */
function qpPlayState(it) {
  const cur = player.current;
  if (!cur || itemKey(cur) !== itemKey(it)) return '';
  return player.state.playing ? 'is-playing' : 'is-playing is-paused';
}
/** Art overlay: solid scrim over the initials with the play glyph, or equaliser bars on the current row. */
const qpOverlay = (it) => `${qpPlayState(it) ? '<span class="eq qp__eq" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}${icon(qpPlayState(it) === 'is-playing' ? 'pause' : 'play', 'icon--fill qp__glyph')}`;

function qpRow(it, i) {
  const st = qpPlayState(it);
  const label = st === 'is-playing' ? 'Pause' : st ? 'Resume' : 'Play';
  const art = artHTML(it).replace(/<\/div>$/, `<button class="qp__play" type="button" data-act="play" aria-label="${label} ${esc(it.title)}"${!isOnline() && needsStream(it) ? ' disabled' : ''}>${qpOverlay(it)}</button></div>`);
  return `<div class="qp${i >= 6 ? ' qp--page2' : ''}${st ? ` ${st}` : ''}" data-idx="${i}" data-key="${esc(itemKey(it))}">
    ${art}
    <div class="qp__main"><div class="qp__title">${esc(it.title)}</div>${qpSub(it)}</div>
    <div class="qp__acts"><span class="qp__dlslot">${qpDl(it)}</span><button class="btn btn--icon btn--sm like qp__like${it.liked ? ' is-liked' : ''}" type="button" data-act="like" aria-pressed="${!!it.liked}" aria-label="${it.liked ? 'Liked' : 'Like'} ${esc(it.title)}">${icon('heart', 'icon--16')}</button><button class="btn btn--icon btn--sm qp__more" type="button" data-act="menu" aria-haspopup="menu" aria-label="More for ${esc(it.title)}">${icon('more', 'icon--16')}</button></div>
  </div>`;
}

/** Recently played tiles: albums of the songs played most recently (newest first). */
function recentGroups(recent) {
  const groups = new Map();
  for (const t of recent) {
    if (isVoice(t)) continue;
    const k = `${t.album || t.title}\u0000${t.artist || ''}`;
    if (!groups.has(k)) groups.set(k, { name: t.album || t.title, artist: t.artist || '', album: !!t.album, tracks: [], artwork: t.thumbnail || null });
    groups.get(k).tracks.push(t);
  }
  return [...groups.values()];
}

function rpTile(g, i) {
  const allDl = g.tracks.every((t) => t.path);
  const sub = `${g.album ? 'Album' : 'Song'}${g.artist ? ` · ${g.artist}` : ''}`;
  return tile({ name: g.name, artist: g.artist, artwork: g.artwork }, {
    kind: g.album ? 'album' : 'track', sub, glyph: allDl ? 'dl' : 'st',
    href: `#search?q=${encodeURIComponent(`${g.name} ${g.artist}`.trim())}`, data: `data-rp="${i}"`,
  });
}

// ------------------------------------------------------------------ view

export default {
  title: () => greeting(),

  async render(root, params, ctx) {
    root.innerHTML = skeleton();
    ctx.setTitle(greeting());
    if (PREVIEW_STATE === 'loading') return () => {};

    const cleanups = [];
    let alive = true;
    let model = null;
    let picks = [];
    let qpState = 'loading';   // loading | ok | error
    let qpPopular = false;
    let qpError = '';

    async function loadModel() {
      const [stats, recent, pls, storage] = await Promise.all([
        api.stats(), api.recent(24), playlists.refresh().then(() => playlists.value), api.storageInfo().catch(() => null),
      ]);
      const fresh = PREVIEW_STATE === 'fresh' || (!stats.music && !recent.some((t) => !isVoice(t)));
      return { stats: fresh && PREVIEW_STATE === 'fresh' ? { ...stats, music: 0, downloaded: 0, liked: 0 } : stats, recent: PREVIEW_STATE === 'fresh' ? [] : recent, likedPl: PREVIEW_STATE === 'fresh' ? null : pls.find((p) => p.is_liked), storage, fresh };
    }

    async function loadPicks(force = false, quiet = false) {
      if (!(quiet && picks.length)) { qpState = 'loading'; paintPicks(); }
      if (!isOnline()) {
        // Offline: Quick picks give way to downloaded songs.
        const dl = await api.tracks('music', { filter: 'downloaded', sort: 'recent', limit: 40 }).catch(() => []);
        const liked = dl.filter((t) => t.liked);
        picks = [...liked, ...dl.filter((t) => !t.liked)].slice(0, 4);
        qpState = 'ok';
        paintPicks();
        return;
      }
      try {
        if (PREVIEW_STATE === 'error') throw new Error('YouTube Music didn’t answer within 15 seconds.');
        const cached = ss(QP_CACHE);
        let res;
        if (!force && cached?.items?.length && Date.now() - cached.at < 30 * 60 * 1000 && cached.fresh === !!model?.fresh) res = cached;
        else {
          const rotate = force ? (cached?.rotate || 0) + 1 : 0;
          res = { ...(await fetchQuickPicks(model?.recent || [], rotate)), at: Date.now(), rotate, fresh: !!model?.fresh };
          ss(QP_CACHE, res);
        }
        picks = await withLibrary(res.items);
        qpPopular = res.popular;
        qpState = 'ok';
        // Resolve stream links for the first picks now so Play starts at once (D22).
        api.youtubePrefetch(picks.filter((p) => needsStream(p)).slice(0, 2).map((p) => p.video_id));
      } catch (e) {
        qpState = 'error';
        qpError = e?.message || String(e);
      }
      if (alive) paintPicks();
    }

    function qpHead() {
      if (!isOnline()) return `<div class="qp-head"><h3 id="qp-h">From your downloads</h3><span class="section-head__sub">Quick picks are paused offline</span></div>`;
      const sub = qpPopular ? 'popular on YouTube Music' : 'from YouTube Music';
      const meta = qpState === 'loading' ? `<span class="section-head__sub qp-fetch"><span class="spinner"></span>Fetching from YouTube Music…</span>`
        : `<span class="qp-head__meta"><span class="section-head__sub">${sub}</span>${qpState === 'ok' ? '<span class="badge badge--ok badge--dot net-badge">Online</span>' : ''}</span>`;
      const tools = qpState === 'ok' && picks.length ? `<div class="qp-head__tools"><button class="btn btn--ghost btn--sm desktop-only" type="button" data-qp="refresh">${icon('refresh', 'icon--16')}Refresh</button><button class="btn btn--secondary btn--sm" type="button" data-qp="play-all">${icon('play', 'icon--16 icon--fill')}Play all</button></div>` : '';
      return `<div class="qp-head"><h3 id="qp-h">Quick picks</h3>${meta}</div>${tools}`;
    }

    function paintPicks() {
      const sec = root.querySelector('[data-section="qp"]');
      if (!sec) return;
      let body;
      if (qpState === 'loading') body = qpSkeleton();
      else if (qpState === 'error') body = `<div class="card qp-error">${emptyState({ icon: 'alert', error: true, compact: true, title: 'Couldn’t load Quick picks', text: `${qpError.replace(/\.?$/, '.')} Your liked songs and downloads still play.`, actions: `<button class="btn btn--secondary" type="button" data-qp="retry">${icon('refresh', 'icon--16')}Try again</button>` })}</div>`;
      else if (!picks.length) body = `<div class="card">${emptyState({ icon: 'download', compact: true, title: isOnline() ? 'No picks right now' : 'Nothing downloaded yet', text: isOnline() ? 'Search YouTube Music to find something to play.' : 'Songs you download play here without internet.', actions: isOnline() ? `<a class="btn btn--secondary" href="#search">${icon('search', 'icon--16')}Search</a>` : '' })}</div>`;
      else body = `<div class="qp-grid" data-qp-list>${picks.map(qpRow).join('')}</div>`;
      sec.innerHTML = `<div class="section-head">${qpHead()}</div>${body}`;
    }

    function paint() {
      const m = model;
      const off = !isOnline();
      ctx.setTitle(m.fresh ? 'Welcome' : greeting());
      const parts = [];

      if (off) {
        const waiting = downloads.value.filter((d) => d.state === 'active' || d.state === 'queued' || d.state === 'paused').length;
        parts.push(`<div class="banner banner--warn offline-banner" role="status">${icon('offline')}<div class="banner__body"><div class="banner__title">You’re offline — showing downloaded music only</div><div class="banner__text num">Streaming and Quick picks need an internet connection. Your ${plural(m.stats.downloaded, 'downloaded song')} play as normal${waiting ? `; ${plural(waiting, 'download')} resume when you’re back online` : ''}.</div></div><button class="btn btn--secondary btn--sm" type="button" data-act-home="retry-online">${icon('refresh', 'icon--16')}Try again</button></div>`);
      }

      if (m.fresh) {
        parts.push(`<div class="fresh-hero">
          <h1>Welcome</h1>
          <p class="fresh-hero__sub">Search YouTube Music to stream any song, or download it to play without internet.</p>
          <form class="fresh-hero__search" data-fresh-search>
            <div class="search search--lg">${icon('search')}<input class="search__input" name="q" placeholder="Songs, albums or artists" aria-label="Search YouTube Music" autocomplete="off"></div>
            <button class="btn btn--primary btn--lg" type="submit">${icon('search')}Search</button>
          </form>
          <div class="chips fresh-hero__chips" aria-label="Try a search">${['Lo-fi beats', 'Bollywood hits', '90s rock', 'Workout'].map((q) => `<a class="chip" href="#search?q=${encodeURIComponent(q)}">${q}</a>`).join('')}</div>
        </div>`);
      } else {
        const meta = off
          ? `<span>${plural(m.stats.downloaded, 'downloaded song')}</span>${m.storage?.downloads_bytes ? `<span class="sep"></span><span>${fmtBytes(m.storage.downloads_bytes)}</span>` : ''}`
          : `<span class="desktop-only">${plural(m.stats.music, 'song')} in your library</span><span class="sep desktop-only"></span><span>${fmtNum(m.stats.downloaded)} downloaded</span>${m.storage?.used_bytes || m.stats.total_bytes ? `<span class="sep"></span><span>${fmtBytes(m.storage?.used_bytes || m.stats.total_bytes)} on this device</span>` : ''}`;
        const shuffleLiked = !off && m.stats.liked > 0;
        const shuffleLabel = shuffleLiked ? 'Shuffle liked songs' : m.stats.downloaded ? 'Shuffle downloads' : 'Shuffle all';
        parts.push(`<div class="page-head greet"><div><h1>${esc(greeting())}</h1><div class="meta num">${meta}</div></div>
          <div class="page-head__actions"><button class="btn btn--primary" type="button" data-act-home="shuffle" data-mode="${shuffleLiked ? 'liked' : m.stats.downloaded ? 'downloaded' : 'all'}">${icon('shuffle')}${shuffleLabel}</button></div></div>`);
      }

      parts.push(shortcuts(m));

      // Continue listening
      const cards = continueCards(m);
      if (!m.fresh) {
        parts.push(`<section class="cl-section" aria-labelledby="cl-h"><div class="section-head"><h3 id="cl-h">Continue listening</h3></div>${cards.length
          ? `<div class="cl-grid" data-cl-list>${cards.map(clCard).join('')}</div>`
          : `<div class="card">${emptyState({ icon: 'clock', compact: true, title: 'Nothing in progress', text: 'Anything you start shows up here with where you left off.' })}</div>`}</section>`);
      }

      parts.push(`<section class="qp-section" aria-labelledby="qp-h" data-section="qp"></section>`);

      if (m.fresh) {
        parts.push(`<div class="ghost-sections">
          <div class="card empty empty--compact"><div class="empty__icon">${icon('clock')}</div><div class="empty__title">Continue listening</div><div class="empty__text">Anything you start shows up here with where you left off.</div></div>
          <div class="card empty empty--compact"><div class="empty__icon">${icon('disc')}</div><div class="empty__title">Recently played</div><div class="empty__text">Albums and songs you play, newest first.</div></div>
        </div>`);
      } else {
        const all = recentGroups(m.recent);
        const groups = off ? all.filter((g) => g.tracks.some((t) => t.path)) : all;
        rpGroups = groups.slice(0, RP_COUNT);
        const sub = off && all.length ? `<span class="section-head__sub">${Math.min(groups.length, RP_COUNT)} of ${Math.min(all.length, RP_COUNT)} available offline</span>` : '';
        parts.push(`<section class="rp-section" aria-labelledby="rp-h"><div class="section-head"><div class="cluster"><h3 id="rp-h">Recently played</h3>${sub}</div>${off ? '' : `<a class="section-head__link" href="#library?tab=recent">See all${icon('chevron-right', 'icon--16')}</a>`}</div>
          ${rpGroups.length ? `<div class="tile-row rp" data-rp-list>${rpGroups.map(rpTile).join('')}</div>` : `<div class="card">${emptyState({ icon: 'disc', compact: true, title: off ? 'Nothing played offline yet' : 'Nothing played yet', text: 'Albums and songs you play show up here, newest first.' })}</div>`}
        </section>`);
      }

      root.innerHTML = `<div class="page${m.fresh ? ' is-fresh' : ''}">${parts.join('')}</div>`;
      clCardsData = cards;
      paintPicks();
      paintDlLive();
    }

    let clCardsData = [];
    let rpGroups = [];

    function continueCards(m) {
      const out = [];
      const s = player.state;
      const cur = player.current;
      const seen = new Set();
      if (cur) {
        const c = s.context;
        if (c && ['playlist', 'liked', 'album'].includes(c.type) && s.queue.length > 1) out.push({ kind: 'queue', item: cur, ctx: c });
        else out.push({ kind: 'track', item: cur });
        seen.add(itemKey(cur));
      }
      for (const t of m.recent) {
        if (out.length >= CL_COUNT) break;
        if (seen.has(itemKey(t))) continue;
        seen.add(itemKey(t));
        out.push({ kind: 'track', item: t });
      }
      return out;
    }

    function paintDlLive() {
      const el = root.querySelector('[data-dl-live]');
      if (!el) return;
      const html = dlLive(downloads.value);
      el.hidden = !html;
      if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
    }

    function patchPickDownloads() {
      root.querySelectorAll('[data-qp-list] .qp').forEach((row) => {
        const it = picks[Number(row.dataset.idx)];
        if (!it) return;
        const slot = row.querySelector('.qp__dlslot');
        const html = qpDl(it);
        if (slot.dataset.html !== html) { slot.dataset.html = html; slot.innerHTML = html; }
        const sub = row.querySelector('.qp__sub');
        const subHtml = qpSub(it);
        if (sub && sub.outerHTML !== subHtml) sub.outerHTML = subHtml;
      });
    }

    // Live progress of the loaded song on its Continue listening card.
    function patchLive() {
      const el = root.querySelector('[data-cl="0"] .progress-line[data-live]');
      if (!el || !clCardsData[0]) return;
      const card = clCardsData[0];
      if (card.kind === 'queue') {
        const s = player.state;
        const n = s.queue.length || 1;
        el.querySelector('.progress').style.setProperty('--p', `${Math.round(((s.index + (s.duration ? s.position / s.duration : 0)) / n) * 100)}%`);
        return;
      }
      if (el.dataset.live !== '1') return;
      const s = player.state;
      const dur = s.duration || card.item.duration_secs || 0;
      el.querySelector('.progress').style.setProperty('--p', `${dur ? Math.round((s.position / dur) * 100) : 0}%`);
      const rate = isVoice(card.item) ? s.rate || 1 : 1;
      const meta = el.querySelector('.progress-line__meta');
      meta.innerHTML = `<span>${fmtDuration(s.position)} / ${fmtDuration(dur)}</span><strong>${fmtLeftLong(Math.max(0, dur - s.position) / rate)}${rate !== 1 ? ` at ${rate}×` : ''}</strong>`;
    }

    async function reload() {
      try {
        model = await loadModel();
      } catch (e) {
        if (!alive) return;
        root.innerHTML = `<div class="page"><div class="card">${emptyState({ icon: 'alert', error: true, title: 'Couldn’t load your library', text: e?.message || String(e), actions: `<button class="btn btn--secondary" type="button" data-act-home="reload">${icon('refresh', 'icon--16')}Try again</button>` })}</div></div>`;
        return;
      }
      if (!alive) return;
      paint();
    }

    // ---- events (delegated on root; survives repaints)
    cleanups.push(on(root, 'click', '[data-act-home]', async (e, b) => {
      const act = b.dataset.actHome;
      if (act === 'reload') { root.innerHTML = skeleton(); await reload(); loadPicks(); }
      if (act === 'retry-online') {
        if (PREVIEW_STATE !== 'offline' && navigator.onLine) { online.set(true); await reload(); loadPicks(true); }
        else toast('Still offline — downloaded music keeps playing', { kind: 'info' });
      }
      if (act === 'shuffle') {
        b.disabled = true;
        const mode = b.dataset.mode;
        const list = await guard(async () => {
          if (mode === 'liked') return (await api.playlist(0)).entries.map((x) => x.track);
          return api.tracks('music', { filter: mode === 'downloaded' ? 'downloaded' : 'all', limit: 5000 });
        });
        b.disabled = false;
        if (!list?.length) { toast('Nothing to shuffle yet', { kind: 'info' }); return; }
        const context = mode === 'liked' ? { type: 'liked', id: 0, name: 'Liked songs' } : mode === 'downloaded' ? { type: 'downloads', name: 'Downloads' } : { type: 'library', name: 'Your library' };
        player.shufflePlay(list, context);
      }
    }));

    cleanups.push(on(root, 'submit', '[data-fresh-search]', (e, form) => {
      e.preventDefault();
      const q = form.elements.q.value.trim();
      location.hash = q ? `#search?q=${encodeURIComponent(q)}` : '#search';
    }));

    cleanups.push(on(root, 'click', '[data-qp]', async (e, b) => {
      const act = b.dataset.qp;
      if (act === 'retry') loadPicks(true);
      if (act === 'refresh') loadPicks(true);
      if (act === 'play-all' && picks.length) player.play(picks, 0, { type: 'search', name: 'Quick picks' });
    }));

    // Quick pick rows: play / like / download / ⋯ through the shared binder; ring = pause/resume.
    cleanups.push(bindTrackList(root, {
      items: () => picks, player,
      context: isOnline() ? { type: 'search', name: 'Quick picks' } : { type: 'downloads', name: 'Downloads' },
      onPlay: (item) => {
        if (qpPlayState(item)) { player.toggle(); return true; }   // current row: overlay is pause/resume
        if (!isOnline() && needsStream(item)) { toast('This song streams — it needs internet', { kind: 'info' }); return true; }
        return false;
      },
    }));
    cleanups.push(on(root, 'click', '[data-act="dl-toggle"]', async (e, b) => {
      e.stopPropagation();
      const id = b.dataset.dl;
      if (b.dataset.state === 'paused') await guard(() => api.resumeDownload(id), 'Download resumed');
      else if (b.dataset.state === 'active') await guard(() => api.pauseDownload(id), 'Download paused');
      else location.hash = '#downloads';
      pokeDownloads();
    }));
    cleanups.push(on(root, 'click', '[data-act="dl-done"]', (e) => { e.stopPropagation(); toast('Downloaded — plays offline', { kind: 'ok' }); }));

    // Continue listening
    cleanups.push(on(root, 'click', '[data-cl]', async (e, card) => {
      const c = clCardsData[Number(card.dataset.cl)];
      if (!c || card.classList.contains('is-unavailable')) return;
      const actBtn = e.target.closest('[data-cl-act]');
      if (actBtn?.dataset.clAct === 'redownload') {
        e.stopPropagation();
        const { download } = await import('../components/actions.js');
        download({ ...c.item, path: null, downloaded: false });
        return;
      }
      if (card.classList.contains('is-missing')) return;
      const cur = player.current;
      if (cur && itemKey(cur) === itemKey(c.item)) {
        if (actBtn) player.toggle(); else location.hash = '#now-playing';
        return;
      }
      const it = c.item;
      if (isVoice(it)) { player.play([it], 0, { type: 'voice', name: 'Voice recordings' }); return; }
      const list = model.recent.filter((t) => !isVoice(t) && (isOnline() || !needsStream(t)));
      const idx = list.findIndex((t) => itemKey(t) === itemKey(it));
      player.play(idx >= 0 ? list : [it], Math.max(0, idx), { type: 'library', name: 'Recently played' });
      const r = typeof player.resumeInfo === 'function' ? player.resumeInfo(it) : null;
      if (r?.position > 5 && typeof player.seekWhenReady === 'function') player.seekWhenReady(r.position);
    }));

    // Recently played tiles: the round play button plays the album from the library.
    cleanups.push(on(root, 'click', '[data-rp] [data-act="play-tile"]', async (e, b) => {
      e.preventDefault(); e.stopPropagation();
      const g = rpGroups[Number(b.closest('[data-rp]').dataset.rp)];
      if (!g) return;
      let list = g.tracks;
      if (g.album) {
        const all = await api.tracks('music', { query: g.name, sort: 'album', limit: 200 }).catch(() => []);
        const same = all.filter((t) => t.album === g.name && (t.artist || '') === g.artist);
        if (same.length) list = same;
      }
      if (!isOnline()) list = list.filter((t) => !needsStream(t));
      if (!list.length) { toast('These songs stream — they need internet', { kind: 'info' }); return; }
      player.play(list, 0, { type: g.album ? 'album' : 'library', name: g.album ? g.name : 'Recently played' });
    }));

    // Quick picks: keep the current row's equaliser / pause glyph in step with the player.
    function paintPickPlaying() {
      root.querySelectorAll('.qp[data-idx]').forEach((row) => {
        const it = picks[Number(row.dataset.idx)];
        if (!it) return;
        const st = qpPlayState(it);
        row.classList.toggle('is-playing', !!st);
        row.classList.toggle('is-paused', st.includes('is-paused'));
        const b = row.querySelector('.qp__play');
        if (b) { b.innerHTML = qpOverlay(it); b.setAttribute('aria-label', `${st === 'is-playing' ? 'Pause' : st ? 'Resume' : 'Play'} ${it.title}`); }
      });
    }

    // Live data
    let lastKey = player.current ? itemKey(player.current) : '';
    let lastPlaying = player.state.playing;
    cleanups.push(player.subscribe((s) => {
      if (!model) return;
      const key = s.current ? itemKey(s.current) : '';
      if (key !== lastKey) { lastKey = key; paintPickPlaying(); reloadSoon(); return; }
      if (s.playing !== lastPlaying) {
        lastPlaying = s.playing;
        paintPickPlaying();
        const btn = root.querySelector('[data-cl="0"] [data-cl-act="play"]');
        if (btn && s.current) { btn.innerHTML = icon(s.playing ? 'pause' : 'play', 'icon--fill'); btn.setAttribute('aria-label', `${s.playing ? 'Pause' : 'Resume'} ${s.current.title}`); }
      }
    }));
    cleanups.push(player.onTime(() => patchLive()));
    cleanups.push(downloads.subscribe(() => { paintDlLive(); patchPickDownloads(); }));
    let reloadTimer = null;
    const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (alive) reload(); }, 250); };
    const onLib = () => { reloadSoon(); if (isOnline()) setTimeout(() => alive && loadPicks(false, true), 300); };
    const onNet = () => { reload().then(() => loadPicks()); };
    addEventListener('library:changed', onLib);
    addEventListener('online:changed', onNet);
    cleanups.push(() => { removeEventListener('library:changed', onLib); removeEventListener('online:changed', onNet); clearTimeout(reloadTimer); });

    await reload();
    if (model) loadPicks();

    return () => { alive = false; cleanups.forEach((fn) => { try { fn?.(); } catch {} }); };
  },
};
