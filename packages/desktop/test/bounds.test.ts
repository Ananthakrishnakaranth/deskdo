import { describe, expect, it } from "vitest";
import { clampInto, defaultBounds, restoreBounds, type Rect } from "../src/main/bounds";

// 1920x1080 display with a 48px taskbar at the bottom (Windows 11 default).
const primary: Rect = { x: 0, y: 0, width: 1920, height: 1032 };
const second: Rect = { x: 1920, y: 0, width: 2560, height: 1392 };

describe("window bounds", () => {
  it("defaults to the right side of the primary work area", () => {
    const b = defaultBounds(primary);
    expect(b.x + b.width).toBe(1920 - 32);
    expect(b.y).toBe(32);
  });

  it("never overlaps the taskbar", () => {
    const b = clampInto({ x: 1500, y: 900, width: 320, height: 430 }, primary);
    expect(b.y + b.height).toBeLessThanOrEqual(primary.height);
  });

  it("restores a saved position on a still-connected monitor", () => {
    const saved = { x: 3000, y: 200, width: 350, height: 500 };
    expect(restoreBounds(saved, [primary, second], primary)).toEqual(saved);
  });

  it("falls back to default when the monitor is gone", () => {
    const saved = { x: 3000, y: 200, width: 350, height: 500 };
    expect(restoreBounds(saved, [primary], primary)).toEqual(defaultBounds(primary));
  });

  it("pulls a partly off-screen widget back on-screen", () => {
    const b = restoreBounds({ x: 1800, y: 100, width: 320, height: 430 }, [primary], primary);
    expect(b.x + b.width).toBeLessThanOrEqual(1920);
  });

  it("handles garbage", () => {
    expect(restoreBounds({ x: NaN, y: 0, width: 1, height: 1 }, [primary], primary)).toEqual(defaultBounds(primary));
    expect(restoreBounds(null, [primary], primary)).toEqual(defaultBounds(primary));
  });
});
