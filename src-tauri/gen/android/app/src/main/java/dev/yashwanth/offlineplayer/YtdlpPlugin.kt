package dev.yashwanth.offlineplayer

import android.app.Activity
import android.content.Context
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import com.yausername.youtubedl_android.YoutubeDLResponse
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Runs yt-dlp on the phone through youtubedl-android (bundled Python + yt-dlp).
 * The Rust side calls these commands; it never talks to yt-dlp directly.
 *
 * Commands: download { id, url, dest, name } → { id }
 *           status   {}                       → { ready, error, jobs: [...] }
 *           cancel   { id }                   → {}
 *           version  {}                       → { version }
 *           update   {}                       → { version, status }
 *
 * Speed notes (see docs/modules/core-youtube.md): every yt-dlp call is a fresh Python
 * process, so [load] warms it up once at app start, and [precompileYtdlp] adds
 * bytecode to the yt-dlp zip so Python stops recompiling ~1000 source files per run.
 */
@TauriPlugin
class YtdlpPlugin(private val activity: Activity) : Plugin(activity) {

  @InvokeArg
  class DownloadArgs {
    lateinit var id: String
    lateinit var url: String
    lateinit var dest: String
    lateinit var name: String
  }

  @InvokeArg
  class UrlArgs {
    lateinit var url: String
  }

  @InvokeArg
  class IdArgs {
    lateinit var id: String
  }

  class Job(val id: String, val name: String, val dest: String) {
    @Volatile var progress: Float = 0f
    @Volatile var eta: Long = -1
    @Volatile var state: String = "queued"
    @Volatile var path: String? = null
    @Volatile var error: String? = null
  }

