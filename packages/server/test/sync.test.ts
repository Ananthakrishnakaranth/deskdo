import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LIMIT_MESSAGE, MAX_ACTIVE_ITEMS, type TodoItem } from "@deskdo/shared";
import { purgeOld } from "../src/ops";
import { device, goOnline, resetDb, settled, startServer, waitFor, type Device, type Harness } from "./helpers";

let h: Harness;
const devices: Device[] = [];
beforeAll(async () => { h = await startServer(); });
afterAll(async () => { await h.stop(); });
beforeEach(async () => { await resetDb(h.db); });
afterEach(() => { for (const d of devices.splice(0)) d.engine.dispose(); });

async function two(): Promise<[Device, Device]> {
  const a = await device(h, "laptop");
  const b = await device(h, "phone");
  devices.push(a, b);
  return [a, b];
}
const find = (d: Device, text: string): TodoItem | undefined => d.engine.getState().items.find((i) => i.text === text);
async function dbRows(): Promise<{ text: string; done: boolean; deleted: boolean }[]> {
  return (await h.db.query("SELECT text, done, deleted FROM todos ORDER BY position, id")).rows;
}

describe("live sync between two devices", () => {
  for (const [from, to] of [["laptop", "phone"], ["phone", "laptop"]] as const) {
    it(`add, edit, check, reorder, delete on ${from} reach ${to} in < 2 s`, async () => {
      const [a, b] = await two();
      const [src, dst] = from === "laptop" ? [a, b] : [b, a];
      const latencies: number[] = [];

      src.engine.add("buy milk");
      latencies.push(await waitFor(() => !!find(dst, "buy milk"), 2000, "add"));
      src.engine.add("call mum");
      latencies.push(await waitFor(() => dst.texts().join() === "buy milk,call mum", 2000, "add 2"));

      const id = find(src, "buy milk")!.id;
      src.engine.edit(id, "buy oat milk");
      latencies.push(await waitFor(() => !!find(dst, "buy oat milk"), 2000, "edit"));

      src.engine.setDone(id, true);
      latencies.push(await waitFor(() => find(dst, "buy oat milk")?.done === true, 2000, "check"));

      src.engine.move(1, 0);
      latencies.push(await waitFor(() => dst.texts().join() === "call mum,buy oat milk", 2000, "reorder"));

      src.engine.remove(id);
      latencies.push(await waitFor(() => !find(dst, "buy oat milk"), 2000, "delete"));

      expect(Math.max(...latencies)).toBeLessThan(2000);
      expect(dst.texts()).toEqual(src.texts());
      console.log(`${from} -> ${to} latencies (ms):`, latencies.map((l) => Math.round(l)).join(", "));
    });
  }

  it("clear completed propagates", async () => {
    const [a, b] = await two();
    a.engine.add("x"); a.engine.add("y"); a.engine.add("z");
    await waitFor(() => b.texts().length === 3);
    for (const t of ["x", "z"]) b.engine.setDone(find(b, t)!.id, true);
    await waitFor(() => a.engine.getState().items.filter((i) => i.done).length === 2);
    a.engine.clearCompleted();
    await waitFor(() => b.texts().join() === "y");
  });
});

describe("offline outbox", () => {
  it("phone offline: 3 edits replayed once, no duplicates", async () => {
    const [laptop, phone] = await two();
    laptop.engine.add("existing");
    await waitFor(() => !!find(phone, "existing"));

    phone.net.setOnline(false);
    await waitFor(() => phone.engine.getState().status === "offline");
    phone.engine.add("offline one");
    phone.engine.edit(find(phone, "existing")!.id, "existing (edited offline)");
    phone.engine.add("offline two");
    expect(phone.engine.getState().pendingCount).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200)); // several failed reconnect attempts happen here
    expect(laptop.texts()).toEqual(["existing"]);

    await goOnline(phone);
    await waitFor(() => laptop.texts().length === 3, 2000, "laptop sees offline edits");
    await settled(laptop, phone);
    expect(laptop.texts()).toEqual(["existing (edited offline)", "offline one", "offline two"]);
    expect(phone.texts()).toEqual(laptop.texts());
    expect((await dbRows()).map((r) => r.text)).toEqual(laptop.texts()); // exactly once in the DB
  });

  it("lost push response: the outbox replay is deduplicated by opId", async () => {
    const [laptop, phone] = await two();
    phone.net.loseNextPushResponse = true;
    phone.engine.add("only once");
    await waitFor(() => phone.engine.getState().status === "offline");
    expect(phone.engine.getState().pendingCount).toBe(1); // phone doesn't know the server got it
    await goOnline(phone);
    await settled(phone);
    await waitFor(() => laptop.texts().length === 1);
    const rows = await dbRows();
    expect(rows).toHaveLength(1);
    expect(phone.texts()).toEqual(["only once"]);
    const statuses = (await h.db.query("SELECT status FROM processed_ops")).rows.map((r) => r.status);
    expect(statuses).toEqual(["applied"]);
  });

  it("both offline, both edit, both reconnect: converge", async () => {
    const [a, b] = await two();
    a.engine.add("shared");
    await waitFor(() => !!find(b, "shared"));
    a.net.setOnline(false); b.net.setOnline(false);
    a.engine.edit(find(a, "shared")!.id, "from laptop");
    b.engine.setDone(find(b, "shared")!.id, true);
    a.engine.add("laptop new");
    b.engine.add("phone new");
    await goOnline(a);
    await goOnline(b);
    await settled(a, b);
    await waitFor(() => a.texts().length === 3 && b.texts().length === 3);
    expect(a.engine.getState().items).toEqual(b.engine.getState().items);
    // Different fields of the same item merged: text from laptop, done from phone.
    expect(find(a, "from laptop")?.done).toBe(true);
  });
});

