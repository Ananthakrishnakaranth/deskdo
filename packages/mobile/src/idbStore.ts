import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { LocalSnapshot, LocalStore, Op, TodoItem } from "@deskdo/shared";

interface Schema extends DBSchema {
  items: { key: string; value: TodoItem };
  outbox: { key: number; value: Op };
  meta: { key: string; value: string | number };
}

/** IndexedDB-backed cache + outbox for the PWA. */
export class IdbStore implements LocalStore {
  private constructor(private readonly db: IDBPDatabase<Schema>) {}

  static async open(name = "deskdo"): Promise<IdbStore> {
    const db = await openDB<Schema>(name, 1, {
      upgrade(db) {
        db.createObjectStore("items");
        db.createObjectStore("outbox");
        db.createObjectStore("meta");
      },
    });
    // Ask the browser not to evict our data under storage pressure (best effort; iOS may ignore).
    void navigator.storage?.persist?.().catch(() => undefined);
    return new IdbStore(db);
  }

  async load(): Promise<LocalSnapshot> {
    const tx = this.db.transaction(["items", "outbox", "meta"], "readwrite");
    let deviceId = (await tx.objectStore("meta").get("deviceId")) as string | undefined;
    if (!deviceId) {
      deviceId = `web-${crypto.randomUUID()}`;
      await tx.objectStore("meta").put(deviceId, "deviceId");
    }
    const [items, outbox, cursor] = await Promise.all([
      tx.objectStore("items").getAll(),
      tx.objectStore("outbox").getAll(), // keys are 0..n-1, so getAll() returns them in order
      tx.objectStore("meta").get("cursor"),
    ]);
    await tx.done;
    return { deviceId, items, outbox, cursor: typeof cursor === "number" ? cursor : 0 };
  }

  async saveItems(items: TodoItem[], cursor: number): Promise<void> {
    const tx = this.db.transaction(["items", "meta"], "readwrite");
    const store = tx.objectStore("items");
    await store.clear();
    await Promise.all(items.map((i) => store.put(i, i.id)));
    await tx.objectStore("meta").put(cursor, "cursor");
    await tx.done;
  }

  async saveOutbox(ops: Op[]): Promise<void> {
    // Clear + rewrite in a single transaction: either the old or the new outbox survives a crash.
    const tx = this.db.transaction("outbox", "readwrite");
    await tx.store.clear();
    await Promise.all(ops.map((op, i) => tx.store.put(op, i)));
    await tx.done;
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction(["items", "outbox", "meta"], "readwrite");
    await Promise.all([tx.objectStore("items").clear(), tx.objectStore("outbox").clear(), tx.objectStore("meta").delete("cursor")]);
    await tx.done;
  }
}