  companion object {
    private const val TAG = "YtdlpPlugin"
    private val jobs = ConcurrentHashMap<String, Job>()
    @Volatile private var ready = false
    @Volatile private var initError: String? = null
    private val initLock = Any()
    private val precompileLock = Any()

    /** Unpacks the bundled Python and yt-dlp on first use (a few seconds, once per install). */
    fun ensureInit(activity: Activity) {
      if (ready) return
      synchronized(initLock) {
        if (ready) return
        try {
          val t = System.currentTimeMillis()
          YoutubeDL.getInstance().init(activity.applicationContext)
          Log.i(TAG, "init took ${System.currentTimeMillis() - t} ms")
          ready = true
          initError = null
        } catch (e: Exception) {
          initError = e.message ?: e.toString()
          throw e
        }
      }
    }

    // youtubedl-android's layout (private to the library, mirrored here for precompile):
    //   <noBackupFilesDir>/youtubedl-android/packages/python/usr   Python home
    //   <noBackupFilesDir>/youtubedl-android/yt-dlp/yt-dlp         the yt-dlp zipapp
    //   <nativeLibraryDir>/libpython.so                             the Python executable
    private fun baseDir(ctx: Context) = File(ctx.noBackupFilesDir, "youtubedl-android")
    private fun packagesDir(ctx: Context) = File(baseDir(ctx), "packages")
    private fun ytdlpZip(ctx: Context) = File(baseDir(ctx), "yt-dlp/yt-dlp")

    /** "<size>:<mtime>" of the zip we last precompiled, so app start skips the check. */
    private fun stamp(zip: File) = "${zip.length()}:${zip.lastModified()}"
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("ytdlp", Context.MODE_PRIVATE)

    /**
     * The yt-dlp release is a zip of ~1000 .py files with no bytecode, and Python cannot
     * cache bytecode for modules inside a zip, so every run recompiled yt-dlp (0.4 s on a
     * desktop CPU, more on the phone). zipimport does load a `.pyc` stored next to each
     * `.py` when its header matches the source entry, so we compile once with the bundled
     * interpreter and rewrite the zip. Falls back to source silently if anything mismatches.
     * Runs after init and after every self-update (which replaces the zip).
     */
    fun precompileYtdlp(ctx: Context) {
      synchronized(precompileLock) {
        val zip = ytdlpZip(ctx)
        val python = File(ctx.applicationInfo.nativeLibraryDir, "libpython.so")
        val pythonHome = File(packagesDir(ctx), "python/usr")
        if (!zip.isFile || !python.isFile || !pythonHome.isDirectory) { Log.w(TAG, "precompile: layout not found (${zip.isFile} ${python.isFile} ${pythonHome.isDirectory})"); return }
        if (prefs(ctx).getString("precompiled", "") == stamp(zip)) return
        // The zipapp starts with a shebang line, which java.util.zip rejects, so the
        // bytecode check happens in Python too.
        val script = """
import sys, zipfile, time, os
import importlib._bootstrap_external as be
src = sys.argv[1]; tmp = src + '.tmp'
n = 0
with zipfile.ZipFile(src) as zi:
    if any(name.endswith('.pyc') for name in zi.namelist()):
        print('already has bytecode'); sys.exit(0)
with zipfile.ZipFile(src) as zi, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zo:
    for info in zi.infolist():
        data = zi.read(info)
        zo.writestr(info, data)
        if info.filename.endswith('.py'):
            try:
                code = compile(data, info.filename, 'exec', dont_inherit=True)
            except SyntaxError:
                continue
            mtime = int(time.mktime(info.date_time + (-1, -1, -1)))
            pi = zipfile.ZipInfo(info.filename + 'c', info.date_time)
            pi.compress_type = zipfile.ZIP_DEFLATED
            zo.writestr(pi, be._code_to_timestamp_pyc(code, mtime, len(data)))
            n += 1
os.replace(tmp, src)
print('compiled', n)
""".trimIndent()
        val t = System.currentTimeMillis()
        try {
          val pb = ProcessBuilder(python.absolutePath, "-c", script, zip.absolutePath) // no -I: it would ignore PYTHONHOME
          pb.environment().apply {
            put("LD_LIBRARY_PATH", File(pythonHome, "lib").absolutePath)
            put("PYTHONHOME", pythonHome.absolutePath)
            put("HOME", packagesDir(ctx).absolutePath)
            put("TMPDIR", ctx.cacheDir.absolutePath)
          }
          pb.redirectErrorStream(true)
          val p = pb.start()
          val out = p.inputStream.bufferedReader().readText()
          if (!p.waitFor(120, TimeUnit.SECONDS)) { p.destroy(); Log.w(TAG, "precompile timed out"); return }
          Log.i(TAG, "precompile rc=${p.exitValue()} in ${System.currentTimeMillis() - t} ms: ${out.trim().take(300)}")
          if (p.exitValue() == 0) prefs(ctx).edit().putString("precompiled", stamp(zip)).apply()
        } catch (e: Exception) {
          Log.w(TAG, "precompile failed: $e")
        }
        File(zip.path + ".tmp").delete()
      }
    }

    /** Normal yt-dlp YouTube options: audio comes from the player response, so the
     *  HLS/DASH manifests and translated subtitles are never fetched. `visionos` first: it is
     *  the only client whose audio links play without anti-bot tokens; the phone's default
     *  pick (ANDROID) returns links that answer 403 (D46). */
    const val EXTRACTOR_ARGS = "youtube:player_client=visionos,default;skip=hls,dash,translated_subs"
    /** Options once YouTube has blocked this address: the embedded-player client still
     *  gets stream URLs there; the default clients stay in the list for non-embeddable songs. */
    const val BLOCKED_EXTRACTOR_ARGS = "youtube:player_client=visionos,web_embedded,default;skip=hls,dash,translated_subs"

    /** True while this network's address is known to be blocked by YouTube. */
    @Volatile private var blocked = false
    /** Where [blocked] is remembered across launches (for [BLOCKED_TTL_MS]). */
    @Volatile private var prefs: android.content.SharedPreferences? = null
    private const val BLOCKED_KEY = "address_blocked_until"
    private const val BLOCKED_TTL_MS = 12L * 3600 * 1000
    private const val AUTO_UPDATE_KEY = "auto_update_checked_at"
    private const val AUTO_UPDATE_EVERY_MS = 24L * 3600 * 1000

    /** yt-dlp's cache (player JS and solved signature challenges). Without it every run
     *  re-downloads and re-solves the player, which costs tens of seconds with quickjs. */
    @Volatile private var cacheDir: String? = null

    /** Loads the remembered "address blocked" flag (it expires so normal clients are tried
     *  again) and picks yt-dlp's cache directory. */
    fun loadNetworkPrefs(context: Context) {
      cacheDir = File(context.cacheDir, "yt-dlp").also { it.mkdirs() }.absolutePath
      val p = context.getSharedPreferences("ytdlp", Context.MODE_PRIVATE)
      prefs = p
      if (p.getLong(BLOCKED_KEY, 0L) > System.currentTimeMillis()) blocked = true
    }

    /** YouTube's answer when it blocks an address: a bot check, often after HTTP 429. */
    private fun isAddressBlock(msg: String?): Boolean =
      msg != null && (msg.contains("not a bot") || msg.contains("HTTP Error 429"))

    /**
     * Runs a yt-dlp request built by [build], which receives the `--extractor-args` value
     * to use. ISPs often share one IPv4 address between many customers (CGNAT) and
     * YouTube answers such addresses with "Sign in to confirm you're not a bot" for its
     * default clients, while the embedded-player client still works. On that error we
     * retry once with [BLOCKED_EXTRACTOR_ARGS] and, if it succeeds, keep using it for
     * [BLOCKED_TTL_MS] (DECISIONS D41). A cancelled job (removed from [jobs]) is not
     * retried. The original error is rethrown when the retry also fails.
     */
    fun execute(processId: String?, callback: ((Float, Long, String) -> Unit)?, buildRaw: (String) -> YoutubeDLRequest): YoutubeDLResponse {
      val build = { xargs: String -> buildRaw(xargs).also { r -> cacheDir?.let { r.addOption("--cache-dir", it) } } }
      if (blocked) return YoutubeDL.getInstance().execute(build(BLOCKED_EXTRACTOR_ARGS), processId, callback)
      try {
        return YoutubeDL.getInstance().execute(build(EXTRACTOR_ARGS), processId, callback)
      } catch (e: Exception) {
        if (!isAddressBlock(e.message)) throw e
        if (processId != null && !jobs.containsKey(processId)) throw e
        Log.w(TAG, "YouTube blocked this address; retrying with the embedded-player client")
        val r = try { YoutubeDL.getInstance().execute(build(BLOCKED_EXTRACTOR_ARGS), processId, callback) } catch (e2: Exception) {
          Log.w(TAG, "retry failed too: ${e2.message?.lines()?.lastOrNull { it.contains("ERROR") }}")
          throw e
        }
        blocked = true
        prefs?.edit()?.putLong(BLOCKED_KEY, System.currentTimeMillis() + BLOCKED_TTL_MS)?.apply()
        return r
      }
    }

    /** One `yt-dlp --version` run: fills the OS page cache and the stdlib __pycache__. */
    fun warmUp() {
      try {
        val t = System.currentTimeMillis()
        val req = YoutubeDLRequest(emptyList<String>())
        req.addOption("--version")
        val r = YoutubeDL.getInstance().execute(req, "warm-up", null)
        Log.i(TAG, "warm-up: yt-dlp ${r.out.trim()} in ${System.currentTimeMillis() - t} ms")
      } catch (e: Exception) {
        Log.w(TAG, "warm-up failed: $e")
      }
    }
  }

