import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Op, TodoItem } from "@deskdo/shared";
import { LocalDb } from "../src/main/localdb";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = mkdtempSync(join(tmpdir(), "deskdo-")); dirs.push(d); return join(d, "t.sqlite"); };

describe("LocalDb (desktop SQLite)", () => {
  it("persists items, outbox order, cursor and a stable device id across reopen", () => {
    const f = file();
    const a = new LocalDb(f);
    const id1 = a.load().deviceId;
    const item: TodoItem = { id: "i1", text: "x", done: false, position: 1, updatedAt: "t", deleted: false, lastDeviceId: "d", seq: 4 };
    const ops: Op[] = [
      { type: "create", opId: "o1", itemId: "i2", text: "y", done: false, position: 2, clientTime: 0 },
      { type: "delete", opId: "o2", itemId: "i1", clientTime: 0 },
    ];
    a.saveItems([item], 4);
    a.saveOutbox(ops);
    a.setMeta("bounds", JSON.stringify({ x: 1, y: 2, width: 300, height: 400 }));
    a.close();
    const b = new LocalDb(f);
    const snap = b.load();
    expect(snap).toEqual({ deviceId: id1, items: [item], outbox: ops, cursor: 4 });
    expect(JSON.parse(b.getMeta("bounds")!)).toEqual({ x: 1, y: 2, width: 300, height: 400 });
    b.clearSyncData();
    expect(b.load()).toMatchObject({ deviceId: id1, items: [], outbox: [], cursor: 0 });
    b.close();
  });
});
