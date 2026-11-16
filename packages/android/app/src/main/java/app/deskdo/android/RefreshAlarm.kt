package app.deskdo.android

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import java.util.Calendar

/**
 * Wakes the widget every few minutes to fetch changes made on other devices.
 *
 * This is a chain of one-shot alarms (each tick arms the next) using setAndAllowWhileIdle, which
 * needs no special permission and still fires in battery-saving modes (less often). WorkManager
 * stays as a second path, but its jobs are the first thing aggressive phones (Xiaomi) defer.
 *
 * Paused between 01:00 and 06:00 phone time so the free server can sleep at night.
 */
object RefreshAlarm {
    const val ACTION_TICK = "app.deskdo.android.TICK"
    private const val INTERVAL_MS = 5 * 60_000L
    private const val REQUEST_CODE = 20
    private val QUIET_HOURS = 1 until 6

    fun inQuietHours(now: Calendar = Calendar.getInstance()): Boolean = now.get(Calendar.HOUR_OF_DAY) in QUIET_HOURS

    /** Arm (or re-arm) the next tick. There is only ever one pending alarm, so calling this often is fine. */
    fun schedule(ctx: Context) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + nextDelayMs(), pending(ctx))
    }

    fun cancel(ctx: Context) {
        (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pending(ctx))
    }

    internal fun nextDelayMs(now: Calendar = Calendar.getInstance()): Long {
        if (!inQuietHours(now)) return INTERVAL_MS
        val wake = (now.clone() as Calendar).apply {
            set(Calendar.HOUR_OF_DAY, QUIET_HOURS.last + 1)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        return (wake.timeInMillis - now.timeInMillis).coerceAtLeast(INTERVAL_MS)
    }

    private fun pending(ctx: Context): PendingIntent = PendingIntent.getBroadcast(
        ctx, REQUEST_CODE,
        Intent(ctx, TodoWidgetProvider::class.java).setAction(ACTION_TICK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}
