# DeskDo

A to-do widget for the Windows 11 desktop, plus an installable phone app (PWA). Both share one list, synced in real time through your own small server and Postgres database.

```
 Windows 11                                     Phone (Android Chrome / iOS Safari)
┌──────────────────────────────┐                ┌───────────────────────────────┐
│ Electron widget              │                │ PWA (React, service worker)   │
│  renderer: React TodoCard ───┼─┐            ┌─┼── same TodoCard + SyncEngine  │
│            SyncEngine        │ │            │ │   IndexedDB: cache + outbox   │
│  main: SQLite cache/outbox   │ │            │ │   httpOnly session cookie     │
│        Credential Manager    │ │            │ └───────────────────────────────┘
│        tray, autostart,      │ │  HTTPS: POST /api/ops, GET /api/changes
│        bottom-of-Z-order     │ │  WSS:   /ws  (server pushes "changes")
└──────────────────────────────┘ │            │
                                 ▼            ▼
                     ┌─────────────────────────────────┐      ┌───────────────────┐
                     │ Node server (Render, free tier) │─────▶│ Postgres (Neon,   │
                     │ HTTP API + WebSocket hub        │      │ free) = source of │
                     │ also serves the built PWA       │      │ truth             │
                     └─────────────────────────────────┘      └───────────────────┘
```

```
packages/
  shared/    types, sync engine, outbox compaction, conflict-free view derivation, React UI (TodoCard)
  server/    Node + TypeScript HTTP/WebSocket server, Postgres schema, auth, conflict rules
  desktop/   Electron main (window, tray, autostart, desktop layer, SQLite, keychain) + React renderer
  mobile/    React + Vite PWA (IndexedDB store, service worker, install manifest)
e2e/         Playwright acceptance runs (PWA two-device sync; Electron widget smoke test; RAM)
scripts/     icon generator, test DB init
```

## Choices (and why)

| Area | Choice | Reason |
|---|---|---|
| Desktop | **Electron 45** + React + TS | Gives reliable tray, autostart, frameless transparent window, `hookWindowMessage`. Tauri can do tray and autostart, but bottom-of-Z-order pinning would need the same Win32 calls written in Rust, so it brings no advantage here. |
| Desktop storage | **SQLite via Node's built-in `node:sqlite`** (Electron 45 ships Node 24) | Still SQLite, but no native module to compile. `better-sqlite3` has no prebuilt binary for Electron 45, so it would require Visual Studio Build Tools on your PC. |
| Token storage | **Windows Credential Manager** via `@napi-rs/keyring` | Prebuilt, maintained (keytar is archived). Shows up as *DeskDo* in Credential Manager. |
| Mobile | **PWA** (not React Native) | No app store, same React UI and sync code, offline via service worker + IndexedDB. Native would only be clearly better for background sync or push notifications, which this doesn't need. |
| PWA auth | **httpOnly, SameSite=Strict cookie** | A PWA has no access to the OS keychain. The cookie is the most secure store a web app has, because JavaScript can't read it. This requires the PWA to be **served by the API server (same origin)**, so the server hosts it. |
| Hosting | **Render** (free web service) + **Neon** (free Postgres) | Both free with no credit card. Render's own free Postgres is deleted after 30 days, so the database lives on Neon. |
| "Active" items | **Not done and not deleted.** Max 8. | Completed items stay visible (struck through) until *Clear completed*. Un-checking an item when 8 are already open is also blocked. |

## Sync model

Every item has `id` (client-made UUID), `text`, `done`, `position`, `updated_at` (server time), `deleted` (tombstone), `last_device_id`, plus a server `seq` (global change counter, used as the pull cursor).

- **Clients never edit state directly.** Every change becomes an *op* (`create` / `update` / `delete`, each with a UUID `opId`) in a persistent **outbox**. What you see = last confirmed server state + the outbox replayed on top. When the server answers, the op leaves the outbox and the view recomputes, so there's nothing to roll back by hand.
- **Push:** `POST /api/ops`. The server applies the batch in one transaction, serialised by an advisory lock, then broadcasts the changed items over WebSocket to every device. Typical latency in tests is 10–40 ms.
- **Conflicts:**
  - Different items never conflict.
  - Same item: last write wins **by server time**. Each write gets a timestamp strictly greater than every earlier write (arrival order). Updates only carry the fields that changed, so ticking a box on the phone doesn't undo a text edit made on the laptop.
  - **A delete beats any edit**, including an offline edit that reaches the server *after* the delete. Tombstones are final.
  - 8-item limit enforced on the server too: if two offline devices together add too many, the later ops are *rejected* and that device shows the message.
- **Offline / no duplicates:** the outbox is stored in SQLite or IndexedDB, so it survives restarts. On reconnect the client flushes the outbox, then pulls everything since its cursor. The server records every `opId`, so a replay after a lost response is a no-op. Consecutive unsent edits to one item are merged, which keeps the outbox small.
- **Cursor safety:** only complete pull responses move the cursor, never push replies or broadcasts. A bug where they did was caught by the tests. Tombstones are purged after 90 days; a client whose cursor is older gets a full reset.

## Windows setup (development)

Prerequisites: **Node 22+**, **Git**, and **Docker Desktop** (for local Postgres; or install PostgreSQL 16 natively).

```powershell
corepack enable
```
```powershell
git clone <your-repo-url> deskdo; cd deskdo
```
```powershell
pnpm install
```
```powershell
docker compose up -d
```
That creates databases `deskdo` and `deskdo_test` (user/password `deskdo`/`deskdo`, local only).

