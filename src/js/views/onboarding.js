// Onboarding (design/screens/onboarding.html) — first run, setup shell (no sidebar, player
// or tab bar; this view renders its own header.topbar and sticky footer).
//   1 Welcome → 2 Device music (scan mode, folders, classifier; scan runs in the background)
//   → 3 Search, stream or download (download quality, mobile data) → 4 Optional import
//   (platform, link, match preview, import) → Done.
// The step is mirrored in the hash (#onboarding?step=3) with replaceState so a reload keeps
// it. Finishing or skipping sets ui.onboarded = "1" and goes Home. Styles: styles/views/onboarding.css.

import { api, isAndroid, KEYS, listen } from '../api.js';
import { pickFolder } from '../components/pickers.js';
import { online, playlists, pokeDownloads, setSetting, settings as settingsStore, stats as statsStore } from '../components/store.js';
import { banner, emptyState, esc, fmtDuration, fmtLongDuration, fmtNum, icon, on, plural, skeletonRows, toast } from '../ui.js';
import { PLATFORMS, detectPlatform, prettyPath } from './settings.js';

const MODES = [['selected_folders', 'Selected folders', 'folder'], ['whole_device', 'Whole device', 'device'], ['app_folder_only', 'App folder', 'storage']];
const QUALITY = [['best', 'Best available'], ['high', 'High · 320 kbps'], ['small', 'Small · 128 kbps']];

// Module state survives step re-renders (and a revisit of #onboarding in this session).
const ob = {
  scan: null,          // latest scan://progress report while/after scanning
  scanning: false,
  started: false,      // a scan was started from step 2
  imp: { platform: 'spotify', url: '', phase: 'pick', error: '', preview: null, progress: null, include: null, playlist: null, token: 0 },
};

