// Playlist detail (design/screens/playlist.html v2.1). Route: #playlist/<id>  (id 0 = Liked songs).
//
// Hero (cover mosaic from the first four songs, meta, Play / Shuffle / Download all · Pause
// download with a live progress line, Add songs, Edit, ⋯), failed-download and offline banners,
// the song list (sort, Downloaded only, per-row download state), and the inline "Add songs"
// search (YouTube Music + library; library only when offline). Edit mode renames, reorders by
// drag handle (pointer) or arrow keys on the handle, removes, and deletes the playlist.

import { api } from '../api.js';
import { addItemsToPlaylist } from '../components/actions.js';
import { artHTML, mosaicCellHTML } from '../components/art.js';
import { downloadFor, downloads, itemKey, online, playlists as plStore, pokeDownloads, rememberDownload, stats as statsStore } from '../components/store.js';
import { bindTrackList } from '../components/tracks.js';
import { player } from '../player.js';
import { banner, confirmDialog, debounce, emptyState, esc, fmtAgo, fmtBytes, fmtDuration, fmtLongDuration, fmtNum, guard, h, icon, openMenu, plural, toast } from '../ui.js';

const EST_BYTES_PER_SEC = 32000;                 // ≈ 256 kbps m4a, for "Download all · ≈ 86 MB"
const playable = (t) => !!(t.path || t.downloaded);
const ORIGIN = { spotify: 'Spotify', youtube: 'YouTube Music', soundcloud: 'SoundCloud' };
const SORTS = {
  custom: ['Custom order', null],
  title: ['Title', (a, b) => a.track.title.localeCompare(b.track.title)],
  artist: ['Artist', (a, b) => (a.track.artist || '').localeCompare(b.track.artist || '') || a.position - b.position],
  added: ['Recently added', (a, b) => b.entry_id - a.entry_id],
};

function mosaic(pl, tracks, cls = '') {
  if (pl.is_liked) return `<div class="pl-mosaic pl-mosaic--single pl-mosaic--liked ${cls}" role="img" aria-label="Liked songs artwork">${artHTML(pl, { kind: 'playlist', size: 'fill' })}</div>`;
  if (tracks.length >= 4) return `<div class="pl-mosaic ${cls}" role="img" aria-label="Playlist artwork: covers of the first four songs">${tracks.slice(0, 4).map((t) => mosaicCellHTML(t, { tag: 'div', cls: 'art pl-mosaic__cell' })).join('')}</div>`;
  if (tracks.length) return `<div class="pl-mosaic pl-mosaic--single ${cls}" role="img" aria-label="Playlist artwork">${artHTML(tracks[0], { size: 'fill' })}</div>`;
  return `<div class="pl-mosaic pl-mosaic--single ${cls}" role="img" aria-label="Generated playlist artwork">${artHTML(pl, { kind: 'playlist', size: 'fill' })}</div>`;
}
const xsRing = (p) => `<svg class="ring ring--xs" viewBox="0 0 36 36" aria-hidden="true"><circle class="ring__bg" cx="18" cy="18" r="15.5"/><circle class="ring__fg" cx="18" cy="18" r="15.5" pathLength="100" style="--p:${Math.round(p * 100)}"/></svg>`;

