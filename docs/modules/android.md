# Module: Android (`src-tauri/gen/android/`)

## What it is
The Gradle project Tauri generated with `npx tauri android init`, with these edits of ours.
It is committed; regenerating it would lose them.

| File | Our change |
|---|---|
| `app/src/main/AndroidManifest.xml` | permissions: `READ_MEDIA_AUDIO`, `READ_EXTERNAL_STORAGE` (≤32), `MANAGE_EXTERNAL_STORAGE`, `WAKE_LOCK`, `ACCESS_NETWORK_STATE`; `requestLegacyExternalStorage` |
| `app/build.gradle.kts` | `usesCleartextTraffic = "true"` so a plain-HTTP LAN server works |
| `app/src/main/java/dev/yashwanth/offlineplayer/MainActivity.kt` | pads the content view with system-bar insets (status/navigation bar); requests the media permission at launch and opens the "All files access" screen once |
| `src-tauri/build.rs` | links Android targets with `max-page-size=16384` (16 KB page devices) |
| `app/src/main/java/dev/yashwanth/offlineplayer/YtdlpPlugin.kt` | Tauri mobile plugin wrapping `youtubedl-android` (bundled yt-dlp); see core-youtube.md |
| `app/build.gradle.kts` | `youtubedl-android` dependency, `useLegacyPackaging`, `abiFilters arm64-v8a` |
| `app/src/main/java/dev/yashwanth/offlineplayer/Playback{Core,Service,Plugin}.kt` | native playback: Media3 ExoPlayer in a foreground `MediaSessionService` + Tauri plugin `playback`; see playback.md |
| `app/src/main/AndroidManifest.xml` | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS`; `<service .PlaybackService foregroundServiceType="mediaPlayback">` |
| `app/build.gradle.kts` | `androidx.media3` 1.11.1 (`exoplayer`, `session`, `datasource`, `database`) |
| `MainActivity.kt` | also requests `POST_NOTIFICATIONS` (Android 13+), in the same dialog batch as the audio permission |

Everything else (webview setup, asset protocol, IPC) is Tauri's.

## Build & install
`package.json` must keep the `"tauri": "tauri"` script; Gradle's Rust plugin calls `npm run tauri`.

```fish
set -x JAVA_HOME $HOME/opt/jdk-17; set -x ANDROID_HOME $HOME/Android/Sdk; set -x NDK_HOME $HOME/Android/Sdk/ndk/27.2.12479018
npx tauri android build --debug --target aarch64 --apk
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb logcat -s RustStdoutStderr Tauri chromium   # Rust + webview logs
adb logcat -s Playback PlaybackPlugin ExoPlayerImpl   # native playback
```
First run: accept the audio and notification permissions, then enable "All files access" on the settings
screen the app opens. Then Scan & folders → Scan now.

## Platform behaviour in the shared code
* `paths::default_roots()` → `/storage/emulated/0`; default include folders are `Music`,
  `Download`, `Recordings`.
* Folder picking uses the in-app browser (`list_dirs` command) because the system picker
  returns `content://` URIs that `walkdir` cannot use.
* `get_platform().is_mobile` lets views adapt (e.g. hide the native picker).

## Known limits / next steps
1. **Background playback.** Done: native Media3 playback in a foreground service with
   notification and lock-screen controls (playback.md, DECISIONS D23; supersedes D9/D21 on Android).
2. **Scoped storage.** Without All-files access, `walkdir` sees only media files in standard
   folders; recorder apps that store under `Android/data/` stay invisible either way.
3. The release build needs a signing key (`key.properties`, git-ignored).
