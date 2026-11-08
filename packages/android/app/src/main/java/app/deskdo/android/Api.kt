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
    fun allItems(server: String, token: String, timeoutMs: Int = TIMEOUT_MS): List<Item> {
        val res = JSONObject(request("GET", "$server/api/changes?since=0", token, null, timeoutMs))
        val arr = res.getJSONArray("items")
        return (0 until arr.length()).map { Item.fromJson(arr.getJSONObject(it)) }
    }

    fun push(server: String, token: String, deviceId: String, ops: JSONArray, timeoutMs: Int = TIMEOUT_MS): JSONObject {
        val body = JSONObject().put("deviceId", deviceId).put("ops", ops)
        return JSONObject(request("POST", "$server/api/ops", token, body.toString(), timeoutMs))
    }

    /**
     * Exchange the bearer token for the web app's session cookie(s). Done natively because Android
     * WebView can drop extra request headers once the web app's service worker controls the page.
     * Returns the raw Set-Cookie values (empty if the token was not accepted).
     */
    fun handoffCookies(server: String, token: String, timeoutMs: Int = TIMEOUT_MS): List<String> {
        val conn = URL("$server/api/handoff").openConnection() as HttpURLConnection
        try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.useCaches = false
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.responseCode // perform the request
            return conn.headerFields.entries
                .filter { it.key.equals("Set-Cookie", ignoreCase = true) }
                .flatMap { it.value }
        } finally {
            conn.disconnect()
        }
    }

    private fun request(method: String, url: String, token: String?, body: String?, timeoutMs: Int = TIMEOUT_MS): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
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
