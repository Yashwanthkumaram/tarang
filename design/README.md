# Offline Player v2 — UI design

Static HTML mockups of every v2 screen, built on one shared design system.
No network, no build step.

## Open the gallery

```sh
xdg-open design/index.html
```

(run from the repo root, or open `index.html` in any browser).

- Left rail: pick a screen. `↑`/`↓` (or `←`/`→`) switch screens.
- **Desktop / Phone** toggle: 1440×900 (scaled to fit) or 390×844. Shortcut `D`.
- **Light / Dark** toggle: reloads the screen with `?theme=dark`. Shortcut `T`.
- "Open alone" opens the current screen in its own tab. The URL hash (`#search`) links to a screen.

## File layout

```
design/
├── index.html          gallery (this viewer)
├── system.css          design system: tokens (light + dark) and every shared component
├── BRIEF.md            design brief the screens were built against
├── preview.html        older single-page preview
├── screens/
│   ├── _components.html   component sheet (buttons, rows, badges, toasts, …)
│   ├── onboarding.html
│   ├── home.html
│   ├── search.html
│   ├── library.html
│   ├── now-playing.html
│   ├── playlist.html
│   ├── downloads.html
│   ├── voice.html
│   ├── device.html
│   └── settings.html
└── review/             screenshots captured during review rounds
```

Screens link `../system.css` and read `?theme=dark` to set `data-theme` on `<html>`;
they must not hard-code colours, sizes or radii.

## Review status

| Screen | Status | Rounds | Score |
|---|---|---|---|
| onboarding | Approved | 4 | 9 |
| home | Approved | 2 | 9 |
| search | Approved | 4 | 9 |
| library | Not approved | 4 | 7.5 |
| now-playing | Not approved | 4 | 8 |
| playlist (was import) | Revised v2.1 | 4 | – |
| downloads | Approved | 4 | 9 |
| voice | Not approved | 4 | 8 |
| device | Not approved | 4 | 8.5 |
| settings | Not approved | 4 | 8.5 |

4 of 10 screens approved. The other six used all 4 review rounds without passing; scores are out of 10.
