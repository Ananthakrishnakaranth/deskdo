import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// In dev, proxy the API and WebSocket so the PWA is same-origin with the server (the session cookie
// is SameSite=Strict + httpOnly). In production the server serves this build directly.
const API = process.env.DESKDO_API ?? "http://localhost:8080";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.png", "icons/apple-touch-icon.png"],
      manifest: {
        name: "DeskDo",
        short_name: "DeskDo",
        description: "Your to-do list, synced with your desktop widget.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#0e1015",
        theme_color: "#0e1015",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // App shell is precached so the PWA opens offline. API/WebSocket traffic is never cached:
        // offline data lives in IndexedDB and goes through the sync outbox instead.
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/healthz/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    proxy: {
      "/api": { target: API, changeOrigin: false },
      "/ws": { target: API.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { target: "es2022", sourcemap: true },
});
