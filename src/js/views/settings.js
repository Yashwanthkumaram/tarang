// Settings (design/screens/settings.html): Appearance · Playback · Streaming · Downloads ·
// Import from other apps · Device folders · About, with a sticky section nav on desktop
// (≥1024 px) and jump chips on narrower screens. The import flow is a sub-page of this
// view: #settings?import=spotify|youtube|soundcloud (link → matching → review → done).
// Deep link to a section: #settings?section=import. Styles: styles/views/settings.css.
//
// Every control maps to a key in docs/API-v2.md (KEYS in api.js) or to a command; options
// the backend has no key for are left out rather than faked (see docs/DECISIONS.md).

import { api, isAndroid, KEYS, listen, openExternal } from '../api.js';
import { confirmDialog, openMenu } from '../components/overlay.js';
import { pickFolder } from '../components/pickers.js';
import { online, platform as platformStore, playlists, pokeDownloads, setSetting, settings as settingsStore, stats as statsStore } from '../components/store.js';
import { updates } from '../components/updates.js';
import { currentTheme, setTheme } from '../theme.js';
import { banner, debounce, emptyState, esc, fmtAgo, fmtBytes, fmtDuration, fmtNum, icon, on, plural, skeletonRows, toast } from '../ui.js';

// ---------------------------------------------------------------- shared with onboarding / device
/** Import platforms (docs/API-v2.md "Import from other apps"). */
export const PLATFORMS = {
  spotify: {
    id: 'spotify', name: 'Spotify', icon: 'spotify', mark: 'src-mark--spotify',
    sub: 'Public playlist, album or track link',
    label: 'Spotify playlist link', placeholder: 'https://open.spotify.com/playlist/…',
    help: 'In Spotify: open the playlist › ⋯ › Share › Copy link. The playlist must be public — no sign-in needed.',
    re: /(^|\.|\/)spotify\.com\/(playlist|album|track)\//i,
  },
  youtube: {
    id: 'youtube', name: 'YouTube Music', icon: 'ytm', mark: 'src-mark--ytm',
    sub: 'Playlist or album link',
    label: 'YouTube Music playlist link', placeholder: 'https://music.youtube.com/playlist?list=…',
    help: 'In YouTube Music: open the playlist › Share › Copy link. Public and unlisted playlists work.',
    re: /(youtube\.com|youtu\.be)\/.*(list=|playlist|browse)/i,
  },
  soundcloud: {
    id: 'soundcloud', name: 'SoundCloud', icon: 'sc', mark: 'src-mark--sc',
    sub: 'Playlist (set) or likes link',
    label: 'SoundCloud set or likes link', placeholder: 'https://soundcloud.com/artist/sets/…',
    help: 'In SoundCloud: open the set or your likes › Share › Copy link.',
    re: /soundcloud\.com\/[^/]+\/(sets\/|likes)/i,
  },
};
/** Which platform a pasted link belongs to (or null). */
export const detectPlatform = (url) => Object.values(PLATFORMS).find((p) => p.re.test(url || ''))?.id || null;

/**
 * Human path: "~/Music/Tarang" on desktop, "Internal storage › Music" on Android.
 * Returns { head, tail } so the last segment never truncates (see .path in settings.css).
 */
export function prettyPath(p) {
  let s = String(p || '');
  const android = /^\/storage\/emulated\/\d+|^\/sdcard/.test(s);
  if (android) {
    s = s.replace(/^\/storage\/emulated\/\d+|^\/sdcard/, 'Internal storage');
    const parts = s.split('/').filter(Boolean);
    const tail = parts.pop() || s;
    return { head: parts.length ? parts.join(' › ') + ' › ' : '', tail, full: parts.concat(tail).join(' › ') };
  }
  s = s.replace(/^\/home\/[^/]+/, '~');
  const i = s.lastIndexOf('/');
  return i > 0 ? { head: s.slice(0, i + 1), tail: s.slice(i + 1), full: s } : { head: '', tail: s, full: s };
}
export const pathHTML = (p, cls = '') => { const x = prettyPath(p); return `<div class="path ${cls}" title="${esc(p)}"><span class="path__head">${esc(x.head)}</span><span class="path__tail">${esc(x.tail)}</span></div>`; };

