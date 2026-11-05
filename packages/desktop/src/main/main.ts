import { app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray } from "electron";
import path from "node:path";
import type { LoginResponse, Op, TodoItem } from "@deskdo/shared";
import type { DesktopSettings } from "../ipc";
import { clampInto, clampSize, restoreBounds, type Rect } from "./bounds";
import { clearToken, getToken, setToken } from "./credentials";
import { pinToDesktopLayer } from "./desktopLayer";
import { LocalDb } from "./localdb";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
// app.getAppPath() is packages/desktop in dev and .../resources/app.asar when installed.
const resources = path.join(app.getAppPath(), "resources");

// ---- memory: this is a small, mostly static UI. Software rendering avoids a GPU process (~40-60 MB)
// and transparent windows still work on Windows without it.
app.disableHardwareAcceleration();
// Favour a small heap over peak JS speed; the UI does very little work.
app.commandLine.appendSwitch("js-flags", "--optimize-for-size --max-old-space-size=96");
// No spellcheck dictionaries, no background networking we don't use.
app.commandLine.appendSwitch("disable-features", "SpareRendererForSitePerProcess,MediaRouter,DialMediaRouteProvider,HardwareMediaKeyHandling");

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
if (process.platform === "win32") app.setAppUserModelId("app.deskdo.widget");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: LocalDb;
let quitting = false;

// Windows matches the Run-key entry by exe path *and* arguments, so the query must pass the same args
// we registered with, or it always reports "off".
const LOGIN_ARGS = ["--autostart"];
const isOpenAtLogin = (): boolean => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;

function settings(): DesktopSettings {
  return {
    serverUrl: db.getMeta("serverUrl") ?? "",
    email: db.getMeta("email") ?? "",
    openAtLogin: isOpenAtLogin(),
  };
}

function setOpenAtLogin(on: boolean): void {
  // Writes HKCU\Software\Microsoft\Windows\CurrentVersion\Run. "--autostart" lets us know we were
  // launched by Windows (so we never steal focus).
  app.setLoginItemSettings({ openAtLogin: on, args: LOGIN_ARGS });
  db.setMeta("openAtLogin", on ? "1" : "0");
  refreshTrayMenu();
}

// ---------------------------------------------------------------- window

function savedBounds(): Rect | null {
  try {
    return JSON.parse(db.getMeta("bounds") ?? "null") as Rect | null;
  } catch {
    return null;
  }
}

function createWindow(): BrowserWindow {
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const bounds = restoreBounds(savedBounds(), displays, screen.getPrimaryDisplay().workArea);

  const w = new BrowserWindow({
    ...bounds,
    show: false, // shown with showInactive() so we never take focus on startup
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false, // transparent windows can't use native resize on Windows; we have a custom grip
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    // "toolbar" = WS_EX_TOOLWINDOW on Windows: no taskbar button and not in Alt+Tab.
    type: process.platform === "win32" ? "toolbar" : undefined,
    title: "DeskDo",
    icon: path.join(resources, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
      devTools: isDev,
    },
  });

  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e) => e.preventDefault());

  // Persist position/size (debounced) whenever the user moves or resizes the widget.
  let saveTimer: NodeJS.Timeout | undefined;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!w.isDestroyed()) db.setMeta("bounds", JSON.stringify(w.getBounds()));
    }, 300);
  };
  w.on("moved", persist);
  w.on("resized", persist);
  w.on("move", persist);

  // Keep it on-screen (and off the taskbar) when displays change.
  const refit = () => {
    if (w.isDestroyed()) return;
    const b = w.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const fitted = clampInto(b, wa);
    if (fitted.x !== b.x || fitted.y !== b.y || fitted.width !== b.width || fitted.height !== b.height) w.setBounds(fitted);
  };
  screen.on("display-metrics-changed", refit);
  screen.on("display-removed", refit);
  w.on("moved", refit);

  // Closing (Alt+F4) hides to tray instead of quitting.
  w.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      w.hide();
      refreshTrayMenu();
    }
  });

  w.once("ready-to-show", () => {
    if (db.getMeta("hidden") !== "1") w.showInactive();
    pinToDesktopLayer(w);
    refreshTrayMenu();
  });

  if (isDev) void w.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else void w.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  return w;
}

