package app.deskdo.android

import android.app.ActivityManager
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.PowerManager

/**
 * A short self-description sent with every native request (header X-DeskDo-Client) and logged by
 * the server. A home-screen widget can't be debugged from outside the phone, so this is how we find
 * out what Android is doing to the app: which trigger ran, whether widgets exist, whether the system
 * killed the app and why, and the last error. No task text, no identifiers, nothing personal.
 *
 * Only characters the server accepts are used: letters, digits and  _ = , . : + - space.
 */
object Diag {
    private const val PREFS = "deskdo_diag"
    private const val WEEK_MS = 7L * 24 * 3600 * 1000

    fun header(ctx: Context, trigger: String): String = try {
        val parts = ArrayList<String>()
        parts += "v=${BuildConfig.VERSION_CODE}"
        parts += "sdk=${Build.VERSION.SDK_INT}"
        parts += "t=$trigger"
        parts += "w=${widgetCount(ctx)}"
        parts += "bo=${if (batteryUnrestricted(ctx)) 1 else 0}"
        val synced = WidgetStore.syncedAt(ctx)
        if (synced > 0) parts += "age=${(System.currentTimeMillis() - synced) / 60_000}m"
        lastExit(ctx)?.let { parts += "exit=$it" }
        lastError(ctx)?.let { parts += "err=$it" }
        clean(parts.joinToString(" "), 160)
    } catch (e: Exception) {
        "v=${BuildConfig.VERSION_CODE} t=${clean(trigger, 12)}"
    }

    fun widgetCount(ctx: Context): Int = try {
        AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, TodoWidgetProvider::class.java)).size
    } catch (e: Exception) {
        -1
    }

    /** True if Android's standard battery optimisation is off for this app (Xiaomi has its own on top). */
    fun batteryUnrestricted(ctx: Context): Boolean = try {
        (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(ctx.packageName)
    } catch (e: Exception) {
        false
    }

    /**
     * Why the app's process last died, as "<reason code>:<system's description>:<minutes ago>".
     * Reason codes are ApplicationExitInfo.REASON_*: 10 = user requested (includes force-stop and
     * swipe-away cleaners), 11 = user stopped, 13 = other, 3 = low memory, 4 = crash, 6 = ANR.
     */
    fun lastExit(ctx: Context): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return try {
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val info = am.getHistoricalProcessExitReasons(ctx.packageName, 0, 1).firstOrNull() ?: return null
            val minutes = (System.currentTimeMillis() - info.timestamp) / 60_000
            clean("${info.reason}:${(info.description ?: "").take(28)}:${minutes}m", 56)
        } catch (e: Exception) {
            null
        }
    }

    fun recordError(ctx: Context, where: String, e: Throwable) {
        try {
            val top = e.stackTrace.firstOrNull { it.className.startsWith("app.deskdo") } ?: e.stackTrace.firstOrNull()
            val text = clean("$where:${e.javaClass.simpleName}:${top?.fileName ?: "?"}:${top?.lineNumber ?: 0}", 64)
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("err", text).putLong("errAt", System.currentTimeMillis()).commit()
        } catch (ignored: Exception) {
            // diagnostics must never cause a failure themselves
        }
    }

    fun lastError(ctx: Context): String? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = p.getLong("errAt", 0)
        if (at == 0L || System.currentTimeMillis() - at > WEEK_MS) return null
        return p.getString("err", null)
    }

    private fun clean(s: String, max: Int): String {
        val sb = StringBuilder()
        for (c in s) {
            val ok = (c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') || c == '_' || c == '=' ||
                c == ',' || c == '.' || c == ':' || c == '+' || c == '-' || c == ' '
            sb.append(if (ok) c else '_')
            if (sb.length >= max) break
        }
        return sb.toString()
    }
}
