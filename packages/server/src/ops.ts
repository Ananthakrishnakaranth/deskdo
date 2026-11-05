import { LIMIT_MESSAGE, MAX_ACTIVE_ITEMS, type Op, type OpResult, type OpStatus, type PullResponse, type PushResponse, type TodoItem } from "@deskdo/shared";
import type { PoolClient } from "pg";
import { rowToItem, type Db, type TodoRow } from "./db";

/** All writes for the (single) account are serialised on this advisory lock. */
const WRITE_LOCK = 7316002;

/**
 * Apply a batch of ops in one transaction.
 *
 * Conflict rules (see README "Sync model"):
 *  - Ops are applied in arrival order and each accepted write gets a server timestamp strictly
 *    greater than every earlier write, so "apply in arrival order" == "last write wins by server time".
 *  - Updates only touch the fields they carry, so a checkbox toggle on one device doesn't undo a text
 *    edit made on another.
 *  - Deletes produce a tombstone, and tombstones are final: any later edit of a deleted item is ignored.
 *  - Every opId is recorded; replaying an op (outbox retry after a lost response) is a no-op.
 */
export async function applyOps(db: Db, deviceId: string, ops: Op[]): Promise<PushResponse> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK]);
    const results: OpResult[] = [];
    const touched = new Set<string>();
    for (const op of ops) {
      const status = await applyOne(client, deviceId, op);
      results.push(status);
      touched.add(op.itemId);
    }
    const { rows } = await client.query<TodoRow>("SELECT * FROM todos WHERE id = ANY($1::uuid[])", [[...touched]]);
    const cursor = await currentCursor(client);
    await client.query("COMMIT");
    return { results, items: rows.map(rowToItem), cursor };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function applyOne(c: PoolClient, deviceId: string, op: Op): Promise<OpResult> {
  const seen = await c.query<{ status: OpStatus }>("SELECT status FROM processed_ops WHERE op_id = $1", [op.opId]);
  if (seen.rowCount) return { opId: op.opId, status: "duplicate" };

  const result = await decide(c, deviceId, op);
  await c.query("INSERT INTO processed_ops (op_id, item_id, status) VALUES ($1, $2, $3)", [op.opId, op.itemId, result.status]);
  return result;
}

async function decide(c: PoolClient, deviceId: string, op: Op): Promise<OpResult> {
  const { rows } = await c.query<TodoRow>("SELECT * FROM todos WHERE id = $1 FOR UPDATE", [op.itemId]);
  const row = rows[0];
  const ok = (status: OpStatus, reason?: string): OpResult => (reason ? { opId: op.opId, status, reason } : { opId: op.opId, status });

  switch (op.type) {
    case "create": {
      // Same item id already exists: a replay whose op record was lost, or (tombstone) deleted since.
      if (row) return ok("duplicate");
      if (!op.done && (await activeCount(c)) >= MAX_ACTIVE_ITEMS) return ok("rejected", LIMIT_MESSAGE);
      await c.query(
        `INSERT INTO todos (id, text, done, position, updated_at, deleted, last_device_id, seq)
         VALUES ($1, $2, $3, $4, ${NEXT_TS}, false, $5, nextval('todo_change_seq'))`,
        [op.itemId, op.text, op.done, op.position, deviceId],
      );
      return ok("applied");
    }
    case "update": {
      if (!row) return ok("ignored", "unknown item");
      if (row.deleted) return ok("ignored", "item was deleted"); // a delete beats any edit
      const p = op.patch;
      if (p.done === false && row.done && (await activeCount(c)) >= MAX_ACTIVE_ITEMS) return ok("rejected", LIMIT_MESSAGE);
      await c.query(
        `UPDATE todos SET
           text = COALESCE($2, text),
           done = COALESCE($3, done),
           position = COALESCE($4, position),
           updated_at = ${NEXT_TS},
           last_device_id = $5,
           seq = nextval('todo_change_seq')
         WHERE id = $1`,
        [op.itemId, p.text ?? null, p.done ?? null, p.position ?? null, deviceId],
      );
      return ok("applied");
    }
    case "delete": {
      if (!row) return ok("ignored", "unknown item");
      if (row.deleted) return ok("duplicate");
      await c.query(
        `UPDATE todos SET deleted = true, updated_at = ${NEXT_TS}, last_device_id = $2, seq = nextval('todo_change_seq') WHERE id = $1`,
        [op.itemId, deviceId],
      );
      return ok("applied");
    }
  }
}

/**
 * Server timestamp for the next write: wall clock, but never <= the previous write's timestamp
 * (protects LWW ordering against clock steps on the server/DB host).
 */
const NEXT_TS = `GREATEST(clock_timestamp(), COALESCE((SELECT updated_at FROM todos ORDER BY seq DESC LIMIT 1), '-infinity'::timestamptz) + interval '1 microsecond')`;

async function activeCount(c: PoolClient): Promise<number> {
  const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM todos WHERE NOT deleted AND NOT done");
  return rows[0]!.n;
}

async function currentCursor(c: PoolClient | Db): Promise<number> {
  const { rows } = await c.query<{ s: number | null }>("SELECT max(seq) AS s FROM todos");
  return rows[0]!.s ?? 0;
}

export async function changesSince(db: Db, since: number): Promise<PullResponse> {
  const client = await db.connect();
  try {
    // One snapshot for all reads, so the returned cursor exactly matches the returned rows.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const meta = await client.query<{ value: number }>("SELECT value FROM server_meta WHERE key = 'purged_through_seq'");
    const purged = meta.rows[0]?.value ?? 0;
    // A client whose cursor predates purged tombstones could keep deleted items forever: send a full reset.
    const reset = since < purged;
    const { rows } = reset
      ? await client.query<TodoRow>("SELECT * FROM todos WHERE NOT deleted ORDER BY seq")
      : await client.query<TodoRow>("SELECT * FROM todos WHERE seq > $1 ORDER BY seq", [since]);
    const cursor = reset ? await currentCursor(client) : Math.max(since, rows.at(-1)?.seq ?? 0);
    await client.query("COMMIT");
    const items: TodoItem[] = rows.map(rowToItem);
    return reset ? { items, cursor, reset: true } : { items, cursor };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Housekeeping: drop tombstones and op records older than `days`. Runs daily. */
export async function purgeOld(db: Db, days = 90): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK]);
    const { rows } = await client.query<{ s: number | null }>(
      "DELETE FROM todos WHERE deleted AND updated_at < now() - make_interval(days => $1) RETURNING seq AS s",
      [days],
    );
    const maxPurged = rows.reduce((m, r) => Math.max(m, r.s ?? 0), 0);
    if (maxPurged > 0) {
      await client.query("UPDATE server_meta SET value = GREATEST(value, $1) WHERE key = 'purged_through_seq'", [maxPurged]);
    }
    await client.query("DELETE FROM processed_ops WHERE processed_at < now() - make_interval(days => $1)", [days]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
