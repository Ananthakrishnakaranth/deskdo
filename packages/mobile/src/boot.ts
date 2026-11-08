import { createHttpTransport, SyncEngine } from "@deskdo/shared";
import { IdbStore } from "./idbStore";

/**
 * Whether we know if this browser has a session:
 *  - "signed-in": the hint is set, sync is running.
 *  - "unknown": still checking, or the server couldn't be reached (asleep/offline). Not a reason to
 *    show the sign-in form.
 *  - "signed-out": the server answered and there is no session: show the sign-in form.
 */
export type SessionState = "signed-in" | "unknown" | "signed-out";

export interface SessionProbe {
  get(): SessionState;
  subscribe(fn: () => void): () => void;
  /** Ask the server again (on start, when back online, and when the Android app signs us in). */
  check(): void;
  markSignedIn(): void;
}

export interface AppContext {
  engine: SyncEngine;
  store: IdbStore;
  session: SessionProbe;
}

// Non-secret hint so we can start syncing immediately when opened offline. The session itself is an
// httpOnly cookie that JavaScript can't read.
export const SIGNED_IN_KEY = "deskdo.signedIn";

function readHint(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_KEY) === "1";
  } catch {
    return false;
  }
}
function writeHint(on: boolean): void {
  try {
    if (on) localStorage.setItem(SIGNED_IN_KEY, "1");
    else localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    /* storage unavailable: we'll just re-check next time */
  }
}

function createSessionProbe(engine: SyncEngine): SessionProbe {
  let state: SessionState = readHint() ? "signed-in" : "unknown";
  let inFlight = false;
  const listeners = new Set<() => void>();
  const set = (s: SessionState) => {
    if (s === state) return;
    state = s;
    listeners.forEach((l) => l());
  };
  const startSync = () => engine.setTransport(createHttpTransport({ baseUrl: "" }));

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    markSignedIn() {
      writeHint(true);
      set("signed-in");
      startSync();
    },
    check() {
      if (state === "signed-in" || inFlight) return;
      inFlight = true;
      // Never block the UI on this: the free server can take a minute to wake up.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      fetch("/api/session", { cache: "no-store", signal: ctl.signal })
        .then((res) => {
          if (res.ok) this.markSignedIn();
          else if (res.status === 401) set("signed-out");
        })
        .catch(() => {
          /* asleep or offline: stay "unknown" and try again later */
        })
        .finally(() => {
          clearTimeout(timer);
          inFlight = false;
        });
    },
  };
}

export async function boot(): Promise<AppContext> {
  const store = await IdbStore.open();
  const engine = new SyncEngine(store);
  await engine.init(); // local data only: the list is shown before any network request
  const session = createSessionProbe(engine);
  if (session.get() === "signed-in") engine.setTransport(createHttpTransport({ baseUrl: "" }));
  else session.check();

  // Mobile networks come and go: react to the OS's connectivity and foreground signals.
  const wake = () => {
    engine.kick();
    session.check();
  };
  addEventListener("online", wake);
  addEventListener("offline", () => engine.markOffline());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  addEventListener("pageshow", wake);
  // Sent by the Android app once it has handed its sign-in over to this page.
  addEventListener("deskdo-session", wake);
  return { engine, store, session };
}
