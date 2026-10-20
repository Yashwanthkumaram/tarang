package dev.yashwanth.offlineplayer

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/**
 * Hands a downloaded update APK to Android's package installer (D45).
 *
 * Command: install { path } → { status: "installing" | "needs_permission" }
 *
 * The APK must sit in the app cache (shared through the FileProvider's cache-path).
 * Android shows its own confirmation and only accepts an APK signed with the same key as
 * the installed app. The first time, the user has to allow "Install unknown apps" for
 * Tarang; we open that settings page and report "needs_permission".
 */
@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {

  @InvokeArg
  class InstallArgs {
    lateinit var path: String
  }

  @Command
  fun install(invoke: Invoke) {
    val args = invoke.parseArgs(InstallArgs::class.java)
    val file = File(args.path)
    if (!file.isFile) {
      invoke.reject("Update file is missing")
      return
    }
    val result = JSObject()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
      activity.startActivity(settings)
      result.put("status", "needs_permission")
      invoke.resolve(result)
      return
    }
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      activity.startActivity(intent)
    } catch (e: Exception) {
      invoke.reject("Could not open the installer: ${e.message}")
      return
    }
    result.put("status", "installing")
    invoke.resolve(result)
  }
}