const toggle = (id, on, label, extra = '') => `<label class="toggle" aria-label="${esc(label)}"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${extra}><span class="toggle__track"></span></label>`;
const select = (id, value, options, label) => `<select class="select" id="${id}" aria-label="${esc(label)}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
const fmtDay = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const sizeNum = (b) => { const [n, u] = fmtBytes(b).split(' '); return `${n}<span class="t-14 muted"> ${u}</span>`; };

// Defaults restored by "Reset settings" (docs/API-v2.md settings keys).
const DEFAULTS = {
  [KEYS.crossfade]: '0', [KEYS.gapless]: 'true', [KEYS.voiceSpeed]: '1', [KEYS.sleepFade]: 'true',
  [KEYS.streamQuality]: 'high', [KEYS.streamCacheMb]: '512', [KEYS.downloadQuality]: 'best', [KEYS.downloadMobileData]: 'false',
};
const VOICE_SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const CROSSFADE = [2, 4, 6, 8, 10, 12];
const STREAM_Q = [['high', 'High · 256 kbps'], ['normal', 'Normal · 128 kbps']];
const DOWNLOAD_Q = [['best', 'Best available (Opus / M4A)'], ['high', 'High · MP3 320 kbps'], ['standard', 'Standard · MP3 192 kbps'], ['small', 'Small · MP3 128 kbps']];
const CACHE_MB = [['256', '256 MB'], ['512', '512 MB'], ['1024', '1 GB'], ['2048', '2 GB']];
const SECTIONS = [
  ['appearance', 'Appearance', 'sun'], ['playback', 'Playback', 'speed'], ['streaming', 'Streaming', 'stream'],
  ['downloads', 'Downloads', 'download'], ['import', 'Import', 'import'], ['device', 'Device folders', 'folder'], ['about', 'About', 'info'],
];

// ---------------------------------------------------------------- view
export default {
  title: (p) => (p.import && PLATFORMS[p.import] ? `Import from ${PLATFORMS[p.import].name}` : 'Settings'),
  back: (p) => (p.import ? '#settings?section=import' : '#home'),
  backPhoneOnly: true,
  render(root, params, ctx) {
    if (params.import) return renderImport(root, params, ctx);
    return renderSettings(root, params, ctx);
  },
};

// ================================================================ main settings page
async function renderSettings(root, params, ctx) {
  const cleanups = [];
  const [s, plat] = await Promise.all([settingsStore.refresh(), platformStore.refresh()]);
  const set = { ...DEFAULTS, ...(s || {}) };
  let lastCrossfade = Number(set[KEYS.crossfade]) > 0 ? Number(set[KEYS.crossfade]) : 6;

  // Phone: "Reset settings" lives in the ⋯ menu of the top bar.
  const trail = document.createElement('button');
  trail.className = 'btn btn--icon';
  trail.type = 'button';
  trail.setAttribute('aria-label', 'More · Reset settings');
  trail.setAttribute('aria-haspopup', 'menu');
  trail.innerHTML = icon('more');
  trail.addEventListener('click', () => openMenu(trail, [{ label: 'Reset settings', icon: 'refresh', danger: true, run: resetSettings }], { title: 'Settings' }));
  ctx.setTrail(trail);

  root.innerHTML = `<div class="page set-page">
    <div class="page-head desktop-only"><div><h1>Settings</h1><div class="page-head__sub">Tarang ${esc(plat.version || '')} · no account, no sync — everything stays on this device.</div></div></div>
    <div class="settings">
      <nav class="settings__nav" aria-label="Settings sections">${SECTIONS.map(([id, name, ic], i) => `<button type="button" class="nav-item${i ? '' : ' is-active'}" data-jump="${id}">${icon(ic)}${name}</button>`).join('')}</nav>
      <div class="settings__body">
        <nav class="jump" aria-label="Settings sections"><div class="jump__scroll chips--scroll">${SECTIONS.map(([id, name], i) => `<button type="button" class="jump__item" data-jump="${id}"${i ? '' : ' aria-current="true"'}><span class="chip${i ? '' : ' is-selected'}">${name}</span></button>`).join('')}</div></nav>
        ${appearanceHTML()}
        ${playbackHTML(set, lastCrossfade)}
        ${streamingHTML(set)}
        ${downloadsHTML(set, plat)}
        <section class="sect" id="set-import"><div class="section-head"><h3>Import from other apps</h3></div><div id="import-card">${importCardHTML(null)}</div></section>
        <section class="sect" id="set-device"><div class="section-head"><h3>Device folders</h3></div><div class="card">
          <a class="srow srow--link" href="#device"><span class="srow-tile">${icon('scan')}</span><div class="srow__main"><div class="srow__title">Scan &amp; folders</div><div class="srow__sub num" id="device-sub">Songs already on this device</div></div>${icon('chevron-right', 'muted')}</a>
        </div></section>
        ${aboutHTML(plat)}
      </div>
    </div>
  </div>`;
  const $ = (sel) => root.querySelector(sel);

  // ---- section nav: click to scroll, scroll-spy highlights ----
  const main = document.getElementById('main');
  const jumpTo = (id, smooth = true) => root.querySelector(`#set-${id}`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  cleanups.push(on(root, 'click', '[data-jump]', (e, b) => jumpTo(b.dataset.jump)));
  const spy = () => {
    const top = main.getBoundingClientRect().top + 140;
    let cur = SECTIONS[0][0];
    for (const [id] of SECTIONS) { const el = root.querySelector(`#set-${id}`); if (el && el.getBoundingClientRect().top <= top) cur = id; }
    if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) cur = SECTIONS[SECTIONS.length - 1][0];
    root.querySelectorAll('.settings__nav [data-jump]').forEach((a) => a.classList.toggle('is-active', a.dataset.jump === cur));
    root.querySelectorAll('.jump__item').forEach((a) => {
      const onIt = a.dataset.jump === cur;
      a.querySelector('.chip').classList.toggle('is-selected', onIt);
      if (onIt) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
      const row = a.parentNode;
      if (onIt && row.scrollWidth > row.clientWidth) {
        const x = a.offsetLeft - row.offsetLeft, r = x + a.offsetWidth + 32 - row.clientWidth;
        if (r > row.scrollLeft) row.scrollLeft = r; else if (x < row.scrollLeft) row.scrollLeft = Math.max(0, x - 16);
      }
    });
  };
  main.addEventListener('scroll', spy, { passive: true });
  cleanups.push(() => main.removeEventListener('scroll', spy));
  if (params.section) requestAnimationFrame(() => { jumpTo(params.section, false); spy(); });

  // ---- appearance ----
  const paintTheme = () => {
    const pref = currentTheme(), resolved = document.documentElement.dataset.theme;
    root.querySelectorAll('[data-theme-opt]').forEach((b) => { const onIt = b.dataset.themeOpt === pref; b.classList.toggle('is-selected', onIt); b.setAttribute('aria-checked', String(onIt)); });
    root.querySelectorAll('[data-invert-when]').forEach((el) => el.classList.toggle('is-inverted', el.dataset.invertWhen === resolved));
  };
  paintTheme();
  cleanups.push(on(root, 'click', '[data-theme-opt]', (e, b) => setTheme(b.dataset.themeOpt)));
  addEventListener('theme:changed', paintTheme);
  cleanups.push(() => removeEventListener('theme:changed', paintTheme));

  // ---- playback ----
  const save = (key, value, msg) => setSetting(key, value).then(() => msg && toast(msg, { kind: 'ok' })).catch((e) => toast(`Couldn’t save: ${e.message || e}`, { kind: 'danger' }));
  $('#gapless').addEventListener('change', (e) => save(KEYS.gapless, e.target.checked ? 'true' : 'false'));
  $('#sleep-fade').addEventListener('change', (e) => save(KEYS.sleepFade, e.target.checked ? 'true' : 'false'));
  const paintCrossfade = (onIt) => {
    const row = $('#xfade-row');
    row.classList.toggle('is-disabled', !onIt);
    row.setAttribute('aria-disabled', String(!onIt));
    $('#xfade-len').disabled = !onIt;
    $('#xfade-sub').textContent = onIt ? 'Blends the end of a song into the next' : 'Turn on Crossfade above to choose 2–12 s';
    $('#xfade-desc').textContent = `${onIt ? `${lastCrossfade} s` : 'Off'} · blends the end of a song into the next; choose a length when on. Never applied to voice recordings.`;
  };
  $('#xfade').addEventListener('change', (e) => { paintCrossfade(e.target.checked); save(KEYS.crossfade, e.target.checked ? lastCrossfade : 0); });
  $('#xfade-len').addEventListener('change', (e) => { lastCrossfade = Number(e.target.value); paintCrossfade(true); save(KEYS.crossfade, lastCrossfade); });
  cleanups.push(on(root, 'click', '#voice-speed .seg__btn', (e, b) => {
    root.querySelectorAll('#voice-speed .seg__btn').forEach((x) => { const onIt = x === b; x.classList.toggle('is-active', onIt); x.setAttribute('aria-pressed', String(onIt)); });
    save(KEYS.voiceSpeed, b.dataset.v);
  }));

  // ---- streaming ----
  $('#stream-q').addEventListener('change', (e) => save(KEYS.streamQuality, e.target.value));
  $('#cache-mb').addEventListener('change', (e) => { save(KEYS.streamCacheMb, e.target.value); paintCache(); });
  $('#mobile-data').addEventListener('change', (e) => { save(KEYS.downloadMobileData, e.target.checked ? 'true' : 'false'); $('#mobile-sub').textContent = e.target.checked ? 'On · downloads also run on mobile data.' : 'Off · downloads wait for Wi‑Fi. Streaming still works on mobile data.'; });
  let storage = null, voiceBytes = 0, voiceCount = 0, cacheCleared = false;
  function paintCache() {
    const limit = Number($('#cache-mb').value) * 1e6;
    const used = storage?.cache_bytes ?? null;
    $('#cache-meter').innerHTML = used == null
      ? `<div class="progress-line__meta"><span>Measuring…</span><span>limit ${esc(fmtBytes(limit))}</span></div><div class="progress progress--indeterminate"><i></i></div>`
      : `<div class="progress-line__meta"><span><strong>${esc(fmtBytes(used))}</strong> used</span><span>limit ${esc(fmtBytes(limit))}</span></div><div class="progress" style="--p:${Math.min(100, Math.round((used / limit) * 100))}%" role="img" aria-label="Stream cache ${esc(fmtBytes(used))} of ${esc(fmtBytes(limit))}"><i></i></div>`;
    $('#cache-sub').textContent = cacheCleared ? 'Cleared just now. It refills only while a streamed song is playing.' : 'Streamed audio is held in chunks while a song plays, then cleared. Nothing streamed is kept.';
    $('#cache-clear').disabled = !used;
  }
  $('#cache-clear').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await api.clearStreamCache(); cacheCleared = true; toast('Stream cache cleared', { kind: 'ok' }); await measure(); } catch (err) { toast(`Couldn’t clear the cache: ${err.message || err}`, { kind: 'danger' }); paintCache(); }
  });
  const paintOnline = () => { $('#stream-offline').innerHTML = online.value ? '' : banner({ kind: 'info', icon: 'offline', title: 'You’re offline — streaming is paused', text: 'Downloaded songs and your device music still play. Quality and cache settings apply when you reconnect.' }); paintImportOffline(); };

  // ---- downloads ----
  $('#dl-q').addEventListener('change', (e) => save(KEYS.downloadQuality, e.target.value));
  $('#dl-change').addEventListener('click', async () => {
    const path = await pickFolder({ title: 'Choose the download folder', start: plat.download_dir, confirm: 'Download here' });
    if (!path) return;
    try {
      await api.addRule(path, 'app');
      const p = await platformStore.refresh();
      $('#dl-path').innerHTML = pathHTML(p.download_dir || path);
      toast('Download folder changed', { kind: 'ok', sub: 'New downloads land here. Songs already downloaded stay where they are.' });
    } catch (err) { toast(`Couldn’t change the folder: ${err.message || err}`, { kind: 'danger' }); }
  });
  async function measure() {
    $('#usage').innerHTML = usageSkeleton(storage);
    $('#measure').classList.add('is-loading');
    try {
      const [info, voice] = await Promise.all([api.storageInfo(), api.tracks('voice', { limit: 100000 }).catch(() => []), statsStore.refresh()]);
      storage = info; voiceBytes = voice.reduce((a, t) => a + (t.size_bytes || 0), 0); voiceCount = voice.length;
      $('#usage').innerHTML = usageHTML(storage, voiceBytes, voiceCount, statsStore.value);
      $('#usage-title').textContent = `Tarang uses ${fmtBytes((storage.downloads_bytes || 0) + voiceBytes + (storage.cache_bytes || 0))}`;
      $('#usage-sub').textContent = `Measured just now · ${plural((statsStore.value?.downloaded ?? 0) + voiceCount, 'file')}`;
      $('#dl-free').textContent = `${fmtBytes(storage.free_bytes)} free of ${fmtBytes(storage.used_bytes + storage.free_bytes)}`;
    } catch (err) {
      $('#usage').innerHTML = banner({ kind: 'danger', icon: 'alert', title: 'Couldn’t measure storage', text: err.message || String(err), action: `<button class="btn btn--secondary btn--sm" type="button" data-act="measure">${icon('refresh', 'icon--16')}Retry</button>` });
    }
    $('#measure').classList.remove('is-loading');
    paintCache();
  }
  $('#measure').addEventListener('click', measure);
  cleanups.push(on(root, 'click', '[data-act="measure"]', measure));

  // ---- import ----
  function paintImportOffline() { const el = $('#import-offline'); if (el) el.innerHTML = online.value ? '' : banner({ kind: 'warn', icon: 'offline', title: 'Importing needs internet', text: 'Songs are matched on YouTube Music. Past imports still open and play what’s downloaded.' }); }
  async function loadImports() {
    try { $('#import-card').innerHTML = importCardHTML(await api.importHistory()); }
    catch (err) { $('#import-card').innerHTML = importCardHTML([], err); }
    paintImportOffline();
  }
  cleanups.push(on(root, 'click', '[data-platform]', (e, b) => { location.hash = `#settings?import=${b.dataset.platform}`; }));

  // ---- device summary ----
  Promise.all([api.rules(), api.lastScan().catch(() => null)]).then(([rules, last]) => {
    const inc = rules.filter((r) => r.rule === 'include' && r.enabled).length, exc = rules.filter((r) => r.rule === 'exclude' && r.enabled).length;
    const when = last?.[0] ? `last scan ${fmtAgo(last[0])}` : 'never scanned';
    $('#device-sub').textContent = `Songs already on this device · ${plural(inc, 'folder')} included, ${fmtNum(exc)} excluded · ${when}`;
  }).catch(() => {});

  // ---- about: yt-dlp ----
  let ytVersion = null;
  const paintYt = (state, msg = '') => {
    const row = $('#ytdlp');
    if (state === 'updating') {
      row.innerHTML = `<div class="between"><div class="srow__main"><div class="srow__title">yt-dlp</div><div class="srow__sub num">Updating${ytVersion ? ` from ${esc(ytVersion)}` : ''} · streaming and downloads keep working meanwhile</div></div></div>
        <div class="progress-line"><div class="progress-line__meta"><span><strong>Checking for a newer version…</strong></span><span>yt-dlp --update</span></div><div class="progress progress--indeterminate"><i></i></div></div>`;
      return;
    }
    const badge = state === 'ok' ? `<span class="badge badge--ok badge--dot title-badge"><span class="badge__label">Up to date</span></span>` : '';
    row.innerHTML = `<div class="between"><div class="srow__main"><div class="srow__title">yt-dlp ${badge}</div><div class="srow__sub num">${ytVersion ? `Installed ${esc(ytVersion)}` : state === 'checking' ? 'Checking the installed version…' : 'Version unknown'} · searches, streams and downloads from YouTube Music${msg ? ` · ${esc(msg)}` : ''}</div></div>
      <div class="srow__ctl"><button class="btn btn--secondary btn--sm btn--check" type="button" id="yt-update">${icon('refresh', 'icon--16')}${state === 'ok' ? 'Check again' : 'Check for update'}</button></div></div>
      ${state === 'error' ? `<div id="yt-error">${banner({ kind: 'danger', icon: 'alert', title: 'yt-dlp update failed', text: `${msg || 'Unknown error'}. Streaming and downloads keep working on the installed version.`, action: `<button class="btn btn--secondary btn--sm" type="button" id="yt-retry">${icon('refresh', 'icon--16')}Retry</button>` })}</div>` : ''}`;
  };
  async function updateYt() {
    if (!online.value) { toast('Updating yt-dlp needs internet', { kind: 'info' }); return; }
    paintYt('updating');
    try {
      const res = await api.youtubeUpdate();
      ytVersion = await api.youtubeVersion().catch(() => ytVersion);
      paintYt('ok', `checked just now`);
      toast(String(res || 'yt-dlp updated'), { kind: 'ok' });
    } catch (err) { paintYt('error', err.message || String(err)); }
  }
  cleanups.push(on(root, 'click', '#yt-update, #yt-retry', updateYt));

  // ---- about: Tarang updates (D45) ----
  const paintUpdate = (u) => {
    const row = $('#app-update');
    if (!row) return;
    const info = u.info || {};
    const current = info.current || platformStore.value?.version || '';
    const whatsNew = info.page_url ? `<button class="btn btn--ghost btn--sm" type="button" id="app-notes">What’s new</button>` : '';
    if (u.phase === 'downloading') {
      const p = u.total ? Math.min(1, u.downloaded / u.total) : 0;
      row.innerHTML = `<div class="between"><div class="srow__main"><div class="srow__title">Updating to ${esc(info.version || '')}</div><div class="srow__sub num">${isAndroid ? 'Android will ask you to confirm the install' : 'Tarang restarts when the update is installed'}</div></div></div>
        <div class="progress-line"><div class="progress-line__meta"><span><strong>${u.total ? `${Math.round(p * 100)}%` : 'Downloading…'}</strong>${u.total ? ` · ${fmtBytes(u.downloaded)} of ${fmtBytes(u.total)}` : ''}</span></div><div class="progress ${u.total ? '' : 'progress--indeterminate'}" style="--p:${Math.round(p * 100)}%"><i></i></div></div>`;
      return;
    }
    let title = 'Tarang updates', sub = `You have ${esc(current)}`, ctl = `<button class="btn btn--secondary btn--sm btn--check" type="button" id="app-check">${icon('refresh', 'icon--16')}Check for updates</button>`;
    if (u.phase === 'checking') { sub = 'Checking GitHub for a newer version…'; ctl = ''; }
    else if (u.phase === 'uptodate') { title += ` <span class="badge badge--ok badge--dot title-badge"><span class="badge__label">Up to date</span></span>`; sub = `${esc(current)} is the newest version · checked just now`; ctl = ctl.replace('Check for updates', 'Check again'); }
    else if (u.phase === 'available' || u.phase === 'permission') {
      title = `Tarang ${esc(info.version)} is available`;
      sub = u.phase === 'permission'
        ? 'Allow “Install unknown apps” for Tarang in the screen that opened, then tap Update again'
        : `You have ${esc(current)}${info.asset_size ? ` · ${fmtBytes(info.asset_size)}` : ''}`;
      ctl = `${whatsNew}<button class="btn btn--primary btn--sm" type="button" id="app-install">${icon('download', 'icon--16')}Update</button>`;
    }
    row.innerHTML = `<div class="between"><div class="srow__main"><div class="srow__title">${title}</div><div class="srow__sub num">${sub}</div></div><div class="srow__ctl cluster">${ctl}</div></div>
      ${u.phase === 'error' ? banner({ kind: 'danger', icon: 'alert', title: 'Couldn’t update', text: esc(u.error || 'Unknown error') }) : ''}`;
  };
  cleanups.push(updates.subscribe(paintUpdate));
  cleanups.push(on(root, 'click', '#app-check', () => {
    if (!online.value) { toast('Checking for updates needs internet', { kind: 'info' }); return; }
    updates.check().catch(() => {});
  }));
  cleanups.push(on(root, 'click', '#app-install', () => updates.install().catch(() => {})));
  cleanups.push(on(root, 'click', '#app-notes', () => { const url = updates.state.info?.page_url; if (url) openExternal(url); }));
  paintYt('checking');
  api.youtubeVersion().then((v) => { ytVersion = v; paintYt('idle'); }).catch((err) => paintYt('idle', err.message || String(err)));
  $('#reset').addEventListener('click', resetSettings);

  async function resetSettings() {
    const ok = await confirmDialog({ title: 'Reset settings?', text: 'Restores every option on this page to its default. Your library, downloads, imports and recordings are untouched.', confirm: 'Reset settings', danger: true });
    if (!ok) return;
    try {
      for (const [k, v] of Object.entries(DEFAULTS)) await setSetting(k, v);
      await setTheme('system');
      toast('Settings reset', { kind: 'ok' });
      renderSettings(root, params, ctx).then((c) => { cleanups.push(c); });
    } catch (err) { toast(`Couldn’t reset: ${err.message || err}`, { kind: 'danger' }); }
  }

  const unsubOnline = online.subscribe(paintOnline);
  cleanups.push(unsubOnline);
  paintCache();
  measure();
  loadImports();
  return () => cleanups.forEach((fn) => { try { fn?.(); } catch {} });
}

