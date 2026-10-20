import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing (D45): CI passes TARANG_KEYSTORE_* env vars; locally a git-ignored
// keystore.properties (storeFile, storePassword, keyAlias, keyPassword) next to settings.gradle.kts.
// Debug builds use the same key when it is available, so an installed debug build can take OTA updates.
val keystoreProperties = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(key: String, env: String): String? = System.getenv(env)?.takeIf { it.isNotEmpty() } ?: keystoreProperties.getProperty(key)
val releaseStoreFile = signingValue("storeFile", "TARANG_KEYSTORE_PATH")

android {
    compileSdk = 37
    namespace = "dev.yashwanth.offlineplayer"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "true" // the user's LAN server is plain http
        applicationId = "dev.yashwanth.offlineplayer"
        minSdk = 24
        ndk { abiFilters += listOf("arm64-v8a") } // the only ABI we ship; keeps the Python bundle to one copy
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (releaseStoreFile != null) {
            create("tarang") {
                storeFile = file(releaseStoreFile)
                storePassword = signingValue("storePassword", "TARANG_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "TARANG_KEY_ALIAS") ?: "tarang"
                keyPassword = signingValue("keyPassword", "TARANG_KEY_PASSWORD") ?: storePassword
            }
        }
    }
    packaging {
        jniLibs.useLegacyPackaging = true // youtubedl-android needs extracted native libs
    }
    buildTypes {
        getByName("debug") {
            signingConfigs.findByName("tarang")?.let { signingConfig = it }
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfigs.findByName("tarang")?.let { signingConfig = it }
            // No R8: Tauri plugins, youtubedl-android and Media3 are reached through reflection.
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // yt-dlp on Android: bundled Python runtime + yt-dlp with in-app self-update (GPL-3.0)
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    // Native playback: ExoPlayer in a MediaSessionService (docs/modules/playback.md)
    val media3 = "1.11.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-session:$media3")
    implementation("androidx.media3:media3-datasource:$media3")
    implementation("androidx.media3:media3-database:$media3")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
