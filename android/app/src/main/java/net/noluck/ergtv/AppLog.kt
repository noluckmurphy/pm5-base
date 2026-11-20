package net.noluck.ergtv

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Logcat plus a small rolling file on the TV (files/logs/ergtv.log, ~512 KB,
 * one older copy kept as ergtv.log.1). Logcat is lost on a reboot or a busy
 * buffer; this file survives, so a lost RPE or row can be traced afterwards:
 *   adb shell run-as net.noluck.ergtv cat files/logs/ergtv.log
 */
object AppLog {
    private const val TAG = "ErgTV"
    private const val MAX = 512 * 1024
    private val io = Executors.newSingleThreadExecutor()
    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)
    private var file: File? = null

    fun init(context: Context) {
        file = File(context.filesDir, "logs").apply { mkdirs() }.let { File(it, "ergtv.log") }
    }

    fun i(msg: String) { Log.i(TAG, msg); write("I", msg) }
    fun w(msg: String) { Log.w(TAG, msg); write("W", msg) }

    private fun write(level: String, msg: String) {
        val f = file ?: return
        val line = "${fmt.format(Date())} $level $msg\n"
        io.execute {
            try {
                if (f.length() > MAX) f.renameTo(File(f.parentFile, "ergtv.log.1"))
                f.appendText(line)
            } catch (_: Exception) { /* logging must never break the app */ }
        }
    }
}
