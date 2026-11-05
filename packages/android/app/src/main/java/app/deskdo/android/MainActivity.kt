package app.deskdo.android

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

/**
 * The full app (add, edit, reorder, delete) is the same PWA the browser uses, hosted in a WebView,
 * so there's one UI to maintain. The native sign-in token is exchanged for the PWA's cookie session
 * through /api/handoff, so you only sign in once.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val token = TokenStore.load(this)
        if (token == null) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
        val server = Prefs.serverUrl(this)
        val host = Uri.parse(server).host

        web = WebView(this).apply {
            setBackgroundColor(getColor(R.color.background))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // IndexedDB + localStorage for the offline outbox
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    // Stay inside the app for our own pages; open anything else in the browser.
                    if (request.url.host == host) return false
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    return true
                }
            }
        }
        CookieManager.getInstance().setAcceptCookie(true)
        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.background))
            addView(web)
        }
        setContentView(root)
        root.padForSystemBars()

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState)
        } else {
            web.loadUrl("$server/api/handoff", mapOf("Authorization" to "Bearer $token"))
        }
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) offerWidget()
    }

    /**
     * Some launchers (notably Xiaomi HyperOS) make widgets from apps installed outside the Play Store
     * hard to find in their picker. Android can add the widget directly: offer that until a widget
     * exists or the user says not to ask again.
     */
    private fun offerWidget() {
        val mgr = AppWidgetManager.getInstance(this)
        val provider = ComponentName(this, TodoWidgetProvider::class.java)
        val prefs = getSharedPreferences("deskdo_settings", Context.MODE_PRIVATE)
        if (mgr.getAppWidgetIds(provider).isNotEmpty()) return
        if (prefs.getBoolean("widgetOfferDismissed", false) || offerShown) return
        if (!mgr.isRequestPinAppWidgetSupported) return
        offerShown = true
        AlertDialog.Builder(this)
            .setTitle(R.string.widget_offer_title)
            .setMessage(R.string.widget_offer_message)
            .setPositiveButton(R.string.widget_offer_add) { _, _ -> mgr.requestPinAppWidget(provider, null, null) }
            .setNegativeButton(R.string.widget_offer_later, null)
            .setNeutralButton(R.string.widget_offer_never) { _, _ -> prefs.edit().putBoolean("widgetOfferDismissed", true).apply() }
            .show()
    }

    private var offerShown = false

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        if (::web.isInitialized) {
            CookieManager.getInstance().flush()
            // You probably just changed the list: update the home-screen widget.
            Sync.enqueueNow(this)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }
}
