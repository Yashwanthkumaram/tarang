// Player: queue, shuffle, repeat, like/download of the current song, sleep timer, voice
// speed, play counts — on top of the engine interface (engine/index.js). Owns no DOM;
// the shell (app.js) and views/now-playing.js render from its state.
//
//   import { player } from './player.js';
//   player.play(items, index, { type: 'playlist', id: 3, name: 'Late drives' });
//   player.subscribe((s) => …)        // any state change except the clock
//   player.onTime(({ position, duration, buffered }) => …)
//
// Items are Track (docs/API-v2.md) or YtTrack objects. YouTube songs that are not
// downloaded stream through youtube_stream_url; the next 2 queued streams are prefetched
// (D22). Local files play by path (engine handles the Android Blob workaround, D21).

import { api } from './api.js';
import { createEngine } from './engine/index.js';
import { download as startDownload, toggleLike as likeItem } from './components/actions.js';
import { online, settings } from './components/store.js';
import { toast } from './components/toast.js';

const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };

let engine = null;
let uidSeq = 0;
let startedFor = null;        // uid whose play was recorded
let errorStreak = 0;
/** Auto-skip pending after a failed song; cancelled by anything the user does (D46). */
let skipTimer = null;
/** uid of the queue entry whose failure was already handled (each song fails once). */
let failedUid = null;
/** uid of the entry already retried with a freshly resolved link. */
let retriedUid = null;
/** Songs that may fail in a row before auto-skipping stops. */
const MAX_AUTO_SKIPS = 3;
function cancelAutoSkip() { clearTimeout(skipTimer); skipTimer = null; }
let sleepTimer = null;
const subs = new Set();
const timeSubs = new Set();

const state = {
  queue: [],                  // [{ uid, item, added }] — `added` = queued by the user ("Added by you")
  index: -1,
  context: null,              // { type, id?, name } where playback started ("Playing from playlist Late drives")
  playing: false,
  buffering: false,
  loading: null,              // null | 'stream' | 'file'   (resolving before audio starts)
  error: null,                // message when playback stopped on an error
  ended: false,               // queue finished
  position: 0, duration: 0, buffered: 0,
  shuffle: LS('player.shuffle') === '1',
  repeat: LS('player.repeat') || 'off',   // off | all | one
  volume: Number(LS('player.volume') ?? 0.7),
  sleep: null,                // { mode: 'min', endsAt, minutes } | { mode: 'end' }
  rate: 1,
};
let originalOrder = null;     // queue order before shuffle (to restore)

// ---------------------------------------------------------------- helpers
/** Normalizes a Track or YtTrack into a queue item (keeps every original field). */
export function toItem(t) {
  if (!t) return null;
  return {
    ...t,
    id: t.id ?? null,
    video_id: t.video_id ?? null,
    path: t.path ?? null,
    title: t.title || 'Untitled',
    artist: t.artist ?? null,
    album: t.album ?? null,
    duration_secs: t.duration_secs ?? 0,
    thumbnail: t.thumbnail ?? null,
    source: t.source || (t.video_id ? 'youtube' : 'local'),
    kind: t.kind || 'music',
    downloaded: t.downloaded ?? !!t.path,
    liked: !!t.liked,
  };
}
/** True when the item needs the network (YouTube song that is not on the device). */
export const needsStream = (it) => !!it && !it.path && !!it.video_id;
const sameItem = (a, b) => !!a && !!b && ((a.id && b.id && a.id === b.id) || (a.video_id && b.video_id && a.video_id === b.video_id && !(a.id && b.id)));

// The notification heart (Android engine) follows the current song's liked state.
let syncedLiked = null;
function syncLiked() {
  const liked = !!current()?.liked;
  if (engine?.setLiked && liked !== syncedLiked) { syncedLiked = liked; engine.setLiked(liked); }
}
function emit() { syncLiked(); const snap = snapshot(); subs.forEach((fn) => { try { fn(snap); } catch (e) { console.error(e); } }); dispatchEvent(new CustomEvent('player:change', { detail: snap })); }
function emitTime() { const t = { position: state.position, duration: state.duration, buffered: state.buffered }; timeSubs.forEach((fn) => { try { fn(t); } catch (e) { console.error(e); } }); }
function snapshot() { return { ...state, current: current(), upNext: upNext() }; }
const current = () => state.queue[state.index]?.item || null;

function upNext() {
  const rest = state.queue.slice(state.index + 1);
  let n = 0;
  while (n < rest.length && rest[n].added) n++;
  return { added: rest.slice(0, n), rest: rest.slice(n), all: rest };
}

