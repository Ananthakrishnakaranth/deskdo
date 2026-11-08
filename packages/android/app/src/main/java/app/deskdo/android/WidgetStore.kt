package app.deskdo.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class SyncStatus { OK, SYNCING, OFFLINE, SIGNED_OUT }

/**
 * The widget's local copy of the list plus an outbox of pending ops, in SharedPreferences.
 * Same model as the other clients: what the widget shows = server state + pending ops on top, and
 * ops carry UUIDs so the server ignores replays.
 */
object WidgetStore {
    private const val PREFS = "deskdo_widget"
    private val lock = Any()

    private fun p(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun serverItems(ctx: Context): List<Item> = synchronized(lock) {
        val arr = JSONArray(p(ctx).getString("items", "[]"))
        (0 until arr.length()).map { Item.fromJson(arr.getJSONObject(it)) }
    }

    fun saveServerItems(ctx: Context, items: List<Item>) = synchronized(lock) {
        val arr = JSONArray()
        items.forEach { arr.put(it.toJson()) }
        p(ctx).edit().putString("items", arr.toString()).putLong("syncedAt", System.currentTimeMillis()).apply()
    }

    fun outbox(ctx: Context): JSONArray = synchronized(lock) { JSONArray(p(ctx).getString("outbox", "[]")) }

    /** Remove ops the server has answered (any status: applied, duplicate, ignored or rejected). */
    fun removeOps(ctx: Context, opIds: Set<String>) = synchronized(lock) {
        val current = outbox(ctx)
        val kept = JSONArray()
        for (i in 0 until current.length()) {
            val op = current.getJSONObject(i)
            if (op.getString("opId") !in opIds) kept.put(op)
        }
        p(ctx).edit().putString("outbox", kept.toString()).apply()
    }

    /** Visible list: not deleted, pending done-toggles applied, ordered like the other clients. */
    fun visibleItems(ctx: Context): List<Item> = synchronized(lock) {
        val byId = serverItems(ctx).associateBy { it.id }.toMutableMap()
        val ops = outbox(ctx)
        for (i in 0 until ops.length()) {
            val op = ops.getJSONObject(i)
            val item = byId[op.getString("itemId")] ?: continue
            if (op.optString("type") == "delete") {
                byId[item.id] = item.copy(deleted = true)
                continue
            }
            val patch = op.optJSONObject("patch") ?: continue
            if (patch.has("done")) byId[item.id] = item.copy(done = patch.getBoolean("done"))
        }
        byId.values.filter { !it.deleted }.sortedWith(compareBy<Item>({ it.position }, { it.id }))
    }

    /** Queue a check/uncheck from the widget. Returns false if the 8-open-tasks limit blocks it. */
    fun toggle(ctx: Context, itemId: String): Boolean = synchronized(lock) {
        val visible = visibleItems(ctx)
        val item = visible.firstOrNull { it.id == itemId } ?: return false
        val newDone = !item.done
        if (!newDone && visible.count { !it.done } >= MAX_ACTIVE) return false
        val op = JSONObject()
            .put("type", "update")
            .put("opId", UUID.randomUUID().toString())
            .put("itemId", itemId)
            .put("clientTime", System.currentTimeMillis())
            .put("patch", JSONObject().put("done", newDone))
        val ops = outbox(ctx).put(op)
        p(ctx).edit().putString("outbox", ops.toString()).apply()
        true
    }

    /**
     * Queue a delete from the widget. The server keeps a tombstone, so the task disappears on every
     * device and a late edit from another device can't bring it back. Returns the task's text, or
     * null if it was already gone.
     */
    fun remove(ctx: Context, itemId: String): String? = synchronized(lock) {
        val item = visibleItems(ctx).firstOrNull { it.id == itemId } ?: return null
        val op = JSONObject()
            .put("type", "delete")
            .put("opId", UUID.randomUUID().toString())
            .put("itemId", itemId)
            .put("clientTime", System.currentTimeMillis())
        p(ctx).edit().putString("outbox", outbox(ctx).put(op).toString()).apply()
        item.text
    }

    fun status(ctx: Context): SyncStatus =
        runCatching { SyncStatus.valueOf(p(ctx).getString("status", SyncStatus.OK.name)!!) }.getOrDefault(SyncStatus.OK)

    fun setStatus(ctx: Context, s: SyncStatus) {
        p(ctx).edit().putString("status", s.name).apply()
    }

    fun syncedAt(ctx: Context): Long = p(ctx).getLong("syncedAt", 0)

    fun clear(ctx: Context) = synchronized(lock) { p(ctx).edit().clear().apply() }

    const val MAX_ACTIVE = 8
}
