package net.noluck.ergtv

import android.content.Context
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Saves each finished workout's session file (tv/summary.js) on the TV, then
 * uploads it to the repo's workout-logs branch with the GitHub Contents API.
 *
 * The token never reaches the page: it lives in the app's private files as
 * `github-token` (put there once with `adb ... run-as`, see README), and
 * only this class reads it. Without a token, or offline, files stay in
 * `workouts/pending/` and go up on the next save or app start.
 */
class WorkoutSaver(private val context: Context, private val onResult: (String, Boolean, String) -> Unit) {

    companion object {
        private const val TAG = "ErgTV"
        private const val REPO = "noluckmurphy/pm5-base"
        private const val BRANCH = "workout-logs"
        private val SAFE_NAME = Regex("^[A-Za-z0-9._-]{1,120}\\.json$")
    }

    private val io = Executors.newSingleThreadExecutor()
    private val pending get() = File(context.filesDir, "workouts/pending").apply { mkdirs() }
    private val sent get() = File(context.filesDir, "workouts/sent").apply { mkdirs() }

    fun save(name: String, json: String) {
        if (!SAFE_NAME.matches(name)) { onResult(name, false, "bad file name"); return }
        io.execute {
            try {
                File(pending, name).writeText(json)
                Log.i(TAG, "workout saved on TV: $name")
            } catch (e: Exception) {
                onResult(name, false, "could not save on the TV: ${e.message}")
                return@execute
            }
            uploadAllNow()
        }
    }

    fun uploadPending() = io.execute { uploadAllNow() }

    private fun token(): String? =
        File(context.filesDir, "github-token").takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.isNotEmpty() }

    private fun uploadAllNow() {
        val files = pending.listFiles()?.sortedBy { it.name } ?: return
        if (files.isEmpty()) return
        val tok = token()
        if (tok == null) {
            files.forEach { onResult(it.name, false, "saved on the TV; no GitHub token yet") }
            return
        }
        for (f in files) {
            val (ok, msg) = try { put(tok, f) } catch (e: Exception) { false to (e.message ?: "network error") }
            if (ok) f.renameTo(File(sent, f.name))
            Log.i(TAG, "workout upload ${f.name}: $ok $msg")
            onResult(f.name, ok, msg)
        }
    }

    private fun put(tok: String, f: File): Pair<Boolean, String> {
        val path = "workouts/${f.name}"
        val url = URL("https://api.github.com/repos/$REPO/contents/$path")
        val body = JSONObject()
            .put("message", "Workout ${f.nameWithoutExtension}")
            .put("branch", BRANCH)
            .put("content", Base64.encodeToString(f.readBytes(), Base64.NO_WRAP))
        val c = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "PUT"
            connectTimeout = 15000; readTimeout = 20000
            doOutput = true
            setRequestProperty("Authorization", "Bearer $tok")
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "erg-tv")
            setRequestProperty("Content-Type", "application/json")
        }
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = c.responseCode
        c.disconnect()
        return when (code) {
            200, 201 -> true to "saved to GitHub"
            422 -> true to "already on GitHub"     // same file name exists: treat as done
            401, 403 -> false to "GitHub token refused ($code)"
            else -> false to "GitHub error $code"
        }
    }
}
