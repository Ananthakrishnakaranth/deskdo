import { createHttpTransport, type LoginResponse } from "@deskdo/shared";
import { TodoCard, useEngineState } from "@deskdo/shared/ui";
import { useState, type FormEvent } from "react";
import { SIGNED_IN_KEY, type AppContext } from "./boot";

export function App({ engine, store }: AppContext) {
  const state = useEngineState(engine);
  const [showAccount, setShowAccount] = useState(false);
  const needsLogin = state.status === "local" || state.status === "unauthorized";

  return (
    <main className="app">
      <TodoCard
        engine={engine}
        variant="mobile"
        title="To-do"
        headerExtra={
          <button type="button" className="dd-icon-btn" aria-label="Account" onClick={() => setShowAccount((v) => !v)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" strokeLinecap="round" />
            </svg>
          </button>
        }
      />
      {(needsLogin || showAccount) && (
        <div className="sheet">
          {needsLogin ? (
            <LoginForm
              expired={state.status === "unauthorized"}
              deviceId={engine.getDeviceId()}
              onSignedIn={() => {
                localStorage.setItem(SIGNED_IN_KEY, "1");
                engine.setTransport(createHttpTransport({ baseUrl: "" }));
                setShowAccount(false);
              }}
            />
          ) : (
            <Account
              pending={state.pendingCount}
              onSignOut={async () => {
                await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
                localStorage.removeItem(SIGNED_IN_KEY);
                engine.setTransport(null);
                await store.clearAll();
                location.reload();
              }}
            />
          )}
        </div>
      )}
    </main>
  );
}

function LoginForm({ expired, deviceId, onSignedIn }: { expired: boolean; deviceId: string; onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, deviceId, mode: "cookie" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Sign-in failed (${res.status})`);
      }
      (await res.json()) as LoginResponse;
      setPassword("");
      onSignedIn();
    } catch (err) {
      setError(err instanceof TypeError ? "You're offline. Connect to sign in." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <h2>{expired ? "Session expired" : "Sign in to sync"}</h2>
      <p className="hint">Tasks you add before signing in are kept and uploaded after you sign in.</p>
      <label>
        Email
        <input type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Password
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="err" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

function Account({ pending, onSignOut }: { pending: number; onSignOut: () => void }) {
  return (
    <div className="login">
      <h2>Account</h2>
      <p className="hint">Signed in. Changes sync automatically with your desktop widget.</p>
      {pending > 0 && <p className="err">{pending} change(s) not yet synced will be lost if you sign out now.</p>}
      <button type="button" onClick={onSignOut}>Sign out</button>
    </div>
  );
}
