import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { LocalSnapshot, Op, TodoItem } from "@deskdo/shared";

/**
 * SQLite cache + outbox + settings for the desktop app, in %APPDATA%\DeskDo\deskdo.sqlite.
 *
 * Uses Node's built-in SQLite (bundled with Electron's Node 24), so there is no native module to
 * compile on Windows. WAL + synchronous=NORMAL: survives app crashes, fast enough to write on
 * every change.
 */
export class LocalDb {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (idx INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  load(): LocalSnapshot {
    let deviceId = this.getMeta("deviceId");
    if (!deviceId) {
      deviceId = `desktop-${randomUUID()}`;
      this.setMeta("deviceId", deviceId);
    }
    const items = (this.db.prepare("SELECT json FROM items").all() as { json: string }[]).map((r) => JSON.parse(r.json) as TodoItem);
    const outbox = (this.db.prepare("SELECT json FROM outbox ORDER BY idx").all() as { json: string }[]).map((r) => JSON.parse(r.json) as Op);
    return { deviceId, items, outbox, cursor: Number(this.getMeta("cursor") ?? 0) };
  }

  saveItems(items: TodoItem[], cursor: number): void {
    const ins = this.db.prepare("INSERT INTO items (id, json) VALUES (?, ?)");
    this.tx(() => {
      this.db.exec("DELETE FROM items");
      for (const i of items) ins.run(i.id, JSON.stringify(i));
      this.setMeta("cursor", String(cursor));
    });
  }

  saveOutbox(ops: Op[]): void {
    const ins = this.db.prepare("INSERT INTO outbox (idx, json) VALUES (?, ?)");
    this.tx(() => {
      this.db.exec("DELETE FROM outbox");
      ops.forEach((op, i) => ins.run(i, JSON.stringify(op)));
    });
  }

  clearSyncData(): void {
    this.tx(() => {
      this.db.exec("DELETE FROM items; DELETE FROM outbox;");
      this.deleteMeta("cursor");
    });
  }

  close(): void {
    this.db.close();
  }
}
