package dev.yashwanth.offlineplayer

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * Foreground media service: wraps [PlaybackCore]'s player in a MediaSession. Media3 then
 * provides the media notification, lock-screen controls, Bluetooth/headset buttons, and
 * keeps the service in the foreground while playing (and for a while after pausing).
 *
 * Started by [PlaybackPlugin] on every `load`; stops itself when the user swipes the app
 * away (the queue lives in the UI, so nothing could advance without it).
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
  private var session: MediaSession? = null

  override fun onCreate() {
    super.onCreate()
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val s = MediaSession.Builder(this, PlaybackCore.remote(this))
      .setSessionActivity(open)
      .setCallback(Callback)
      .setMediaButtonPreferences(listOf(PlaybackCore.likeButton()))
      .build()
    session = s
    // No MediaController binds to us (the UI talks to the player directly), so register the
    // session explicitly; otherwise the notification manager would never see it.
    addSession(s)
    PlaybackCore.onLikedChanged = { session?.setMediaButtonPreferences(listOf(PlaybackCore.likeButton())) }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    pauseAllPlayersAndStopSelf()
  }

  override fun onDestroy() {
    PlaybackCore.onLikedChanged = null
    session?.release() // the player itself belongs to PlaybackCore and outlives the service
    session = null
    super.onDestroy()
  }

  private object Callback : MediaSession.Callback {
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
      val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
        .add(PlaybackCore.LIKE_COMMAND)
        .build()
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
        .setAvailableSessionCommands(commands)
        .build()
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      if (customCommand.customAction == PlaybackCore.LIKE_ACTION) {
        // Flip the icon right away; the UI confirms (or reverts) through setLiked.
        PlaybackCore.setLiked(!PlaybackCore.liked)
        PlaybackCore.remoteAction("like")
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
      return super.onCustomCommand(session, controller, customCommand, args)
    }
  }
}
