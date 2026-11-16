package app.deskdo.android

import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetHostView
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Paint
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.ListView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/**
 * Runs the real app on an Android emulator against a real DeskDo server (started by CI on the host,
 * reachable from the emulator as localhost through `adb reverse`). The widget is placed on a test "home screen"
 * (an AppWidgetHost inside WidgetHostActivity) and driven the way a launcher would: it receives the
 * widget's RemoteViews, and taps go through the same PendingIntents.
 *
 * Needs:  adb shell appwidget grantbind --package app.deskdo.android --user 0
 */
@RunWith(AndroidJUnit4::class)
class WidgetEndToEndTest {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val ctx: Context = inst.targetContext
    private val args = InstrumentationRegistry.getArguments()
    private val server: String = args.getString("server") ?: "http://localhost:18080"
    private val email: String = args.getString("email") ?: "e2e@example.com"
    private val password: String = args.getString("password") ?: "e2e-password-123"

    private lateinit var token: String
    private lateinit var hostView: AppWidgetHostView

    // Must stay referenced for the whole test: the system only holds a weak link to a widget host,
    // so a garbage-collected host silently stops receiving widget updates.
    private lateinit var host: AppWidgetHost

    private data class Row(val text: String, val struck: Boolean)

    @Before
    fun signInAndStartClean() {
        // Same calls LoginActivity makes.
        token = Api.login(server, email, password, Prefs.deviceId(ctx))
        TokenStore.save(ctx, token)
        Prefs.save(ctx, server, email)
        assertEquals("token survives the Keystore round trip", token, TokenStore.load(ctx))
        WidgetStore.clear(ctx)
        // Don't let first-run dialogs cover the screens under test.
        ctx.getSharedPreferences("deskdo_settings", Context.MODE_PRIVATE).edit()
            .putBoolean("setupShown", true).putBoolean("widgetOfferDismissed", true).commit()
        // Empty the server list (tests share one database).
        val live = serverItems().filter { !it.deleted }
        if (live.isNotEmpty()) pushAs("cleanup", *live.map { delete(it.id) }.toTypedArray())
    }

    @Test
    fun widgetSyncsRendersAndHandlesTaps() {
        val milk = UUID.randomUUID().toString()
        val bank = UUID.randomUUID().toString()
        pushAs("laptop", create(milk, "Buy milk", 1.0), create(bank, "Call the bank", 2.0))

        placeWidgetOnTestHomeScreen()

        // Placing the widget makes Android call the provider's onUpdate, which syncs by itself.
        waitFor("widget shows the two tasks from the server") { rows().map { it.text } == listOf("Buy milk", "Call the bank") }
        assertEquals("2/8", text(R.id.count))
        waitFor("header shows when it was last updated") { text(R.id.status).isNotEmpty() }
        log("after first sync: rows=${rows()} status='${text(R.id.status)}'")

        // A change made on another device, then the refresh button on the widget.
        pushAs("laptop", create(UUID.randomUUID().toString(), "Added on laptop", 3.0))
        click(R.id.refresh)
        waitFor("refresh button brings in the laptop's new task") { rows().map { it.text }.contains("Added on laptop") }
        assertEquals("3/8", text(R.id.count))

        // Tick a task on the widget: struck through at once, and stored on the server.
        clickInRow("Buy milk", R.id.row)
        waitFor("ticked row is struck through") { rows().firstOrNull { it.text == "Buy milk" }?.struck == true }
        waitFor("server has the tick") { serverItems().first { it.id == milk }.done }
        assertEquals("2/8", text(R.id.count))

        // Delete with the × on a row.
        clickInRow("Call the bank", R.id.delete)
        waitFor("deleted row disappears") { rows().none { it.text == "Call the bank" } }
        waitFor("server has the delete") { serverItems().first { it.id == bank }.deleted }

        screenshot("widget.png")

        // The alarm tick: what keeps the widget fresh when nobody touches the phone.
        if (!RefreshAlarm.inQuietHours()) {
            pushAs("laptop", create(UUID.randomUUID().toString(), "Seen by the alarm", 4.0))
            ctx.sendBroadcast(Intent(ctx, TodoWidgetProvider::class.java).setAction(RefreshAlarm.ACTION_TICK))
            // Must be this sync that brought it (not some other path): check what triggered it.
            waitFor("alarm tick syncs and shows the laptop's change") {
                Sync.lastTrigger == "alarm" && rows().any { it.text == "Seen by the alarm" }
            }
        }

        // The in-app page reports its list through the JavaScript bridge: widget redraws at once.
        WidgetBridge(ctx).onItemsChanged("""[{"id":"$milk","text":"From the app","done":false,"position":1}]""")
        waitFor("bridge update is shown") { rows().map { it.text } == listOf("From the app") }
        assertEquals("1/8", text(R.id.count))

        // Diagnostics header is well-formed (the server only logs it if it matches this pattern).
        val diag = Diag.header(ctx, "test")
        log("diag: $diag")
        assertTrue("diag header format: $diag", Regex("^[\\w=,.:+ -]{1,160}$").matches(diag))
        assertTrue("diag reports one widget: $diag", diag.contains(" w=1"))
        assertEquals("no error was recorded along the way", null, Diag.lastError(ctx))
    }

