// Dev loop: Vite (renderer, hot reload) + esbuild watch (main/preload) + Electron.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const electronPath = require("electron"); // resolves to the Electron binary path

const vite = await createServer({ configFile: "vite.config.ts", server: { port: 5174, strictPort: true } });
await vite.listen();
const url = `http://localhost:5174/`;

await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ["scripts/build-main.mjs"], { stdio: "inherit" });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("main build failed"))));
});
spawn(process.execPath, ["scripts/build-main.mjs", "--watch"], { stdio: "inherit" });

const electron = spawn(electronPath, ["."], { stdio: "inherit", env: { ...process.env, VITE_DEV_SERVER_URL: url } });
electron.on("exit", async (code) => {
  await vite.close();
  process.exit(code ?? 0);
});
