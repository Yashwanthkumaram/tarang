// Mock backend for browser previews (no Tauri). Shapes follow docs/API-v2.md exactly;
// the data mirrors the approved designs so a preview looks like design/screens/*.html.
// State lives in memory and resets on reload. Events (scan://progress, import://progress)
// are delivered through mockListen().

const now = Math.floor(Date.now() / 1000);
const H = 3600, D = 86400;
const MUSIC_DIR = '/home/me/Music/Tarang';

// ---- Events ----------------------------------------------------------------
const listeners = new Map();
export function mockListen(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}
function emit(event, payload) { listeners.get(event)?.forEach((h) => { try { h(payload); } catch (e) { console.error(e); } }); }

// ---- Silent audio so the browser preview can "play" (8 kHz, 8-bit mono WAV) ----
const mediaCache = new Map();
/** Blob URL of `secs` seconds of silence, used for every mock file and stream. */
export function mockMediaUrl(secs = 180) {
  secs = Math.max(1, Math.min(900, Math.round(secs || 180)));
  if (mediaCache.has(secs)) return mediaCache.get(secs);
  const rate = 8000, n = rate * secs, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  mediaCache.set(secs, url);
  return url;
}

// ---- Tracks ----------------------------------------------------------------
let seq = 100;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

// Release years (Track.year — not yet in the Rust model; see open issue) so the Now playing
// meta line reads "Artist · Album · Year · 3:58" as designed.
const YEARS = { Dreamland: 2020, 'Stranger in the Alps': 2017, 'Con Todo El Mundo': 2018, Currents: 2015, AM: 2013, Blonde: 2016, Rumours: 1977,
  'Bon Iver, Bon Iver': 2011, 'For Emma, Forever Ago': 2007, 'Random Access Memories': 2013, "Hurry Up, We're Dreaming": 2011, 'Awaken, My Love!': 2016,
  Punisher: 2020, 'The Dark Side of the Moon': 1973, 'Aashiqui 2': 2013, 'Jaane Tu… Ya Jaane Na': 2008, 'Actual Life 3': 2022, 'The Slow Rush': 2020, 'Depression Cherry': 2015 };

function song(title, artist, album, dur, o = {}) {
  const downloaded = o.downloaded ?? true;
  const source = o.source || (o.video_id ? 'youtube' : 'local');
  const fmt = source === 'youtube' ? 'm4a' : (o.format || 'flac');
  return {
    id: uuid(), path: downloaded ? `${source === 'youtube' ? MUSIC_DIR : '/home/me/Music'}/${artist}/${album}/${title}.${fmt}` : null,
    video_id: o.video_id ?? (source === 'youtube' ? `yt${seq}${title.length}`.padEnd(11, 'x').slice(0, 11) : null),
    title, artist, album, year: YEARS[album] ?? null, duration_secs: dur, thumbnail: null, source, kind: 'music',
    downloaded, liked: !!o.liked, play_count: o.plays ?? 0, last_played_at: o.played ?? null, added_at: now - (o.added ?? 30) * D,
    confidence: 0.97, reason: 'has artist tag, music folder', format: downloaded ? fmt : null, sample_rate: 44100, channels: 2,
    bitrate_kbps: fmt === 'flac' ? 920 : 256, size_bytes: downloaded ? Math.round(dur * (fmt === 'flac' ? 115000 : 32000)) : 0, modified_at: now - (o.added ?? 30) * D,
  };
}

