// Bootstrap + app shell: theme, player, router, sidebar (nav, playlists, counts), top bar
// (back, title, search field, download pill, trailing action), desktop player bar, phone
// mini player + tab bar, first-run redirect to onboarding, and global shortcuts.

import { isTauri, listen } from './api.js';
import { createPlaylistDialog } from './components/actions.js';
import { artHTML } from './components/art.js';
import { bindSlider, isDragging, openSleepMenu, paintScrubber, showBuffering, sleepShort } from './components/player-ui.js';
import { initQuickSearch, openQuickSearch } from './components/quicksearch.js';
import { downloadSummary, downloads, platform, playlists, settings, startDownloadPolling, stats } from './components/store.js';
import { toast } from './components/toast.js';
import { autoCheckUpdates } from './components/updates.js';
import { player } from './player.js';
import { canGoBack, currentRoute, go, initRouter, lastPageHref } from './router.js';
import { initTheme } from './theme.js';
import { $, $$, esc, fmtDuration, fmtEta, icon } from './ui.js';

const app = $('#app');
let onboarded = true;

// ------------------------------------------------------------------ top bar + nav
function applyMeta(meta) {
  app.classList.toggle('app--setup', meta.shell === 'setup');
  app.classList.toggle('is-np', meta.nowPlaying);
  $('#topbar').hidden = meta.shell === 'setup';
  // Sidebar
  $$('#sidebar [data-nav]').forEach((a) => {
    const on = a.dataset.nav === meta.nav;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  // Tab bar
  $$('#tabbar [data-tab]').forEach((a) => {
    const on = a.dataset.tab === meta.tab;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  setBack(meta.back, meta.backPhoneOnly, meta.nowPlaying);
  setTitle(meta.title);
  $('#topbar-title').classList.toggle('phone-only', meta.topbarSearch);
  $('#topbar-search').hidden = !meta.topbarSearch;
  $('#topbar').classList.toggle('np-topbar', meta.nowPlaying);
  setTrail(meta.trail);
  renderBar(player.state);
}

function setTitle(text) { $('#topbar-title').textContent = text || ''; }

function setBack(hrefValue, phoneOnly = false, np = false) {
  const b = $('#topbar-back');
  b.hidden = !hrefValue;
  if (!hrefValue) return;
  b.setAttribute('href', hrefValue);
  b.classList.toggle('phone-only', !!phoneOnly);
  b.setAttribute('aria-label', np ? 'Collapse player (Esc)' : `Back`);
}

/** trail: 'settings' (gear on phone) | null | HTML string | Element. */
function setTrail(trail) {
  const slot = $('#topbar-trail');
  slot.innerHTML = '';
  if (!trail) return;
  if (trail === 'settings') { slot.innerHTML = `<a class="btn btn--icon topbar__trail" href="#settings" aria-label="Settings">${icon('settings')}</a>`; return; }
  if (typeof trail === 'string') slot.innerHTML = trail;
  else slot.appendChild(trail);
  slot.querySelectorAll('.btn').forEach((b) => b.classList.add('topbar__trail'));
}

function renderDownloadsChrome(list) {
  const s = downloadSummary(list);
  const pill = $('#dl-status');
  const pct = Math.round(s.progress * 100);
  if (s.count) {
    pill.hidden = false;
    pill.setAttribute('aria-label', `${s.count} downloading, ${pct} percent${s.eta ? `, ${fmtEta(s.eta)} left` : ''}`);
    pill.innerHTML = `${icon('download', 'icon--16')}<span><span class="strong">${s.count} downloading</span> · ${pct}%${s.eta ? ` · ${fmtEta(s.eta)} left` : ''}</span><i class="dl-status__bar" style="--p:${pct}%"></i>`;
  } else pill.hidden = true;
  $('#count-downloads').textContent = s.count ? String(s.count) : '';
  const tc = $('#tab-count-downloads');
  tc.hidden = !s.count;
  tc.textContent = String(s.count);
  tc.setAttribute('aria-label', `${s.count} active downloads`);
}

function renderPlaylists(list) {
  const host = $('#sidebar-playlist-list');
  const route = currentRoute();
  const activeNav = route.meta?.nav;
  host.innerHTML = list.filter((p) => !p.is_liked).map((p) => {
    const nav = `playlist:${p.id}`;
    return `<a class="nav-item nav-item--playlist${activeNav === nav ? ' is-active' : ''}" href="#playlist/${p.id}" data-nav="${nav}"${activeNav === nav ? ' aria-current="page"' : ''}>${icon('playlist', 'icon--16')}<span class="truncate">${esc(p.name)}</span></a>`;
  }).join('');
}

// ------------------------------------------------------------------ player bar + mini player
const bar = $('#player-bar');
const mini = $('#mini-player');

function buildBar() {
  bar.innerHTML = `
    <div class="player-bar__now">
      <a class="player-bar__now np-now" href="#now-playing" data-bar="open" aria-label="Open Now Playing">
        <span data-bar="art"></span>
        <div class="player-bar__meta"><div class="player-bar__title truncate" data-bar="title">Nothing playing</div><div class="player-bar__sub" data-bar="sub"><span>Pick a song to start</span></div></div>
        <span data-bar="chev"></span>
      </a>
      <button class="btn btn--icon btn--sm like" type="button" data-bar="like" aria-label="Like">${icon('heart', 'icon--16')}</button>
    </div>
    <div class="player-bar__center np-bar-center">
      <div class="np-bar-next t-13 muted" data-bar="next"></div>
      <div class="transport">
        <button class="btn btn--icon" type="button" data-bar="shuffle" aria-label="Shuffle (S)">${icon('shuffle')}</button>
        <button class="btn btn--icon" type="button" data-bar="prev" aria-label="Previous">${icon('prev')}</button>
        <button class="btn btn--play" type="button" data-bar="play" aria-label="Play (Space)">${icon('play', 'icon--fill')}</button>
        <button class="btn btn--icon" type="button" data-bar="nextbtn" aria-label="Next">${icon('next')}</button>
        <button class="btn btn--icon" type="button" data-bar="repeat" aria-label="Repeat (R)">${icon('repeat')}</button>
      </div>
      <div class="scrubber scrubber--inline" data-bar="scrub">
        <div class="scrubber__times"><span>0:00</span></div>
        <div class="scrubber__track" role="slider" aria-label="Seek"><i class="scrubber__buffer"></i><i class="scrubber__fill"></i><i class="scrubber__thumb"></i></div>
        <div class="scrubber__times"><span>0:00</span></div>
      </div>
    </div>
    <div class="player-bar__right">
      <a class="btn btn--icon" href="#now-playing" data-bar="queue" aria-label="Queue">${icon('queue')}</a>
      <span data-bar="timer"></span>
      <div class="volume" data-bar="volume"><svg class="icon muted" aria-hidden="true"><use href="#i-volume"/></svg><div class="volume__track" role="slider" aria-label="Volume" tabindex="0"><i class="volume__fill"></i><i class="volume__thumb"></i></div></div>
    </div>`;
  mini.innerHTML = `
    <div class="mini-player__progress" data-mini="progress"><i></i></div>
    <span data-mini="art"></span>
    <div class="mini-player__meta"><div class="mini-player__title truncate" data-mini="title"></div><div class="mini-player__sub num" data-mini="sub"></div></div>
    <button class="btn btn--icon np-mini-play" type="button" data-mini="play" aria-label="Play">${icon('play', 'icon--fill')}</button>
    <button class="btn btn--icon" type="button" data-mini="next" aria-label="Next">${icon('next')}</button>`;

  const q = (k) => bar.querySelector(`[data-bar="${k}"]`);
  q('play').addEventListener('click', () => player.toggle());
  q('prev').addEventListener('click', () => player.prev());
  q('nextbtn').addEventListener('click', () => player.next());
  q('shuffle').addEventListener('click', () => player.toggleShuffle());
  q('repeat').addEventListener('click', () => player.cycleRepeat());
  q('like').addEventListener('click', () => player.toggleLike());
  q('open').addEventListener('click', (e) => { if (currentRoute().name === 'now-playing') { e.preventDefault(); collapseNowPlaying(); } });
  q('queue').addEventListener('click', (e) => { if (currentRoute().name === 'now-playing') { e.preventDefault(); collapseNowPlaying(); } });
  q('timer').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) openSleepMenu(b, player); });
  const scrub = q('scrub');
  bindSlider(scrub.querySelector('.scrubber__track'), { container: scrub, onChange: (f, final) => { if (final) player.seekFraction(f); }, getValue: () => (player.state.duration ? player.state.position / player.state.duration : 0), step: 0.02 });
  const vol = q('volume');
  vol.style.setProperty('--p', `${player.state.volume * 100}%`);
  bindSlider(vol.querySelector('.volume__track'), { container: vol, onChange: (f) => player.setVolume(f), getValue: () => player.state.volume, step: 0.05 });

  mini.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mini]');
    if (b?.dataset.mini === 'play') { e.stopPropagation(); player.toggle(); return; }
    if (b?.dataset.mini === 'next') { e.stopPropagation(); player.next(); return; }
    location.hash = '#now-playing';
  });
  mini.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === mini) { e.preventDefault(); location.hash = '#now-playing'; } });

  player.onTime((t) => {
    const s = player.state;
    paintScrubber(q('scrub'), t, { buffering: showBuffering(s) });
    if (!s.current) q('scrub').querySelectorAll('.scrubber__times span').forEach((x) => { x.textContent = '0:00'; });
    const d = t.duration || 0;
    mini.querySelector('[data-mini="progress"]').style.setProperty('--p', `${d ? (t.position / d) * 100 : 0}%`);
    const time = mini.querySelector('[data-mini="time"]');
    if (time && !showBuffering(s)) time.textContent = `${fmtDuration(t.position)} / ${fmtDuration(d)}`;
  });
}

