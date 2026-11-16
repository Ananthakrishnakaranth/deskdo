package app.deskdo.android

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView

/**
 * "Keep the widget up to date": one screen with buttons that open the system settings a phone needs
 * so it doesn't stop DeskDo in the background.
 *
 * Why this exists: Xiaomi/Redmi/POCO phones (and some others) stop apps that aren't on an allow-list.
 * A stopped app's home-screen widget keeps showing its last picture but is dead: it can't refresh
 * and taps on it go nowhere until the app is opened again. Reinstalling resets those settings.
 * Android gives apps no way to read or change them, so the best we can do is take the user there.
 */
class SetupActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        findViewById<View>(R.id.setup_root).padForSystemBars()

        val xiaomi = isXiaomi()
        findViewById<View>(R.id.step_autostart).visibility = if (xiaomi) View.VISIBLE else View.GONE
        findViewById<TextView>(R.id.battery_text).setText(if (xiaomi) R.string.setup_battery_xiaomi else R.string.setup_battery_generic)
        findViewById<TextView>(R.id.recents_text).setText(if (xiaomi) R.string.setup_recents_xiaomi else R.string.setup_recents_generic)

        findViewById<Button>(R.id.btn_autostart).setOnClickListener { openFirst(autostartScreens()) }
        findViewById<Button>(R.id.btn_battery).setOnClickListener { openFirst(batteryScreens(xiaomi)) }
        findViewById<Button>(R.id.btn_app_info).setOnClickListener { openFirst(listOf(appInfo())) }
        findViewById<Button>(R.id.btn_done).setOnClickListener { finish() }
    }

    override fun onResume() {
        super.onResume()
        // Only Android's standard setting can be read back; Xiaomi's own switches can't.
        findViewById<TextView>(R.id.battery_state).setText(
            if (Diag.batteryUnrestricted(this)) R.string.setup_battery_ok else R.string.setup_battery_unknown,
        )
    }

    private fun appInfo() = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))

    /** Xiaomi's autostart list; falls back to the app's info page (which has an Autostart switch). */
    private fun autostartScreens() = listOf(
        Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")),
        Intent("miui.intent.action.OP_AUTO_START").addCategory(Intent.CATEGORY_DEFAULT),
        appInfo(),
    )

    private fun batteryScreens(xiaomi: Boolean): List<Intent> {
        val list = ArrayList<Intent>()
        if (xiaomi) {
            // Xiaomi's per-app "Battery saver" page (choose "No restrictions").
            list += Intent().setComponent(ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"))
                .putExtra("package_name", packageName)
                .putExtra("package_label", getString(R.string.app_name))
        }
        // Android's standard "let this app run in the background" prompt.
        if (!Diag.batteryUnrestricted(this)) {
            list += Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        }
        list += Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        list += appInfo()
        return list
    }

    /** Settings screens differ between phones and versions: open the first one that exists. */
    private fun openFirst(intents: List<Intent>) {
        for (intent in intents) {
            try {
                startActivity(intent)
                return
            } catch (e: Exception) {
                // not on this phone (or not allowed): try the next one
            }
        }
    }

    companion object {
        fun isXiaomi(): Boolean {
            val maker = (Build.MANUFACTURER ?: "").lowercase()
            val brand = (Build.BRAND ?: "").lowercase()
            return listOf("xiaomi", "redmi", "poco").any { it in maker || it in brand }
        }
    }
}
