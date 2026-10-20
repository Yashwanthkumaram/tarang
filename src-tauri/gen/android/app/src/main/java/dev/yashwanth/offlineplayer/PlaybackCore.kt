package dev.yashwanth.offlineplayer

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebSettings
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CommandButton
import androidx.media3.session.SessionCommand
import app.tauri.plugin.JSObject
import java.io.File
import java.util.IdentityHashMap

/**
 * Process-wide native player shared by [PlaybackPlugin] (commands from the UI) and
 * [PlaybackService] (media session, notification, lock screen).
 *
 * The player lives here rather than inside the service so UI commands work whether or not
 * the service is currently running; the service only wraps it in a MediaSession.
 *
 * Two entry points into the player:
 *  - [exo]    the raw ExoPlayer, used by the UI's own commands (no remote events);
 *  - [remote] a [RemotePlayer] wrapper handed to the MediaSession: every action arriving
 *             through it came from the notification, lock screen, headset or Bluetooth, so it
 *             is reported to the UI as a `remote` event. Next/previous are not executed
 *             natively at all — the queue lives in the UI, which answers with a new `load`.
 *
 * Everything that touches the player must run on the main looper ([main]).
 */
@OptIn(UnstableApi::class)
object PlaybackCore {
  private const val TAG = "Playback"
  const val DEFAULT_CACHE_MB = 256L
  const val LIKE_ACTION = "dev.yashwanth.offlineplayer.LIKE"
  val LIKE_COMMAND = SessionCommand(LIKE_ACTION, android.os.Bundle.EMPTY)

  val main = Handler(Looper.getMainLooper())

  /** Delivers an event (name, payload) to the UI. Set by [PlaybackPlugin.load]. */
  @Volatile var emit: ((String, JSObject) -> Unit)? = null

  /** Called when the like state changes so the service can redraw its button. */
  var onLikedChanged: (() -> Unit)? = null

  private var exoPlayer: ExoPlayer? = null
  private var remotePlayer: RemotePlayer? = null

  private var cache: SimpleCache? = null
  private var cacheMb: Long = 0
  private var dbProvider: StandaloneDatabaseProvider? = null
  private var streamFactory: DefaultMediaSourceFactory? = null
  private var localFactory: DefaultMediaSourceFactory? = null

  var hasPrev = false; private set
  var hasNext = false; private set
  var liked = false; private set
  /** Last player error, cleared by the next load. */
  private var lastError: String? = null

  // ---------------------------------------------------------------- player

  fun exo(ctx: Context): ExoPlayer {
    exoPlayer?.let { return it }
    val attrs = AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
      .build()
    val p = ExoPlayer.Builder(ctx.applicationContext)
      .setAudioAttributes(attrs, /* handleAudioFocus= */ true)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    p.addListener(StateListener)
    exoPlayer = p
    return p
  }

  fun remote(ctx: Context): RemotePlayer {
    remotePlayer?.let { return it }
    val r = RemotePlayer(exo(ctx))
    remotePlayer = r
    return r
  }

  /** Arguments of the `load` command (see PlaybackPlugin.LoadArgs). */
  class Source(
    val url: String?, val path: String?, val videoId: String?,
    val title: String?, val artist: String?, val album: String?, val artworkUrl: String?,
    val cacheMb: Long, val autoplay: Boolean, val startMs: Long,
  )

  fun load(ctx: Context, s: Source) {
    val p = exo(ctx)
    lastError = null
    val local = !s.path.isNullOrEmpty()
    val uri = when {
      local -> Uri.fromFile(File(s.path!!))
      !s.url.isNullOrEmpty() -> Uri.parse(s.url)
      else -> throw IllegalArgumentException("load needs a path or a url")
    }
    val item = MediaItem.Builder()
      .setUri(uri)
      .setMediaId(s.videoId ?: s.path ?: s.url!!)
      .setMediaMetadata(metadata(s.title, s.artist, s.album, s.artworkUrl))
    if (!local) {
      // Stream URLs change on every resolve (signature, expiry), so the cache is keyed by
      // video id + format; the same song streamed again plays from disk.
      val itag = uri.getQueryParameter("itag") ?: "0"
      item.setCustomCacheKey(if (s.videoId != null) "yt:${s.videoId}:$itag" else uri.toString())
    }
    val mediaItem = item.build()
    val factory = if (local) localFactory(ctx) else {
      if (cache != null && s.cacheMb != cacheMb) p.clearMediaItems() // free the old cache's spans
      streamFactory(ctx, s.cacheMb)
    }
    p.setMediaSource(factory.createMediaSource(mediaItem), if (s.startMs > 0) s.startMs else 0L)
    p.prepare()
    p.playWhenReady = s.autoplay
  }

