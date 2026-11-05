package app.deskdo.android

import android.annotation.SuppressLint
import android.app.Activity
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