// ---------------------------------------------------------------- section markup
function appearanceHTML() {
  const preview = (mainCls = '', invert = '') => `<span class="theme-opt__main ${mainCls}"${invert ? ` data-invert-when="${invert}"` : ''}><i></i><i></i><i></i></span>`;
  return `<section class="sect" id="set-appearance"><div class="section-head"><h3>Appearance</h3></div><div class="card">
    <div class="srow srow--block">
      <div class="between"><div class="srow__main"><div class="srow__title">Theme</div><div class="srow__sub">Light is the default. System follows your device.</div></div></div>
      <div class="themes" role="radiogroup" aria-label="Theme">
        <button type="button" class="theme-opt" role="radio" data-theme-opt="light"><span class="theme-opt__preview" data-invert-when="dark"><i class="theme-opt__side"></i>${preview()}</span><span class="theme-opt__label">Light${icon('check')}</span></button>
        <button type="button" class="theme-opt" role="radio" data-theme-opt="dark"><span class="theme-opt__preview" data-invert-when="light"><i class="theme-opt__side"></i>${preview()}</span><span class="theme-opt__label">Dark${icon('check')}</span></button>
        <button type="button" class="theme-opt theme-opt--system" role="radio" data-theme-opt="system"><span class="theme-opt__preview"><i class="theme-opt__side"></i>${preview('', 'dark')}${preview('', 'light')}</span><span class="theme-opt__label">System${icon('check')}</span></button>
      </div>
    </div>
  </div></section>`;
}