### Configure the server
```powershell
Copy-Item packages/server/.env.example packages/server/.env
```
```powershell
pnpm --filter @deskdo/server hash-password
```
Paste the printed `ACCOUNT_PASSWORD_HASH='...'` line into `packages/server/.env`, set `ACCOUNT_EMAIL`, and set `JWT_SECRET` to the output of:
```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Run each part
| Part | Command | Notes |
|---|---|---|
| Server | `pnpm dev:server` | http://localhost:8080 , migrates the DB on start |
| PWA | `pnpm dev:mobile` | http://localhost:5173 , proxies `/api` and `/ws` to the server. On your phone (same Wi-Fi) open `http://<PC-LAN-IP>:5173` to try it; installing needs HTTPS, so do that after deploying. |
| Widget | `pnpm dev:desktop` | Opens the widget. Settings (gear) → Server URL `http://localhost:8080`, your email and password. |

### Tests
```powershell
pnpm test
```
Runs unit tests and server integration tests (needs the Docker Postgres from above).

```powershell
pnpm build; npx -y playwright@1 install chromium; pnpm e2e
```
Runs the two-device PWA acceptance run in real Chromium.

### Build the Windows installer (.exe)
Run on Windows (no Visual Studio or Wine needed):
```powershell
pnpm dist:win
```
Output: `packages/desktop/release/DeskDo-Setup-1.0.0.exe`. It's a per-user install, so no admin is needed. The installer isn't code-signed, so SmartScreen will warn: click *More info → Run anyway*. CI (`.github/workflows/ci.yml`) also builds it on a Windows runner and uploads it as an artifact.

## Deploy (free tiers)

**1. Database: Neon.** Create a project at neon.tech, then copy the connection string (`postgresql://...neon.tech/neondb?sslmode=require`).

**2. Server + PWA: Render.**
1. Push this repo to GitHub.
2. Render dashboard → *New → Blueprint* → pick the repo. It reads `render.yaml`.
3. When prompted, set `DATABASE_URL` (Neon string), `ACCOUNT_EMAIL`, and `ACCOUNT_PASSWORD_HASH` (output of `hash-password`, **without** the surrounding quotes). `JWT_SECRET` is generated for you.
4. Deploy. Check `https://<name>.onrender.com/healthz` returns `{"ok":true}`.

**3. Phone:** open `https://<name>.onrender.com`, sign in, then install it:
- **Android Chrome:** ⋮ → *Install app*.
- **iOS Safari:** Share → *Add to Home Screen*.

**4. Widget:** Settings → Server URL `https://<name>.onrender.com` → sign in.

> **Free-tier caveat.** A free Render service sleeps after ~15 minutes without traffic and takes up to about a minute to wake. While it sleeps, both apps keep working offline and sync once it's up. The 2-second guarantee only applies while the server is awake. A paid instance (~$7/month) removes this.

### Environment variables (server)
| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `DATABASE_SSL` | no | `true` for hosted Postgres (Neon), `false` locally |
| `ACCOUNT_EMAIL` | yes | The single account's email |
| `ACCOUNT_PASSWORD_HASH` | yes | bcrypt hash from `hash-password` |
| `JWT_SECRET` | yes | ≥ 32 random chars. **Changing it signs out every device.** |
| `TOKEN_TTL_DAYS` | no | Session lifetime (default 90) |
| `PORT` | no | Default 8080 (Render sets it) |
| `STATIC_DIR` | no | Built PWA directory to serve at `/` |
| `ALLOWED_ORIGINS` | no | Extra origins allowed to use cookie auth |
| `COOKIE_SECURE` | no | Force the cookie's `Secure` flag (auto-detected behind HTTPS) |

The desktop app and PWA have no environment variables; the server URL is entered in the widget's settings.

## Desktop behaviour (Windows)
- **Desktop layer.** The window is frameless, transparent, not always-on-top, and a *tool window* (no taskbar button, not in Alt+Tab). On every Z-order change it calls Win32 `SetWindowPos(HWND_BOTTOM)` (via `koffi`), so every normal window covers it. See `packages/desktop/src/main/desktopLayer.ts` for why it uses this rather than reparenting into `WorkerW`.
- **No focus stealing.** The window is created hidden and shown with `showInactive()`.
- **Never over the taskbar.** Bounds are always clamped to the display's *work area*, which excludes the taskbar, including when monitors change.
- **Position and size** are saved to SQLite and restored on start. If the saved spot is on a monitor that's gone, it falls back to the default (top-right).
- **Autostart** is on by default after install. Toggle it in Settings or the tray menu. It's stored as an `HKCU\...\Run` entry.
- **Tray icon:** click to show/hide. The menu has Show/Hide, Settings…, Start with Windows, and Quit. Closing the widget (Alt+F4) hides it to the tray.
- **Move:** drag the title. **Resize:** drag the bottom-right corner. Transparent windows can't use native resize on Windows.

## Security notes
- No secrets in the repo. The server reads them from env; `.env` is git-ignored.
- Passwords are stored as bcrypt hashes. Login is rate-limited (10 failures per IP per 15 minutes).
- Desktop: the bearer token lives in Windows Credential Manager. It is sent over WebSocket as the first message, not in the URL, so it doesn't end up in proxy logs.
- PWA: the token is in an httpOnly, SameSite=Strict cookie. Cookie requests and WebSockets from other origins are refused (CSRF and cross-site WebSocket hijacking).
- All ops are strictly validated server-side. The PWA is served with a strict CSP.
