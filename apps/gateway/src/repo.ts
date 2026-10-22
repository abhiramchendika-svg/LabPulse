import crypto from 'node:crypto';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type LabDefinition,
  type RoomEvent,
  type RoomEventType,
  type RoomInfo,
} from '@labpulse/shared';
import type { Db } from './db.js';
import { sha256 } from './auth.js';

export interface Instructor {
  id: string;
  email: string;
  name: string;
}

export interface RoomRow {
  id: string;
  code: string;
  instructorId: string;
  title: string;
  lab: LabDefinition;
  stuckMinutes: number;
  status: 'live' | 'ended';
  createdAt: number;
  endedAt: number | null;
}

export interface StudentRow {
  id: string;
  roomId: string;
  name: string;
  joinedAt: number;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function roomInfo(r: RoomRow): RoomInfo {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    labId: r.lab.id,
    labTitle: r.lab.title,
    stuckMinutes: r.stuckMinutes,
    status: r.status,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
    exercises: r.lab.exercises.map((e) => ({ id: e.id, title: e.title })),
  };
}

function mapRoom(row: Record<string, unknown>): RoomRow {
  return {
    id: row.id as string,
    code: row.code as string,
    instructorId: row.instructor_id as string,
    title: row.title as string,
    lab: row.lab as LabDefinition,
    stuckMinutes: row.stuck_minutes as number,
    status: row.status as 'live' | 'ended',
    createdAt: row.created_at as number,
    endedAt: (row.ended_at as number | null) ?? null,
  };
}

function mapEvent(row: Record<string, unknown>): RoomEvent {
  return {
    seq: row.seq as number,
    ts: row.ts as number,
    type: row.type as RoomEventType,
    studentId: (row.student_id as string | null) ?? null,
    payload: row.payload,
  } as RoomEvent;
}

export function randomRoomCode(): string {
  const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length];
  return s;
}

export class Repo {
  constructor(private db: Db) {}

  /* ---------------------------------------------------------- instructors */

  async createInstructor(email: string, name: string, passwordHash: string): Promise<Instructor | null> {
    const r = await this.db.query(
      `INSERT INTO instructors (email, name, password_hash, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, name`,
      [email, name, passwordHash, Date.now()],
    );
    return (r.rows[0] as Instructor | undefined) ?? null;
  }

  async findInstructorByEmail(email: string): Promise<(Instructor & { passwordHash: string }) | null> {
    const r = await this.db.query(`SELECT id, email, name, password_hash FROM instructors WHERE email = $1`, [email]);
    const row = r.rows[0];
    return row ? { id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash } : null;
  }

  async createSession(instructorId: string, token: string): Promise<void> {
    await this.db.query(`INSERT INTO sessions (token_hash, instructor_id, expires_at) VALUES ($1, $2, $3)`, [
      sha256(token),
      instructorId,
      Date.now() + SESSION_TTL_MS,
    ]);
    // Opportunistic cleanup of expired sessions.
    await this.db.query(`DELETE FROM sessions WHERE expires_at < $1`, [Date.now()]);
  }

