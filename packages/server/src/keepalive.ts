/**
 * Render's free web services sleep after 15 minutes without inbound traffic and sometimes fail to
 * wake up again. While awake, the server requests its own public URL every few minutes; that
 * request comes in through Render's router like any visitor's, so the service never counts as idle.
 *
 * Only during "active hours": the free tier's 750 instance-hours a month are shared by every free
 * service in the Render workspace, so letting DeskDo sleep at night leaves room for the others.
 */
export interface KeepAliveWindow {
  /** Local hour (0-23) the window opens. */
  startHour: number;
  /** Local hour (0-23) the window closes; may be smaller than startHour (window crosses midnight). */
  endHour: number;
  timeZone: string;
}

/** Parses "6-1" style hour ranges. Returns null for anything malformed. */
export function parseHours(spec: string | undefined, timeZone: string): KeepAliveWindow | null {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec ?? "");
  if (!m) return null;
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (startHour > 23 || endHour > 23) return null;
  return { startHour, endHour, timeZone };
}

export function localHour(date: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(date);
  return Number(h);
}

export function inWindow(w: KeepAliveWindow, date: Date): boolean {
  const h = localHour(date, w.timeZone);
  if (w.startHour === w.endHour) return true; // "0-0": always
  return w.startHour < w.endHour ? h >= w.startHour && h < w.endHour : h >= w.startHour || h < w.endHour;
}

export function startKeepAlive(opts: { url: string | undefined; window: KeepAliveWindow | null; intervalMs?: number; log?: (m: string) => void }): () => void {
  const log = opts.log ?? console.log;
  if (!opts.url || !opts.window) {
    log("keep-alive: off (no public URL or KEEPALIVE_HOURS)");
    return () => {};
  }
  const url = opts.url.replace(/\/+$/, "") + "/healthz";
  const w = opts.window;
  const intervalMs = opts.intervalMs ?? 10 * 60_000;
  log(`keep-alive: pinging ${url} every ${Math.round(intervalMs / 60_000)} min between ${w.startHour}:00 and ${w.endHour}:00 ${w.timeZone}`);
  const timer = setInterval(() => {
    if (!inWindow(w, new Date())) return;
    fetch(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" }).catch(() => {
      /* next tick tries again */
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
