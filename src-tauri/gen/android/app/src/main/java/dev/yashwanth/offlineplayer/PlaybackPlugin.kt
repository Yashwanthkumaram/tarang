package dev.yashwanth.offlineplayer

import android.app.Activity
import android.content.Intent
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlin.concurrent.thread

/**
 * Native playback for Android (docs/modules/playback.md). The Rust commands in
 * `src-tauri/src/commands/playback.rs` call these; the UI never calls them directly.
 *
 * Commands
 *   load          { url?, path?, videoId?, title?, artist?, album?, artworkUrl?, cacheMb?, autoplay?, startMs? }
 *   play / pause / stop
 *   seek          { ms }
 *   setRate       { rate }
 *   setVolume     { volume }            0..1
 *   setQueueHints { hasPrev, hasNext }  shows/hides the notification's previous/next buttons
 *   setMetadata   { title?, artist?, album?, artworkUrl? }
 *   setLiked      { liked }             heart icon of the notification's like button
 *   getState      → { playing, play_when_ready, buffering, ended, position_ms, duration_ms, buffered_ms, loaded, rate, volume, error? }
 *   cacheSize     { cacheMb? } → { bytes }
 *   clearCache    { cacheMb? } → { bytes }   bytes left (songs being read stay)
 *
 * Events (Plugin.trigger; Rust registers a listener per event and re-emits `playback://<event>`)
 *   state   same shape as getState, on play/pause/buffering/ended/error/seek changes
 *   ended   same shape, once when a song finishes
 *   error   { message, code, http_status }
 *   remote  { action: play|pause|seek|next|prev|like, position? (seconds) } from the
 *           notification, lock screen, headset or Bluetooth
 */
@TauriPlugin
class PlaybackPlugin(private val activity: Activity) : Plugin(activity) {

  @InvokeArg
  class LoadArgs {
    var url: String? = null
    var path: String? = null
    var videoId: String? = null
    var title: String? = null
    var artist: String? = null
    var album: String? = null
    var artworkUrl: String? = null
    var cacheMb: Long = PlaybackCore.DEFAULT_CACHE_MB
    var autoplay: Boolean = false
    var startMs: Long = 0
  }

  @InvokeArg class SeekArgs { var ms: Long = 0 }
  @InvokeArg class RateArgs { var rate: Float = 1f }
  @InvokeArg class VolumeArgs { var volume: Float = 1f }
  @InvokeArg class HintArgs { var hasPrev: Boolean = false; var hasNext: Boolean = false }
  @InvokeArg class LikedArgs { var liked: Boolean = false }
  @InvokeArg class CacheArgs { var cacheMb: Long = PlaybackCore.DEFAULT_CACHE_MB }
  @InvokeArg
  class MetaArgs {
    var title: String? = null
    var artist: String? = null
    var album: String? = null
    var artworkUrl: String? = null
  }

  override fun load(webView: WebView) {
    PlaybackCore.emit = { event, payload -> trigger(event, payload) }
  }

  /** Runs [block] on the main looper (the player's thread) and rejects on any exception. */
  private fun onMain(invoke: Invoke, block: () -> Unit) {
    PlaybackCore.main.post {
      try { block() } catch (e: Exception) {
        Log.w(TAG, "${invoke.command} failed", e)
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  /** Starts the media service (idempotent). Media3 promotes it to foreground once playing. */
  private fun ensureService() {
    try {
      activity.startService(Intent(activity, PlaybackService::class.java))
    } catch (e: Exception) {
      // Background start is refused when the service is not already running; the next
      // load from the foreground starts it.
      Log.w(TAG, "startService: $e")
    }
  }

  @Command
  fun load(invoke: Invoke) {
    val a = invoke.parseArgs(LoadArgs::class.java)
    onMain(invoke) {
      PlaybackCore.load(activity, PlaybackCore.Source(
        a.url, a.path, a.videoId, a.title, a.artist, a.album, a.artworkUrl,
        a.cacheMb, a.autoplay, a.startMs,
      ))
      ensureService()
      invoke.resolve(PlaybackCore.state())
    }
  }

  @Command
  fun play(invoke: Invoke) = onMain(invoke) {
    val p = PlaybackCore.exo(activity)
    if (p.playbackState == androidx.media3.common.Player.STATE_IDLE && p.currentMediaItem != null) p.prepare()
    if (p.playbackState == androidx.media3.common.Player.STATE_ENDED) p.seekTo(0)
    ensureService()
    p.play()
    invoke.resolve()
  }

  @Command
  fun pause(invoke: Invoke) = onMain(invoke) { PlaybackCore.exo(activity).pause(); invoke.resolve() }

  @Command
  fun stop(invoke: Invoke) = onMain(invoke) { PlaybackCore.stop(); invoke.resolve() }

  @Command
  fun seek(invoke: Invoke) {
    val a = invoke.parseArgs(SeekArgs::class.java)
    onMain(invoke) { PlaybackCore.exo(activity).seekTo(a.ms.coerceAtLeast(0)); invoke.resolve() }
  }

  @Command
  fun setRate(invoke: Invoke) {
    val a = invoke.parseArgs(RateArgs::class.java)
    onMain(invoke) { PlaybackCore.exo(activity).setPlaybackSpeed(a.rate.coerceIn(0.25f, 4f)); invoke.resolve() }
  }

  @Command
  fun setVolume(invoke: Invoke) {
    val a = invoke.parseArgs(VolumeArgs::class.java)
    onMain(invoke) { PlaybackCore.exo(activity).volume = a.volume.coerceIn(0f, 1f); invoke.resolve() }
  }

  @Command
  fun setQueueHints(invoke: Invoke) {
    val a = invoke.parseArgs(HintArgs::class.java)
    onMain(invoke) { PlaybackCore.setQueueHints(a.hasPrev, a.hasNext); invoke.resolve() }
  }

  @Command
  fun setMetadata(invoke: Invoke) {
    val a = invoke.parseArgs(MetaArgs::class.java)
    onMain(invoke) { PlaybackCore.setMetadata(a.title, a.artist, a.album, a.artworkUrl); invoke.resolve() }
  }

  @Command
  fun setLiked(invoke: Invoke) {
    val a = invoke.parseArgs(LikedArgs::class.java)
    onMain(invoke) { PlaybackCore.setLiked(a.liked); invoke.resolve() }
  }

  @Command
  fun getState(invoke: Invoke) = onMain(invoke) { invoke.resolve(PlaybackCore.state()) }

  @Command
  fun cacheSize(invoke: Invoke) {
    val a = invoke.parseArgs(CacheArgs::class.java)
    thread(name = "playback-cache") {
      try {
        val o = JSObject(); o.put("bytes", PlaybackCore.cacheSize(activity, a.cacheMb)); invoke.resolve(o)
      } catch (e: Exception) { invoke.reject(e.message ?: e.toString()) }
    }
  }

  @Command
  fun clearCache(invoke: Invoke) {
    val a = invoke.parseArgs(CacheArgs::class.java)
    thread(name = "playback-cache") {
      try {
        PlaybackCore.clearCache(activity, a.cacheMb)
        val o = JSObject(); o.put("bytes", PlaybackCore.cacheSize(activity, a.cacheMb)); invoke.resolve(o)
      } catch (e: Exception) { invoke.reject(e.message ?: e.toString()) }
    }
  }

  companion object { private const val TAG = "PlaybackPlugin" }
}
