# Module: frontend (`src/`)

## What it does
Renders the app in the Tauri webview (Linux desktop + Android). Plain ES modules, no
bundler, no framework. Markup and class names follow the approved designs in
`design/screens/*.html`; every colour/size comes from `styles/system.css` (see theming.md).

```
src/
├── index.html              shell: sidebar, top bar, #view, player bar, mini player, tab bar, icon sprite
├── styles/
│   ├── system.css          the design system, ported verbatim from design/system.css (tokens + components)
│   ├── app.css             app layer: shell states, player-bar extras, buffering, overlays, pickers, thumbnails
│   └── now-playing.css     Now Playing screen (ported from design/screens/now-playing.html)
└── js/
    ├── app.js              boot + shell: theme, player, router hooks, sidebar/top bar/tab bar, player bar, mini player, keys
    ├── api.js              the only place that calls Tauri; one wrapper per command in docs/API-v2.md; KEYS
    ├── mock.js             in-memory backend for browser previews (same shapes) + mock events + silent audio
    ├── router.js           hash router + views registry (REGISTRY) + placeholder for missing views
    ├── theme.js            light / dark / system (+ ?theme= for review screenshots)
    ├── player.js           queue, shuffle, repeat, like/download current, sleep timer, voice speed, record_play
    ├── ui.js               esc(), icon(), on(), h(), formatters, emptyState(), banner(), ring(), waveform(), guard()
    ├── engine/
    │   ├── index.js        createEngine(): android.js on Android-in-Tauri (if present), else html.js
    │   ├── html.js         <audio> + Media Session; D21 Blob-URL workaround on Android without native
    │   └── android.js      (owned by the Android agent) native Media3 engine via the `playback` plugin
    ├── components/
    │   ├── store.js        shared stores: downloads (polled), playlists, stats, settings, platform, online
    │   ├── actions.js      like, download, add-to-playlist picker, create playlist, the ⋯ track menu
    │   ├── tracks.js       trackRow(), resultRow(), stateGlyph(), downloadCell(), bindTrackList()
    │   ├── tiles.js        tile(), playlistTile()
    │   ├── art.js          artHTML(): thumbnails or generated art (gradient + initials + motif), playlist mosaic;
    │   │                   mosaicCellHTML() / cellMotif(): mosaic quadrants with the small-cell motifs
    │   ├── output.js       audio output picker: enumerateDevices + player.setOutput (setSinkId), D43
    │   ├── overlay.js      openModal, openSheet, openPopover, openMenu, confirmDialog, promptDialog
    │   ├── toast.js        toast(text, { kind, sub, action, ms })
    │   ├── player-ui.js    bindSlider (scrubber/volume), paintScrubber, sleep-timer menu, buffering helpers
    │   ├── quicksearch.js  Ctrl+K palette (also the top-bar search field and `ui://quick-search`)
    │   └── pickers.js      pickFolder(): native on desktop, list_dirs browser on Android
    └── views/              one module per screen (see the contract below)
```

## View contract
Routes are `#name[/id][?k=v]`, e.g. `#playlist/3`, `#search?q=bon%20iver`, `#library?tab=liked`.
`router.js` lazy-loads `js/views/<name>.js` on first visit. The module exports (as `default`,
or a named export equal to the view name, camel-cased for `now-playing` → `nowPlaying`):

```js
export default {
  title: 'Library',                 // or (params) => string. Phone top-bar title + document.title
  render(root, params, ctx) {       // root = empty <div id="view" class="view view--<name>">
    root.innerHTML = `<div class="page">…</div>`;   // views render their own .page
    return () => { /* cleanup: unsubscribe, clear timers */ };   // may be async
  },
  css: `…`,                         // optional screen-only CSS, injected once as <style data-view-css>
  // optional overrides of the REGISTRY defaults: tab, nav, back, trail, shell, topbarSearch
};
```

`params` = query params plus `id` (path segment). `ctx`:
* `ctx.setTitle(text)` — phone top-bar title (Home sets the greeting).
* `ctx.setTrail(html | Element | null)` — the phone top-bar trailing action (e.g. a "⋯" menu
  button on Playlist / Voice / Device). Default comes from the registry: `'settings'` = gear.
* `ctx.setBack(href | null)` — the top-bar back link.

Registry defaults (`router.js` `REGISTRY`): `tab` = phone tab kept active (Settings/Device keep
**Home**, Playlist/Voice keep **Library**), `nav` = sidebar item (`'home'`, `'playlist:<id>'`, …),
`back`, `trail`, `shell: 'setup'` (onboarding: no sidebar/player/tab bar and no shell top bar —
the view renders its own `header.topbar`), `topbarSearch: false` (Search shows its title on
desktop instead of the search field). A missing or failing module renders a placeholder card.

**Screen CSS.** Shared components come from `system.css`/`app.css`. Anything that exists only
in one design file's `<style>` block goes in the view's `css` export (skip the review-only
"variants/states" rules). Tokens only.

## Shared pieces views should use
* Rows: `trackRow(item, { index, dl })`, `resultRow(item, { index })`, then
  `bindTrackList(listEl, { items: () => items, player, context: { type, id, name }, menuExtra })`.
  It wires play (button, double-click on desktop, tap on phone), like, download (with live
  progress ring), the ⋯ menu, and keeps playing/liked/download state live.
* Actions: `toggleLike(item)`, `download(item)`, `openPlaylistPicker(anchor, items)`,
  `createPlaylistDialog(items)`, `openTrackMenu(anchor, item, { player })`.
* Stores (`components/store.js`): `downloads`, `playlists`, `stats`, `settings`, `platform`,
  `online` — each `{ value, subscribe(fn) → unsub, refresh() }`; `downloadFor(item)`,
  `downloadSummary()`, `setSetting(key, value)` (updates the cache; onboarding finishes with
  `setSetting('ui.onboarded', '1')` then `location.hash = '#home'`).