const music = [
  song('Heat Waves', 'Glass Animals', 'Dreamland', 238, { source: 'youtube', liked: true, plays: 41, played: now - 300, added: 7 }),
  song('Motion Sickness', 'Phoebe Bridgers', 'Stranger in the Alps', 229, { source: 'youtube', downloaded: false, liked: true, plays: 12, played: now - 2 * H }),
  song('Maria También', 'Khruangbin', 'Con Todo El Mundo', 188, { liked: true, plays: 9, played: now - 5 * H, format: 'mp3' }),
  song('The Less I Know the Better', 'Tame Impala', 'Currents', 216, { source: 'youtube', liked: true, plays: 33, played: now - D }),
  song('Do I Wanna Know?', 'Arctic Monkeys', 'AM', 272, { liked: false, plays: 20, played: now - 2 * D }),
  song('Pink + White', 'Frank Ocean', 'Blonde', 184, { source: 'youtube', downloaded: false, liked: true, plays: 6, played: now - 3 * D }),
  song('Dreams', 'Fleetwood Mac', 'Rumours', 257, { liked: true, plays: 14, played: now - 4 * D }),
  song('Holocene', 'Bon Iver', 'Bon Iver, Bon Iver', 336, { source: 'youtube', downloaded: false, plays: 3, played: now - 6 * D }),
  song('Nights', 'Frank Ocean', 'Blonde', 307, { liked: true, plays: 8, played: now - 8 * D }),
  song('Skinny Love', 'Bon Iver', 'For Emma, Forever Ago', 238, { source: 'youtube', downloaded: false }),
  song('Instant Crush', 'Daft Punk', 'Random Access Memories', 337, { plays: 4, played: now - 9 * D }),
  song('Midnight City', 'M83', "Hurry Up, We're Dreaming", 243, { source: 'youtube', liked: true }),
  song('Redbone', 'Childish Gambino', 'Awaken, My Love!', 327, { source: 'youtube', downloaded: false }),
  song('Kyoto', 'Phoebe Bridgers', 'Punisher', 184, { source: 'youtube', downloaded: false, liked: true }),
  song('Garden Song', 'Phoebe Bridgers', 'Punisher', 221, { source: 'youtube' }),
  song('White Gloves', 'Khruangbin', 'Con Todo El Mundo', 240, { format: 'mp3' }),
  song('Time', 'Pink Floyd', 'The Dark Side of the Moon', 413, {}),
  song('Tum Hi Ho', 'Arijit Singh', 'Aashiqui 2', 262, { source: 'youtube', liked: true }),
  song('Kabhi Kabhi Aditi', 'Rashid Ali', 'Jaane Tu… Ya Jaane Na', 232, {}),
  song('Delete Forever', 'Fred again..', 'Actual Life 3', 254, { source: 'youtube', downloaded: false }),
  song('Borderline', 'Tame Impala', 'The Slow Rush', 237, { source: 'youtube', liked: true }),
  song('Space Song', 'Beach House', 'Depression Cherry', 320, {}),
];

function voiceRec(title, dur, daysAgo, o = {}) {
  const t = song(title, null, null, dur, { added: daysAgo });
  return { ...t, artist: null, album: null, kind: o.kind || 'voice', path: o.path || `/sdcard/Recordings/Voice/${title}.m4a`, format: 'm4a', channels: 1, sample_rate: 16000, bitrate_kbps: 64,
    size_bytes: dur * 24000, confidence: o.conf ?? 0.97, reason: o.reason || 'mono, 16 kHz, no artist tag, recordings folder', last_played_at: o.played ?? null };
}
const voice = [
  voiceRec('Standup notes — 14 Oct', 761, 0, { played: now - 3 * H }),
  voiceRec('Call with landlord', 724, 2),
  voiceRec('Lecture — distributed systems wk 6', 3120, 4),
  voiceRec('PTT-20261009-WA0012', 22, 10, { path: '/sdcard/WhatsApp/Media/WhatsApp Audio/PTT-20261009-WA0012.opus' }),
];
const unsure = [
  voiceRec('Rec 2026-10-14 09.12', 134, 5, { kind: 'unsure', conf: 0.24, reason: 'mono, no artist tag, speech-rate rhythm' }),
  voiceRec('Jam session idea', 63, 12, { kind: 'unsure', conf: 0.16, reason: 'steady beat, no artist tag, mono', path: '/home/me/Music/Scratch/Jam session idea.mp3' }),
];
const allTracks = () => [...music, ...voice, ...unsure];
const findTrack = (id) => allTracks().find((t) => t.id === id) || null;

