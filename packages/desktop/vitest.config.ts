import { defineConfig } from "vitest/config";
// Separate from vite.config.ts, whose root is the renderer folder.
export default defineConfig({ test: { root: ".", include: ["test/**/*.test.ts"], environment: "node" } });