  fun setMetadata(title: String?, artist: String?, album: String?, artworkUrl: String?) {
    val p = exoPlayer ?: return
    val cur = p.currentMediaItem ?: return
    // Same URI + cache key, so ExoPlayer swaps the metadata without re-buffering.
    p.replaceMediaItem(p.currentMediaItemIndex, cur.buildUpon().setMediaMetadata(metadata(title, artist, album, artworkUrl)).build())
  }

  private fun metadata(title: String?, artist: String?, album: String?, artworkUrl: String?): MediaMetadata {
    val b = MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(album)
    if (!artworkUrl.isNullOrEmpty()) b.setArtworkUri(Uri.parse(artworkUrl))
    return b.build()
  }

  fun setQueueHints(prev: Boolean, next: Boolean) {
    if (prev == hasPrev && next == hasNext) return
    hasPrev = prev
    hasNext = next
    remotePlayer?.commandsChanged()
  }

  fun setLiked(value: Boolean) {
    if (value == liked) return
    liked = value
    onLikedChanged?.invoke()
  }

  fun likeButton(): CommandButton =
    CommandButton.Builder(if (liked) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED)
      .setDisplayName(if (liked) "Unlike" else "Like")
      .setSessionCommand(LIKE_COMMAND)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  fun state(): JSObject {
    val o = JSObject()
    val p = exoPlayer
    if (p == null) {
      o.put("playing", false); o.put("buffering", false); o.put("ended", false)
      o.put("position_ms", 0); o.put("duration_ms", 0); o.put("buffered_ms", 0)
      o.put("loaded", false)
      return o
    }
    val dur = p.duration
    o.put("playing", p.isPlaying)
    o.put("play_when_ready", p.playWhenReady)
    o.put("buffering", p.playbackState == Player.STATE_BUFFERING)
    o.put("ended", p.playbackState == Player.STATE_ENDED)
    o.put("position_ms", p.currentPosition)
    o.put("duration_ms", if (dur == C.TIME_UNSET) 0 else dur)
    o.put("buffered_ms", p.bufferedPosition)
    o.put("loaded", p.currentMediaItem != null)
    o.put("rate", p.playbackParameters.speed.toDouble())
    o.put("volume", p.volume.toDouble())
    lastError?.let { o.put("error", it) }
    return o
  }

  fun stop() {
    exoPlayer?.let { it.stop(); it.clearMediaItems() }
  }

  // ---------------------------------------------------------------- stream cache

  private fun cacheDir(ctx: Context) = File(ctx.cacheDir, "stream-cache")

  /** LRU disk cache for streamed songs. Its size is fixed per instance; a new size swaps it. */
  @Synchronized
  fun cache(ctx: Context, mb: Long): SimpleCache {
    val want = if (mb > 0) mb else DEFAULT_CACHE_MB
    cache?.let { c ->
      if (want == cacheMb) return c
      c.release()
      cache = null
      streamFactory = null
    }
    val db = dbProvider ?: StandaloneDatabaseProvider(ctx.applicationContext).also { dbProvider = it }
    val c = SimpleCache(cacheDir(ctx), LeastRecentlyUsedCacheEvictor(want * 1024 * 1024), db)
    cache = c
    cacheMb = want
    Log.i(TAG, "stream cache: ${want} MB at ${cacheDir(ctx)}")
    return c
  }

  /** Existing cache, or one with the default size; does not change the size of a live one. */
  @Synchronized
  private fun anyCache(ctx: Context, mb: Long): SimpleCache = cache ?: cache(ctx, mb)

  fun cacheSize(ctx: Context, mb: Long): Long = anyCache(ctx, mb).cacheSpace

  /** Removes every cached song that is not being read right now. */
  fun clearCache(ctx: Context, mb: Long) {
    val c = anyCache(ctx, mb)
    for (key in c.keys.toList()) {
      try { c.removeResource(key) } catch (e: Exception) { Log.w(TAG, "cache remove $key: $e") }
    }
  }

  private fun httpFactory(ctx: Context): DefaultHttpDataSource.Factory {
    // Same user agent the WebView used when it played these links (D22), which googlevideo accepts.
    val ua = try { WebSettings.getDefaultUserAgent(ctx) } catch (_: Exception) { null }
    val f = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(15_000).setReadTimeoutMs(20_000)
    if (ua != null) f.setUserAgent(ua)
    return f
  }

  private fun streamFactory(ctx: Context, mb: Long): DefaultMediaSourceFactory {
    val c = cache(ctx, mb)
    streamFactory?.let { return it }
    val ds = CacheDataSource.Factory()
      .setCache(c)
      .setUpstreamDataSourceFactory(DefaultDataSource.Factory(ctx, httpFactory(ctx)))
      .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    return DefaultMediaSourceFactory(ds).also { streamFactory = it }
  }

