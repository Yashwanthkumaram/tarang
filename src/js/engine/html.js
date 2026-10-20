// HTML <audio> playback engine + Media Session API (desktop, browser preview, and the
// Android fallback when the native `playback` plugin is unavailable).
// Implements the engine interface from docs/API-v2.md "Playback engine"; see engine/index.js.
//
// Android without the native engine keeps the D21 workaround: Tauri's asset protocol
// fails range requests that don't start at byte 0, so local files are read once with
// fetch() and played from a Blob URL (the previous Blob URL is revoked on track change).

import { fileSrc, isAndroid, isTauri } from '../api.js';
import { mockMediaUrl } from '../mock.js';

export function createHtmlEngine() {
  const audio = new Audio();
  audio.preload = 'auto';
  const subs = { time: new Set(), state: new Set(), remote: new Set() };
  const emit = (ev, payload) => subs[ev].forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
  const state = { playing: false, buffering: false, ended: false, error: null };
  const setState = (patch) => {
    let changed = false;
    for (const k in patch) if (state[k] !== patch[k]) { state[k] = patch[k]; changed = true; }
    if (changed) emit('state', { ...state });
  };
  let blobUrl = null;
  let loadSeq = 0;
  let durationHint = 0;
  let lastPosState = 0;

  function bufferedEnd() {
    const t = audio.currentTime, b = audio.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i);
    return t;
  }
  const duration = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationHint);
  function emitTime() {
    emit('time', { position: audio.currentTime || 0, duration: duration(), buffered: bufferedEnd() });
    const ms = navigator.mediaSession;
    if (ms?.setPositionState && duration() && Date.now() - lastPosState > 1000) {
      lastPosState = Date.now();
      try { ms.setPositionState({ duration: duration(), position: Math.min(audio.currentTime, duration()), playbackRate: audio.playbackRate || 1 }); } catch {}
    }
  }

  audio.addEventListener('timeupdate', emitTime);
  audio.addEventListener('durationchange', emitTime);
  audio.addEventListener('progress', emitTime);
  audio.addEventListener('playing', () => setState({ playing: true, buffering: false, ended: false, error: null }));
  audio.addEventListener('play', () => setState({ playing: true, ended: false }));
  audio.addEventListener('pause', () => setState({ playing: false, buffering: false }));
  audio.addEventListener('waiting', () => setState({ buffering: true }));
  audio.addEventListener('stalled', () => { if (!audio.paused) setState({ buffering: true }); });
  audio.addEventListener('canplay', () => setState({ buffering: false }));
  audio.addEventListener('ended', () => setState({ playing: false, buffering: false, ended: true }));
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    const codes = { 1: 'Playback was aborted', 2: 'Network error while loading audio', 3: 'The file could not be decoded', 4: 'This audio format or link is not supported' };
    setState({ playing: false, buffering: false, error: codes[audio.error?.code] || 'Playback failed' });
  });

  // Media Session (MPRIS on Linux webkit builds that support it, notification on Android Chrome WebView).
  const ms = navigator.mediaSession;
  const remote = (action) => (d) => emit('remote', { action, position: d?.seekTime });
  if (ms) {
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch {} };
    set('play', remote('play'));
    set('pause', remote('pause'));
    set('previoustrack', remote('prev'));
    set('nexttrack', remote('next'));
    set('seekto', remote('seek'));
  }

  async function resolveSrc({ src, path, duration: d }) {
    if (src) return src;
    if (!path) throw new Error('Nothing to play: no file path or stream link');
    if (!isTauri) return mockMediaUrl(d);
    const url = fileSrc(path);
    if (!isAndroid) return url;
    const res = await fetch(url); // D21: full GET works where later range requests fail
    if (!res.ok) throw new Error(`Could not read the file (HTTP ${res.status})`);
    return URL.createObjectURL(await res.blob());
  }

  return {
    name: 'html',
    /** Loads a source without starting playback. Resolves false when superseded by a newer load. */
    async load(source) {
      const seq = ++loadSeq;
      durationHint = source.duration || 0;
      audio.pause();
      setState({ playing: false, buffering: true, ended: false, error: null });
      let url;
      try {
        url = await resolveSrc(source);
      } catch (e) {
        if (seq === loadSeq) setState({ buffering: false, error: e.message || String(e) });
        return false;
      }
      const ours = isTauri && !source.src && url.startsWith('blob:');
      if (seq !== loadSeq) { if (ours) URL.revokeObjectURL(url); return false; }
      const old = blobUrl;
      blobUrl = ours ? url : null;
      audio.src = url;
      audio.load();
      if (old && old !== url) URL.revokeObjectURL(old);
      emitTime();
      return true;
    },
    async play() {
      try { await audio.play(); } catch (e) {
        if (e?.name === 'AbortError') return;
        setState({ playing: false, buffering: false, error: e?.name === 'NotAllowedError' ? null : (e?.message || 'Playback failed') });
      }
    },
    pause() { audio.pause(); },
    seek(secs) { if (isFinite(secs)) { audio.currentTime = Math.max(0, secs); emitTime(); } },
    setRate(r) { audio.playbackRate = r; audio.defaultPlaybackRate = r; },
    setVolume(v) { audio.volume = Math.min(1, Math.max(0, v)); },
    /** Routes output to an audio device (Chromium only). Resolves false when unsupported. */
    async setSinkId(id) {
      if (typeof audio.setSinkId !== 'function') return false;
      try { await audio.setSinkId(id || ''); return true; } catch { return false; }
    },
    get canSetSink() { return typeof audio.setSinkId === 'function'; },
    setMetadata({ title, artist, album, artwork }) {
      if (!ms || typeof MediaMetadata === 'undefined') return;
      try { ms.metadata = new MediaMetadata({ title: title || '', artist: artist || '', album: album || '', artwork: artwork ? [{ src: artwork, sizes: '512x512' }] : [] }); } catch {}
    },
    setQueueHints({ hasPrev, hasNext }) {
      if (!ms) return;
      try { ms.setActionHandler('previoustrack', hasPrev ? remote('prev') : null); } catch {}
      try { ms.setActionHandler('nexttrack', hasNext ? remote('next') : null); } catch {}
    },
    setPlaybackState(playing) { if (ms) ms.playbackState = playing ? 'playing' : 'paused'; },
    /** Stops and unloads (queue cleared). */
    stop() { loadSeq++; audio.pause(); audio.removeAttribute('src'); audio.load(); setState({ playing: false, buffering: false, ended: false, error: null }); if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; } },
    on(ev, fn) { subs[ev]?.add(fn); return () => subs[ev]?.delete(fn); },
    get state() { return { ...state }; },
    get position() { return audio.currentTime || 0; },
    get duration() { return duration(); },
  };
}
