// Now Playing — full player + queue (design/screens/now-playing.html).
// Desktop: hero (artwork, transport, title, actions, sleep timer, volume, file facts) +
// sticky queue panel. Phone: the mini player expanded into a full sheet (art, title row,
// scrubber, transport, utilities, "Up next" peek → queue bottom sheet). Voice recordings
// get the voice variant (waveform scrubber, ±15 s, speed). Styles: styles/now-playing.css.

import { openPlaylistPicker, openTrackMenu, download as downloadItem } from '../components/actions.js';
import { artHTML } from '../components/art.js';
import { openMenu, openSheet } from '../components/overlay.js';
import { bindSlider, isDragging, openSleepMenu, paintScrubber, showBuffering, sleepLabel, sleepShort } from '../components/player-ui.js';
import { downloadFor, downloads, online } from '../components/store.js';
import { toast } from '../components/toast.js';
import { createPlaylistDialog } from '../components/actions.js';
import { currentOutputLabel, onOutputs, outputSnapshot, outputs, setOutputDevice } from '../components/output.js';
import { api, isAndroid } from '../api.js';
import { needsStream, player } from '../player.js';
import { canGoBack, lastPageHref } from '../router.js';
import { banner, emptyState, esc, fmtBytes, fmtDuration, fmtLongDuration, hashStr, icon, plural, ring, waveform } from '../ui.js';

const VOICE_SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const SLEEP_SEG = [['Off', null], ['15', 15], ['30', 30], ['45', 45], ['60 min', 60], ['End of song', 'end']];
const QUEUE_PREVIEW = 8;

const isVoice = (it) => it && (it.kind === 'voice' || it.kind === 'unsure');
const playGlyph = (s) => (s.playing || showBuffering(s) ? 'pause' : 'play');

function srcGlyph(it, size = 'icon--16') {
  if (!it || isVoice(it)) return '';
  return it.path
    ? `<svg class="icon ${size} np-src-ic np-src-ic--dl" role="img" aria-label="Downloaded"><use href="#i-check"/></svg>`
    : `<svg class="icon ${size} np-src-ic np-src-ic--st" role="img" aria-label="Streams — needs internet"><use href="#i-stream"/></svg>`;
}
function srcBadge(it, extra = '') {
  if (!it || isVoice(it)) return '';
  if (it.path) return `<span class="badge badge--ok np-src ${extra}">${icon('check')}${it.source === 'local' ? 'On this device' : 'Downloaded'}</span>`;
  return `<span class="badge np-src np-src--st ${extra}">${icon('stream')}Streaming</span>`;
}
function contextHref(c) {
  if (!c) return null;
  if (c.type === 'playlist' && c.id != null) return `#playlist/${c.id}`;
  if (c.type === 'liked') return '#playlist/0';
  if (c.type === 'search') return c.query ? `#search?q=${encodeURIComponent(c.query)}` : '#search';
  if (c.type === 'downloads') return '#downloads';
  if (c.type === 'voice') return '#voice';
  if (c.type === 'library') return '#library';
  return null;
}
const contextLabel = (c) => ({ playlist: 'Playing from playlist', liked: 'Playing from', album: 'Playing from album', artist: 'Playing from artist', search: 'Playing from search', downloads: 'Playing from', voice: 'Playing from', library: 'Playing from' }[c?.type] || 'Playing');