function hints() {
  engine?.setQueueHints({ hasPrev: state.index > 0 || state.position > 3, hasNext: state.index < state.queue.length - 1 || state.repeat === 'all' });
}

function prefetchUpcoming() {
  const ids = state.queue.slice(state.index + 1, state.index + 3).map((e) => e.item).filter(needsStream).map((it) => it.video_id);
  if (ids.length && online.value) api.youtubePrefetch(ids);
}

function voiceRate(item) {
  const own = item?.id ? Number(LS(`voice.speed.${item.id}`)) : 0;
  return own || Number(settings.value['playback.voice_speed']) || 1;
}

// ---------------------------------------------------------------- loading
async function load(autoplay = true, { fresh = false, startAt = 0 } = {}) {
  cancelAutoSkip();
  const entry = state.queue[state.index];
  if (!entry) return;
  let it = entry.item;
  state.error = null; state.ended = false;
  state.position = 0; state.buffered = 0; state.duration = it.duration_secs || 0;
  // A search result that is already in the library: prefer the downloaded file.
  if (!it.path && it.local_track_id) {
    try { const t = await api.track(it.local_track_id); if (t?.path && t.downloaded !== false) { it = entry.item = toItem({ ...t, thumbnail: t.thumbnail || it.thumbnail }); } } catch {}
  }
  if (needsStream(it) && !online.value) {
    state.loading = null; emit();
    toast(`Skipped “${it.title}” — needs internet`, { kind: 'info' });
    if (!skipForward(true)) { state.error = 'You’re offline and the rest of the queue streams.'; emit(); }
    return;
  }
  state.loading = needsStream(it) ? 'stream' : 'file';
  state.rate = it.kind === 'voice' || it.kind === 'unsure' ? voiceRate(it) : 1;
  emit(); emitTime();
  engine.setMetadata({ title: it.title, artist: it.artist || '', album: it.album || '', artwork: /^https?:/.test(it.thumbnail || '') ? it.thumbnail : null });
  const uid = entry.uid;
  let source;
  try {
    source = needsStream(it)
      ? await api.youtubeStreamUrl(it.video_id, fresh).then((r) => ({ src: r.url, headers: r.headers, videoId: it.video_id, duration: it.duration_secs }))
      : { path: it.path, duration: it.duration_secs };
  } catch (e) {
    if (state.queue[state.index]?.uid !== uid) return;
    return fail(`Couldn’t start the stream: ${e.message || e}`);
  }
  if (state.queue[state.index]?.uid !== uid) return; // skipped meanwhile
  const ok = await engine.load(source);
  if (!ok || state.queue[state.index]?.uid !== uid) return;
  if (failedUid === uid) failedUid = null; // new source loaded: it may fail (once) again
  engine.setRate(state.rate);
  engine.setVolume(state.volume);
  state.loading = null;
  hints();
  prefetchUpcoming();
  if (startAt > 1) engine.seek(startAt);
  if (autoplay) engine.play();
  emit();
}

function fail(message) {
  const entry = state.queue[state.index];
  if (entry && failedUid === entry.uid) return; // already handled for this song
  failedUid = entry?.uid ?? null;
  const it = current();
  const at = state.position;
  // A refused stream link (HTTP 403/410): links are bound to the network that resolved
  // them and expire, so fetch a fresh one once and carry on where the song was.
  if (entry && needsStream(it) && /expired|403|410/i.test(message) && retriedUid !== entry.uid && online.value) {
    retriedUid = entry.uid;
    state.error = null;
    state.loading = 'stream';
    emit();
    load(true, { fresh: true, startAt: at });
    return;
  }
  state.loading = null;
  state.playing = false;
  state.error = /expired/i.test(message) ? 'YouTube refused this stream' : message;
  emit();
  const hasNext = state.index < state.queue.length - 1;
  // Failed at the very start: move on so the music keeps going, but only a few songs in a
  // row, and never behind the user's back: any control cancels the pending skip.
  if (at < 1 && hasNext && errorStreak < MAX_AUTO_SKIPS - 1) {
    errorStreak++;
    toast(`Couldn’t play “${it?.title || 'this song'}”, skipping`, { kind: 'danger', sub: state.error });
    skipTimer = setTimeout(() => { skipTimer = null; skipForward(true); }, 1200);
  } else if (at < 1 && hasNext) {
    errorStreak = 0;
    state.error = `${MAX_AUTO_SKIPS} songs in a row couldn’t play. Check your connection, then press play.`;
    emit();
    toast('Stopped skipping: several songs couldn’t play', { kind: 'danger', sub: 'Check your internet connection and try again.', ms: 8000 });
  } else {
    toast(state.error, { kind: 'danger', action: hasNext ? { label: 'Skip', run: () => player.next() } : null });
  }
}