// ---- YouTube Music catalogue (search results) ---------------------------------
const yt = (video_id, title, artist, album, duration_secs, explicit = false) => ({ video_id, title, artist, album, duration_secs, thumbnail: null, explicit, local_track_id: null });
const ytCatalogue = [
  yt('kPa7bsKwL-c', 'Die With A Smile', 'Lady Gaga, Bruno Mars', 'Die With A Smile', 251),
  yt('V9PVRfjEBTI', 'Birds of a Feather', 'Billie Eilish', 'HIT ME HARD AND SOFT', 210),
  yt('eVli-tstM5E', 'Espresso', 'Sabrina Carpenter', "Short n' Sweet", 175, true),
  yt('ekr2nIex040', 'APT.', 'ROSÉ, Bruno Mars', 'rosie', 169),
  yt('mRD0-GxqHVo', 'Heat Waves', 'Glass Animals', 'Dreamland', 238),
  yt('2SUwOgmvzK4', 'The Less I Know the Better', 'Tame Impala', 'Currents', 216),
  yt('bpOSxM0rNPM', 'Do I Wanna Know?', 'Arctic Monkeys', 'AM', 272),
  yt('9wWoDmkF5Rg', 'Motion Sickness', 'Phoebe Bridgers', 'Stranger in the Alps', 229),
  yt('TWcyIpul8OE', 'Holocene', 'Bon Iver', 'Bon Iver, Bon Iver', 336),
  yt('ssdgFoHLwnk', 'Skinny Love', 'Bon Iver', 'For Emma, Forever Ago', 238),
  yt('dX3k_QDnzHE', 'Midnight City', 'M83', "Hurry Up, We're Dreaming", 243),
  yt('Kp7eSUU9oy8', 'Redbone', 'Childish Gambino', 'Awaken, My Love!', 327),
  yt('a5uQMwRMHcs', 'Instant Crush', 'Daft Punk', 'Random Access Memories', 337),
  yt('Wh8JjVHw6kI', 'Kyoto', 'Phoebe Bridgers', 'Punisher', 184),
  yt('B6mVb3LeYIs', 'Delete Forever', 'Fred again..', 'Actual Life 3', 254),
  yt('uHy8MyOwbfI', 'Borderline', 'Tame Impala', 'The Slow Rush', 237),
  yt('TyxP0XRwP2I', 'Space Song', 'Beach House', 'Depression Cherry', 320),
  yt('Y-BhGa8i1tE', 'Pink + White', 'Frank Ocean', 'Blonde', 184),
  yt('r00ikilDxW4', 'Nights', 'Frank Ocean', 'Blonde', 307),
  yt('mFbCrCxpeJY', 'Dreams', 'Fleetwood Mac', 'Rumours', 257),
];
function withLocal(r) {
  const t = music.find((m) => m.video_id === r.video_id || (m.title === r.title && (m.artist || '') === r.artist.split(',')[0]));
  return { ...r, local_track_id: t ? t.id : null };
}

// ---- Playlists -----------------------------------------------------------------
let entrySeq = 1000;
const byTitle = (t) => music.find((m) => m.title === t);
let playlists = [
  { id: 1, name: 'Late drives', description: 'Night-time, windows down.', imported_from: null, created_at: now - 40 * D, updated_at: now - 2 * D,
    tracks: ['Heat Waves', 'Motion Sickness', 'Maria También', 'The Less I Know the Better', 'Do I Wanna Know?', 'Pink + White', 'Dreams', 'Holocene', 'Nights', 'Midnight City', 'Space Song', 'Borderline'] },
  { id: 2, name: 'Focus — no vocals', description: null, imported_from: null, created_at: now - 90 * D, updated_at: now - 9 * D, tracks: ['Time', 'White Gloves', 'Space Song', 'Instant Crush'] },
  { id: 3, name: 'Gym 2026', description: null, imported_from: 'spotify', created_at: now - 20 * D, updated_at: now - 5 * D, tracks: ['Redbone', 'Delete Forever', 'Borderline', 'Midnight City', 'Do I Wanna Know?'] },
  { id: 4, name: 'Sunday morning', description: 'Slow coffee songs.', imported_from: 'youtube', created_at: now - 12 * D, updated_at: now - 12 * D, tracks: ['Kyoto', 'Garden Song', 'Skinny Love'] },
].map((p) => ({ ...p, entries: p.tracks.map((t) => ({ entry_id: ++entrySeq, track_id: byTitle(t).id })) }));