    @Test
    fun setupScreenOpens() {
        ActivityScenario.launch(SetupActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertTrue(activity.findViewById<View>(R.id.btn_battery).isShown)
                assertTrue(activity.findViewById<View>(R.id.btn_done).isShown)
            }
            screenshot("setup.png")
        }
    }

    /**
     * The full app is the web page in a WebView. Opening it must refresh the widget's data, and a
     * change that arrives while it's open (pushed by the server over the page's WebSocket) must
     * reach the widget through the JavaScript bridge, with no native sync involved.
     */
    @Test
    fun appOpensAndFeedsLiveChangesToTheWidget() {
        pushAs("laptop", create(UUID.randomUUID().toString(), "Already there", 1.0))
        ActivityScenario.launch(MainActivity::class.java).use {
            waitFor("opening the app loads the list for the widget", 40_000) {
                WidgetStore.visibleItems(ctx).map { it.text } == listOf("Already there")
            }
            val reportsBefore = WidgetStore.appReports.get()
            pushAs("laptop", create(UUID.randomUUID().toString(), "Live from laptop", 2.0))
            waitFor("the page reports the live change to the widget", 60_000) {
                WidgetStore.appReports.get() > reportsBefore && WidgetStore.visibleItems(ctx).any { it.text == "Live from laptop" }
            }
            log("page reports to widget: ${WidgetStore.appReports.get()}")
            screenshot("app.png")
            assertEquals("no error was recorded", null, Diag.lastError(ctx))
        }
        // Closing the screen must stop the page: no more reports from a page nobody can see.
        Thread.sleep(1500)
        val afterClose = WidgetStore.appReports.get()
        pushAs("laptop", create(UUID.randomUUID().toString(), "After the app closed", 3.0))
        Thread.sleep(3000)
        assertEquals("page stopped reporting once the app screen was closed", afterClose, WidgetStore.appReports.get())
    }

    // ------------------------------------------------------------------ helpers

    private fun placeWidgetOnTestHomeScreen() {
        val mgr = AppWidgetManager.getInstance(ctx)
        host = AppWidgetHost(ctx, 4242)
        val widgetId = host.allocateAppWidgetId()
        val bound = mgr.bindAppWidgetIdIfAllowed(widgetId, ComponentName(ctx, TodoWidgetProvider::class.java))
        assertTrue("allowed to bind the widget (run: adb shell appwidget grantbind ...)", bound)
        ActivityScenario.launch(WidgetHostActivity::class.java).onActivity { activity ->
            host.startListening()
            hostView = host.createView(activity, widgetId, mgr.getAppWidgetInfo(widgetId))
            val d = activity.resources.displayMetrics.density
            activity.setContentView(hostView, ViewGroup.LayoutParams((340 * d).toInt(), (380 * d).toInt()))
        }
        inst.waitForIdleSync()
    }

    private fun rows(): List<Row> {
        var out = emptyList<Row>()
        if (!::hostView.isInitialized) return out
        inst.runOnMainSync {
            val list = hostView.findViewById<ListView>(R.id.list)
            if (list != null) {
                out = (0 until list.childCount).map { i ->
                    val tv = list.getChildAt(i).findViewById<TextView>(R.id.text)
                    Row(tv?.text?.toString() ?: "?", tv != null && (tv.paintFlags and Paint.STRIKE_THRU_TEXT_FLAG) != 0)
                }
            }
        }
        return out
    }

    private fun text(id: Int): String {
        var s = ""
        if (!::hostView.isInitialized) return s
        inst.runOnMainSync { s = hostView.findViewById<TextView>(id)?.text?.toString() ?: "" }
        return s
    }

    private fun click(id: Int) = inst.runOnMainSync {
        assertTrue("view $id reacts to a tap", hostView.findViewById<View>(id).performClick())
    }

    /**
     * Tap inside a list row the way a launcher delivers it. A tap on the row itself is handled by
     * the list's item-click listener (that's how RemoteViews wires setOnClickFillInIntent on a row's
     * root view); a tap on a child such as × has its own click listener.
     */
    private fun clickInRow(rowText: String, id: Int) = inst.runOnMainSync {
        val list = hostView.findViewById<ListView>(R.id.list)
        val index = (0 until list.childCount).first {
            list.getChildAt(it).findViewById<TextView>(R.id.text)?.text?.toString() == rowText
        }
        val row = list.getChildAt(index)
        val target = row.findViewById<View>(id)
        val position = list.firstVisiblePosition + index
        val handled = if (target === row) list.performItemClick(row, position, list.getItemIdAtPosition(position)) else target.performClick()
        assertTrue("'$rowText' reacts to a tap", handled)
    }

    private fun waitFor(what: String, timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        var last: Throwable? = null
        while (System.currentTimeMillis() < deadline) {
            try {
                if (condition()) return
            } catch (e: Exception) {
                last = e
            }
            Thread.sleep(250)
        }
        val state = runCatching { "rows=${rows()} count='${text(R.id.count)}' status='${text(R.id.status)}'" }.getOrDefault("(no widget)")
        throw AssertionError(
            "Timed out waiting for: $what. $state store=${WidgetStore.visibleItems(ctx).map { it.text }} " +
                "syncStatus=${WidgetStore.status(ctx)} err=${Diag.lastError(ctx)} last=${last?.message}",
        )
    }

    /** A real screen capture, saved in the app's files dir; CI pulls it with `run-as`. */
    private fun screenshot(name: String) {
        inst.waitForIdleSync()
        Thread.sleep(500)
        val bmp = inst.uiAutomation.takeScreenshot() ?: return
        File(ctx.filesDir, name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun serverItems(): List<Item> = Api.allItems(server, token)

    private fun pushAs(device: String, vararg ops: JSONObject) {
        val res = Api.push(server, token, device, JSONArray(ops.toList()))
        log("push by $device: ${res.getJSONArray("results")}")
    }

    private fun create(id: String, text: String, position: Double) = JSONObject()
        .put("type", "create").put("opId", UUID.randomUUID().toString()).put("itemId", id)
        .put("text", text).put("done", false).put("position", position).put("clientTime", System.currentTimeMillis())

    private fun delete(id: String) = JSONObject()
        .put("type", "delete").put("opId", UUID.randomUUID().toString()).put("itemId", id)
        .put("clientTime", System.currentTimeMillis())

    private fun log(msg: String) {
        Log.i("DeskDoTest", msg)
    }
}
