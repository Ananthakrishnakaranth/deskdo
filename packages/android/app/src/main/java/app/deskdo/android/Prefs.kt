package app.deskdo.android

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/** Non-secret settings: server URL, sign-in email, this device's sync id. */
object Prefs {
    const val DEFAULT_SERVER = "https://deskdo.onrender.com"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences("deskdo_settings", Context.MODE_PRIVATE)

    fun serverUrl(ctx: Context): String = prefs(ctx).getString("serverUrl", null) ?: DEFAULT_SERVER
    fun email(ctx: Context): String = prefs(ctx).getString("email", null) ?: ""

    fun save(ctx: Context, serverUrl: String, email: String) {
        prefs(ctx).edit().putString("serverUrl", serverUrl).putString("email", email).apply()
    }

    /** Stable id the server records as last_device_id for changes made from the widget. */
    fun deviceId(ctx: Context): String {
        val p = prefs(ctx)
        p.getString("deviceId", null)?.let { return it }
        val id = "android-" + UUID.randomUUID().toString()
        p.edit().putString("deviceId", id).apply()
        return id
    }
}