function glyphFor(it) {
  if (!it || it.kind === 'voice') return '';
  return it.path ? icon('check', 'sg sg--dl', 'Downloaded') : icon('stream', 'sg sg--st', 'Streaming');
}

let lastArtKey = '';
function renderBar(s) {
  const it = s.current;
  const q = (k) => bar.querySelector(`[data-bar="${k}"]`);
  const np = currentRoute().name === 'now-playing';
  bar.classList.toggle('is-idle', !it);
  const artKey = it ? `${it.id || it.video_id}|${it.thumbnail}` : 'idle';
  if (artKey !== lastArtKey) {
    lastArtKey = artKey;
    q('art').outerHTML = `<span data-bar="art">${it ? artHTML(it) : `<div class="art art--idle"><span>${icon('music')}</span></div>`}</span>`;
    mini.querySelector('[data-mini="art"]').outerHTML = `<span data-mini="art">${it ? artHTML(it) : ''}</span>`;
  }
  q('title').textContent = it ? it.title : 'Nothing playing';
  q('sub').innerHTML = it ? `${glyphFor(it)}<span>${esc([it.artist, it.album].filter(Boolean).join(' · ') || (it.kind === 'voice' ? 'Voice recording' : ''))}</span>` : '<span>Pick a song to start</span>';
  const link = q('open');
  link.classList.toggle('is-current', np);
  link.setAttribute('aria-label', np ? 'Now playing — collapse' : 'Open Now Playing');
  if (np) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  link.style.pointerEvents = it ? '' : 'none';
  // The art + title block is the expand target (as designed); only the open state shows a chevron.
  q('chev').innerHTML = it && np ? icon('chevron-down', 'icon--16 np-now__chev') : '';
  const like = q('like');
  like.hidden = !it || it.kind === 'voice';
  like.classList.toggle('is-liked', !!it?.liked);
  like.setAttribute('aria-pressed', String(!!it?.liked));
  like.setAttribute('aria-label', it?.liked ? 'Liked' : 'Like');

  // Up next (Now Playing open: the hero owns transport + scrubber)
  const nxt = s.upNext.all[0]?.item;
  q('next').innerHTML = nxt ? `<span class="eyebrow">Up next</span>${glyphFor(nxt)}<span class="truncate"><span class="strong np-text">${esc(nxt.title)}</span>${nxt.artist ? ` · ${esc(nxt.artist)}` : ''}</span>` : `<span class="eyebrow">Up next</span><span class="truncate">Nothing queued</span>`;

  const buffering = showBuffering(s);
  const play = q('play');
  play.disabled = !it;
  play.innerHTML = icon(s.playing || buffering ? 'pause' : 'play', 'icon--fill');
  play.setAttribute('aria-label', buffering ? 'Buffering — pause' : s.playing ? 'Pause (Space)' : 'Play (Space)');
  play.classList.toggle('np-play--buffer', buffering);
  for (const k of ['prev', 'nextbtn', 'shuffle', 'repeat']) q(k).disabled = !it;
  const sh = q('shuffle');
  sh.classList.toggle('is-on', s.shuffle);
  sh.setAttribute('aria-pressed', String(s.shuffle));
  sh.setAttribute('aria-label', `Shuffle ${s.shuffle ? 'on' : 'off'} (S)`);
  const rp = q('repeat');
  rp.classList.toggle('is-on', s.repeat !== 'off');
  rp.innerHTML = icon(s.repeat === 'one' ? 'repeat-one' : 'repeat');
  rp.setAttribute('aria-label', `Repeat ${s.repeat === 'off' ? 'off' : s.repeat === 'one' ? 'this song' : 'all'} (R)`);
  rp.setAttribute('aria-pressed', String(s.repeat !== 'off'));
  const queue = q('queue');
  queue.classList.toggle('is-on', np);
  queue.setAttribute('aria-pressed', String(np));
  queue.classList.toggle('is-disabled', !it);
  queue.setAttribute('aria-label', np ? 'Queue (open)' : 'Queue');
  const timer = q('timer');
  const timerHtml = s.sleep
    ? `<button class="np-timer" type="button" aria-label="Sleep timer: ${esc(sleepShort(player))}">${icon('moon', 'icon--16')}<span class="num">${esc(sleepShort(player))}</span></button>`
    : `<button class="btn btn--icon" type="button" aria-label="Sleep timer"${it ? '' : ' disabled'}>${icon('moon')}</button>`;
  if (timer.dataset.html !== timerHtml) { timer.dataset.html = timerHtml; timer.innerHTML = timerHtml; }
  const vol = q('volume');
  if (!isDragging(vol)) vol.style.setProperty('--p', `${s.volume * 100}%`);

  // Mini player
  mini.hidden = !it;
  if (it) {
    mini.querySelector('[data-mini="title"]').textContent = it.title;
    const d = s.duration || it.duration_secs;
    mini.querySelector('[data-mini="sub"]').innerHTML = buffering
      ? `${glyphFor(it)}<span class="np-mini__time">${s.loading === 'stream' ? 'Loading stream…' : 'Buffering…'}</span><span class="truncate">· ${esc(it.artist || '')}</span>`
      : `${glyphFor(it)}<span>${it.artist ? `${esc(it.artist)} · ` : ''}<span data-mini="time">${fmtDuration(s.position)} / ${fmtDuration(d)}</span></span>`;
    const mp = mini.querySelector('[data-mini="play"]');
    mp.innerHTML = buffering ? '<span class="spinner"></span>' : icon(s.playing ? 'pause' : 'play', 'icon--fill');
    mp.setAttribute('aria-label', buffering ? 'Buffering — pause' : s.playing ? 'Pause' : 'Play');
  }
}

