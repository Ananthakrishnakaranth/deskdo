import { loadConfig } from "./config";
import { createPool, migrate } from "./db";
import { createApp } from "./app";
import { purgeOld } from "./ops";

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, cfg.databaseSsl);
await migrate(db);
const app = createApp(cfg, db);
app.server.listen(cfg.port, () => console.log(`deskdo server listening on :${cfg.port}`));

const housekeeping = setInterval(() => purgeOld(db).catch((e) => console.error("purge failed", e)), 24 * 3600_000);
housekeeping.unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
