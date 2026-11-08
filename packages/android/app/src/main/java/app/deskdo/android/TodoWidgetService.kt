package app.deskdo.android

import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/** Supplies the widget's list rows. */
class TodoWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext)

    private class Factory(private val ctx: Context) : RemoteViewsFactory {
        private fun fillIn(itemId: String, op: String) = Intent()
            .putExtra(TodoWidgetProvider.EXTRA_ITEM_ID, itemId)
            .putExtra(TodoWidgetProvider.EXTRA_OP, op)

        private var items: List<Item> = emptyList()

        override fun onCreate() {}
        override fun onDataSetChanged() {
            items = WidgetStore.visibleItems(ctx)
        }
        override fun onDestroy() {}
        override fun getCount() = items.size
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 1
        override fun hasStableIds() = true
        override fun getItemId(position: Int): Long = items.getOrNull(position)?.id?.hashCode()?.toLong() ?: position.toLong()

        override fun getViewAt(position: Int): RemoteViews {
            val item = items.getOrNull(position) ?: return RemoteViews(ctx.packageName, R.layout.widget_item)
            return RemoteViews(ctx.packageName, R.layout.widget_item).apply {
                setTextViewText(R.id.text, item.text)
                setImageViewResource(R.id.check, if (item.done) R.drawable.ic_check_on else R.drawable.ic_check_off)
                // Completed: struck through and faded, same as the desktop widget.
                val flags = Paint.ANTI_ALIAS_FLAG or if (item.done) Paint.STRIKE_THRU_TEXT_FLAG else 0
                setInt(R.id.text, "setPaintFlags", flags)
                setTextColor(R.id.text, ctx.getColor(if (item.done) R.color.text_done else R.color.text))
                // Tapping the row ticks it; tapping × deletes it (the inner view's own click wins).
                setOnClickFillInIntent(R.id.row, fillIn(item.id, TodoWidgetProvider.OP_TOGGLE))
                setOnClickFillInIntent(R.id.delete, fillIn(item.id, TodoWidgetProvider.OP_DELETE))
                setContentDescription(R.id.row, (if (item.done) "Done: " else "To do: ") + item.text)
                setContentDescription(R.id.delete, "Delete " + item.text)
            }
        }
    }
}