function playbackHTML(s, lastCrossfade) {
  const xOn = Number(s[KEYS.crossfade]) > 0;
  const speed = Number(s[KEYS.voiceSpeed]) || 1;
  return `<section class="sect" id="set-playback"><div class="section-head"><h3>Playback</h3></div><div class="card">
    <div class="srow"><div class="srow__main"><div class="srow__title">Gapless playback</div><div class="srow__sub">No silence between tracks on live albums and DJ mixes.</div></div>${toggle('gapless', s[KEYS.gapless] !== 'false', 'Gapless playback')}</div>
    <div class="srow"><div class="srow__main"><div class="srow__title">Crossfade</div><div class="srow__sub" id="xfade-desc">${xOn ? `${lastCrossfade} s` : 'Off'} · blends the end of a song into the next; choose a length when on. Never applied to voice recordings.</div></div>${toggle('xfade', xOn, 'Crossfade')}</div>
    <div class="srow srow--wrap${xOn ? '' : ' is-disabled'}" id="xfade-row" aria-disabled="${!xOn}">
      <div class="srow__main"><div class="srow__title">Crossfade length</div><div class="srow__sub" id="xfade-sub">${xOn ? 'Blends the end of a song into the next' : 'Turn on Crossfade above to choose 2–12 s'}</div></div>
      <div class="srow__ctl"><select class="select" id="xfade-len" aria-label="Crossfade length" ${xOn ? '' : 'disabled'}>${CROSSFADE.map((v) => `<option value="${v}" ${v === lastCrossfade ? 'selected' : ''}>${v} s</option>`).join('')}</select></div>
    </div>
    <div class="srow srow--block">
      <div class="between"><div class="srow__main"><div class="srow__title">Default speed for voice recordings</div><div class="srow__sub">Music always plays at 1×. Per-recording speed overrides this.</div></div></div>
      <div class="seg seg--block" role="group" aria-label="Default voice speed" id="voice-speed">${VOICE_SPEEDS.map((v) => `<button type="button" class="seg__btn${v === speed ? ' is-active' : ''}" aria-pressed="${v === speed}" data-v="${v}">${v}×</button>`).join('')}</div>
    </div>
    <div class="srow"><div class="srow__main"><div class="srow__title">Sleep timer fades out</div><div class="srow__sub">Lowers the volume over the final 30 s instead of stopping abruptly.</div></div>${toggle('sleep-fade', s[KEYS.sleepFade] !== 'false', 'Sleep timer fades out')}</div>
  </div></section>`;
}

