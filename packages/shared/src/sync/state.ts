import { compareItems } from "../ordering";
import { MAX_ACTIVE_ITEMS, type Op, type TodoItem, type TodoPatch } from "../types";

export type ItemMap = Readonly<Record<string, TodoItem>>;

/**
 * Merge items received from the server into the confirmed cache. The server's `seq` is a total
 * order over all writes, so "newer seq wins" makes the merge idempotent and order-independent:
 * receiving the same change twice (push response + WebSocket broadcast + pull) is harmless.
 */
export function mergeServerItems(confirmed: ItemMap, incoming: readonly TodoItem[]): { items: ItemMap; changed: boolean } {
  let next: Record<string, TodoItem> | null = null;
  for (const item of incoming) {
    const existing = (next ?? confirmed)[item.id];
    if (existing && existing.seq >= item.seq) continue;
    next ??= { ...confirmed };
    next[item.id] = item;
  }
  return next ? { items: next, changed: true } : { items: confirmed, changed: false };
}

/** Optimistically apply one pending op on top of an item, mirroring the server's rules. */
export function applyOpToItem(item: TodoItem | undefined, op: Op, deviceId: string): TodoItem | undefined {
  switch (op.type) {
    case "create":
      if (item) return item; // server already has it (replayed create) — server state wins
      return {
        id: op.itemId,
        text: op.text,
        done: op.done,
        position: op.position,
        updatedAt: "",
        deleted: false,
        lastDeviceId: deviceId,
        seq: 0,
      };
    case "update":
      if (!item || item.deleted) return item; // tombstones are final: edits after a delete are ignored
      return { ...item, ...op.patch, lastDeviceId: deviceId };
    case "delete":
      return item ? { ...item, deleted: true, lastDeviceId: deviceId } : undefined;
  }
}

/**
 * The view the user sees = confirmed server state with the pending outbox replayed on top. Because
 * the view is *derived* rather than mutated, an op that gets acknowledged or rejected simply leaves
 * the outbox and the view recomputes; there is no local state to roll back by hand.
 */
export function deriveItems(confirmed: ItemMap, outbox: readonly Op[], deviceId: string): TodoItem[] {
  const work: Record<string, TodoItem | undefined> = { ...confirmed };
  for (const op of outbox) work[op.itemId] = applyOpToItem(work[op.itemId], op, deviceId);
  return Object.values(work)
    .filter((i): i is TodoItem => !!i && !i.deleted)
    .sort(compareItems);
}

export function countActive(items: readonly TodoItem[]): number {
  return items.filter((i) => !i.deleted && !i.done).length;
}

export function wouldExceedLimit(items: readonly TodoItem[]): boolean {
  return countActive(items) >= MAX_ACTIVE_ITEMS;
}

/**
 * Append `op` to the outbox, folding it into earlier pending ops for the same item when that is
 * semantically identical. Keeps the outbox small during long offline periods (or local-only use)
 * and means the server sees fewer writes. Ops whose ids are in `inFlight` have already been sent
 * and are never modified.
 */
export function enqueueOp(outbox: readonly Op[], op: Op, inFlight: ReadonlySet<string>): Op[] {
  if (op.type === "create") return [...outbox, op];

  const sameItem = (o: Op) => o.itemId === op.itemId;
  const isPending = (o: Op) => !inFlight.has(o.opId);

  if (op.type === "update") {
    // Only fold into the *latest* op for this item, and only if it hasn't been sent yet.
    let lastIdx = -1;
    for (let i = outbox.length - 1; i >= 0; i--) if (sameItem(outbox[i]!)) { lastIdx = i; break; }
    const last = lastIdx >= 0 ? outbox[lastIdx]! : undefined;
    if (last && isPending(last) && last.type !== "delete") {
      const merged: Op =
        last.type === "create"
          ? { ...last, ...pickCreateFields(op.patch) }
          : { ...last, patch: { ...last.patch, ...op.patch }, clientTime: op.clientTime };
      const next = outbox.slice();
      next[lastIdx] = merged;
      return next;
    }
    return [...outbox, op];
  }

  // delete: drop every unsent op for the item. If an unsent create was among them and nothing for
  // this item is in flight, the server never heard of the item, so the delete itself is unnecessary.
  const removed = outbox.filter((o) => sameItem(o) && isPending(o));
  const kept = outbox.filter((o) => !(sameItem(o) && isPending(o)));
  const hadUnsentCreate = removed.some((o) => o.type === "create");
  const anyInFlight = outbox.some((o) => sameItem(o) && !isPending(o));
  if (hadUnsentCreate && !anyInFlight) return kept;
  return [...kept, op];
}

function pickCreateFields(patch: TodoPatch): Partial<Pick<TodoItem, "text" | "done" | "position">> {
  const out: Partial<Pick<TodoItem, "text" | "done" | "position">> = {};
  if (patch.text !== undefined) out.text = patch.text;
  if (patch.done !== undefined) out.done = patch.done;
  if (patch.position !== undefined) out.position = patch.position;
  return out;
}
