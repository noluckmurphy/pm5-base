package net.noluck.ergtv

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * Full-screen WebView showing the bundled display (tv/index.html) plus a
 * Bluetooth bridge, because Android WebView has no Web Bluetooth.
 * The page drives connect/disconnect through window.PM5Android and gets
 * data back through window.pm5native (lib/pm5-native.js).
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var link: PM5Link
    private lateinit var saver: WorkoutSaver
    private var wantConnection = false

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLog.init(this)
        AppLog.i("lifecycle onCreate")
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        link = PM5Link(
            this,
            onState = { state, info ->
                val json = JSONObject(info as Map<*, *>).toString()
                js("window.pm5native && window.pm5native.onState(${q(state)}, ${q(json)})")
            },
            onPacket = { id, bytes ->
                val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                runOnUiThread { js("window.pm5native && window.pm5native.onPacket('$id','$b64')") }
            },
        )

        saver = WorkoutSaver(this) { name, ok, msg ->
            runOnUiThread { js("window.ergtvSaved && window.ergtvSaved(${q(name)}, $ok, ${q(msg)})") }
        }

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            setBackgroundColor(0xFF050608.toInt())
            isFocusable = true
            isFocusableInTouchMode = true
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)
            }
            // Page console -> logcat, so a row can be read back with
            // `adb logcat -s ErgTV`.
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    // [ergtv] state, split and ui lines also go to the file log; the
                    // 4/s status chatter stays in logcat only.
                    if ((m.message().startsWith("[ergtv]") && !m.message().startsWith("[ergtv] status")) || m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) AppLog.i("${m.messageLevel()} ${m.message()}")
                    else Log.i("ErgTV", "${m.messageLevel()} ${m.message()}")
                    return true
                }
            }
            addJavascriptInterface(Bridge(), "PM5Android")
        }
        setContentView(web)
        web.requestFocus()
        web.loadUrl("https://appassets.androidplatform.net/assets/web/tv/index.html?native=1")
        hideSystemUi()
        saver.flushDrafts()
    }

    private fun q(s: String) = JSONObject.quote(s)

    private fun js(code: String) {
        if (::web.isInitialized) web.evaluateJavascript(code, null)
    }

    inner class Bridge {
        @JavascriptInterface
        fun connect() = runOnUiThread {
            wantConnection = true
            if (hasPermissions()) link.start() else askPermissions()
        }

        @JavascriptInterface
        fun disconnect() = runOnUiThread {
            wantConnection = false
            link.stop()
        }

        @JavascriptInterface
        fun isConnected(): Boolean = link.isConnected

        @JavascriptInterface
        fun saveWorkout(name: String, json: String) = saver.save(name, json)

        @JavascriptInterface
        fun saveDraft(name: String, json: String) = saver.saveDraft(name, json)

        @JavascriptInterface
        fun appVersion(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    }

    private val neededPermissions: Array<String>
        get() = if (Build.VERSION.SDK_INT >= 31) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun hasPermissions() =
        neededPermissions.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun askPermissions() = requestPermissions(neededPermissions, 1)

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (hasPermissions()) {
            if (wantConnection) link.start()
        } else {
            js("window.pm5native && window.pm5native.onState('error', ${q("{\"message\":\"Bluetooth permission was not granted\"}")})")
        }
    }

    override fun onResume() {
        super.onResume()
        AppLog.i("lifecycle onResume")
        hideSystemUi()
        if (wantConnection && hasPermissions()) link.start()
    }

    // Let go of the PM5 when the app isn't on screen, so ErgData or another
    // app can connect to it.
    override fun onPause() {
        super.onPause()
        AppLog.i("lifecycle onPause")
    }

    override fun onStop() {
        super.onStop()
        AppLog.i("lifecycle onStop")
        link.stop()
    }

    override fun onDestroy() {
        AppLog.i("lifecycle onDestroy")
        saver.flushDrafts()
        link.stop()
        web.destroy()
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
    }
}
