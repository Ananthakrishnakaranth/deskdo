package app.deskdo.android

import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.widget.RemoteViews

/** One list row of the home-screen widget. Used by both ways of filling the list. */
fun widgetRow(ctx: Context, item: Item): RemoteViews =
    RemoteViews(ctx.packageName, R.layout.widget_item).apply {
        setTextViewText(R.id.text, item.text)
        setImageViewResource(R.id.check, if (item.done) R.drawable.ic_check_on else R.drawable.ic_check_off)
        // Completed: struck through and faded, same as the desktop widget.
        val flags = Paint.ANTI_ALIAS_FLAG or if (item.done) Paint.STRIKE_THRU_TEXT_FLAG else 0
        setInt(R.id.text, "setPaintFlags", flags)
        setTextColor(R.id.text, ctx.getColor(if (item.done) R.color.text_done else R.color.text))
        // Tapping the row ticks it; tapping × deletes it (the inner view's own click wins).
        setOnClickFillInIntent(R.id.row, rowTap(item.id, TodoWidgetProvider.OP_TOGGLE))
        setOnClickFillInIntent(R.id.delete, rowTap(item.id, TodoWidgetProvider.OP_DELETE))
        setContentDescription(R.id.row, (if (item.done) "Done: " else "To do: ") + item.text)
        setContentDescription(R.id.delete, "Delete " + item.text)
    }

private fun rowTap(itemId: String, op: String) = Intent()
    .putExtra(TodoWidgetProvider.EXTRA_ITEM_ID, itemId)
    .putExtra(TodoWidgetProvider.EXTRA_OP, op)

/** Stable id for a row: hasStableIds lets the launcher animate/reuse rows correctly. */
fun widgetRowId(item: Item): Long = item.id.hashCode().toLong()