function playlistShape(p) {
  const tracks = p.entries.map((e) => findTrack(e.track_id)).filter(Boolean);
  return {
    id: p.id, name: p.name, description: p.description ?? null, track_count: tracks.length,
    total_secs: tracks.reduce((s, t) => s + t.duration_secs, 0), downloaded_count: tracks.filter((t) => t.downloaded).length,
    artwork: tracks.map((t) => t.thumbnail).filter(Boolean).slice(0, 4), imported_from: p.imported_from ?? null, is_liked: false,
    created_at: p.created_at, updated_at: p.updated_at,
  };
}
function likedShape() {
  const tracks = music.filter((t) => t.liked);
  return { id: 0, name: 'Liked songs', description: null, track_count: tracks.length, total_secs: tracks.reduce((s, t) => s + t.duration_secs, 0),
    downloaded_count: tracks.filter((t) => t.downloaded).length, artwork: [], imported_from: null, is_liked: true, created_at: now - 365 * D, updated_at: now };
}
const getPl = (id) => { const p = playlists.find((x) => x.id === Number(id)); if (!p) throw new Error(`Playlist ${id} not found`); return p; };

/** Finds or creates the library row for a YouTube result (like_youtube / add_to_playlist). */
function rowForYt(y) {
  let t = music.find((m) => m.video_id === y.video_id) || (y.local_track_id && findTrack(y.local_track_id));
  if (!t) {
    t = song(y.title, y.artist, y.album || '', y.duration_secs || 0, { source: 'youtube', downloaded: false, video_id: y.video_id, added: 0 });
    t.thumbnail = y.thumbnail || null;
    music.unshift(t);
  }
  return t;
}

// ---- Downloads -----------------------------------------------------------------
let downloads = [
  { id: 'd1', kind: 'youtube', name: 'Glass Animals – Tangerine', state: 'active', progress: 0.62, downloaded_bytes: 4.6e6, total_bytes: 7.4e6, speed_bps: 1.8e6, eta_secs: 2, track_id: null, error: null },
  { id: 'd2', kind: 'youtube', name: 'Phoebe Bridgers – Kyoto', state: 'active', progress: 0.31, downloaded_bytes: 1.9e6, total_bytes: 6.1e6, speed_bps: 1.1e6, eta_secs: 4, track_id: byTitle('Kyoto').id, error: null },
  { id: 'd3', kind: 'youtube', name: 'Fred again.. – Delete Forever', state: 'queued', progress: 0, downloaded_bytes: 0, total_bytes: 0, speed_bps: 0, eta_secs: null, track_id: byTitle('Delete Forever').id, error: null },
  { id: 'd4', kind: 'youtube', name: 'Bon Iver – Re: Stacks', state: 'error', progress: 0.12, downloaded_bytes: 0.9e6, total_bytes: 7.9e6, speed_bps: 0, eta_secs: null, track_id: null, error: 'Network went away at 12% — retry when online' },
  { id: 'd5', kind: 'youtube', name: 'Glass Animals – Heat Waves', state: 'done', progress: 1, downloaded_bytes: 7.6e6, total_bytes: 7.6e6, speed_bps: 0, eta_secs: null, track_id: music[0].id, error: null },
];
let lastTick = Date.now();
function tickDownloads() {
  const dt = (Date.now() - lastTick) / 1000; lastTick = Date.now();
  let activeSlots = 2 - downloads.filter((d) => d.state === 'active').length;
  for (const d of downloads) {
    if (d.state === 'queued' && activeSlots > 0) { d.state = 'active'; d.total_bytes = d.total_bytes || 6.5e6; d.speed_bps = 1.4e6; activeSlots--; }
    if (d.state !== 'active') continue;
    d.downloaded_bytes = Math.min(d.total_bytes, d.downloaded_bytes + d.speed_bps * dt * 0.25);
    d.progress = d.total_bytes ? d.downloaded_bytes / d.total_bytes : 0;
    d.eta_secs = Math.max(0, Math.round((d.total_bytes - d.downloaded_bytes) / (d.speed_bps * 0.25)));
    if (d.progress >= 1) {
      Object.assign(d, { state: 'done', progress: 1, speed_bps: 0, eta_secs: null });
      const t = d.track_id && findTrack(d.track_id);
      if (t) Object.assign(t, { downloaded: true, path: `${MUSIC_DIR}/${t.artist}/${t.title}.m4a`, format: 'm4a', size_bytes: d.total_bytes });
    }
  }
}
function queueDownload(name, trackId) {
  const existing = trackId && downloads.find((d) => d.track_id === trackId && d.state !== 'done');
  if (existing) return existing.id;
  const id = 'd' + (++seq);
  downloads.unshift({ id, kind: 'youtube', name, state: 'queued', progress: 0, downloaded_bytes: 0, total_bytes: 0, speed_bps: 0, eta_secs: null, track_id: trackId || null, error: null });
  return id;
}