* Player: `player.play(items, index, context)`, `shufflePlay`, `playNext`, `addToQueue`,
  `toggle`, `subscribe(fn)`, `onTime(fn)`; context `{ type: 'playlist'|'liked'|'album'|'artist'|'search'|'library'|'downloads'|'voice', id?, name }`
  drives "Playing from …" and the Now Playing breadcrumb.
* Window events: `library:changed` (download finished, scan, playlist edit), `track:updated`
  (like), `player:change`, `online:changed`, `theme:changed`.

## Player + engine
`player.js` owns the queue (`[{ uid, item, added }]`; "Added by you" = `added` entries right
after the current song), shuffle (keeps the original order to restore), repeat off/all/one,
like/download of the current song, the sleep timer (minutes or end of song, "+10 min"; with
`playback.sleep_fade` on — the default — the volume ramps down over the last 30 s),
output routing (`setOutput(id)` → engine `setSinkId`, html engine only),
per-recording voice speed (default `playback.voice_speed`), `record_play` on first audio,
offline skipping of streams, and auto-skip of songs that fail at 0:00 (max 3 in a row).
YouTube songs without a file stream via `youtube_stream_url`; the next 2 queued streams are
prefetched with `youtube_prefetch` (D22). The engine interface is documented in
`engine/index.js`; `html.js` is the desktop/preview engine and the Android fallback (D21).

## Shell behaviour
* Desktop: sidebar (Home, Search, Library, Downloads, Voice recordings, PLAYLISTS, New
  playlist, Settings), top bar (back · search field → quick search · download pill), player bar
  (the "now" block — art + title — opens Now Playing; it shows a chevron only while Now Playing
  is open, where it is highlighted and the centre shows "Up next"). Shortcuts: Space play/pause, S shuffle, R repeat, Esc collapses Now Playing,
  Ctrl+K quick search.
* Phone (≤ 820 px): tab bar (Home, Search, Library, Downloads with a count), mini player
  above it; tapping it opens `#now-playing`, which hides the mini player, tab bar and top bar
  and shows the sheet header (collapse ˅ · "Playing from …" · ⋯).
* First run: until setting `ui.onboarded` is `"1"` every route redirects to `#onboarding`.

## Testing without a build
`cd src && python3 -m http.server 8765` → http://127.0.0.1:8765/. Everything runs on
`mock.js`. Review switches: `?theme=dark|light`, `?onboarded=0` (first run),
`?demo=music|stream|voice` (starts a queue so Now Playing and the player bar have content),
`&sleep=1` (sleep timer at 30 min). Headless screenshots:
`chromium --headless=new --disable-gpu --no-sandbox --hide-scrollbars --window-size=1440,900 --virtual-time-budget=3000 --screenshot=out.png 'http://127.0.0.1:8765/?demo=music#now-playing'`.


## Home and Search views
* `views/home.js` + `styles/views/home.css` — greeting (phone: top-bar title; "Welcome" on a fresh
  install), shuffle (liked songs online, downloads offline), Liked songs / Downloads shortcuts with the
  live download line, Continue listening, Quick picks (D33), Recently played. States: skeleton while
  loading, fresh install, offline banner + "From your downloads", Quick picks error card, "File missing".
* `views/search.js` + `styles/views/search.css` — search field (debounced 400 ms, Enter records a
  recent search), YouTube Music · Your library switch, All/Songs/Albums/Artists chips, Top result,
  song rows (Play/Stream · Download → ring % → Queued · Nth → Retry · Like · ⋯), albums, artists (D34).
  URL keeps `?q=`, `src=library`, `show=songs|albums|artists` (replaceState, no re-render).
* Review switch for both (browser preview only): `?state=loading|fresh|offline|error`
  (`fresh` is Home only). `#search?q=zzz` shows the no-results state with the mock.

## Settings, Onboarding, Voice and Device views
* `views/settings.js` + `styles/views/settings.css` — sticky section nav (≥1024 px) / jump chips,
  scroll-spy on `#main`; Appearance (theme previews), Playback (gapless, crossfade + length, default
  voice speed), Streaming (quality, cache meter + Clear, cache limit, mobile data, offline banner),
  Downloads (quality, location → `app` folder rule, storage usage from `storage_info` + voice sizes),
  Import (platform tiles, past imports), Device folders link, About (yt-dlp version / update, app
  version, Reset settings; phone: ⋯ in the top bar). Deep link `#settings?section=<id>`.
  Import sub-page `#settings?import=spotify|youtube|soundcloud[&url=…&go=1]` (D38, D39).
  Exports `PLATFORMS`, `detectPlatform`, `prettyPath`, `pathHTML` (used by onboarding/device).
* `views/onboarding.js` + `styles/views/onboarding.css` — setup shell; steps 1–4 kept in the hash
  with replaceState (`#onboarding?step=N`); background scan strip from `scan://progress`; import
  step states pick → matching → review → done / no matches / offline; Finish and Skip set
  `ui.onboarded = "1"`. `&link=<url>` on step 4 starts matching (review screenshots).
* `views/voice.js` + `styles/views/voice.css` — continue-listening card (waveform scrubber via
  `bindSlider`, per-recording speed, resume), day-grouped list with search/sort/paging, Needs review
  rail (keep / move to music with Undo), About card, Scan for new with live counters (D40).
* `views/device.js` + `styles/views/device.css` — scan mode cards, included / excluded rules
  (missing folders detected with `list_dirs` on desktop), file types, classifier, last-scan summary,
  live scan (ring %, counters, just found, Stop) and the phone thumb bar. `#device?scan=1` starts a scan.
