// Bundles the Electron main process and preload script (CommonJS, required for sandboxed preloads).
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  // Native modules and Electron itself are loaded at runtime, not bundled.
  external: ["electron", "@napi-rs/keyring", "koffi"],
  logLevel: "info",
};
const entries = [
  { entryPoints: ["src/main/main.ts"], outfile: "dist-electron/main.cjs" },
  { entryPoints: ["src/main/preload.ts"], outfile: "dist-electron/preload.cjs" },
];
if (watch) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
}
