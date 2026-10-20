// Scan & folders (design/screens/device.html), reached from Settings → Device folders and
// Library → Device. What to scan (scan.mode), included / excluded folder rules, file types
// (scan.extensions), the voice classifier (classifier.enabled), the last-scan summary, and a
// live scan with counters (scan://progress). Folder sizes and per-type counts are computed
// from the library rows (list_tracks) because the scan API reports totals only.
// Styles: styles/views/device.css.

import { api, isAndroid, listen } from '../api.js';
import { openMenu, openSheet } from '../components/overlay.js';
import { pickFolder } from '../components/pickers.js';
import { platform as platformStore, setSetting, settings as settingsStore, stats as statsStore } from '../components/store.js';
import { artHTML } from '../components/art.js';
import { banner, esc, fmtAgo, fmtBytes, fmtDuration, fmtNum, icon, on, plural, toast } from '../ui.js';
import { prettyPath } from './settings.js';

const MODES = [
  ['whole_device', 'Whole device', 'device', 'Every readable folder except the exclude list. Slowest, but finds stray files.'],
  ['selected_folders', 'Selected folders', 'folder', 'Only the folders you add below, plus the app folder. Recommended.'],
  ['app_folder_only', 'App folder only', 'download', 'Just songs downloaded in the app. No storage permission needed.'],
];
const TYPES = [['mp3', 'MP3', ''], ['flac', 'FLAC', ''], ['m4a', 'M4A', 'AAC'], ['aac', 'AAC', ''], ['ogg', 'OGG', 'Vorbis'], ['opus', 'Opus', ''], ['wav', 'WAV', ''], ['amr', 'AMR', '3GP']];
const nw = (s) => esc(s).replace(/ /g, '&nbsp;');
const sepHTML = '<span class="sep"></span><wbr>';
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return null; };

// Per-mode scan size, remembered from the last finished scan in each mode ("~48,200 files ·
// about 6 min" on the mode cards). The scan API reports totals only, so a mode that hasn't
// been scanned yet is estimated from the library rows or left as a plain hint (D43).
const scanMemo = () => { try { return JSON.parse(LS('scan.memo') || '{}') || {}; } catch { return {}; } };
function rememberScan(mode, r) {
  const m = scanMemo();
  m[mode] = { files: r.files_seen || 0, ms: r.elapsed_ms || 0 };
  LS('scan.memo', JSON.stringify(m));
}
const fmtScanTime = (ms) => { const s = Math.round(ms / 1000); return s < 5 ? 'under 5 s' : s < 60 ? `about ${s} s` : `about ${Math.round(s / 60)} min`; };
// Android "All files access": inferred from scan outcomes (no permission query in the API).
const permState = () => LS('scan.perm') || '';

