import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EMAIL, PASSWORD, login, resetDb, startServer, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => { h = await startServer(); });
afterAll(async () => { await h.stop(); });
beforeEach(async () => { await resetDb(h.db); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(h.baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("auth", () => {
  it("rejects requests without a valid token", async () => {
    expect((await fetch(`${h.baseUrl}/api/changes?since=0`)).status).toBe(401);
    expect((await fetch(`${h.baseUrl}/api/changes?since=0`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("rejects a wrong password / email", async () => {
    expect((await post("/api/login", { email: EMAIL, password: "wrong", deviceId: "d1", mode: "bearer" })).status).toBe(401);
    expect((await post("/api/login", { email: "x@y.z", password: PASSWORD, deviceId: "d1", mode: "bearer" })).status).toBe(401);
  });

  it("cookie mode sets an httpOnly SameSite=Strict cookie and never returns the token", async () => {
    const res = await post("/api/login", { email: EMAIL, password: PASSWORD, deviceId: "pwa", mode: "cookie" });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("token");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const session = cookie.split(";")[0]!;
    expect((await fetch(`${h.baseUrl}/api/session`, { headers: { Cookie: session } })).status).toBe(200);
    // Same cookie from a foreign origin is refused.
    expect((await fetch(`${h.baseUrl}/api/session`, { headers: { Cookie: session, Origin: "https://evil.example" } })).status).toBe(403);
  });

  it("handoff turns a bearer token into a cookie session (Android app → in-app PWA)", async () => {
    const token = await login(h.baseUrl, "android-1");
    const res = await fetch(`${h.baseUrl}/api/handoff`, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const session = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${h.baseUrl}/api/session`, { headers: { Cookie: session } })).status).toBe(200);
    // Without a bearer header (e.g. a link from another site) it does nothing.
    expect((await fetch(`${h.baseUrl}/api/handoff`, { redirect: "manual" })).status).toBe(401);
    expect((await fetch(`${h.baseUrl}/api/handoff`, { headers: { Cookie: session }, redirect: "manual" })).status).toBe(401);
  });

  it("WebSocket without auth is closed with 4401", async () => {
    const ws = new WebSocket(h.baseUrl.replace("http", "ws") + "/ws");
    const code = await new Promise<number>((r) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: "bad" }));
      ws.onclose = (e) => r(e.code);
    });
    expect(code).toBe(4401);
  });
});

describe("validation", () => {
  it("rejects malformed ops with 400 and applies nothing", async () => {
    const token = await login(h.baseUrl, "d1");
    const auth = { Authorization: `Bearer ${token}` };
    const bad = [
      { type: "create", opId: "not-a-uuid", itemId: randomUUID(), text: "x", position: 1 },
      { type: "create", opId: randomUUID(), itemId: randomUUID(), text: "   ", position: 1 },
      { type: "update", opId: randomUUID(), itemId: randomUUID(), patch: {} },
      { type: "create", opId: randomUUID(), itemId: randomUUID(), text: "x", position: "NaN" },
      { type: "drop-table", opId: randomUUID(), itemId: randomUUID() },
    ];
    for (const op of bad) expect((await post("/api/ops", { deviceId: "d1", ops: [op] }, auth)).status).toBe(400);
    expect((await h.db.query("SELECT count(*)::int n FROM todos")).rows[0].n).toBe(0);
  });

  it("is idempotent for an exact replay of a batch", async () => {
    const token = await login(h.baseUrl, "d1");
    const auth = { Authorization: `Bearer ${token}` };
    const body = { deviceId: "d1", ops: [{ type: "create", opId: randomUUID(), itemId: randomUUID(), text: "x", done: false, position: 1, clientTime: 0 }] };
    const r1 = await (await post("/api/ops", body, auth)).json();
    const r2 = await (await post("/api/ops", body, auth)).json();
    expect(r1.results[0].status).toBe("applied");
    expect(r2.results[0].status).toBe("duplicate");
    expect((await h.db.query("SELECT count(*)::int n FROM todos")).rows[0].n).toBe(1);
  });

  it("server timestamps strictly increase", async () => {
    const token = await login(h.baseUrl, "d1");
    const auth = { Authorization: `Bearer ${token}` };
    // 20 writes in one transaction: each must still get its own, strictly later, server time.
    const ops = Array.from({ length: 20 }, (_, i) => ({ type: "create", opId: randomUUID(), itemId: randomUUID(), text: `t${i}`, done: true, position: i }));
    await post("/api/ops", { deviceId: "d1", ops }, auth);
    const { rows } = await h.db.query("SELECT extract(epoch from updated_at)::numeric * 1000000 AS us FROM todos ORDER BY seq");
    expect(rows).toHaveLength(20);
    for (let i = 1; i < rows.length; i++) expect(Number(rows[i].us)).toBeGreaterThan(Number(rows[i - 1].us));
  });
});
