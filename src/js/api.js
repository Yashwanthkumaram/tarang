// =============================================================================
// API BRIDGE (v2). Every call from the UI to the Rust core goes through here.
// The command list mirrors docs/API-v2.md exactly; change that file first.
// In a plain browser (no Tauri) calls are served by mock.js so the UI can be
// previewed and developed without a native build.
// =============================================================================

import { mock, mockListen } from './mock.js';

const T = window.__TAURI__;
export const isTauri = !!(T && T.core);
export const isAndroid = /Android/i.test(navigator.userAgent);

/** Calls a Rust command. Throws an Error carrying the message the core returned. */
export async function invoke(cmd, args = {}) {
  if (!isTauri) return mock(cmd, args);
  try {
    return await T.core.invoke(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : (e?.message || JSON.stringify(e)));
  }
}

/** Subscribes to a Rust event (scan://progress, import://progress, …). Returns an unsubscribe function. */
export async function listen(event, handler) {
  if (!isTauri) return mockListen(event, handler);
  return T.event.listen(event, (ev) => handler(ev.payload));
}

/** URL a webview <audio> element can load for a local file path. */
export function fileSrc(path) {
  if (!isTauri) return path;
  return T.core.convertFileSrc(path);
}

/** Native folder picker (desktop). Returns a path or null. Android returns content URIs, so it uses list_dirs instead. */
export async function pickFolderNative() {
  if (!isTauri || !T.dialog || isAndroid) return null;
  const res = await T.dialog.open({ directory: true, multiple: false });
  return typeof res === 'string' ? res : null;
}

export async function openExternal(url) {
  if (isTauri && T.opener) return T.opener.openUrl(url);
  window.open(url, '_blank', 'noopener');
}

const opt = (v) => (v === undefined ? null : v);

// ---- One wrapper per command in docs/API-v2.md, grouped like the contract ----
export const api = {
  // Library
  stats: () => invoke('get_stats'),
  /** kind: "music"|"voice"|"unsure"; opts: { filter: all|liked|downloaded|device, query, sort: recent|title|artist|album|duration, limit } */
  tracks: (kind = 'music', opts = {}) => invoke('list_tracks', { kind, filter: opt(opts.filter), query: opt(opts.query), sort: opt(opts.sort), limit: opt(opts.limit) }),
  track: (id) => invoke('get_track', { id }),
  recent: (limit) => invoke('list_recent', { limit: opt(limit) }),
  albums: (query) => invoke('list_albums', { query: opt(query) }),
  artists: (query) => invoke('list_artists', { query: opt(query) }),
  setLiked: (id, liked) => invoke('set_liked', { id, liked }),
  likeYoutube: (track, liked) => invoke('like_youtube', { track, liked }),
  /** Pass `track` (a YtTrack) for a stream started from search that has no library id yet; `id` may then be ''. */
  recordPlay: (id, track) => invoke('record_play', { id: id || '', track: opt(track) }),
  setKind: (id, kind) => invoke('set_track_kind', { id, kind }),

  // Playlists
  playlists: () => invoke('list_playlists'),
  playlist: (id) => invoke('get_playlist', { id: Number(id) }),
  createPlaylist: (name, description) => invoke('create_playlist', { name, description: opt(description) }),
  renamePlaylist: (id, name, description) => invoke('rename_playlist', { id: Number(id), name, description: opt(description) }),
  deletePlaylist: (id) => invoke('delete_playlist', { id: Number(id) }),
  /** Add library tracks (trackIds) and/or YouTube results (ytTracks) in one call. */
  addToPlaylist: (playlistId, { trackIds, ytTracks } = {}) => invoke('add_to_playlist', { playlistId: Number(playlistId), trackIds: opt(trackIds), ytTracks: opt(ytTracks) }),
  removeFromPlaylist: (playlistId, entryIds) => invoke('remove_from_playlist', { playlistId: Number(playlistId), entryIds }),
  reorderPlaylist: (playlistId, entryIds) => invoke('reorder_playlist', { playlistId: Number(playlistId), entryIds }),
  downloadPlaylist: (id) => invoke('download_playlist', { id: Number(id) }),

  // YouTube Music
  youtubeSearch: (query, limit = 30) => invoke('youtube_search', { query, limit }),
  /** → { url, headers, resolve_ms, cached }; fresh: skip the cached link (after a 403) */
  youtubeStreamUrl: (videoId, fresh = false) => invoke('youtube_stream_url', { videoId, fresh }),
  /** Fire-and-forget: resolves stream links ahead of time (D22). Never throws. */
  youtubePrefetch: (videoIds) => (videoIds?.length ? invoke('youtube_prefetch', { videoIds }).catch(() => {}) : Promise.resolve()),
  youtubeDownload: (track) => invoke('youtube_download', { track }),
  downloadTrack: (id) => invoke('download_track', { id }),
  youtubeVersion: () => invoke('youtube_version'),
  youtubeUpdate: () => invoke('youtube_update'),
  // App updates from GitHub Releases (D45)
  updateCheck: () => invoke('update_check'),
  /** → "installing" | "needs_permission"; progress on update://progress { downloaded, total } */
  updateInstall: () => invoke('update_install'),

  // Downloads
  downloads: () => invoke('list_downloads'),
  pauseDownload: (id) => invoke('pause_download', { id }),
  resumeDownload: (id) => invoke('resume_download', { id }),
  removeDownload: (id) => invoke('remove_download', { id }),
  retryDownload: (id) => invoke('retry_download', { id }),
  clearFinishedDownloads: () => invoke('clear_finished_downloads'),
  storageInfo: () => invoke('storage_info'),
  clearStreamCache: () => invoke('clear_stream_cache'),

  // Import from other apps (onboarding + Settings only)
  importPreview: (platform, url) => invoke('import_preview', { platform, url }),
  importCommit: (previewId, name, include) => invoke('import_commit', { previewId, name, include }),
  importHistory: () => invoke('list_import_history'),

  // Device scan
  scanConfig: () => invoke('get_scan_config'),
  rules: () => invoke('list_folder_rules'),
  addRule: (path, rule) => invoke('add_folder_rule', { path, rule }),
  removeRule: (id) => invoke('remove_folder_rule', { id }),
  setRuleEnabled: (id, enabled) => invoke('set_folder_rule_enabled', { id, enabled }),
  startScan: () => invoke('start_scan'),
  cancelScan: () => invoke('cancel_scan'),
  isScanning: () => invoke('is_scanning'),
  lastScan: () => invoke('last_scan'),
  reclassify: (id) => invoke('reclassify_track', { id }),
  listDirs: (path) => invoke('list_dirs', { path }),

  // Settings
  settings: () => invoke('get_settings'),
  setSetting: (key, value) => invoke('set_setting', { key, value: String(value) }),
  platform: () => invoke('get_platform'),
};

/** Setting keys from docs/API-v2.md, so views never mistype them. */
export const KEYS = {
  theme: 'ui.theme',
  onboarded: 'ui.onboarded',
  crossfade: 'playback.crossfade_secs',
  gapless: 'playback.gapless',
  voiceSpeed: 'playback.voice_speed',
  sleepFade: 'playback.sleep_fade',
  streamQuality: 'stream.quality',
  streamCacheMb: 'stream.cache_mb',
  downloadQuality: 'download.quality',
  downloadMobileData: 'download.mobile_data',
};