function streamingHTML(s) {
  const mobile = s[KEYS.downloadMobileData] === 'true';
  return `<section class="sect" id="set-streaming"><div class="section-head"><h3>Streaming</h3><span class="section-head__sub">YouTube Music songs you play without downloading</span></div>
    <div id="stream-offline" class="sect__banner"></div>
    <div class="card">
      <div class="srow srow--wrap"><div class="srow__main"><div class="srow__title">Streaming quality</div><div class="srow__sub">Normal uses about half the data. Downloads have their own quality below.</div></div><div class="srow__ctl">${select('stream-q', s[KEYS.streamQuality], STREAM_Q, 'Streaming quality')}</div></div>
      <div class="srow srow--block">
        <div class="between"><div class="srow__main"><div class="srow__title">Stream cache</div><div class="srow__sub" id="cache-sub">Streamed audio is held in chunks while a song plays, then cleared. Nothing streamed is kept.</div></div>
          <div class="srow__ctl"><button class="btn btn--secondary btn--sm" type="button" id="cache-clear">${icon('trash', 'icon--16')}Clear cache</button></div></div>
        <div class="progress-line cache-meter" id="cache-meter"></div>
      </div>
      <div class="srow srow--wrap"><div class="srow__main"><div class="srow__title">Cache limit</div><div class="srow__sub">Oldest chunks are dropped first when the limit is reached.</div></div><div class="srow__ctl">${select('cache-mb', CACHE_MB.some(([v]) => v === String(s[KEYS.streamCacheMb])) ? s[KEYS.streamCacheMb] : '512', CACHE_MB, 'Cache limit')}</div></div>
      <div class="srow"><span class="srow-tile">${icon('cell')}</span><div class="srow__main"><div class="srow__title">Download over mobile data</div><div class="srow__sub" id="mobile-sub">${mobile ? 'On · downloads also run on mobile data.' : 'Off · downloads wait for Wi‑Fi. Streaming still works on mobile data.'}</div></div>${toggle('mobile-data', mobile, 'Download over mobile data')}</div>
    </div>
  </section>`;
}

function downloadsHTML(s, plat) {
  return `<section class="sect" id="set-downloads"><div class="section-head"><h3>Downloads</h3><span class="section-head__sub num" id="dl-free"></span></div><div class="card">
    <div class="srow srow--wrap"><div class="srow__main"><div class="srow__title">Download quality</div><div class="srow__sub">Applies to new downloads. Higher quality uses more storage (~9 MB per song at Best).</div></div><div class="srow__ctl">${select('dl-q', DOWNLOAD_Q.some(([v]) => v === s[KEYS.downloadQuality]) ? s[KEYS.downloadQuality] : 'best', DOWNLOAD_Q, 'Download quality')}</div></div>
    <div class="srow srow--block">
      <div class="between"><div class="srow__main"><div class="srow__title">Download location</div><div class="srow__sub">Downloaded songs land here. It is always scanned for music.</div></div>
        <div class="srow__ctl"><button class="btn btn--secondary btn--sm" type="button" id="dl-change">${icon('folder', 'icon--16')}Change</button></div></div>
      <div id="dl-path">${pathHTML(plat.download_dir || '')}</div>
    </div>
    <div class="srow srow--block">
      <div class="between"><div class="srow__main"><div class="srow__title" id="usage-title">Storage used by Tarang</div><div class="srow__sub num" id="usage-sub">Downloads, voice recordings and the stream cache</div></div>
        <button class="btn btn--icon btn--ghost btn--sm" type="button" id="measure" aria-label="Measure again">${icon('refresh', 'icon--16')}</button></div>
      <div id="usage" class="usage-block">${usageSkeleton(null)}</div>
    </div>
  </div></section>`;
}

function usageSkeleton(prev) {
  const w = [72, 60, 52];
  return `<div class="usage-stats" aria-busy="true">${w.map((x, i) => `<div class="stat"><i class="skel skel--num" style="width:${x}px"></i><i class="skel skel--text skel-gap" style="width:${96 - i * 8}px;max-width:100%"></i></div>`).join('')}
    <div class="stat stat--split">${prev ? `<div class="stat__num">${sizeNum(prev.free_bytes)}</div><div class="stat__label num">Free · of ${esc(fmtBytes(prev.used_bytes + prev.free_bytes))}</div>` : `<i class="skel skel--num" style="width:56px"></i><i class="skel skel--text skel-gap" style="width:80px"></i>`}</div></div>
    <i class="skel skel--bar"></i>`;
}

