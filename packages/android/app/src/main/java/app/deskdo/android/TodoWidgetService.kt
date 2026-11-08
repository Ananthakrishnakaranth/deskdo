package app.deskdo.android

import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/**
 * Supplies the widget's list rows on Android 8–11. (Android 12+ sends the rows inside each widget
 * update instead; see TodoWidgetProvider.)
 */
class TodoWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext)

    private class Factory(private val ctx: Context) : RemoteViewsFactory {
        private var items: List<Item> = emptyList()

        override fun onCreate() {
            items = WidgetStore.visibleItems(ctx)
        }
        override fun onDataSetChanged() {
            items = WidgetStore.visibleItems(ctx)
        }
        override fun onDestroy() {}
        override fun getCount() = items.size
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 1
        override fun hasStableIds() = true
        override fun getItemId(position: Int): Long = items.getOrNull(position)?.let(::widgetRowId) ?: position.toLong()
        override fun getViewAt(position: Int): RemoteViews =
            items.getOrNull(position)?.let { widgetRow(ctx, it) } ?: RemoteViews(ctx.packageName, R.layout.widget_item)
    }
}
