// Launches the real Electron widget (built), checks window flags, local persistence across restarts,
// position memory, and memory use. Linux/Xvfb can't show Windows z-order behaviour; see README.
//   pnpm --filter @deskdo/desktop build && xvfb-run -a node e2e/desktop-smoke.mjs
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "packages/desktop");
const configHome = mkdtempSync(join(tmpdir(), "deskdo-desktop-"));
const env = { ...process.env, XDG_CONFIG_HOME: configHome };
const results = [];
const record = (name, pass, detail = "") => { results.push(pass); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

async function launch() {
  const app = await electron.launch({ executablePath: require(join(root, "node_modules/electron")), args: [appDir], env });
  const page = await app.firstWindow();
  await page.waitForSelector(".dd-card");
  return { app, page };
}
const winInfo = (app) => app.evaluate(({ BrowserWindow, screen }) => {
  const w = BrowserWindow.getAllWindows()[0];
  return {
    bounds: w.getBounds(), focused: w.isFocused(), visible: w.isVisible(), alwaysOnTop: w.isAlwaysOnTop(),
    workArea: screen.getPrimaryDisplay().workArea,
  };
});

let { app, page } = await launch();
const info = await winInfo(app);
record("window visible after start", info.visible);
record("does not take focus on startup", !info.focused);
record("not always-on-top", !info.alwaysOnTop);
const right = info.workArea.x + info.workArea.width;
record("default position on the right side, inside the work area (taskbar excluded)",
  info.bounds.x + info.bounds.width === right - 32 && info.bounds.y + info.bounds.height <= info.workArea.y + info.workArea.height,
  JSON.stringify(info.bounds));

for (const t of ["Finish OS assignment", "Buy groceries", "Call the bank"]) {
  await page.getByLabel("Add task").fill(t);
  await page.getByLabel("Add task").press("Enter");
}
await page.locator(".dd-row", { hasText: "Buy groceries" }).getByRole("checkbox").click();
await page.locator(".dd-row", { hasText: "Call the bank" }).locator(".dd-text").click();
await page.getByLabel("Edit task").fill("Call the bank re: card");
await page.getByLabel("Edit task").press("Enter");
// Move + resize, as the user would by dragging the header / grip.
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 900, y: 120, width: 360, height: 460 }));
await page.waitForTimeout(800); // debounced save
await page.locator(".dd-card").screenshot({ path: join(root, "e2e/widget.png") });

const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize })));
const totalMb = metrics.reduce((s, m) => s + m.kb, 0) / 1024;
console.log("info  RSS sum incl. Playwright instrumentation (double-counts shared libs):", `${totalMb.toFixed(0)} MB: ${metrics.map((m) => `${m.type} ${(m.kb / 1024).toFixed(0)}`).join(", ")}`);

await app.close();
({ app, page } = await launch());
const texts = await page.locator(".dd-row .dd-text").allTextContents();
const done = await page.locator(".dd-row.dd-done .dd-text").allTextContents();
record("items survive a restart", JSON.stringify(texts) === JSON.stringify(["Finish OS assignment", "Buy groceries", "Call the bank re: card"]) && done[0] === "Buy groceries", texts.join(" | "));
const after = await winInfo(app);
record("position and size survive a restart", JSON.stringify(after.bounds) === JSON.stringify({ x: 900, y: 120, width: 360, height: 460 }), JSON.stringify(after.bounds));
record("still unfocused after restart", !after.focused);

// Settings panel opens from the tray "Settings…" path (same IPC event).
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("open-settings"));
await page.getByRole("dialog", { name: "Settings" }).waitFor();
record("settings panel opens (tray → Settings…)", true);
await page.screenshot({ path: join(root, "e2e/widget-settings.png") });

// Off-screen saved position (monitor unplugged) falls back to the default.
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 5000, y: 5000, width: 360, height: 460 }));
await page.waitForTimeout(800);
await app.close();
({ app, page } = await launch());
const fb = await winInfo(app);
record("off-screen position is recovered on next start", fb.bounds.x + fb.bounds.width <= fb.workArea.x + fb.workArea.width && fb.bounds.y >= fb.workArea.y, JSON.stringify(fb.bounds));
await app.close();

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
