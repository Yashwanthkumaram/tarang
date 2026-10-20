# Offline Player — UI/UX redesign brief (v2)

This brief is the contract between the **designer** (produces screens) and the **critic**
(approves or returns fixes). Both read it in full before every round.

## Product scope (v2.1 — user update 2026-10-19, overrides earlier scope)
Minimal, like YouTube Music / Spotify, but works offline.
1. **Online + offline player.** Plays downloaded/local songs fully offline, and **streams
   YouTube Music songs** when online. Streaming is cache-and-forget: audio is fetched in
   chunks into a temporary cache and cleared after the song plays (Settings shows the cache
   size and a "clear" action). The UI must make the difference visible but calm: a small
   "Streaming" vs "Downloaded" indicator, and a buffering state on the scrubber.
2. **Search YouTube Music** (songs, albums, artists) and from any result: **Play** (stream),
   **Download** (keep offline), **Like**, **Add to playlist**.
3. **Library like a streaming app:** Liked songs, Downloads, Playlists (create, rename,
   reorder, delete, add/remove songs), Albums, Artists, Recently played. A liked song can be
   downloaded with one tap; liked + downloaded is shown clearly.
4. **Playback everywhere:** background playback, **media notification** (artwork, title,
   artist, prev/play-pause/next, like) and **lock screen** controls with scrubber. Design
   mockups of the Android notification shade card and the lock screen are required.
5. **Device music:** scan folders on this device for songs (voice recordings stay separate,
   as before) — kept, but secondary (lives in Settings → Device folders and the Library).
6. **Downloads queue** with progress, speed, ETA, pause/retry.
7. **Settings:** theme, download quality, streaming cache (size, clear), device folders,
   yt-dlp version + update, about.

8. **Import from other platforms (first run, then Settings only).** Bring in songs and
   playlists from **Spotify, YouTube Music and SoundCloud**. Offered once during onboarding
   (optional, skippable) and afterwards reachable ONLY from Settings → Import from other apps
   — never as a home-screen card, nav item or search scope. Flow: choose platform → paste a
   playlist/profile link (or sign-in-free export for Spotify) → preview of matched songs
   (matched / needs review / not found) → import as playlists in the Library, with each song
   streamable and downloadable via YouTube Music.

**Out of scope now (remove if a screen still shows them):** torrents, self-hosted server,
"Bring music in"/"Import a link" entry points outside onboarding and Settings, SoundCloud or
Spotify as search scopes or source badges on everyday rows (imported songs are just songs).

## Platforms
Desktop (Linux window, 1440×900 typical, resizable down to 1024) and Android phone
(390×844 typical). Every screen must work at both. Desktop uses a left sidebar + persistent
bottom player bar. Phone uses a bottom tab bar (Home, Search, Library, Downloads) with a
mini player docked above it; tapping the mini player opens the full Now Playing sheet.
Phone sub-pages keep the tab they were opened from: Settings and Device folders are reached
from the gear on Home, so they keep **Home** active; the media notification page also keeps
Home. Phone header right action: top-level tabs show the gear, sub-pages show "…" only when
they have a menu, Settings shows nothing.

## Visual language
* **Theme:** light by default (off-white page, white surfaces, warm gray text, one red
  accent), dark theme available. Everything comes from CSS custom properties in
  `design/system.css`; screens must not hard-code colours, radii or font sizes.
* **Type:** system sans; strict scale (12/13/14/16/20/28/36). Titles bold and tight.
* **Spacing:** 4-pt grid; page gutters 24 px desktop, 16 px phone.
* **Shape:** 12 px cards, 8 px controls, pill buttons; artwork 8 px.
* **Artwork placeholders:** generated vector art only (SVG gradients, shapes, initials),
  never external images, never empty gray boxes.
* **Icons:** inline SVG, 20 px in nav, 16 px in rows, stroke 2.
* **Motion:** none needed in mockups, but hover/active/focus states must be visible.

## UX principles the critic enforces
1. **One primary action per screen**, visually dominant. Secondary actions quieter.
2. **Progress is always visible**: scan, import matching, downloads, playback — with
   numbers (percent, ETA, counts), not just bars.
