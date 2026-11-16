package app.deskdo.android

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.text.format.DateFormat
import android.text.format.DateUtils
import android.widget.RemoteViews
import android.widget.Toast
import java.util.Date

class TodoWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        ids.forEach { mgr.updateAppWidget(it, buildViews(ctx, it)) }
        notifyListChanged(mgr, ids)
        Sync.schedulePeriodic(ctx)
        RefreshAlarm.schedule(ctx)
        Sync.runNow(ctx, trigger = "update")
    }

    override fun onEnabled(ctx: Context) {
        Sync.schedulePeriodic(ctx)
        RefreshAlarm.schedule(ctx)
    }

    override fun onDisabled(ctx: Context) {
        Sync.cancelPeriodic(ctx)
        RefreshAlarm.cancel(ctx)
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        // Nothing here may crash the app: an exception is remembered and reported with the next sync.
        try {
            super.onReceive(ctx, intent)
            handle(ctx, intent)
        } catch (e: Exception) {
            Diag.recordError(ctx, "widget", e)
        }
    }

    private fun handle(ctx: Context, intent: Intent) {
        when (intent.action) {
            ACTION_ROW -> {
                val id = intent.getStringExtra(EXTRA_ITEM_ID) ?: return
                when (intent.getStringExtra(EXTRA_OP)) {
                    OP_DELETE -> {
                        val text = WidgetStore.remove(ctx, id) ?: return
                        Toast.makeText(ctx, ctx.getString(R.string.deleted_task, text), Toast.LENGTH_SHORT).show()
                    }
                    else -> if (!WidgetStore.toggle(ctx, id)) {
                        Toast.makeText(ctx, R.string.limit_reached, Toast.LENGTH_SHORT).show()
                        return
                    }
                }
                refreshAll(ctx) // show the change immediately, then sync right away
                RefreshAlarm.schedule(ctx)
                syncNow(ctx, "tap")
            }
            ACTION_REFRESH -> {
                WidgetStore.setStatus(ctx, SyncStatus.SYNCING)
                refreshAll(ctx)
                RefreshAlarm.schedule(ctx)
                syncNow(ctx, "refresh")
            }
            RefreshAlarm.ACTION_TICK -> {
                if (Diag.widgetCount(ctx) <= 0) return // no widget on the home screen: let the chain end
                RefreshAlarm.schedule(ctx)
                if (!RefreshAlarm.inQuietHours()) syncNow(ctx, "alarm")
            }
        }
    }

    /** Sync now, keeping this receiver alive until done (goAsync allows several seconds). */
    private fun syncNow(ctx: Context, trigger: String) {
        val pending = goAsync()
        Sync.runNow(ctx, timeoutMs = 8_000, trigger = trigger) { pending.finish() }
    }

    companion object {
        /** Any tap on a list row; EXTRA_OP says whether it was the row (tick) or its × (delete). */
        const val ACTION_ROW = "app.deskdo.android.ROW"
        const val EXTRA_OP = "op"
        const val OP_TOGGLE = "toggle"
        const val OP_DELETE = "delete"
        const val ACTION_REFRESH = "app.deskdo.android.REFRESH"
        const val EXTRA_ITEM_ID = "itemId"

        /** After this long without a successful sync the "updated" time turns yellow. */
        private const val STALE_MS = 45 * 60_000L

        /** Redraw every placed widget from the local cache. Safe to call from any thread. */
        fun refreshAll(ctx: Context) {
            try {
                val mgr = AppWidgetManager.getInstance(ctx)
                val ids = mgr.getAppWidgetIds(ComponentName(ctx, TodoWidgetProvider::class.java))
                if (ids.isEmpty()) return
                ids.forEach { mgr.updateAppWidget(it, buildViews(ctx, it)) }
                notifyListChanged(mgr, ids)
            } catch (e: Exception) {
                Diag.recordError(ctx, "render", e)
            }
        }

        /** Only the Android 8–11 list (served by TodoWidgetService) needs to be told to re-read. */
        @Suppress("DEPRECATION")
        private fun notifyListChanged(mgr: AppWidgetManager, ids: IntArray) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) mgr.notifyAppWidgetViewDataChanged(ids, R.id.list)
        }

        /** "21:42" for today, "14 Nov" for older: when the list was last fetched from the server. */
        private fun syncedLabel(ctx: Context, at: Long): String {
            if (at <= 0) return ""
            return if (DateUtils.isToday(at)) DateFormat.getTimeFormat(ctx).format(Date(at)) else DateFormat.format("d MMM", at).toString()
        }

        @Suppress("DEPRECATION") // setRemoteAdapter(Intent) still works on every API level we support
        private fun buildViews(ctx: Context, widgetId: Int): RemoteViews {
            val views = RemoteViews(ctx.packageName, R.layout.widget_todo)
            val items = WidgetStore.visibleItems(ctx)
            val open = items.count { !it.done }
            views.setTextViewText(R.id.count, "$open/${WidgetStore.MAX_ACTIVE}")

            // Next to the count: when the list was last fetched, or what's wrong. The time makes a
            // frozen widget obvious (and tells us from a screenshot whether refreshes are happening).
            val status = WidgetStore.status(ctx)
            val syncedAt = WidgetStore.syncedAt(ctx)
            val updated = syncedLabel(ctx, syncedAt)
            val statusText = when (status) {
                SyncStatus.OK -> updated
                SyncStatus.SYNCING -> ctx.getString(R.string.status_syncing)
                SyncStatus.OFFLINE -> listOf(ctx.getString(R.string.status_offline), updated).filter { it.isNotEmpty() }.joinToString(" · ")
                SyncStatus.SIGNED_OUT -> ctx.getString(R.string.status_signed_out)
            }
            val fresh = status == SyncStatus.OK && System.currentTimeMillis() - syncedAt < STALE_MS
            views.setTextViewText(R.id.status, statusText)
            views.setTextColor(R.id.status, ctx.getColor(if (fresh) R.color.text_muted else R.color.warn))
            views.setTextViewText(
                R.id.empty,
                ctx.getString(if (status == SyncStatus.SIGNED_OUT) R.string.empty_signed_out else R.string.empty_list),
            )

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Android 12+: send the rows inside this same update. The header count and the list
                // then always come from the same data; with the older service-based adapter some
                // launchers (Xiaomi HyperOS) kept showing a stale, empty list under a correct count.
                val rows = RemoteViews.RemoteCollectionItems.Builder()
                    .setHasStableIds(true)
                    .setViewTypeCount(1)
                items.forEach { rows.addItem(widgetRowId(it), widgetRow(ctx, it)) }
                views.setRemoteAdapter(R.id.list, rows.build())
            } else {
                // Android 8–11: rows come from TodoWidgetService. A new data URI on every update makes
                // the launcher re-bind and re-fetch instead of reusing a cached (possibly stale) list.
                val svc = Intent(ctx, TodoWidgetService::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                    data = Uri.parse("deskdo-widget://$widgetId/${System.nanoTime()}")
                }
                views.setRemoteAdapter(R.id.list, svc)
            }
            views.setEmptyView(R.id.list, R.id.empty)

            // Row taps: one template for the whole list (must be MUTABLE so each row and each × can
            // fill in its item id and which action it is).
            // FLAG_RECEIVER_FOREGROUND: a tap on the widget is a user action, so it shouldn't wait in
            // the background broadcast queue behind whatever else the phone is doing.
            val rowTap = Intent(ctx, TodoWidgetProvider::class.java).setAction(ACTION_ROW).addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
            views.setPendingIntentTemplate(
                R.id.list,
                PendingIntent.getBroadcast(ctx, 1, rowTap, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE),
            )

            val refresh = Intent(ctx, TodoWidgetProvider::class.java).setAction(ACTION_REFRESH).addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
            views.setOnClickPendingIntent(
                R.id.refresh,
                PendingIntent.getBroadcast(ctx, 2, refresh, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
            )

            // "+" and the title open the full app (add, edit, reorder, delete). Opening the app is
            // also what revives a widget whose app the system had stopped.
            val openApp = PendingIntent.getActivity(
                ctx, 3, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.add, openApp)
            views.setOnClickPendingIntent(R.id.title, openApp)
            views.setOnClickPendingIntent(R.id.empty, openApp)
            return views
        }
    }
}