/** Moves to the next playable entry. Returns false at the end of the queue. */
function skipForward(auto) {
  const n = state.queue.length;
  for (let step = 1; step <= n; step++) {
    let i = state.index + step;
    if (i >= n) { if (state.repeat === 'all' || !auto) i -= n; else return false; }
    if (i === state.index && auto) return false;
    const it = state.queue[i]?.item;
    if (!online.value && needsStream(it)) continue;
    state.index = i;
    load(true);
    return true;
  }
  return false;
}

function onEngineState(s) {
  state.playing = s.playing;
  state.buffering = s.buffering;
  if (s.playing) {
    state.loading = null;
    errorStreak = 0;
    const entry = state.queue[state.index];
    if (entry && startedFor !== entry.uid) {
      startedFor = entry.uid;
      const it = entry.item;
      if (it.id) api.recordPlay(it.id).catch(() => {});
      else if (it.video_id) api.recordPlay('', {
        video_id: it.video_id, title: it.title, artist: it.artist || '', album: it.album,
        duration_secs: it.duration_secs || null, thumbnail: it.thumbnail, explicit: !!it.explicit,
      }).catch(() => {});
    }
  }
  if (s.error) return fail(s.error);
  if (s.ended) return onEnded();
  engine.setPlaybackState?.(s.playing);
  emit();
}

function onEnded() {
  if (state.sleep?.mode === 'end') { state.sleep = null; applySleepFade(); state.playing = false; emit(); toast('Sleep timer — stopped at the end of the song', { kind: 'info' }); return; }
  if (state.repeat === 'one') { engine.seek(0); engine.play(); return; }
  if (!skipForward(true)) { state.playing = false; state.ended = true; emit(); }
}

function onEngineTime(t) {
  state.position = t.position;
  if (t.duration) state.duration = t.duration;
  applySleepFade();
  state.buffered = needsStream(current()) ? t.buffered : (t.duration || state.duration);
  emitTime();
}

function onRemote(r) {
  switch (r.action) {
    case 'play': player.resume(); break;
    case 'pause': player.pause(); break;
    case 'next': player.next(); break;
    case 'prev': player.prev(); break;
    case 'seek': if (r.position != null) player.seek(r.position); break;
    case 'like': player.toggleLike(); break;
  }
}

// ---------------------------------------------------------------- sleep timer
// "Sleep timer fades out" (setting playback.sleep_fade, default on): the volume ramps down
// linearly over the final SLEEP_FADE_SECS before the timer stops playback.
const SLEEP_FADE_SECS = 30;
let fadeGain = 1;
function sleepFadeOn() { return settings.value['playback.sleep_fade'] !== 'false'; }
function applySleepFade() {
  let g = 1;
  if (state.sleep && sleepFadeOn()) {
    const left = state.sleep.mode === 'end'
      ? Math.max(0, (state.duration || 0) - state.position)
      : Math.max(0, (state.sleep.endsAt - Date.now()) / 1000);
    if (state.sleep.mode === 'min' || state.duration) g = Math.min(1, left / SLEEP_FADE_SECS);
  }
  if (Math.abs(g - fadeGain) > 0.005 || (g === 1 && fadeGain !== 1)) { fadeGain = g; engine?.setVolume(state.volume * g); }
}
function tickSleep() {
  clearInterval(sleepTimer);
  applySleepFade();
  if (state.sleep?.mode !== 'min') return;
  sleepTimer = setInterval(() => {
    if (!state.sleep || state.sleep.mode !== 'min') { clearInterval(sleepTimer); return; }
    applySleepFade();
    if (Date.now() >= state.sleep.endsAt) {
      clearInterval(sleepTimer);
      state.sleep = null;
      engine.pause();
      applySleepFade();
      toast('Sleep timer — playback paused', { kind: 'info' });
    }
    emit();
  }, 1000);
}

function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const wrap = (items, added = false) => items.map((t) => ({ uid: ++uidSeq, item: toItem(t), added }));