function usageHTML(st, voiceBytes, voiceCount, stats) {
  const dl = st.downloads_bytes || 0, cache = st.cache_bytes || 0;
  const total = dl + voiceBytes + cache;
  const pc = (x) => (total ? (x / total) * 100 : 0);
  const r = (x) => `${Math.round(pc(x))}%`;
  return `<div class="usage-stats">
      <div class="stat"><div class="stat__num">${sizeNum(dl)}</div><div class="stat__label num">${plural(stats?.downloaded ?? 0, 'download')}</div></div>
      <div class="stat"><div class="stat__num">${sizeNum(voiceBytes)}</div><div class="stat__label num">${plural(voiceCount, 'recording')}</div></div>
      <div class="stat"><div class="stat__num">${sizeNum(cache)}</div><div class="stat__label">Stream cache</div></div>
      <div class="stat stat--split"><div class="stat__num">${sizeNum(st.free_bytes)}</div><div class="stat__label num">Free · of ${esc(fmtBytes(st.used_bytes + st.free_bytes))}</div></div>
    </div>
    <div class="usage" role="img" aria-label="Tarang’s ${esc(fmtBytes(total))}: downloads ${r(dl)}, voice recordings ${r(voiceBytes)}, stream cache ${r(cache)}">
      <i class="usage__music" style="--w:${pc(dl).toFixed(1)}%"></i><i class="usage__voice" style="--w:${pc(voiceBytes).toFixed(1)}%"></i><i class="usage__cache" style="--w:${pc(cache).toFixed(1)}%"></i>
    </div>
    <div class="legend">
      <span class="legend__item"><i class="legend__dot legend__dot--music"></i><strong>${r(dl)}</strong> Downloads</span>
      <span class="legend__item"><i class="legend__dot legend__dot--voice"></i><strong>${r(voiceBytes)}</strong> Voice recordings</span>
      <span class="legend__item"><i class="legend__dot legend__dot--cache"></i><strong>${r(cache)}</strong> Stream cache</span>
    </div>`;
}

function importCardHTML(history, error = null) {
  const tiles = Object.values(PLATFORMS).map((p) => `<button class="card card--interactive platform" type="button" data-platform="${p.id}" aria-label="Import from ${esc(p.name)}">
      <span class="src-mark ${p.mark}">${icon(p.icon)}</span>
      <span class="source-card__body"><span class="source-card__title">${esc(p.name)}</span><span class="source-card__sub">${esc(p.sub)}</span></span>
      <span class="platform__go"><span>Choose</span>${icon('chevron-right', 'icon--16')}</span></button>`).join('');
  let past;
  if (history == null) past = `<div class="list">${skeletonRows(2)}</div>`;
  else if (error) past = banner({ kind: 'danger', icon: 'alert', title: 'Couldn’t load past imports', text: error.message || String(error) });
  else if (!history.length) {
    past = `<div class="empty empty--compact"><div class="empty__icon">${icon('import')}</div><div class="empty__title">No imports yet</div><div class="empty__text">Bring playlists from another app — they become regular playlists you can stream or download.</div></div>`;
  } else {
    const songs = history.reduce((a, h) => a + (h.matched || 0), 0);
    past = `<div class="list">${history.map((h) => {
      const p = PLATFORMS[h.platform] || PLATFORMS.spotify;
      const missing = Math.max(0, (h.total || 0) - (h.matched || 0));
      return `<div class="drow"><span class="src-mark ${p.mark}">${icon(p.icon, 'icon--16')}</span>
        <div class="drow__main"><div class="drow__title">${esc(h.name)}</div><div class="drow__meta"><span>${esc(p.name)}</span><span class="sep"></span><span class="num">${fmtNum(h.matched)} of ${plural(h.total, 'song')}</span><span class="sep"></span><span>${esc(fmtDay(h.imported_at))}</span>${missing ? `<span class="badge badge--danger">${fmtNum(missing)} not found</span>` : ''}</div></div>
        <div class="drow__actions">${h.playlist_id != null ? `<a class="btn btn--secondary btn--sm" href="#playlist/${esc(h.playlist_id)}">Open</a>` : ''}</div></div>`;
    }).join('')}</div>`;
    past = `<div class="between"><div class="srow__title">Past imports</div><span class="srow__value num">${plural(history.length, 'playlist')} · ${plural(songs, 'song')}</span></div>${past}`;
  }
  return `<div id="import-offline" class="sect__banner"></div><div class="card">
    <div class="srow srow--block">
      <div class="srow__main"><div class="srow__title">Bring your songs and playlists over</div><div class="srow__sub">Pick where they are now. Each song is matched on YouTube Music and saved as a playlist in your Library — stream it, or download it to keep.</div></div>
      <div class="platforms">${tiles}</div>
    </div>
    <div class="srow srow--block imports">${history && !history.length && !error ? `<div class="srow__title">Past imports</div>` : ''}${past}</div>
  </div>`;
}

function aboutHTML(plat) {
  const os = { android: 'Android', linux: 'Linux', windows: 'Windows', macos: 'macOS', browser: 'Browser preview' }[plat.os] || plat.os || '';
  return `<section class="sect" id="set-about"><div class="section-head"><h3>About</h3></div><div class="card">
    <div class="srow srow--block" id="app-update"></div>
    <div class="srow srow--block" id="ytdlp"></div>
    <div class="srow"><span class="brand-mark">${icon('play', 'icon--fill')}</span>
      <div class="srow__main"><div class="srow__title">Tarang</div><div class="srow__sub num">Version ${esc(plat.version || '—')}${os ? ` · ${esc(os)}` : ''}</div><div class="srow__sub truncate" title="${esc(plat.data_dir || '')}">Library data: ${esc(prettyPath(plat.data_dir || '').full)}</div></div>
    </div>
    <div class="srow desktop-only"><div class="srow__main"><div class="srow__title">Reset settings</div><div class="srow__sub">Restores every option above to its default. Your library, downloads, imports and recordings are untouched.</div></div>
      <div class="srow__ctl"><button class="btn btn--danger btn--sm" type="button" id="reset">${icon('refresh', 'icon--16')}Reset settings</button></div></div>
  </div><p class="help phone-only set-reset-help">Reset settings is in the ⋯ menu at the top.</p></section>`;
}

// ================================================================ import flow sub-page
const STEP_NAMES = ['Platform', 'Link', 'Review matches', 'Import'];
function stepsHTML(current, phone = false) {
  return `<ol class="steps ${phone ? 'phone-only' : 'desktop-only'}" aria-label="Steps">${STEP_NAMES.map((n, i) => {
    const st = i < current ? 'is-done' : i === current ? 'is-current' : '';
    const label = phone && i === current ? `${n.split(' ')[0]} · step ${i + 1} of 4` : n;
    return `${i ? '<li class="steps__sep"></li>' : ''}<li class="steps__item ${st}">${esc(label)}</li>`;
  }).join('')}</ol>`;
}

const matchArt = (it) => {
  const m = it.match;
  if (!m) return `<div class="art art--empty">${icon('music', 'icon--16')}</div>`;
  if (m.thumbnail) return `<div class="art"><img class="art__img" src="${esc(m.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`;
  return `<div class="art art--${(Math.abs([...m.title].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 6) + 1}"><span>${esc((m.title.match(/\b\p{L}/gu) || ['♪']).slice(0, 2).join('').toUpperCase())}</span></div>`;
};

