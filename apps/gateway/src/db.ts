import pg from 'pg';

// bigint columns (seq, timestamps in ms) come back as strings by default.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;

export function createDb(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 20 });
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS instructors (
     id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     email         text NOT NULL UNIQUE,
     name          text NOT NULL,
     password_hash text NOT NULL,
     created_at    bigint NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash    text PRIMARY KEY,
     instructor_id uuid NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
     expires_at    bigint NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rooms (
     id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     code           text NOT NULL,
     instructor_id  uuid NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
     title          text NOT NULL,
     lab            jsonb NOT NULL,
     stuck_minutes  int NOT NULL,
     status         text NOT NULL CHECK (status IN ('live', 'ended')),
     created_at     bigint NOT NULL,
     ended_at       bigint
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rooms_live_code ON rooms (code) WHERE status = 'live'`,
  `CREATE INDEX IF NOT EXISTS rooms_instructor ON rooms (instructor_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS students (
     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     name        text NOT NULL,
     token_hash  text NOT NULL UNIQUE,
     joined_at   bigint NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     seq         bigserial PRIMARY KEY,
     room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     type        text NOT NULL,
     student_id  uuid REFERENCES students(id) ON DELETE CASCADE,
     payload     jsonb NOT NULL,
     ts          bigint NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS events_room_seq ON events (room_id, seq)`,
  // A student's browser re-sends unacknowledged runs after a reconnect; this makes that safe.
  `CREATE UNIQUE INDEX IF NOT EXISTS events_run_dedupe ON events (student_id, (payload->>'runId')) WHERE type = 'run'`,
];

/** Idempotent schema setup, run at startup. A lock keeps parallel servers from racing. */
export async function migrate(db: Db): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    for (const sql of MIGRATIONS) await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}