export default {
  title: 'Now playing',
  render(root) {
    let mode = null;
    let showAll = false;
    let sheet = null;          // open queue sheet { el, close, render }
    const memo = new WeakMap();
    const unsubs = [];
    const q = (k) => root.querySelector(`[data-np="${k}"]`);
    const put = (el, html) => { if (el && memo.get(el) !== html) { memo.set(el, html); el.innerHTML = html; } };

    // ------------------------------------------------------------ skeletons
    const sheetHead = `<header class="np-sheethead">
        <button class="btn btn--icon" type="button" data-a="collapse" aria-label="Collapse to mini player">${icon('chevron-down', 'icon--24')}</button>
        <div class="np-context" data-np="ctx"></div>
        <button class="btn btn--icon" type="button" data-a="more" aria-haspopup="menu" aria-label="More options">${icon('more')}</button>
      </header>`;
    const scrubber = (k, cls) => `<div class="scrubber ${cls} np-scrub" data-np="${k}"><div class="scrubber__track" role="slider" tabindex="0" aria-label="Seek"><i class="scrubber__buffer"></i><i class="scrubber__fill"></i><i class="scrubber__thumb"></i></div><div class="scrubber__times"><span>0:00</span><span>--:--</span></div></div>`;
    const queuePanel = `<aside class="card card--flush np-queue" aria-label="Queue" data-np="queue"></aside>`;

    function build(newMode) {
      mode = newMode;
      if (mode === 'empty') {
        root.innerHTML = `${sheetHead}<div class="page np-page"><div class="np-grid">
          <div class="card card--flush" data-np="empty"></div>${queuePanel}</div></div>`;
      } else if (mode === 'voice') {
        root.innerHTML = `${sheetHead}<div class="page np-page"><div class="np-banners" data-np="banners"></div><div class="np-grid">
          <div class="np-voice-wrap"><section class="np-voice" aria-label="Now playing">
            <div data-np="v-art"></div>
            <div class="np-voice__ctrl">
              <div data-np="v-head"></div>
              <div class="wave-wrap" data-np="wave" role="slider" tabindex="0" aria-label="Seek"></div>
              <div class="scrubber__times np-voice__times" data-np="v-times"><span>0:00</span><span></span></div>
              <div class="np-transport" data-np="v-transport"></div>
              <div class="np-voice__speed" data-np="v-speed"></div>
            </div>
          </section><div class="phone-only" data-np="p-peek"></div></div>
          ${queuePanel}</div></div>`;
      } else {
        root.innerHTML = `${sheetHead}<div class="page np-page"><div class="np-banners" data-np="banners"></div><div class="np-grid">
          <section class="np-hero" aria-label="Now playing">
            <div class="np-stage">
              <div class="np-art" data-np="art"></div>
              <div class="np-deck" role="group" aria-label="Playback">${scrubber('scrub', '')}<div class="np-deck__row" data-np="deck"></div></div>
            </div>
            <div class="np-info">
              <div class="np-info__head" data-np="head"></div>
              <div class="np-actions" data-np="actions"></div>
              <div class="np-cards">
                <div class="card" data-np="sleep"></div>
                <div class="card"><div class="np-card__head"><div class="card__title">${icon('speaker', 'icon--16 np-ic-inline')}Output</div><span class="t-13 muted num" data-np="vol-value"></span></div>
                  <div class="np-out"><select class="select" data-np="out-sel" aria-label="Output device"></select><div class="volume" data-np="volume"><svg class="icon muted" aria-hidden="true"><use href="#i-volume"/></svg><div class="volume__track" role="slider" tabindex="0" aria-label="Volume"><i class="volume__fill"></i><i class="volume__thumb"></i></div></div></div></div>
                <div class="card card--tint" data-np="facts"></div>
              </div>
            </div>
          </section>
          ${queuePanel}
          <section class="np-phone" aria-label="Now playing">
            <div data-np="p-art"></div>
            <div class="np-titlerow" data-np="p-title"></div>
            ${scrubber('p-scrub', 'scrubber--lg')}
            <div class="np-transport" data-np="p-transport"></div>
            <div class="np-util" data-np="p-util"></div>
            <div data-np="p-peek"></div>
          </section>
        </div></div>`;
      }
      // Sliders
      for (const k of ['scrub', 'p-scrub']) {
        const el = q(k);
        if (el) bindSlider(el.querySelector('.scrubber__track'), { container: el, onChange: (f, final) => { if (final) player.seekFraction(f); }, getValue: () => frac(), step: 0.02 });
      }
      const vol = q('volume');
      if (vol) bindSlider(vol.querySelector('.volume__track'), { container: vol, onChange: (f) => player.setVolume(f), getValue: () => player.state.volume, step: 0.05 });
      const wave = q('wave');
      if (wave) bindSlider(wave, { container: wave, onChange: (f, final) => { paintWave(f); if (final) player.seekFraction(f); }, getValue: () => frac(), step: 0.01 });
    }
    const frac = () => { const s = player.state; return s.duration ? s.position / s.duration : 0; };

    // ------------------------------------------------------------ pieces
    function ctxHTML(s) {
      const c = s.context;
      if (!c?.name) return `<span class="np-context__label">Now playing</span><span class="np-context__name">${esc(isVoice(s.current) ? 'Voice recording' : 'Your queue')}</span>`;
      return `<span class="np-context__label">${esc(contextLabel(c))}</span><span class="np-context__name">${esc(c.name)}</span>`;
    }

    function headHTML(s) {
      const it = s.current, c = s.context;
      const ch = contextHref(c);
      const crumb = c?.name ? `<nav class="crumb desktop-only" aria-label="Breadcrumb">${ch ? `<a href="${ch}">${esc(c.name)}</a>` : `<span>${esc(c.name)}</span>`}${icon('chevron-right')}<span>Now playing</span></nav>` : '';
      const pos = `Song · ${s.index + 1} of ${s.queue.length}${c?.name ? ` in ${esc(c.name)}` : ''}`;
      const year = it.year ? `<span class="sep"></span><span class="num">${esc(it.year)}</span>` : '';
      const sub = [
        it.artist ? `<a href="#search?q=${encodeURIComponent(it.artist)}">${esc(it.artist)}</a>` : '<span>Unknown artist</span>',
        it.album ? `<span class="sep"></span><a href="#search?q=${encodeURIComponent(`${it.album} ${it.artist || ''}`.trim())}">${esc(it.album)}</a>` : '',
        year,
        `<span class="sep"></span><span class="num">${fmtDuration(s.duration || it.duration_secs)}</span>`,
      ].join('');
      return `${crumb}<div class="np-eyerow"><span class="eyebrow">${pos}</span>${srcBadge(it)}</div><h1 class="np-title">${esc(it.title)}</h1><div class="np-sub">${sub}</div>`;
    }

    function dlState(it) {
      if (it.path) return { kind: 'done' };
      if (!it.video_id) return { kind: 'none' };
      const d = downloadFor(it);
      if (d && (d.state === 'active' || d.state === 'queued')) return { kind: 'busy', p: d.progress || 0, queued: d.state === 'queued' };
      if (d && d.state === 'error') return { kind: 'error', d };
      return { kind: 'idle' };
    }

    function actionsHTML(s) {
      const it = s.current;
      const d = dlState(it);
      const like = `<button class="btn btn--secondary like${it.liked ? ' is-liked' : ''}" type="button" data-a="like" aria-pressed="${!!it.liked}">${icon('heart')}${it.liked ? 'Liked' : 'Like'}</button>`;
      let dl = '';
      if (d.kind === 'done') dl = `<button class="btn btn--secondary np-dl is-done" type="button" data-a="dl-done" aria-label="${it.source === 'local' ? 'On this device' : 'Downloaded — plays offline'}">${icon('check-circle')}${it.source === 'local' ? 'On this device' : 'Downloaded'}</button>`;
      else if (d.kind === 'busy') dl = `<button class="btn btn--secondary np-dl is-busy" type="button" data-a="downloads" style="--p:${Math.round(d.p * 100)}%" aria-label="Downloading, ${Math.round(d.p * 100)} percent — open Downloads"><span class="spinner"></span><span class="num">${d.queued ? 'Queued' : `Downloading ${Math.round(d.p * 100)}%`}</span></button>`;
      else if (d.kind === 'idle' || d.kind === 'error') dl = `<button class="btn btn--secondary np-dl" type="button" data-a="download"${online.value ? '' : ' disabled title="Needs internet"'}>${icon(d.kind === 'error' ? 'refresh' : 'download')}${d.kind === 'error' ? 'Retry download' : 'Download'}</button>`;
      return `${like}${dl}<button class="btn btn--secondary np-addpl" type="button" data-a="addpl">${icon('plus')}Add to playlist</button><button class="btn btn--icon" type="button" data-a="more" aria-haspopup="menu" aria-label="More: go to album, go to artist">${icon('more')}</button>`;
    }

    function transportHTML(s, { size = 'deck' } = {}) {
      const buffering = showBuffering(s);
      const repeatIcon = s.repeat === 'one' ? 'repeat-one' : 'repeat';
      const repeatLabel = `Repeat ${s.repeat === 'off' ? 'off' : s.repeat === 'one' ? 'this song' : 'all'}`;
      const playBtn = (cls, ic) => `<button class="btn btn--play ${cls} np-play--accent${buffering ? ' np-play--buffer' : ''}" type="button" data-a="play" aria-label="${buffering ? 'Buffering — pause' : s.playing ? 'Pause (Space)' : 'Play (Space)'}">${icon(playGlyph(s), `${ic} icon--fill`)}</button>`;
      if (size === 'deck') {
        return `<button class="btn btn--icon np-mode${s.shuffle ? ' is-on' : ''}" type="button" data-a="shuffle" aria-pressed="${s.shuffle}" aria-label="Shuffle ${s.shuffle ? 'on' : 'off'} (S)">${icon('shuffle')}</button>
          <button class="btn btn--icon np-skipbtn" type="button" data-a="prev" aria-label="Previous">${icon('skip-prev', 'np-skip-ic')}</button>
          ${playBtn('', 'icon--24')}
          <button class="btn btn--icon np-skipbtn" type="button" data-a="next" aria-label="Next">${icon('skip-next', 'np-skip-ic')}</button>
          <button class="btn btn--icon np-mode${s.repeat !== 'off' ? ' is-on' : ''}" type="button" data-a="repeat" aria-pressed="${s.repeat !== 'off'}" aria-label="${repeatLabel} (R)">${icon(repeatIcon)}</button>`;
      }
      if (size === 'voice') {
        return `<button class="btn btn--icon np-skip" type="button" data-a="back15" aria-label="Back 15 seconds">${icon('back', 'icon--24')}<b>15</b></button>
          <button class="btn btn--icon btn--lg np-skipbtn" type="button" data-a="prev" aria-label="Previous recording">${icon('skip-prev', 'np-skip-ic')}</button>
          ${playBtn('btn--lg', 'icon--28')}
          <button class="btn btn--icon btn--lg np-skipbtn" type="button" data-a="next" aria-label="Next recording">${icon('skip-next', 'np-skip-ic')}</button>
          <button class="btn btn--icon np-skip" type="button" data-a="fwd15" aria-label="Forward 15 seconds">${icon('fwd', 'icon--24')}<b>15</b></button>`;
      }
      return `<button class="btn btn--icon${s.shuffle ? ' is-on' : ''}" type="button" data-a="shuffle" aria-pressed="${s.shuffle}" aria-label="Shuffle ${s.shuffle ? 'on' : 'off'}">${icon('shuffle')}</button>
        <button class="btn btn--icon btn--lg np-skipbtn" type="button" data-a="prev" aria-label="Previous">${icon('skip-prev', 'np-skip-ic')}</button>
        ${playBtn('btn--lg', 'icon--28')}
        <button class="btn btn--icon btn--lg np-skipbtn" type="button" data-a="next" aria-label="Next">${icon('skip-next', 'np-skip-ic')}</button>
        <button class="btn btn--icon${s.repeat !== 'off' ? ' is-on' : ''}" type="button" data-a="repeat" aria-pressed="${s.repeat !== 'off'}" aria-label="${repeatLabel}">${icon(repeatIcon)}</button>`;
    }

    function sleepHTML(s) {
      const val = s.sleep ? sleepLabel(player) : 'Off';
      const active = (v) => (v === null ? !s.sleep : v === 'end' ? s.sleep?.mode === 'end' : s.sleep?.mode === 'min' && s.sleep.minutes === v);
      return `<div class="np-card__head"><div class="card__title">${icon('moon', 'icon--16 np-ic-inline')}Sleep timer</div><span class="np-card__value">${esc(val)}</span></div>
        <div class="seg seg--block" role="group" aria-label="Sleep timer, minutes">${SLEEP_SEG.map(([l, v]) => `<button class="seg__btn${active(v) ? ' is-active' : ''}" type="button" data-a="sleep-set" data-v="${v ?? 'off'}" aria-pressed="${active(v)}"${typeof v === 'number' ? ` aria-label="${v} minutes"` : ''}>${l}</button>`).join('')}</div>`;
    }

    function factsHTML(s) {
      const it = s.current;
      const rows = [];
      if (it.path) rows.push(['Status', `${icon('check', 'icon--16 np-ic-inline np-src-ic--dl')}${it.source === 'local' ? 'On this device · plays offline' : 'Downloaded · plays offline'}`]);
      else rows.push(['Status', `${icon('stream', 'icon--16 np-ic-inline np-src-ic--st')}Streaming from YouTube Music · cleared after play`]);
      const file = [it.format?.toUpperCase(), it.bitrate_kbps ? `${it.bitrate_kbps} kbps` : null, it.size_bytes ? fmtBytes(it.size_bytes) : null].filter(Boolean).join(' · ');
      if (it.path && file) rows.push(['File', esc(file)]);
      if (it.path) rows.push(['Location', `<span title="${esc(it.path)}">${esc(it.path.replace(/^\/home\/[^/]+\//, '~/'))}</span>`]);
      const d = dlState(it);
      if (d.kind === 'busy') rows.push(['Keep it', `Downloading · ${Math.round(d.p * 100)}%`]);
      const added = it.added_at ? new Date(it.added_at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      const when = added ? `&nbsp; ${it.path && it.video_id ? 'downloaded' : 'added'} ${esc(added)}` : '';
      rows.push(['From', `${it.source === 'youtube' || it.video_id ? `<span class="badge badge--ytm badge--dot"><span class="badge__label">YouTube Music</span></span>` : `<span class="badge badge--local badge--dot"><span class="badge__label">This device</span></span>`}${when}`]);
      return `<dl class="np-facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    }

    function bannersHTML(s) {
      const out = [];
      const streams = s.upNext.all.filter((e) => needsStream(e.item)).length;
      if (!online.value) out.push(banner({ kind: 'info', icon: 'offline', title: 'You’re offline — playing downloads only', text: `${streams ? `${plural(streams, 'streaming song')} in the queue will be skipped until you reconnect. ` : ''}Liking and adding to playlists still work.` }));
      if (s.error && s.current) {
        const at = s.position > 1 ? `Stopped at ${fmtDuration(s.position)} — ` : '';
        const hasNext = s.upNext.all.length > 0;
        out.push(`<div class="banner banner--danger">${icon('alert')}<div class="banner__body"><div class="banner__title">${esc(at)}“${esc(s.current.title)}” couldn’t play</div><div class="banner__text">${esc(s.error)}</div></div><div class="np-errbtns"><button class="btn btn--secondary btn--sm" type="button" data-a="retry">${icon('refresh', 'icon--16')}Try again</button>${hasNext ? `<button class="btn btn--primary btn--sm" type="button" data-a="next">${icon('skip-next', 'icon--16')}Skip to next</button>` : ''}</div></div>`);
      }
      return out.join('');
    }

    function phoneTitleHTML(s) {
      const it = s.current;
      const d = dlState(it);
      let dl = '';
      if (d.kind === 'done') dl = `<button class="btn btn--icon np-dl-ic is-done" type="button" data-a="dl-done" aria-label="Downloaded">${icon('check-circle', 'icon--24')}</button>`;
      else if (d.kind === 'busy') dl = `<button class="btn btn--icon np-dl-ic is-busy" type="button" data-a="downloads" aria-label="Downloading, ${Math.round(d.p * 100)} percent">${ring(d.p)}</button>`;
      else if (d.kind !== 'none') dl = `<button class="btn btn--icon np-dl-ic" type="button" data-a="download" aria-label="Download"${online.value ? '' : ' disabled'}>${icon('download', 'icon--24')}</button>`;
      return `<div class="grow"><div class="np-titlerow__title truncate">${esc(it.title)}</div><div class="np-titlerow__sub truncate">${esc([it.artist, it.album].filter(Boolean).join(' · ') || 'Unknown artist')}</div>${srcBadge(it, 'np-mt-2')}</div>
        ${dl}<button class="btn btn--icon like${it.liked ? ' is-liked' : ''}" type="button" data-a="like" aria-pressed="${!!it.liked}" aria-label="${it.liked ? 'Liked' : 'Like'}">${icon('heart', 'icon--24')}</button>`;
    }

    function utilHTML(s) {
      return `<button class="np-util__btn${s.sleep ? ' is-on' : ''}" type="button" data-a="sleep-open" aria-label="Sleep timer${s.sleep ? `: ${esc(sleepShort(player))}` : ': off'}">${icon('moon')}<span class="num">${s.sleep ? `Sleep · ${esc(sleepShort(player))}` : 'Sleep timer'}</span></button>
        <button class="np-util__btn" type="button" data-a="output-open" aria-haspopup="menu" aria-label="Output: ${esc(currentOutputLabel())}, change">${icon('speaker')}<span><span class="truncate">${esc(currentOutputLabel())}</span>${icon('chevron-down', 'icon--16 np-util__chev')}</span></button>
        <button class="np-util__btn" type="button" data-a="addpl" aria-label="Add ${esc(s.current.title)} to a playlist">${icon('plus')}<span>Add to playlist</span></button>`;
    }

    function peekHTML(s) {
      const nxt = s.upNext.all[0]?.item;
      if (!nxt) return `<button class="np-peek" type="button" data-a="queue-open" aria-label="Open queue: nothing up next"><span class="eyebrow">Up next</span><span></span><span class="np-peek__main"><span class="t-13 muted">Nothing queued — playback stops after this</span></span><span></span>${icon('queue', 'muted')}</button>`;
      const more = s.upNext.all.length - 1;
      return `<button class="np-peek" type="button" data-a="queue-open" aria-label="Open queue: ${s.upNext.all.length} up next"><span class="eyebrow">Up next</span>${artHTML(nxt)}<span class="np-peek__main"><span class="strong truncate">${esc(nxt.title)}</span><span class="t-13 muted truncate">${esc(nxt.artist || '')}</span></span><span class="np-peek__count" aria-label="then ${more} more">${more > 0 ? `+${more}` : ''}</span>${icon('queue', 'muted')}</button>`;
    }

    // ---- queue (desktop panel + phone sheet share the row markup)
    function qRow(e, { playing = false, phone = false } = {}) {
      const it = e.item;
      const offline = !online.value && needsStream(it);
      if (phone) {
        return `<div class="row row--result${playing ? ' is-playing' : ''}${offline ? ' is-disabled' : ''}" data-uid="${e.uid}">${artHTML(it)}<div class="row__main"><div class="row__title">${esc(it.title)}</div><div class="row__sub np-minisub">${srcGlyph(it)}<span class="truncate">${esc(it.artist || '')}</span></div></div>${offline ? '<span class="np-off-tag">Needs internet</span>' : `<div class="row__dur">${fmtDuration(it.duration_secs)}</div>`}${playing ? '<div></div>' : `<div class="row__actions"><button class="btn btn--icon" type="button" data-a="q-remove" aria-label="Remove ${esc(it.title)} from queue">${icon('x')}</button><button class="btn btn--icon q-grip" type="button" data-grip aria-label="Drag to reorder">${icon('grip')}</button></div>`}</div>`;
      }
      return `<div class="row row--result q-row${playing ? ' is-playing' : ''}${offline ? ' is-disabled' : ''}" data-uid="${e.uid}">
        <span class="q-grip"${playing ? '' : ' data-grip aria-label="Drag to reorder"'}>${playing ? '<span class="eq"><i></i><i></i><i></i></span>' : icon('grip', 'icon--16')}</span>
        ${artHTML(it)}
        <div class="row__main"><div class="row__title">${esc(it.title)}</div><div class="row__sub">${srcGlyph(it)}<span>${esc(it.artist || (isVoice(it) ? 'Voice recording' : ''))}</span></div></div>
        ${offline ? '<span class="np-off-tag">Needs internet</span><span></span>' : `<div class="row__dur">${fmtDuration(it.duration_secs)}</div><div class="q-act">${playing
          ? `<button class="btn btn--icon btn--sm" type="button" data-a="q-menu" aria-label="More for ${esc(it.title)}">${icon('more', 'icon--16')}</button>`
          : `<button class="btn btn--icon btn--sm" type="button" data-a="q-remove" aria-label="Remove ${esc(it.title)} from queue">${icon('x', 'icon--16')}</button>`}</div>`}
      </div>`;
    }

    function queueSummary(s) {
      const all = s.upNext.all;
      const left = all.reduce((t, e) => t + (e.item.duration_secs || 0), 0) + Math.max(0, (s.duration || 0) - s.position);
      const dl = all.filter((e) => e.item.path).length;
      return { n: all.length, left, dl, st: all.length - dl };
    }

    function queueBody(s, { phone = false } = {}) {
      const { added, rest } = s.upNext;
      const ctxName = s.context?.name;
      let html = '';
      if (!phone) html += `<div class="group-head">Now playing</div>${qRow(s.queue[s.index], { playing: true })}`;
      if (added.length) html += `<div class="group-head">Added by you<span class="group-head__count">${added.length}</span><button class="btn btn--ghost btn--sm" type="button" data-a="clear-added" aria-label="Clear the ${added.length} songs added by you">Clear added</button></div>${added.map((e) => qRow(e, { phone })).join('')}`;
      if (rest.length) {
        const shown = phone || showAll ? rest : rest.slice(0, QUEUE_PREVIEW);
        html += `<div class="group-head">${ctxName ? `Next from ${esc(ctxName)}` : 'Next up'}<span class="group-head__count">${rest.length}</span></div>${shown.map((e) => qRow(e, { phone })).join('')}`;
        if (!phone && rest.length > shown.length) {
          const hidden = rest.slice(shown.length);
          html += `<div class="np-queue__foot"><span>${hidden.length} more · ${fmtLongDuration(hidden.reduce((t, e) => t + (e.item.duration_secs || 0), 0))}</span><button class="btn btn--ghost btn--sm" type="button" data-a="show-all">Show all</button></div>`;
        }
      }
      if (!added.length && !rest.length) {
        const end = s.context?.name ? `End of ${s.context.name}` : 'Nothing up next';
        html += emptyState({ icon: 'queue', compact: true, title: end, text: `Playback stops after “${s.current.title}”. Add songs, or repeat${s.context?.name ? ' the playlist' : ''}.`,
          actions: `<a class="btn btn--secondary btn--sm" href="#search">${icon('plus', 'icon--16')}Add songs</a>${s.queue.length > 1 ? `<button class="btn btn--ghost btn--sm" type="button" data-a="repeat-all">${icon('repeat', 'icon--16')}Repeat ${s.context?.name ? 'playlist' : 'queue'}</button>` : ''}` });
      }
      return html;
    }

    function queueHTML(s) {
      if (!s.current) {
        return `<div class="np-queue__head"><div><h3>Queue</h3><div class="t-13 muted num np-mt-1">0 up next</div></div></div>${emptyState({ icon: 'queue', compact: true, title: 'Queue is empty', text: 'Songs you play or queue show up here.' })}`;
      }
      const sum = queueSummary(s);
      const legend = sum.n ? `<div class="np-legend t-12 muted np-mt-1"><span>${srcGlyph({ path: 1 })}${sum.dl} downloaded</span>${sum.st ? `<span>${srcGlyph({ video_id: 1 })}${sum.st} stream</span>` : ''}</div>` : '';
      return `<div class="np-queue__head"><div><h3>Queue</h3><div class="t-13 muted num np-mt-1">${sum.n} up next · ${fmtLongDuration(sum.left)} left</div>${legend}</div>
          <button class="btn btn--icon btn--sm" type="button" data-a="queue-menu" aria-haspopup="menu" aria-label="Queue options: Save as playlist, Clear queue">${icon('more', 'icon--16')}</button></div>
        <div class="np-queue__body" data-np="qbody">${queueBody(s)}</div>`;
    }

    function emptyHTML() {
      return emptyState({ icon: 'music', title: 'Nothing playing', text: 'Pick something from your library, or shuffle all your songs. Voice recordings stay out of shuffle.',
        actions: `<button class="btn btn--primary" type="button" data-a="shuffle-all">${icon('shuffle')}Shuffle all</button><a class="btn btn--secondary" href="#library">${icon('library')}Open library</a>` });
    }

    // ---- voice
    function voiceHeadHTML(s) {
      const it = s.current;
      const when = it.modified_at || it.added_at;
      const date = when ? new Date(when * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      const meta = [date && `Recorded ${date}`, it.size_bytes ? fmtBytes(it.size_bytes) : null].filter(Boolean).join(' · ');
      return `<div class="cluster"><span class="badge badge--voice badge--dot"><span class="badge__label">Voice recording</span></span><span class="t-13 muted">${esc(meta)}</span></div><div class="np-titlerow__title np-titlerow__title--lg">${esc(it.title)}</div>`;
    }
    function speedHTML(s) {
      return `<span class="label">${icon('speed', 'icon--16 np-ic-inline')}Speed</span>
        <div class="seg" role="group" aria-label="Playback speed">${VOICE_SPEEDS.map((r) => `<button class="seg__btn${Math.abs(s.rate - r) < 0.01 ? ' is-active' : ''}" type="button" data-a="speed" data-v="${r}" aria-pressed="${Math.abs(s.rate - r) < 0.01}">${r}×</button>`).join('')}</div>
        <button class="btn btn--ghost btn--sm${s.sleep ? ' btn--accent' : ''}" type="button" data-a="sleep-open" aria-label="Sleep timer: ${s.sleep ? esc(sleepShort(player)) : 'off'}">${icon('moon')}${s.sleep ? `Sleep · ${esc(sleepShort(player))}` : 'Sleep timer'}</button>`;
    }
    let waveKey = '';
    function paintWave(f) {
      const w = q('wave');
      if (!w) return;
      const bars = w.querySelectorAll('.wave i:not(.wave__cursor)');
      const n = bars.length;
      bars.forEach((b, i) => b.classList.toggle('is-played', i / n < f));
      const cur = w.querySelector('.wave__cursor');
      if (cur) w.querySelector('.wave').style.setProperty('--p', `${f * 100}%`);
    }

    // ---- output device (desktop select; phone util button opens a menu)
    function renderOutputSelect() {
      const sel = q('out-sel');
      if (!sel) return;
      const o = outputSnapshot();
      const devices = o ? o.devices : [{ id: '', label: currentOutputLabel() }];
      const html = devices.map((d) => `<option value="${esc(d.id)}"${o && d.id === o.current ? ' selected' : ''}>${esc(d.label)}</option>`).join('');
      if (memo.get(sel) !== html) { memo.set(sel, html); sel.innerHTML = html; }
      const lock = !o?.canSwitch;
      sel.disabled = lock;
      sel.title = lock ? 'Audio goes to the system output — change it in your system sound settings' : '';
    }
    function outputMenu(anchor) {
      const o = outputSnapshot();
      if (!o?.canSwitch) {
        toast(`Playing on ${currentOutputLabel()}`, { kind: 'info', sub: isAndroid ? 'Android routes audio — plug in headphones or pick Bluetooth from quick settings' : 'Change the output in your system sound settings' });
        return;
      }
      openMenu(anchor, o.devices.map((d) => ({ label: d.label, icon: 'speaker', checked: d.id === o.current, run: () => pickOutput(d.id) })), { title: 'Play on' });
    }
    async function pickOutput(id) {
      if (!(await setOutputDevice(id))) toast('Couldn’t switch the output device', { kind: 'danger' });
    }

    // ------------------------------------------------------------ render
    function render(s) {
      const it = s.current;
      const want = !it ? 'empty' : isVoice(it) ? 'voice' : 'music';
      if (want !== mode) build(want);
      put(q('ctx'), ctxHTML(s));
      put(q('queue'), queueHTML(s));
      if (mode === 'empty') { put(q('empty'), emptyHTML()); return; }
      put(q('banners'), bannersHTML(s));
      if (mode === 'voice') {
        put(q('v-art'), artHTML(it, { size: 'hero', label: 'Voice recording' }));
        put(q('v-head'), voiceHeadHTML(s));
        const key = `${it.id || it.path}`;
        if (key !== waveKey) {
          waveKey = key;
          q('wave').innerHTML = waveform({ bars: 96, seed: (hashStr(key) % 97) + 1, cls: 'wave--lg wave--voice' }).replace('</div>', '<i class="wave__cursor"></i></div>');
        }
        put(q('v-transport'), transportHTML(s, { size: 'voice' }));
        put(q('v-speed'), speedHTML(s));
        put(q('p-peek'), peekHTML(s));
        paintTime();
        return;
      }
      put(q('art'), artHTML(it, { size: 'hero', tag: it.album || '', label: `Artwork: ${[it.album || it.title, it.artist].filter(Boolean).join(' by ')}` }));
      put(q('head'), headHTML(s));
      put(q('actions'), actionsHTML(s));
      put(q('deck'), transportHTML(s));
      put(q('sleep'), sleepHTML(s));
      put(q('facts'), factsHTML(s));
      put(q('vol-value'), `Volume ${Math.round(s.volume * 100)}`);
      renderOutputSelect();
      const vol = q('volume');
      if (vol && !isDragging(vol)) vol.style.setProperty('--p', `${s.volume * 100}%`);
      put(q('p-art'), artHTML(it, { size: 'hero', tag: it.album || it.title, label: `Artwork: ${[it.album || it.title, it.artist].filter(Boolean).join(' by ')}` }));
      put(q('p-title'), phoneTitleHTML(s));
      put(q('p-transport'), transportHTML(s, { size: 'phone' }));
      put(q('p-util'), utilHTML(s));
      put(q('p-peek'), peekHTML(s));
      sheet?.render(s);
      paintTime();
    }

    function paintTime(t = { position: player.state.position, duration: player.state.duration, buffered: player.state.buffered }) {
      const s = player.state;
      const buffering = showBuffering(s);
      paintScrubber(q('scrub'), t, { buffering });
      paintScrubber(q('p-scrub'), t, { buffering });
      if (mode === 'voice') {
        const d = t.duration || 0;
        const wave = q('wave');
        if (wave && !isDragging(wave)) paintWave(d ? t.position / d : 0);
        const times = q('v-times')?.querySelectorAll('span');
        if (times) {
          const rem = Math.max(0, d - t.position);
          times[0].textContent = fmtDuration(t.position);
          times[1].textContent = s.rate !== 1 ? `-${fmtDuration(rem / s.rate)} at ${s.rate}× · ${fmtDuration(rem)} at 1×` : `-${fmtDuration(rem)}`;
        }
        if (wave) wave.setAttribute('aria-valuetext', `${fmtDuration(t.position)} of ${fmtDuration(d)}`);
      }
    }

    // ------------------------------------------------------------ queue sheet (phone)
    function openQueueSheet() {
      const body = document.createElement('div');
      body.className = 'np-qsheet';
      const head = `<button class="btn btn--icon" type="button" data-a="queue-menu" aria-haspopup="menu" aria-label="Queue options: Save as playlist, Clear queue">${icon('more')}</button>`;
      const s0 = player.state;
      const sum0 = queueSummary(s0);
      const sh = openSheet({ title: 'Queue', sub: `${sum0.n} up next · ${fmtLongDuration(sum0.left)} left`, head, body: body, label: 'Queue', onClose: () => { sheet = null; } });
      const renderSheet = (s) => {
        if (!s.current) { sh.close(); return; }
        const sum = queueSummary(s);
        const sub = sh.el.querySelector('.t-13.muted');
        if (sub) sub.textContent = `${sum.n} up next · ${fmtLongDuration(sum.left)} left`;
        const html = `<div class="list">${queueBody(s, { phone: true })}</div>`;
        if (memo.get(body) !== html) { memo.set(body, html); body.innerHTML = html; }
      };
      sheet = { ...sh, render: renderSheet };
      renderSheet(s0);
      sh.el.addEventListener('click', onClick);
      bindReorder(sh.el);
    }

    // ------------------------------------------------------------ reorder (pointer drag on grips)
    function bindReorder(container) {
      container.addEventListener('pointerdown', (e) => {
        const grip = e.target.closest('[data-grip]');
        if (!grip || !container.contains(grip)) return;
        const row = grip.closest('[data-uid]');
        if (!row) return;
        e.preventDefault();
        const list = row.parentElement;
        row.classList.add('is-dragging');
        grip.setPointerCapture?.(e.pointerId);
        const move = (ev) => {
          const sibs = [...list.querySelectorAll(':scope > [data-uid]:not(.is-playing)')].filter((r) => r !== row);
          const before = sibs.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
          if (before) { if (row.nextElementSibling !== before) list.insertBefore(row, before); }
          else if (sibs.length) { const last = sibs[sibs.length - 1]; if (last.nextElementSibling !== row) last.after(row); }
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
          row.classList.remove('is-dragging');
          let next = row.nextElementSibling;
          while (next && !next.dataset?.uid) next = next.nextElementSibling;
          memo.delete(q('queue')); memo.delete(container.querySelector('.np-qsheet') || container);
          player.move(Number(row.dataset.uid), next ? Number(next.dataset.uid) : null);
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
      });
    }

    // ------------------------------------------------------------ actions
    function queueMenu(anchor) {
      const s = player.state;
      const items = s.queue.map((e) => e.item);
      openMenu(anchor, [
        { label: 'Save queue as playlist', icon: 'playlist', hint: plural(items.length, 'song'), run: () => createPlaylistDialog(items) },
        { label: 'Shuffle up next', icon: 'shuffle', disabled: s.upNext.rest.length < 2, run: () => player.shuffleUpNext() },
        { sep: true },
        { label: 'Clear queue', icon: 'trash', danger: true, hint: plural(s.upNext.all.length, 'song'), disabled: !s.upNext.all.length, run: () => { const before = s.queue.slice(s.index + 1).map((e) => e.item); player.clearQueue(); toast('Queue cleared', { action: { label: 'Undo', run: () => player.addToQueue(before) } }); } },
      ], { title: 'Queue', className: 'menu--queue' });
    }

    function collapse() {
      if (canGoBack()) history.back(); else location.hash = lastPageHref();
    }

    async function onClick(e) {
      const a = e.target.closest('[data-a]');
      const row = e.target.closest('[data-uid]');
      if (!a) {
        if (row && !row.classList.contains('is-playing') && !row.classList.contains('is-disabled') && !e.target.closest('[data-grip]')) player.jump(Number(row.dataset.uid));
        return;
      }
      const s = player.state;
      const it = s.current;
      switch (a.dataset.a) {
        case 'collapse': collapse(); break;
        case 'more': if (it) openTrackMenu(a, it, { player }); break;
        case 'q-menu': if (it) openTrackMenu(a, it, { player }); break;
        case 'play': player.toggle(); break;
        case 'prev': player.prev(); break;
        case 'next': player.next(); break;
        case 'shuffle': player.toggleShuffle(); break;
        case 'repeat': player.cycleRepeat(); break;
        case 'repeat-all': player.setRepeat('all'); if (s.queue[0]) player.jump(s.queue[0].uid); break;
        case 'like': player.toggleLike(); break;
        case 'download': if (it) { await downloadItem(it); render(player.state); } break;
        case 'downloads': location.hash = '#downloads'; break;
        case 'dl-done': toast(it?.source === 'local' ? 'This song is a file on this device' : 'Downloaded — plays offline', { kind: 'ok', sub: it?.path || '' }); break;
        case 'addpl': if (it) openPlaylistPicker(a, it); break;
        case 'sleep-set': { const v = a.dataset.v; player.setSleep(v === 'off' ? null : v === 'end' ? 'end' : Number(v)); break; }
        case 'sleep-open': openSleepMenu(a, player); break;
        case 'queue-open': openQueueSheet(); break;
        case 'output-open': outputMenu(a); break;
        case 'queue-menu': queueMenu(a); break;
        case 'q-remove': if (row) { const uid = Number(row.dataset.uid); const entry = s.queue.find((x) => x.uid === uid); player.remove(uid); if (entry) toast(`Removed “${entry.item.title}” from the queue`, { action: { label: 'Undo', run: () => player.playNext(entry.item) } }); } break;
        case 'clear-added': player.clearAdded(); break;
        case 'show-all': showAll = true; memo.delete(q('queue')); render(player.state); break;
        case 'back15': player.seekBy(-15); break;
        case 'fwd15': player.seekBy(15); break;
        case 'speed': player.setVoiceSpeed(Number(a.dataset.v)); break;
        case 'retry': player.resume(); break;
        case 'shuffle-all': {
          const tracks = await api.tracks('music', { limit: 500 }).catch(() => []);
          if (tracks.length) player.shufflePlay(tracks, { type: 'library', name: 'All songs' });
          else toast('No songs yet — search YouTube Music or scan this device', { kind: 'info' });
          break;
        }
      }
    }

    function onChange(e) {
      if (e.target.matches('[data-np="out-sel"]')) pickOutput(e.target.value);
    }
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    unsubs.push(onOutputs(() => { if (player.state.current) render(player.state); }));
    outputs();
    bindReorder(root);
    unsubs.push(player.subscribe(render));
    unsubs.push(player.onTime((t) => paintTime(t)));
    unsubs.push(downloads.subscribe(() => { if (player.state.current) render(player.state); }));
    unsubs.push(online.subscribe(() => render(player.state)));

    return () => {
      unsubs.forEach((u) => u());
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      sheet?.close();
    };
  },
};
