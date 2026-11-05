import type { BrowserWindow } from "electron";

/**
 * Keeps the widget at the bottom of the Z-order on Windows, so every normal app window covers it,
 * like a desktop gadget. Electron has no API for "always on bottom", so we call user32 SetWindowPos
 * with HWND_BOTTOM through koffi (FFI, prebuilt binaries — no compiler needed) and repeat it whenever
 * Windows changes our Z-order (e.g. when the widget is clicked and gets activated).
 *
 * Why not reparent into the desktop's WorkerW window (what wallpaper engines do)? It depends on an
 * undocumented message (0x052C) whose window layout changed in Windows 11 24H2; HWND_BOTTOM is
 * documented and stable. Trade-off: "Show desktop" (Win+D) hides the widget along with other
 * windows, and clicking the taskbar's show-desktop corner does the same.
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
  const WM_WINDOWPOSCHANGED = 0x0047;

  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  let pushing = false;

  const sendToBottom = () => {
    if (pushing || win.isDestroyed()) return;
    pushing = true; // SetWindowPos synchronously re-sends WM_WINDOWPOSCHANGED; don't recurse.
    try {
      SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    } finally {
      pushing = false;
    }
  };

  let scheduled = false;
  win.hookWindowMessage(WM_WINDOWPOSCHANGED, () => {
    if (pushing || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      sendToBottom();
    });
  });
  win.on("show", sendToBottom);
  win.on("focus", sendToBottom);
  win.on("blur", sendToBottom);
  sendToBottom();
}
