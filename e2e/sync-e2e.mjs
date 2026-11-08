// End-to-end acceptance run: starts the real server (serving the built PWA) against Postgres, opens
// two isolated Chromium contexts ("laptop" and "phone"), and drives the real UI.
//
//   pnpm build && pnpm e2e
//
// Requires: Postgres reachable at E2E_DATABASE_URL (default: local deskdo_test), Playwright + Chromium.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(join(root, "packages/server/package.json"));
const { chromium } = require("playwright");
const bcrypt = serverRequire("bcryptjs");
const pg = serverRequire("pg");

const DB = process.env.E2E_DATABASE_URL ?? "postgres://deskdo:deskdo@localhost:5432/deskdo_test";
const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "e2e@example.com";
const PASSWORD = "e2e-password-123";
const results = [];
const record = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

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

const server = spawn(process.execPath, ["packages/server/dist/server.js"], {
  cwd: root,
  env: {
    ...process.env, DATABASE_URL: DB, DATABASE_SSL: "false", ACCOUNT_EMAIL: EMAIL,
    ACCOUNT_PASSWORD_HASH: await bcrypt.hash(PASSWORD, 4), JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-1234",
    PORT: String(PORT), STATIC_DIR: join(root, "packages/mobile/dist"), COOKIE_SECURE: "false",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 10000);

const browser = await chromium.launch();
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const laptopCtx = await browser.newContext({ viewport: { width: 420, height: 700 } });
const phone = await phoneCtx.newPage();
const laptop = await laptopCtx.newPage();

async function signIn(page) {
  await page.goto(BASE);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator(".dd-status-online").waitFor({ timeout: 5000 });
}
const texts = (page) => page.locator(".dd-row .dd-text").allTextContents();
const row = (page, text) => page.locator(".dd-row", { has: page.locator(".dd-text", { hasText: new RegExp(`^${text.replace(/[()]/g, "\\$&")}$`) }) });
async function add(page, text) {
  const input = page.getByLabel("Add task");
  await input.fill(text);
  await input.press("Enter");
}

try {
  await signIn(laptop);
  await signIn(phone);
  record("both devices sign in and connect", true);

  for (const [srcName, src, dst] of [["laptop", laptop, phone], ["phone", phone, laptop]]) {
    const other = srcName === "laptop" ? "phone" : "laptop";
    const t = `${srcName} task`;
    const lat = [];
    await add(src, t);
    lat.push(await waitFor(async () => (await texts(dst)).includes(t)));
    await row(src, t).locator(".dd-text").click();
    const edit = src.getByLabel("Edit task");
    await edit.fill(`${t} edited`);
    await edit.press("Enter");
    lat.push(await waitFor(async () => (await texts(dst)).includes(`${t} edited`)));
    await row(src, `${t} edited`).getByRole("checkbox").click();
    lat.push(await waitFor(async () => (await row(dst, `${t} edited`).getAttribute("class")).includes("dd-done")));
    await row(src, `${t} edited`).hover();
    await row(src, `${t} edited`).getByRole("button", { name: /^Delete/ }).click();
    lat.push(await waitFor(async () => !(await texts(dst)).includes(`${t} edited`)));
    record(`add/edit/check/delete ${srcName} -> ${other} within 2 s`, Math.max(...lat) < 2000, `latencies ms: ${lat.join(", ")}`);
  }

  // Inline edit: Esc cancels
  await add(laptop, "esc test");
  await row(laptop, "esc test").locator(".dd-text").click();
  await laptop.getByLabel("Edit task").fill("should not save");
  await laptop.getByLabel("Edit task").press("Escape");
  record("Esc cancels an inline edit", (await texts(laptop)).includes("esc test") && !(await texts(laptop)).includes("should not save"));

  // Offline phone: 3 edits, back online, laptop sees each once
  await waitFor(async () => (await texts(phone)).includes("esc test"));
  await phoneCtx.setOffline(true);
  await phone.locator(".dd-status-offline").waitFor({ timeout: 3000 });
  await add(phone, "offline A");
  await add(phone, "offline B");
  await row(phone, "esc test").locator(".dd-text").click();
  await phone.getByLabel("Edit task").fill("edited offline");
  await phone.getByLabel("Edit task").press("Enter");
  await new Promise((r) => setTimeout(r, 800));
  const laptopBefore = await texts(laptop);
  // Reload while offline: proves the outbox and cache survive an app restart (IndexedDB + SW shell).
  await phone.reload();
  const phoneAfterReload = await texts(phone);
  record("phone offline: app reloads from cache with pending edits", JSON.stringify(phoneAfterReload) === JSON.stringify(["edited offline", "offline A", "offline B"]), phoneAfterReload.join(" | "));
  await phoneCtx.setOffline(false);
  const ms = await waitFor(async () => (await texts(laptop)).length === 3, 10000);
  await new Promise((r) => setTimeout(r, 500));
  const final = await texts(laptop);
  const { rows } = await db.query("SELECT text FROM todos WHERE NOT deleted ORDER BY position");
  record(
    "3 offline edits appear on laptop once, no duplicates",
    !laptopBefore.includes("offline A") && JSON.stringify(final) === JSON.stringify(["edited offline", "offline A", "offline B"]) && rows.length === 3,
    `${ms} ms after reconnect; laptop: ${final.join(" | ")}; db rows: ${rows.length}`,
  );

  // Simultaneous edit of the same task
  await Promise.all([laptop, phone].map((p) => row(p, "offline A").locator(".dd-text").click()));
  await Promise.all([laptop.getByLabel("Edit task").fill("from laptop"), phone.getByLabel("Edit task").fill("from phone")]);
  await Promise.all([laptop.getByLabel("Edit task").press("Enter"), phone.getByLabel("Edit task").press("Enter")]);
  await waitFor(async () => JSON.stringify(await texts(laptop)) === JSON.stringify(await texts(phone)) && !(await texts(laptop)).includes("offline A"), 3000);
  const conflictText = (await db.query("SELECT text FROM todos WHERE text LIKE 'from %'")).rows.map((r) => r.text);
  record("simultaneous edit: both devices end with the same text", conflictText.length === 1 && (await texts(phone)).includes(conflictText[0]), `winner: "${conflictText[0]}"`);

  // Drag to reorder on the laptop (mouse), check the phone
  const before = await texts(laptop);
  const handleFirst = laptop.locator(".dd-row").first().locator(".dd-handle");
  const lastRow = laptop.locator(".dd-row").last();
  await laptop.locator(".dd-row").first().hover();
  const hb = await handleFirst.boundingBox();
  const lb = await lastRow.boundingBox();
  await laptop.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await laptop.mouse.down();
  for (let i = 1; i <= 10; i++) await laptop.mouse.move(hb.x + hb.width / 2, hb.y + (lb.y + lb.height - 4 - hb.y) * (i / 10));
  await laptop.mouse.up();
  const expected = [...before.slice(1), before[0]];
  await waitFor(async () => JSON.stringify(await texts(phone)) === JSON.stringify(expected), 2000)
    .then(() => record("drag-reorder on laptop syncs to phone", true, expected.join(" | ")))
    .catch(async () => record("drag-reorder on laptop syncs to phone", false, `laptop: ${(await texts(laptop)).join("|")} phone: ${(await texts(phone)).join("|")}`));

  // Long-press + drag on the phone with real touch events (CDP), check the laptop
  const pBefore = await texts(phone);
  const cdp = await phoneCtx.newCDPSession(phone);
  const hBox = await phone.locator(".dd-row").last().locator(".dd-handle").boundingBox();
  const firstBox = await phone.locator(".dd-row").first().boundingBox();
  const x = hBox.x + hBox.width / 2;
  const touch = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  await touch("touchStart", hBox.y + hBox.height / 2);
  await new Promise((r) => setTimeout(r, 400)); // long-press
  for (let i = 1; i <= 12; i++) await touch("touchMove", hBox.y + hBox.height / 2 - (hBox.y - firstBox.y - 4) * (i / 12));
  await touch("touchEnd");
  const pExpected = [pBefore[2], pBefore[0], pBefore[1]];
  await waitFor(async () => JSON.stringify(await texts(laptop)) === JSON.stringify(pExpected), 2000)
    .then(() => record("long-press drag reorder on phone syncs to laptop", true, pExpected.join(" | ")))
    .catch(async () => record("long-press drag reorder on phone syncs to laptop", false, `phone: ${(await texts(phone)).join("|")}`));

  // 8-item cap
  for (let i = (await texts(laptop)).length; i < 8; i++) await add(laptop, `fill ${i}`);
  await waitFor(async () => (await texts(laptop)).length === 8);
  const ninth = laptop.getByLabel("Add task");
  const placeholder = await ninth.getAttribute("placeholder");
  await ninth.fill("ninth task");
  await ninth.press("Enter");
  const alert = await laptop.getByRole("alert").textContent({ timeout: 2000 }).catch(() => "");
  await new Promise((r) => setTimeout(r, 300));
  const count = (await texts(laptop)).length;
  record("9th item is blocked with a clear message", count === 8 && /at most 8/.test(alert) && !(await texts(phone)).includes("ninth task"), `placeholder "${placeholder}", alert "${alert}", rows ${count}`);
  await ninth.fill("");

  // Clear completed
  await row(laptop, "fill 3").getByRole("checkbox").click();
  await row(laptop, "fill 4").getByRole("checkbox").click();
  await waitFor(async () => (await phone.locator(".dd-row.dd-done").count()) === 2);
  await phone.getByRole("button", { name: "Clear completed" }).click();
  await waitFor(async () => (await texts(laptop)).length === 6)
    .then(() => record("clear completed on phone syncs to laptop", true))
    .catch(() => record("clear completed on phone syncs to laptop", false));

  // --- Slow / sleeping server: the app must render its saved list at once, never a blank page ----
  // Reload the phone with every /api/session call delayed 25 s (like a free server waking up).
  const phoneTexts = await texts(phone);
  await phone.evaluate(() => localStorage.removeItem("deskdo.signedIn")); // force the session check
  await phone.route("**/api/session", async (route) => {
    await new Promise((r) => setTimeout(r, 25_000));
    await route.continue().catch(() => {});
  });
  const t0 = Date.now();
  await phone.reload({ waitUntil: "domcontentloaded" });
  await phone.locator(".dd-card").waitFor({ timeout: 5000 });
  const renderMs = Date.now() - t0;
  const shown = await texts(phone);
  const loginShown = await phone.getByRole("button", { name: "Sign in" }).isVisible().catch(() => false);
  record("server slow to answer: app shows the saved list immediately, no sign-in prompt",
    renderMs < 5000 && JSON.stringify(shown) === JSON.stringify(phoneTexts) && !loginShown,
    `rendered in ${renderMs} ms, ${shown.length} tasks, sign-in form ${loginShown ? "shown" : "not shown"}`);
  await phone.unroute("**/api/session");

  // --- Android app hand-off: a fresh page with no session gets signed in from outside ------------
  const appCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const app = await appCtx.newPage();
  await app.goto(BASE);
  await app.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 5000 }); // no session yet
  // What MainActivity does: obtain the session cookie natively, then dispatch "deskdo-session".
  const login = await appCtx.request.post(`${BASE}/api/login`, { data: { email: EMAIL, password: PASSWORD, deviceId: "android-e2e", mode: "bearer" } });
  const { token } = await login.json();
  const handoff = await appCtx.request.get(`${BASE}/api/handoff`, { headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0 });
  const cookie = handoff.headers()["set-cookie"].split(";")[0];
  const [name, value] = cookie.split("=");
  await appCtx.addCookies([{ name, value, url: BASE, httpOnly: true, sameSite: "Strict" }]);
  await app.evaluate(() => window.dispatchEvent(new Event("deskdo-session")));
  await app.locator(".dd-status-online").waitFor({ timeout: 5000 });
  await waitFor(async () => JSON.stringify(await texts(app)) === JSON.stringify(await texts(laptop)), 3000)
    .then(() => record("Android hand-off: page signs in by itself and shows the same tasks", true))
    .catch(async () => record("Android hand-off: page signs in by itself and shows the same tasks", false, (await texts(app)).join("|")));
  await add(app, "added in android app");
  await waitFor(async () => (await texts(laptop)).includes("added in android app"), 2000)
    .then((ms) => record("Android app -> laptop within 2 s after hand-off", true, `${ms} ms`))
    .catch(() => record("Android app -> laptop within 2 s after hand-off", false));
  // The Android widget bridge: the page reports its list to window.DeskDoAndroid when it changes.
  await app.addInitScript(() => {
    window.__widgetReports = [];
    window.DeskDoAndroid = { onItemsChanged: (json) => window.__widgetReports.push(JSON.parse(json)) };
  });
  await app.reload();
  await app.locator(".dd-status-online").waitFor({ timeout: 5000 });
  await add(laptop, "laptop -> android widget");
  await waitFor(async () => (await app.evaluate(() => window.__widgetReports.at(-1)?.map((i) => i.text) ?? [])).includes("laptop -> android widget"), 2000)
    .then((ms) => record("change on laptop reaches the Android widget via the app within 2 s", true, `${ms} ms`))
    .catch(async () => record("change on laptop reaches the Android widget via the app within 2 s", false, JSON.stringify(await app.evaluate(() => window.__widgetReports.length))));
  await appCtx.close();

  await laptop.screenshot({ path: join(root, "e2e/laptop.png") });
  await phone.screenshot({ path: join(root, "e2e/phone.png") });
} catch (e) {
  record("e2e run", false, e.stack);
} finally {
  await browser.close();
  server.kill();
  await db.end();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