  private fun localFactory(ctx: Context): DefaultMediaSourceFactory =
    localFactory ?: DefaultMediaSourceFactory(ctx).also { localFactory = it }

  // ---------------------------------------------------------------- events

  fun send(event: String, payload: JSObject) {
    try { emit?.invoke(event, payload) } catch (e: Exception) { Log.w(TAG, "emit $event: $e") }
  }

  fun remoteAction(action: String, positionMs: Long? = null) {
    val o = JSObject()
    o.put("action", action)
    if (positionMs != null) o.put("position", positionMs / 1000.0)
    send("remote", o)
  }

  private object StateListener : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      if (events.containsAny(
          Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_PLAYBACK_STATE_CHANGED,
          Player.EVENT_PLAY_WHEN_READY_CHANGED, Player.EVENT_PLAYER_ERROR,
          Player.EVENT_POSITION_DISCONTINUITY,
        )) {
        send("state", state())
      }
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
      if (playbackState == Player.STATE_ENDED) send("ended", state())
    }

    override fun onPlayerError(error: PlaybackException) {
      lastError = "${error.errorCodeName}: ${error.message ?: ""}".trim()
      Log.w(TAG, "player error", error)
      val o = JSObject()
      o.put("message", lastError)
      o.put("code", error.errorCode)
      // 403/410 from googlevideo means the stream link expired: the UI should re-resolve.
      o.put("http_status", (error.cause as? androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException)?.responseCode ?: 0)
      send("error", o)
    }
  }
}

/**
 * The player the MediaSession sees. Adds next/previous according to the UI's queue hints,
 * reports every action to the UI, and leaves next/previous to the UI entirely.
 */
@OptIn(UnstableApi::class)
class RemotePlayer(private val inner: ExoPlayer) : ForwardingPlayer(inner) {
  // Listeners are forwarded by ForwardingPlayer itself. Do not wrap them with
  // `Player.Listener by target`: every Listener method is a Java default method, which Kotlin
  // delegation does not forward, so the session would miss play/pause/position updates.
  private val listeners: MutableSet<Player.Listener> = java.util.Collections.newSetFromMap(IdentityHashMap())

  init {
    // The inner player announces its own (unfiltered) commands; follow up with ours.
    inner.addListener(object : Player.Listener {
      override fun onAvailableCommandsChanged(availableCommands: Player.Commands) {
        PlaybackCore.main.post { commandsChanged() }
      }
    })
  }

  private fun commands(base: Player.Commands): Player.Commands {
    val b = base.buildUpon()
    if (PlaybackCore.hasNext) b.addAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
    else b.removeAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
    if (PlaybackCore.hasPrev) b.addAll(Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
    else b.remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
    return b.build()
  }

  override fun getAvailableCommands(): Player.Commands = commands(inner.availableCommands)
  override fun isCommandAvailable(command: Int): Boolean = availableCommands.contains(command)

  /** Re-announces the available commands after the queue hints changed. */
  fun commandsChanged() {
    val cmds = availableCommands
    for (l in listeners.toList()) l.onAvailableCommandsChanged(cmds)
  }

  override fun addListener(listener: Player.Listener) {
    listeners.add(listener)
    super.addListener(listener)
  }

  override fun removeListener(listener: Player.Listener) {
    listeners.remove(listener)
    super.removeListener(listener)
  }

  // Remote actions --------------------------------------------------------------

  override fun play() {
    PlaybackCore.remoteAction("play")
    super.play()
  }

  override fun pause() {
    PlaybackCore.remoteAction("pause")
    super.pause()
  }

  override fun setPlayWhenReady(playWhenReady: Boolean) {
    PlaybackCore.remoteAction(if (playWhenReady) "play" else "pause")
    super.setPlayWhenReady(playWhenReady)
  }

  /** "Stop" from an old-style controller: pause instead, so the song stays loaded. */
  override fun stop() {
    PlaybackCore.remoteAction("pause")
    super.pause()
  }

  override fun seekTo(positionMs: Long) {
    PlaybackCore.remoteAction("seek", positionMs)
    super.seekTo(positionMs)
  }

  override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
    PlaybackCore.remoteAction("seek", positionMs)
    super.seekTo(mediaItemIndex, positionMs)
  }

  override fun seekToNext() = PlaybackCore.remoteAction("next")
  override fun seekToNextMediaItem() = PlaybackCore.remoteAction("next")
  override fun seekToPrevious() = PlaybackCore.remoteAction("prev")
  override fun seekToPreviousMediaItem() = PlaybackCore.remoteAction("prev")
}
