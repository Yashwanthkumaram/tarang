# Tarang

*Tarang (तरंग) — "wave".* An offline-first music player for Windows, Linux, macOS and Android. It searches YouTube Music and
streams or downloads songs (yt-dlp), keeps playlists and liked songs, imports playlists from
Spotify / YouTube Music / SoundCloud links, and scans the device for audio, keeping voice
recordings separate from music. On Android it plays through a native Media3 player with a
media notification and lock-screen controls.

Built with **Tauri 2** (web UI in a native shell) and a **Rust core** shared by every platform.

```
tarang/
├── crates/core/        Rust library: database (library, playlists), YouTube Music + yt-dlp, imports, scanner, classifier
├── src-tauri/          Tauri shell: commands that expose the core to the UI, Android project
├── src/                Frontend: plain HTML/CSS/JS modules, no build step
├── docs/               Architecture, decisions, one document per module  ← start here
├── design/             The approved v2 screen designs (HTML) the UI was rebuilt from
├── .github/workflows/  CI (core tests) and the release pipeline for every platform
└── scripts/release.sh  Cuts a release: bump version, tag, push
```

## Download

**[⬇️ Get Tarang from the latest release](https://github.com/Yashwanthkumaram/tarang/releases/latest)**:
pick your device in the table at the top of that page. Each device also has a few short
install steps written for non-technical users (including what to click when Windows or
Android warns about an app from an unknown developer).

| Device | File |
|---|---|
| 🪟 Windows | `Tarang_<version>_x64-setup.exe` |
| 🤖 Android | `Tarang_<version>_android-universal.apk` |
| 🍎 Mac | `Tarang_<version>_universal.dmg` |
| 🐧 Linux | `Tarang_<version>_amd64.AppImage` (or the `.deb`) |

Once installed, Tarang updates itself. It checks GitHub once a day and offers new versions,
or you can check by hand in **Settings › About**.

## Releasing

```sh
scripts/release.sh 0.2.0   # bumps every version, commits, tags v0.2.0, pushes
```

The tag starts `.github/workflows/release.yml`. It builds Windows (NSIS), Linux (AppImage + deb),
macOS (universal) and the signed Android APK, uploads them with `latest.json`, and then publishes
the release. Release notes (download table plus install steps) are written by
`scripts/release-notes.sh` just before publishing. Installed apps see the update only once it is published. Repository secrets:
`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `ANDROID_KEYSTORE_BASE64` and
`ANDROID_KEYSTORE_PASSWORD`. The originals are kept outside the repo in `~/.tarang-keys/`. Losing
them means installed apps can no longer be updated, so back them up.

## Run it

Prerequisites are installed in user space (see `docs/modules/toolchain.md`):

```fish
set -x PATH $HOME/.cargo/bin $PATH
set -x JAVA_HOME $HOME/opt/jdk-17
set -x ANDROID_HOME $HOME/Android/Sdk
set -x NDK_HOME $HOME/Android/Sdk/ndk/27.2.12479018
```

| What | Command |
|---|---|
| Core tests | `cargo test -p offline_core` |
| UI preview in a browser (mock data) | `cd src && python3 -m http.server 8765` then open http://127.0.0.1:8765 |
| Desktop app (Linux needs `webkit2gtk-4.1`) | `npx tauri dev`, or `npx tauri build` |
| Quick search from anywhere (Hyprland) | Super+M → `tarang --quick-search` (bound in `~/.config/hypr/user.lua`) |
| Android debug APK | `npx tauri android build --debug --target aarch64 --apk` |
| Install on the connected phone | `adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` |
| Check the Android shell compiles | `cargo check -p offline-player --target aarch64-linux-android` (NDK env vars in `docs/modules/toolchain.md`) |
| Debug the phone's WebView | `adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof dev.yashwanth.offlineplayer)` then `curl 127.0.0.1:9222/json` (Chrome DevTools Protocol) |

## Where things are decided

Every non-obvious choice is written down in `docs/DECISIONS.md`. Each module has its own
page under `docs/modules/` describing what it does, its public surface, and what to touch
when changing it. The commands the UI may call are listed in `docs/API-v2.md`. Colours and
spacing live only in CSS variables (`src/styles/tokens.css`).

## License

Tarang is free software under the [GNU General Public License v3.0 or later](LICENSE).
The Android app bundles [youtubedl-android](https://github.com/JunkFood02/youtubedl-android)
(GPL-3.0), and yt-dlp is downloaded separately and keeps its own Unlicense terms.
