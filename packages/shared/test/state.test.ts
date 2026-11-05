import { describe, expect, it } from "vitest";
import { compareItems, positionForMove } from "../src/ordering";
import { deriveItems, enqueueOp, mergeServerItems } from "../src/sync/state";
import type { CreateOp, DeleteOp, Op, TodoItem, UpdateOp } from "../src/types";

const item = (id: string, over: Partial<TodoItem> = {}): TodoItem => ({
  id, text: id, done: false, position: 1, updatedAt: "2026-01-01T00:00:00.000Z", deleted: false, lastDeviceId: "srv", seq: 1, ...over,
});
let n = 0;
const create = (itemId: string, text = itemId, position = 1): CreateOp => ({ type: "create", opId: `c${++n}`, itemId, text, done: false, position, clientTime: 0 });
const update = (itemId: string, patch: UpdateOp["patch"]): UpdateOp => ({ type: "update", opId: `u${++n}`, itemId, patch, clientTime: 0 });
const del = (itemId: string): DeleteOp => ({ type: "delete", opId: `d${++n}`, itemId, clientTime: 0 });
const none = new Set<string>();

describe("mergeServerItems", () => {
  it("accepts newer seq, ignores older or equal seq (idempotent, order independent)", () => {
    const a1 = item("a", { text: "v1", seq: 5 });
    const a2 = item("a", { text: "v2", seq: 9 });
    const s1 = mergeServerItems({}, [a2, a1]).items;
    const s2 = mergeServerItems(mergeServerItems({}, [a1]).items, [a2]).items;
    expect(s1.a!.text).toBe("v2");
    expect(s2.a!.text).toBe("v2");
    const again = mergeServerItems(s1, [a2, a1]);
    expect(again.changed).toBe(false);
    expect(again.items).toBe(s1);
  });
});

describe("deriveItems", () => {
  it("overlays pending ops on confirmed state and hides tombstones", () => {
    const confirmed = { a: item("a", { position: 1 }), b: item("b", { position: 2 }), c: item("c", { position: 3, deleted: true }) };
    const out = deriveItems(confirmed, [update("a", { text: "edited" }), del("b"), create("d", "new", 4)], "dev");
    expect(out.map((i) => [i.id, i.text])).toEqual([["a", "edited"], ["d", "new"]]);
  });

  it("never resurrects a deleted item through a pending edit", () => {
    const out = deriveItems({ a: item("a", { deleted: true }) }, [update("a", { text: "late" })], "dev");
    expect(out).toEqual([]);
  });

  it("server state wins over a replayed create", () => {
    const out = deriveItems({ a: item("a", { text: "server" }) }, [create("a", "local")], "dev");
    expect(out[0]!.text).toBe("server");
  });

  it("orders by position then id", () => {
    const out = deriveItems({ b: item("b", { position: 1 }), a: item("a", { position: 1 }), c: item("c", { position: 0.5 }) }, [], "d");
    expect(out.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });
});

describe("enqueueOp (outbox compaction)", () => {
  it("folds updates into an unsent create", () => {
    const c = create("a", "x");
    const out = enqueueOp(enqueueOp([c], update("a", { text: "y" }), none), update("a", { done: true }), none);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "create", opId: c.opId, text: "y", done: true });
  });

  it("merges consecutive unsent updates, later fields win", () => {
    const out = enqueueOp([update("a", { text: "1", done: true })], update("a", { text: "2" }), none);
    expect(out).toHaveLength(1);
    expect((out[0] as UpdateOp).patch).toEqual({ text: "2", done: true });
  });

  it("does not touch ops that are already in flight", () => {
    const u = update("a", { text: "1" });
    const out = enqueueOp([u], update("a", { text: "2" }), new Set([u.opId]));
    expect(out).toHaveLength(2);
    expect((out[0] as UpdateOp).patch.text).toBe("1");
  });

  it("delete of a never-sent item removes it from the outbox entirely", () => {
    const out = enqueueOp([create("a"), update("a", { text: "z" }), create("b")], del("a"), none);
    expect(out.map((o) => o.itemId)).toEqual(["b"]);
  });

  it("delete of an item whose create is in flight is kept", () => {
    const c = create("a");
    const out = enqueueOp([c, update("a", { text: "z" })], del("a"), new Set([c.opId]));
    expect(out.map((o) => o.type)).toEqual(["create", "delete"]);
  });

  it("delete of a server-side item replaces its pending updates", () => {
    const out = enqueueOp([update("a", { text: "z" })], del("a"), none);
    expect(out.map((o: Op) => o.type)).toEqual(["delete"]);
  });

  it("keeps ops for other items in order", () => {
    const ops = [update("a", { text: "1" }), update("b", { text: "1" })];
    const out = enqueueOp(ops, update("a", { text: "2" }), none);
    expect(out.map((o) => [o.itemId, (o as UpdateOp).patch.text])).toEqual([["a", "2"], ["b", "1"]]);
  });
});

describe("ordering", () => {
  const rows = [{ position: 1 }, { position: 2 }, { position: 3 }, { position: 4 }];
  it("moves to the middle using the midpoint of the new neighbours", () => {
    expect(positionForMove(rows, 0, 2)).toBe(3.5); // between 3 and 4
    expect(positionForMove(rows, 3, 0)).toBe(0);
    expect(positionForMove(rows, 0, 3)).toBe(5);
    expect(positionForMove(rows, 3, 1)).toBe(1.5);
  });
  it("compareItems breaks ties by id", () => {
    expect(compareItems({ id: "a", position: 1 }, { id: "b", position: 1 })).toBeLessThan(0);
  });
});
