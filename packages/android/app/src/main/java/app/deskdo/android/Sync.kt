package app.deskdo.android

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.Data
import java.io.IOException
import kotlin.concurrent.thread
import java.util.concurrent.TimeUnit

object Sync {
    private val running = Any()

    /**
     * Sync right now on a background thread, without waiting for Android's job scheduler (which
     * Xiaomi and other phones can delay for a long time). If it can't finish (offline, server
     * waking up), the scheduled job is queued as a fallback. `done` runs when finished.
     */
    fun runNow(ctx: Context, timeoutMs: Int = 15_000, trigger: String = "app", done: (() -> Unit)? = null) {
        val app = ctx.applicationContext
        thread(name = "deskdo-sync") {
            try {
                run(app, timeoutMs, trigger)
                if (WidgetStore.status(app) != SyncStatus.OK) enqueueNow(app)
            } catch (e: Exception) {
                Diag.recordError(app, "sync", e)
                runCatching { enqueueNow(app) }
            } finally {
                done?.invoke()
            }
        }
    }

    /**
     * Push pending widget ops, then fetch the full list. Blocking: call from a worker thread.
     * `trigger` says what started this sync (refresh, tap, alarm, periodic, update, open, pause);
     * it's reported to the server for diagnosis.
     */
    fun run(ctx: Context, timeoutMs: Int = 70_000, trigger: String = "work") = synchronized(running) {
        val token = TokenStore.load(ctx)
        if (token == null) {
            WidgetStore.setStatus(ctx, SyncStatus.SIGNED_OUT)
            TodoWidgetProvider.refreshAll(ctx)
            return
        }
        val server = Prefs.serverUrl(ctx)
        val info = Diag.header(ctx, trigger)
        try {
            val ops = WidgetStore.outbox(ctx)
            if (ops.length() > 0) {
                val res = Api.push(server, token, Prefs.deviceId(ctx), ops, timeoutMs, info)
                val results = res.getJSONArray("results")
                val answered = (0 until results.length()).map { results.getJSONObject(it).getString("opId") }.toSet()
                WidgetStore.removeOps(ctx, answered)
            }
            WidgetStore.saveServerItems(ctx, Api.allItems(server, token, timeoutMs, info))
            WidgetStore.setStatus(ctx, SyncStatus.OK)
        } catch (e: ApiException) {
            WidgetStore.setStatus(ctx, if (e.status == 401) SyncStatus.SIGNED_OUT else SyncStatus.OFFLINE)
        } catch (e: IOException) {
            WidgetStore.setStatus(ctx, SyncStatus.OFFLINE)
        } catch (e: org.json.JSONException) {
            WidgetStore.setStatus(ctx, SyncStatus.OFFLINE)
        }
        TodoWidgetProvider.refreshAll(ctx)
    }

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Sync as soon as there's a network connection (de-duplicated: one pending run at a time). */
    fun enqueueNow(ctx: Context) {
        val req = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online).build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("deskdo-sync-now", ExistingWorkPolicy.REPLACE, req)
    }

    /**
     * Background refresh about every 15 minutes (Android's minimum for periodic work). Skipped
     * between 01:00 and 06:00 phone time (see SyncWorker) so the free server can sleep at night.
     */
    fun schedulePeriodic(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(online)
            .setInputData(Data.Builder().putBoolean(SyncWorker.KEY_PERIODIC, true).build())
            .build()
        // UPDATE (not KEEP) so phones upgrading from an older version pick up the new input data.
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("deskdo-sync-periodic", ExistingPeriodicWorkPolicy.UPDATE, req)
    }

    fun cancelPeriodic(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork("deskdo-sync-periodic")
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val periodic = inputData.getBoolean(KEY_PERIODIC, false)
        // Automatic refreshes pause at night; your own taps (refresh, tick, delete) always sync.
        if (periodic && RefreshAlarm.inQuietHours()) return Result.success()
        // A job that runs proves background work is allowed: make sure the alarm chain is alive too.
        if (Diag.widgetCount(applicationContext) > 0) RefreshAlarm.schedule(applicationContext)
        Sync.run(applicationContext, trigger = if (periodic) "periodic" else "work")
        return Result.success()
    }

    companion object {
        const val KEY_PERIODIC = "periodic"
    }
}
