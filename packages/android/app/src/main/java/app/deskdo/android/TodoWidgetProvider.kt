package app.deskdo.android

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import android.widget.Toast

class TodoWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        ids.forEach { mgr.updateAppWidget(it, buildViews(ctx, it)) }
        mgr.notifyAppWidgetViewDataChanged(ids, R.id.list)
        Sync.schedulePeriodic(ctx)
        Sync.enqueueNow(ctx)
    }

    override fun onEnabled(ctx: Context) = Sync.schedulePeriodic(ctx)

    override fun onDisabled(ctx: Context) = Sync.cancelPeriodic(ctx)

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
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
                refreshAll(ctx) // show the change immediately, then sync in the background
                Sync.enqueueNow(ctx)
            }
            ACTION_REFRESH -> {
                WidgetStore.setStatus(ctx, SyncStatus.SYNCING)
                refreshAll(ctx)
                Sync.enqueueNow(ctx)
            }
        }
    }

    companion object {
        /** Any tap on a list row; EXTRA_OP says whether it was the row (tick) or its × (delete). */
        const val ACTION_ROW = "app.deskdo.android.ROW"
        const val EXTRA_OP = "op"
        const val OP_TOGGLE = "toggle"
        const val OP_DELETE = "delete"
        const val ACTION_REFRESH = "app.deskdo.android.REFRESH"
        const val EXTRA_ITEM_ID = "itemId"

        /** Redraw every placed widget from the local cache. */
        fun refreshAll(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, TodoWidgetProvider::class.java))
            if (ids.isEmpty()) return
            ids.forEach { mgr.updateAppWidget(it, buildViews(ctx, it)) }
            mgr.notifyAppWidgetViewDataChanged(ids, R.id.list)
        }

        @Suppress("DEPRECATION") // setRemoteAdapter(Intent) still works on every API level we support
        private fun buildViews(ctx: Context, widgetId: Int): RemoteViews {
            val views = RemoteViews(ctx.packageName, R.layout.widget_todo)
            val items = WidgetStore.visibleItems(ctx)
            val open = items.count { !it.done }
            views.setTextViewText(R.id.count, "$open/${WidgetStore.MAX_ACTIVE}")

            val status = WidgetStore.status(ctx)
            views.setTextViewText(
                R.id.status,
                when (status) {
                    SyncStatus.OK -> ""
                    SyncStatus.SYNCING -> ctx.getString(R.string.status_syncing)
                    SyncStatus.OFFLINE -> ctx.getString(R.string.status_offline)
                    SyncStatus.SIGNED_OUT -> ctx.getString(R.string.status_signed_out)
                },
            )
            views.setTextViewText(
                R.id.empty,
                ctx.getString(if (status == SyncStatus.SIGNED_OUT) R.string.empty_signed_out else R.string.empty_list),
            )

            // List rows come from TodoWidgetService. The unique data URI keeps one adapter per widget.
            val svc = Intent(ctx, TodoWidgetService::class.java).apply {
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
            }
            views.setRemoteAdapter(R.id.list, svc)
            views.setEmptyView(R.id.list, R.id.empty)

            // Row taps: one template for the whole list (must be MUTABLE so each row and each × can
            // fill in its item id and which action it is).
            val rowTap = Intent(ctx, TodoWidgetProvider::class.java).setAction(ACTION_ROW)
            views.setPendingIntentTemplate(
                R.id.list,
                PendingIntent.getBroadcast(ctx, 1, rowTap, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE),
            )

            val refresh = Intent(ctx, TodoWidgetProvider::class.java).setAction(ACTION_REFRESH)
            views.setOnClickPendingIntent(
                R.id.refresh,
                PendingIntent.getBroadcast(ctx, 2, refresh, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
            )

            // "+" and the title open the full app (add, edit, reorder, delete).
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
