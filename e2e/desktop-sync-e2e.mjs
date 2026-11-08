// The real Electron widget, signed in, syncing with a phone (Chromium) through the real server.
// Linux needs a Secret Service for the keychain; run inside a D-Bus session with gnome-keyring:
//   dbus-run-session -- bash -c 'echo -n x | gnome-keyring-daemon --unlock --components=secrets >/dev/null; xvfb-run -a node e2e/desktop-sync-e2e.mjs'
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(join(root, "packages/server/package.json"));
const { chromium, _electron: electron } = require("playwright");
const bcrypt = serverRequire("bcryptjs");
const pg = serverRequire("pg");

const DB = process.env.E2E_DATABASE_URL ?? "postgres://deskdo:deskdo@localhost:5432/deskdo_test";
const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "e2e@example.com";
const PASSWORD = "e2e-password-123";
const results = [];
const record = (name, pass, detail = "") => { results.push(pass); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
async function waitFor(fn, timeout = 2000) {
  const start = Date.now();
  for (;;) {
    try { if (await fn()) return Date.now() - start; } catch {}
    if (Date.now() - start > timeout) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const db = new pg.Client({ connectionString: DB });
await db.connect();
await db.query("DROP TABLE IF EXISTS todos, processed_ops, server_meta, schema_migrations; DROP SEQUENCE IF EXISTS todo_change_seq");
const serverLog = [];
const server = spawn(process.execPath, ["packages/server/dist/server.js"], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: DB, DATABASE_SSL: "false", ACCOUNT_EMAIL: EMAIL, ACCOUNT_PASSWORD_HASH: await bcrypt.hash(PASSWORD, 4),
    JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-1234", PORT: String(PORT), STATIC_DIR: join(root, "packages/mobile/dist"), COOKIE_SECURE: "false" },
  stdio: ["ignore", "pipe", "inherit"],
});
server.stdout.on("data", (d) => serverLog.push(...String(d).split("\n").filter(Boolean)));
await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 10000);

const configHome = mkdtempSync(join(tmpdir(), "deskdo-desk-"));
const launch = async () => {
  const app = await electron.launch({ executablePath: require(join(root, "node_modules/electron")), args: [join(root, "packages/desktop")],
    env: { ...process.env, XDG_CONFIG_HOME: configHome } });
  const page = await app.firstWindow();
  await page.waitForSelector(".dd-card");
  return { app, page };
};
const texts = (p) => p.locator(".dd-row .dd-text").allTextContents();
const add = async (p, t) => { const i = p.getByLabel("Add task"); await i.fill(t); await i.press("Enter"); };

const browser = await chromium.launch();
let desk;
try {
  // Phone first, with a task already on it.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneCtx.newPage();
  await phone.goto(BASE);
  await phone.getByLabel("Email").fill(EMAIL);
  await phone.getByLabel("Password").fill(PASSWORD);
  await phone.getByRole("button", { name: "Sign in" }).click();
  await phone.locator(".dd-status-online").waitFor({ timeout: 5000 });
  await add(phone, "made on phone before laptop signed in");

  // Laptop widget: sign in through Settings, exactly as a user does.
  desk = await launch();
  const { page } = desk;
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByPlaceholder("https://your-app.onrender.com").fill(BASE);
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.locator('input[type="email"]').fill(EMAIL);
  await dialog.locator('input[type="password"]').fill(PASSWORD);
  await dialog.getByRole("button", { name: "Sign in" }).click();
  await dialog.getByText("Syncing with").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Close settings" }).click();
  const connectMs = await waitFor(async () => (await page.locator(".dd-status-online").count()) > 0, 10000);
  await waitFor(() => serverLog.some((l) => l.includes("ws ready") && l.includes("client=desktop")), 10000)
    .then(() => record("laptop widget signs in and connects live (green dot, server: ws ready client=desktop)", true, `${connectMs} ms`))
    .catch(() => record("laptop widget connects live", false, serverLog.filter((l) => l.startsWith("ws")).slice(-5).join(" / ")));
  await waitFor(async () => (await texts(page)).includes("made on phone before laptop signed in"), 3000)
    .then(() => record("laptop shows the tasks already on the phone", true))
    .catch(async () => record("laptop shows the tasks already on the phone", false, (await texts(page)).join("|")));

  const lat = [];
  await add(page, "added on laptop");
  lat.push(await waitFor(async () => (await texts(phone)).includes("added on laptop")));
  await add(phone, "added on phone");
  lat.push(await waitFor(async () => (await texts(page)).includes("added on phone")));
  await page.locator(".dd-row", { hasText: "added on phone" }).getByRole("checkbox").click();
  lat.push(await waitFor(async () => (await phone.locator(".dd-row.dd-done .dd-text").allTextContents()).includes("added on phone")));
  await phone.locator(".dd-row", { hasText: "added on laptop" }).getByRole("button", { name: /^Delete/ }).click();
  lat.push(await waitFor(async () => !(await texts(page)).includes("added on laptop")));
  record("laptop <-> phone: add, check, delete in both directions within 2 s", Math.max(...lat) < 2000, `latencies ms: ${lat.join(", ")}`);

  // Restart the widget: still signed in (token from the keychain), same tasks, live again.
  await desk.app.close();
  desk = await launch();
  await desk.page.locator(".dd-status-online").waitFor({ timeout: 10000 });
  const after = await texts(desk.page);
  record("after restarting the widget: still signed in, live, same tasks", JSON.stringify(after) === JSON.stringify(await texts(phone)), after.join(" | "));
  await add(phone, "after restart");
  await waitFor(async () => (await texts(desk.page)).includes("after restart"), 2000)
    .then((ms) => record("phone -> laptop still live after restart", true, `${ms} ms`))
    .catch(() => record("phone -> laptop still live after restart", false));
  await desk.page.locator(".dd-card").screenshot({ path: join(root, "e2e/widget-synced.png") });
} catch (e) {
  record("desktop sync run", false, e.stack);
} finally {
  await desk?.app.close().catch(() => {});
  await browser.close();
  server.kill();
  await db.end();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