export default {
  title: 'Scan & folders',
  async render(root, params, ctx) {
    const cleanups = [];
    let rules = [], cfg = null, last = null, plat = {}, tracks = [], scan = null, scanStart = 0, missing = new Set();
    let justFound = [];

    const trail = document.createElement('button');
    trail.type = 'button'; trail.className = 'btn btn--icon';
    trail.setAttribute('aria-label', 'More · Scan now, Add folder'); trail.setAttribute('aria-haspopup', 'menu');
    trail.innerHTML = icon('more');
    trail.addEventListener('click', () => openMenu(trail, scanning()
      ? [{ label: 'Stop scan', icon: 'x', danger: true, run: stopScan }]
      : [{ label: 'Scan now', icon: 'scan', run: startScan, disabled: !canScan() }, { label: 'Add folder', icon: 'plus', run: () => addRule('include') }, { label: 'Exclude folder', icon: 'x-circle', run: () => addRule('exclude') }],
    { title: 'Scan & folders' }));
    ctx.setTrail(trail);

    const scanning = () => scan && !scan.finished;
    const mode = () => cfg?.mode || settingsStore.value?.['scan.mode'] || 'selected_folders';
    const includes = () => rules.filter((r) => r.rule === 'include');
    const excludes = () => rules.filter((r) => r.rule === 'exclude');
    const appRule = () => rules.find((r) => r.rule === 'app');
    const appPath = () => appRule()?.path || plat.download_dir || '';
    const canScan = () => true; // the app folder is always scanned, so a scan always has somewhere to look
    const under = (t, path) => t.path && (t.path === path || t.path.startsWith(path.replace(/\/$/, '') + '/'));
    function folderStats(path) {
      const list = tracks.filter((t) => under(t, path));
      return { songs: list.filter((t) => t.kind === 'music').length, voice: list.filter((t) => t.kind !== 'music').length, bytes: list.reduce((a, t) => a + (t.size_bytes || 0), 0), albums: new Set(list.filter((t) => t.album).map((t) => t.album)).size };
    }
    /** "~1,700 files · about 40 s" for a mode card: remembered scan, else library-based estimate. */
    function modeFoot(v) {
      const memo = scanMemo()[v] || (last && mode() === v && last[1].finished !== false ? { files: last[1].files_seen, ms: last[1].elapsed_ms } : null);
      const inc = includes().filter((r) => r.enabled).length;
      const lead = v === 'selected_folders' ? `${plural(inc, 'folder')} · ` : '';
      if (memo?.files) return `${lead}~${fmtNum(memo.files)} files · ${fmtScanTime(memo.ms || 0)}`;
      if (v === 'app_folder_only') { const s = folderStats(appPath()); return `${fmtNum(s.songs + s.voice)} files · under 5 s`; }
      if (v === 'selected_folders') { const n = inc ? includes().reduce((a, r) => a + folderStats(r.path).songs + folderStats(r.path).voice, 0) : 0; return `${lead}${n ? `~${fmtNum(n)}+ audio files` : 'plus the app folder'}`; }
      return 'Not measured yet · usually a few minutes';
    }
    /** Phone: Android "All files access" status under Whole device. */
    function permLine() {
      if (!isAndroid) return '';
      const p = permState();
      if (p === 'granted') return `<span class="mode__perm phone-only">${icon('check', 'icon--16')}All files access granted</span>`;
      if (p === 'denied') return `<span class="mode__perm mode__perm--warn phone-only">${icon('alert', 'icon--16')}Needs “All files access”</span>`;
      return `<span class="mode__perm mode__perm--muted phone-only">${icon('info', 'icon--16')}Asks for “All files access” on first scan</span>`;
    }
    function scopeNote() {
      const inc = includes().filter((r) => r.enabled).length;
      const est = last?.[1]?.files_seen;
      const secs = last?.[1]?.elapsed_ms ? Math.max(1, Math.round(last[1].elapsed_ms / 1000)) : null;
      const where = mode() === 'whole_device' ? 'Whole device' : mode() === 'app_folder_only' ? 'App folder only' : `${plural(inc, 'folder')} + app folder`;
      return `${where}${est ? ` · ~${fmtNum(est)} files` : ''}${secs ? ` · about ${secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`}` : ''}`;
    }

    root.innerHTML = `<div class="page dev-page">
      <div class="page-head desktop-only" id="dev-head"></div>
      <div id="dev-banner"></div>
      <div class="dev" id="dev"><div class="dev__col">${'<section class="card card--pad-lg"><div class="skel-frow"><span class="skel skel--art"></span><div class="stack"><span class="skel skel--title"></span><span class="skel skel--text w-80"></span></div><span class="skel skel--text w-100"></span></div><div class="skel-frow"><span class="skel skel--art"></span><div class="stack"><span class="skel skel--title w-40"></span><span class="skel skel--text"></span></div><span class="skel skel--text w-100"></span></div></section>'.repeat(2)}</div></div>
    </div>
    <div class="scanbar" id="scanbar"></div>`;
    const $ = (s) => root.querySelector(s);

    // ---------------------------------------------------------------- data
    async function load() {
      try {
        const [r, c, l, p, busy, music, voice, unsure] = await Promise.all([
          api.rules(), api.scanConfig(), api.lastScan().catch(() => null), platformStore.refresh(), api.isScanning().catch(() => false),
          api.tracks('music', { filter: 'all', limit: 100000 }).catch(() => []), api.tracks('voice', { limit: 100000 }).catch(() => []), api.tracks('unsure', { limit: 100000 }).catch(() => []),
        ]);
        rules = r; cfg = c; last = l; plat = p || {}; tracks = [...music, ...voice, ...unsure];
        if (busy && !scanning()) { scan = { files_seen: 0, audio_found: 0, music: 0, voice: 0, unsure: 0, added: 0, skipped: 0, finished: false, current_path: '' }; scanStart = Date.now(); }
        statsStore.refresh();
        paint();
        checkMissing();
      } catch (e) {
        $('#dev').innerHTML = `<div class="dev__col">${banner({ kind: 'danger', icon: 'alert', title: 'Couldn’t load scan settings', text: e.message || String(e), action: `<button class="btn btn--secondary btn--sm" type="button" data-act="reload">${icon('refresh', 'icon--16')}Try again</button>` })}</div>`;
      }
    }
    async function checkMissing() {
      if (isAndroid) return; // list_dirs needs storage permission on Android; the scan error banner covers it
      const res = await Promise.all(includes().map((r) => (r.path.startsWith('/') ? api.listDirs(r.path).then(() => null).catch(() => r.id) : null)));
      const next = new Set(res.filter((x) => x != null));
      if ([...next].join() !== [...missing].join()) { missing = next; paint(); }
    }

    // ---------------------------------------------------------------- paint
    function paint() {
      paintHead();
      paintBanner();
      if (scanning()) paintScanning(); else paintSettings();
      paintScanbar();
    }
    function paintHead() {
      $('#dev-head').innerHTML = `<div><nav class="crumb" aria-label="Breadcrumb"><a href="#settings?section=device">Settings</a>${icon('chevron-right')}<span>Scan &amp; folders</span></nav>
        <h1>Scan &amp; folders</h1>
        <div class="page-head__sub">${scanning() ? 'Keep listening while this runs — new songs appear in Library as they’re found.' : `Choose where the app looks for audio on this ${isAndroid || plat.is_mobile ? 'phone' : 'computer'}. Nothing leaves the device. Songs found here appear in <a href="#library?tab=device">Library → Device</a>.`}</div></div>
        ${scanning() ? '' : `<div class="head-cta"><button class="btn btn--primary btn--lg" type="button" data-act="scan" ${canScan() ? '' : 'disabled'}>${icon('scan')}Scan now</button><span class="head-cta__note num">${esc(scopeNote())}</span></div>`}`;
    }
    function paintBanner() {
      const el = $('#dev-banner');
      const err = scan?.finished && /^Error:/.test(scan.current_path || '') ? scan.current_path.replace(/^Error:\s*/, '') : '';
      if (!err) { el.innerHTML = ''; return; }
      const perm = /permission|denied|EACCES/i.test(err);
      el.innerHTML = `<div class="banner banner--danger">${icon('alert')}<div class="banner__body"><div class="banner__title">${perm ? (isAndroid ? 'Scan stopped — storage permission denied' : 'Scan stopped — permission denied') : 'The scan stopped'}</div><div class="banner__text num">${perm && isAndroid ? 'Android needs “All files access” to scan outside the app folder. ' : ''}${esc(err)}${scan.files_seen ? ` <span class="nw">${fmtNum(scan.files_seen)} files</span> were checked; nothing was removed.` : ''}</div></div>
        ${perm && isAndroid ? `<button class="btn btn--secondary btn--sm" type="button" data-mode="app_folder_only">Use app folder only</button>` : `<button class="btn btn--secondary btn--sm" type="button" data-act="scan">${icon('refresh', 'icon--16')}Try again</button>`}</div>`;
    }

    function summaryHTML() {
      if (!last) {
        return `<section class="card card--pad-lg sum" aria-labelledby="h-last"><div class="card__head"><div><h4 id="h-last">Last scan</h4><div class="card__sub">Nothing scanned yet.</div></div><span class="badge">Never</span></div>
          <div class="empty empty--compact"><div class="empty__icon">${icon('scan')}</div><div class="empty__title">No scan yet</div><div class="empty__text">Add a folder, then scan. You can keep listening meanwhile.</div></div>
          <div class="sum__scan"><button class="btn btn--primary btn--block" type="button" data-act="scan">${icon('scan')}Scan now</button><span class="sum__scan-note num">${esc(scopeNote())}</span></div></section>`;
      }
      const [at, r] = last;
      const st = statsStore.value || {};
      const secs = Math.round((r.elapsed_ms || 0) / 1000);
      const notAudio = Math.max(0, (r.files_seen || 0) - (r.audio_found || 0));
      return `<section class="card card--pad-lg sum" aria-labelledby="h-last">
        <div class="between"><div class="sum__status">${icon('check-circle')}<div><h4 id="h-last">Last scan complete</h4><div class="t-13 muted num">${esc(fmtAgo(at))} · took ${secs < 60 ? `${secs} s` : fmtDuration(secs)}</div></div></div>${r.added || r.removed || r.updated ? '' : '<span class="badge badge--ok">Up to date</span>'}</div>
        <div class="stats">
          <div class="stat"><div class="stat__num">${fmtNum(st.music ?? r.music)}</div><div class="stat__label">Songs${r.added ? ` <span class="stat__delta num">+${fmtNum(r.added)}</span>` : ''}</div></div>
          <div class="stat"><div class="stat__num">${fmtNum(st.voice ?? r.voice)}</div><div class="stat__label">Voice</div></div>
          <div class="stat${(st.unsure ?? r.unsure) ? ' stat--accent' : ''}"><div class="stat__num">${fmtNum(st.unsure ?? r.unsure)}</div><div class="stat__label">To review</div></div>
          <div class="stat"><div class="stat__num">${fmtNum(r.skipped)}</div><div class="stat__label">Skipped</div></div>
        </div>
        <div class="kv">
          <div class="kv__row"><span>Files checked</span><strong>${fmtNum(r.files_seen)}</strong></div>
          <div class="kv__row"><span>Not audio — images, playlists, lyrics</span><strong>${fmtNum(notAudio)}</strong></div>
          <div class="kv__row"><span>New songs added</span><strong>${fmtNum(r.added)}</strong></div>
          <div class="kv__row"><span>Tags or artwork updated</span><strong>${fmtNum(r.updated)}</strong></div>
          <div class="kv__row"><span>Removed — file no longer on disk</span><strong>${fmtNum(r.removed)}</strong></div>
          <div class="kv__row"><span>Skipped — too short or not playable</span><strong>${fmtNum(r.skipped)}</strong></div>
        </div>
        <div class="sum__actions">
          <a class="btn btn--secondary btn--sm" href="#library?tab=device">${icon('library')}${r.added ? `View ${fmtNum(r.added)} new in Library` : 'View in Library'}</a>
          ${(st.unsure ?? r.unsure) ? `<a class="btn btn--secondary btn--sm" href="#voice">${icon('mic')}Review ${plural(st.unsure ?? r.unsure, 'recording')}</a>` : ''}
          ${r.skipped ? `<button class="btn btn--ghost btn--sm" type="button" data-act="skipped">Skipped files</button>` : ''}
        </div>
        <div class="sum__scan"><button class="btn btn--primary btn--block" type="button" data-act="scan" ${canScan() ? '' : 'disabled'}>${icon('scan')}Scan now</button><span class="sum__scan-note num">${esc(scopeNote())}</span></div>
      </section>`;
    }

    function folderRow(r, { app = false, ex = false } = {}) {
      const pp = prettyPath(r.path);
      const isMissing = missing.has(r.id);
      const voiceish = /record|voice|whatsapp/i.test(r.path);
      const mark = isMissing ? '' : ex ? 'src-mark--ex' : voiceish ? 'src-mark--voice' : 'src-mark--local';
      const ic = isMissing ? 'alert' : ex ? 'x-circle' : app ? 'download' : voiceish ? 'mic' : 'folder';
      let meta;
      if (isMissing) meta = `Folder not found — drive unplugged or renamed? Songs from it are hidden until it’s back`;
      else if (ex) { const n = r.path.startsWith('/') ? tracks.filter((t) => under(t, r.path)).length : 0; meta = r.path.startsWith('/') ? `Never scanned${n ? `${sepHTML}${fmtNum(n)}&nbsp;files&nbsp;still&nbsp;in&nbsp;library` : ''}` : `Any folder named “${esc(r.path)}”`; }
      else {
        const s = folderStats(r.path);
        const parts = [];
        if (s.songs || !s.voice) parts.push(`${fmtNum(s.songs)}&nbsp;${s.songs === 1 ? 'song' : 'songs'}`);
        if (s.voice) parts.push(`${fmtNum(s.voice)}&nbsp;voice`);
        if (s.albums > 1) parts.push(`${fmtNum(s.albums)}&nbsp;albums`);
        if (s.bytes) parts.push(nw(fmtBytes(s.bytes)));
        const exIn = excludes().filter((e) => e.path.startsWith(r.path.replace(/\/$/, '') + '/')).length;
        if (exIn) parts.push(`${exIn}&nbsp;subfolder${exIn === 1 ? '' : 's'}&nbsp;excluded`);
        if (app) parts.push('always&nbsp;scanned');
        if (!r.enabled) parts.push('paused');
        meta = parts.join(sepHTML);
      }
      const actions = app ? ''
        : isMissing ? `<button class="btn btn--secondary btn--sm" type="button" data-act="locate" data-id="${r.id}">${icon('folder')}Locate folder</button><button class="btn btn--icon btn--sm" type="button" data-act="remove" data-id="${r.id}" aria-label="Remove ${esc(pp.full)}">${icon('x', 'icon--16')}</button>`
          : `<button class="btn btn--icon btn--sm" type="button" data-act="remove" data-id="${r.id}" aria-label="${ex ? `Stop excluding ${esc(pp.full)}` : `Remove ${esc(pp.full)} from scan`}">${icon('x', 'icon--16')}</button>`;
      return `<div class="frow${isMissing ? ' is-error' : ''}${r.enabled === false ? ' is-off' : ''}">
        <span class="src-mark ${mark}">${icon(ic)}</span>
        <div class="frow__main">
          <div class="frow__path"><span title="${esc(r.path)}">${esc(pp.full)}</span>${app ? `<span class="badge badge--outline desktop-only">${icon('lock')}App folder</span>` : ''}${isMissing ? '<span class="badge badge--danger desktop-only">Not found</span>' : ''}</div>
          ${app ? `<div class="frow__tag phone-only"><span class="badge badge--outline">${icon('lock')}App folder · always scanned</span></div>` : ''}${isMissing ? '<div class="frow__tag phone-only"><span class="badge badge--danger">Not found</span></div>' : ''}
          <div class="frow__meta">${meta}</div>
        </div>
        <div class="frow__actions">${actions}</div>
      </div>`;
    }

    function paintSettings() {
      const m = mode();
      const inc = includes(), exc = excludes();
      const incTotal = inc.reduce((a, r) => { const s = folderStats(r.path); return { songs: a.songs + s.songs, voice: a.voice + s.voice, bytes: a.bytes + s.bytes }; }, folderStats(appPath()));
      const exts = new Set((cfg?.extensions || []).map((e) => e.toLowerCase()));
      const known = TYPES.filter(([e]) => exts.has(e) || ['mp3', 'flac', 'm4a', 'ogg', 'opus', 'wav'].includes(e));
      const extras = [...exts].filter((e) => !TYPES.some(([x]) => x === e)).map((e) => [e, e.toUpperCase(), '']);
      const typeCount = (e) => tracks.filter((t) => (t.format || (t.path || '').split('.').pop() || '').toLowerCase() === e).length;
      const classify = cfg ? cfg.classify : true;
      const unsureN = statsStore.value?.unsure ?? tracks.filter((t) => t.kind === 'unsure').length;
      const appRow = folderRow({ id: appRule()?.id ?? 'app', path: appPath(), enabled: true }, { app: true });
      $('#dev').innerHTML = `
        <aside class="dev__aside">${summaryHTML()}</aside>
        <div class="dev__col">
          <section class="card card--pad-lg" aria-labelledby="h-mode">
            <div class="card__head"><div><h4 id="h-mode">What to scan</h4><div class="card__sub">The app folder, where your YouTube Music downloads land, is always included.</div></div></div>
            <div class="modes" role="radiogroup" aria-label="Scan mode">${MODES.map(([v, t, ic, text]) => {
              return `<label class="mode${v === m ? ' is-selected' : ''}"><span class="mode__top"><span class="check"><input type="radio" name="dev-mode" value="${v}" ${v === m ? 'checked' : ''}></span><span class="mode__title">${t}</span>${icon(ic, 'mode__icon')}</span><span class="mode__text">${text}</span><span class="mode__foot num">${esc(modeFoot(v))}</span>${v === 'whole_device' ? permLine() : ''}</label>`;
            }).join('')}</div>
          </section>

          <section class="card card--pad-lg" aria-labelledby="h-inc">
            <div class="card__head"><div><h4 id="h-inc">Included folders</h4><div class="card__sub num">${missing.size ? `${plural(missing.size, 'folder')} unavailable` : `${plural(inc.length + 1, 'folder')} · ${plural(incTotal.songs, 'song')} · ${plural(incTotal.voice, 'voice recording')}${incTotal.bytes ? ` · ${fmtBytes(incTotal.bytes)}` : ''}`}</div></div>
              <button class="btn btn--secondary btn--sm desktop-only" type="button" data-act="add-include">${icon('plus')}Add folder</button></div>
            <div class="flist">${appRow}${inc.map((r) => folderRow(r)).join('')}</div>
            ${inc.length ? `<div class="card__foot phone-only"><button class="btn btn--secondary" type="button" data-act="add-include">${icon('plus')}Add folder</button></div>`
              : `<div class="empty empty--compact"><div class="empty__icon">${icon('folder')}</div><div class="empty__title">Add the folders that hold your music</div><div class="empty__text">Pick Music, Downloads or a recordings folder. You can change this any time.</div><div class="empty__actions"><button class="btn btn--primary" type="button" data-act="add-include">${icon('plus')}Add folder</button>${m !== 'whole_device' ? `<button class="btn btn--ghost" type="button" data-mode="whole_device">Scan whole device instead</button>` : ''}</div></div>`}
          </section>

          <section class="card card--pad-lg" aria-labelledby="h-exc">
            <div class="card__head"><div><h4 id="h-exc">Excluded folders</h4><div class="card__sub">Never scanned, even inside an included folder.</div></div>
              <button class="btn btn--secondary btn--sm desktop-only" type="button" data-act="add-exclude">${icon('plus')}Exclude folder</button></div>
            ${exc.length ? `<div class="flist">${exc.map((r) => folderRow(r, { ex: true })).join('')}</div>` : '<p class="t-13 muted dev-none">No folders excluded.</p>'}
            <div class="card__foot">
              <label class="toggle"><input type="checkbox" id="dev-nomedia" ${cfg?.respect_nomedia !== false ? 'checked' : ''}><span class="toggle__track"></span><span><span class="toggle__label">Skip folders with a .nomedia file</span><span class="toggle__help">Apps mark caches and ringtones this way</span></span></label>
              <button class="btn btn--secondary phone-only" type="button" data-act="add-exclude">${icon('plus')}Exclude folder</button>
            </div>
          </section>

          <section class="card card--pad-lg" aria-labelledby="h-types">
            <div class="card__head"><div><h4 id="h-types">File types</h4><div class="card__sub">Songs in your library per type.</div></div><span class="badge num">${fmtNum([...known, ...extras].filter(([e]) => exts.has(e)).length)} of ${fmtNum(known.length + extras.length)} on</span></div>
            <div class="ftypes">${[...known, ...extras].map(([e, l, sub]) => `<div class="ftype"><label class="check"><input type="checkbox" data-ext="${esc(e)}" ${exts.has(e) ? 'checked' : ''}>${esc(l)}${sub ? ` <span class="ftype__ext">${esc(sub)}</span>` : ''}</label><span class="ftype__n">${fmtNum(typeCount(e))}</span></div>`).join('')}</div>
            <div class="ftypes-note">${icon('info', 'icon--16')}<span>WMA and MIDI can’t be played and are always skipped.</span></div>
          </section>

          <section class="card card--pad-lg" aria-labelledby="h-cls">
            <label class="cls__head"><span class="grow"><span class="t-16 dev-block" id="h-cls">Separate voice recordings from music</span><span class="card__sub dev-block">Recordings go to <a href="#voice">Voice recordings</a> and never enter music shuffle.</span></span>
              <span class="toggle"><input type="checkbox" id="dev-classify" ${classify ? 'checked' : ''} aria-labelledby="h-cls"><span class="toggle__track"></span></span></label>
            <div class="eyebrow signals__label">Detected by</div>
            <div class="signals">
              <div class="signal">${icon('dot', 'icon--16')}<span><strong>Folder name</strong> — Recordings, Voice Memos, Call recordings</span></div>
              <div class="signal">${icon('dot', 'icon--16')}<span><strong>Recorder format</strong> — AMR, 3GP, mono M4A</span></div>
              <div class="signal">${icon('dot', 'icon--16')}<span><strong>No music tags</strong> — no artist, album or artwork</span></div>
              <div class="signal">${icon('dot', 'icon--16')}<span><strong>Speech, not music</strong> — low bitrate, mostly voice</span></div>
            </div>
            <div class="unsure"><div><div class="strong">When unsure</div><div class="t-13 muted">${unsureN ? `${plural(unsureN, 'file')} ${unsureN === 1 ? 'is' : 'are'} waiting for you to decide.` : 'Files the classifier can’t place wait for you in Voice recordings.'}</div></div>
              ${unsureN ? `<a class="btn btn--secondary btn--sm" href="#voice">${icon('mic', 'icon--16')}Review ${fmtNum(unsureN)}</a>` : ''}</div>
          </section>
        </div>`;
    }

    function paintScanning() {
      const r = scan;
      const est = Math.max(last?.[1]?.files_seen || 0, r.files_seen || 0);
      const pct = est && last ? Math.min(99, Math.round((r.files_seen / est) * 100)) : null;
      const elapsed = Math.max(0, (Date.now() - scanStart) / 1000);
      const rate = elapsed > 1 ? Math.round(r.files_seen / elapsed) : 0;
      const left = pct != null && rate ? Math.max(0, Math.round((est - r.files_seen) / rate)) : null;
      const folder = (() => { const all = [appPath(), ...includes().map((x) => x.path)]; const hit = all.find((p) => r.current_path?.startsWith(p)); return hit ? prettyPath(hit).tail : null; })();
      const preparing = !r.files_seen;
      $('#dev').innerHTML = `<div class="dev__col dev__col--full">
        <section class="card card--pad-lg scan" aria-label="Scan progress" aria-live="polite">
          <div class="scan__top">
            <span class="ring-wrap"><svg class="ring ring--lg" viewBox="0 0 36 36" aria-hidden="true"><circle class="ring__bg" cx="18" cy="18" r="15.5"/><circle class="ring__fg" cx="18" cy="18" r="15.5" pathLength="100" style="--p:${pct ?? 12}"/></svg>${pct != null && !preparing ? `<span class="ring-wrap__label t-14">${pct}%</span>` : icon('folder')}</span>
            <div class="grow"><div class="scan__title truncate">${preparing ? 'Preparing scan…' : folder ? `Scanning ${esc(folder)}` : 'Scanning'}</div>
              <div class="meta"><span class="scan__elapsed">${fmtDuration(elapsed)} elapsed</span>${left != null ? `<span class="sep scan__elapsed"></span><span class="hi">~${left < 60 ? `${left} s` : fmtDuration(left)} left</span>` : ''}${rate ? `<span class="sep"></span><span>${fmtNum(rate)} files/s</span>` : ''}</div></div>
            <div class="scan__actions"><button class="btn btn--ghost" type="button" data-act="stop">Stop</button></div>
          </div>
          <div class="progress-line">
            <div class="progress-line__meta"><span><strong>${fmtNum(r.files_seen)}</strong>${est && last ? ` of ~${fmtNum(est)}` : ''} files</span><span>${fmtNum(r.audio_found)} audio</span></div>
            <div class="progress progress--thick${pct == null ? ' progress--indeterminate' : ''}" style="--p:${pct ?? 0}%"><i></i></div>
            <div class="scan__file">${esc(prettyPath(r.current_path || '').full)}</div>
          </div>
          <div class="stats">
            <div class="stat"><div class="stat__num">${fmtNum(r.music)}</div><div class="stat__label">Songs</div></div>
            <div class="stat"><div class="stat__num">${fmtNum(r.voice)}</div><div class="stat__label">Voice</div></div>
            <div class="stat stat--ok"><div class="stat__num">${fmtNum(r.added)}</div><div class="stat__label">New</div></div>
            <div class="stat stat--accent"><div class="stat__num">${fmtNum(r.unsure)}</div><div class="stat__label">Review</div></div>
            <div class="stat"><div class="stat__num">${fmtNum(r.skipped)}</div><div class="stat__label">Skipped</div></div>
          </div>
        </section>
        ${justFound.length ? `<section aria-labelledby="h-found"><div class="section-head section-head--sm"><h3 id="h-found">Just found</h3><span class="t-13 muted num">newest first</span></div>
          <div class="list found">${justFound.map((t) => `<div class="drow">${artHTML(t)}<div class="drow__main"><div class="drow__title">${esc(t.title)}</div><div class="drow__meta"><span>${esc([t.artist, t.album].filter(Boolean).join(' · ') || prettyPath(t.path || '').head)}</span>${t.kind === 'voice' ? '<span class="badge badge--voice">Voice</span>' : t.kind === 'unsure' ? '<span class="badge badge--warn">Needs review</span>' : '<span class="badge badge--ok">New song</span>'}</div></div><span class="drow__dur">${fmtDuration(t.duration_secs)}</span></div>`).join('')}</div></section>` : ''}
        <section class="card locked" aria-label="Folder settings locked while scanning"><div class="between"><div><div class="strong">Folders and file types are locked</div><div class="locked__text">Edits apply to the next scan.</div></div>${icon('lock')}</div></section>
      </div>`;
    }

    function paintScanbar() {
      const el = $('#scanbar');
      if (scanning()) {
        el.innerHTML = `<div class="scanbar__row"><button class="btn btn--ghost btn--lg" type="button" data-act="stop">${icon('x')}Stop scan</button></div><div class="scanbar__note num">${fmtNum(scan.files_seen)} files checked · ${plural(scan.music, 'song')}</div>`;
      } else {
        el.innerHTML = `<button class="btn btn--primary btn--lg btn--block" type="button" data-act="scan" ${canScan() ? '' : 'disabled'}>${icon('scan')}Scan now</button><div class="scanbar__note num">${esc(scopeNote())}</div>`;
      }
    }

    // ---------------------------------------------------------------- actions
    async function startScan() {
      if (scanning()) return;
      try {
        await api.startScan();
        scan = { files_seen: 0, audio_found: 0, music: 0, voice: 0, unsure: 0, added: 0, skipped: 0, finished: false, current_path: '' };
        scanStart = Date.now(); justFound = [];
        paint();
      } catch (e) { toast(`Couldn’t start the scan: ${e.message || e}`, { kind: 'danger' }); }
    }
    async function stopScan() { try { await api.cancelScan(); } catch (e) { toast(`Couldn’t stop: ${e.message || e}`, { kind: 'danger' }); } }
    async function addRule(kind, replaceId = null) {
      const path = await pickFolder({ title: kind === 'exclude' ? 'Exclude a folder' : replaceId ? 'Locate the folder' : 'Add a music folder', start: rules.find((r) => r.id === replaceId)?.path?.replace(/\/[^/]+\/?$/, '') || null, confirm: kind === 'exclude' ? 'Exclude this folder' : 'Use this folder' });
      if (!path) return;
      try {
        if (replaceId != null) await api.removeRule(replaceId);
        rules = await api.addRule(path, kind);
        missing.delete(replaceId);
        toast(kind === 'exclude' ? 'Folder excluded' : 'Folder added', { kind: 'ok', sub: 'Applies to the next scan', action: { label: 'Scan now', run: startScan } });
        paint(); checkMissing();
      } catch (e) { toast(`Couldn’t add the folder: ${e.message || e}`, { kind: 'danger' }); }
    }
    async function removeRule(id) {
      const r = rules.find((x) => String(x.id) === String(id));
      if (!r) return;
      try {
        rules = await api.removeRule(r.id);
        toast(r.rule === 'exclude' ? 'No longer excluded' : 'Folder removed from scan', { sub: r.rule === 'exclude' ? null : 'Songs from it leave the library on the next scan', action: { label: 'Undo', run: async () => { rules = await api.addRule(r.path, r.rule); paint(); } } });
        paint();
      } catch (e) { toast(`Couldn’t remove: ${e.message || e}`, { kind: 'danger' }); }
    }
    /** Skipped-files sheet: why files were skipped. The scan reports a count only (no per-file list yet). */
    function openSkipped() {
      const r = last?.[1];
      if (!r) return;
      const min = cfg?.min_duration_secs ?? 10;
      const exts = (cfg?.extensions || []).map((e) => `.${e}`).join(', ');
      openSheet({
        title: 'Skipped files', sub: `${plural(r.skipped, 'file')} in the last scan`,
        body: `<p class="t-13 muted dev-skip-note">The scan reports how many files it skipped, not which ones. A file is skipped when it is:</p>
          <ul class="dev-skip">
            <li>${icon('clock', 'icon--16')}<span>Shorter than ${min} s — ringtones, notification sounds</span></li>
            <li>${icon('x-circle', 'icon--16')}<span>Not playable — WMA, MIDI or a damaged file</span></li>
            <li>${icon('music', 'icon--16')}<span>A file type that’s turned off${exts ? ` (now scanning ${esc(exts)})` : ''}</span></li>
            ${cfg?.respect_nomedia ? `<li>${icon('folder', 'icon--16')}<span>In a folder with a .nomedia file</span></li>` : ''}
          </ul>
          <p class="t-13 muted dev-skip-note">Nothing is moved or deleted. Turn a type on under “File types” and scan again to include it.</p>`,
      });
    }
    async function setMode(v) {
      try { await setSetting('scan.mode', v); if (cfg) cfg.mode = v; paint(); } catch (e) { toast(`Couldn’t save: ${e.message || e}`, { kind: 'danger' }); }
    }

    cleanups.push(on(root, 'click', '[data-act]', (e, b) => {
      switch (b.dataset.act) {
        case 'scan': startScan(); break;
        case 'stop': stopScan(); break;
        case 'reload': load(); break;
        case 'add-include': addRule('include'); break;
        case 'add-exclude': addRule('exclude'); break;
        case 'remove': removeRule(b.dataset.id); break;
        case 'locate': addRule('include', Number(b.dataset.id)); break;
        case 'skipped': openSkipped(); break;
      }
    }));
    cleanups.push(on(root, 'click', '[data-mode]', (e, b) => setMode(b.dataset.mode)));
    cleanups.push(on(root, 'change', 'input[name="dev-mode"]', (e, i) => setMode(i.value)));
    cleanups.push(on(root, 'change', '#dev-nomedia', async (e, c) => { try { await setSetting('scan.respect_nomedia', c.checked ? 'true' : 'false'); if (cfg) cfg.respect_nomedia = c.checked; } catch (err) { toast(`Couldn’t save: ${err.message || err}`, { kind: 'danger' }); } }));
    cleanups.push(on(root, 'change', '#dev-classify', async (e, c) => { try { await setSetting('classifier.enabled', c.checked ? 'true' : 'false'); if (cfg) cfg.classify = c.checked; } catch (err) { toast(`Couldn’t save: ${err.message || err}`, { kind: 'danger' }); } }));
    cleanups.push(on(root, 'change', '[data-ext]', async () => {
      const list = [...root.querySelectorAll('[data-ext]')].filter((x) => x.checked).map((x) => x.dataset.ext);
      if (!list.length) { toast('Keep at least one file type', { kind: 'info' }); paint(); return; }
      try { await setSetting('scan.extensions', list.join(',')); if (cfg) cfg.extensions = list; paint(); } catch (err) { toast(`Couldn’t save: ${err.message || err}`, { kind: 'danger' }); }
    }));

    // live scan
    let lastFound = 0, tick = null;
    const unlisten = await listen('scan://progress', async (r) => {
      const was = scanning();
      if (!was && !r.finished) { scanStart = Date.now(); justFound = []; }
      scan = r;
      if (r.finished) {
        clearInterval(tick); tick = null;
        if (was) {
          const err = /^Error:/.test(r.current_path || '');
          if (!err) rememberScan(mode(), r);
          if (isAndroid && mode() !== 'app_folder_only') LS('scan.perm', err && /permission|denied|EACCES/i.test(r.current_path) ? 'denied' : err ? permState() : 'granted');
          if (!err) toast(`Scan finished — ${plural(r.added, 'new song')}`, { kind: 'ok', sub: `${fmtNum(r.files_seen)} files checked · ${fmtNum(r.voice)} voice · ${fmtNum(r.unsure)} to review` });
          dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'scan' } }));
          await load();
          return;
        }
      } else if (!tick) tick = setInterval(() => { if (scanning()) { paintScanning(); paintScanbar(); } }, 1000);
      if (Date.now() - lastFound > 2500 && !r.finished) {
        lastFound = Date.now();
        api.tracks('music', { sort: 'recent', limit: 4 }).then((list) => { justFound = list.filter((t) => t.source === 'local' && (t.added_at || 0) * 1000 >= scanStart - 5000); }).catch(() => {});
      }
      paint();
    });
    cleanups.push(() => { try { unlisten?.(); } catch {} clearInterval(tick); });

    await load();
    // #device?scan=1 starts a scan right away (deep link from other screens).
    if (params.scan === '1' && !scanning()) startScan();
    return () => cleanups.forEach((fn) => { try { fn?.(); } catch {} });
  },
};
