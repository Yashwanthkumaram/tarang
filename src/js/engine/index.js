// Playback engine selector (docs/API-v2.md "Playback engine").
//
// Every engine implements the same interface, used only by player.js:
//   load({ src?, path?, videoId?, duration? }) → Promise<boolean>   (false = superseded by a newer load)
//   play(), pause(), seek(secs), setRate(r), setVolume(0..1), stop()
//   setMetadata({ title, artist, album, artwork }), setQueueHints({ hasPrev, hasNext }), setPlaybackState(playing)
//   on('time'|'state'|'remote', fn) → unsubscribe
//     time   { position, duration, buffered }            (seconds)
//     state  { playing, buffering, ended, error }        (full snapshot on every change)
//     remote { action: 'play'|'pause'|'next'|'prev'|'seek'|'like', position? }
//   name: 'html' | 'android'
//
// On Android inside Tauri we try engine/android.js (native Media3 ExoPlayer via the
// `playback` mobile plugin). That module must export `createAndroidEngine()` (async,
// throws when the plugin is missing). Any failure falls back to the HTML engine.

import { isAndroid, isTauri } from '../api.js';

export async function createEngine() {
  let forced = null;
  try { forced = localStorage.getItem('engine'); } catch {}
  if (isTauri && isAndroid && forced !== 'html') {
    try {
      const mod = await import('./android.js');
      const make = mod.createAndroidEngine || mod.default;
      const engine = make ? await make() : null;
      if (engine) return engine;
    } catch (e) {
      console.warn('[engine] native Android engine unavailable, using <audio>:', e?.message || e);
    }
  }
  const { createHtmlEngine } = await import('./html.js');
  return createHtmlEngine();
}
