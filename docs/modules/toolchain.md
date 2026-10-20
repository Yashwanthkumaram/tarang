# Module: toolchain & environment

Everything is installed in user space (no sudo) except WebKitGTK.

| Tool | Where | Why |
|---|---|---|
| rustup + stable toolchain + Android targets | `~/.cargo` (`aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`) | the pacman `rust` package cannot add targets; put `~/.cargo/bin` first on `PATH` |
| JDK 17 (Temurin) | `~/opt/jdk-17` | Gradle / Android build |
| Android SDK | `~/Android/Sdk` (cmdline-tools, platform-tools, platforms;android-35, build-tools;35.0.0) | Gradle may download platform 37 on first build |
| Android NDK | `~/Android/Sdk/ndk/27.2.12479018` | compiles the Rust core for arm64 |
| Tauri CLI | `node_modules/.bin/tauri` (`npx tauri`) | builds, icons, Android project |
| WebKitGTK | **not installed** — `sudo pacman -S webkit2gtk-4.1 libappindicator-gtk3` | Linux desktop window |

Environment for every build command:
```fish
set -x PATH $HOME/.cargo/bin $PATH
set -x JAVA_HOME $HOME/opt/jdk-17
set -x ANDROID_HOME $HOME/Android/Sdk
set -x NDK_HOME $HOME/Android/Sdk/ndk/27.2.12479018
```

Quick checks:
```fish
cargo test -p offline_core                                   # core unit tests (18)
cargo check -p offline-player --target aarch64-linux-android # shell compiles for Android
adb devices                                                  # phone must say "device", not "unauthorized"
```
