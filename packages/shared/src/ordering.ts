import type { TodoItem } from "./types";

/** Stable display order: by position, ties (e.g. two devices appended concurrently) broken by id. */
export function compareItems(a: Pick<TodoItem, "position" | "id">, b: Pick<TodoItem, "position" | "id">): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function positionAtEnd(items: readonly Pick<TodoItem, "position">[]): number {
  let max = 0;
  for (const i of items) if (i.position > max) max = i.position;
  return Math.floor(max) + 1;
}

/**
 * Position for an item moved to `toIndex` within `ordered` (which still contains the moved item at
 * `fromIndex`). Uses the midpoint between the new neighbours so only the moved row is rewritten —
 * this is what keeps concurrent reorders of *different* rows from conflicting.
 */
export function positionForMove(
  ordered: readonly Pick<TodoItem, "position">[],
  fromIndex: number,
  toIndex: number,
): number {
  const without = ordered.filter((_, i) => i !== fromIndex);
  const before = without[toIndex - 1];
  const after = without[toIndex];
  if (!before && !after) return 1;
  if (!before) return after!.position - 1;
  if (!after) return before.position + 1;
  return (before.position + after.position) / 2;
}