  async instructorForSession(token: string): Promise<Instructor | null> {
    const r = await this.db.query(
      `SELECT i.id, i.email, i.name FROM sessions s JOIN instructors i ON i.id = s.instructor_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [sha256(token), Date.now()],
    );
    return (r.rows[0] as Instructor | undefined) ?? null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
  }

  /* ---------------------------------------------------------------- rooms */

  async createRoom(instructorId: string, title: string, lab: LabDefinition, stuckMinutes: number): Promise<RoomRow> {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const r = await this.db.query(
          `INSERT INTO rooms (code, instructor_id, title, lab, stuck_minutes, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'live', $6) RETURNING *`,
          [randomRoomCode(), instructorId, title, JSON.stringify(lab), stuckMinutes, Date.now()],
        );
        return mapRoom(r.rows[0]);
      } catch (err) {
        // 23505 = unique violation on the live room code: try another code.
        if ((err as { code?: string }).code !== '23505') throw err;
      }
    }
    throw new Error('Could not allocate a room code');
  }

  async getRoom(id: string): Promise<RoomRow | null> {
    if (!isUuid(id)) return null;
    const r = await this.db.query(`SELECT * FROM rooms WHERE id = $1`, [id]);
    return r.rows[0] ? mapRoom(r.rows[0]) : null;
  }

  async getLiveRoomByCode(code: string): Promise<RoomRow | null> {
    const r = await this.db.query(`SELECT * FROM rooms WHERE code = $1 AND status = 'live'`, [code]);
    return r.rows[0] ? mapRoom(r.rows[0]) : null;
  }

  async listRooms(instructorId: string): Promise<(RoomRow & { studentCount: number })[]> {
    const r = await this.db.query(
      `SELECT r.*, (SELECT count(*) FROM students s WHERE s.room_id = r.id)::int AS student_count
       FROM rooms r WHERE r.instructor_id = $1 ORDER BY r.created_at DESC LIMIT 200`,
      [instructorId],
    );
    return r.rows.map((row) => ({ ...mapRoom(row), studentCount: row.student_count as number }));
  }

  /** Marks the room ended. Returns false if it was already ended. */
  async endRoom(id: string, at: number): Promise<boolean> {
    const r = await this.db.query(`UPDATE rooms SET status = 'ended', ended_at = $2 WHERE id = $1 AND status = 'live'`, [id, at]);
    return (r.rowCount ?? 0) > 0;
  }

  /* ------------------------------------------------------------- students */

  async createStudent(roomId: string, name: string, token: string): Promise<StudentRow> {
    const r = await this.db.query(
      `INSERT INTO students (room_id, name, token_hash, joined_at) VALUES ($1, $2, $3, $4) RETURNING id, room_id, name, joined_at`,
      [roomId, name, sha256(token), Date.now()],
    );
    const row = r.rows[0];
    return { id: row.id, roomId: row.room_id, name: row.name, joinedAt: row.joined_at };
  }

  async studentForToken(token: string): Promise<StudentRow | null> {
    const r = await this.db.query(`SELECT id, room_id, name, joined_at FROM students WHERE token_hash = $1`, [sha256(token)]);
    const row = r.rows[0];
    return row ? { id: row.id, roomId: row.room_id, name: row.name, joinedAt: row.joined_at } : null;
  }

  /* --------------------------------------------------------------- events */

  async appendEvent(
    roomId: string,
    type: RoomEventType,
    studentId: string | null,
    payload: unknown,
    ts = Date.now(),
  ): Promise<RoomEvent> {
    const r = await this.db.query(
      `INSERT INTO events (room_id, type, student_id, payload, ts) VALUES ($1, $2, $3, $4, $5)
       RETURNING seq, ts, type, student_id, payload`,
      [roomId, type, studentId, JSON.stringify(payload), ts],
    );
    return mapEvent(r.rows[0]);
  }

  /** Inserts a run unless this student already sent a run with the same id. Returns null for a duplicate. */
  async appendRunEvent(roomId: string, studentId: string, payload: { runId: string } & Record<string, unknown>, ts = Date.now()): Promise<RoomEvent | null> {
    const r = await this.db.query(
      `INSERT INTO events (room_id, type, student_id, payload, ts) VALUES ($1, 'run', $2, $3, $4)
       ON CONFLICT (student_id, (payload->>'runId')) WHERE type = 'run' DO NOTHING
       RETURNING seq, ts, type, student_id, payload`,
      [roomId, studentId, JSON.stringify(payload), ts],
    );
    return r.rows[0] ? mapEvent(r.rows[0]) : null;
  }

  async listEvents(roomId: string): Promise<RoomEvent[]> {
    const r = await this.db.query(
      `SELECT seq, ts, type, student_id, payload FROM events WHERE room_id = $1 ORDER BY seq`,
      [roomId],
    );
    return r.rows.map(mapEvent);
  }

  async listStudentEvents(roomId: string, studentId: string): Promise<RoomEvent[]> {
    const r = await this.db.query(
      `SELECT seq, ts, type, student_id, payload FROM events
       WHERE room_id = $1 AND (student_id = $2 OR type = 'hint_sent') ORDER BY seq`,
      [roomId, studentId],
    );
    return r.rows.map(mapEvent);
  }
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
