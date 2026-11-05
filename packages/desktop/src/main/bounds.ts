/** Window placement rules, kept free of Electron imports so they can be unit-tested. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_SIZE = { width: 320, height: 430 };
export const MIN_SIZE = { width: 240, height: 200 };
export const MAX_SIZE = { width: 640, height: 1000 };
const MARGIN = 32;

/** Default spot: top-right of the primary display's work area (never over the taskbar). */
export function defaultBounds(workArea: Rect): Rect {
  const width = Math.min(DEFAULT_SIZE.width, workArea.width - 2 * MARGIN);
  const height = Math.min(DEFAULT_SIZE.height, workArea.height - 2 * MARGIN);
  return { x: workArea.x + workArea.width - width - MARGIN, y: workArea.y + MARGIN, width, height };
}

export function clampSize(width: number, height: number, workArea?: Rect): { width: number; height: number } {
  const maxW = Math.min(MAX_SIZE.width, workArea?.width ?? Infinity);
  const maxH = Math.min(MAX_SIZE.height, workArea?.height ?? Infinity);
  return {
    width: Math.round(Math.max(MIN_SIZE.width, Math.min(width, maxW))),
    height: Math.round(Math.max(MIN_SIZE.height, Math.min(height, maxH))),
  };
}

/** Move/shrink `r` so it lies entirely inside `wa` (the work area excludes the taskbar). */
export function clampInto(r: Rect, wa: Rect): Rect {
  const { width, height } = clampSize(r.width, r.height, wa);
  const x = Math.min(Math.max(r.x, wa.x), wa.x + wa.width - width);
  const y = Math.min(Math.max(r.y, wa.y), wa.y + wa.height - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Restore saved bounds if they are still on a connected display (monitors get unplugged, resolutions
 * change); otherwise fall back to the default position on the primary display.
 */
export function restoreBounds(saved: Rect | null, workAreas: Rect[], primaryWorkArea: Rect): Rect {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return defaultBounds(primaryWorkArea);
  let best: Rect | null = null;
  let bestOverlap = 0;
  for (const wa of workAreas) {
    const o = overlapArea(saved, wa);
    if (o > bestOverlap) {
      bestOverlap = o;
      best = wa;
    }
  }
  // Require a meaningful part of the widget to be on-screen, else it's effectively lost.
  if (!best || bestOverlap < 0.25 * saved.width * saved.height) return defaultBounds(primaryWorkArea);
  return clampInto(saved, best);
}
