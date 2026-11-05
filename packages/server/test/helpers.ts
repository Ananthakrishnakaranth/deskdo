import bcrypt from "bcryptjs";
import type { AddressInfo } from "node:net";
import {
  createHttpTransport, SyncEngine, type LiveHandlers, type LocalSnapshot, type LocalStore, type Op, type SyncTransport, type TodoItem,
} from "@deskdo/shared";
import { createApp, type App } from "../src/app";
import type { Config } from "../src/config";
import { createPool, migrate, type Db } from "../src/db";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://deskdo:deskdo@localhost:5432/deskdo_test";
export const EMAIL = "me@example.com";
export const PASSWORD = "correct horse battery staple";

export interface Harness {
  app: App;
  db: Db;
  baseUrl: string;
  cfg: Config;
  stop(): Promise<void>;
}

export async function startServer(): Promise<Harness> {
  const cfg: Config = {
    databaseUrl: TEST_DB,
    databaseSsl: false,
    accountEmail: EMAIL,
    accountPasswordHash: await bcrypt.hash(PASSWORD, 4),
    jwtSecret: "test-secret-test-secret-test-secret-123",
    tokenTtlDays: 1,
    port: 0,
    staticDir: null,
    allowedOrigins: [],
    cookieSecure: false,
  };
  const db = createPool(cfg.databaseUrl, false);
  await migrate(db);
  const app = createApp(cfg, db);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const { port } = app.server.address() as AddressInfo;
  return {
    app, db, cfg, baseUrl: `http://127.0.0.1:${port}`,
    async stop() { await app.close(); await db.end(); },
  };
}

export async function resetDb(db: Db): Promise<void> {
  await db.query("TRUNCATE todos, processed_ops");
  await db.query("UPDATE server_meta SET value = 0 WHERE key = 'purged_through_seq'");
}

export async function login(baseUrl: string, deviceId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, deviceId, mode: "bearer" }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

export class MemStore implements LocalStore {
  constructor(public snap: LocalSnapshot) {}
  async load() { return structuredClone(this.snap); }
  async saveItems(items: TodoItem[], cursor: number) { this.snap = { ...this.snap, items: structuredClone(items), cursor }; }
  async saveOutbox(ops: Op[]) { this.snap = { ...this.snap, outbox: structuredClone(ops) }; }
}

/**
 * Wraps a real transport with a "Wi-Fi switch". Offline: requests fail like a dropped network and
 * the live socket reports closed. `loseNextPushResponse` lets the request reach the server but
 * throws away the reply — the classic cause of duplicate replays.
 */
export class Network {
  online = true;
  loseNextPushResponse = false;
  private lives = new Set<{ inner: { close(): void }; h: LiveHandlers }>();

  wrap(inner: SyncTransport): SyncTransport {
    const net = this;
    const offlineErr = () => new TypeError("fetch failed (simulated offline)");
    return {
      async push(req) {
        if (!net.online) throw offlineErr();
        const res = await inner.push(req);
        if (net.loseNextPushResponse) {
          net.loseNextPushResponse = false;
          net.setOnline(false);
          throw offlineErr();
        }
        return res;
      },
      async pull(since) {
        if (!net.online) throw offlineErr();
        return inner.pull(since);
      },
      openLive(h) {
        if (!net.online) {
          setTimeout(() => h.onClose({ unauthorized: false }), 0);
          return { close() {} };
        }
        const entry = { inner: inner.openLive(h), h };
        net.lives.add(entry);
        return { close() { net.lives.delete(entry); entry.inner.close(); } };
      },
    };
  }

  setOnline(on: boolean): void {
    this.online = on;
    if (!on) {
      for (const l of this.lives) {
        l.inner.close();
        l.h.onClose({ unauthorized: false });
      }
      this.lives.clear();
    }
  }
}

export interface Device {
  engine: SyncEngine;
  net: Network;
  store: MemStore;
  id: string;
  texts(): string[];
}

export async function device(h: Harness, id: string): Promise<Device> {
  const token = await login(h.baseUrl, id);
  const store = new MemStore({ deviceId: id, items: [], outbox: [], cursor: 0 });
  const engine = new SyncEngine(store, { minBackoffMs: 20, maxBackoffMs: 100 });
  await engine.init();
  const net = new Network();
  engine.setTransport(net.wrap(createHttpTransport({ baseUrl: h.baseUrl, getToken: async () => token })));
  await waitFor(() => engine.getState().status === "online", 3000, `${id} online`);
  return { engine, net, store, id, texts: () => engine.getState().items.map((i) => i.text) };
}

export async function goOnline(d: Device): Promise<void> {
  d.net.setOnline(true);
  d.engine.kick();
  await waitFor(() => d.engine.getState().status === "online", 3000, `${d.id} back online`);
}

export async function waitFor(pred: () => boolean, timeoutMs = 2000, what = "condition"): Promise<number> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return performance.now() - start;
}

export async function settled(...ds: Device[]): Promise<void> {
  await waitFor(() => ds.every((d) => d.engine.getState().pendingCount === 0), 3000, "outboxes drained");
}
