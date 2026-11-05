import { defineConfig } from "vitest/config";
// Integration tests share one Postgres database, so run files one at a time.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 20_000 } });