export default {
  title: 'Playlist',
  async render(root, params, ctx) {
    const id = Number(params.id ?? 0);
    const isLiked = id === 0;
    let pl = null, entries = [], loadErr = null, imported = null;
    let sortKey = 'custom', dlOnly = false, editing = false;
    let rows = [];                                // entries in display order (data-idx indexes it)
    const cleanups = [];

    root.innerHTML = `<div class="page" data-page>
      <section class="pl-hero" aria-busy="true"><span class="skel skel--mosaic"></span><div class="pl-info"><span class="skel skel--text w-40"></span><span class="skel skel--h1"></span><span class="skel skel--text"></span><div class="pl-actions"><span class="skel skel--play"></span><span class="skel skel--circle"></span><span class="skel skel--btn"></span><span class="skel skel--btn skel--btn-lg"></span></div></div></section>
      <div class="list" aria-busy="true">${Array.from({ length: 6 }, (_, i) => `<div class="skel-row skel-row--pl"><span class="skel skel--num"></span><span class="skel skel--art"></span><div class="stack"><span class="skel skel--title"></span><span class="skel skel--text${i % 2 ? '' : ' w-40'}"></span></div><span class="skel skel--chip"></span></div>`).join('')}</div>
    </div>`;
    const page = root.querySelector('[data-page]');

    // ---------------------------------------------------------------- data
    async function load() {
      try {
        const d = await api.playlist(id);
        pl = d.playlist; entries = d.entries; loadErr = null;
        ctx.setTitle(pl.name);
        document.title = `${pl.name} · Tarang`;
        if (pl.imported_from && imported == null) {
          api.importHistory().then((hist) => { imported = hist.find((x) => x.playlist_id === pl.id) || false; if (!editing) renderBanners(); }).catch(() => { imported = false; });
        }
      } catch (e) { loadErr = e; }
    }
    const tracks = () => entries.map((e) => e.track);

    /** Download progress of this playlist's songs (from the shared downloads store). */
    function dlStatus() {
      const ts = tracks();
      const wanted = ts.filter((t) => playable(t) || t.video_id);
      const done = ts.filter(playable);
      const st = { active: [], queued: [], paused: [], failed: [] };
      for (const t of ts) {
        if (playable(t)) continue;
        const d = downloadFor(t);
        if (!d) continue;
        if (d.state === 'active') st.active.push(d); else if (d.state === 'queued') st.queued.push(d);
        else if (d.state === 'paused') st.paused.push(d); else if (d.state === 'error') st.failed.push({ d, t });
      }
      const partial = [...st.active, ...st.paused].reduce((s, d) => s + (d.progress || 0), 0);
      const total = wanted.length;
      return {
        ...st, total, done: done.length,
        doneBytes: done.reduce((s, t) => s + (t.size_bytes || 0), 0),
        todoBytes: ts.filter((t) => !playable(t) && t.video_id).reduce((s, t) => s + (t.duration_secs || 0) * EST_BYTES_PER_SEC, 0),
        todo: ts.filter((t) => !playable(t) && t.video_id && !downloadFor(t)).length + st.failed.length,
        inflight: st.active.length + st.queued.length,
        progress: total ? (done.length + partial) / total : 0,
        speed: st.active.reduce((s, d) => s + (d.speed_bps || 0), 0),
        eta: st.active.length ? Math.max(...st.active.map((d) => d.eta_secs || 0)) + st.queued.length * 20 : null,
      };
    }
    const etaText = (s) => (s == null ? '' : s < 60 ? 'under a minute left' : `about ${Math.round(s / 60)} min left`);

    // ---------------------------------------------------------------- hero
    function metaHTML(s) {
      const parts = [`<span><strong>${plural(pl.track_count, 'song')}</strong></span>`];
      if (!entries.length) parts.push(`<span>Created ${fmtAgo(pl.created_at)}</span>`);
      else {
        parts.push(`<span>${fmtLongDuration(pl.total_secs)}</span>`);
        parts.push(s.done
          ? `<span class="cluster">${icon('check', 'sg sg--dl')}${s.done >= entries.length ? `All ${fmtNum(s.done)} downloaded` : `${fmtNum(s.done)} of ${fmtNum(entries.length)} downloaded`}${s.doneBytes ? ` · ${fmtBytes(s.doneBytes)}` : ''}</span>`
          : `<span class="cluster">${icon('stream', 'sg sg--st')}Streams · 0 downloaded</span>`);
      }
      return parts.join('<span class="sep"></span>');
    }
    function dlSlot(s) {
      if (!entries.length) return '';
      if (s.inflight) {
        return `<button class="btn btn--secondary lbl-btn" type="button" data-act="pause-dl" aria-label="Pause downloading this playlist">${icon('pause')}<span class="lbl">Pause download</span></button>`;
      }
      if (s.paused.length) return `<button class="btn btn--secondary lbl-btn" type="button" data-act="resume-dl" aria-label="Resume downloading this playlist">${icon('download')}<span class="lbl">Resume download</span></button>`;
      if (s.todo && s.total > s.done) return `<button class="btn btn--secondary lbl-btn" type="button" data-act="download-all"${online.value ? '' : ' disabled'} aria-label="Download all songs">${icon('download')}<span class="lbl">Download all${s.todoBytes ? ` · ≈ ${fmtBytes(s.todoBytes)}` : ''}</span></button>`;
      if (s.done && s.done >= entries.length) return `<span class="badge badge--ok">${icon('check')}Downloaded</span>`;
      return '';
    }
    function progressLine(s) {
      if (s.inflight) {
        const cur = Math.min(s.total, s.done + 1);
        return `<div class="progress-line pl-dl" role="status" aria-label="Download all progress"><div class="progress-line__meta"><span>Downloading <strong>${cur} of ${s.total}</strong></span><strong class="num">${Math.round(s.progress * 100)}%</strong></div><div class="progress" style="--p:${Math.round(s.progress * 100)}%"><i></i></div><div class="progress-line__meta"><span>${[s.speed ? `${fmtBytes(s.speed)}/s` : '', s.queued.length ? `${s.queued.length} queued` : '', s.failed.length ? `${s.failed.length} failed` : ''].filter(Boolean).join(' · ')}</span><span>${etaText(s.eta)}</span></div></div>`;
      }
      if (s.paused.length) return `<div class="progress-line pl-dl" role="status"><div class="progress-line__meta"><span>Paused at <strong>${s.done} of ${s.total}</strong></span><strong class="num">${Math.round(s.progress * 100)}%</strong></div><div class="progress progress--paused" style="--p:${Math.round(s.progress * 100)}%"><i></i></div></div>`;
      return '';
    }
    function heroHTML() {
      const s = dlStatus();
      const ts = tracks();
      const has = entries.length > 0;
      return `<section class="pl-hero" aria-labelledby="pl-title">
        ${mosaic(pl, ts)}
        <div class="pl-info">
          <nav class="crumb desktop-only" aria-label="Breadcrumb"><a href="#library">Library</a>${icon('chevron-right')}<span>${esc(pl.name)}</span></nav>
          <div class="eyebrow">${isLiked ? 'Auto playlist' : 'Playlist'}</div>
          <h1 id="pl-title">${esc(pl.name)}</h1>
          ${pl.description ? `<p class="pl-desc">${esc(pl.description)}</p>` : isLiked ? '<p class="pl-desc">Every song you’ve liked, streamed or downloaded. Updates itself.</p>' : ''}
          <div class="meta pl-meta num" data-meta>${metaHTML(s)}</div>
          ${pl.imported_from ? `<div class="pl-origin">Imported from ${ORIGIN[pl.imported_from] || pl.imported_from} on ${new Date(pl.created_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</div>` : ''}
          ${has ? `<div class="pl-actions" data-actions>
            <button class="btn btn--icon btn--primary pl-play" type="button" data-act="play" aria-label="Play ${esc(pl.name)}">${icon('play')}</button>
            <button class="btn btn--icon btn--secondary pl-shuffle" type="button" data-act="shuffle" aria-label="Shuffle play">${icon('shuffle')}</button>
            <span data-dlslot style="display:contents">${dlSlot(s)}</span>
            ${isLiked ? '' : `<button class="btn btn--secondary lbl-btn lbl-btn--icon" type="button" data-act="add" aria-label="Add songs">${icon('plus')}<span class="lbl">Add songs</span></button>
            <button class="btn btn--secondary lbl-btn lbl-btn--icon" type="button" data-act="edit" aria-label="Edit playlist">${icon('edit')}<span class="lbl">Edit</span></button>`}
            <button class="btn btn--icon" type="button" data-act="more" aria-haspopup="menu" aria-label="More options for ${esc(pl.name)}">${icon('more')}</button>
            <span data-progress style="display:contents">${progressLine(s)}</span>
          </div>` : ''}
        </div>
      </section>`;
    }

    // ---------------------------------------------------------------- banners
    function bannersHTML() {
      const s = dlStatus();
      const out = [];
      if (!online.value && entries.length) {
        const off = entries.length - s.done;
        if (off) out.push(banner({ kind: 'warn', icon: 'offline', title: 'You’re offline', text: `${off} of ${plural(entries.length, 'song')} aren’t downloaded and will play again when you reconnect. Play and Shuffle use the ${fmtNum(s.done)} downloaded song${s.done === 1 ? '' : 's'}.` }));
      }
      if (s.failed.length) {
        const { d, t } = s.failed[0];
        const more = s.failed.length > 1 ? ` (and ${s.failed.length - 1} more)` : '';
        out.push(`<div class="banner banner--danger" role="alert">${icon('alert')}<div class="banner__body"><div class="banner__title">${esc(t.title)} couldn’t download${more}</div><div class="banner__text">${esc(d.error || 'The download stopped.')} It still streams when you’re online.</div></div><button class="btn btn--secondary btn--sm" type="button" data-act="retry-failed">${icon('refresh')}Retry</button></div>`);
      }
      if (imported && imported.total > imported.matched) {
        const n = imported.total - imported.matched;
        out.push(`<div class="banner banner--info">${icon('info')}<div class="banner__body"><div class="banner__title">${plural(n, 'song')} from the original ${n === 1 ? 'wasn’t' : 'weren’t'} found</div><div class="banner__text">They’re listed in Settings → Import from other apps, where you can pick a match or skip them.</div></div><a class="btn btn--secondary btn--sm" href="#settings">Review</a></div>`);
      }
      return out.join('');
    }
    function renderBanners() { const el = page.querySelector('[data-banners]'); if (el) el.innerHTML = bannersHTML(); }

    // ---------------------------------------------------------------- song list
    function subHTML(t) {
      const off = !online.value && !playable(t);
      let st;
      if (playable(t)) st = icon('check', 'sg sg--dl', 'Downloaded');
      else {
        const d = downloadFor(t);
        if (d?.state === 'active') st = `<span class="dl-prog" aria-label="Downloading, ${Math.round(d.progress * 100)}%">${xsRing(d.progress)}<span class="num">${Math.round(d.progress * 100)}%</span></span>`;
        else if (d?.state === 'queued') st = `${icon('stream', 'sg sg--st', 'Streams until downloaded')}<span class="badge">Queued</span>`;
        else if (d?.state === 'paused') st = `${icon('stream', 'sg sg--st', 'Streams until downloaded')}<span class="badge">Paused</span>`;
        else if (d?.state === 'error') st = `<span class="badge badge--danger" title="${esc(d.error || '')}">${icon('alert')}Failed</span>`;
        else if (off) st = `<span class="dl-stream">${icon('stream', 'sg sg--st')}Needs internet</span>`;
        else st = t.video_id ? icon('stream', 'sg sg--st', 'Streams') : '';
      }
      return `${st}<span class="row__artist">${esc(t.artist || 'Unknown artist')}</span>`;
    }
    function rowState(t) {
      const d = !playable(t) && downloadFor(t);
      return [d?.state === 'error' ? 'is-failed' : '', !online.value && !playable(t) ? 'is-disabled' : ''].filter(Boolean).join(' ');
    }
    function rowHTML(e, i) {
      const t = e.track;
      return `<div class="row song ${rowState(t)}" data-idx="${i}" data-key="${esc(itemKey(t))}" data-entry="${e.entry_id}">
        <div class="row__num"><span>${i + 1}</span><button class="btn btn--icon btn--sm" type="button" data-act="play" aria-label="Play ${esc(t.title)}">${icon('play', 'icon--16 icon--fill')}</button></div>
        ${artHTML(t)}
        <div class="row__main"><div class="row__title">${esc(t.title)}</div><div class="row__sub">${subHTML(t)}</div></div>
        <div class="row__album">${esc(t.album || '')}</div>
        <div class="row__dur">${fmtDuration(t.duration_secs)}</div>
        <button class="btn btn--icon btn--sm like row__like${t.liked ? ' is-liked' : ''}" type="button" data-act="like" aria-pressed="${!!t.liked}" aria-label="${t.liked ? 'Liked' : 'Like'} ${esc(t.title)}">${icon('heart', 'icon--16')}</button>
        <button class="btn btn--icon btn--sm row__menu" type="button" data-act="menu" aria-haspopup="menu" aria-label="More options for ${esc(t.title)}">${icon('more', 'icon--16')}</button>
      </div>`;
    }
    function footText() {
      const s = dlStatus();
      const bits = [`${fmtNum(s.done)} downloaded`, s.active.length && `${s.active.length} downloading`, s.queued.length && `${s.queued.length} queued`, s.paused.length && `${s.paused.length} paused`, s.failed.length && `${s.failed.length} failed`].filter(Boolean);
      return `${plural(entries.length, 'song')} · ${fmtLongDuration(pl.total_secs)} · ${bits.join(', ')}`;
    }
    function listHTML() {
      rows = entries.slice();
      if (SORTS[sortKey][1]) rows.sort(SORTS[sortKey][1]);
      if (dlOnly) rows = rows.filter((e) => playable(e.track));
      const countText = sortKey === 'custom' ? (isLiked ? 'Most recently liked first' : 'Custom order · drag in Edit to reorder') : `Sorted by ${SORTS[sortKey][0].toLowerCase()}`;
      return `<div class="pl-tools">
          <span class="pl-tools__count muted t-13 num">${countText}</span>
          <div class="pl-tools__right">
            <label class="toggle t-13"><input type="checkbox" data-dlonly${dlOnly ? ' checked' : ''}><span class="toggle__track"></span><span>Downloaded only</span></label>
            <select class="select" data-sort aria-label="Sort songs">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}"${k === sortKey ? ' selected' : ''}>${k === 'custom' && isLiked ? 'Recently liked' : l}</option>`).join('')}</select>
          </div>
        </div>
        <div class="list" data-list>
          <div class="row row--head"><div class="row__num">#</div><div></div><div>Title</div><div>Album</div><div class="row__dur" aria-label="Duration">${icon('clock', 'icon--16')}</div><div aria-label="Liked"></div><div aria-label="More"></div></div>
          ${rows.length ? rows.map(rowHTML).join('') : emptyState({ icon: 'download', compact: true, title: 'No downloaded songs yet', text: 'Turn off “Downloaded only” to see every song, or download the playlist.' })}
        </div>
        <div class="pl-foot" data-foot>${footText()}</div>`;
    }

    // ---------------------------------------------------------------- add songs (inline search)
    let addQuery = '', addResults = null, addBusy = false, addSeq = 0;
    const inPlaylist = (it) => entries.some((e) => (it.id && e.track.id === it.id) || (it.local_track_id && e.track.id === it.local_track_id) || (it.video_id && e.track.video_id === it.video_id));
    function resultsHTML() {
      if (!addQuery) return '';
      if (addBusy) return `<div class="list" aria-busy="true">${Array.from({ length: 3 }, (_, i) => `<div class="skel-row"><span class="skel skel--art"></span><div class="stack"><span class="skel skel--title"></span><span class="skel skel--text${i % 2 ? '' : ' w-40'}"></span></div><span class="skel skel--btn"></span></div>`).join('')}</div>`;
      const offline = !online.value ? banner({ kind: 'warn', icon: 'offline', title: 'Searching needs internet', text: 'Showing matches from your downloads.' }) : '';
      if (!addResults?.length) return offline + emptyState({ icon: 'search', compact: true, title: 'No songs match', text: online.value ? 'Check the spelling or try just the artist name.' : 'Nothing you’ve downloaded matches. Try again when you’re online.', actions: online.value ? `<a class="btn btn--secondary btn--sm" href="#search?q=${encodeURIComponent(addQuery)}">Search “${esc(addQuery)}” in Search</a>` : '' });
      return offline + `<div class="list" data-results>${addResults.map((r, i) => {
        const added = inPlaylist(r);
        const local = playable(r);
        return `<div class="row row--result" data-ridx="${i}">${artHTML(r)}<div class="row__main"><div class="row__title">${esc(r.title)}</div><div class="row__sub">${local ? icon('check', 'sg sg--dl', 'Downloaded') : icon('stream', 'sg sg--st', 'Streams')}<span class="row__artist">${esc(r.artist || 'Unknown artist')}${r.album ? ` · ${esc(r.album)}` : ''}</span></div></div><div class="row__dur">${fmtDuration(r.duration_secs)}</div><div class="row__actions">${online.value || local ? `<button class="btn btn--icon btn--sm row__play" type="button" data-act="preview" aria-label="Preview ${esc(r.title)}${local ? '' : ' (streams)'}">${icon('play', 'icon--16 icon--fill')}</button>` : ''}${added ? `<button class="btn btn--ghost btn--sm is-added" type="button" disabled aria-label="Added to ${esc(pl.name)}">${icon('check')}Added</button>` : `<button class="btn btn--secondary btn--sm" type="button" data-act="add-one" aria-label="Add ${esc(r.title)} to ${esc(pl.name)}">${icon('plus')}Add</button>`}</div></div>`;
      }).join('')}</div>`;
    }
    function addMetaHTML() {
      if (!addQuery || addBusy || !addResults) return '';
      const n = addResults.filter(inPlaylist).length;
      return `${n ? `<span>${n} added</span><span class="sep"></span>` : ''}<span>${plural(addResults.length, 'result')}</span>`;
    }
    function renderAddResults() {
      const box = page.querySelector('[data-add-results]');
      if (box) box.innerHTML = resultsHTML();
      const meta = page.querySelector('[data-add-meta]');
      if (meta) meta.innerHTML = addMetaHTML();
    }
    const runSearch = debounce(async (q) => {
      addQuery = q;
      const seq = ++addSeq;
      if (!q) { addResults = null; addBusy = false; renderAddResults(); return; }
      addBusy = true; renderAddResults();
      const local = api.tracks('music', { query: q, limit: 8 }).catch(() => []);
      const remote = online.value ? api.youtubeSearch(q, 10).catch(() => null) : Promise.resolve([]);
      const [loc, yt] = await Promise.all([local, remote]);
      if (seq !== addSeq) return;
      const locMatches = online.value ? loc.slice(0, 4) : loc.filter(playable);
      const seen = new Set(locMatches.map((t) => t.video_id).filter(Boolean));
      const ids = new Set(locMatches.map((t) => t.id));
      const fromYt = (yt || []).filter((r) => !seen.has(r.video_id) && !(r.local_track_id && ids.has(r.local_track_id)));
      addResults = [...locMatches, ...fromYt].slice(0, 10);
      addBusy = false;
      if (yt === null && !locMatches.length) toast('YouTube Music didn’t answer. Showing library matches only.', { kind: 'danger' });
      renderAddResults();
      if (fromYt.length) api.youtubePrefetch(fromYt.slice(0, 2).map((r) => r.video_id));
    }, 300);
    function addCardHTML() {
      if (isLiked) return '';
      if (!entries.length) {
        return `<div class="card empty empty--compact" data-add>
          <div class="empty__icon">${icon('playlist')}</div>
          <div class="empty__title">Add your first songs</div>
          <p class="empty__text">Search YouTube Music or your library. You can also add from any song’s ⋯ menu.</p>
          <div class="search search--lg empty__search">${icon('search')}<input class="search__input" data-add-input placeholder="Songs, artists or albums" aria-label="Search songs to add" autocomplete="off" value="${esc(addQuery)}"></div>
          <div class="empty__search" data-add-results>${resultsHTML()}</div>
        </div>`;
      }
      return `<section class="card card--pad-lg add-card" aria-labelledby="h-add" data-add>
        <div class="between"><div><h3 class="t-16" id="h-add">Add songs</h3><div class="card__sub">Search YouTube Music and your library. Use Download all to keep new songs offline.</div></div><span class="meta num" data-add-meta>${addMetaHTML()}</span></div>
        <div class="search search--lg">${icon('search')}<input class="search__input" data-add-input placeholder="Songs, artists or albums" aria-label="Search songs to add" autocomplete="off" value="${esc(addQuery)}"><button class="btn btn--icon btn--sm search__clear" type="button" data-act="clear-add" aria-label="Clear"${addQuery ? '' : ' hidden'}>${icon('x', 'icon--16')}</button></div>
        <div data-add-results>${resultsHTML()}</div>
      </section>`;
    }

    // ---------------------------------------------------------------- render
    function render() {
      if (loadErr) {
        ctx.setTrail(null);
        page.innerHTML = `<div class="card">${emptyState({ icon: 'x-circle', error: true, title: pl ? `Couldn’t open “${pl.name}”` : 'Couldn’t open this playlist', text: loadErr.message || String(loadErr), actions: `<button class="btn btn--primary" type="button" data-act="reload">${icon('refresh')}Try again</button><a class="btn btn--secondary" href="#library">Back to Library</a>` })}</div>`;
        return;
      }
      ctx.setTrail(trail);
      if (editing) { renderEdit(); return; }
      page.innerHTML = `${heroHTML()}
        ${entries.length ? `<section class="pl-list" aria-label="Songs in ${esc(pl.name)}"><div data-banners style="display:contents">${bannersHTML()}</div>${listHTML()}</section>` : `<div data-banners style="display:contents">${bannersHTML()}</div>`}
        ${addCardHTML()}`;
    }
    /** Live refresh of download state without rebuilding the page (keeps focus and scroll). */
    let lastSig = '';
    function patchLive() {
      if (editing || !pl || loadErr) return;
      const s = dlStatus();
      const sig = JSON.stringify([s.done, s.active.map((d) => [d.id, Math.round(d.progress * 100)]), s.queued.length, s.paused.length, s.failed.length, online.value]);
      if (sig === lastSig) return;
      lastSig = sig;
      const meta = page.querySelector('[data-meta]'); if (meta) meta.innerHTML = metaHTML(s);
      const slot = page.querySelector('[data-dlslot]'); if (slot) slot.innerHTML = dlSlot(s);
      const prog = page.querySelector('[data-progress]'); if (prog) prog.innerHTML = progressLine(s);
      renderBanners();
      page.querySelectorAll('[data-list] .row.song').forEach((row) => {
        const e = rows[Number(row.dataset.idx)];
        if (!e) return;
        const html = subHTML(e.track);
        const sub = row.querySelector('.row__sub');
        if (sub.dataset.html !== html) { sub.dataset.html = html; sub.innerHTML = html; }
        row.className = `row song ${rowState(e.track)}${row.classList.contains('is-playing') ? ' is-playing' : ''}`;
      });
      const foot = page.querySelector('[data-foot]'); if (foot) foot.textContent = footText();
    }

    // ---------------------------------------------------------------- edit mode
    let draft = null;   // { name, description, order: entry[], removed: Set }
    function startEdit() {
      if (isLiked) return;
      draft = { name: pl.name, description: pl.description || '', order: entries.slice(), removed: new Set() };
      editing = true;
      render();
      page.querySelector('#ed-name')?.focus();
    }
    function erowHTML(e, i) {
      const t = e.track;
      return `<div class="erow" data-eidx="${i}" data-entry="${e.entry_id}"><button class="erow__grip" type="button" data-grip aria-label="Drag to reorder ${esc(t.title)}. Arrow keys move it.">${icon('grip')}</button>${artHTML(t)}<div class="row__main"><div class="row__title">${esc(t.title)}</div><div class="row__sub"><span class="row__artist">${esc(t.artist || 'Unknown artist')}</span></div></div><div class="row__dur">${fmtDuration(t.duration_secs)}</div><button class="btn btn--icon btn--sm erow__remove" type="button" data-act="e-remove" aria-label="Remove ${esc(t.title)} from playlist">${icon('x', 'icon--16')}</button></div>`;
    }
    function editListHTML() {
      const live = draft.order.filter((e) => !draft.removed.has(e.entry_id));
      return live.length ? live.map((e) => erowHTML(e, draft.order.indexOf(e))).join('') : emptyState({ icon: 'playlist', compact: true, title: 'Every song removed', text: 'Save to empty the playlist, or Cancel to keep them.' });
    }
    function renderEdit() {
      const live = draft.order.filter((e) => !draft.removed.has(e.entry_id));
      page.innerHTML = `<section class="edit-head" aria-label="Edit ${esc(pl.name)}">
          ${mosaic(pl, live.map((e) => e.track))}
          <div class="edit-fields">
            <div class="field"><label class="label" for="ed-name">Name</label><input class="input" id="ed-name" value="${esc(draft.name)}" autocomplete="off" maxlength="120"><span class="help help--error" data-name-err hidden></span></div>
            <div class="field"><label class="label" for="ed-desc">Description <span class="faint">(optional)</span></label><input class="input" id="ed-desc" value="${esc(draft.description)}" autocomplete="off" maxlength="300"><span class="help">Artwork is made from the first four songs.</span></div>
          </div>
        </section>
        <div class="list edit-list" aria-label="Songs, drag to reorder" data-elist>${editListHTML()}</div>
        <div class="edit-bar">
          <button class="btn btn--danger" type="button" data-act="delete">${icon('trash')}Delete playlist</button>
          <span class="grow"></span>
          <button class="btn btn--ghost" type="button" data-act="e-cancel">Cancel</button>
          <button class="btn btn--primary" type="button" data-act="e-save">${icon('check')}Save changes</button>
        </div>`;
      page.querySelector('#ed-name').addEventListener('input', (e) => { draft.name = e.target.value; validateName(); });
      page.querySelector('#ed-desc').addEventListener('input', (e) => { draft.description = e.target.value; });
    }
    function validateName() {
      const name = draft.name.trim();
      const taken = plStore.value.some((p) => p.id !== pl.id && p.name.trim().toLowerCase() === name.toLowerCase());
      const err = !name ? 'Give the playlist a name.' : taken ? `You already have a playlist called “${name}”. Pick another name.` : '';
      const el = page.querySelector('[data-name-err]'), input = page.querySelector('#ed-name'), save = page.querySelector('[data-act="e-save"]');
      if (el) { el.hidden = !err; el.textContent = err; }
      input?.classList.toggle('is-error', !!err); input?.setAttribute('aria-invalid', String(!!err));
      if (save) save.disabled = !!err;
      return !err;
    }
    function rerenderEditList(focusEntry) {
      const el = page.querySelector('[data-elist]');
      el.innerHTML = editListHTML();
      const mos = page.querySelector('.edit-head .pl-mosaic');
      if (mos) mos.outerHTML = mosaic(pl, draft.order.filter((e) => !draft.removed.has(e.entry_id)).map((e) => e.track));
      if (focusEntry != null) el.querySelector(`[data-entry="${focusEntry}"] [data-grip]`)?.focus();
    }
    function moveEntry(entryId, toLiveIndex) {
      const live = draft.order.filter((e) => !draft.removed.has(e.entry_id));
      const from = live.findIndex((e) => e.entry_id === entryId);
      if (from < 0) return;
      const [e] = live.splice(from, 1);
      live.splice(Math.max(0, Math.min(live.length, toLiveIndex)), 0, e);
      draft.order = [...live, ...draft.order.filter((x) => draft.removed.has(x.entry_id))];
    }
    async function saveEdit() {
      if (!validateName()) return;
      const name = draft.name.trim(), desc = draft.description.trim() || null;
      const live = draft.order.filter((e) => !draft.removed.has(e.entry_id)).map((e) => e.entry_id);
      const ok = await guard(async () => {
        if (name !== pl.name || desc !== (pl.description || null)) await api.renamePlaylist(id, name, desc);
        if (draft.removed.size) await api.removeFromPlaylist(id, [...draft.removed]);
        const before = entries.map((e) => e.entry_id).filter((x) => !draft.removed.has(x));
        if (live.join() !== before.join() && live.length) await api.reorderPlaylist(id, live);
        return true;
      });
      if (!ok) return;
      editing = false; draft = null;
      plStore.refresh(); statsStore.refresh();
      dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'playlist', playlistId: id } }));
      await load(); render();
      toast('Playlist saved', { kind: 'ok' });
    }
    async function deletePlaylist() {
      const ok = await confirmDialog({ title: `Delete “${pl.name}”?`, text: `The playlist goes away; its ${plural(pl.track_count, 'song')} stay in your library and downloads are kept.`, confirm: 'Delete playlist', danger: true });
      if (!ok) return;
      if (await guard(() => api.deletePlaylist(id).then(() => true))) {
        plStore.refresh(); statsStore.refresh();
        toast(`Deleted “${pl.name}”`, { kind: 'ok' });
        location.hash = '#library';
      }
    }

    // Drag to reorder (pointer). A drop line shows where the row lands.
    let drag = null;
    page.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('[data-grip]');
      if (!grip || !editing) return;
      const row = grip.closest('.erow');
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      row.classList.add('is-dragging');
      const line = h('<div class="drop-line" aria-hidden="true"></div>');
      drag = { row, grip, line, entry: Number(row.dataset.entry), startY: e.clientY, target: null };
    });
    page.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.row.style.transform = `translateY(${e.clientY - drag.startY}px)`;
      const others = [...page.querySelectorAll('[data-elist] .erow')].filter((r) => r !== drag.row);
      let idx = others.findIndex((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
      if (idx < 0) idx = others.length;
      drag.target = idx;
      const list = page.querySelector('[data-elist]');
      if (idx < others.length) list.insertBefore(drag.line, others[idx]); else list.appendChild(drag.line);
    });
    const endDrag = () => {
      if (!drag) return;
      const { entry, target, line } = drag;
      line.remove();
      drag.row.style.transform = '';
      drag.row.classList.remove('is-dragging');
      drag = null;
      if (target != null) { moveEntry(entry, target); rerenderEditList(entry); }
    };
    page.addEventListener('pointerup', endDrag);
    page.addEventListener('pointercancel', endDrag);
    page.addEventListener('keydown', (e) => {
      const grip = e.target.closest('[data-grip]');
      if (!grip || !editing || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const entry = Number(grip.closest('.erow').dataset.entry);
      const live = draft.order.filter((x) => !draft.removed.has(x.entry_id));
      const i = live.findIndex((x) => x.entry_id === entry);
      moveEntry(entry, i + (e.key === 'ArrowUp' ? -1 : 1));
      rerenderEditList(entry);
    });

    // ---------------------------------------------------------------- actions
    const playCtx = () => ({ type: isLiked ? 'liked' : 'playlist', id, name: pl.name });
    const visibleTracks = () => rows.map((e) => e.track);
    async function downloadAll() {
      const ids = await guard(() => api.downloadPlaylist(id));
      if (!ids) return;
      // Map each new download id to its song so rows show progress before the core reports track_id.
      const todo = tracks().filter((t) => !playable(t) && t.video_id && !downloadFor(t));
      ids.forEach((did, i) => todo[i] && rememberDownload(did, todo[i]));
      pokeDownloads();
      toast(ids.length ? `Downloading ${plural(ids.length, 'song')} from ${pl.name}` : 'Everything here is already downloaded', { kind: ids.length ? 'info' : 'ok', action: ids.length ? { label: 'View', run: () => { location.hash = '#downloads'; } } : null });
    }
    async function setPaused(pause) {
      const s = dlStatus();
      const list = pause ? [...s.active, ...s.queued] : s.paused;
      await guard(async () => { for (const d of list) await (pause ? api.pauseDownload(d.id) : api.resumeDownload(d.id)); });
      pokeDownloads();
      toast(pause ? `Paused ${plural(list.length, 'download')}` : `Resumed ${plural(list.length, 'download')}`, { kind: 'info' });
    }
    async function retryFailed() {
      const s = dlStatus();
      await guard(async () => { for (const { d } of s.failed) await api.retryDownload(d.id); });
      pokeDownloads();
    }
    function focusAdd() {
      const input = page.querySelector('[data-add-input]');
      if (!input) return;
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input.focus({ preventScroll: true });
    }
    function openPlMenu(anchor) {
      const s = dlStatus();
      const items = [
        !isLiked && { label: 'Add songs', icon: 'plus', run: focusAdd },
        !isLiked && { label: 'Edit: rename and reorder', icon: 'edit', run: startEdit },
        s.inflight ? { label: 'Pause download', icon: 'pause', hint: `${Math.min(s.total, s.done + 1)} of ${s.total}`, run: () => setPaused(true) }
          : s.paused.length ? { label: 'Resume download', icon: 'download', run: () => setPaused(false) }
            : s.todo ? { label: 'Download all', icon: 'download', hint: s.todoBytes ? `≈ ${fmtBytes(s.todoBytes)}` : '', disabled: !online.value, run: downloadAll } : null,
        entries.length && { label: 'Play next', icon: 'play-next', run: () => { player.playNext(tracks()); toast(`${pl.name} plays next`, { kind: 'ok' }); } },
        entries.length && { label: 'Add to queue', icon: 'queue', run: () => { player.addToQueue(tracks()); toast(`Added ${plural(entries.length, 'song')} to the queue`, { kind: 'ok' }); } },
        !isLiked && { sep: true },
        !isLiked && { label: 'Delete playlist', icon: 'trash', danger: true, run: deletePlaylist },
      ].filter(Boolean);
      openMenu(anchor, items, { title: pl.name, sub: entries.length ? `${plural(entries.length, 'song')} · ${fmtLongDuration(pl.total_secs)}` : '', label: `${pl.name} options` });
    }
    async function removeEntry(e) {
      const pos = entries.indexOf(e);
      const ok = await guard(() => api.removeFromPlaylist(id, [e.entry_id]).then(() => true));
      if (!ok) return;
      plStore.refresh();
      dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'playlist', playlistId: id } }));
      await load(); render();
      toast(`Removed “${e.track.title}” from ${pl.name}`, { action: { label: 'Undo', run: async () => {
        await addItemsToPlaylist(id, [e.track]);
        const d = await api.playlist(id);
        const ids = d.entries.map((x) => x.entry_id);
        const added = ids.pop();
        ids.splice(Math.min(pos, ids.length), 0, added);
        await api.reorderPlaylist(id, ids);
        await load(); render();
      } } });
    }

    page.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act || !page.contains(act)) return;
      const a = act.dataset.act;
      if (act.closest('[data-list]') && (a === 'play' || a === 'like' || a === 'menu')) return;   // handled by bindTrackList
      switch (a) {
        case 'play': { const ts = visibleTracks(); if (!ts.length) return; const first = online.value ? 0 : Math.max(0, ts.findIndex(playable)); player.play(ts, first, playCtx()); break; }
        case 'shuffle': { const ts = visibleTracks(); if (ts.length) player.shufflePlay(online.value ? ts : ts.filter(playable), playCtx()); break; }
        case 'download-all': act.disabled = true; await downloadAll(); break;
        case 'pause-dl': await setPaused(true); break;
        case 'resume-dl': await setPaused(false); break;
        case 'retry-failed': await retryFailed(); break;
        case 'add': focusAdd(); break;
        case 'edit': startEdit(); break;
        case 'more': openPlMenu(act); break;
        case 'reload': await load(); render(); break;
        case 'clear-add': { const input = page.querySelector('[data-add-input]'); input.value = ''; act.hidden = true; runSearch(''); input.focus(); break; }
        case 'preview': { const i = Number(act.closest('[data-ridx]').dataset.ridx); player.play(addResults, i, { type: 'search', name: `Add songs · “${addQuery}”` }); break; }
        case 'add-one': {
          const r = addResults[Number(act.closest('[data-ridx]').dataset.ridx)];
          act.disabled = true;
          const okk = await guard(() => addItemsToPlaylist(id, [r]).then(() => true));
          if (okk) { await load(); const y = document.getElementById('main')?.scrollTop; render(); if (y != null) document.getElementById('main')?.scrollTo({ top: y }); toast(`Added “${r.title}” to ${pl.name}`, { kind: 'ok' }); }
          else act.disabled = false;
          break;
        }
        case 'e-remove': { const entry = Number(act.closest('.erow').dataset.entry); draft.removed.add(entry); rerenderEditList(); break; }
        case 'e-cancel': editing = false; draft = null; render(); break;
        case 'e-save': await saveEdit(); break;
        case 'delete': await deletePlaylist(); break;
      }
    });
    page.addEventListener('input', (e) => {
      if (e.target.matches('[data-add-input]')) {
        const clear = page.querySelector('[data-act="clear-add"]'); if (clear) clear.hidden = !e.target.value;
        runSearch(e.target.value.trim());
      }
    });
    page.addEventListener('change', (e) => {
      if (e.target.matches('[data-dlonly]')) { dlOnly = e.target.checked; rerenderList(); }
      if (e.target.matches('[data-sort]')) { sortKey = e.target.value; rerenderList(); }
    });
    function rerenderList() {
      const sec = page.querySelector('.pl-list');
      if (!sec) return;
      sec.innerHTML = `<div data-banners style="display:contents">${bannersHTML()}</div>${listHTML()}`;
    }

    // Rows: play / like / ⋯ (with "Remove from <playlist>") via the shared binder.
    cleanups.push(bindTrackList(page, {
      items: () => visibleTracks(), player,
      get context() { return pl ? playCtx() : null; },
      menuExtra: (item, idx) => (isLiked || !rows[idx] ? [] : [{ label: `Remove from ${pl.name}`, icon: 'trash', danger: true, run: () => removeEntry(rows[idx]) }]),
    }));

    // Phone top bar: ⋯ opens the same menu as a bottom sheet.
    const trail = h(`<button class="btn btn--icon" type="button" aria-haspopup="menu" aria-label="More options">${icon('more')}</button>`);
    trail.addEventListener('click', () => pl && !loadErr && openPlMenu(trail));

    // Live updates
    cleanups.push(downloads.subscribe(patchLive));
    cleanups.push(online.subscribe(() => { if (pl && !editing) { lastSig = ''; render(); } }));
    const onChanged = debounce(async (e) => {
      if (editing) return;
      const d = e?.detail;
      if (d?.reason === 'playlist' && d.playlistId != null && Number(d.playlistId) !== id) return;
      const y = document.getElementById('main')?.scrollTop;
      const focusedAdd = document.activeElement?.matches?.('[data-add-input]');
      await load(); render();
      if (y != null) document.getElementById('main')?.scrollTo({ top: y });
      if (focusedAdd) { const inp = page.querySelector('[data-add-input]'); inp?.focus(); inp?.setSelectionRange(inp.value.length, inp.value.length); }
    }, 250);
    addEventListener('library:changed', onChanged);
    const onTrack = () => { if (isLiked) onChanged(); };
    addEventListener('track:updated', onTrack);
    cleanups.push(() => { removeEventListener('library:changed', onChanged); removeEventListener('track:updated', onTrack); });
    const onKey = (e) => { if (e.key === 'Escape' && editing && !document.querySelector('.scrim, .popover-scrim')) { editing = false; draft = null; render(); } };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));

    await load();
    render();
    if (params.edit === '1' && !loadErr) startEdit();
    return () => cleanups.forEach((fn) => { try { fn(); } catch {} });
  },
};
