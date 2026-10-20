// Native Android playback engine: Media3 ExoPlayer in a foreground MediaSessionService,
// driven through the Rust `playback_*` commands (docs/modules/playback.md).
// Implements the engine interface from docs/API-v2.md "Playback engine"; see engine/index.js.
//
// What the native side does on its own (so it keeps working with the screen off):
//   audio focus, pause on headphones unplugged, media notification, lock screen,
//   Bluetooth/headset buttons, stream caching (LRU, `stream.cache_mb`).
// What stays here: the queue. Next/prev from the notification arrive as `remote` events and
// player.js answers with a new load().
//
// Events from Rust: playback://state, playback://ended, playback://error, playback://remote
// (pushed even when the WebView is hidden). Positions are polled every 500 ms only while
// playing and visible; background timers are throttled anyway and nothing needs them.

import { invoke, listen } from '../api.js';

const POLL_MS = 500;

/** Builds the engine; throws when the native plugin is not available (index.js falls back). */
export async function createAndroidEngine() {
  // Probe: fails when the plugin or the commands are not registered in this build.
  let native = await invoke('playback_get_state');

  const subs = { time: new Set(), state: new Set(), remote: new Set() };
  const emit = (ev, payload) => subs[ev].forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
  const state = { playing: false, buffering: false, ended: false, error: null };
  const setState = (patch) => {
    let changed = false;
    for (const k in patch) if (state[k] !== patch[k]) { state[k] = patch[k]; changed = true; }
    if (changed) emit('state', { ...state });
  };

  let loadSeq = 0;
  let loaded = false;
  let durationHint = 0;
  let meta = { title: null, artist: null, album: null, artwork: null };
  let pollTimer = null;

  const secs = (ms) => (ms > 0 ? ms / 1000 : 0);
  const duration = () => secs(native.duration_ms) || durationHint;
  const emitTime = () => emit('time', { position: secs(native.position_ms), duration: duration(), buffered: secs(native.buffered_ms) });

  /** Applies a native snapshot (getState result or a playback://state payload). */
  function apply(s) {
    if (!s || typeof s !== 'object') return;
    native = { ...native, ...s };
    const playing = !!s.playing || (!!s.play_when_ready && !!s.buffering && !s.ended);
    const patch = { playing, buffering: !!s.buffering, ended: !!s.ended };
    if (s.error) patch.error = s.error;
    setState(patch);
    emitTime();
    schedulePoll();
  }

  async function poll() {
    pollTimer = null;
    try { apply(await invoke('playback_get_state')); } catch (e) { console.warn('[engine] getState', e.message); }
  }

  function schedulePoll() {
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    if (pollTimer || !visible || !(state.playing || state.buffering)) return;
    pollTimer = setTimeout(poll, POLL_MS);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  }

  await listen('playback://state', apply);
  await listen('playback://ended', (s) => apply({ ...s, ended: true, playing: false }));
  await listen('playback://error', (e) => {
    const expired = e?.http_status === 403 || e?.http_status === 410;
    setState({ playing: false, buffering: false, error: expired ? 'Stream link expired, try again' : (e?.message || 'Playback failed') });
  });
  await listen('playback://remote', (r) => {
    if (!r?.action) return;
    emit('remote', r.position != null ? { action: r.action, position: r.position } : { action: r.action });
  });

  // A song may still be loaded natively (e.g. the WebView reloaded while it played).
  apply(native);

  const call = (cmd, args) => invoke(cmd, args).catch((e) => { console.warn(`[engine] ${cmd}`, e.message); throw e; });
  const quiet = (cmd, args) => call(cmd, args).catch(() => {});

  return {
    name: 'android',

    /** Loads a source without starting playback. Resolves false when superseded by a newer load. */
    async load({ src, path, videoId, duration: d } = {}) {
      const seq = ++loadSeq;
      durationHint = d || 0;
      setState({ playing: false, buffering: true, ended: false, error: null });
      try {
        let url = src || null;
        if (!url && !path && videoId) url = (await invoke('youtube_stream_url', { videoId })).url;
        if (!url && !path) throw new Error('Nothing to play: no file path or stream link');
        if (seq !== loadSeq) return false;
        const s = await invoke('playback_load', {
          url: path ? null : url, path: path || null, videoId: videoId || null,
          title: meta.title, artist: meta.artist, album: meta.album, artworkUrl: meta.artwork,
          autoplay: false,
        });
        if (seq !== loadSeq) return false;
        loaded = true;
        apply(s);
        return true;
      } catch (e) {
        if (seq === loadSeq) setState({ buffering: false, error: e.message || String(e) });
        return false;
      }
    },

    async play() {
      try { await call('playback_play'); setState({ playing: true, ended: false, error: null }); schedulePoll(); }
      catch (e) { setState({ playing: false, buffering: false, error: e.message || 'Playback failed' }); }
    },
    pause() { quiet('playback_pause'); },
    seek(s) {
      if (!isFinite(s)) return;
      native.position_ms = Math.max(0, s) * 1000;
      emitTime();
      quiet('playback_seek', { ms: Math.round(Math.max(0, s) * 1000) });
    },
    setRate(r) { quiet('playback_set_rate', { rate: r }); },
    setVolume(v) { quiet('playback_set_volume', { volume: Math.min(1, Math.max(0, v)) }); },

    /** Notification / lock-screen metadata. `artwork` must be an http(s) URL to show. `liked` is optional. */
    setMetadata({ title, artist, album, artwork, liked } = {}) {
      meta = { title: title || null, artist: artist || null, album: album || null, artwork: /^https?:/.test(artwork || '') ? artwork : null };
      if (loaded) quiet('playback_set_metadata', { title: meta.title, artist: meta.artist, album: meta.album, artworkUrl: meta.artwork });
      if (typeof liked === 'boolean') quiet('playback_set_liked', { liked });
    },
    /** Fills the heart on the notification's like button. Android-only extra. */
    setLiked(liked) { quiet('playback_set_liked', { liked: !!liked }); },
    setQueueHints({ hasPrev, hasNext } = {}) { quiet('playback_set_queue_hints', { hasPrev: !!hasPrev, hasNext: !!hasNext }); },
    /** The native session reports the real player state itself. */
    setPlaybackState() {},

    /** Stops and unloads (queue cleared); the notification goes away. */
    stop() {
      loadSeq++;
      loaded = false;
      native = { ...native, position_ms: 0, duration_ms: 0, buffered_ms: 0 };
      setState({ playing: false, buffering: false, ended: false, error: null });
      quiet('playback_stop');
    },

    on(ev, fn) { subs[ev]?.add(fn); return () => subs[ev]?.delete(fn); },
    get state() { return { ...state }; },
    get position() { return secs(native.position_ms); },
    get duration() { return duration(); },
  };
}

export default createAndroidEngine;