export default {
  title: 'Set up',
  shell: 'setup',
  async render(root, params) {
    let step = Math.min(4, Math.max(1, Number(params.step) || 1));
    let disposeStep = null;
    const cleanups = [];
    let rules = null, settings = {}, last = null;

    const unlistenScan = await listen('scan://progress', (r) => {
      ob.scan = r; ob.scanning = !r.finished;
      if (r.finished) statsStore.refresh();
      paintScanStrip();
    });
    cleanups.push(() => { try { unlistenScan?.(); } catch {} });
    const unlistenImp = await listen('import://progress', (e) => { if (ob.imp.phase === 'matching') { ob.imp.progress = e; paintImportProgress(); } });
    cleanups.push(() => { try { unlistenImp?.(); } catch {} });
    api.isScanning().then((v) => { ob.scanning = !!v; }).catch(() => {});

    function go(n) {
      step = n;
      history.replaceState(null, '', `#onboarding?step=${n}`);
      draw();
      document.getElementById('main')?.scrollTo({ top: 0 });
    }
    async function finish() {
      try { await setSetting(KEYS.onboarded, '1'); } catch (e) { toast(`Couldn’t save: ${e.message || e}`, { kind: 'danger' }); return; }
      location.hash = '#home';
    }

    const topbar = (n, { done = false, skip = 'Skip setup' } = {}) => `<header class="topbar ob-topbar">
      <div class="topbar__title topbar__brand"><span class="brand-mark">${icon('play', 'icon--fill')}</span><span class="desktop-only">Tarang</span><span class="phone-only">${done ? 'All set' : 'Set up'}</span></div>
      <div class="ob-steps"><div class="dots" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i${i === n ? ' class="is-active"' : ''}></i>`).join('')}</div><span class="ob-steps__label desktop-only">${done ? 'Done' : `Step ${n} of 4`}</span><span class="ob-steps__label phone-only">${done ? 'Done' : `<span class="sr-only">Step </span>${n}/4`}</span></div>
      ${skip ? `<button class="btn btn--ghost btn--sm ob-skip" type="button" data-act="skip">${esc(skip)}</button>` : '<span></span>'}
    </header>`;
    const foot = (hint, actions) => `<div class="ob-foot"><div class="ob-foot__inner"><div class="ob-foot__hint num" id="ob-hint">${hint}</div><div class="ob-foot__actions">${actions}</div></div></div>`;
    const shell = (n, body, footer, opts) => `${topbar(n, opts)}<div class="page ob-page"><div class="ob">${body}</div></div>${footer}`;

    // ---------------------------------------------------------------- steps
    function step1() {
      root.innerHTML = shell(1, `
        <div class="hero">
          <div class="hero-fan" aria-hidden="true">
            <div class="art art--4">${icon('search')}</div><div class="art art--2">${icon('heart')}</div><div class="art art--1">${icon('play', 'icon--fill')}</div><div class="art art--3">${icon('download')}</div><div class="art art--6">${icon('offline')}</div>
          </div>
          <h1>Your music, online or off.</h1>
          <p>Search YouTube Music and stream anything. Download what you want to keep, and it plays with no connection at all.</p>
        </div>
        <ul class="values">
          <li><span class="src-mark src-mark--accent">${icon('search')}</span><div><div class="values__title">Search and stream YouTube Music</div><div class="values__text">Songs, albums and artists. Streams are cached briefly, then cleared.</div></div></li>
          <li><span class="src-mark src-mark--ok">${icon('download')}</span><div><div class="values__title">Download to play offline</div><div class="values__text">One tap keeps a song, album or playlist on this device.</div></div></li>
          <li><span class="src-mark src-mark--local">${icon('playlist')}</span><div><div class="values__title">Bring your playlists with you</div><div class="values__text">Optional last step: import from Spotify, YouTube Music or SoundCloud.</div></div></li>
        </ul>`,
      foot('4 short steps · about a minute · change anything later in Settings', `<button class="btn btn--primary btn--lg" type="button" data-act="next">Get started${icon('arrow-right')}</button>`));
    }

    function step2() {
      const mode = settings['scan.mode'] || 'selected_folders';
      const classify = settings['classifier.enabled'] !== 'false';
      const folders = (rules || []).filter((r) => r.rule === 'include' || r.rule === 'app');
      const selected = folders.filter((r) => r.enabled);
      const scanErr = ob.scan?.finished && /^Error:/.test(ob.scan.current_path || '') ? ob.scan.current_path.replace(/^Error:\s*/, '') : '';
      const permErr = scanErr && /permission|denied|EACCES/i.test(scanErr);
      const canScan = mode !== 'selected_folders' || selected.length > 0;
      const markFor = (r) => (r.rule === 'app' ? ['src-mark--local', 'download'] : /record|voice|whatsapp/i.test(r.path) ? ['src-mark--voice', 'mic'] : ['src-mark--local', 'folder']);
      const name = (r) => r.path.split('/').filter(Boolean).pop() || r.path;
      const folderRows = rules == null ? skeletonRows(3) : !folders.length
        ? `<div class="empty empty--compact"><div class="empty__icon">${icon('folder')}</div><div class="empty__title">No folders chosen yet</div><div class="empty__text">Pick the folder that holds your music, or skip — you can search and stream YouTube Music next.</div><div class="empty__actions"><button class="btn btn--primary" type="button" data-act="add-folder">${icon('folder')}Choose a folder</button><button class="btn btn--secondary" type="button" data-act="next">Skip this step</button></div></div>`
        : folders.map((r) => {
          const [mk, ic] = markFor(r);
          const voice = mk === 'src-mark--voice';
          return `<label class="frow${mode === 'app_folder_only' && r.rule !== 'app' ? ' is-disabled' : ''}">
            <span class="check"><input type="checkbox" data-rule="${r.id}" ${r.enabled ? 'checked' : ''} ${r.rule === 'app' || mode === 'whole_device' || mode === 'app_folder_only' ? 'disabled' : ''} aria-label="Include ${esc(name(r))}"></span>
            <span class="src-mark ${mk}">${icon(ic)}</span>
            <div class="frow__main"><div class="frow__title"><span>${esc(name(r))}</span>${voice ? '<span class="badge badge--voice badge--dot" title="Voice recordings"><span class="badge__label">Voice</span></span>' : ''}</div><div class="frow__path">${esc(prettyPath(r.path).full)}</div></div>
            <div class="frow__count">${r.rule === 'app' ? '<b>App folder</b><span>always scanned</span>' : mode === 'whole_device' ? '<span>Included</span>' : ''}</div>
          </label>`;
        }).join('') + (mode === 'selected_folders' ? `<button class="frow frow--add" type="button" data-act="add-folder"><span class="src-mark">${icon('plus')}</span><span class="truncate">Add another folder</span></button>` : '');
      const scanLabel = mode === 'whole_device' ? 'Scan whole device' : mode === 'app_folder_only' ? 'Scan app folder' : `Scan ${plural(selected.length, 'folder')}`;
      const where = mode === 'whole_device' ? 'the whole device' : mode === 'app_folder_only' ? 'the app folder' : plural(selected.length, 'folder');
      root.innerHTML = shell(2, `
        <div class="ob-head"><div class="eyebrow">Music already on this device</div><h1>Add songs you already have</h1><p>Pick folders to scan; they join your Library and play offline. Voice recordings are kept separate from music.</p></div>
        ${permErr ? `<div class="banner banner--danger">${icon('alert')}<div class="banner__body"><div class="banner__title">Scan can’t start — storage permission denied</div><div class="banner__text">${isAndroid ? 'Allow “All files access” for Tarang in Android settings, or scan only the app folder.' : esc(scanErr)}</div></div><div class="cluster banner__actions"><button class="btn btn--ghost btn--sm" type="button" data-mode="app_folder_only">Use app folder</button></div></div>`
          : scanErr ? banner({ kind: 'danger', icon: 'alert', title: 'The scan stopped', text: scanErr }) : ''}
        <div class="field">
          <div class="between"><span class="label">Scan</span><span class="t-13 muted">${mode === 'whole_device' ? 'Every readable folder' : mode === 'app_folder_only' ? 'Only songs downloaded in the app' : 'Only the folders below'}</span></div>
          <div class="seg seg--block" role="radiogroup" aria-label="Scan mode">${MODES.map(([v, l, ic]) => `<button type="button" class="seg__btn${v === mode ? ' is-active' : ''}" role="radio" aria-checked="${v === mode}" data-mode="${v}">${icon(ic, 'icon--16')}${l}</button>`).join('')}</div>
        </div>
        <div class="card card--flush">
          <div class="card__head card__head--flush"><div><div class="card__title">Folders</div><div class="card__sub num">${rules == null ? 'Loading folders…' : `${fmtNum(selected.length)} of ${fmtNum(folders.length)} selected`}</div></div>
            ${mode === 'selected_folders' && folders.filter((r) => r.rule !== 'app').length > 1 ? `<button class="btn btn--ghost btn--sm ob-folders-all" type="button" data-act="all">${selected.length === folders.length ? 'Select none' : 'Select all'}</button>` : ''}</div>
          <div class="frows">${folderRows}</div>
        </div>
        <div class="card ob-toggle"><div class="srow"><div class="srow__main"><div class="srow__title">Classify voice recordings</div><div class="srow__sub">Memos and lectures go to Voice recordings, not shuffle. Unsure files are queued for your review.</div></div><label class="toggle"><input type="checkbox" id="ob-classify" ${classify ? 'checked' : ''} aria-label="Classify voice recordings"><span class="toggle__track"></span></label></div></div>`,
      foot(canScan ? `${where} · scans in the background while you continue` : 'Choose a folder, or skip — you can stream without device music',
        `<button class="btn btn--ghost" type="button" data-act="next">Not now</button><button class="btn btn--primary btn--lg${canScan ? '' : ' is-off'}" type="button" data-act="scan" ${canScan ? '' : 'disabled aria-disabled="true"'}>${icon('scan')}${esc(scanLabel)}</button>`));
    }

    function step3() {
      const q = QUALITY.some(([v]) => v === settings[KEYS.downloadQuality]) ? settings[KEYS.downloadQuality] : 'best';
      const mobile = settings[KEYS.downloadMobileData] === 'true';
      root.innerHTML = shell(3, `
        <div class="ob-head"><div class="eyebrow">How it works</div><h1>Search, then stream or download</h1><p>Every song from YouTube Music can play right away or be kept on this device. You always see which is which.</p></div>
        <div id="ob-offline3"></div>
        <div class="card demo" aria-label="Example search" aria-hidden="true">
          <div class="input-wrap">${icon('search')}<input class="input input--with-icon" value="fred again" tabindex="-1" readonly></div>
          <div>
            <div class="drow2"><div class="art art--2"><span>AL</span></div><div class="drow2__main"><div class="drow2__title">Marea (we’ve lost dancing)</div><div class="drow2__sub"><span>Fred again..<span class="desktop-only">, The Blessed Madonna</span></span><span class="badge badge--stream">${icon('stream')}<span class="badge__label">Streaming</span></span></div></div>
              <div class="drow2__acts"><span class="btn btn--icon btn--sm like">${icon('heart', 'icon--16')}</span><span class="btn btn--icon btn--sm desktop-only">${icon('download', 'icon--16')}</span><span class="btn btn--icon btn--sm btn--secondary">${icon('play', 'icon--16 icon--fill')}</span></div></div>
            <div class="drow2"><div class="art art--1"><span>AL</span></div><div class="drow2__main"><div class="drow2__title">Delilah (pull me out of this)</div><div class="drow2__sub"><span>Fred again..</span><span class="badge badge--ok">${icon('check')}<span class="badge__label">Downloaded</span></span></div></div>
              <div class="drow2__acts"><span class="btn btn--icon btn--sm like is-liked">${icon('heart', 'icon--16')}</span><span class="btn btn--icon btn--sm btn--secondary">${icon('play', 'icon--16 icon--fill')}</span></div></div>
          </div>
        </div>
        <div class="legend2">
          <div><span class="src-mark src-mark--local">${icon('stream')}</span><div><div class="legend2__title">Streaming</div><div class="legend2__text">Plays over the internet. Audio is cached while it plays, then cleared.</div></div></div>
          <div><span class="src-mark src-mark--ok">${icon('download')}</span><div><div class="legend2__title">Downloaded</div><div class="legend2__text">Saved on this device. Plays with no connection. Like it to find it fast.</div></div></div>
        </div>
        <div class="field"><div class="between"><span class="label">Download quality</span><span class="t-13 muted num" id="ob-q-hint">${q === 'small' ? '≈ 3 MB per song' : q === 'high' ? '≈ 9 MB per song' : '≈ 8 MB per song'}</span></div>
          <div class="seg seg--block" role="radiogroup" aria-label="Download quality">${QUALITY.map(([v, l]) => `<button type="button" class="seg__btn${v === q ? ' is-active' : ''}" role="radio" aria-checked="${v === q}" data-quality="${v}">${l}</button>`).join('')}</div></div>
        <div class="card ob-toggle${isAndroid ? '' : ' phone-only'}"><div class="srow"><div class="srow__main"><div class="srow__title">Download over mobile data</div><div class="srow__sub">Off: downloads wait for Wi-Fi. Streaming still works on mobile data.</div></div><label class="toggle"><input type="checkbox" id="ob-mobile" ${mobile ? 'checked' : ''} aria-label="Download over mobile data"><span class="toggle__track"></span></label></div></div>
        <div id="ob-scan"></div>`,
      foot('Quality and data use can be changed in Settings', `<button class="btn btn--ghost" type="button" data-act="back">${icon('chevron-left')}Back</button><button class="btn btn--primary btn--lg" type="button" data-act="next">Next${icon('arrow-right')}</button>`));
      const paintOffline = () => { const el = root.querySelector('#ob-offline3'); if (el) el.innerHTML = online.value ? '' : banner({ kind: 'warn', icon: 'offline', title: 'You’re offline', text: `Search and streaming come back when you reconnect. Music from this device plays now${ob.scan ? ` — ${plural(ob.scan.music, 'song')} found so far` : ''}.` }); };
      paintOffline();
      return online.subscribe(paintOffline);
    }

    function step4() {
      const s = ob.imp;
      const p = PLATFORMS[s.platform];
      const offline = !online.value;
      if (s.phase === 'done') return importDone();
      if (s.phase === 'matching') {
        root.innerHTML = shell(4, `
          <div class="ob-head"><div class="eyebrow">Importing from ${esc(p.name)}</div><h1>Finding your songs</h1><p>Each song is matched on YouTube Music. Nothing downloads yet — you choose that after.</p></div>
          <div class="card card--tint progress-line" aria-live="polite" id="ob-imp-progress"></div>
          <div class="card card--flush ob-skel">${skeletonRows(4)}</div>`,
        foot('Matching reads song titles only', `<button class="btn btn--ghost" type="button" data-act="imp-cancel">Cancel</button>`), { skip: 'Cancel import' });
        root.querySelector('.ob-skip').dataset.act = 'imp-cancel';
        paintImportProgress();
        return;
      }
      if (s.phase === 'review' || s.phase === 'committing') return importReview();
      const det = detectPlatform(s.url);
      const plats = Object.values(PLATFORMS).map((x) => `<button class="card card--interactive plat${x.id === s.platform && !offline ? ' is-selected' : ''}${offline ? ' is-disabled' : ''}" role="radio" aria-checked="${x.id === s.platform}" type="button" data-plat="${x.id}" ${offline ? 'disabled' : ''}>
          <span class="src-mark ${x.mark} src-mark--lg">${icon(x.icon, 'icon--24')}</span>
          <div><div class="plat__title">${esc(x.name)}</div><div class="plat__sub">${offline ? 'Needs a connection' : esc(x.sub)}</div></div>
          <span class="plat__check" aria-hidden="true">${x.id === s.platform && !offline ? icon('check') : ''}</span></button>`).join('');
      root.innerHTML = shell(4, `
        <div class="ob-head"><div class="eyebrow">Optional</div><h1>Bring your music</h1><p>Import a playlist from another app. It arrives as a playlist in your Library, and every song can stream or be downloaded.</p></div>
        ${offline ? `<div class="banner banner--warn">${icon('offline')}<div class="banner__body"><div class="banner__title">Import needs internet</div><div class="banner__text">Songs are matched on YouTube Music. Skip for now and import later from Settings → Import from other apps.</div></div></div>` : ''}
        <div class="field"><span class="label" id="plat-label">1 · Where from?</span><div class="plats" role="radiogroup" aria-labelledby="plat-label">${plats}</div></div>
        ${offline ? '' : `<div class="field">
          <label class="label" for="ob-link">2 · Paste a ${esc(p.name)} link</label>
          <div class="pastebox${s.error ? ' is-error' : det ? ' is-detected' : ''}">
            ${det && !s.error ? `<span class="src-mark ${PLATFORMS[det].mark}">${icon(PLATFORMS[det].icon)}</span>` : icon(s.error ? 'alert' : 'link', 'pastebox__icon')}
            <input class="input" id="ob-link" type="url" inputmode="url" autocomplete="off" placeholder="${esc(p.placeholder)}" value="${esc(s.url)}" ${s.error ? 'aria-invalid="true"' : ''}>
            ${s.url ? `<button class="btn btn--icon btn--sm" type="button" data-act="imp-clear" aria-label="Clear link">${icon('x', 'icon--16')}</button>` : ''}
          </div>
          <div class="help${s.error ? ' help--error' : ''}" id="ob-link-help">${esc(s.error || p.help)}</div>
        </div>`}`,
      foot(offline ? 'Nothing is lost by skipping' : s.url.trim() ? 'Optional · later only from Settings → Import from other apps' : 'Paste a link to continue, or skip',
        offline ? `<button class="btn btn--primary btn--lg" type="button" data-act="finish">Skip &amp; finish</button>`
          : s.url.trim() ? `<button class="btn btn--ghost" type="button" data-act="finish">Skip &amp; finish</button><button class="btn btn--primary btn--lg" type="button" data-act="imp-find">${icon('search')}Find songs</button>`
            : `<button class="btn btn--ghost" type="button" data-act="back">${icon('chevron-left')}Back</button><button class="btn btn--primary btn--lg" type="button" data-act="finish">Skip &amp; finish</button>`));
      const input = root.querySelector('#ob-link');
      if (input) {
        input.addEventListener('input', () => {
          const had = !!s.url.trim();
          s.url = input.value; s.error = '';
          const d = detectPlatform(s.url);
          if (d && d !== s.platform) s.platform = d;
          if (had !== !!s.url.trim() || d) { const pos = input.selectionStart; draw(); const i2 = root.querySelector('#ob-link'); i2?.focus(); i2?.setSelectionRange(pos, pos); }
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') importFind(); });
      }
      const was = online.value;
      return online.subscribe((v) => { if (v !== was && step === 4 && ob.imp.phase === 'pick') queueMicrotask(draw); });
    }

    function importReview() {
      const s = ob.imp, items = s.preview.items;
      const by = (st) => items.map((it, i) => ({ it, i })).filter((x) => x.it.status === st);
      const matched = by('matched'), review = by('review'), missing = by('not_found');
      const count = s.include.size;
      const total = items.filter((it, i) => s.include.has(i)).reduce((a, it) => a + (it.match?.duration_secs || it.duration_secs || 0), 0);
      if (!matched.length && !review.length) {
        root.innerHTML = shell(4, `<div class="card card--flush">${emptyState({ icon: 'search', error: true, compact: true, title: `No matches for “${s.preview.name || 'this playlist'}”`, text: `0 of ${items.length} songs are on YouTube Music. No playlist was created. Try another playlist, or finish and search YouTube Music yourself.`, actions: `<button class="btn btn--primary" type="button" data-act="finish">Finish setup</button><button class="btn btn--secondary" type="button" data-act="imp-again">${icon('link')}Try another link</button>` })}</div>`, '');
        return;
      }
      const row = ({ it, i }) => {
        const st = it.status;
        const badge = st === 'matched' ? `<span class="badge badge--ok">${icon('check')}<span class="badge__label">Matched</span></span>`
          : st === 'review' ? `<span class="badge badge--warn">${icon('help')}<span class="badge__label">Review</span></span>`
            : `<span class="badge badge--danger">${icon('x')}<span class="badge__label">Not found</span></span>`;
        const sub = st === 'not_found' ? `${esc(it.artist || '')} · not on YouTube Music`
          : st === 'review' ? `Best guess: ${esc(it.match?.title || '')} · ${esc(it.match?.artist || '')} · ${fmtDuration(it.match?.duration_secs)}`
            : `${esc(it.match?.artist || it.artist || '')} · ${fmtDuration(it.match?.duration_secs ?? it.duration_secs)}`;
        const toggleBtn = st === 'review' ? `<button class="btn btn--secondary btn--sm" type="button" data-act="imp-toggle" data-i="${i}">${s.include.has(i) ? 'Leave out' : 'Use it'}</button>` : '';
        return `<div class="mrow${st === 'review' && !s.include.has(i) ? ' is-pending' : ''}">${st === 'not_found' ? `<div class="art art--empty">${icon('music', 'icon--16')}</div>` : `<div class="art art--${(i % 6) + 1}"><span>${esc((it.title.match(/\b\p{L}/gu) || ['♪']).slice(0, 2).join('').toUpperCase())}</span></div>`}
          <div class="mrow__main"><div class="mrow__title">${esc(it.title)}</div><div class="mrow__sub">${sub}</div></div><div class="mrow__end">${badge}${toggleBtn}</div></div>`;
      };
      const shown = [...review, ...missing, ...matched.slice(0, s.showAll ? Infinity : 6)];
      root.innerHTML = shell(4, `
        <div class="ob-head"><div class="eyebrow">Importing from ${esc(PLATFORMS[s.platform].name)}</div><h1>${esc(s.preview.name || 'Your playlist')}</h1><p>Review the matches, then import. Songs stream until you download them.</p></div>
        <div class="mstats">
          <div class="mstat mstat--ok"><div class="stat__num">${matched.length}</div><div class="stat__label">Matched</div></div>
          <div class="mstat mstat--warn"><div class="stat__num">${review.length}</div><div class="stat__label">Need review</div></div>
          <div class="mstat mstat--danger"><div class="stat__num">${missing.length}</div><div class="stat__label">Not found</div></div>
        </div>
        <div class="card card--flush">
          <div class="card__head card__head--flush"><div><div class="card__title">${esc(s.preview.name || 'Playlist')}</div><div class="card__sub num">${plural(items.length, 'song')} · ${matched.length} matched · ${review.length} need review · ${missing.length} not found</div></div></div>
          <div class="mrows">${shown.map(row).join('')}</div>
          ${matched.length > 6 && !s.showAll ? `<div class="more-link"><button class="btn btn--ghost btn--sm" type="button" data-act="imp-more">Show all ${matched.length} matched</button></div>` : ''}
        </div>`,
      foot(`${plural(count, 'song')} · ${fmtLongDuration(total)} · saved as a playlist`,
        `<button class="btn btn--ghost" type="button" data-act="imp-again">${icon('chevron-left')}Back</button><button class="btn btn--primary btn--lg" type="button" data-act="imp-commit" ${s.phase === 'committing' || !count ? 'disabled' : ''}>${s.phase === 'committing' ? '<span class="spinner" aria-hidden="true"></span>Importing…' : `Import ${plural(count, 'song')}`}</button>`));
    }

    function importDone() {
      const pl = ob.imp.playlist;
      const sc = ob.scan;
      root.innerHTML = shell(4, `
        <div class="done-head"><span class="done-mark">${icon('check-circle')}</span><h1>You’re all set</h1><p>${pl ? `“${esc(pl.name)}” is in your Library. Play it now — it streams — or download it to listen offline.` : 'Search YouTube Music, stream anything, and download what you want to keep.'}</p></div>
        ${pl ? `<div class="mstats">
          <div class="mstat mstat--ok"><div class="stat__num">${pl.track_count}</div><div class="stat__label">Songs imported</div></div>
          <div class="mstat mstat--warn"><div class="stat__num">${ob.imp.reviewUsed || 0}</div><div class="stat__label">Of those, best guesses</div></div>
          <div class="mstat mstat--danger"><div class="stat__num">${ob.imp.leftOut || 0}</div><div class="stat__label">Left out</div></div>
        </div>
        <div class="card card--flush">
          <div class="card__head card__head--flush"><div><div class="card__title">New playlist</div><div class="card__sub num">${plural(pl.track_count, 'song')} · ${fmtLongDuration(pl.total_secs)}</div></div>
            <button class="btn btn--secondary btn--sm" type="button" data-act="imp-download" ${ob.imp.downloading ? 'disabled' : ''}>${icon('download', 'icon--16')}${ob.imp.downloading ? 'Downloading' : 'Download all'}</button></div>
          <div class="frows"><div class="frow frow--plain frow--pl"><div class="mosaic" aria-hidden="true"><div class="art art--2"></div><div class="art art--5"></div><div class="art art--4"></div><div class="art art--6"></div></div>
            <div class="frow__main"><div class="frow__title">${esc(pl.name)}</div><div class="frow__path">${plural(pl.track_count, 'song')}${ob.imp.leftOut ? ` · ${ob.imp.leftOut} missing` : ' · all matched'}</div></div>
            <div class="frow__count"><b>${fmtLongDuration(pl.total_secs)}</b><span>${ob.imp.downloading ? 'Downloading' : 'Streams'}</span></div></div></div>
        </div>` : ''}
        ${sc ? `<div class="perm-row perm-row--wrap">${icon(sc.finished ? 'check-circle' : 'scan', 'icon--16')}<span class="perm-row__text num">${sc.finished ? `This device: ${plural(sc.music, 'song')} and ${plural(sc.voice, 'voice recording')} found` : `Still scanning this device — ${plural(sc.music, 'song')} so far`}</span></div>` : ''}`,
      foot('Import more any time from Settings → Import from other apps', `<button class="btn btn--primary btn--lg" type="button" data-act="finish">Start listening${icon('arrow-right')}</button>`), { done: true, skip: '' });
    }

    function paintImportProgress() {
      const el = root.querySelector('#ob-imp-progress');
      if (!el) return;
      const pr = ob.imp.progress;
      const p = pr && pr.total ? Math.round((pr.done / pr.total) * 100) : null;
      el.innerHTML = p == null
        ? `<div class="progress-line__meta"><span><strong>Reading the ${esc(PLATFORMS[ob.imp.platform].name)} link…</strong></span><span>finding songs</span></div><div class="progress progress--thick progress--indeterminate"><i></i></div>`
        : `<div class="progress-line__meta"><span><strong>Matching ${esc(ob.imp.previewName || 'songs')}</strong></span><span><strong>${fmtNum(pr.done)} of ${fmtNum(pr.total)}</strong> · ${p}%</span></div><div class="progress progress--thick" style="--p:${p}%"><i></i></div><div class="progress-line__meta"><span>Matched on YouTube Music by title, artist and length</span></div>`;
      const hint = root.querySelector('#ob-hint');
      if (hint && p != null) hint.textContent = `Matching ${fmtNum(pr.done)} of ${fmtNum(pr.total)}`;
    }

    function paintScanStrip() {
      const el = root.querySelector('#ob-scan');
      if (!el) return;
      const r = ob.scan;
      if (!r || (!ob.started && !ob.scanning)) { el.innerHTML = ''; return; }
      const est = last?.[1]?.files_seen || 0;
      const p = r.finished ? 100 : est ? Math.min(99, Math.round((r.files_seen / est) * 100)) : null;
      el.innerHTML = `<div class="card card--tint scan-strip">${r.finished ? icon('check-circle') : '<span class="spinner" aria-hidden="true"></span>'}
        <div class="progress-line">
          <div class="progress-line__meta"><span><strong>${r.finished ? 'This device is scanned' : 'Scanning this device'}</strong></span><span>${p != null ? `<strong>${p}%</strong>` : ''}</span></div>
          <div class="progress${p == null ? ' progress--indeterminate' : ''}" style="--p:${p ?? 0}%"><i></i></div>
          <div class="progress-line__meta"><span class="num">${fmtNum(r.files_seen)} files · ${plural(r.music, 'song')} · ${fmtNum(r.voice)} voice</span></div>
        </div></div>`;
    }

    // ---------------------------------------------------------------- import actions
    async function importFind() {
      const s = ob.imp;
      const url = (root.querySelector('#ob-link')?.value ?? s.url).trim();
      if (!url || !online.value) return;
      s.url = url;
      s.platform = detectPlatform(url) || s.platform;
      s.phase = 'matching'; s.progress = null; s.error = '';
      const token = ++s.token;
      draw();
      try {
        const pv = await api.importPreview(s.platform, url);
        if (token !== s.token) return;
        s.preview = pv; s.previewName = pv.name; s.showAll = false;
        s.include = new Set(pv.items.map((it, i) => (it.status !== 'not_found' && it.match ? i : -1)).filter((i) => i >= 0));
        s.phase = 'review';
      } catch (e) {
        if (token !== s.token) return;
        s.phase = 'pick'; s.error = e.message || String(e);
      }
      if (step === 4) draw();
    }
    async function importCommit() {
      const s = ob.imp;
      s.phase = 'committing'; draw();
      try {
        const include = [...s.include].sort((a, b) => a - b);
        s.playlist = await api.importCommit(s.preview.preview_id, s.preview.name || `${PLATFORMS[s.platform].name} import`, include);
        s.leftOut = s.preview.items.length - include.length;
        s.reviewUsed = include.filter((i) => s.preview.items[i].status === 'review').length;
        playlists.refresh(); statsStore.refresh();
        dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'import' } }));
        s.phase = 'done';
      } catch (e) {
        s.phase = 'review';
        toast(`Couldn’t import: ${e.message || e}`, { kind: 'danger' });
      }
      draw();
    }

    // ---------------------------------------------------------------- data + events
    async function loadDeviceData() {
      const [r, s, l] = await Promise.all([api.rules().catch(() => []), settingsStore.refresh(), api.lastScan().catch(() => null)]);
      rules = r; settings = { ...(s || {}) }; last = l;
    }
    const saveSetting = async (k, v) => { settings[k] = String(v); try { await setSetting(k, v); } catch (e) { toast(`Couldn’t save: ${e.message || e}`, { kind: 'danger' }); } };

    cleanups.push(on(root, 'click', '[data-act]', async (e, b) => {
      switch (b.dataset.act) {
        case 'skip': case 'finish': finish(); break;
        case 'next': go(Math.min(4, step + 1)); break;
        case 'back': go(Math.max(1, step - 1)); break;
        case 'add-folder': {
          const path = await pickFolder({ title: 'Add a music folder', confirm: 'Add folder' });
          if (path) { try { rules = await api.addRule(path, 'include'); } catch (err) { toast(`Couldn’t add the folder: ${err.message || err}`, { kind: 'danger' }); } draw(); }
          break;
        }
        case 'all': {
          const list = rules.filter((r) => r.rule === 'include');
          const target = !list.every((r) => r.enabled);
          await Promise.all(list.map((r) => api.setRuleEnabled(r.id, target).then(() => { r.enabled = target; }).catch(() => {})));
          draw(); break;
        }
        case 'scan':
          try { await api.startScan(); ob.started = true; ob.scanning = true; ob.scan = { files_seen: 0, music: 0, voice: 0, finished: false }; go(3); }
          catch (err) { toast(`Couldn’t start the scan: ${err.message || err}`, { kind: 'danger' }); }
          break;
        case 'imp-find': importFind(); break;
        case 'imp-clear': ob.imp.url = ''; ob.imp.error = ''; draw(); root.querySelector('#ob-link')?.focus(); break;
        case 'imp-cancel': ob.imp.token++; ob.imp.phase = 'pick'; draw(); break;
        case 'imp-again': Object.assign(ob.imp, { phase: 'pick', preview: null, error: '' }); draw(); break;
        case 'imp-more': ob.imp.showAll = true; draw(); break;
        case 'imp-toggle': { const i = Number(b.dataset.i); if (ob.imp.include.has(i)) ob.imp.include.delete(i); else ob.imp.include.add(i); draw(); break; }
        case 'imp-commit': importCommit(); break;
        case 'imp-download':
          b.disabled = true;
          try { const ids = await api.downloadPlaylist(ob.imp.playlist.id); ob.imp.downloading = true; pokeDownloads(); toast(`Downloading ${plural(ids.length, 'song')}`, { kind: 'info' }); }
          catch (err) { toast(`Couldn’t start downloads: ${err.message || err}`, { kind: 'danger' }); }
          draw(); break;
      }
    }));
    cleanups.push(on(root, 'click', '[data-mode]', async (e, b) => { await saveSetting('scan.mode', b.dataset.mode); draw(); }));
    cleanups.push(on(root, 'click', '[data-plat]', (e, b) => { ob.imp.platform = b.dataset.plat; ob.imp.error = ''; draw(); }));
    cleanups.push(on(root, 'click', '[data-quality]', (e, b) => {
      root.querySelectorAll('[data-quality]').forEach((x) => { const onIt = x === b; x.classList.toggle('is-active', onIt); x.setAttribute('aria-checked', String(onIt)); });
      const q = b.dataset.quality;
      root.querySelector('#ob-q-hint').textContent = q === 'small' ? '≈ 3 MB per song' : q === 'high' ? '≈ 9 MB per song' : '≈ 8 MB per song';
      saveSetting(KEYS.downloadQuality, q);
    }));
    cleanups.push(on(root, 'change', '[data-rule]', async (e, c) => {
      const r = rules.find((x) => String(x.id) === c.dataset.rule);
      try { await api.setRuleEnabled(r.id, c.checked); r.enabled = c.checked; } catch (err) { toast(`Couldn’t update the folder: ${err.message || err}`, { kind: 'danger' }); }
      draw();
    }));
    cleanups.push(on(root, 'change', '#ob-classify', (e, c) => saveSetting('classifier.enabled', c.checked ? 'true' : 'false')));
    cleanups.push(on(root, 'change', '#ob-mobile', (e, c) => saveSetting(KEYS.downloadMobileData, c.checked ? 'true' : 'false')));

    function draw() {
      if (typeof disposeStep === 'function') { try { disposeStep(); } catch {} }
      disposeStep = null;
      if (step === 1) step1();
      else if (step === 2) disposeStep = step2();
      else if (step === 3) { disposeStep = step3(); paintScanStrip(); }
      else disposeStep = step4();
    }

    if (step > 1) root.innerHTML = `${topbar(step)}<div class="page ob-page"><div class="ob"><div class="card card--flush ob-skel">${skeletonRows(4)}</div></div></div>`;
    await loadDeviceData();
    // #onboarding?step=4&link=<url> pre-fills the import link and starts matching (review screenshots, deep links).
    const autoFind = step === 4 && params.link && ob.imp.phase === 'pick';
    if (autoFind) ob.imp.url = params.link;
    draw();
    if (autoFind) importFind();
    return () => { if (typeof disposeStep === 'function') disposeStep(); cleanups.forEach((fn) => { try { fn?.(); } catch {} }); };
  },
};
