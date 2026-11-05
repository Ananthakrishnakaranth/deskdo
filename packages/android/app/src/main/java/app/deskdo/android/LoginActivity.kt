package app.deskdo.android

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import java.io.IOException
import kotlin.concurrent.thread

class LoginActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        findViewById<View>(R.id.login_root).padForSystemBars()

        val server = findViewById<EditText>(R.id.server).apply { setText(Prefs.serverUrl(this@LoginActivity)) }
        val email = findViewById<EditText>(R.id.email).apply { setText(Prefs.email(this@LoginActivity)) }
        val password = findViewById<EditText>(R.id.password)
        val error = findViewById<TextView>(R.id.error)
        val button = findViewById<Button>(R.id.sign_in)

        button.setOnClickListener {
            val url = server.text.toString().trim().trimEnd('/')
            val mail = email.text.toString().trim()
            val pw = password.text.toString()
            if (!url.startsWith("https://")) {
                error.text = getString(R.string.error_https)
                return@setOnClickListener
            }
            button.isEnabled = false
            error.text = getString(R.string.signing_in)
            thread {
                val result = try {
                    val token = Api.login(url, mail, pw, Prefs.deviceId(this))
                    TokenStore.save(this, token)
                    Prefs.save(this, url, mail)
                    null
                } catch (e: ApiException) {
                    e.message ?: getString(R.string.error_generic)
                } catch (e: IOException) {
                    getString(R.string.error_network)
                }
                runOnUiThread {
                    button.isEnabled = true
                    if (result == null) {
                        WidgetStore.clear(this) // fresh cache for this account
                        Sync.enqueueNow(this)
                        Sync.schedulePeriodic(this)
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                        finish()
                    } else {
                        error.text = result
                    }
                }
            }
        }
    }
}
