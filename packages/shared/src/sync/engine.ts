import { MAX_ACTIVE_ITEMS, MAX_TEXT_LENGTH, type Op, type OpResult, type TodoItem, type TodoPatch } from "../types";
import { positionAtEnd, positionForMove } from "../ordering";
import { countActive, deriveItems, enqueueOp, mergeServerItems, type ItemMap } from "./state";
import { UnauthorizedError, type SyncTransport } from "./transport";

export interface LocalSnapshot {
  deviceId: string;
  items: TodoItem[];
  outbox: Op[];
  cursor: number;
}

/** Platform storage: SQLite (desktop, via IPC to the main process) or IndexedDB (PWA). */
export interface LocalStore {
  load(): Promise<LocalSnapshot>;
  saveItems(items: TodoItem[], cursor: number): Promise<void>;
  /** Replaces the whole outbox. It is tiny (≤ a few dozen ops after compaction), so this is fine. */
  saveOutbox(ops: Op[]): Promise<void>;
}

/** local = not signed in (everything stays in the outbox until you sign in). */
export type SyncStatus = "local" | "connecting" | "online" | "offline" | "unauthorized";

export interface EngineState {
  items: TodoItem[];
  pendingCount: number;
  status: SyncStatus;
  /** Last user-facing problem (limit reached, rejected op, ...). Cleared by `dismissError()`. */
  error: string | null;
}

export type CommandResult = { ok: true } | { ok: false; error: string };

export interface EngineOptions {
  newId?: () => string;
  now?: () => number;
  /** Reconnect backoff bounds (ms). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  pushBatchSize?: number;
}

export const LIMIT_MESSAGE = `List is full: at most ${MAX_ACTIVE_ITEMS} open tasks. Finish or delete one first.`;

/**
 * Client-side sync engine shared by the desktop widget and the PWA.
 *
 * Model: `confirmed` mirrors the server; `outbox` holds ops not yet acknowledged; the UI shows
 * `deriveItems(confirmed, outbox)`. Ops are pushed over HTTP; the server's answers and other devices'
 * changes arrive over the WebSocket (and in push responses). On every (re)connect the engine flushes
 * the outbox and then pulls everything since its cursor, so nothing is missed while offline.
 */
export class SyncEngine {
  private deviceId = "";
  private confirmed: ItemMap = {};
  private outbox: Op[] = [];
  private cursor = 0;
  private inFlight = new Set<string>();
  private status: SyncStatus = "local";
  private error: string | null = null;
  private view: TodoItem[] = [];
  private state!: EngineState;

  private transport: SyncTransport | null = null;
  private live: { close(): void } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private backoff: number;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private persistChain: Promise<void> = Promise.resolve();
  private listeners = new Set<(s: EngineState) => void>();
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly batchSize: number;

