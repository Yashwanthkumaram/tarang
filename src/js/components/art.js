// Artwork. Real thumbnails (YouTube https URLs) when a track has one; otherwise the
// generated vector art from the design system: one of the six --art-N gradients picked
// by a stable hash, initials, and (for large sizes) a soft SVG motif. Never empty boxes.
//
//   artHTML(track)                         40 px row art
//   artHTML(track, { size: 'lg' })         64 px · 'xl' 160 px · 'fill' / 'tile' fluid · 'hero' Now Playing
//   artHTML(playlist, { kind: 'playlist' }) mosaic of up to 4 thumbnails, heart for Liked songs
//   artHTML({ name }, { kind: 'artist', round: true })

import { esc, hashStr, icon } from '../ui.js';

const SIZE_CLASS = { row: '', lg: 'art--lg', xl: 'art--xl', fill: 'art--fill', tile: '', hero: 'art--hero' };
const BIG = new Set(['xl', 'fill', 'tile', 'hero']);

/** Palette slot 1..6 for a key. */
export const artSlot = (key) => (hashStr(String(key || '').toLowerCase()) % 6) + 1;

/** Up to two initials: "Heat Waves" → "HW", "The Less I Know the Better" → "LI", "AM" → "AM". */
export function initials(text) {
  const words = String(text || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const sig = words.filter((w, i) => !(i === 0 && words.length > 1 && /^(the|a|an)$/i.test(w)));
  if (!sig.length) return '♪';
  if (sig.length === 1) return sig[0].length <= 3 && sig[0] === sig[0].toUpperCase() ? sig[0] : sig[0][0].toUpperCase();
  return (sig[0][0] + sig[1][0]).toUpperCase();
}

/** Generated background motif (SVG, currentColor at low opacity). */
function motif(seed) {
  switch (seed % 3) {
    case 0: return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><circle cx="68" cy="34" r="20" fill="currentColor" fill-opacity=".22"/><circle cx="68" cy="34" r="12" fill="currentColor" fill-opacity=".28"/><path d="M0 62 Q12 54 25 62 T50 62 T75 62 T100 62 V100 H0Z" fill="currentColor" fill-opacity=".10"/><path d="M0 72 Q12 64 25 72 T50 72 T75 72 T100 72 V100 H0Z" fill="currentColor" fill-opacity=".12"/><path d="M0 82 Q12 74 25 82 T50 82 T75 82 T100 82 V100 H0Z" fill="currentColor" fill-opacity=".14"/></svg>`;
    case 1: return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><circle cx="30" cy="30" r="22" fill="currentColor" fill-opacity=".18"/><circle cx="70" cy="68" r="30" fill="currentColor" fill-opacity=".14"/><path d="M0 78 L30 60 L55 74 L100 50 V100 H0Z" fill="currentColor" fill-opacity=".14"/></svg>`;
    default: return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><circle cx="50" cy="40" r="26" fill="currentColor" fill-opacity=".16"/><circle cx="50" cy="40" r="14" fill="currentColor" fill-opacity=".14"/><path d="M0 76 L25 58 L50 70 L75 52 L100 64 V100 H0Z" fill="currentColor" fill-opacity=".14"/></svg>`;
  }
}

/** Small-cell motifs for playlist cover mosaics (design/screens/library.html): rings, waves,
 *  tilted squares, a diagonal band, lines, offset circles. Picked by a stable hash per song. */
const CELL_MOTIFS = [
  '<circle cx="78" cy="22" r="34" stroke="currentColor" stroke-opacity=".22" stroke-width="2" fill="none"/><circle cx="78" cy="22" r="20" stroke="currentColor" stroke-opacity=".16" stroke-width="2" fill="none"/>',
  '<path d="M0 72 Q25 52 50 72 T100 72 V100 H0Z" fill="currentColor" fill-opacity=".12"/><path d="M0 84 Q25 66 50 84 T100 84 V100 H0Z" fill="currentColor" fill-opacity=".12"/>',
  '<rect x="58" y="-10" width="60" height="60" transform="rotate(30 88 20)" fill="currentColor" fill-opacity=".12"/><rect x="-20" y="70" width="50" height="50" transform="rotate(20 5 95)" fill="currentColor" fill-opacity=".10"/>',
  '<path d="M0 100 L100 0 V30 L30 100Z" fill="currentColor" fill-opacity=".12"/>',
  '<g stroke="currentColor" stroke-opacity=".18" stroke-width="2"><path d="M10 20h80M10 32h60M10 44h70"/></g>',
  '<circle cx="20" cy="82" r="40" fill="currentColor" fill-opacity=".10"/><circle cx="88" cy="12" r="18" fill="currentColor" fill-opacity=".14"/>',
];
export const cellMotif = (seed) => `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${CELL_MOTIFS[Math.abs(seed) % CELL_MOTIFS.length]}</svg>`;

/** One mosaic quadrant for a song: thumbnail, or gradient + cell motif + initials. */
export function mosaicCellHTML(t, { tag = 'i', cls = 'mosaic__cell' } = {}) {
  const slot = artSlot((t.album || t.title || '') + (t.artist || ''));
  const body = t.thumbnail ? img(t.thumbnail) : `${cellMotif(hashStr(`${t.album || t.title || ''}|${t.title || ''}`))}<span>${esc(initials(t.album || t.title))}</span>`;
  return `<${tag} class="${cls} art--${slot}">${body}</${tag}>`;
}

const img = (src) => `<img class="art__img" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;

/**
 * Returns the artwork HTML. opts: { size, kind: 'track'|'playlist'|'album'|'artist', round, cls,
 * play (adds the hover play button), tag (caption on hero art), label (aria-label → role=img) }.
 */
export function artHTML(item, opts = {}) {
  const size = opts.size || 'row';
  const kind = opts.kind || (item && 'track_count' in item && 'is_liked' in item ? 'playlist' : 'track');
  const big = BIG.has(size);
  let slot, text, inner = '', extra = '';

  if (kind === 'playlist') {
    slot = item.is_liked ? 1 : artSlot(item.name);
    if (item.is_liked) inner = `<span>${icon('heart', 'icon--fill art__glyph')}</span>`;
    else if (item.artwork?.length >= 4) inner = `<span class="art__mosaic">${item.artwork.slice(0, 4).map(img).join('')}</span>`;
    else if (item.artwork?.length) inner = img(item.artwork[0]);
    text = item.is_liked ? '' : initials(item.name);
  } else if (kind === 'album' || kind === 'artist') {
    slot = artSlot(item.name + (item.artist || ''));
    text = initials(item.name);
    if (item.artwork) inner = img(item.artwork);
  } else {
    const isVoice = item?.kind === 'voice' || item?.kind === 'unsure';
    if (isVoice) {
      const cls = ['art', SIZE_CLASS[size], 'art--voice', opts.round ? 'art--round' : '', opts.cls || ''].filter(Boolean).join(' ');
      return `<div class="${cls}"${opts.label ? ` role="img" aria-label="${esc(opts.label)}"` : ''}>${big ? `<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="30" fill="currentColor" fill-opacity=".12"/><circle cx="50" cy="50" r="20" fill="currentColor" fill-opacity=".14"/></svg>` : ''}<span>${icon('mic', big ? 'art__glyph art__glyph--lg' : 'art__glyph')}</span>${opts.play ? playBtn() : ''}</div>`;
    }
    slot = artSlot((item?.album || item?.title || '') + (item?.artist || ''));
    text = initials(item?.title);
    if (item?.thumbnail) inner = img(item.thumbnail);
  }

  if (big && !inner.includes('art__img') && !inner.includes('art__mosaic')) extra = motif(hashStr(item?.name || item?.title || ''));
  if (opts.tag) extra += `<span class="np-art__tag">${esc(opts.tag)}</span>`;
  const cls = ['art', SIZE_CLASS[size], `art--${slot}`, opts.round ? 'art--round' : '', opts.cls || ''].filter(Boolean).join(' ');
  const label = opts.label ? ` role="img" aria-label="${esc(opts.label)}"` : '';
  const textSpan = text && !opts.tag && !inner.includes('art__glyph') ?`<span>${esc(text)}</span>` : '';
  return `<div class="${cls}"${label}>${extra}${textSpan}${inner}${opts.play ? playBtn() : ''}</div>`;
}

const playBtn = () => `<span class="art__play" aria-hidden="true">${icon('play', 'icon--fill')}</span>`;
