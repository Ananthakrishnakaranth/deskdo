import { createServer, Socket, type Server } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpTransport, SyncEngine } from "@deskdo/shared";
import { device, login, MemStore, resetDb, startServer, waitFor, type Device, type Harness } from "./helpers";

/**
 * A TCP relay that can "black-hole" traffic: connections stay open but nothing gets through, which
 * is what a laptop sees after sleep or a Wi-Fi switch (stale sockets, hung requests), and what
 * left the real desktop widget stuck on "connecting" before requests had timeouts and a watchdog.
 */
class Relay {
  server!: Server;
  port = 0;
  blackhole = false;
  private pairs = new Set<{ a: Socket; b: Socket }>();
  constructor(private targetPort: number) {}
  async start() {
    this.server = createServer((a) => {
      const b = new Socket();
      b.connect(this.targetPort, "127.0.0.1");
      const pair = { a, b };
      this.pairs.add(pair);
      const forward = (from: Socket, to: Socket) => from.on("data", (d) => { if (!this.blackhole) to.write(d); });
      forward(a, b);
      forward(b, a);
      const end = () => { a.destroy(); b.destroy(); this.pairs.delete(pair); };
      a.on("close", end); b.on("close", end); a.on("error", end); b.on("error", end);
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as { port: number }).port;
  }
  /** Turn the black hole off. Existing connections stay dead (like stale sockets after sleep). */
  restore() {
    this.blackhole = false;
    for (const { a, b } of this.pairs) { a.pause(); b.pause(); } // never deliver again
    this.pairs.clear();
  }
  async stop() {
    for (const { a, b } of this.pairs) { a.destroy(); b.destroy(); }
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

let h: Harness;
let relay: Relay;
const engines: SyncEngine[] = [];
const devices: Device[] = [];
beforeAll(async () => {
  h = await startServer({ pingIntervalMs: 300 });
  relay = new Relay(Number(new URL(h.baseUrl).port));
  await relay.start();
});
afterAll(async () => { await relay.stop(); await h.stop(); });
beforeEach(async () => { await resetDb(h.db); relay.blackhole = false; });
afterEach(() => { engines.splice(0).forEach((e) => e.dispose()); devices.splice(0).forEach((d) => d.engine.dispose()); });

async function laptopBehindRelay(): Promise<SyncEngine> {
  const token = await login(h.baseUrl, "laptop");
  const engine = new SyncEngine(new MemStore({ deviceId: "laptop", items: [], outbox: [], cursor: 0 }), {
    minBackoffMs: 20, maxBackoffMs: 200, pollIntervalMs: 200, watchdogIntervalMs: 200, watchdogResetMs: 1500,
  });
  await engine.init();
  engine.setTransport(createHttpTransport({
    baseUrl: `http://127.0.0.1:${relay.port}`, getToken: async () => token,
    requestTimeoutMs: 600, connectTimeoutMs: 600, idleTimeoutMs: 1000,
  }));
  engines.push(engine);
  await waitFor(() => engine.getState().status === "online", 3000, "laptop online");
  return engine;
}
const texts = (e: SyncEngine) => e.getState().items.map((i) => i.text);

describe("network silently stops passing data (laptop sleep, Wi-Fi switch)", () => {
  it("recovers by itself, with no kick, and syncs both ways afterwards", async () => {
    const laptop = await laptopBehindRelay();
    const phone = await device(h, "phone");
    devices.push(phone);
    phone.engine.add("before");
    await waitFor(() => texts(laptop).includes("before"), 2000, "before");

    relay.blackhole = true;
    phone.engine.add("during outage");
    laptop.add("laptop offline edit");
    await waitFor(() => laptop.getState().status !== "online", 5000, "laptop notices the outage");
    expect(laptop.getState().syncError).toBeTruthy(); // the reason is shown to the user
    expect(texts(laptop)).not.toContain("during outage");

    relay.restore(); // no kick(): only timeouts, retries and the watchdog may bring it back
    await waitFor(() => texts(laptop).includes("during outage"), 8000, "laptop catches up by itself");
    await waitFor(() => phone.texts().includes("laptop offline edit"), 3000, "laptop's offline edit reaches phone");
    await waitFor(() => laptop.getState().status === "online", 3000, "laptop back online");
    expect(laptop.getState().syncError).toBeNull();

    phone.engine.add("after");
    await waitFor(() => texts(laptop).includes("after"), 2000, "live again");
  });

  it("an HTTP request that never answers is abandoned with a clear reason", async () => {
    const token = await login(h.baseUrl, "x");
    relay.blackhole = true;
    const t = createHttpTransport({ baseUrl: `http://127.0.0.1:${relay.port}`, getToken: async () => token, requestTimeoutMs: 300 });
    const started = Date.now();
    await expect(t.pull(0)).rejects.toThrow(/No answer from the server/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
