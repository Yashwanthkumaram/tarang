fn main() {
    // Android 15+ devices require 16 KB page-aligned native libraries. NDK r28
    // does this by default; r27 needs the flag. Harmless on older devices.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
