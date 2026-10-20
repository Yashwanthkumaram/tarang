// Album / playlist / artist tiles (system.css .tile, .tile-grid, .tile-row).
//
//   `<div class="tile-grid">${pls.map((p) => playlistTile(p)).join('')}</div>`
//   tile({ name, artist }, { kind: 'album', href: '#search?q=…', sub: 'Album · Phoebe Bridgers' })
// A tile's .art__play button carries data-act="play-tile"; the view decides what it plays.

import { esc, icon, plural } from '../ui.js';
import { artHTML } from './art.js';

/** Generic tile. opts: { kind: 'album'|'artist'|'playlist'|'track', href, sub, glyph ('dl'|'st'|null), round, data (attrs string) }. */
export function tile(item, opts = {}) {
  const kind = opts.kind || 'album';
  const title = item.name ?? item.title ?? '';
  const glyph = opts.glyph === 'dl' ? icon('check', 'sg sg--dl', 'Downloaded') : opts.glyph === 'st' ? icon('stream', 'sg sg--st', 'Streams') : '';
  const art = artHTML(item, { kind: kind === 'track' ? 'track' : kind, size: 'tile', round: opts.round ?? kind === 'artist' });
  const withPlay = art.replace(/<\/div>$/, `<button class="art__play" type="button" data-act="play-tile" aria-label="Play ${esc(title)}">${icon('play', 'icon--fill')}</button></div>`);
  const tag = opts.href ? 'a' : 'div';
  return `<${tag} class="tile" ${opts.href ? `href="${esc(opts.href)}"` : 'tabindex="0"'} ${opts.data || ''}>${withPlay}<div class="tile__title">${esc(title)}</div><div class="tile__sub">${glyph}<span>${esc(opts.sub || '')}</span></div></${tag}>`;
}

/** Playlist tile linking to #playlist/<id>; sub = "Playlist · 24 songs", glyph = all downloaded ✓ / streams. */
export function playlistTile(p, opts = {}) {
  const allDl = p.track_count > 0 && p.downloaded_count >= p.track_count;
  return tile(p, {
    kind: 'playlist', href: `#playlist/${p.id}`,
    sub: opts.sub || (p.is_liked ? `Auto playlist · ${plural(p.track_count, 'song')}` : `Playlist · ${plural(p.track_count, 'song')}`),
    glyph: p.track_count ? (allDl ? 'dl' : 'st') : null,
    data: `data-playlist="${p.id}"`,
  });
}