/** Import sub-page. Exported state helpers are reused by onboarding step 4. */
async function renderImport(root, params, ctx) {
  const p = PLATFORMS[params.import];
  if (!p) { location.replace('#settings?section=import'); return; }
  ctx.setTrail(null);
  const st = { phase: 'link', url: params.url || '', error: '', preview: null, progress: null, include: new Set(), showMatched: 5, name: '', download: false, playlist: null, token: 0 };
  const cleanups = [];

  root.innerHTML = `<div class="page imp-page"><div class="flow" id="flow"></div></div>`;
  const flow = root.querySelector('#flow');

  const unlisten = await listen('import://progress', (e) => {
    if (st.phase !== 'matching') return;
    st.progress = e;
    paintProgress();
  });
  cleanups.push(() => { try { unlisten?.(); } catch {} });
  cleanups.push(online.subscribe(() => { if (st.phase === 'link') paint(); }));

  function bar(title, step, right = '') {
    return `<div class="flow__bar"><a class="btn btn--icon btn--sm" href="#settings?section=import" aria-label="Back to Settings">${icon('chevron-left')}</a><div class="grow truncate"><div class="flow__crumb desktop-only">Settings › Import from other apps</div><div class="flow__title truncate">${esc(title)}</div></div>${step != null ? stepsHTML(step) : ''}${right}</div>`;
  }

  function paint() {
    if (st.phase === 'link') {
      const detected = detectPlatform(st.url);
      const wrong = st.url && detected && detected !== p.id;
      const offline = !online.value;
      flow.innerHTML = `${bar(`Import from ${p.name}`, 1)}
        <div class="flow__body">
          ${stepsHTML(1, true)}
          ${offline ? banner({ kind: 'warn', icon: 'offline', title: 'Importing needs internet', text: 'Links are matched on YouTube Music. Connect and try again — nothing is lost meanwhile.' }) : ''}
          <div class="field">
            <label class="label" for="imp-link">${esc(p.label)}</label>
            <div class="pastebox${st.error ? ' is-error' : detected === p.id ? ' is-detected' : ''}">
              ${icon(st.error ? 'alert' : 'link', 'pastebox__icon')}
              <input class="input${st.error ? ' is-error' : ''}" id="imp-link" type="url" inputmode="url" autocomplete="off" placeholder="${esc(p.placeholder)}" value="${esc(st.url)}" ${st.error ? 'aria-invalid="true"' : ''}>
              ${st.url ? `<button class="btn btn--icon btn--sm" type="button" data-act="clear" aria-label="Clear link">${icon('x', 'icon--16')}</button>` : ''}
            </div>
            <div class="help${st.error ? ' help--error' : ''}" id="imp-help">${esc(st.error || (wrong ? `That looks like a ${PLATFORMS[detected].name} link — it will be read as ${PLATFORMS[detected].name}.` : p.help))}</div>
          </div>
        </div>
        <div class="flow__foot">
          <div class="help grow">Matching reads song titles only; nothing is downloaded yet.</div>
          <div class="flow__cta"><button class="btn btn--primary" type="button" data-act="find" ${st.url.trim() && !offline ? '' : 'disabled'}>Find songs on YouTube Music${icon('chevron-right', 'icon--16')}</button></div>
        </div>`;
      const input = flow.querySelector('#imp-link');
      input.addEventListener('input', debounce(() => { st.url = input.value; st.error = ''; const pos = input.selectionStart; paint(); const i2 = flow.querySelector('#imp-link'); i2.focus(); i2.setSelectionRange(pos, pos); }, 250));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { st.url = input.value; find(); } });
      if (!st.url) requestAnimationFrame(() => input.focus());
      return;
    }
    if (st.phase === 'matching') {
      flow.innerHTML = `${bar(`Import from ${p.name}`, 2, `<button class="btn btn--ghost btn--sm" type="button" data-act="cancel">Cancel</button>`)}
        <div class="flow__body">
          <div class="progress-line" id="imp-progress" aria-live="polite"></div>
          <div class="mlist">${skeletonRows(3)}</div>
        </div>`;
      paintProgress();
      return;
    }
    if (st.phase === 'review' || st.phase === 'committing') {
      const items = st.preview.items;
      const by = (s) => items.map((it, i) => ({ it, i })).filter((x) => x.it.status === s);
      const matched = by('matched'), review = by('review'), missing = by('not_found');
      const reviewIn = review.filter((x) => st.include.has(x.i)).length;
      const count = matched.length + reviewIn;
      const committing = st.phase === 'committing';
      const meta = (it) => [esc(it.artist || ''), it.duration_secs ? `${fmtDuration(it.duration_secs)} on ${esc(p.name)}` : ''].filter(Boolean).join('<span class="sep"></span>');
      flow.innerHTML = `${bar(st.preview.name || `Import from ${p.name}`, 2)}
        <div class="flow__body">
          ${stepsHTML(2, true)}
          <div class="match-stats">
            <div class="match-stat stat stat--ok"><div class="stat__num num">${matched.length}</div><div class="stat__label">Matched</div></div>
            <div class="match-stat stat stat--warn"><div class="stat__num num">${review.length}</div><div class="stat__label">Needs review</div></div>
            <div class="match-stat stat stat--danger"><div class="stat__num num">${missing.length}</div><div class="stat__label">Not found</div></div>
          </div>
          ${!matched.length && !review.length ? `<div class="card card--flush">${emptyState({ icon: 'search', error: true, compact: true, title: `No matches for “${st.preview.name || 'this playlist'}”`, text: `0 of ${items.length} songs are on YouTube Music. No playlist will be created. Try another link, or search YouTube Music yourself.`, actions: `<button class="btn btn--secondary" type="button" data-act="again">${icon('link')}Try another link</button>` })}</div>` : `
          <div class="mlist">
            ${review.length ? `<div class="group-head">Needs review <span class="group-head__count">${review.length} · best guess is used unless you leave it out</span></div>
              ${review.map(({ it, i }) => `<div class="drow mrow--review">${matchArt(it)}
                <div class="drow__main"><div class="drow__title">${esc(it.title)}</div><div class="drow__meta">${meta(it)}</div></div>
                <span class="badge badge--warn">Review</span>
                <div class="cands" role="radiogroup" aria-label="Pick a match for ${esc(it.title)}">
                  <label class="cand"><span class="check"><input type="radio" name="c${i}" value="use" data-i="${i}" ${st.include.has(i) ? 'checked' : ''}></span><span class="cand__main truncate"><span class="strong">${esc(it.match?.title || '')}</span> · ${esc(it.match?.artist || '')}${it.match?.album ? ` · ${esc(it.match.album)}` : ''}</span><span class="cand__dur">${fmtDuration(it.match?.duration_secs)}</span></label>
                  <label class="cand"><span class="check"><input type="radio" name="c${i}" value="skip" data-i="${i}" ${st.include.has(i) ? '' : 'checked'}></span><span class="cand__main truncate">None of these — leave it out</span></label>
                </div></div>`).join('')}` : ''}
            ${missing.length ? `<div class="group-head">Not found <span class="group-head__count">${missing.length} · left out of the playlist</span></div>
              ${missing.map(({ it }) => `<div class="drow">${matchArt(it)}<div class="drow__main"><div class="drow__title">${esc(it.title)}</div><div class="drow__meta"><span>${esc(it.artist || '')}</span><span class="sep"></span><span>No match on YouTube Music</span></div></div>
                <div class="drow__actions"><a class="btn btn--secondary btn--sm" href="#search?q=${encodeURIComponent(`${it.title} ${it.artist || ''}`.trim())}">${icon('search', 'icon--16')}<span class="lbl">Search</span></a></div></div>`).join('')}` : ''}
            ${matched.length ? `<div class="group-head">Matched <span class="group-head__count">${matched.length}</span></div>
              ${matched.slice(0, st.showMatched).map(({ it }) => `<div class="drow">${matchArt(it)}<div class="drow__main"><div class="drow__title">${esc(it.match?.title || it.title)}</div><div class="drow__meta">${it.match?.local_track_id ? `${icon('check', 'sg sg--dl', 'Already in your library')}` : ''}<span>${esc(it.match?.artist || it.artist || '')}</span><span class="sep"></span><span class="num">${fmtDuration(it.match?.duration_secs ?? it.duration_secs)}</span>${it.match?.local_track_id ? '<span class="sep"></span><span>already in your library</span>' : ''}</div></div><span class="badge badge--ok">Matched</span></div>`).join('')}
              ${matched.length > st.showMatched ? `<div class="more-link"><button class="btn btn--ghost btn--sm" type="button" data-act="more">Show all ${matched.length} matched</button></div>` : ''}` : ''}
          </div>`}
        </div>
        ${count ? `<div class="flow__foot">
          <div class="field"><label class="label" for="pl-name">Save as playlist</label><input class="input" id="pl-name" value="${esc(st.name)}" ${committing ? 'disabled' : ''}></div>
          <label class="toggle"><input type="checkbox" id="imp-dl" ${st.download ? 'checked' : ''} ${committing ? 'disabled' : ''}><span class="toggle__track"></span><span class="toggle__label t-13">Download all ${count}</span></label>
          <div class="flow__cta"><button class="btn btn--primary" type="button" data-act="commit" ${committing ? 'disabled' : ''}>${committing ? '<span class="spinner" aria-hidden="true"></span>Importing…' : `Import ${plural(count, 'song')} as playlist`}</button>
            <span class="help num">${matched.length} matched${reviewIn ? ` + ${reviewIn} best ${reviewIn === 1 ? 'guess' : 'guesses'}` : ''}${items.length - count ? ` · ${items.length - count} left out` : ''}</span></div>
        </div>` : ''}`;
      flow.querySelector('#pl-name')?.addEventListener('input', (e) => { st.name = e.target.value; });
      flow.querySelector('#imp-dl')?.addEventListener('change', (e) => { st.download = e.target.checked; });
      return;
    }
    if (st.phase === 'done') {
      const pl = st.playlist;
      flow.innerHTML = `<div class="flow__body">
        ${banner({ kind: 'ok', icon: 'check-circle', title: `“${pl.name}” is in your Library · ${plural(pl.track_count, 'song')}`, text: `Songs stream from YouTube Music until you download them.${st.download ? ' Downloads have started — see Downloads for progress.' : ''}${st.leftOut ? ` ${plural(st.leftOut, 'song')} could not be matched and were left out.` : ''}` })}
        <div class="cluster"><a class="btn btn--primary" href="#playlist/${esc(pl.id)}">${icon('playlist', 'icon--16')}Open playlist</a><button class="btn btn--secondary" type="button" data-act="again">Import another</button><a class="btn btn--ghost" href="#settings?section=import">Back to Settings</a></div>
      </div>`;
    }
  }

  function paintProgress() {
    const el = flow.querySelector('#imp-progress');
    if (!el) return;
    const pr = st.progress;
    el.innerHTML = pr && pr.total
      ? `<div class="progress-line__meta"><span><strong>Matching ${fmtNum(pr.done)} of ${plural(pr.total, 'song')}</strong></span><span>${Math.round((pr.done / pr.total) * 100)}%</span></div><div class="progress progress--thick" style="--p:${Math.round((pr.done / pr.total) * 100)}%"><i></i></div>`
      : `<div class="progress-line__meta"><span><strong>Reading the ${esc(p.name)} link…</strong></span><span>finding songs</span></div><div class="progress progress--thick progress--indeterminate"><i></i></div>`;
  }

  async function find() {
    const url = st.url.trim();
    if (!url || !online.value) return;
    const platformId = detectPlatform(url) || p.id;
    st.phase = 'matching'; st.progress = null; st.error = '';
    const token = ++st.token;
    paint();
    try {
      const preview = await api.importPreview(platformId, url);
      if (token !== st.token) return;
      st.preview = preview;
      st.name = preview.name || '';
      st.include = new Set(preview.items.map((it, i) => (it.status !== 'not_found' && it.match ? i : -1)).filter((i) => i >= 0));
      st.phase = 'review';
    } catch (err) {
      if (token !== st.token) return;
      st.phase = 'link'; st.error = err.message || String(err);
    }
    paint();
  }

  async function commit() {
    const name = (st.name || '').trim() || st.preview.name || `${p.name} import`;
    st.phase = 'committing'; paint();
    try {
      const include = [...st.include].sort((a, b) => a - b);
      const pl = await api.importCommit(st.preview.preview_id, name, include);
      st.playlist = pl;
      st.leftOut = st.preview.items.length - include.length;
      if (st.download) { await api.downloadPlaylist(pl.id).catch((e) => toast(`Couldn’t start downloads: ${e.message || e}`, { kind: 'danger' })); pokeDownloads(); }
      playlists.refresh(); statsStore.refresh();
      dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'import' } }));
      st.phase = 'done';
    } catch (err) {
      st.phase = 'review';
      toast(`Couldn’t import: ${err.message || err}`, { kind: 'danger' });
    }
    paint();
  }

  cleanups.push(on(flow, 'click', '[data-act]', (e, b) => {
    switch (b.dataset.act) {
      case 'clear': st.url = ''; st.error = ''; paint(); break;
      case 'find': st.url = flow.querySelector('#imp-link')?.value || st.url; find(); break;
      case 'cancel': st.token++; st.phase = 'link'; paint(); break;
      case 'more': st.showMatched = Infinity; paint(); break;
      case 'commit': commit(); break;
      case 'again': Object.assign(st, { phase: 'link', url: '', error: '', preview: null, playlist: null, download: false, showMatched: 5 }); paint(); break;
    }
  }));
  cleanups.push(on(flow, 'change', '.cands input[type="radio"]', (e, r) => {
    const i = Number(r.dataset.i);
    if (r.value === 'use') st.include.add(i); else st.include.delete(i);
    paint();
  }));

  paint();
  if (st.url && params.go === '1') find();
  return () => { st.token++; cleanups.forEach((fn) => { try { fn?.(); } catch {} }); };
}

