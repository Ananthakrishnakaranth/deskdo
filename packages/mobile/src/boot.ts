import { createHttpTransport, SyncEngine } from "@deskdo/shared";
import { IdbStore } from "./idbStore";

export interface AppContext {
  engine: SyncEngine;
  store: IdbStore;
}

// Non-secret hint so we can start syncing immediately when opened offline. The session itself is an
// httpOnly cookie that JavaScript can't read.
export const SIGNED_IN_KEY = "deskdo.signedIn";

export async function boot(): Promise<AppContext> {
  const store = await IdbStore.open();
  const engine = new SyncEngine(store);
  await engine.init();
  if (localStorage.getItem(SIGNED_IN_KEY) === "1") engine.setTransport(createHttpTransport({ baseUrl: "" }));

  // Mobile networks come and go: react to the OS's connectivity and foreground signals.
  addEventListener("online", () => engine.kick());
  addEventListener("offline", () => engine.markOffline());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") engine.kick();
  });
  addEventListener("pageshow", () => engine.kick());
  return { engine, store };
}
