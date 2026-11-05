import { describe, expect, it } from "vitest";
import { LIMIT_MESSAGE, SyncEngine, type LocalSnapshot, type LocalStore } from "../src/sync/engine";
import { MAX_ACTIVE_ITEMS, type Op, type TodoItem } from "../src/types";

class MemStore implements LocalStore {
  snap: LocalSnapshot = { deviceId: "dev-1", items: [], outbox: [], cursor: 0 };
  async load() { return structuredClone(this.snap); }
  async saveItems(items: TodoItem[], cursor: number) { this.snap.items = items; this.snap.cursor = cursor; }
  async saveOutbox(ops: Op[]) { this.snap.outbox = ops; }
}

async function engine() {
  const store = new MemStore();
  const e = new SyncEngine(store);
  await e.init();
  return { e, store };
}

describe("SyncEngine (local-only)", () => {
  it("adds, edits, checks, reorders and deletes; persists the outbox", async () => {
    const { e, store } = await engine();
    e.add("one"); e.add("two"); e.add("three");
    let items = e.getState().items;
    expect(items.map((i) => i.text)).toEqual(["one", "two", "three"]);
    e.edit(items[0]!.id, "  first   task ");
    e.setDone(items[1]!.id, true);
    e.move(2, 0);
    items = e.getState().items;
    expect(items.map((i) => i.text)).toEqual(["three", "first task", "two"]);
    expect(items[2]!.done).toBe(true);
    e.clearCompleted();
    expect(e.getState().items.map((i) => i.text)).toEqual(["three", "first task"]);
    await e.whenPersisted();
    // Compaction: 3 creates, later edits folded in, the cleared one removed entirely.
    expect(store.snap.outbox).toHaveLength(2);

    // Reload from storage == same view.
    const e2 = new SyncEngine(store);
    await e2.init();
    expect(e2.getState().items.map((i) => i.text)).toEqual(["three", "first task"]);
  });

  it(`blocks the ${MAX_ACTIVE_ITEMS + 1}th active item and un-checking past the limit`, async () => {
    const { e } = await engine();
    for (let i = 0; i < MAX_ACTIVE_ITEMS; i++) expect(e.add(`t${i}`).ok).toBe(true);
    const r = e.add("one too many");
    expect(r).toEqual({ ok: false, error: LIMIT_MESSAGE });
    expect(e.getState().error).toBe(LIMIT_MESSAGE);
    expect(e.getState().items).toHaveLength(MAX_ACTIVE_ITEMS);
    // Completing one frees a slot; un-checking it again while full is blocked.
    const first = e.getState().items[0]!;
    e.setDone(first.id, true);
    expect(e.add("now fits").ok).toBe(true);
    expect(e.setDone(first.id, false).ok).toBe(false);
  });

  it("rejects empty text and keeps the old value on an empty edit", async () => {
    const { e } = await engine();
    expect(e.add("   ").ok).toBe(false);
    e.add("x");
    const id = e.getState().items[0]!.id;
    expect(e.edit(id, "").ok).toBe(false);
    expect(e.getState().items[0]!.text).toBe("x");
  });

  it("renumbers positions when midpoints run out of precision", async () => {
    const { e } = await engine();
    e.add("a"); e.add("b"); e.add("c");
    // Repeatedly move the last row to index 1: halves the gap each time.
    for (let i = 0; i < 80; i++) e.move(2, 1);
    const pos = e.getState().items.map((i) => i.position);
    expect(new Set(pos).size).toBe(3);
    for (let i = 1; i < pos.length; i++) expect(pos[i]! - pos[i - 1]!).toBeGreaterThan(1e-9);
  });
});