function setVisible(show: boolean): void {
  if (!win) return;
  if (show) win.showInactive();
  else win.hide();
  db.setMeta("hidden", show ? "0" : "1");
  refreshTrayMenu();
}

// ---------------------------------------------------------------- tray

function refreshTrayMenu(): void {
  if (!tray) return;
  const visible = !!win?.isVisible();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? "Hide widget" : "Show widget", click: () => setVisible(!visible) },
      {
        label: "Settings…",
        click: () => {
          setVisible(true);
          win?.webContents.send("open-settings");
          win?.focus();
        },
      },
      { label: "Start with Windows", type: "checkbox", checked: isOpenAtLogin(), click: (i) => setOpenAtLogin(i.checked) },
      { type: "separator" },
      { label: "Quit DeskDo", click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

function createTray(): void {
  const img = nativeImage.createFromPath(path.join(resources, "tray.png"));
  const hi = nativeImage.createFromPath(path.join(resources, "tray@2x.png"));
  if (!hi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip("DeskDo");
  tray.on("click", () => setVisible(!win?.isVisible()));
  refreshTrayMenu();
}

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
  ipcMain.handle("store:load", () => db.load());
  ipcMain.handle("store:saveItems", (_e, items: TodoItem[], cursor: number) => db.saveItems(items, cursor));
  ipcMain.handle("store:saveOutbox", (_e, ops: Op[]) => db.saveOutbox(ops));
  ipcMain.handle("store:clear", () => db.clearSyncData());

  ipcMain.handle("auth:getToken", () => getToken());
  ipcMain.handle("auth:logout", () => {
    clearToken();
  });
  ipcMain.handle("auth:login", async (_e, rawUrl: string, email: string, password: string) => {
    let serverUrl: string;
    try {
      const u = new URL(rawUrl.trim());
      const local = ["localhost", "127.0.0.1"].includes(u.hostname) || /^192\.168\.|^10\./.test(u.hostname);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { ok: false, error: "Use an https:// server URL (http is only allowed for localhost/LAN testing)." };
      serverUrl = u.origin;
    } catch {
      return { ok: false, error: "Server URL is not valid." };
    }
    try {
      const res = await fetch(`${serverUrl}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, deviceId: db.load().deviceId, mode: "bearer" }),
        signal: AbortSignal.timeout(60_000), // free-tier hosts can take ~50 s to wake up
      });
      const body = (await res.json().catch(() => ({}))) as LoginResponse & { error?: string };
      if (!res.ok || !body.token) return { ok: false, error: body.error ?? `Sign-in failed (HTTP ${res.status})` };
      setToken(body.token);
      db.setMeta("serverUrl", serverUrl);
      db.setMeta("email", email);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Could not reach the server: ${(e as Error).message}` };
    }
  });

  ipcMain.handle("settings:get", () => settings());
  ipcMain.handle("settings:setOpenAtLogin", (_e, on: boolean) => setOpenAtLogin(on));

  ipcMain.on("win:resizeTo", (_e, width: number, height: number) => {
    if (!win) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const size = clampSize(width, height, wa);
    win.setBounds(clampInto({ ...b, ...size }, wa));
  });
  ipcMain.on("win:hide", () => setVisible(false));
}

// ---------------------------------------------------------------- lifecycle

app.on("second-instance", () => setVisible(true));

app.whenReady().then(() => {
  db = new LocalDb(path.join(app.getPath("userData"), "deskdo.sqlite"));
  // First run of the installed app: enable autostart by default (toggle in tray/settings).
  if (app.isPackaged && db.getMeta("openAtLogin") === null) setOpenAtLogin(true);
  Menu.setApplicationMenu(null);
  registerIpc();
  win = createWindow();
  createTray();
  // Laptop woke up: reconnect now instead of waiting for the backoff timer.
  powerMonitor.on("resume", () => win?.webContents.send("resume"));
  powerMonitor.on("unlock-screen", () => win?.webContents.send("resume"));
});

app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => db?.close());
app.on("window-all-closed", () => {
  /* keep running in the tray */
});
