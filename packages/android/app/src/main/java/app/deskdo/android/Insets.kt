package app.deskdo.android

import android.os.Build
import android.view.View
import android.view.WindowInsets

/** Android 15 draws apps edge-to-edge: pad content so it stays clear of the status/navigation bars. */
fun View.padForSystemBars() {
    setOnApplyWindowInsetsListener { v, insets ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
        } else {
            @Suppress("DEPRECATION")
            v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
        }
        insets
    }
    requestApplyInsets()
}
