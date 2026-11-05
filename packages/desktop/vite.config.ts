import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./", // loaded from file:// in production
  plugins: [react()],
  build: { outDir: "../../dist", emptyOutDir: true, target: "chrome130" },
});