3. **Every list has an empty state** that says what to do next, with the action inline.
4. **Loading and error states** exist for anything that waits on the network or disk.
5. **Touch targets ≥ 44 px on phone**; hit areas on desktop ≥ 32 px.
6. **Contrast:** text ≥ 4.5:1 on its background; muted text ≥ 3:1; accent on white ≥ 4.5:1.
7. **Consistency:** same nav, same header pattern, same card and row anatomy on every screen.
8. **Density:** desktop shows more per screen without feeling cramped; phone is thumb-first
   (primary actions in the lower half, destructive ones behind a menu).
9. **Information hierarchy:** title → metadata → actions; numbers right-aligned, tabular.
10. **Nothing fake**: every control shown must map to a v2 feature. No "coming soon".

## Screens (each is one self-contained HTML file in `design/screens/<id>.html`)
Each file: `<!doctype html>`, links `../system.css`, contains BOTH layouts (desktop and
phone) using responsive CSS so the same file renders correctly at 1440 and 390 wide, and
includes this snippet so the critic can render dark mode:
`<script>document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light'</script>`

| id | Must show |
|---|---|
| `onboarding` | 4 steps: welcome → storage permission + choose music folders (phone) → "Search YouTube Music, stream or download" → **optional "Bring your music: import songs & playlists from Spotify, YouTube Music, SoundCloud"** (platform cards, paste link, skip). Progress dots, skip, primary CTA. Also show the import-in-progress / done state of that step. |
| `home` | Greeting; Continue listening (with progress); Quick picks from YouTube Music (stream/download affordances, online state); Recently played; Liked songs + Downloads shortcuts; offline banner variant (only downloaded music shown, streaming disabled with reason). Fresh-install empty state. |
| `search` | One search bar with recent searches; results grouped Songs / Albums / Artists with artwork, duration, "Downloaded" badge where applicable; row actions Play (stream), Download (with in-row progress), Like, Add to playlist (via menu); loading skeleton; no-results; offline state ("Search needs internet — showing your library matches"). |
| `library` | Tabs/segments: Playlists · Liked · Downloads · Albums · Artists · Device. Playlist cards incl. "Liked songs" auto-playlist; song rows with like + download state; sort/filter; multi-select (desktop) → add to playlist / download / remove. |
| `playlist` | NEW (repurpose `import.html` into `playlist.html` is fine). Playlist detail: artwork mosaic, title, song count + total time, Play / Shuffle / Download all (with progress), edit (rename, reorder via drag handles, remove), "Add songs" (search inline). Create-playlist sheet/dialog. |
| `now-playing` | Full player: large artwork, title/artist/album, scrubber with elapsed/remaining and a **buffering** state for streams, Streaming/Downloaded indicator, play/pause/prev/next, shuffle/repeat, like, download, add to playlist, queue (desktop side panel / phone sheet), sleep timer, speed (voice only), volume (desktop). Mini player. |
| `notification` | NEW. Android media notification (collapsed + expanded) and lock screen player, drawn as faithful mockups inside phone frames, using the app's artwork/branding; plus the desktop equivalent (MPRIS/system media overlay) if relevant. |
| `downloads` | Queue: active (progress, speed, ETA, pause), queued, done (play), failed (retry, reason). Storage used/free. Clear finished. Empty state. |
| `voice` | Unchanged from before (voice recordings section). |
| `device` | Device folders & scan (secondary): include/exclude folders, scan progress with live counters, last scan summary. Reached from Settings and Library → Device. |
| `settings` | Theme; Playback (crossfade, gapless, voice speed); Streaming (quality, cache size + Clear cache, "Download over mobile data"); Downloads (quality, location); **Import from other apps (Spotify, YouTube Music, SoundCloud) — opens the import flow: platform → link → match preview (matched / review / not found) → import as playlists; history of past imports**; Device folders link; yt-dlp version + Update; About. The import flow may be a sub-page or sheet; design it fully here. |

## Deliverable for the designer each round
Write the file(s) requested. Return a 3–6 line note: what you changed and any brief
ambiguity you resolved. Do not ask questions; decide and note it.

## Deliverable for the critic each round
Render the file at 1440×900 and 390×844 (light), and 390×844 (dark); look at the images.
Return a verdict: `approved` only when every "Must show" item is present and all ten
principles hold at both widths; otherwise a numbered list of concrete fixes, each naming the
element and the exact change. Be demanding — this is the final design, not a sketch.
