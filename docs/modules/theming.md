# Module: theming & design system

## Where it lives
`src/styles/system.css` is the design system, ported **verbatim** from `design/system.css`
(the approved v2 designs link the same file). It is the single source of colour, type,
spacing, shape, elevation and every shared component (shell, buttons, inputs, chips, badges,
cards, tiles, rows, progress, scrubber, volume, waveform, empty/skeleton/toast/banner,
modal/sheet/menu). When the design system changes, copy `design/system.css` over it again.

On top of it:
* `src/styles/app.css` — app-only patterns the screens share (shell states such as
  `.app.is-np`, the player bar "now" block, buffering spinner/ring, popover positioning, the
  add-to-playlist picker, quick search, thumbnails over generated art). Tokens only.
* `src/styles/now-playing.css` — the Now Playing screen, ported from the design file.
* Screen-only CSS of other views is shipped by the view module (`css` export, see frontend.md).

## Light and dark
Two token blocks in `system.css`: `:root { … }` (light, the default) and
`:root[data-theme="dark"] { … }` (same names). `src/js/theme.js` resolves the preference
`light | dark | system` to `<html data-theme="light|dark">` and re-resolves when the OS
switches, so no `prefers-color-scheme` query is needed. An inline script in `index.html`
applies the saved preference from `localStorage` before first paint (no flash); the persistent
copy is the `ui.theme` setting. `?theme=dark` on the URL forces a theme for review screenshots
without saving it. `<meta name="theme-color">` follows `--page`.

## Token groups (system.css §1)
| Group | Tokens |
|---|---|
| Surfaces | `--page`, `--surface`, `--surface-2/3`, `--border`, `--border-strong`, `--scrim` |
| Text | `--text`, `--text-2`, `--text-3` |
| Accent | `--accent`, `--accent-hover/active`, `--accent-text`, `--accent-soft/-2`, `--on-accent`, `--focus` |
| Semantic | `--ok`, `--warn`, `--danger`, `--info` (+ `-soft`), toast colours |
| Sources | `--src-spotify/ytm/sc/local/voice` (+ `-text`, `-soft`) |
| Generated artwork | `--art-1 … --art-6`, `--art-voice` (gradients; `components/art.js` picks one by hash) |
| Type | `--font`, `--fs-12/13/14/16/20/28/36`, weights, tracking |
| Space / shape | `--sp-1 … --sp-16` (4-pt grid), `--r-card/ctl/art/sm/pill` |
| Layout | `--sidebar-w`, `--player-h`, `--tabbar-h`, `--mini-h`, `--topbar-h`, `--gutter`, `--hit`, `--touch-min` |

The phone breakpoint is `max-width: 820px` (system.css §10); JS uses `isPhone()` from `ui.js`
for the same test.

## Artwork
Never empty boxes and never external placeholder images: `artHTML()` renders the YouTube
thumbnail when a track has one, over generated art (gradient `--art-N` + initials + a soft SVG
motif on large sizes). If the image fails, it is removed and the generated art shows.

## Rule
No hex/rgb values, radii or font sizes outside `system.css`. Components in `app.css`,
`now-playing.css` and view `css` exports use tokens only.
