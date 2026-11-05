package app.deskdo.android

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ApiException(val status: Int, message: String) : IOException(message)

data class Item(
    val id: String,
    val text: String,
    val done: Boolean,
    val position: Double,
    val deleted: Boolean,
    val seq: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("text", text).put("done", done)
        .put("position", position).put("deleted", deleted).put("seq", seq)

    companion object {
        fun fromJson(o: JSONObject) = Item(
            id = o.getString("id"),
            text = o.getString("text"),
            done = o.getBoolean("done"),
            position = o.getDouble("position"),
            deleted = o.optBoolean("deleted", false),
            seq = o.optLong("seq", 0),
        )
    }
}

/** Minimal client for the DeskDo server API (same endpoints the desktop app uses). */
object Api {
    // Free-tier servers can take up to a minute to wake up.
    private const val TIMEOUT_MS = 70_000

    fun login(server: String, email: String, password: String, deviceId: String): String {
        val body = JSONObject()
            .put("email", email).put("password", password)
            .put("deviceId", deviceId).put("mode", "bearer")
        val res = JSONObject(request("POST", "$server/api/login", null, body.toString()))
        return res.optString("token").ifEmpty { throw ApiException(500, "Server did not return a session") }
    }

    /** Full current state (since=0), including tombstones. The list is tiny (≤ a few dozen rows). */
    fun allItems(server: String, token: String): List<Item> {
        val res = JSONObject(request("GET", "$server/api/changes?since=0", token, null))
        val arr = res.getJSONArray("items")
        return (0 until arr.length()).map { Item.fromJson(arr.getJSONObject(it)) }
    }

    fun push(server: String, token: String, deviceId: String, ops: JSONArray): JSONObject {
        val body = JSONObject().put("deviceId", deviceId).put("ops", ops)
        return JSONObject(request("POST", "$server/api/ops", token, body.toString()))
    }

    private fun request(method: String, url: String, token: String?, body: String?): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.useCaches = false
            conn.setRequestProperty("Accept", "application/json")
            if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (status !in 200..299) {
                val msg = runCatching { JSONObject(text).optString("error") }.getOrNull().orEmpty()
                throw ApiException(status, msg.ifEmpty { "HTTP $status" })
            }
            return text
        } finally {
            conn.disconnect()
        }
    }
}