// ---- Settings, scan, imports -------------------------------------------------------
let settings = {
  'ui.theme': 'system', 'ui.onboarded': '1', 'playback.crossfade_secs': '0', 'playback.gapless': 'true', 'playback.voice_speed': '1.5',
  'stream.quality': 'high', 'stream.cache_mb': '512', 'download.quality': 'high', 'download.mobile_data': 'false', 'scan.mode': 'selected_folders',
};
try { const o = new URLSearchParams(location.search).get('onboarded'); if (o !== null) settings['ui.onboarded'] = o; } catch {}

let rules = [
  { id: 1, path: MUSIC_DIR, rule: 'app', enabled: true },
  { id: 2, path: '/home/me/Music', rule: 'include', enabled: true },
  { id: 3, path: '/home/me/Downloads', rule: 'include', enabled: true },
  { id: 4, path: '/sdcard/WhatsApp/Media/WhatsApp Audio', rule: 'exclude', enabled: true },
];
let scanTimer = null, scanning = false;
let lastScanReport = { files_seen: 1321, audio_found: 1321, added: 4, updated: 0, removed: 0, music: 1284, voice: 37, unsure: 3, skipped: 212, current_path: '', finished: true, elapsed_ms: 11300 };

let importHistory = [
  { id: 1, platform: 'spotify', name: 'Gym 2026', imported_at: now - 20 * D, total: 5, matched: 5, playlist_id: 3 },
  { id: 2, platform: 'youtube', name: 'Sunday morning', imported_at: now - 12 * D, total: 4, matched: 3, playlist_id: 4 },
];
const previews = new Map();