// ---------------------------------------------------------------- public API
export const player = {
  get state() { return snapshot(); },
  get current() { return current(); },
  get engineName() { return engine?.name || 'none'; },

  /** Must be called once at boot. */
  async init() {
    engine = await createEngine();
    engine.on('state', onEngineState);
    engine.on('time', onEngineTime);
    engine.on('remote', onRemote);
    engine.setVolume(state.volume);
    addEventListener('library:changed', () => player.refreshCurrent());
    online.subscribe(() => emit());
    emit();
    return engine.name;
  },

  subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
  onTime(fn) { timeSubs.add(fn); fn({ position: state.position, duration: state.duration, buffered: state.buffered }); return () => timeSubs.delete(fn); },

  /** Replaces the queue with `items` and plays items[index]. context: { type, id?, name }. */
  play(items, index = 0, context = null) {
    cancelAutoSkip();
    const list = (items || []).filter(Boolean);
    if (!list.length) return;
    index = Math.min(Math.max(0, index), list.length - 1);
    let queue = wrap(list);
    originalOrder = null;
    if (state.shuffle) {
      originalOrder = queue.slice();
      const first = queue[index];
      queue = [first, ...shuffleArray(queue.filter((e) => e !== first))];
      index = 0;
    }
    state.queue = queue;
    state.index = index;
    state.context = context;
    errorStreak = 0;
    load(true);
  },
  /** Plays one item, keeping it as a one-song queue (context optional). */
  playItem(item, context = null) { player.play([item], 0, context); },
  /** Shuffle-plays a list (turns shuffle on). */
  shufflePlay(items, context = null) {
    if (!items?.length) return;
    state.shuffle = true; LS('player.shuffle', '1');
    player.play(items, Math.floor(Math.random() * items.length), context);
  },

  toggle() { if (!current()) return; if (state.playing) player.pause(); else player.resume(); },
  pause() { cancelAutoSkip(); engine?.pause(); },
  resume() {
    cancelAutoSkip();
    if (!current()) return;
    if (state.error || state.ended) { state.ended = false; return load(true); }
    if (state.loading) return;
    engine.play();
  },
  next() { cancelAutoSkip(); if (state.queue.length) { errorStreak = 0; if (!skipForward(false)) emit(); } },
  prev() {
    cancelAutoSkip();
    if (!current()) return;
    if (state.position > 3 || state.index === 0) { engine.seek(0); if (!state.playing) engine.play(); return; }
    state.index -= 1;
    load(true);
  },
  seek(secs) { cancelAutoSkip(); engine?.seek(Math.max(0, Math.min(secs, state.duration || secs))); },
  seekBy(delta) { player.seek(state.position + delta); },
  seekFraction(f) { if (state.duration) player.seek(f * state.duration); },
  setVolume(v) { state.volume = Math.min(1, Math.max(0, v)); engine?.setVolume(state.volume * fadeGain); LS('player.volume', String(state.volume)); emit(); },
  /** True when the active engine can route audio to a chosen output device. */
  get canSetOutput() { return !!engine?.canSetSink; },
  /** Routes playback to an output device id (from enumerateDevices). Resolves false when unsupported. */
  async setOutput(id) { return (await engine?.setSinkId?.(id)) || false; },

  toggleShuffle() {
    state.shuffle = !state.shuffle;
    LS('player.shuffle', state.shuffle ? '1' : '0');
    const cur = state.queue[state.index];
    if (cur) {
      const head = state.queue.slice(0, state.index + 1);
      const { added, rest } = upNext();
      if (state.shuffle) {
        originalOrder = state.queue.slice();
        state.queue = [...head, ...added, ...shuffleArray(rest.slice())];
      } else if (originalOrder) {
        const remaining = new Set(rest);
        const restored = originalOrder.filter((e) => remaining.has(e));
        const extra = rest.filter((e) => !restored.includes(e));
        state.queue = [...head, ...added, ...restored, ...extra];
        originalOrder = null;
      }
    }
    hints(); prefetchUpcoming(); emit();
  },
  cycleRepeat() { state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat] || 'off'; LS('player.repeat', state.repeat); hints(); emit(); },
  setRepeat(mode) { state.repeat = mode; LS('player.repeat', mode); hints(); emit(); },

  // ---- queue editing ----
  /** Inserts items right after the current song (before other "added" songs). */
  playNext(items) {
    const list = [].concat(items).filter(Boolean);
    if (!current()) return player.play(list, 0);
    state.queue.splice(state.index + 1, 0, ...wrap(list, true));
    prefetchUpcoming(); hints(); emit();
  },
  /** Appends items after the other songs the user added ("Added by you"). */
  addToQueue(items) {
    const list = [].concat(items).filter(Boolean);
    if (!current()) return player.play(list, 0);
    const pos = state.index + 1 + upNext().added.length;
    state.queue.splice(pos, 0, ...wrap(list, true));
    prefetchUpcoming(); hints(); emit();
  },
  /** Removes the queue entry with this uid (never the current one). */
  remove(uid) {
    const i = state.queue.findIndex((e) => e.uid === uid);
    if (i < 0 || i === state.index) return;
    state.queue.splice(i, 1);
    if (i < state.index) state.index--;
    hints(); prefetchUpcoming(); emit();
  },
  /** Moves entry `uid` to sit before entry `beforeUid` (null = end). Dropping into "Added by you" marks it added. */
  move(uid, beforeUid) {
    const from = state.queue.findIndex((e) => e.uid === uid);
    if (from <= state.index) return;
    const [e] = state.queue.splice(from, 1);
    let to = beforeUid == null ? state.queue.length : state.queue.findIndex((x) => x.uid === beforeUid);
    if (to < 0) to = state.queue.length;
    if (to <= state.index) to = state.index + 1;
    e.added = to === state.index + 1 ? true : !!state.queue[to - 1]?.added;
    state.queue.splice(to, 0, e);
    prefetchUpcoming(); hints(); emit();
  },
  /** Jumps to a queue entry and plays it. */
  jump(uid) { const i = state.queue.findIndex((e) => e.uid === uid); if (i >= 0) { state.index = i; load(true); } },
  clearAdded() { const { added } = upNext(); const drop = new Set(added); state.queue = state.queue.filter((e) => !drop.has(e)); hints(); emit(); },
  /** Removes everything after the current song. */
  clearQueue() { state.queue = state.queue.slice(0, state.index + 1); originalOrder = null; hints(); emit(); },
  shuffleUpNext() { const { added, rest } = upNext(); state.queue = [...state.queue.slice(0, state.index + 1), ...added, ...shuffleArray(rest.slice())]; prefetchUpcoming(); emit(); },
  /** Stops and empties the player. */
  stop() { cancelAutoSkip(); engine?.stop?.(); state.queue = []; state.index = -1; state.context = null; state.playing = false; state.error = null; state.loading = null; state.position = state.duration = 0; emit(); emitTime(); },

  // ---- current song actions ----
  async toggleLike() {
    const it = current();
    if (!it) return;
    const updated = await likeItem(it);
    if (updated) player.patchItem(it, updated);
  },
  /** Downloads the current song (stream → keep offline). */
  download() { const it = current(); if (it) return startDownload(it); },
  /** Replaces matching queue items' fields (after like / download / library refresh). */
  patchItem(match, fields) {
    let changed = false;
    for (const e of state.queue) if (sameItem(e.item, match)) { e.item = toItem({ ...e.item, ...fields, thumbnail: fields.thumbnail || e.item.thumbnail }); changed = true; }
    if (changed) emit();
  },
  /** Re-reads the current song from the library (picks up a finished download). */
  async refreshCurrent() {
    const it = current();
    const id = it?.id || it?.local_track_id;
    if (!id) return;
    try { const t = await api.track(id); if (t) player.patchItem(it, { ...t, id: t.id }); } catch {}
  },

  // ---- sleep timer ----
  /** minutes: number → stop after N minutes; 'end' → stop at end of song; null → off. */
  setSleep(minutes) {
    if (minutes == null || minutes === 'off') state.sleep = null;
    else if (minutes === 'end') state.sleep = { mode: 'end' };
    else state.sleep = { mode: 'min', minutes, endsAt: Date.now() + minutes * 60000 };
    tickSleep(); emit();
  },
  addSleep(minutes = 10) {
    if (state.sleep?.mode === 'min') state.sleep = { ...state.sleep, endsAt: state.sleep.endsAt + minutes * 60000 };
    else return player.setSleep(minutes);
    tickSleep(); emit();
  },
  /** Seconds until the sleep timer stops playback (null when off). */
  sleepRemaining() {
    if (!state.sleep) return null;
    if (state.sleep.mode === 'end') return Math.max(0, (state.duration || 0) - state.position);
    return Math.max(0, Math.round((state.sleep.endsAt - Date.now()) / 1000));
  },

  // ---- voice speed ----
  /** Sets the speed for the current voice recording (remembered per recording). */
  setVoiceSpeed(rate) {
    const it = current();
    state.rate = rate;
    if (it?.id) LS(`voice.speed.${it.id}`, String(rate));
    if (it && (it.kind === 'voice' || it.kind === 'unsure')) engine?.setRate(rate);
    emit();
  },
};
