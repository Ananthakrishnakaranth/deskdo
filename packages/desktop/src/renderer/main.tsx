import { SyncEngine, createHttpTransport, type LocalStore } from "@deskdo/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@deskdo/shared/ui/styles.css";
import "./widget.css";
import { Widget } from "./Widget";
import "../ipc";

const bridge = window.deskdo;

/** SQLite in the main process, reached over IPC. */
const store: LocalStore = {
  load: () => bridge.store.load(),
  saveItems: (items, cursor) => bridge.store.saveItems(items, cursor),
  saveOutbox: (ops) => bridge.store.saveOutbox(ops),
};

export async function connect(engine: SyncEngine): Promise<void> {
  const [s, token] = await Promise.all([bridge.settings.get(), bridge.auth.getToken()]);
  if (s.serverUrl && token) {
    // The token only changes when you sign in again, which calls connect() again, so keep it here
    // instead of asking the main process over IPC for every request and every reconnect.
    engine.setTransport(createHttpTransport({ baseUrl: s.serverUrl, getToken: async () => token }));
  } else {
    engine.setTransport(null);
  }
}

const engine = new SyncEngine(store);
await engine.init();
await connect(engine);

addEventListener("online", () => engine.kick(true));
addEventListener("offline", () => engine.markOffline());
bridge.on.resume(() => engine.kick(true)); // woke from sleep: the old socket is probably dead
// Whenever you look at or click the widget and it isn't synced, try again right away.
const kickIfNotOnline = () => {
  if (engine.getState().status !== "online") engine.kick();
};
addEventListener("focus", kickIfNotOnline);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") kickIfNotOnline();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Widget engine={engine} reconnect={() => connect(engine)} />
  </StrictMode>,
);
