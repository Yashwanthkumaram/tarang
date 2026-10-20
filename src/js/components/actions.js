// Song actions shared by every screen: like, download, add to playlist (picker), play
// next / add to queue, and the "⋯" track menu. Each works for a library Track and for a
// YouTube Music search result (YtTrack); YtTracks become library rows on the backend
// (like_youtube / add_to_playlist ytTracks / youtube_download).
//
// Dispatches window event 'track:updated' { detail: { before, track } } after a like so
// rows can update in place.

import { api } from '../api.js';
import { esc, icon } from '../ui.js';
import { artHTML } from './art.js';
import { openMenu, openPopover, promptDialog } from './overlay.js';
import { downloadFor, playlists, pokeDownloads, rememberDownload, stats } from './store.js';
import { toast } from './toast.js';

/** The YtTrack shape the backend expects for a song. */
export function ytShape(it) {
  return { video_id: it.video_id, title: it.title, artist: it.artist || '', album: it.album || null, duration_secs: it.duration_secs ?? null, thumbnail: it.thumbnail || null, explicit: !!it.explicit, local_track_id: it.local_track_id || it.id || null };
}

const announce = (before, track) => dispatchEvent(new CustomEvent('track:updated', { detail: { before, track } }));

/** Likes / unlikes. Returns the updated Track (or null on failure). */
export async function toggleLike(item) {
  const liked = !item.liked;
  try {
    const track = item.id ? await api.setLiked(item.id, liked) : await api.likeYoutube(ytShape(item), liked);
    const t = track || { ...item, liked };
    toast(liked ? 'Added to Liked songs' : 'Removed from Liked songs', { kind: liked ? 'ok' : null, action: { label: 'Undo', run: () => toggleLike(t) } });
    announce(item, t);
    playlists.refresh(); stats.refresh();
    return t;
  } catch (e) {
    toast(`Couldn’t update Liked songs: ${e.message || e}`, { kind: 'danger' });
    return null;
  }
}

/** Starts a download for a song. Returns the download id (or null). */
export async function download(item) {
  if (item.downloaded && item.path) { toast('Already downloaded — plays offline', { kind: 'ok' }); return null; }
  const pending = downloadFor(item);
  if (pending && pending.state !== 'done' && pending.state !== 'error') { toast(`Already downloading — ${Math.round(pending.progress * 100)}%`, { kind: 'info' }); return pending.id; }
  try {
    let id;
    if (item.id && item.video_id) id = await api.downloadTrack(item.id);
    else if (item.video_id) id = await api.youtubeDownload(ytShape(item));
    else throw new Error('This song has no YouTube Music source to download from');
    rememberDownload(id, item);
    pokeDownloads();
    toast(`Downloading “${item.title}”`, { kind: 'info', action: { label: 'View', run: () => { location.hash = '#downloads'; } } });
    return id;
  } catch (e) {
    toast(`Couldn’t download: ${e.message || e}`, { kind: 'danger' });
    return null;
  }
}

/** Adds songs (Tracks and/or YtTracks) to a playlist. Returns the Playlist. */
export async function addItemsToPlaylist(playlistId, items) {
  const trackIds = items.filter((t) => t.id).map((t) => t.id);
  const ytTracks = items.filter((t) => !t.id && t.video_id).map(ytShape);
  const pl = await api.addToPlaylist(playlistId, { trackIds: trackIds.length ? trackIds : null, ytTracks: ytTracks.length ? ytTracks : null });
  playlists.refresh(); stats.refresh();
  dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'playlist', playlistId } }));
  return pl;
}

/** Creates a playlist via a name dialog, optionally seeded with `items`. Returns the Playlist or null. */
export async function createPlaylistDialog(items = []) {
  const name = await promptDialog({ title: 'New playlist', label: 'Name', placeholder: 'My playlist', confirm: 'Create' });
  if (!name) return null;
  try {
    let pl = await api.createPlaylist(name, null);
    if (items.length) pl = await addItemsToPlaylist(pl.id, items);
    playlists.refresh(); stats.refresh();
    toast(items.length ? `Created “${pl.name}” with ${items.length === 1 ? `“${items[0].title}”` : `${items.length} songs`}` : `Created “${pl.name}”`, { kind: 'ok', action: { label: 'Open', run: () => { location.hash = `#playlist/${pl.id}`; } } });
    return pl;
  } catch (e) {
    toast(`Couldn’t create the playlist: ${e.message || e}`, { kind: 'danger' });
    return null;
  }
}

const matches = (entry, it) => (it.id && entry.track.id === it.id) || (it.video_id && entry.track.video_id === it.video_id) || (it.local_track_id && entry.track.id === it.local_track_id);

/**
 * Add-to-playlist picker (design: now-playing.html "Add to playlist — picker").
 * Desktop popover under `anchor`, phone bottom sheet. A check marks playlists that already
 * contain the (single) song; tapping toggles it; a toast confirms with Undo.
 */
