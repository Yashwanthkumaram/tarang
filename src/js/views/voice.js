// Voice recordings (design/screens/voice.html): continue-listening card (waveform scrubber,
// per-recording speed, resume), all recordings grouped by day with search + sort, the
// "Needs review" rail for files the classifier was unsure about, and an About card.
// Recordings never enter music shuffle; they play in their own queue (context type 'voice').
// Styles: styles/views/voice.css.
//
// Resume positions: kept per recording in localStorage (`voice.pos.<id>`, seconds), written
// by a module-level player.onTime listener installed when this module first loads. Speeds
// use the same per-recording key as player.js (`voice.speed.<id>`).

import { api, listen } from '../api.js';
import { openMenu } from '../components/overlay.js';
import { bindSlider, isDragging } from '../components/player-ui.js';
import { settings as settingsStore, stats as statsStore } from '../components/store.js';
import { player } from '../player.js';
import { emptyState, esc, fmtBytes, fmtDuration, fmtLongDuration, fmtNum, hashStr, icon, isPhone, on, plural, toast, waveform } from '../ui.js';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const PAGE = 40;
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} return null; };
const isVoice = (t) => t && (t.kind === 'voice' || t.kind === 'unsure');
const savedPos = (t) => Number(LS(`voice.pos.${t.id}`)) || 0;
const ownSpeed = (t) => Number(LS(`voice.speed.${t.id}`)) || 0;
const defSpeed = () => Number(settingsStore.value?.['playback.voice_speed']) || 1;
const speedOf = (t) => ownSpeed(t) || defSpeed();
const when = (t) => (t.modified_at || t.added_at || 0) * 1000;

// Needs-review suggestions. Track carries no voice probability (only confidence = distance
// from 50 %), so the suggestion is read from the classifier's reason labels (classifier.rs
// `score`): each label leans voice or music; ties stay voice (D43).
const MUSIC_CUES = /steady beat|has artist tag|music folder/;
const VOICE_CUES = /frequent pauses|speech-rate rhythm|narrow bandwidth|identical channels|^mono$|kHz|recorder format|recordings folder|recorder-style|no artist tag/;
const cues = (reason) => String(reason || '').split(',').map((x) => x.trim()).filter(Boolean);
// Audio cues (rhythm, beat, pauses) outweigh file cues; a missing artist tag is weak evidence.
const cueWeight = (c) => (/steady beat|speech-rate rhythm|frequent pauses/.test(c) ? 2 : /no artist tag/.test(c) ? 0.5 : 1);
function suggestKind(t) {
  let v = 0, m = 0;
  for (const c of cues(t.reason)) { if (MUSIC_CUES.test(c)) m += cueWeight(c); else if (VOICE_CUES.test(c)) v += cueWeight(c); }
  return m > v ? 'music' : 'voice';
}
/** Short reason line in the design's voice ("Speech over music"); the full list is the tooltip. */
function shortReason(reason) {
  const c = cues(reason);
  if (!c.length) return 'Couldn’t tell';
  if (/could not decode/.test(c[0])) return 'Couldn’t analyse the audio';
  const speech = c.some((x) => /speech-rate rhythm|frequent pauses/.test(x));
  const beat = c.includes('steady beat');
  if (speech && beat) return 'Speech over music';
  if (beat) return 'Mostly instruments';
  const first = c.slice(0, 2).join(', ');
  return first[0].toUpperCase() + first.slice(1);
}

// ---- remember where each recording was left (survives leaving this screen) ----
let lastSave = 0;
player.onTime(({ position, duration }) => {
  const it = player.current;
  if (!isVoice(it) || !it.id || !duration) return;
  const now = Date.now();
  if (now - lastSave < 3000 && position < duration - 2) return;
  lastSave = now;
  if (position >= duration - 3) LS(`voice.pos.${it.id}`, null);   // finished → start over next time
  else if (position > 5) LS(`voice.pos.${it.id}`, String(Math.floor(position)));
  LS('voice.last', it.id);
});

// ---- date helpers ----
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function groupLabel(ms) {
  const d = new Date(ms), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayName = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (ms >= start) return ['today', `Today<span class="vr-sep" aria-hidden="true">·</span>${esc(dayName)}`];
  if (ms >= start - 86400000) return ['yesterday', `Yesterday<span class="vr-sep" aria-hidden="true">·</span>${esc(dayName)}`];
  if (ms >= start - 6 * 86400000) return ['week', 'Earlier this week'];
  return [`m${d.getFullYear()}-${d.getMonth()}`, esc(d.toLocaleDateString(undefined, { month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }))];
}
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTod = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const sep = '<span class="vr-sep" aria-hidden="true">·</span>';
const clock = `<svg class="icon vr-clock" aria-hidden="true"><use href="#i-clock"/></svg>`;
const mic = (cls = 'vr-art') => `<div class="art art--voice ${cls}" aria-hidden="true">${icon('mic', 'vr-art__mic')}</div>`;

