import { describe, expect, it } from "vitest";
import { inWindow, localHour, parseHours } from "../src/keepalive";

const IST = "Asia/Kolkata";
const at = (iso: string) => new Date(iso);

describe("keep-alive window", () => {
  it("parses hour ranges and rejects garbage", () => {
    expect(parseHours("6-1", IST)).toEqual({ startHour: 6, endHour: 1, timeZone: IST });
    expect(parseHours("25-1", IST)).toBeNull();
    expect(parseHours("", IST)).toBeNull();
    expect(parseHours(undefined, IST)).toBeNull();
  });

  it("uses local time (India is UTC+5:30)", () => {
    expect(localHour(at("2026-11-08T00:30:00Z"), IST)).toBe(6);
    expect(localHour(at("2026-11-08T18:29:00Z"), IST)).toBe(23);
  });

  it("handles a window that crosses midnight (06:00-01:00)", () => {
    const w = parseHours("6-1", IST)!;
    expect(inWindow(w, at("2026-11-08T00:30:00Z"))).toBe(true); // 06:00 IST
    expect(inWindow(w, at("2026-11-08T12:00:00Z"))).toBe(true); // 17:30
    expect(inWindow(w, at("2026-11-08T19:00:00Z"))).toBe(true); // 00:30
    expect(inWindow(w, at("2026-11-08T19:45:00Z"))).toBe(false); // 01:15
    expect(inWindow(w, at("2026-11-08T23:00:00Z"))).toBe(false); // 04:30
  });

  it("supports a same-day window and always-on", () => {
    expect(inWindow(parseHours("9-17", IST)!, at("2026-11-08T05:00:00Z"))).toBe(true); // 10:30
    expect(inWindow(parseHours("9-17", IST)!, at("2026-11-08T13:00:00Z"))).toBe(false); // 18:30
    expect(inWindow(parseHours("0-0", IST)!, at("2026-11-08T21:00:00Z"))).toBe(true);
  });
});
