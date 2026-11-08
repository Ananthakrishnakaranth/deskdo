import pg from "pg";
import type { TodoItem } from "@deskdo/shared";

// Return bigint (seq) as JS number; values stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Db = pg.Pool;

export function createPool(url: string, ssl: boolean): Db {
  const pool = new pg.Pool({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: true } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000, // Neon can take a moment to resume a suspended database
  });
  // Neon closes idle connections when it suspends the database. pg reports that as an 'error'
  // event on the pool; without a listener Node would crash the whole server. The pool replaces the
  // connection on next use, so logging is all that's needed.
  pool.on("error", (e) => console.error("database connection dropped (will reconnect):", e.message));
  return pool;
}

const MIGRATIONS: string[] = [
  `
  CREATE SEQUENCE IF NOT EXISTS todo_change_seq;
  CREATE TABLE IF NOT EXISTS todos (
    id             uuid PRIMARY KEY,
    text           text NOT NULL,
    done           boolean NOT NULL DEFAULT false,
    position       double precision NOT NULL,
    updated_at     timestamptz NOT NULL,
    deleted        boolean NOT NULL DEFAULT false,
    last_device_id text NOT NULL,
    seq            bigint NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS todos_seq_idx ON todos (seq);
  -- Every op id the server has handled. Makes outbox replays idempotent.
  CREATE TABLE IF NOT EXISTS processed_ops (
    op_id        uuid PRIMARY KEY,
    item_id      uuid NOT NULL,
    status       text NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS processed_ops_time_idx ON processed_ops (processed_at);
  CREATE TABLE IF NOT EXISTS server_meta (
    key   text PRIMARY KEY,
    value bigint NOT NULL
  );
  INSERT INTO server_meta (key, value) VALUES ('purged_through_seq', 0) ON CONFLICT DO NOTHING;
  `,
];

export async function migrate(db: Db): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialise concurrent migrators (e.g. two instances booting at once).
    await client.query("SELECT pg_advisory_xact_lock(7316001)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY)");
    const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      if (applied.has(i + 1)) continue;
      await client.query(MIGRATIONS[i]!);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [i + 1]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface TodoRow {
  id: string;
  text: string;
  done: boolean;
  position: number;
  updated_at: Date;
  deleted: boolean;
  last_device_id: string;
  seq: number;
}

export function rowToItem(r: TodoRow): TodoItem {
  return {
    id: r.id,
    text: r.text,
    done: r.done,
    position: r.position,
    updatedAt: r.updated_at.toISOString(),
    deleted: r.deleted,
    lastDeviceId: r.last_device_id,
    seq: r.seq,
  };
}
