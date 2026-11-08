import type { BrowserWindow } from "electron";

/**
 * Keeps the widget at the bottom of the Z-order on Windows, so normal app windows cover it, like a
 * desktop gadget. Electron has no "always on bottom" option, so we call user32 SetWindowPos with
 * HWND_BOTTOM through koffi (FFI with prebuilt binaries; no compiler needed).
 *
 * We do this only on a few discrete events (shown, focused, unfocused) and rate-limit it. An earlier
 * version also re-pinned on every WM_WINDOWPOSCHANGED message; because our own SetWindowPos call
 * produces that message, it could feed itself and keep the main process busy, which starved IPC and
 * stopped the widget from syncing. Never hook window-position messages here.
 *
 * Why not reparent into the desktop's WorkerW window (what wallpaper engines do)? It depends on an
 * undocumented message whose window layout changed in Windows 11 24H2; HWND_BOTTOM is documented
 * and stable. Trade-off: "Show desktop" (Win+D) hides the widget along with other windows.
 */
export function pinToDesktopLayer(win: BrowserWindow): void {
  if (process.platform !== "win32") return;

  let SetWindowPos: (hwnd: bigint, after: bigint, x: number, y: number, cx: number, cy: number, flags: number) => boolean;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    SetWindowPos = user32.func("bool __stdcall SetWindowPos(intptr hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)");
  } catch (e) {
    console.error("desktop layer: FFI unavailable, widget will behave like a normal (non-topmost) window", e);
    return;
  }

  const HWND_BOTTOM = 1n;
  const SWP_NOSIZE = 0x0001;
  const SWP_NOMOVE = 0x0002;
  const SWP_NOACTIVATE = 0x0010;
  const SWP_NOOWNERZORDER = 0x0200;
  const SWP_NOSENDCHANGING = 0x0400;

  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));

  let last = 0;
  let pending: NodeJS.Timeout | undefined;
  const sendToBottom = () => {
    if (win.isDestroyed() || pending) return;
    // At most ~4 times a second, whatever triggers it.
    const wait = Math.max(0, 250 - (Date.now() - last));
    pending = setTimeout(() => {
      pending = undefined;
      last = Date.now();
      if (win.isDestroyed()) return;
      try {
        SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING);
      } catch (e) {
        console.error("desktop layer: SetWindowPos failed", e);
      }
    }, wait);
  };

  win.on("show", sendToBottom);
  win.on("focus", sendToBottom);
  win.on("blur", sendToBottom);
  win.on("closed", () => clearTimeout(pending));
  sendToBottom();
}
