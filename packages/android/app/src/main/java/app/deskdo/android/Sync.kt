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
import java.io.IOException
import java.util.concurrent.TimeUnit

object Sync {
    private val running = Any()

    /** Push pending widget ops, then fetch the full list. Blocking: call from a worker thread. */
    fun run(ctx: Context) = synchronized(running) {
        val token = TokenStore.load(ctx)
        if (token == null) {
            WidgetStore.setStatus(ctx, SyncStatus.SIGNED_OUT)
            TodoWidgetProvider.refreshAll(ctx)
            return
        }
        val server = Prefs.serverUrl(ctx)
        try {
            val ops = WidgetStore.outbox(ctx)
            if (ops.length() > 0) {
                val res = Api.push(server, token, Prefs.deviceId(ctx), ops)
                val results = res.getJSONArray("results")
                val answered = (0 until results.length()).map { results.getJSONObject(it).getString("opId") }.toSet()
                WidgetStore.removeOps(ctx, answered)
            }
            WidgetStore.saveServerItems(ctx, Api.allItems(server, token))
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

    /** Background refresh about every 15 minutes (Android's minimum for periodic work). */
    fun schedulePeriodic(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("deskdo-sync-periodic", ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun cancelPeriodic(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork("deskdo-sync-periodic")
    }
}

class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        Sync.run(applicationContext)
        return Result.success()
    }
}