  override fun load(webView: WebView) {
    loadNetworkPrefs(activity.applicationContext)
    thread(name = "ytdlp-init") {
      try {
        ensureInit(activity)
        autoUpdate(activity.applicationContext)
        precompileYtdlp(activity.applicationContext)
        warmUp()
      } catch (e: Exception) {
        Log.w(TAG, "init failed: $e")
      }
    }
  }

  /**
   * Resolves a direct, device-bound audio stream URL (yt-dlp -g) for streaming playback.
   * Must run on the phone: googlevideo URLs are bound to the requesting IP address.
   * Returns { url, ms }.
   */
  @Command
  fun resolve(invoke: Invoke) {
    val args = invoke.parseArgs(UrlArgs::class.java)
    thread(name = "ytdlp-resolve") {
      try {
        ensureInit(activity)
        val t = System.currentTimeMillis()
        val resp = execute(null, null) { xargs ->
          val req = YoutubeDLRequest(args.url)
          req.addOption("--no-playlist")
          req.addOption("--no-warnings")
          req.addOption("-f", "140/bestaudio[ext=m4a]/bestaudio")
          req.addOption("--extractor-args", xargs)
          // URL plus the HTTP headers googlevideo expects for it: links from some player
          // clients (e.g. ANDROID) answer 403 to any other User-Agent (D46).
          req.addOption("--print", "%(url)s\t%(http_headers)j")
          req
        }
        val line = resp.out.lines().map { it.trim() }.firstOrNull { it.startsWith("http") }
        if (line == null) { invoke.reject("yt-dlp returned no stream URL"); return@thread }
        val url = line.substringBefore('\t')
        val headers = JSObject()
        try {
          val h = org.json.JSONObject(line.substringAfter('\t', "{}"))
          for (k in h.keys()) headers.put(k, h.getString(k))
        } catch (_: Exception) { /* no headers: plain URL */ }
        val out = JSObject()
        out.put("url", url)
        out.put("headers", headers)
        out.put("ms", System.currentTimeMillis() - t)
        invoke.resolve(out)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "resolve failed")
      }
    }
  }

  @Command
  fun download(invoke: Invoke) {
    val args = invoke.parseArgs(DownloadArgs::class.java)
    val job = Job(args.id, args.name, args.dest)
    jobs[args.id] = job
    thread(name = "ytdlp-${args.id}") {
      val t = System.currentTimeMillis()
      try {
        ensureInit(activity)
        job.state = "active"
        val response = execute(args.id, { progress, etaSeconds, _ ->
          job.progress = progress
          job.eta = etaSeconds
        }) { xargs ->
          val req = YoutubeDLRequest(args.url)
          req.addOption("--no-playlist")
          req.addOption("--no-mtime")
          req.addOption("--no-warnings")
          req.addOption("--newline")   // one progress line per update: the library's parser needs this
          req.addOption("--progress")  // stdout is not a terminal, so force progress output
          req.addOption("-v")          // timing of each step lands in logcat (see below)
          // itag 140 is YouTube's standard 128 kbps AAC; naming it first skips format probing.
          req.addOption("-f", "140/bestaudio[ext=m4a]/bestaudio")
          // Audio comes from the player response; skip the HLS/DASH manifests and translated subs.
          req.addOption("--extractor-args", xargs)
          req.addOption("-o", "${args.dest}/${args.name}.%(ext)s")
          req.addOption("--print", "after_move:FILE %(filepath)s")
          req
        }
        job.path = response.out.lines().firstOrNull { it.startsWith("FILE ") }?.removePrefix("FILE ")?.trim()
        job.progress = 100f
        job.state = if (job.path != null) "done" else "error"
        if (job.path == null) job.error = "yt-dlp finished but reported no file"
        Log.i(TAG, "download ${args.id} ${job.state} in ${System.currentTimeMillis() - t} ms")
        for (line in response.err.lines()) if (line.isNotBlank() && !line.startsWith("[download]")) Log.d(TAG, line)
      } catch (e: Exception) {
        job.state = "error"
        job.error = (e.message ?: e.toString()).lines().lastOrNull { it.contains("ERROR") }?.removePrefix("ERROR: ") ?: (e.message ?: "download failed")
        Log.w(TAG, "download ${args.id} failed in ${System.currentTimeMillis() - t} ms: ${job.error}")
        for (line in (e.message ?: "").lines()) if (line.isNotBlank() && !line.startsWith("[download]")) Log.d(TAG, line)
      }
    }
    val out = JSObject()
    out.put("id", args.id)
    invoke.resolve(out)
  }

  @Command
  fun status(invoke: Invoke) {
    val arr = JSArray()
    for (j in jobs.values) {
      val o = JSObject()
      o.put("id", j.id); o.put("name", j.name); o.put("dest", j.dest)
      o.put("progress", j.progress.toDouble()); o.put("eta", j.eta)
      o.put("state", j.state); o.put("path", j.path ?: ""); o.put("error", j.error ?: "")
      arr.put(o)
    }
    val out = JSObject()
    out.put("ready", ready)
    out.put("error", initError ?: "")
    out.put("jobs", arr)
    invoke.resolve(out)
  }

  @Command
  fun cancel(invoke: Invoke) {
    val args = invoke.parseArgs(IdArgs::class.java)
    try { YoutubeDL.getInstance().destroyProcessById(args.id) } catch (_: Exception) {}
    jobs.remove(args.id)
    invoke.resolve()
  }

  @Command
  fun version(invoke: Invoke) {
    thread {
      val out = JSObject()
      try {
        ensureInit(activity)
        out.put("version", YoutubeDL.getInstance().version(activity.applicationContext) ?: "unknown")
        invoke.resolve(out)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "yt-dlp not ready")
      }
    }
  }

  /**
   * Keeps yt-dlp current without the user doing anything (D46): YouTube changes often, and
   * the copy bundled in the APK stops streaming within weeks (it returned links that answer
   * 403). At most once a day, at start-up. First compares the real `yt-dlp --version` with
   * the version the library has recorded: when they differ (e.g. app data restored onto a
   * fresh install), the record is cleared so the library does not skip the download.
   */
  private fun autoUpdate(context: Context) {
    val p = context.getSharedPreferences("ytdlp", Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    if (now - p.getLong(AUTO_UPDATE_KEY, 0L) < AUTO_UPDATE_EVERY_MS) return
    try {
      val actual = YoutubeDL.getInstance()
        .execute(YoutubeDLRequest(emptyList<String>()).apply { addOption("--version") })
        .out.trim()
      val recorded = YoutubeDL.getInstance().version(context)
      if (actual.isNotEmpty() && actual != recorded) {
        Log.i(TAG, "yt-dlp is $actual but recorded as $recorded; forcing an update")
        context.getSharedPreferences("youtubedl-android", Context.MODE_PRIVATE).edit()
          .remove("dlpVersion").remove("dlpVersionName").apply()
      }
      val status = YoutubeDL.getInstance().updateYoutubeDL(context, YoutubeDL.UpdateChannel.STABLE)
      Log.i(TAG, "yt-dlp auto-update: $status (${YoutubeDL.getInstance().version(context)})")
      p.edit().putLong(AUTO_UPDATE_KEY, now).apply()
    } catch (e: Exception) {
      Log.w(TAG, "yt-dlp auto-update failed (offline?): ${e.message}") // try again next start
    }
  }

  /** Self-updates yt-dlp inside the app, so YouTube changes do not need a new APK. */
  @Command
  fun update(invoke: Invoke) {
    thread {
      try {
        ensureInit(activity)
        val status = YoutubeDL.getInstance().updateYoutubeDL(activity.applicationContext, YoutubeDL.UpdateChannel.STABLE)
        precompileYtdlp(activity.applicationContext) // the update replaced the zip with a source-only one
        val out = JSObject()
        out.put("status", status?.name ?: "UNKNOWN")
        out.put("version", YoutubeDL.getInstance().version(activity.applicationContext) ?: "unknown")
        invoke.resolve(out)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "update failed")
      }
    }
  }
}