export async function openPlaylistPicker(anchor, items) {
  items = [].concat(items).filter(Boolean);
  if (!items.length) return;
  const single = items.length === 1 ? items[0] : null;
  const label = single ? `“${single.title}”` : `${items.length} songs`;
  await playlists.refresh();
  const lists = playlists.value.filter((p) => !p.is_liked);
  const contains = new Map(); // playlist id → entry ids holding the song
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="menu__head desktop-only"><span class="strong truncate">Add ${esc(label)} to</span><span class="t-12 muted num" data-count></span></div>
    <div class="np-pl-search"><div class="input-wrap">${icon('search', 'icon--16')}<input class="input input--with-icon" placeholder="Find a playlist" aria-label="Find a playlist"></div></div>
    <button class="menu__item np-pl-new" type="button" data-new>${icon('plus')}New playlist…</button>
    <div class="menu__sep"></div>
    <div class="np-pl-list" data-list></div>
    <div class="np-pl-foot">Liked songs is updated with ♥, not from this list.</div>`;
  const listEl = body.querySelector('[data-list]');
  const countEl = body.querySelector('[data-count]');
  const render = (q = '') => {
    const shown = lists.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
    listEl.innerHTML = shown.length ? shown.map((p) => {
      const on = (contains.get(p.id) || []).length > 0;
      return `<button class="menu__item${on ? ' is-checked' : ''}" type="button" role="menuitemcheckbox" aria-checked="${on}" data-pl="${p.id}">${artHTML(p, { kind: 'playlist' })}<span class="grow truncate">${esc(p.name)}</span><span class="menu__hint">${p.track_count} songs</span>${on ? icon('check', 'np-pl-check') : ''}</button>`;
    }).join('') : `<div class="np-pl-foot">${lists.length ? 'No playlist matches.' : 'No playlists yet — create one above.'}</div>`;
    if (single) countEl.textContent = `In ${[...contains.values()].filter((v) => v.length).length} of ${lists.length}`;
  };
  render();
  const pop = openPopover(anchor, body, { className: 'menu menu--pl', title: 'Add to playlist', sub: single ? `${single.title}` : `${items.length} songs`, label: `Add ${label} to playlist` });
  const input = body.querySelector('input');
  input.addEventListener('input', () => render(input.value.trim()));
  body.querySelector('[data-new]').addEventListener('click', async () => { pop.close(); await createPlaylistDialog(items); });
  listEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pl]');
    if (!b) return;
    const id = Number(b.dataset.pl);
    const pl = lists.find((p) => p.id === id);
    const held = contains.get(id) || [];
    pop.close();
    try {
      if (single && held.length) {
        await api.removeFromPlaylist(id, held);
        playlists.refresh();
        dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'playlist', playlistId: id } }));
        toast(`Removed from ${pl.name}`, { action: { label: 'Undo', run: () => addItemsToPlaylist(id, items) } });
      } else {
        const before = await api.playlist(id).catch(() => null);
        const beforeIds = new Set((before?.entries || []).map((x) => x.entry_id));
        await addItemsToPlaylist(id, items);
        toast(`Added to ${pl.name}`, { kind: 'ok', action: { label: 'Undo', run: async () => {
          const after = await api.playlist(id);
          const added = after.entries.filter((x) => !beforeIds.has(x.entry_id)).map((x) => x.entry_id);
          if (added.length) { await api.removeFromPlaylist(id, added); playlists.refresh(); dispatchEvent(new CustomEvent('library:changed', { detail: { reason: 'playlist', playlistId: id } })); }
        } } });
      }
    } catch (err) {
      toast(`Couldn’t update ${pl?.name || 'the playlist'}: ${err.message || err}`, { kind: 'danger' });
    }
  });
  // Fill in check marks (which playlists already hold this song).
  if (single) {
    await Promise.all(lists.map(async (p) => {
      try { const d = await api.playlist(p.id); contains.set(p.id, d.entries.filter((en) => matches(en, single)).map((en) => en.entry_id)); } catch {}
    }));
    render(input.value.trim());
  }
}

/**
 * The "⋯" menu for one song. opts: { player, extra: [menu items], title }.
 * `player` is passed in (instead of imported) to keep this module free of a player dependency.
 */
export function openTrackMenu(anchor, item, { player, extra = [] } = {}) {
  const dl = downloadFor(item);
  const busy = dl && (dl.state === 'active' || dl.state === 'queued');
  const items = [
    player && { label: 'Play next', icon: 'play-next', run: () => { player.playNext(item); toast(`“${item.title}” plays next`, { kind: 'ok' }); } },
    player && { label: 'Add to queue', icon: 'queue', run: () => { player.addToQueue(item); toast(`Added “${item.title}” to the queue`, { kind: 'ok' }); } },
    { label: 'Add to playlist…', icon: 'playlist', run: () => openPlaylistPicker(anchor, item) },
    { label: item.liked ? 'Remove from Liked songs' : 'Like', icon: 'heart', run: () => toggleLike(item) },
    item.kind === 'music' && (item.downloaded && item.path
      ? { label: 'Downloaded · plays offline', icon: 'check-circle', disabled: true }
      : item.video_id ? { label: busy ? `Downloading ${Math.round(dl.progress * 100)}%` : 'Download', icon: 'download', disabled: busy, run: () => download(item) } : null),
    item.artist && { sep: true },
    item.artist && { label: `Go to artist`, icon: 'user', hint: item.artist, run: () => { location.hash = `#search?q=${encodeURIComponent(item.artist)}`; } },
    item.album && { label: `Go to album`, icon: 'disc', hint: item.album, run: () => { location.hash = `#search?q=${encodeURIComponent(`${item.album} ${item.artist || ''}`.trim())}`; } },
    ...(extra.length ? [{ sep: true }, ...extra] : []),
  ].filter(Boolean);
  return openMenu(anchor, items, { title: item.title, sub: item.artist || '', label: `More for ${item.title}` });
}