  constructor(private readonly store: LocalStore, opts: EngineOptions = {}) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => Date.now());
    this.minBackoff = opts.minBackoffMs ?? 1_000;
    this.maxBackoff = opts.maxBackoffMs ?? 30_000;
    this.batchSize = opts.pushBatchSize ?? 50;
    this.backoff = this.minBackoff;
    this.recompute();
  }

  async init(): Promise<void> {
    const snap = await this.store.load();
    this.deviceId = snap.deviceId;
    this.confirmed = Object.fromEntries(snap.items.map((i) => [i.id, i]));
    this.outbox = snap.outbox;
    this.cursor = snap.cursor;
    this.recompute();
  }

  getDeviceId(): string {
    return this.deviceId;
  }
  getState(): EngineState {
    return this.state;
  }
  subscribe(fn: (s: EngineState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  // ---------------------------------------------------------------- connection management

  /** Attach a transport (signed in) or detach it (`null`, signed out / local-only). */
  setTransport(t: SyncTransport | null): void {
    this.live?.close();
    this.live = null;
    clearTimeout(this.reconnectTimer);
    this.transport = t;
    this.backoff = this.minBackoff;
    if (!t) {
      this.setStatus("local");
      return;
    }
    this.connect();
  }

  /** Reconnect now (e.g. browser `online` event, app returned to foreground). */
  kick(): void {
    if (!this.transport || this.status === "unauthorized") return;
    if (this.live && this.status === "online") {
      void this.flush();
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.backoff = this.minBackoff;
    this.connect();
  }

  /** Signals the network is gone (browser `offline` event) so the UI updates immediately. */
  markOffline(): void {
    if (!this.transport || this.status === "unauthorized") return;
    this.live?.close();
    this.live = null;
    this.setStatus("offline");
    this.scheduleReconnect();
  }

  dispose(): void {
    this.live?.close();
    this.live = null;
    clearTimeout(this.reconnectTimer);
    this.transport = null;
    this.listeners.clear();
  }

  private connect(): void {
    const t = this.transport;
    if (!t) return;
    this.live?.close();
    this.setStatus("connecting");
    const conn = t.openLive({
      onOpen: () => {
        if (this.transport !== t) return;
        this.backoff = this.minBackoff;
        this.setStatus("online");
        // Replay the outbox first, then catch up on everything we missed.
        void this.flush().then(() => this.pull());
      },
      onMessage: (msg) => {
        if (this.transport !== t) return;
        // Broadcasts may arrive before the catch-up pull completes, so they never move the cursor.
        if (msg.type === "changes") this.receive(msg.items, null);
      },
      onClose: ({ unauthorized }) => {
        if (this.transport !== t || this.live !== conn) return;
        this.live = null;
        if (unauthorized) {
          this.setStatus("unauthorized");
          return;
        }
        this.setStatus("offline");
        this.scheduleReconnect();
      },
    });
    this.live = conn;
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    const delay = this.backoff * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async pull(): Promise<void> {
    const t = this.transport;
    if (!t) return;
    try {
      const res = await t.pull(this.cursor);
      if (this.transport !== t) return;
      if (res.reset) {
        this.confirmed = {};
        this.cursor = 0;
      }
      this.receive(res.items, res.cursor);
      if (res.reset) this.recompute();
    } catch (e) {
      this.handleTransportError(e);
    }
  }

  // ---------------------------------------------------------------- outbox flushing

  /** Push pending ops. Safe to call any time; concurrent calls coalesce into one loop. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = this.flushLoop().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushLoop(): Promise<void> {
    do {
      this.flushAgain = false;
      while (this.transport && this.status === "online" && this.outbox.length > 0) {
        const t = this.transport;
        const batch = this.outbox.slice(0, this.batchSize);
        for (const op of batch) this.inFlight.add(op.opId);
        try {
          const res = await t.push({ deviceId: this.deviceId, ops: batch });
          if (this.transport !== t) return;
          this.acknowledge(res.results, res.items, res.cursor);
        } catch (e) {
          this.handleTransportError(e);
          return;
        } finally {
          for (const op of batch) this.inFlight.delete(op.opId);
        }
      }
    } while (this.flushAgain && this.status === "online");
  }

  private acknowledge(results: OpResult[], items: TodoItem[], cursor: number): void {
    const done = new Set(results.map((r) => r.opId));
    const rejected = results.filter((r) => r.status === "rejected");
    // Server items go into `confirmed` *before* the ops leave the outbox, so the view never flickers
    // back to a stale value between the two steps.
    // Note: `cursor` is deliberately NOT adopted here. A push response only contains the items this
    // batch touched, so jumping the cursor to the server's latest seq would skip other devices'
    // changes we have not received yet. Only pull responses (complete since-cursor) move it.
    void cursor;
    this.mergeIntoConfirmed(items, null);
    this.outbox = this.outbox.filter((op) => !done.has(op.opId));
    if (rejected.length > 0) this.error = rejected[0]!.reason ?? "The server rejected a change.";
    this.persistOutbox();
    this.recompute();
  }

  private handleTransportError(e: unknown): void {
    if (e instanceof UnauthorizedError) {
      this.live?.close();
      this.live = null;
      this.setStatus("unauthorized");
      return;
    }
    // Network failure: drop to offline; the reconnect loop will flush again.
    if (this.status === "online") {
      this.live?.close();
      this.live = null;
      this.setStatus("offline");
      this.scheduleReconnect();
    }
  }

  // ---------------------------------------------------------------- incoming changes

  /** Merge server items. `cursor` is only passed for complete pull responses. */
  receive(items: TodoItem[], cursor: number | null): void {
    if (this.mergeIntoConfirmed(items, cursor)) this.recompute();
  }

  private mergeIntoConfirmed(items: TodoItem[], cursor: number | null): boolean {
    const { items: next, changed } = mergeServerItems(this.confirmed, items);
    const cursorMoved = cursor !== null && cursor > this.cursor;
    if (!changed && !cursorMoved) return false;
    this.confirmed = next;
    if (cursorMoved) this.cursor = cursor!;
    const snapshot = Object.values(next);
    const c = this.cursor;
    this.persistChain = this.persistChain.then(() => this.store.saveItems(snapshot, c)).catch(() => undefined);
    return changed;
  }

  // ---------------------------------------------------------------- user commands

  add(rawText: string): CommandResult {
    const text = normalise(rawText);
    if (!text) return this.fail("Task text can't be empty.");
    if (countActive(this.view) >= MAX_ACTIVE_ITEMS) return this.fail(LIMIT_MESSAGE);
    const itemId = this.newId();
    return this.enqueue({
      type: "create",
      opId: this.newId(),
      itemId,
      clientTime: this.now(),
      text,
      done: false,
      position: positionAtEnd(this.view),
    });
  }

  edit(id: string, rawText: string): CommandResult {
    const text = normalise(rawText);
    if (!text) return this.fail("Task text can't be empty.");
    const item = this.find(id);
    if (!item) return this.fail("That task no longer exists.");
    if (item.text === text) return { ok: true };
    return this.update(id, { text });
  }

  setDone(id: string, done: boolean): CommandResult {
    const item = this.find(id);
    if (!item) return this.fail("That task no longer exists.");
    if (item.done === done) return { ok: true };
    // Un-checking makes the item active again, so it counts against the limit.
    if (!done && countActive(this.view) >= MAX_ACTIVE_ITEMS) return this.fail(LIMIT_MESSAGE);
    return this.update(id, { done });
  }

  remove(id: string): CommandResult {
    if (!this.find(id)) return { ok: true };
    return this.enqueue({ type: "delete", opId: this.newId(), itemId: id, clientTime: this.now() });
  }

  clearCompleted(): CommandResult {
    for (const item of this.view.filter((i) => i.done)) this.remove(item.id);
    return { ok: true };
  }

  /** Move the row at `from` to index `to` (indices into `state.items`). */
  move(from: number, to: number): CommandResult {
    const ordered = this.view;
    const item = ordered[from];
    if (!item || from === to || to < 0 || to >= ordered.length) return { ok: true };
    const pos = positionForMove(ordered, from, to);
    const neighbours = ordered.filter((_, i) => i !== from);
    const tooTight = neighbours.some((n) => Math.abs(n.position - pos) < 1e-6);
    if (!tooTight) return this.update(item.id, { position: pos });
    // Float midpoints ran out of precision after many moves: renumber every row once.
    const reordered = neighbours.slice();
    reordered.splice(to, 0, item);
    reordered.forEach((it, idx) => {
      if (it.position !== idx + 1) this.update(it.id, { position: idx + 1 });
    });
    return { ok: true };
  }

  /** Show the "list is full" banner (e.g. when the user focuses the disabled add field). */
  showLimitMessage(): void {
    this.fail(LIMIT_MESSAGE);
  }

  dismissError(): void {
    if (this.error === null) return;
    this.error = null;
    this.recompute();
  }

  private update(itemId: string, patch: TodoPatch): CommandResult {
    return this.enqueue({ type: "update", opId: this.newId(), itemId, clientTime: this.now(), patch });
  }

  private enqueue(op: Op): CommandResult {
    this.outbox = enqueueOp(this.outbox, op, this.inFlight);
    this.error = null;
    this.persistOutbox();
    this.recompute();
    if (this.status === "online") void this.flush();
    return { ok: true };
  }

  private persistOutbox(): void {
    const snapshot = this.outbox.slice();
    this.persistChain = this.persistChain.then(() => this.store.saveOutbox(snapshot)).catch(() => undefined);
  }

  /** Resolves once everything queued so far has been written to local storage. */
  whenPersisted(): Promise<void> {
    return this.persistChain;
  }

  private find(id: string): TodoItem | undefined {
    return this.view.find((i) => i.id === id);
  }

  private fail(error: string): CommandResult {
    this.error = error;
    this.recompute();
    return { ok: false, error };
  }

  private setStatus(s: SyncStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.recompute();
  }

  private recompute(): void {
    this.view = deriveItems(this.confirmed, this.outbox, this.deviceId);
    this.state = { items: this.view, pendingCount: this.outbox.length, status: this.status, error: this.error };
    for (const l of this.listeners) l(this.state);
  }
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
}
