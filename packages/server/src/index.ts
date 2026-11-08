import { loadConfig } from "./config";
import { createPool, migrate } from "./db";
import { createApp } from "./app";
import { purgeOld } from "./ops";
import { parseHours, startKeepAlive } from "./keepalive";

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, cfg.databaseSsl);
await migrate(db);
const app = createApp(cfg, db);
app.server.listen(cfg.port, () => console.log(`deskdo server listening on :${cfg.port}`));

// Render sets RENDER_EXTERNAL_URL. Defaults: awake 06:00-01:00 India time; KEEPALIVE_HOURS=off disables.
const stopKeepAlive = startKeepAlive({
  url: process.env.KEEPALIVE_URL ?? process.env.RENDER_EXTERNAL_URL,
  window: process.env.KEEPALIVE_HOURS === "off" ? null : parseHours(process.env.KEEPALIVE_HOURS ?? "6-1", process.env.KEEPALIVE_TZ ?? "Asia/Kolkata"),
});

const housekeeping = setInterval(() => purgeOld(db).catch((e) => console.error("purge failed", e)), 24 * 3600_000);
housekeeping.unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopKeepAlive();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
