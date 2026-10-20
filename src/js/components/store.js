// Shared app state that several screens show at once: downloads (polled while busy),
// playlists (sidebar + pickers), library stats, platform, settings and the online flag.
// Each store is { value, subscribe(fn) → unsubscribe, refresh() → Promise<value> }.
//
// Window events dispatched here (views may listen):
//   'library:changed'   a download finished, a like/playlist change happened — re-fetch lists
//   'online:changed'    detail = boolean

import { api } from '../api.js';

function createStore(fetcher, initial) {
  const subs = new Set();
  let inflight = null;
  const s = {
    value: initial,
    loaded: false,
    subscribe(fn) { subs.add(fn); if (s.loaded) fn(s.value); return () => subs.delete(fn); },
    set(v) { s.value = v; s.loaded = true; subs.forEach((fn) => { try { fn(v); } catch (e) { console.error(e); } }); },
    async refresh() {
      if (inflight) return inflight;
      inflight = (async () => { try { s.set(await fetcher()); } catch (e) { console.warn('store refresh failed', e); } finally { inflight = null; } return s.value; })();
      return inflight;
    },
  };
  return s;
}

// ---- Online state ----
export const online = createStore(async () => navigator.onLine, navigator.onLine);
online.loaded = true;
addEventListener('online', () => { online.set(true); dispatchEvent(new CustomEvent('online:changed', { detail: true })); });
addEventListener('offline', () => { online.set(false); dispatchEvent(new CustomEvent('online:changed', { detail: false })); });

// ---- Platform + settings ----
export const platform = createStore(() => api.platform(), { os: 'unknown', is_mobile: false });
export const settings = createStore(() => api.settings(), {});
/** Writes a setting and updates the cached map. */
export async function setSetting(key, value) {
  await api.setSetting(key, value);
  settings.set({ ...settings.value, [key]: String(value) });
}

// ---- Library stats + playlists ----
export const stats = createStore(() => api.stats(), null);
export const playlists = createStore(() => api.playlists(), []);

// ---- Downloads ----
export const downloads = createStore(() => api.downloads(), []);
/** download id → item key ("t:<track id>" | "v:<video id>") for downloads started from this UI. */
const startedFor = new Map();
let pollTimer = null;
let lastStates = new Map();

function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = downloads.value.some((d) => d.state === 'active' || d.state === 'queued');
  pollTimer = setTimeout(async () => { await downloads.refresh(); schedulePoll(); }, document.hidden ? 15000 : busy ? 1000 : 6000);
}
downloads.subscribe((list) => {
  let finished = false;
  for (const d of list) {
    const prev = lastStates.get(d.id);
    if (prev && prev !== 'done' && d.state === 'done') finished = true;
  }
  lastStates = new Map(list.map((d) => [d.id, d.state]));
  if (finished) {
    stats.refresh();
    playlists.refresh();
    dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'download' } }));
  }
});

/** Starts polling downloads (called once by app.js). */
export function startDownloadPolling() { downloads.refresh().then(schedulePoll); }
/** Forces an immediate refresh (after starting/pausing a download). */
export function pokeDownloads() { downloads.refresh().then(schedulePoll); }

/** Summary for the top-bar pill, sidebar count and tab badge. */
export function downloadSummary(list = downloads.value) {
  const busy = list.filter((d) => d.state === 'active' || d.state === 'queued');
  const total = busy.reduce((s, d) => s + (d.total_bytes || 0), 0);
  const done = busy.reduce((s, d) => s + (d.downloaded_bytes || 0), 0);
  const eta = busy.reduce((m, d) => Math.max(m, d.eta_secs || 0), 0);
  return { count: busy.length, progress: total ? done / total : 0, eta: busy.length ? eta : null, failed: list.filter((d) => d.state === 'error').length };
}

/** Stable key for a Track or YtTrack. */
export const itemKey = (item) => (item?.id ? `t:${item.id}` : item?.video_id ? `v:${item.video_id}` : '');

/** Records which item a download id belongs to (used by actions.download). */
export function rememberDownload(downloadId, item) {
  if (downloadId) startedFor.set(String(downloadId), item);
}

/** The newest download for a Track / YtTrack, or null. */
export function downloadFor(item, list = downloads.value) {
  if (!item) return null;
  for (const d of list) {
    if (item.id && d.track_id === item.id) return d;
    if (item.local_track_id && d.track_id === item.local_track_id) return d;
    const started = startedFor.get(String(d.id));
    if (started && ((item.id && started.id === item.id) || (item.video_id && started.video_id === item.video_id))) return d;
  }
  return null;
}