function collapseNowPlaying() {
  if (canGoBack() && currentRoute().name === 'now-playing') history.back();
  else location.hash = lastPageHref();
}

// ------------------------------------------------------------------ global keys
function initKeys() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t.closest?.('input, textarea, select, [contenteditable="true"], .scrim, .popover-scrim')) return;
    if (app.classList.contains('app--setup')) return;
    if (e.key === ' ' && !t.closest('button, a, [role="slider"]')) { e.preventDefault(); player.toggle(); }
    else if (e.key === 's' || e.key === 'S') player.toggleShuffle();
    else if (e.key === 'r' || e.key === 'R') player.cycleRepeat();
    else if (e.key === 'Escape' && currentRoute().name === 'now-playing') collapseNowPlaying();
  });
}

// ------------------------------------------------------------------ boot
async function main() {
  await settings.refresh();
  initTheme(settings.value['ui.theme']);
  onboarded = settings.value['ui.onboarded'] === '1';
  platform.refresh();
  buildBar();
  await player.init();
  player.subscribe(renderBar);

  // Sidebar + chrome data
  downloads.subscribe(renderDownloadsChrome);
  playlists.subscribe(renderPlaylists);
  stats.subscribe((s) => { if (s) $('#count-voice').textContent = s.voice ? String(s.voice) : ''; });
  startDownloadPolling();
  autoCheckUpdates();
  playlists.refresh();
  stats.refresh();
  addEventListener('library:changed', () => { stats.refresh(); playlists.refresh(); });
  addEventListener('settings:changed', () => settings.refresh());
  $('#sidebar').addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="new-playlist"]')) {
      const pl = await createPlaylistDialog();
      if (pl) go('playlist', { id: pl.id });
    }
  });

  // Desktop top-bar search: opens the quick-search palette (type, then Enter for YouTube Music).
  const topInput = $('#topbar-search-input');
  topInput.addEventListener('focus', () => { const v = topInput.value; topInput.blur(); openQuickSearch(v); });

  // Thumbnails that fail to load fall back to the generated art underneath.
  document.addEventListener('error', (e) => { if (e.target?.classList?.contains('art__img')) e.target.remove(); }, true);

  // A finished scan refreshes everything and says so.
  listen('scan://progress', (r) => {
    if (!r?.finished) return;
    stats.refresh();
    dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'scan' } }));
  });

  initKeys();
  initQuickSearch();
  initRouter({
    applyMeta, setTitle, setTrail,
    setBack: (h) => setBack(h),
    // First run: everything routes to onboarding until ui.onboarded = "1".
    guard: (name) => {
      if (!onboarded) onboarded = settings.value['ui.onboarded'] === '1';
      return !onboarded && name !== 'onboarding' ? 'onboarding' : null;
    },
  });
  if (!isTauri) console.info('[offline-player] browser preview — data from js/mock.js; engine:', player.engineName);
  if (!isTauri) previewDemo();
}

/** Browser preview only: ?demo=music|stream|voice starts playback so screens can be reviewed. */
async function previewDemo() {
  const demo = new URLSearchParams(location.search).get('demo');
  if (!demo) return;
  const { api } = await import('./api.js');
  if (demo === 'voice') {
    const v = await api.tracks('voice');
    player.play(v, 0, { type: 'voice', name: 'Voice recordings' });
  } else {
    const { playlist, entries } = await api.playlist(1);
    player.play(entries.map((e) => e.track), demo === 'stream' ? 1 : 0, { type: 'playlist', id: playlist.id, name: playlist.name });
    player.addToQueue([entries[5].track, entries[2].track]);
    player.playNext(entries[7].track);
  }
  if (new URLSearchParams(location.search).get('sleep')) player.setSleep(30);
}

addEventListener('unhandledrejection', (e) => { console.error(e.reason); });
main().catch((e) => {
  console.error(e);
  toast(`Startup failed: ${e?.message || e}`, { kind: 'danger', ms: 0 });
});