export default {
  title: 'Voice recordings',
  async render(root, params, ctx) {
    const cleanups = [];
    let recs = [], unsure = [], query = params.q || '', sort = 'newest', shown = PAGE, reviewAll = false;
    let scan = null;   // scan://progress while a scan started here runs
    let resumeItem = null;

    // Phone top-bar ⋯: Scan for new · Sort
    const trail = document.createElement('button');
    trail.type = 'button'; trail.className = 'btn btn--icon';
    trail.setAttribute('aria-label', 'More · Scan for new recordings, Sort'); trail.setAttribute('aria-haspopup', 'menu');
    trail.innerHTML = icon('more');
    trail.addEventListener('click', () => openMenu(trail, [
      { label: 'Scan for new', icon: 'scan', run: startScan, disabled: !!scan },
      { sep: true },
      { label: 'Newest first', checked: sort === 'newest', run: () => { sort = 'newest'; paintList(); } },
      { label: 'Oldest first', checked: sort === 'oldest', run: () => { sort = 'oldest'; paintList(); } },
      { label: 'Longest first', checked: sort === 'longest', run: () => { sort = 'longest'; paintList(); } },
      { label: 'Name A–Z', checked: sort === 'name', run: () => { sort = 'name'; paintList(); } },
    ], { title: 'Voice recordings' }));
    ctx.setTrail(trail);

    root.innerHTML = `<div class="page vr-page">
      <div class="page-head desktop-only">
        <div><nav class="crumb" aria-label="Breadcrumb"><a href="#library">Library</a>${icon('chevron-right')}<span>Voice recordings</span></nav>
          <h1>Voice recordings</h1><div class="page-head__sub num" id="vr-sub">Loading…</div></div>
        <div class="page-head__actions"><button class="btn btn--secondary" type="button" data-act="scan">${icon('scan')}Scan for new</button></div>
      </div>
      <div class="search phone-only vr-phone-search">${icon('search')}<input class="search__input" type="search" placeholder="Search recordings by name or date" aria-label="Search voice recordings" value="${esc(query)}" data-search></div>
      <div id="vr-scan"></div>
      <div id="vr-resume"></div>
      <div class="vr-body">
        <section class="vr-list" aria-labelledby="h-all"><h2 class="sr-only" id="h-all">All recordings</h2>
          <div class="vr-toolbar">
            <div class="search vr-topsearch desktop-only">${icon('search')}<span class="badge badge--voice vr-scope">${icon('mic')}Voice</span><input class="search__input" type="search" placeholder="Name or date" aria-label="Search voice recordings" value="${esc(query)}" data-search></div>
            <span class="vr-toolbar__count" id="vr-count"></span>
            <button class="btn btn--ghost btn--sm desktop-only" type="button" data-act="sort" aria-haspopup="menu">${icon('sort', 'icon--16')}<span id="vr-sort-label">Newest first</span>${icon('chevron-down', 'icon--16')}</button>
          </div>
          <div class="list" id="vr-rows"><div class="skel-list">${Array.from({ length: 5 }, (_, i) => `<div class="skel-row"><i class="skel skel--art"></i><div class="stack"><i class="skel skel--title" style="width:${40 + (i * 13) % 35}%"></i><i class="skel skel--text" style="width:96px"></i></div><i class="skel skel--text" style="width:40px"></i></div>`).join('')}</div></div>
        </section>
        <section class="card vr-review" aria-labelledby="h-review" id="vr-review" hidden></section>
        <section class="card vr-summary" aria-labelledby="h-summary" id="vr-summary" hidden></section>
      </div>
    </div>`;
    const $ = (s) => root.querySelector(s);

    // ---------------------------------------------------------------- data
    async function load() {
      try {
        [recs, unsure] = await Promise.all([api.tracks('voice', { sort: 'recent', limit: 100000 }), api.tracks('unsure', { sort: 'recent', limit: 1000 })]);
      } catch (e) {
        $('#vr-rows').innerHTML = emptyState({ icon: 'alert', error: true, title: 'Couldn’t load recordings', text: e.message || String(e), actions: `<button class="btn btn--secondary" type="button" data-act="reload">${icon('refresh')}Try again</button>` });
        $('#vr-sub').textContent = 'Couldn’t load';
        return;
      }
      paintHead(); paintResume(); paintList(); paintReview(); paintSummary();
    }

    function paintHead() {
      const total = recs.reduce((a, t) => a + (t.duration_secs || 0), 0), bytes = recs.reduce((a, t) => a + (t.size_bytes || 0), 0);
      $('#vr-sub').textContent = recs.length ? `${plural(recs.length, 'recording')} · ${fmtLongDuration(total)} · ${fmtBytes(bytes)} · kept out of music and shuffle` : 'Kept out of music and shuffle';
    }

    // ---- continue listening ----
    function pickResume() {
      const cur = player.current;
      if (isVoice(cur) && cur.kind === 'voice') { const t = recs.find((r) => r.id === cur.id); if (t) return t; }
      const lastId = LS('voice.last');
      const partial = recs.filter((t) => savedPos(t) > 0).sort((a, b) => (b.id === lastId) - (a.id === lastId) || (b.last_played_at || 0) - (a.last_played_at || 0));
      if (partial.length) return partial[0];
      return recs.slice().sort((a, b) => (b.last_played_at || 0) - (a.last_played_at || 0))[0] || null;
    }
    function posOf(t) { const cur = player.current; return cur && cur.id === t.id ? player.state.position : savedPos(t); }
    function paintResume() {
      const el = $('#vr-resume');
      resumeItem = recs.length ? pickResume() : null;
      if (!resumeItem) { el.innerHTML = ''; return; }
      const t = resumeItem, ms = when(t), sp = speedOf(t);
      el.innerHTML = `<section class="card card--pad-lg vr-resume" aria-labelledby="h-resume">
        <div class="art art--lg art--voice"><span style="display:grid">${icon('mic', 'icon--24')}</span></div>
        <div class="vr-resume__main">
          <div class="vr-resume__head">
            <div class="eyebrow" id="vr-resume-eyebrow">Continue listening</div>
            <div class="vr-resume__title" id="h-resume">${esc(t.title)}</div>
            <div class="meta vr-meta"><span>${esc(fmtDate(ms))}</span>${sep}<span>${clock}${esc(fmtTod(ms))}</span>${sep}<span class="num">${fmtDuration(t.duration_secs)}</span>${t.format ? `<span class="badge badge--outline desktop-only vr-fmt">${esc(t.format.toUpperCase())}</span>` : ''}</div>
          </div>
          <div class="vr-resume__wave">
            <div class="vr-scrub" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="${Math.round(t.duration_secs || 0)}">
              ${waveform({ bars: isPhone() ? 64 : 96, seed: (hashStr(t.id) % 50) + 1, played: 0, cls: 'wave--voice' }).replace('</div>', '<i class="wave__cursor"></i></div>')}
              <span class="vr-handle" aria-hidden="true"></span>
            </div>
            <div class="vr-resume__times" id="vr-times"></div>
          </div>
        </div>
        <div class="vr-resume__aside">
          <div class="vr-speed"><span class="eyebrow">Speed</span>
            <div class="seg" role="radiogroup" aria-label="Playback speed for this recording">${SPEEDS.map((v) => `<button type="button" class="seg__btn${v === sp ? ' is-active' : ''}" role="radio" aria-checked="${v === sp}" data-speed="${v}">${v}×</button>`).join('')}</div></div>
          <button class="btn btn--primary btn--lg" type="button" data-act="resume" id="vr-resume-btn"></button>
        </div>
      </section>`;
      const scrub = el.querySelector('.vr-scrub');
      cleanups.push(bindSlider(scrub, {
        container: scrub, step: 10 / Math.max(1, t.duration_secs || 1),
        getValue: () => posOf(t) / Math.max(1, t.duration_secs || 1),
        onChange: (f, final) => {
          const secs = f * (t.duration_secs || 0);
          paintResumeTime(secs);
          if (!final) return;
          if (player.current?.id === t.id) player.seek(secs);
          else LS(`voice.pos.${t.id}`, String(Math.floor(secs)));
        },
      }));
      paintResumeTime();
    }
    function paintResumeTime(override) {
      const t = resumeItem;
      if (!t || !$('#vr-times')) return;
      const dur = t.duration_secs || 0, pos = override ?? posOf(t), sp = speedOf(t);
      const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
      const scrub = root.querySelector('.vr-scrub');
      if (scrub && (override != null || !isDragging(scrub))) {
        scrub.style.setProperty('--p', `${pct}%`);
        scrub.querySelector('.wave').style.setProperty('--p', `${pct}%`);
        scrub.querySelectorAll('.wave i:not(.wave__cursor)').forEach((b, i, all) => b.classList.toggle('is-played', (i / all.length) * 100 < pct));
        scrub.setAttribute('aria-valuenow', String(Math.round(pos)));
        scrub.setAttribute('aria-valuetext', `${fmtDuration(pos)} of ${fmtDuration(dur)}`);
      }
      $('#vr-times').innerHTML = `<span><strong>${fmtDuration(pos)}</strong> / ${fmtDuration(dur)}${sep}${Math.round(pct)}%</span><span>${fmtDuration(Math.max(0, dur - pos) / sp)} left at ${sp}×</span>`;
      const playingThis = player.current?.id === t.id;
      const btn = $('#vr-resume-btn');
      if (btn) btn.innerHTML = playingThis && player.state.playing ? `${icon('pause', 'icon--fill vr-glyph')}Pause` : pos > 1 ? `${icon('play', 'icon--fill vr-glyph')}Resume from ${fmtDuration(pos)}` : `${icon('play', 'icon--fill vr-glyph')}Play`;
      const eb = $('#vr-resume-eyebrow');
      if (eb) eb.textContent = playingThis ? 'Now playing' : pos > 1 ? 'Continue listening' : 'Latest recording';
    }

    // ---- list ----
    function filtered() {
      const q = query.trim().toLowerCase();
      let list = recs.filter((t) => !q || `${t.title} ${fmtDate(when(t))} ${new Date(when(t)).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} ${t.path || ''}`.toLowerCase().includes(q));
      const cmp = { newest: (a, b) => when(b) - when(a), oldest: (a, b) => when(a) - when(b), longest: (a, b) => (b.duration_secs || 0) - (a.duration_secs || 0), name: (a, b) => a.title.localeCompare(b.title) }[sort];
      return list.slice().sort(cmp);
    }
    const SORT_LABEL = { newest: 'Newest first', oldest: 'Oldest first', longest: 'Longest first', name: 'Name A–Z' };
    function rowHTML(t, idx) {
      const ms = when(t), dur = t.duration_secs || 0, pos = posOf(t), pct = dur ? Math.round((pos / dur) * 100) : 0;
      const own = ownSpeed(t), partial = pos > 1 && pct < 99;
      const left = partial ? fmtDuration((dur - pos) / speedOf(t)) : '';
      const playing = player.current?.id === t.id;
      return `<div class="row row--actions row--voice vr-row${playing ? ' is-playing' : ''}${partial ? ' vr-row--prog' : ''}" data-idx="${idx}" data-id="${esc(t.id)}">
        ${mic()}
        <div class="row__main"><div class="row__title">${esc(t.title)}</div>
          <div class="row__sub">${waveform({ bars: 28, seed: (hashStr(t.id) % 50) + 1, played: partial ? pct : 0, cls: 'wave--sm wave--voice' })}<span class="vr-when"><span class="vr-date">${esc(fmtDate(ms))}</span><span class="vr-tod">${sep}${clock}${esc(fmtTod(ms))}</span></span>${own ? `<span class="badge badge--voice desktop-only"><span class="badge__label">${own}×</span></span>` : ''}${partial ? `<span class="vr-sep desktop-only" aria-hidden="true">·</span><span class="vr-left desktop-only num">${left} left</span>` : ''}</div>
          ${partial ? `<div class="vr-prog phone-only"><span class="vr-prog__bar" aria-hidden="true"><i style="width:${pct}%"></i></span><span class="vr-prog__text num">${pct}%${sep}<span class="vr-left">${left} left</span></span></div>` : ''}
        </div>
        <div class="row__dur vr-dur"><span>${fmtDuration(dur)}</span>${own ? `<span class="vr-spd phone-only">${own}×</span>` : ''}</div>
        <div class="row__actions">
          <button class="btn btn--icon btn--sm row__play" type="button" data-act="play" aria-label="${playing && player.state.playing ? 'Pause' : 'Play'} ${esc(t.title)}">${icon(playing && player.state.playing ? 'pause' : 'play', 'icon--fill vr-glyph')}</button>
          <button class="btn btn--icon btn--sm desktop-only vr-hover" type="button" data-act="to-music" aria-label="Move to music" title="Move to music">${icon('music', 'icon--16')}</button>
          <button class="btn btn--icon btn--sm vr-menu" type="button" data-act="menu" aria-label="Speed, move to music" title="Speed, move to music" aria-haspopup="menu">${icon('more', 'icon--16')}</button>
        </div>
      </div>`;
    }
    let view = [];
    function paintList() {
      view = filtered();
      $('#vr-sort-label').textContent = SORT_LABEL[sort];
      const q = query.trim();
      $('#vr-count').innerHTML = q ? `<strong>${fmtNum(view.length)}</strong> ${view.length === 1 ? 'match' : 'matches'}` : `All <strong>${fmtNum(recs.length)}</strong> recordings`;
      const el = $('#vr-rows');
      if (!recs.length) {
        el.innerHTML = `<div class="card vr-empty">${emptyState({ icon: 'mic', title: 'No voice recordings yet', text: 'Recorder files, WhatsApp voice notes and lectures show up here after a scan. They’re kept apart from your music and never play in shuffle.', actions: `<button class="btn btn--primary" type="button" data-act="scan">${icon('scan')}Scan for new</button><a class="btn btn--secondary" href="#device">${icon('folder')}Choose folders</a>` })}<div class="help num vr-lastscan" id="vr-lastscan"></div></div>`;
        api.lastScan().then((l) => { const h = $('#vr-lastscan'); if (h && l?.[0]) h.innerHTML = `Last scan: ${esc(new Date(l[0] * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}${sep}${plural(l[1].files_seen, 'file')}${sep}${fmtNum(l[1].voice)} voice`; }).catch(() => {});
        return;
      }
      if (!view.length) {
        el.innerHTML = emptyState({ icon: 'search', compact: true, title: `No recordings match “${q}”`, text: 'Search looks at names and dates, e.g. “lecture” or “14 Oct”. Unsorted files are in Needs review.', actions: `<button class="btn btn--secondary btn--sm" type="button" data-act="clear-search">Clear search</button>` });
        return;
      }
      const slice = view.slice(0, shown);
      let html = '';
      if (sort === 'newest' || sort === 'oldest') {
        const groups = [];
        for (let i = 0; i < slice.length; i++) {
          const [key, label] = groupLabel(when(slice[i]));
          if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, label, items: [] });
          groups[groups.length - 1].items.push(i);
        }
        for (const g of groups) {
          const secs = g.items.reduce((a, i) => a + (slice[i].duration_secs || 0), 0);
          html += `<div class="group-head"><span>${g.label}</span><span class="group-head__count">${plural(g.items.length, 'recording')}${sep}${fmtLongDuration(secs)}</span></div>`;
          html += g.items.map((i) => rowHTML(slice[i], i)).join('');
        }
      } else html = slice.map((t, i) => rowHTML(t, i)).join('');
      const rest = view.length - slice.length;
      if (rest > 0) {
        const secs = view.slice(shown).reduce((a, t) => a + (t.duration_secs || 0), 0);
        html += `<div class="vr-more"><button class="btn btn--ghost btn--sm" type="button" data-act="more">Show ${fmtNum(Math.min(rest, PAGE))} more<span class="faint num">${fmtLongDuration(secs)}</span>${icon('chevron-down', 'icon--16')}</button></div>`;
      }
      el.innerHTML = html;
    }

    // ---- review rail ----
    function paintReview() {
      const el = $('#vr-review');
      el.hidden = false;
      if (!unsure.length) {
        el.innerHTML = `<div class="card__head"><div class="card__title" id="h-review">Needs review</div></div>${emptyState({ icon: 'check-circle', compact: true, title: 'All sorted', text: 'Nothing unsure from the last scan. New files the classifier can’t place will wait here.' })}`;
        el.querySelector('.empty__icon').classList.add('vr-ok-icon');
        return;
      }
      const show = reviewAll ? unsure : unsure.slice(0, 2);
      const sug = unsure.map(suggestKind);
      const nVoice = sug.filter((k) => k === 'voice').length, nMusic = sug.length - nVoice;
      const sugTitle = [nVoice && `Keep ${nVoice} as voice`, nMusic && `move ${nMusic} to music`].filter(Boolean).join(', ').replace(/^m/, 'M');
      el.innerHTML = `<div class="card__head"><div><div class="card__title" id="h-review">Needs review<span class="badge badge--warn vr-count-badge"><span class="badge__label">${unsure.length}</span></span></div></div><button class="btn btn--ghost btn--sm desktop-only" type="button" data-act="accept-all" title="${esc(sugTitle)}">${icon('check', 'icon--16')}Accept suggestions</button></div>
        <p class="vr-review__intro">Kept out of music and shuffle until you decide.</p>
        <div class="list">${show.map((t) => {
          const ms = when(t), playing = player.current?.id === t.id && player.state.playing;
          return `<div class="row row--actions row--voice row--stack vr-rrow" data-id="${esc(t.id)}"><div class="art vr-unsure" aria-hidden="true">${icon('question')}</div>
            <div class="row__main"><div class="row__title">${esc(t.title)}</div><div class="row__sub">${waveform({ bars: 28, seed: (hashStr(t.id) % 50) + 1, cls: 'wave--sm' })}<span class="vr-when"><span class="vr-date">${esc(new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</span><span class="vr-tod">${sep}${clock}${esc(fmtTod(ms))}</span></span><span class="vr-break" aria-hidden="true"></span><span class="badge badge--warn"><span class="badge__label">Unsure · ${Math.round((t.confidence || 0) * 100)}% confident</span></span><span class="vr-reason clamp-1" title="${esc(t.reason || '')}">${esc(shortReason(t.reason))}</span></div></div>
            <div class="vr-preview"><span class="vr-preview__dur num">${fmtDuration(t.duration_secs)}</span><button class="btn btn--icon btn--sm vr-preview__btn" type="button" data-act="preview" aria-label="${playing ? 'Pause' : 'Preview'} ${esc(t.title)}">${icon(playing ? 'pause' : 'play', 'icon--fill vr-glyph')}</button></div>
            <div class="row__actions"><button class="btn ${suggestKind(t) === 'voice' ? 'btn--secondary' : 'btn--ghost'} btn--sm" type="button" data-act="keep">${icon('mic', 'icon--16')}Keep as voice</button><button class="btn ${suggestKind(t) === 'music' ? 'btn--secondary' : 'btn--ghost'} btn--sm" type="button" data-act="to-music">${icon('music', 'icon--16')}Move to music</button></div></div>`;
        }).join('')}</div>
        ${unsure.length > 2 ? `<button class="srow srow--link vr-review__all" type="button" data-act="review-all"><div class="srow__main"><div class="srow__title">${reviewAll ? 'Show fewer' : `Review all ${unsure.length}`}</div>${reviewAll ? '' : `<div class="srow__sub num">${plural(unsure.length - 2, 'more file')} waiting</div>`}</div>${icon(reviewAll ? 'chevron-up' : 'chevron-right', 'muted')}</button>` : ''}`;
    }

    // ---- about this section ----
    function paintSummary() {
      const el = $('#vr-summary');
      if (!recs.length) { el.hidden = true; return; }
      el.hidden = false;
      const total = recs.reduce((a, t) => a + (t.duration_secs || 0), 0), bytes = recs.reduce((a, t) => a + (t.size_bytes || 0), 0);
      const h = Math.floor(total / 3600), m = Math.round((total % 3600) / 60);
      const dirs = new Map();
      for (const t of recs) { const d = (t.path || '').split('/').slice(0, -1).pop(); if (d) dirs.set(d, (dirs.get(d) || 0) + 1); }
      const found = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d).join(' · ');
      const [num, unit] = fmtBytes(bytes).split(' ');
      const classify = settingsStore.value?.['classifier.enabled'] !== 'false';
      el.innerHTML = `<div class="card__head"><div class="card__title" id="h-summary">About this section</div></div>
        <div class="stats">
          <div class="stat"><div class="stat__num">${fmtNum(recs.length)}</div><div class="stat__label">Recordings</div></div>
          <div class="stat"><div class="stat__num">${h ? `${h} h ${m}` : `${m} min`}</div><div class="stat__label">Total length</div></div>
          <div class="stat"><div class="stat__num">${esc(num)}</div><div class="stat__label">${esc(unit)} on disk</div></div>
        </div>
        ${found ? `<a class="srow srow--link" href="#device"><div class="srow__main"><div class="srow__title">Found in</div><div class="srow__sub truncate">${esc(found)}</div></div>${icon('chevron-right', 'muted')}</a>` : ''}
        <a class="srow srow--link" href="#device"><div class="srow__main"><div class="srow__title">Voice classifier</div><div class="srow__sub">Sorts new files after every scan</div></div><span class="srow__value">${classify ? 'On' : 'Off'}</span>${icon('chevron-right', 'muted')}</a>
        <a class="srow srow--link" href="#settings?section=playback"><div class="srow__main"><div class="srow__title">Default speed</div><div class="srow__sub">For recordings you haven’t set</div></div><span class="srow__value">${defSpeed()}×</span>${icon('chevron-right', 'muted')}</a>
        <div class="vr-note">${icon('info', 'icon--16')}<span>Voice recordings never appear in Songs, playlists or music shuffle. Use “Move to music” on any row if one landed here by mistake.</span></div>`;
    }

    // ---------------------------------------------------------------- actions
    const ctxVoice = { type: 'voice', name: 'Voice recordings' };
    function playRec(list, t, { resume = true } = {}) {
      if (player.current?.id === t.id) { player.toggle(); return; }
      const idx = list.findIndex((x) => x.id === t.id);
      const at = resume ? savedPos(t) : 0;
      player.play(list, Math.max(0, idx), ctxVoice);
      if (at > 1) {
        // Seek once the engine has the file (player.play loads asynchronously).
        const unsub = player.subscribe((s) => { if (s.current?.id === t.id && !s.loading && s.duration) { unsub?.(); queueMicrotask(() => player.seek(at)); } });
        setTimeout(() => unsub?.(), 8000);
      }
    }
    async function setKind(t, kind) {
      try {
        await api.setKind(t.id, kind);
        const before = { recs: recs.slice(), unsure: unsure.slice() };
        recs = recs.filter((x) => x.id !== t.id); unsure = unsure.filter((x) => x.id !== t.id);
        if (kind === 'voice') recs = [{ ...t, kind: 'voice' }, ...recs];
        statsStore.refresh();
        dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'kind' } }));
        toast(kind === 'music' ? 'Moved to music' : 'Kept as voice recording', {
          kind: 'ok', sub: kind === 'music' ? `“${t.title}” is now in Songs` : null,
          action: { label: 'Undo', run: async () => { await api.setKind(t.id, t.kind).catch(() => {}); recs = before.recs; unsure = before.unsure; statsStore.refresh(); paintAll(); } },
        });
        paintAll();
      } catch (e) { toast(`Couldn’t move “${t.title}”: ${e.message || e}`, { kind: 'danger' }); }
    }
    async function acceptSuggestions() {
      const todo = unsure.map((t) => ({ t, kind: suggestKind(t) }));
      if (!todo.length) return;
      const done = [];
      for (const x of todo) {
        try { await api.setKind(x.t.id, x.kind); done.push(x); } catch (e) { toast(`Couldn’t move “${x.t.title}”: ${e.message || e}`, { kind: 'danger' }); }
      }
      if (!done.length) return;
      const before = { recs: recs.slice(), unsure: unsure.slice() };
      const ids = new Set(done.map((x) => x.t.id));
      unsure = unsure.filter((x) => !ids.has(x.id));
      recs = [...done.filter((x) => x.kind === 'voice').map((x) => ({ ...x.t, kind: 'voice' })), ...recs];
      const nV = done.filter((x) => x.kind === 'voice').length, nM = done.length - nV;
      statsStore.refresh();
      dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'kind' } }));
      toast([nV && `Kept ${plural(nV, 'recording')} as voice`, nM && `moved ${nM} to music`].filter(Boolean).join(', ').replace(/^m/, 'M'), {
        kind: 'ok',
        action: { label: 'Undo', run: async () => { for (const x of done) await api.setKind(x.t.id, x.t.kind).catch(() => {}); recs = before.recs; unsure = before.unsure; statsStore.refresh(); dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'kind' } })); paintAll(); } },
      });
      paintAll();
    }
    function setSpeed(t, v) {
      LS(`voice.speed.${t.id}`, String(v));
      if (player.current?.id === t.id) player.setVoiceSpeed(v);
      paintAll();
    }
    function openRowMenu(anchor, t) {
      const items = [
        { label: player.current?.id === t.id && player.state.playing ? 'Pause' : 'Play', icon: 'play', run: () => playRec(view.length ? view : recs, t) },
        { label: 'Play from the start', icon: 'back', run: () => { LS(`voice.pos.${t.id}`, null); if (player.current?.id === t.id) player.seek(0); else playRec(view, t, { resume: false }); } },
        { sep: true },
        ...SPEEDS.map((v) => ({ label: `${v}×${v === defSpeed() && !ownSpeed(t) ? ' (default)' : ''}`, icon: 'speed', checked: speedOf(t) === v, run: () => setSpeed(t, v) })),
        { sep: true },
        { label: 'Move to music', icon: 'music', hint: 'Adds to Songs', run: () => setKind(t, 'music') },
      ];
      openMenu(anchor, items, { title: t.title, sub: `${fmtDate(when(t))} · ${fmtDuration(t.duration_secs)}`, label: 'Recording options' });
    }
    async function startScan() {
      if (scan && !scan.finished) return;
      try { await api.startScan(); scan = { files_seen: 0, voice: 0, unsure: 0, finished: false }; paintScan(); }
      catch (e) { toast(`Couldn’t start the scan: ${e.message || e}`, { kind: 'danger' }); }
    }
    function paintScan() {
      const el = $('#vr-scan');
      if (!scan) { el.innerHTML = ''; return; }
      if (scan.finished) {
        const err = /^Error:/.test(scan.current_path || '');
        el.innerHTML = err ? `<div class="banner banner--danger">${icon('alert')}<div class="banner__body"><div class="banner__title">The scan stopped</div><div class="banner__text">${esc(scan.current_path.replace(/^Error:\s*/, ''))}</div></div><a class="btn btn--secondary btn--sm" href="#device">${icon('folder', 'icon--16')}Folder settings</a></div>` : '';
        return;
      }
      el.innerHTML = `<div class="card vr-scancard" aria-busy="true"><div class="progress-line">
          <div class="progress-line__meta"><span><strong>Sorting ${fmtNum(scan.files_seen)}</strong> files${sep}${fmtNum(scan.voice)} voice so far${sep}${fmtNum(scan.unsure)} unsure</span><span>${scan.audio_found != null ? `${fmtNum(scan.audio_found)} audio` : ''}</span></div>
          <div class="progress progress--thick progress--indeterminate"><i></i></div></div>
        <div class="vr-loadbar"><button class="btn btn--secondary btn--sm" type="button" disabled aria-disabled="true">${icon('scan', 'icon--16')}Scan for new</button><span class="help">Available again when this scan finishes. Recordings sorted so far can already play.</span></div></div>`;
    }
    function paintAll() { paintHead(); paintResume(); paintList(); paintReview(); paintSummary(); }

    cleanups.push(on(root, 'click', '[data-act]', (e, b) => {
      const row = b.closest('[data-id]');
      const t = row ? (recs.find((x) => x.id === row.dataset.id) || unsure.find((x) => x.id === row.dataset.id)) : null;
      switch (b.dataset.act) {
        case 'scan': startScan(); break;
        case 'reload': load(); break;
        case 'resume': if (resumeItem) playRec(recs, resumeItem); break;
        case 'play': if (t) playRec(view, t); break;
        case 'preview': if (t) playRec(unsure, t, { resume: false }); break;
        case 'menu': if (t) openRowMenu(b, t); break;
        case 'to-music': if (t) setKind(t, 'music'); break;
        case 'keep': if (t) setKind(t, 'voice'); break;
        case 'accept-all': acceptSuggestions(); break;
        case 'more': shown += PAGE; paintList(); break;
        case 'review-all': reviewAll = !reviewAll; paintReview(); break;
        case 'clear-search': query = ''; root.querySelectorAll('[data-search]').forEach((i) => { i.value = ''; }); paintList(); break;
        case 'sort': openMenu(b, Object.entries(SORT_LABEL).map(([k, l]) => ({ label: l, checked: sort === k, run: () => { sort = k; paintList(); } })), { title: 'Sort recordings' }); break;
      }
    }));
    // Phone: tapping a row plays it (the row is the target; buttons keep their own action).
    cleanups.push(on(root, 'click', '.vr-row', (e, row) => { if (e.target.closest('button, a') || !isPhone()) return; const t = recs.find((x) => x.id === row.dataset.id); if (t) playRec(view, t); }));
    cleanups.push(on(root, 'dblclick', '.vr-row', (e, row) => { if (e.target.closest('button, a') || isPhone()) return; const t = recs.find((x) => x.id === row.dataset.id); if (t) playRec(view, t); }));
    cleanups.push(on(root, 'click', '[data-speed]', (e, b) => { if (resumeItem) setSpeed(resumeItem, Number(b.dataset.speed)); }));
    cleanups.push(on(root, 'input', '[data-search]', (e, inp) => {
      query = inp.value; shown = PAGE;
      root.querySelectorAll('[data-search]').forEach((i) => { if (i !== inp) i.value = query; });
      paintList();
    }));

    // live player state: playing row, resume card clock
    let lastKey = '';
    cleanups.push(player.subscribe((s) => {
      const key = `${s.current?.id}|${s.playing}`;
      if (key === lastKey) return;
      lastKey = key;
      if (!recs.length && !unsure.length) return;
      if (isVoice(s.current) && resumeItem?.id !== s.current.id && s.current.kind === 'voice') paintResume(); else paintResumeTime();
      root.querySelectorAll('.vr-row').forEach((row) => {
        const onIt = row.dataset.id === s.current?.id;
        row.classList.toggle('is-playing', onIt);
        const btn = row.querySelector('[data-act="play"]');
        if (btn) btn.innerHTML = icon(onIt && s.playing ? 'pause' : 'play', 'icon--fill vr-glyph');
      });
      root.querySelectorAll('.vr-rrow [data-act="preview"]').forEach((btn) => { btn.innerHTML = icon(btn.closest('[data-id]').dataset.id === s.current?.id && s.playing ? 'pause' : 'play', 'icon--fill vr-glyph'); });
    }));
    cleanups.push(player.onTime(() => { if (resumeItem && player.current?.id === resumeItem.id) paintResumeTime(); }));

    const unlisten = await api.isScanning().then(async (busy) => {
      if (busy) { scan = { files_seen: 0, voice: 0, unsure: 0, finished: false }; paintScan(); }
      return listen('scan://progress', (r) => {
        const wasRunning = scan && !scan.finished;
        scan = r; paintScan();
        if (r.finished && wasRunning) { load(); toast(`Scan finished — ${plural(r.voice, 'voice recording')}, ${fmtNum(r.unsure)} to review`, { kind: 'ok' }); }
      });
    }).catch(() => null);
    cleanups.push(() => { try { unlisten?.(); } catch {} });
    const onLib = () => load();
    addEventListener('library:changed', onLib);
    cleanups.push(() => removeEventListener('library:changed', onLib));

    await load();
    return () => cleanups.forEach((fn) => { try { fn?.(); } catch {} });
  },
};

