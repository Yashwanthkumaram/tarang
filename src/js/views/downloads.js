// Downloads (design/screens/downloads.html). Route: #downloads
//
// Totals card (Active · Queued · Done · Failed · Speed, overall progress, storage strip), then
// Active (incl. paused), Failed, Queued and Done sections. Rows follow the design's .drow
// anatomy: art, "Title · Artist", meta numbers, a bar on active rows, and at the right a
// progress ring plus the row actions (desktop) or a "…" sheet (phone). Live data comes from the
// shared downloads store (polled every second while anything is busy); song details (art,
// artist, bitrate) from get_track for downloads that carry a track_id.

import { api } from '../api.js';
import { artHTML } from '../components/art.js';
import { downloads, online, platform, pokeDownloads, stats as statsStore } from '../components/store.js';
import { player } from '../player.js';
import { banner, emptyState, esc, fmtAgo, fmtBytes, fmtClock, fmtNum, guard, icon, openMenu, plural, toast } from '../ui.js';

const LOW_DISK = 500e6;                    // warn when less than this is free
const QUEUE_SHOWN = 3, DONE_SHOWN = 4, DONE_SHOWN_DESKTOP = 6;
const ordinal = (n) => (n === 1 ? 'Next up' : `${n}${n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : n % 10 === 1 && n % 100 !== 11 ? 'st' : 'th'} in line`);
const mb = (b) => (b ? (b / 1e6).toFixed(1) : '0.0');
function secsLeft(s) {
  if (s == null) return '';
  if (s < 60) return `${Math.max(1, Math.round(s))} s left`;
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`;
}
const ringHTML = (p, inner = '', cls = '', fgCls = '') => `<span class="ring-wrap"><svg class="ring ${cls}" viewBox="0 0 36 36" aria-hidden="true"><circle class="ring__bg" cx="18" cy="18" r="15.5"/>${p > 0 ? `<circle class="ring__fg ${fgCls}" cx="18" cy="18" r="15.5" pathLength="100" style="--p:${Math.round(p * 100)}"/>` : ''}</svg>${inner}</span>`;
const btnIcon = (act, ic, label, cls = '') => `<button class="btn btn--icon btn--sm ${cls}" type="button" data-act="${act}" aria-label="${esc(label)}">${ic}</button>`;

export default {
  title: 'Downloads',
  async render(root) {
    const tracks = new Map();               // track_id → Track (null while loading / missing)
    let list = null, loadErr = null, storage = null, likedTodo = 0, songsOnDisk = null;
    let expandQueued = false, expandDone = false;
    const cleanups = [];

    root.innerHTML = `<div class="page" data-page>
      <div class="page-head desktop-only"><div><h1>Downloads</h1><div class="page-head__sub num" data-sub>YouTube Music songs saved for offline</div></div><div class="page-head__actions" data-head-actions></div></div>
      <div data-banners style="display:contents"></div>
      <div data-summary></div>
      <div class="dl-sections" data-sections></div>
    </div>
    <div class="dl-dock phone-only" role="toolbar" aria-label="Queue actions" data-dock hidden></div>`;
    const $ = (s) => root.querySelector(s);
    const set = (el, html) => { if (el && el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };

    // ---------------------------------------------------------------- song details
    function info(d) {
      const t = d.track_id ? tracks.get(d.track_id) : null;
      if (t) return { title: t.title, artist: t.artist || '', track: t };
      const [artist, ...rest] = String(d.name || '').split(' – ');
      return rest.length ? { title: rest.join(' – '), artist, track: null } : { title: d.name || 'Unknown song', artist: '', track: null };
    }
    async function fetchTracks() {
      const need = [...new Set((list || []).map((d) => d.track_id).filter((id) => id && !tracks.has(id)))];
      if (!need.length) return;
      need.forEach((id) => tracks.set(id, null));
      await Promise.all(need.map(async (id) => { try { tracks.set(id, await api.track(id)); } catch {} }));
      render();
    }
    const art = (d) => { const i = info(d); return artHTML(i.track || { title: i.title, artist: i.artist, album: i.track?.album }); };
    const titleHTML = (i) => `<div class="drow__title">${esc(i.title)}${i.artist ? `<span class="dl-artist"> · ${esc(i.artist)}</span>` : ''}</div>`;
    const by = (i, brk = true) => (i.artist ? `<span class="dl-by">${esc(i.artist)}</span><span class="sep dl-by"></span>${brk ? '<i class="dl-break dl-by-break"></i>' : ''}` : '');
    const rowMenuBtn = `<button class="btn btn--icon btn--sm phone-only" type="button" data-act="row-menu" aria-haspopup="menu" aria-label="More actions">${icon('more', 'icon--16')}</button>`;
    const removeBtn = (label = 'Remove') => btnIcon('remove', icon('x', 'icon--16'), label, 'desktop-only');

    // ---------------------------------------------------------------- rows
    function activeRow(d) {
      const i = info(d);
      const p = d.progress || 0;
      const off = !online.value;
      if (d.state === 'paused' || off) {
        const meta = off
          ? `<span class="dl-line1">${by(i, false)}<span class="nw">${Math.round(p * 100)}% · ${mb(d.downloaded_bytes)} / ${mb(d.total_bytes)} MB kept</span></span><span class="sep"></span><span class="dl-status-text">Waiting for connection</span>`
          : `<span class="dl-line1">${by(i, false)}<span class="nw">${mb(d.downloaded_bytes)} / ${mb(d.total_bytes)} MB</span></span><span class="sep dl-sep-break"></span><i class="dl-break"></i><span>${Math.round(p * 100)}%</span><span class="sep"></span><span>Paused</span>`;
        const action = off ? btnIcon('retry', icon('refresh', 'icon--16'), 'Retry now') : btnIcon('resume', icon('play', 'icon--16 dl-glyph'), `Resume ${i.title}`);
        return `<div class="drow drow--split" data-id="${esc(d.id)}">${art(d)}<div class="drow__main">${titleHTML(i)}<div class="drow__meta">${meta}</div><div class="progress progress--paused" style="--p:${Math.round(p * 100)}%"><i></i></div></div><div class="drow__actions">${ringHTML(p, icon(off ? 'offline' : 'pause-line'), 'ring--paused')}${action}${removeBtn()}${rowMenuBtn}</div></div>`;
      }
      return `<div class="drow drow--split" data-id="${esc(d.id)}">${art(d)}<div class="drow__main">${titleHTML(i)}<div class="drow__meta"><span class="dl-line1">${by(i, false)}<span class="nw">${mb(d.downloaded_bytes)} / ${mb(d.total_bytes)} MB</span></span><span class="sep dl-sep-break"></span><i class="dl-break"></i><span>${fmtBytes(d.speed_bps)}/s</span>${d.eta_secs != null ? `<span class="sep"></span><span class="strong">${secsLeft(d.eta_secs)}</span>` : ''}</div><div class="progress" style="--p:${Math.round(p * 100)}%"><i></i></div></div><div class="drow__actions">${ringHTML(p, `<span class="ring-wrap__label">${Math.round(p * 100)}</span>`)}${btnIcon('pause', icon('pause-line', 'icon--16'), `Pause ${i.title}`)}${removeBtn()}${rowMenuBtn}</div></div>`;
    }
    function failedRow(d) {
      const i = info(d);
      const err = d.error || 'The download stopped.';
      const ytdlp = /yt-dlp|format|extract|signature/i.test(err);
      const disk = /space|disk|ENOSPC/i.test(err);
      const kept = d.downloaded_bytes ? ` · <span class="nw">${mb(d.downloaded_bytes)} / ${mb(d.total_bytes)} MB kept</span>` : '';
      return `<div class="drow is-failed" data-id="${esc(d.id)}">${art(d)}<div class="drow__main">${titleHTML(i)}<div class="drow__meta">${by(i)}<span>${esc(err)}${kept}${ytdlp ? ' · <a href="#settings">Update yt-dlp</a>' : ''}</span></div></div><div class="drow__actions">${ringHTML(d.progress || 0, icon(disk ? 'storage' : 'alert', 'dl-danger'), '', 'dl-ring-danger')}<button class="btn btn--secondary btn--sm desktop-only" type="button" data-act="retry">${icon('refresh', 'icon--16')}Retry</button>${btnIcon('retry', icon('refresh', 'icon--16'), `Retry ${i.title}`, 'btn--secondary phone-only')}${removeBtn()}${rowMenuBtn}</div></div>`;
    }
    function queuedRow(d, n, cut) {
      const i = info(d);
      return `<div class="drow${cut && !expandQueued ? ' dl-cut' : ''}" data-id="${esc(d.id)}">${art(d)}<div class="drow__main">${titleHTML(i)}<div class="drow__meta">${by(i)}${d.total_bytes ? `<span>${mb(d.total_bytes)} MB</span><span class="sep"></span>` : ''}<span>${ordinal(n)}</span></div></div><div class="drow__actions">${ringHTML(0, icon('clock'))}${removeBtn('Remove from queue')}${rowMenuBtn}</div></div>`;
    }
    function doneRow(d, cut) {
      const i = info(d);
      const t = i.track;
      return `<div class="drow drow--done${cut && !expandDone ? ' dl-cut' : ''}" data-id="${esc(d.id)}">${art(d)}<div class="drow__main">${titleHTML(i)}<div class="drow__meta">${by(i)}<span class="dl-ok" title="In library">${icon('check', 'icon--16')}<span class="dl-ok__label">In library</span></span><span class="sep"></span><span class="num">${mb(d.total_bytes || t?.size_bytes)} MB</span>${t?.bitrate_kbps ? `<span class="sep dl-done-sep"></span><i class="dl-break dl-done-break"></i><span>${t.bitrate_kbps} kbps</span>` : ''}${t?.modified_at ? `<span class="sep"></span><span class="num">${fmtAgo(t.modified_at)}</span>` : ''}</div></div><div class="drow__actions">${t ? `<button class="btn btn--secondary btn--sm desktop-only" type="button" data-act="play">${icon('play', 'icon--16 icon--fill')}Play</button>${btnIcon('play', icon('play', 'icon--16 icon--fill'), `Play ${i.title}`, 'btn--secondary phone-only')}` : ''}${removeBtn('Remove from list')}${rowMenuBtn}</div></div>`;
    }

    // ---------------------------------------------------------------- groups + totals
    function groups() {
      const by = (s) => list.filter((d) => d.state === s);
      return { active: by('active'), paused: by('paused'), queued: by('queued'), failed: by('error'), done: by('done') };
    }
    function summaryHTML(g) {
      const off = !online.value;
      const batch = [...g.active, ...g.paused, ...g.queued, ...g.done];
      const total = batch.reduce((s, d) => s + (d.total_bytes || 0), 0);
      const got = batch.reduce((s, d) => s + (d.state === 'done' ? (d.total_bytes || 0) : (d.downloaded_bytes || 0)), 0);
      const pct = total ? got / total : 0;
      const speed = g.active.reduce((s, d) => s + (d.speed_bps || 0), 0);
      const left = total - got;
      const busy = g.active.length + g.queued.length;
      const eta = speed > 0 ? left / speed : null;
      const doneBy = eta != null ? fmtClock(Date.now() + eta * 1000) : null;
      const failedStat = `<div class="stat${g.failed.length ? ' stat--danger' : ''}"><div class="stat__num dl-stat-icon">${g.failed.length ? icon('alert') : ''}${g.failed.length}</div><div class="stat__label">Failed</div></div>`;
      const stats = off
        ? `<div class="stats stats--4"><div class="stat"><div class="stat__num">${g.active.length + g.paused.length}</div><div class="stat__label">Paused</div></div><div class="stat"><div class="stat__num">${g.queued.length}</div><div class="stat__label">Queued</div></div><div class="stat stat--ok"><div class="stat__num">${g.done.length}</div><div class="stat__label">Done</div></div>${failedStat}</div>`
        : `<div class="stats"><div class="stat"><div class="stat__num">${g.active.length}</div><div class="stat__label">Active</div></div><div class="stat"><div class="stat__num">${g.queued.length}</div><div class="stat__label">Queued</div></div><div class="stat stat--ok"><div class="stat__num">${g.done.length}</div><div class="stat__label">Done</div></div>${failedStat}<div class="stat desktop-only"><div class="stat__num">${speed ? `${fmtBytes(speed)}/s` : '—'}</div><div class="stat__label">Speed</div></div></div>`;
      const files = `${fmtNum(g.done.length)} of ${plural(batch.length, 'file')}`;
      let line;
      if (off && busy + g.paused.length) line = `<div class="progress-line"><div class="progress-line__meta"><span><strong>${Math.round(pct * 100)}%</strong> · ${files} · ${mb(got)} of ${mb(total)} MB</span><span>Waiting for connection</span></div><div class="progress progress--thick progress--paused" style="--p:${Math.round(pct * 100)}%"><i></i></div></div>`;
      else if (busy) line = `<div class="progress-line"><div class="progress-line__meta"><span><strong>${Math.round(pct * 100)}%</strong> · ${files} · ${mb(got)} of ${mb(total)} MB</span><span class="desktop-only">${fmtBytes(left)} left${eta != null ? ` · ${secsLeft(eta)} · done by <strong>${doneBy}</strong>` : ''}</span><span class="phone-only"><strong>${speed ? `${fmtBytes(speed)}/s` : 'Starting'}</strong>${eta != null ? ` · ${secsLeft(eta)} · done by ${doneBy}` : ''}</span></div><div class="progress progress--thick" style="--p:${Math.round(pct * 100)}%"><i></i></div></div>`;
      else if (g.paused.length) line = `<div class="progress-line"><div class="progress-line__meta"><span><strong>${Math.round(pct * 100)}%</strong> · ${files} · ${mb(got)} of ${mb(total)} MB</span><span>Paused</span></div><div class="progress progress--thick progress--paused" style="--p:${Math.round(pct * 100)}%"><i></i></div></div>`;
      else line = `<div class="progress-line"><div class="progress-line__meta"><span><strong>All done</strong> · ${plural(g.done.length, 'file')} · ${fmtBytes(total)}</span><span>${g.failed.length ? `${g.failed.length} need attention` : 'Nothing waiting'}</span></div><div class="progress progress--thick progress--ok" style="--p:100%"><i></i></div></div>`;
      return `<section class="card card--pad-lg dl-summary" aria-label="Queue totals">${stats}${line}${storageHTML()}</section>`;
    }
    function storageHTML() {
      if (!storage) return '';
      const used = storage.downloads_bytes || 0, free = storage.free_bytes || 0;
      const p = used + free ? Math.max(1, Math.round((used / (used + free)) * 100)) : 0;
      return `<div class="dl-storage" aria-label="Storage">${icon('storage', 'muted')}<div class="progress-line grow"><div class="progress-line__meta"><span><strong>${fmtBytes(used)}</strong> used<span class="dl-wide"> by downloads${songsOnDisk != null ? ` · ${plural(songsOnDisk, 'song')}` : ''}</span></span><span><strong>${fmtBytes(free)}</strong> free<span class="dl-wide"> on this disk</span></span></div><div class="progress" style="--p:${p}%"><i></i></div></div><a class="btn btn--ghost btn--sm" href="#settings">Manage</a></div>`;
    }
    function bannersHTML(g) {
      const out = [];
      const waiting = g.active.length + g.paused.length + g.queued.length;
      if (!online.value && waiting) out.push(banner({ kind: 'info', icon: 'offline', title: `You’re offline — ${plural(g.active.length + g.queued.length || waiting, 'download')} paused`, text: `${songsOnDisk != null ? `Your ${fmtNum(songsOnDisk)} downloaded songs still play.` : 'Downloaded songs still play.'} The queue resumes by itself when you’re back online.`, action: `<button class="btn btn--secondary btn--sm" type="button" data-act="try-now">${icon('refresh', 'icon--16')}Try now</button>` }));
      if (storage && storage.free_bytes < LOW_DISK && (g.queued.length || g.active.length || g.failed.some((d) => /space|disk/i.test(d.error || '')))) {
        const next = g.queued[0] || g.active[0];
        out.push(banner({ kind: 'warn', icon: 'storage', title: 'Not enough space for the next download', text: `${fmtBytes(storage.free_bytes)} free on this disk${next?.total_bytes ? `; ${info(next).title} needs ${fmtBytes(next.total_bytes)}` : ''}. Remove downloads you no longer need or choose another folder.`, action: `<a class="btn btn--secondary btn--sm" href="#settings">${icon('folder', 'icon--16')}Manage storage</a>` }));
      }
      return out.join('');
    }
    function sectionsHTML(g) {
      const out = [];
      const act = [...g.active, ...g.paused];
      if (act.length) {
        const left = act.reduce((s, d) => s + Math.max(0, (d.total_bytes || 0) - (d.downloaded_bytes || 0)), 0);
        out.push(`<section class="dl-section" aria-labelledby="h-active"><div class="section-head section-head--sm"><h3 id="h-active">Active<span class="section-head__sub num">${act.length}${left ? ` · ${fmtBytes(left)} left` : ''}</span></h3></div><div class="list">${act.map(activeRow).join('')}</div></section>`);
      }
      if (g.failed.length) {
        out.push(`<section class="dl-section" aria-labelledby="h-failed"><div class="section-head section-head--sm"><h3 id="h-failed">Failed<span class="section-head__sub num">${g.failed.length} need${g.failed.length === 1 ? 's' : ''} attention</span></h3>${g.failed.length > 1 ? `<button class="btn btn--ghost btn--sm" type="button" data-act="retry-all">${icon('refresh', 'icon--16')}Retry all</button>` : ''}</div><div class="list">${g.failed.map(failedRow).join('')}</div></section>`);
      }
      if (g.queued.length) {
        const size = g.queued.reduce((s, d) => s + (d.total_bytes || 0), 0);
        const hidden = g.queued.length - QUEUE_SHOWN;
        out.push(`<section class="dl-section" aria-labelledby="h-queued"><div class="section-head section-head--sm"><h3 id="h-queued">Queued<span class="section-head__sub num">${g.queued.length}${size ? ` · ${fmtBytes(size)}` : ''}</span></h3></div><div class="list">${g.queued.map((d, k) => queuedRow(d, k + 1, k >= QUEUE_SHOWN)).join('')}</div>${hidden > 0 && !expandQueued ? `<div class="dl-more"><button class="btn btn--ghost btn--sm phone-only" type="button" data-act="more-queued">Show ${hidden} more${icon('chevron-down', 'icon--16')}</button></div>` : ''}</section>`);
      }
      if (g.done.length) {
        const size = g.done.reduce((s, d) => s + (d.total_bytes || 0), 0);
        const rows = expandDone ? g.done : g.done.slice(0, DONE_SHOWN_DESKTOP);
        const moreD = g.done.length - DONE_SHOWN_DESKTOP, moreP = g.done.length - DONE_SHOWN;
        out.push(`<section class="dl-section" aria-labelledby="h-done"><div class="section-head section-head--sm"><h3 id="h-done">Done<span class="section-head__sub num">${g.done.length}${size ? ` · ${fmtBytes(size)}` : ''}</span></h3></div><div class="list">${rows.map((d, k) => doneRow(d, k >= DONE_SHOWN)).join('')}</div>${!expandDone && (moreD > 0 || moreP > 0) ? `<div class="dl-more">${moreD > 0 ? `<button class="btn btn--ghost btn--sm desktop-only" type="button" data-act="more-done">Show ${moreD} more${icon('chevron-down', 'icon--16')}</button>` : ''}${moreP > 0 ? `<button class="btn btn--ghost btn--sm phone-only" type="button" data-act="more-done">Show ${moreP} more${icon('chevron-down', 'icon--16')}</button>` : ''}</div>` : ''}</section>`);
      }
      return out.join('');
    }
    function actionsHTML(g) {
      const busy = g.active.length + g.queued.length;
      const main = busy ? `<button class="btn btn--primary" type="button" data-act="pause-all">${icon('pause-line')}Pause all</button>`
        : g.paused.length ? `<button class="btn btn--primary" type="button" data-act="resume-all">${icon('play', 'dl-glyph')}Resume all</button>` : '';
      const clear = g.done.length ? `<button class="btn btn--secondary" type="button" data-act="clear">Clear finished<span class="faint num">${g.done.length}</span></button>` : '';
      return main + clear;
    }

    // ---------------------------------------------------------------- render
    function render() {
      const page = $('[data-page]');
      if (loadErr && !list) {
        set($('[data-summary]'), `<div class="card">${emptyState({ icon: 'alert', error: true, title: 'Couldn’t read the download queue', text: loadErr.message || String(loadErr), actions: `<button class="btn btn--primary" type="button" data-act="reload">${icon('refresh')}Try again</button>` })}</div>`);
        set($('[data-sections]'), '');
        return;
      }
      if (!list) {
        $('[data-sub]').textContent = 'Restoring queue…';
        set($('[data-summary]'), `<div class="card card--pad-lg dl-summary" aria-busy="true"><div class="stats skel-stats">${'<div class="skel-stat"><i class="skel skel--title"></i><i class="skel skel--text"></i></div>'.repeat(4)}<div class="skel-stat skel-stat--wide desktop-only"><i class="skel skel--title"></i><i class="skel skel--text"></i></div></div><div class="progress-line"><div class="progress-line__meta"><span><strong>Checking files</strong></span><span class="dl-status-text">Reading the download folder</span></div><div class="progress progress--thick progress--indeterminate"><i></i></div></div></div>`);
        set($('[data-sections]'), `<div class="list">${Array.from({ length: 4 }, (_, i) => `<div class="skel-row"><i class="skel ${i < 3 ? 'skel--circle' : 'skel--art'}"></i><div class="stack"><i class="skel skel--title" style="width:${[55, 70, 45, 60][i]}%"></i><i class="skel skel--text w-40"></i></div><i class="skel skel--btn skel--btn-sm"></i></div>`).join('')}</div>`);
        return;
      }
      const dir = platform.value?.download_dir;
      $('[data-sub]').textContent = `YouTube Music songs saved for offline${dir ? ` · ${dir}` : ''}`;
      const g = groups();
      const actions = actionsHTML(g);
      set($('[data-head-actions]'), actions);
      const dock = $('[data-dock]');
      dock.hidden = !actions;
      set(dock, actions);
      set($('[data-banners]'), bannersHTML(g));
      if (!list.length) {
        set($('[data-summary]'), `<div class="card card--flush"><div class="empty">
          <div class="empty__icon">${icon('download')}</div>
          <div class="empty__title">Nothing downloading</div>
          <div class="empty__text">Find a song, album or artist on YouTube Music and tap Download. It queues here and then plays with no connection, artwork and all.</div>
          <div class="empty__actions dl-empty-actions"><a class="btn btn--primary" href="#search">${icon('search')}Search YouTube Music</a>${likedTodo ? `<button class="btn btn--secondary" type="button" data-act="dl-liked">${icon('heart')}Download liked songs<span class="faint num">${likedTodo}</span></button>` : ''}</div>
          ${storage ? `<div class="help num">${fmtBytes(storage.downloads_bytes)} used by downloads · ${fmtBytes(storage.free_bytes)} free on this disk</div>` : ''}
        </div></div>`);
        set($('[data-sections]'), '');
        return;
      }
      set($('[data-summary]'), summaryHTML(g));
      set($('[data-sections]'), sectionsHTML(g));
      void page;
    }

    // ---------------------------------------------------------------- actions
    const byId = (id) => list?.find((d) => String(d.id) === String(id));
    async function act(fn, d) { await guard(fn); pokeDownloads(); void d; }
    async function playDone(d) {
      const t = d.track_id ? tracks.get(d.track_id) || await api.track(d.track_id).catch(() => null) : null;
      if (!t) { toast('This song isn’t in the library any more', { kind: 'danger' }); return; }
      const done = groups().done.map((x) => tracks.get(x.track_id)).filter(Boolean);
      const idx = done.findIndex((x) => x.id === t.id);
      player.play(idx >= 0 ? done : [t], Math.max(0, idx), { type: 'downloads', name: 'Downloads' });
    }
    function rowMenu(anchor, d) {
      const i = info(d);
      const items = {
        active: [{ label: 'Pause', icon: 'pause-line', run: () => act(() => api.pauseDownload(d.id)) }, { sep: true }, { label: 'Cancel download', icon: 'x', danger: true, run: () => act(() => api.removeDownload(d.id)) }],
        paused: [{ label: 'Resume', icon: 'play', run: () => act(() => api.resumeDownload(d.id)) }, { sep: true }, { label: 'Cancel download', icon: 'x', danger: true, run: () => act(() => api.removeDownload(d.id)) }],
        queued: [{ label: 'Remove from queue', icon: 'x', danger: true, run: () => act(() => api.removeDownload(d.id)) }],
        error: [{ label: 'Retry', icon: 'refresh', run: () => act(() => api.retryDownload(d.id)) }, { sep: true }, { label: 'Remove', icon: 'x', danger: true, run: () => act(() => api.removeDownload(d.id)) }],
        done: [d.track_id && { label: 'Play', icon: 'play', run: () => playDone(d) }, { label: 'Remove from list', icon: 'x', hint: 'keeps the file', run: () => act(() => api.removeDownload(d.id)) }].filter(Boolean),
      }[d.state] || [];
      const sub = [d.total_bytes ? `${mb(d.total_bytes)} MB` : '', i.track?.bitrate_kbps ? `${i.track.bitrate_kbps} kbps` : '', d.state === 'queued' ? ordinal(groups().queued.indexOf(d) + 1) : ''].filter(Boolean).join(' · ');
      openMenu(anchor, items, { title: i.artist ? `${i.title} — ${i.artist}` : i.title, sub, label: `${i.title} download actions` });
    }

    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !root.contains(b)) return;
      const d = byId(b.closest('[data-id]')?.dataset.id);
      const g = list ? groups() : null;
      switch (b.dataset.act) {
        case 'pause': await act(() => api.pauseDownload(d.id)); break;
        case 'resume': await act(() => api.resumeDownload(d.id)); break;
        case 'retry': await act(() => (d.state === 'error' ? api.retryDownload(d.id) : api.resumeDownload(d.id))); break;
        case 'remove': await act(() => api.removeDownload(d.id)); break;
        case 'play': await playDone(d); break;
        case 'row-menu': rowMenu(b, d); break;
        case 'retry-all': await act(async () => { for (const x of g.failed) await api.retryDownload(x.id); }); toast(`Retrying ${plural(g.failed.length, 'download')}`, { kind: 'info' }); break;
        case 'pause-all': await act(async () => { for (const x of [...g.active, ...g.queued]) await api.pauseDownload(x.id); }); toast('Downloads paused', { kind: 'info' }); break;
        case 'resume-all': await act(async () => { for (const x of g.paused) await api.resumeDownload(x.id); }); toast('Downloads resumed', { kind: 'info' }); break;
        case 'clear': await act(() => api.clearFinishedDownloads()); toast(`Cleared ${plural(g.done.length, 'finished download')} — the songs stay in your library`, { kind: 'ok' }); break;
        case 'try-now': pokeDownloads(); break;
        case 'more-queued': expandQueued = true; render(); break;
        case 'more-done': expandDone = true; render(); break;
        case 'reload': loadErr = null; await first(); break;
        case 'dl-liked': {
          b.disabled = true;
          const ids = await guard(() => api.downloadPlaylist(0));
          if (ids) { pokeDownloads(); toast(`Downloading ${plural(ids.length, 'liked song')}`, { kind: 'info' }); }
          break;
        }
      }
    });

    // ---------------------------------------------------------------- data
    async function sideData() {
      const [st, liked, sts] = await Promise.all([api.storageInfo().catch(() => null), api.tracks('music', { filter: 'liked' }).catch(() => []), api.stats().catch(() => null)]);
      storage = st;
      likedTodo = liked.filter((t) => !t.path && !t.downloaded && t.video_id).length;
      songsOnDisk = sts ? sts.downloaded : null;
      render();
    }
    async function first() {
      render();
      try { list = await api.downloads(); downloads.set(list); } catch (e) { loadErr = e; }
      render();
      fetchTracks();
    }
    cleanups.push(downloads.subscribe((v) => { if (!downloads.loaded) return; list = v; render(); fetchTracks(); }));
    cleanups.push(online.subscribe(() => render()));
    cleanups.push(platform.subscribe(() => render()));
    const onChanged = () => { sideData(); statsStore.refresh(); };
    addEventListener('library:changed', onChanged);
    cleanups.push(() => removeEventListener('library:changed', onChanged));
    const storageTimer = setInterval(() => { if (!document.hidden) api.storageInfo().then((s) => { storage = s; render(); }).catch(() => {}); }, 30000);
    cleanups.push(() => clearInterval(storageTimer));

    if (downloads.loaded) { list = downloads.value; render(); fetchTracks(); } else await first();
    if (!platform.loaded) platform.refresh();
    sideData();
    pokeDownloads();
    return () => cleanups.forEach((fn) => { try { fn(); } catch {} });
  },
};