// ---- Command dispatcher ----------------------------------------------------------
const sorters = {
  recent: (a, b) => b.added_at - a.added_at,
  title: (a, b) => a.title.localeCompare(b.title),
  artist: (a, b) => (a.artist || '').localeCompare(b.artist || ''),
  album: (a, b) => (a.album || '').localeCompare(b.album || ''),
  duration: (a, b) => a.duration_secs - b.duration_secs,
};
const matchQ = (t, q) => !q || `${t.title} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q.toLowerCase());
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

export async function mock(cmd, args = {}) {
  await new Promise((r) => setTimeout(r, cmd === 'youtube_search' || cmd === 'import_preview' ? 350 : 30));
  return clone(dispatch(cmd, args));
}

function dispatch(cmd, a) {
  switch (cmd) {
    // Library
    case 'get_stats': return {
      music: music.length, voice: voice.length, unsure: unsure.length, liked: music.filter((t) => t.liked).length,
      downloaded: music.filter((t) => t.downloaded).length, playlists: playlists.length + 1,
      total_bytes: allTracks().reduce((s, t) => s + (t.size_bytes || 0), 0), total_secs: music.reduce((s, t) => s + t.duration_secs, 0),
      albums: new Set(music.map((t) => t.album)).size, artists: new Set(music.map((t) => t.artist)).size,
    };
    case 'list_tracks': {
      let rows = { music, voice, unsure }[a.kind || 'music'] || [];
      const f = a.filter || 'all';
      rows = rows.filter((t) => matchQ(t, a.query) && (f === 'all' || (f === 'liked' && t.liked) || (f === 'downloaded' && t.downloaded) || (f === 'device' && t.source === 'local')));
      rows = rows.slice().sort(sorters[a.sort || 'recent'] || sorters.recent);
      return a.limit ? rows.slice(0, a.limit) : rows;
    }
    case 'get_track': return findTrack(a.id);
    case 'list_recent': return allTracks().filter((t) => t.last_played_at).sort((x, y) => y.last_played_at - x.last_played_at).slice(0, a.limit || 20);
    case 'list_albums': case 'list_artists': {
      const key = cmd === 'list_albums' ? 'album' : 'artist';
      const map = new Map();
      for (const t of music) {
        if (!t[key] || !matchQ(t, a.query)) continue;
        const k = key === 'album' ? `${t.album}\u0000${t.artist}` : t.artist;
        const e = map.get(k) || { name: t[key], artist: key === 'album' ? t.artist : undefined, track_count: 0, artwork: t.thumbnail || null };
        e.track_count++; map.set(k, e);
      }
      return [...map.values()].sort((x, y) => x.name.localeCompare(y.name));
    }
    case 'set_liked': { const t = findTrack(a.id); if (!t) throw new Error('Track not found'); t.liked = !!a.liked; return t; }
    case 'like_youtube': { const t = rowForYt(a.track); t.liked = !!a.liked; return t; }
    case 'record_play': { const t = (a.id && findTrack(a.id)) || (a.track ? rowForYt(a.track) : null); if (t) { t.play_count++; t.last_played_at = Math.floor(Date.now() / 1000); } return null; }
    case 'set_track_kind': {
      for (const list of [music, voice, unsure]) {
        const i = list.findIndex((t) => t.id === a.id);
        if (i >= 0) { const [t] = list.splice(i, 1); t.kind = a.kind; t.confidence = 1; t.reason = 'Set by you'; ({ music, voice, unsure })[a.kind].unshift(t); }
      }
      return null;
    }

    // Playlists
    case 'list_playlists': return [likedShape(), ...playlists.map(playlistShape)];
    case 'get_playlist': {
      if (Number(a.id) === 0) return { playlist: likedShape(), entries: music.filter((t) => t.liked).map((t, i) => ({ entry_id: i + 1, position: i, track: t })) };
      const p = getPl(a.id);
      return { playlist: playlistShape(p), entries: p.entries.map((e, i) => ({ entry_id: e.entry_id, position: i, track: findTrack(e.track_id) })).filter((e) => e.track) };
    }
    case 'create_playlist': {
      const p = { id: Math.max(0, ...playlists.map((x) => x.id)) + 1, name: a.name, description: a.description ?? null, imported_from: null, created_at: now, updated_at: now, entries: [] };
      playlists.push(p); return playlistShape(p);
    }
    case 'rename_playlist': { const p = getPl(a.id); p.name = a.name; p.description = a.description ?? null; p.updated_at = Math.floor(Date.now() / 1000); return playlistShape(p); }
    case 'delete_playlist': playlists = playlists.filter((p) => p.id !== Number(a.id)); return null;
    case 'add_to_playlist': {
      const p = getPl(a.playlistId);
      const ids = [...(a.trackIds || []), ...(a.ytTracks || []).map((y) => rowForYt(y).id)];
      ids.forEach((id) => p.entries.push({ entry_id: ++entrySeq, track_id: id }));
      p.updated_at = Math.floor(Date.now() / 1000);
      return playlistShape(p);
    }
    case 'remove_from_playlist': { const p = getPl(a.playlistId); p.entries = p.entries.filter((e) => !a.entryIds.includes(e.entry_id)); return playlistShape(p); }
    case 'reorder_playlist': { const p = getPl(a.playlistId); p.entries = a.entryIds.map((id) => p.entries.find((e) => e.entry_id === id)).filter(Boolean); return playlistShape(p); }
    case 'download_playlist': {
      const tracks = Number(a.id) === 0 ? music.filter((t) => t.liked) : getPl(a.id).entries.map((e) => findTrack(e.track_id));
      return tracks.filter((t) => t && !t.downloaded && t.video_id).map((t) => queueDownload(`${t.artist} – ${t.title}`, t.id));
    }

    // YouTube Music
    case 'youtube_search': {
      const q = (a.query || '').toLowerCase().trim();
      if (q === 'zzz' || q === 'no results') return [];
      const words = q.split(/\s+/).filter(Boolean);
      const hits = ytCatalogue.filter((r) => !words.length || words.some((w) => `${r.title} ${r.artist} ${r.album}`.toLowerCase().includes(w)));
      return (hits.length ? hits : ytCatalogue.slice(0, 8)).slice(0, a.limit || 30).map(withLocal);
    }
    case 'youtube_stream_url': { const r = ytCatalogue.find((x) => x.video_id === a.videoId) || music.find((x) => x.video_id === a.videoId); return { url: mockMediaUrl(r?.duration_secs || 200), resolve_ms: 420, cached: false }; }
    case 'youtube_prefetch': return null;
    case 'youtube_download': {
      const t = rowForYt(a.track);
      return queueDownload(`${a.track.artist} – ${a.track.title}`, t.id);
    }
    case 'download_track': { const t = findTrack(a.id); if (!t) throw new Error('Track not found'); if (!t.video_id) throw new Error('This song has no YouTube Music id'); return queueDownload(`${t.artist} – ${t.title}`, t.id); }
    case 'youtube_version': return '2026.08.19';
    case 'youtube_update': return 'yt-dlp is up to date (2026.08.19)';
    case 'update_check': return { available: false, current: '0.1.0', version: '0.1.0', notes: '', published_at: null, page_url: 'https://github.com/Yashwanthkumaram/tarang/releases', asset_size: 0 };
    case 'update_install': throw new Error('Tarang is already up to date');

    // Downloads
    case 'list_downloads': tickDownloads(); return downloads;
    case 'pause_download': { const d = downloads.find((x) => x.id === a.id); if (d) Object.assign(d, { state: 'paused', speed_bps: 0, eta_secs: null }); return null; }
    case 'resume_download': { const d = downloads.find((x) => x.id === a.id); if (d) Object.assign(d, { state: 'active', speed_bps: 1.4e6 }); return null; }
    case 'retry_download': { const d = downloads.find((x) => x.id === a.id); if (d) Object.assign(d, { state: 'queued', error: null, speed_bps: 0 }); return null; }
    case 'remove_download': downloads = downloads.filter((d) => d.id !== a.id); return null;
    case 'clear_finished_downloads': downloads = downloads.filter((d) => d.state !== 'done'); return null;
    case 'storage_info': return { used_bytes: 4.2e9, free_bytes: 38.6e9, downloads_bytes: 2.9e9, cache_bytes: 182e6 };
    case 'clear_stream_cache': return null;

    // Import
    case 'import_preview': {
      if (!/^https?:\/\//.test(a.url || '')) throw new Error('That doesn’t look like a link. Paste a playlist URL from the app’s Share menu.');
      const preview_id = 'pv' + (++seq);
      const pick = (i) => ytCatalogue[i % ytCatalogue.length];
      const items = [
        ...[0, 1, 2, 3, 5, 6, 10, 11].map((i) => ({ title: pick(i).title, artist: pick(i).artist, duration_secs: pick(i).duration_secs, status: 'matched', match: withLocal(pick(i)), alternatives: [] })),
        { title: 'Blinding Lights (Live)', artist: 'The Weeknd', duration_secs: 262, status: 'review', match: yt('fHI8X4OXluQ', 'Blinding Lights', 'The Weeknd', 'After Hours', 201), alternatives: [yt('4NRXx6U8ABQ', 'Blinding Lights (Live at SNL)', 'The Weeknd', '', 268)] },
        { title: 'Untitled demo 3', artist: 'Local band', duration_secs: 143, status: 'not_found', match: null, alternatives: [] },
      ];
      const platform = a.platform;
      const name = { spotify: 'Road trip ’26', youtube: 'Chill mix', soundcloud: 'Likes' }[platform] || 'Imported playlist';
      previews.set(preview_id, { name, platform, items });
      items.forEach((_, i) => setTimeout(() => emit('import://progress', { preview_id, done: i + 1, total: items.length }), 60 * (i + 1)));
      return { preview_id, name, platform, items };
    }
    case 'import_commit': {
      const pv = previews.get(a.previewId); if (!pv) throw new Error('Preview expired — paste the link again');
      const p = { id: Math.max(0, ...playlists.map((x) => x.id)) + 1, name: a.name || pv.name, description: null, imported_from: pv.platform, created_at: now, updated_at: now, entries: [] };
      (a.include || []).map((i) => pv.items[i]).filter((it) => it && it.match).forEach((it) => p.entries.push({ entry_id: ++entrySeq, track_id: rowForYt(it.match).id }));
      playlists.push(p);
      importHistory.unshift({ id: importHistory.length + 1, platform: pv.platform, name: p.name, imported_at: Math.floor(Date.now() / 1000), total: pv.items.length, matched: p.entries.length, playlist_id: p.id });
      return playlistShape(p);
    }
    case 'list_import_history': return importHistory;

    // Device scan
    case 'get_scan_config': return { mode: settings['scan.mode'], roots: ['/home/me'], rules, extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav'], min_duration_secs: 10, respect_nomedia: true, classify: true, confidence_threshold: 0.5, use_hints: true };
    case 'list_folder_rules': return rules;
    case 'add_folder_rule': if (a.rule === 'app') rules = rules.filter((r) => r.rule !== 'app'); rules.push({ id: ++seq, path: a.path, rule: a.rule, enabled: true }); return rules;
    case 'remove_folder_rule': rules = rules.filter((r) => r.id !== a.id); return rules;
    case 'set_folder_rule_enabled': { const r = rules.find((x) => x.id === a.id); if (r) r.enabled = a.enabled; return null; }
    case 'start_scan': {
      let p = 0; clearInterval(scanTimer); scanning = true;
      scanTimer = setInterval(() => {
        p = Math.min(100, p + 4 + Math.random() * 6);
        const r = { files_seen: Math.round(p * 13), audio_found: Math.round(p * 2.1), added: Math.round(p / 25), updated: 0, removed: 0, music: Math.round(p * 2), voice: p > 40 ? 1 : 0, unsure: 0, skipped: Math.round(p / 10), current_path: `/home/me/Music/Album ${Math.round(p)}/track.flac`, finished: p >= 100, elapsed_ms: Math.round(p * 110) };
        emit('scan://progress', r);
        if (p >= 100) { clearInterval(scanTimer); scanning = false; lastScanReport = r; }
      }, 150);
      return null;
    }
    case 'cancel_scan': clearInterval(scanTimer); scanning = false; emit('scan://progress', { ...lastScanReport, finished: true, current_path: '' }); return null;
    case 'is_scanning': return scanning;
    case 'last_scan': return [now - 2 * H, lastScanReport];
    case 'reclassify_track': return findTrack(a.id);
    case 'list_dirs': return ['Music', 'Downloads', 'Recordings', 'Podcasts'].map((d) => `${String(a.path || '/').replace(/\/$/, '')}/${d}`);

    // Settings
    case 'get_settings': return settings;
    case 'set_setting': settings[a.key] = String(a.value); return null;
    case 'get_platform': return { os: 'browser', is_mobile: /Android|iPhone/i.test(navigator.userAgent), data_dir: '/home/me/.local/share/dev.yashwanth.offlineplayer', download_dir: MUSIC_DIR, version: '2.0.0-preview' };

    default: throw new Error(`mock: unknown command ${cmd}`);
  }
}
