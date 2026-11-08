import type { SyncEngine, SyncStatus } from "@deskdo/shared";
import { TodoCard, useEngineState } from "@deskdo/shared/ui";
import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import type { DesktopSettings } from "../ipc";

const bridge = window.deskdo;

const STATUS_TEXT: Record<SyncStatus, string> = {
  online: "connected",
  connecting: "connecting…",
  offline: "can't reach the server, retrying",
  unauthorized: "signed out",
  local: "not signed in",
};

export function Widget({ engine, reconnect }: { engine: SyncEngine; reconnect: () => Promise<void> }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { status } = useEngineState(engine);
  useEffect(() => bridge.on.openSettings(() => setSettingsOpen(true)), []);
  // Session expired or revoked: bring up the sign-in form instead of silently not syncing.
  useEffect(() => {
    if (status === "unauthorized") setSettingsOpen(true);
  }, [status]);

  return (
    <div className="widget">
      <TodoCard
        engine={engine}
        variant="widget"
        title="To-do"
        headerClassName="drag-region"
        headerExtra={
          <>
            <button type="button" className="dd-icon-btn no-drag" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen((v) => !v)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
            <button type="button" className="dd-icon-btn no-drag" aria-label="Hide widget (reopen from the tray icon)" title="Hide (reopen from tray)" onClick={() => bridge.win.hide()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M6 12h12" strokeLinecap="round" />
              </svg>
            </button>
          </>
        }
      />
      {settingsOpen && <Settings engine={engine} reconnect={reconnect} onClose={() => setSettingsOpen(false)} />}
      <ResizeGrip />
    </div>
  );
}

function Settings({ engine, reconnect, onClose }: { engine: SyncEngine; reconnect: () => Promise<void>; onClose: () => void }) {
  const state = useEngineState(engine);
  const [s, setS] = useState<DesktopSettings | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const signedIn = state.status !== "local" && state.status !== "unauthorized";

  useEffect(() => {
    void bridge.settings.get().then((v) => {
      setS(v);
      setServerUrl(v.serverUrl);
      setEmail(v.email);
    });
  }, []);

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("Signing in… (a sleeping free-tier server can take up to a minute)");
    const r = await bridge.auth.login(serverUrl, email, password);
    setBusy(false);
    if (!r.ok) return setMsg(r.error);
    setPassword("");
    setMsg(null);
    await reconnect();
    setS(await bridge.settings.get());
  };

  const signOut = async () => {
    if (state.pendingCount > 0 && !confirm(`${state.pendingCount} change(s) haven't synced yet and will be lost. Sign out anyway?`)) return;
    await bridge.auth.logout();
    await bridge.store.clear();
    location.reload();
  };

  if (!s) return null;
  return (
    <div className="settings" role="dialog" aria-label="Settings">
      <div className="settings-head">
        <h2>Settings</h2>
        <button type="button" className="dd-icon-btn" aria-label="Close settings" onClick={onClose}>×</button>
      </div>

      {signedIn ? (
        <div className="settings-section">
          <p>
            Syncing with <b>{s.serverUrl}</b> as {s.email}.
          </p>
          <p className={state.status === "online" ? "ok" : "warn"}>
            Status: {STATUS_TEXT[state.status]}
            {state.pendingCount > 0 ? ` · ${state.pendingCount} change(s) waiting to sync` : ""}
          </p>
          {state.syncError && state.status !== "online" && <p className="hint">Last problem: {state.syncError}</p>}
          {state.status !== "online" && (
            <button type="button" className="btn" onClick={() => engine.kick(true)}>
              Reconnect now
            </button>
          )}
          <button type="button" className="btn" onClick={signOut}>Sign out</button>
        </div>
      ) : (
        <form className="settings-section" onSubmit={signIn}>
          {state.status === "unauthorized" && <p className="warn">Your session expired. Sign in again.</p>}
          <label>
            Server URL
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://your-app.onrender.com" required />
          </label>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          <p className="hint">Your session token is stored in Windows Credential Manager.</p>
        </form>
      )}
      {msg && <p className="warn">{msg}</p>}

      <label className="toggle">
        <input
          type="checkbox"
          checked={s.openAtLogin}
          onChange={async (e) => {
            await bridge.settings.setOpenAtLogin(e.target.checked);
            setS(await bridge.settings.get());
          }}
        />
        Start with Windows
      </label>
      <p className="hint">Drag the title to move. Drag the bottom-right corner to resize. Show, hide and quit from the tray icon.</p>
    </div>
  );
}

/** Custom resize handle: transparent frameless windows can't use native resizing on Windows. */
function ResizeGrip() {
  const start = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.screenX, y: e.screenY, w: window.outerWidth, h: window.outerHeight };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    bridge.win.resizeTo(s.w + e.screenX - s.x, s.h + e.screenY - s.y);
  };
  const onUp = () => {
    start.current = null;
  };
  return <div className="resize-grip" aria-hidden="true" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />;
}
