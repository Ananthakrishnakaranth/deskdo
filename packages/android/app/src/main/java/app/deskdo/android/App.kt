package app.deskdo.android

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // Remember a crash (exception type and where) so the next sync can report it; then let
        // Android handle it as usual.
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            Diag.recordError(this, "crash", error)
            previous?.uncaughtException(thread, error)
        }
    }
}