describe("conflict rules", () => {
  it("same item edited on both devices at the same moment: both end with the same text", async () => {
    const [a, b] = await two();
    a.engine.add("draft");
    await waitFor(() => !!find(b, "draft"));
    const id = find(a, "draft")!.id;
    for (let round = 0; round < 10; round++) {
      a.engine.edit(id, `laptop ${round}`);
      b.engine.edit(id, `phone ${round}`);
      await settled(a, b);
      await waitFor(() => a.engine.getState().items[0]!.text === b.engine.getState().items[0]!.text, 2000, "converge");
      const server = (await dbRows())[0]!.text;
      expect(a.engine.getState().items[0]!.text).toBe(server);
      expect(b.engine.getState().items[0]!.text).toBe(server);
    }
  });

  it("last write by server time wins", async () => {
    const [a, b] = await two();
    a.engine.add("t");
    await waitFor(() => !!find(b, "t"));
    const id = find(a, "t")!.id;
    a.net.setOnline(false);
    a.engine.edit(id, "older (made first, offline)");
    b.engine.edit(id, "newer on server? no - arrives first");
    await settled(b);
    await goOnline(a); // A's edit reaches the server last, so it wins
    await settled(a);
    await waitFor(() => b.texts()[0] === "older (made first, offline)");
    expect(a.texts()).toEqual(b.texts());
  });

  it("a delete beats an edit, even one that reaches the server later", async () => {
    const [a, b] = await two();
    a.engine.add("doomed");
    await waitFor(() => !!find(b, "doomed"));
    const id = find(a, "doomed")!.id;
    a.net.setOnline(false);
    a.engine.edit(id, "edited while offline");
    b.engine.remove(id);
    await settled(b);
    await goOnline(a);
    await settled(a);
    await waitFor(() => a.texts().length === 0, 2000, "laptop sees delete");
    expect(b.texts()).toEqual([]);
    const row = (await h.db.query("SELECT text, deleted FROM todos WHERE id = $1", [id])).rows[0];
    expect(row).toEqual({ text: "doomed", deleted: true });
    const st = (await h.db.query("SELECT status FROM processed_ops WHERE item_id = $1 ORDER BY processed_at", [id])).rows.map((r) => r.status);
    expect(st).toEqual(["applied", "applied", "ignored"]);
  });

  it("edits to different items never conflict", async () => {
    const [a, b] = await two();
    a.engine.add("one"); a.engine.add("two");
    await waitFor(() => b.texts().length === 2);
    a.engine.edit(find(a, "one")!.id, "one (laptop)");
    b.engine.edit(find(b, "two")!.id, "two (phone)");
    await settled(a, b);
    await waitFor(() => a.texts().join() === "one (laptop),two (phone)" && b.texts().join() === a.texts().join());
  });

  it(`server enforces the ${MAX_ACTIVE_ITEMS}-item limit across offline devices`, async () => {
    const [a, b] = await two();
    a.net.setOnline(false); b.net.setOnline(false);
    for (let i = 0; i < 5; i++) { a.engine.add(`a${i}`); b.engine.add(`b${i}`); }
    await goOnline(a); await settled(a);
    await goOnline(b); await settled(b);
    await waitFor(() => a.texts().length === MAX_ACTIVE_ITEMS && b.texts().length === MAX_ACTIVE_ITEMS, 2000, `limit: a=${a.texts()} b=${b.texts()}`).catch((e) => {
      throw new Error(`${e.message} | a=${a.texts().join()} b=${b.texts().join()} bstatus=${b.engine.getState().status} bpending=${b.engine.getState().pendingCount}`);
    });
    expect(a.texts()).toEqual(b.texts());
    expect(b.engine.getState().error).toBe(LIMIT_MESSAGE);
    expect((await dbRows()).filter((r) => !r.deleted && !r.done)).toHaveLength(MAX_ACTIVE_ITEMS);
  });

  it("a fresh device with a stale cursor after a tombstone purge gets a full reset", async () => {
    const [a, b] = await two();
    a.engine.add("keep"); a.engine.add("gone");
    await waitFor(() => b.texts().length === 2);
    b.net.setOnline(false);
    a.engine.remove(find(a, "gone")!.id);
    await settled(a);
    await h.db.query("UPDATE todos SET updated_at = now() - interval '200 days' WHERE deleted");
    await purgeOld(h.db, 90);
    // b's cursor predates the purge; without a reset it would never learn "gone" was deleted.
    await goOnline(b);
    await waitFor(() => b.texts().join() === "keep", 2000, "reset");
  });
});
