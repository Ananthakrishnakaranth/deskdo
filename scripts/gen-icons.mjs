// Generates every app icon (PWA, Apple touch, Windows installer, tray) as PNG with no dependencies:
// a rounded dark square with a blue check mark, rendered with 4x4 supersampling.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Coordinates are in a 0..1 unit square. `pad` shrinks the art (maskable icons need a safe zone). */
function render(size, { pad = 0.06, radius = 0.22, full = false } = {}) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  const bg = [24, 27, 35], fg = [122, 167, 255];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, cr = 0, cg = 0, cb = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
      // rounded square
      const lo = full ? 0 : pad, hi = 1 - lo, r = full ? 0 : radius;
      const qx = Math.max(lo + r - u, 0, u - (hi - r)), qy = Math.max(lo + r - v, 0, v - (hi - r));
      const inside = u >= lo && u <= hi && v >= lo && v <= hi && Math.hypot(qx, qy) <= r;
      if (!inside) continue;
      // check mark, scaled into the safe zone for maskable icons
      const s = full ? 0.62 : 1, o = (1 - s) / 2;
      const cu = (u - o) / s, cv = (v - o) / s;
      const d = Math.min(distToSegment(cu, cv, 0.28, 0.53, 0.44, 0.69), distToSegment(cu, cv, 0.44, 0.69, 0.73, 0.33));
      const c = d < 0.065 ? fg : bg;
      a++; cr += c[0]; cg += c[1]; cb += c[2];
    }
    const i = (y * size + x) * 4;
    if (a) { out[i] = cr / a; out[i + 1] = cg / a; out[i + 2] = cb / a; out[i + 3] = (255 * a) / (SS * SS); }
  }
  return png(size, out);
}

const targets = [
  ["packages/mobile/public/icons/icon-192.png", 192, {}],
  ["packages/mobile/public/icons/icon-512.png", 512, {}],
  ["packages/mobile/public/icons/maskable-512.png", 512, { full: true }],
  ["packages/mobile/public/icons/apple-touch-icon.png", 180, { full: true }],
  ["packages/mobile/public/favicon.png", 64, {}],
  ["packages/desktop/build/icon.png", 512, {}],
  ["packages/desktop/resources/tray.png", 32, { pad: 0.02, radius: 0.25 }],
  ["packages/desktop/resources/tray@2x.png", 64, { pad: 0.02, radius: 0.25 }],
  ["packages/desktop/resources/icon.png", 256, {}],
];
for (const [file, size, opts] of targets) {
  const p = join(root, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, render(size, opts));
  console.log("wrote", file);
}
