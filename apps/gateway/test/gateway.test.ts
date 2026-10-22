/**
 * Integration tests against real Postgres and Redis.
 * Requires TEST_DATABASE_URL and TEST_REDIS_URL (see README "Running tests").
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { fingerprint, type RoomEvent, type ServerMessage } from '@labpulse/shared';
import { createDb, migrate, type Db } from '../src/db.js';
import { RedisBus } from '../src/bus.js';
import { Repo } from '../src/repo.js';
import { buildServer } from '../src/server.js';
import type { Config } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://labpulse:labpulse@localhost:5432/labpulse_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

const config: Config = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: DB_URL,
  redisUrl: REDIS_URL,
  exercisesDir: path.resolve(here, '../../../exercises'),
  webDist: '',
  cookieSecure: false,
  logLevel: 'silent',
  publicUrl: '',
  signupCode: '',
  pyodideUrl: '',
};

let db: Db;
const servers: { app: FastifyInstance; bus: RedisBus; base: string; ws: string }[] = [];

async function startServer() {
  const bus = new RedisBus(REDIS_URL);
  await bus.ready();
  const app = await buildServer({ config, repo: new Repo(db), bus, limits: { authPerMinute: 10_000, joinsPerMinute: 10_000 } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const s = { app, bus, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
  servers.push(s);
  return s;
}

beforeAll(async () => {
  // These tests wipe tables: refuse to run against anything but a *_test database.
  if (!/_test(\?|$)/.test(new URL(DB_URL).pathname + new URL(DB_URL).search)) {
    throw new Error(`Refusing to run integration tests against ${DB_URL}: use a database whose name ends in _test`);
  }
  db = createDb(DB_URL);
  await migrate(db);
  // Two gateway instances sharing Postgres + Redis, like a scaled deployment.
  await startServer();
  await startServer();
});

afterAll(async () => {
  for (const s of servers) {
    await s.app.close();
    await s.bus.close();
  }
  await db.end();
});

beforeEach(async () => {
  await db.query('TRUNCATE instructors, sessions, rooms, students, events RESTART IDENTITY CASCADE');
  const redis = servers[0]!.bus as unknown as { pub: { flushdb(): Promise<unknown> } };
  await redis.pub.flushdb();
});

/* --------------------------------------------------------------- helpers */

class Http {
  cookie = '';
  constructor(private base: string) {}
  async req(method: string, url: string, body?: unknown) {
    const res = await fetch(this.base + url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const json = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, json };
  }
}

class Client {
  messages: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  closeCode: number | null = null;
  constructor(public ws: WebSocket) {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
    ws.on('close', (code) => (this.closeCode = code));
  }
  static async open(url: string, cookie?: string) {
    const ws = new WebSocket(url, { headers: cookie ? { cookie } : {} });
    const c = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return c;
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  wait<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 3000) {
    const match = (m: ServerMessage) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>);
    const found = this.messages.find(match);
    if (found) return Promise.resolve(found as Extract<ServerMessage, { t: T }>);
    return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), ms);
      this.waiters.push({
        pred: match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }
  waitEvent(pred: (e: RoomEvent) => boolean, ms = 3000) {
    return this.wait('event', (m) => pred(m.event), ms).then((m) => m.event);
  }
  close() {
    this.ws.close();
  }
}

async function instructor(base: string, email = 'ana@example.com') {
  const http = new Http(base);
  const r = await http.req('POST', '/api/auth/signup', { name: 'Ana', email, password: 'correct horse' });
  expect(r.status).toBe(200);
  return http;
}

async function createRoom(http: Http, stuckMinutes = 4) {
  const r = await http.req('POST', '/api/rooms', { title: 'CSE Lab 3', labId: 'python-warmup', stuckMinutes });
  expect(r.status).toBe(200);
  return r.json.room as { id: string; code: string };
}

async function joinStudent(base: string, wsBase: string, code: string, name: string) {
  const http = new Http(base);
  const r = await http.req('POST', '/api/join', { code, name });
  expect(r.status).toBe(200);
  const c = await Client.open(`${wsBase}/ws/student`);
  c.send({ t: 'hello', token: r.json.token });
  const welcome = await c.wait('welcome');
  return { client: c, token: r.json.token as string, studentId: r.json.studentId as string, welcome };
}

const TYPE_ERR = {
  exerciseId: 'receipt-line',
  result: 'error',
  testsPassed: 0,
  testsTotal: 3,
  errorType: 'TypeError',
  errorMessage: "unsupported operand type(s) for +: 'int' and 'str'",
  failingTest: 'test_several_items',
} as const;

let runId = 0;
async function run(c: Client, signal: object) {
  const id = `r${++runId}`;
  c.send({ t: 'run', id, signal });
  return c.wait('ack', (m) => m.id === id);
}

/* ------------------------------------------------------------------ tests */

describe('auth', () => {
  it('signs up, reads the session, logs out and back in', async () => {
    const http = await instructor(servers[0]!.base);
    expect((await http.req('GET', '/api/auth/me')).json.instructor.email).toBe('ana@example.com');
    expect((await http.req('POST', '/api/auth/signup', { name: 'Ana', email: 'ANA@example.com', password: 'whatever1' })).status).toBe(409);
    await http.req('POST', '/api/auth/logout', {});
    http.cookie = '';
    expect((await http.req('GET', '/api/auth/me')).json.instructor).toBeNull();
    expect((await http.req('POST', '/api/auth/login', { email: 'ana@example.com', password: 'wrong pass' })).status).toBe(401);
    expect((await http.req('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'wrong pass' })).status).toBe(401);
    const ok = await http.req('POST', '/api/auth/login', { email: ' Ana@Example.com ', password: 'correct horse' });
    expect(ok.status).toBe(200);
    expect((await http.req('GET', '/api/auth/me')).json.instructor.name).toBe('Ana');
  });

  it('rejects short passwords and unauthenticated access', async () => {
    const http = new Http(servers[0]!.base);
    const r = await http.req('POST', '/api/auth/signup', { name: 'A', email: 'a@b.co', password: 'short' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/8 characters/);
    expect((await http.req('GET', '/api/rooms')).status).toBe(401);
  });
});

describe('invite code', () => {
  it('requires the invite code for sign-up when one is configured', async () => {
    const bus = new RedisBus(REDIS_URL);
    await bus.ready();
    const app = await buildServer({ config: { ...config, signupCode: 'lab-2026' }, repo: new Repo(db), bus, limits: { authPerMinute: 10_000, joinsPerMinute: 10_000 } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      const http = new Http(base);
      expect((await http.req('GET', '/api/config')).json.signupRequiresCode).toBe(true);
      const body = { name: 'Ana', email: 'ana@example.com', password: 'correct horse' };
      expect((await http.req('POST', '/api/auth/signup', body)).status).toBe(403);
      expect((await http.req('POST', '/api/auth/signup', { ...body, inviteCode: 'wrong' })).status).toBe(403);
      expect((await http.req('POST', '/api/auth/signup', { ...body, inviteCode: 'lab-2026' })).status).toBe(200);
    } finally {
      await app.close();
      await bus.close();
    }
  });
});

describe('labs and rooms', () => {
  it('lists the starter lab and creates a room with a 6-character code', async () => {
    const http = await instructor(servers[0]!.base);
    const labs = await http.req('GET', '/api/labs');
    const lab = labs.json.labs.find((l: { id: string }) => l.id === 'python-warmup');
    expect(lab.exercises.map((e: { id: string }) => e.id)).toEqual(['class-average', 'receipt-line', 'fizzbuzz']);
    const room = await createRoom(http);
    expect(room.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    const list = await http.req('GET', '/api/rooms');
    expect(list.json.rooms).toHaveLength(1);
    expect(list.json.rooms[0].studentCount).toBe(0);
  });

  it('keeps rooms private to their instructor', async () => {
    const ana = await instructor(servers[0]!.base);
    const room = await createRoom(ana);
    const bob = await instructor(servers[0]!.base, 'bob@example.com');
    expect((await bob.req('GET', `/api/rooms/${room.id}`)).status).toBe(404);
    expect((await bob.req('GET', `/api/rooms/${room.id}/report`)).status).toBe(404);
    expect((await bob.req('POST', `/api/rooms/${room.id}/end`, {})).status).toBe(404);
    expect((await bob.req('GET', `/api/rooms/not-a-uuid`)).status).toBe(404);
    const dash = await Client.open(`${servers[0]!.ws}/ws/dashboard/${room.id}`, bob.cookie);
    await new Promise((r) => dash.ws.once('close', r));
    expect(dash.closeCode).toBe(4403);
  });

  it('rejects unknown room codes and bad names', async () => {
    const http = new Http(servers[0]!.base);
    expect((await http.req('POST', '/api/join', { code: 'ZZZZZZ', name: 'Ravi' })).status).toBe(404);
    expect((await http.req('POST', '/api/join', { code: 'abc', name: 'Ravi' })).status).toBe(400);
    const ana = await instructor(servers[0]!.base);
    const room = await createRoom(ana);
    expect((await http.req('POST', '/api/join', { code: room.code, name: '   ' })).status).toBe(400);
    // Codes are case-insensitive for students.
    expect((await http.req('POST', '/api/join', { code: room.code.toLowerCase(), name: 'Ravi' })).status).toBe(200);
  });
});

describe('live lab across two gateway instances', () => {
  it('streams normalized runs to the dashboard, groups them, and delivers hints to the group only', async () => {
    const [a, b] = servers as [(typeof servers)[0], (typeof servers)[0]];
    const ana = await instructor(a.base);
    const room = await createRoom(ana);

    // Dashboard on instance B; students on instance A.
    const dash = await Client.open(`${b.ws}/ws/dashboard/${room.id}`, ana.cookie);
    const snap = await dash.wait('snapshot');
    expect(snap.room.code).toBe(room.code);
    expect(snap.events).toEqual([]);

    const ravi = await joinStudent(a.base, a.ws, room.code, 'Ravi');
    const meera = await joinStudent(a.base, a.ws, room.code, 'Meera');
    const kiran = await joinStudent(a.base, a.ws, room.code, 'Kiran');

    // Students get the exercises but not the instructor's hint suggestions.
    expect(ravi.welcome.lab.exercises).toHaveLength(3);
    expect(ravi.welcome.lab.exercises[1]!.tests).toContain('def test_several_items');
    expect(ravi.welcome.lab.exercises[1]!.hints).toBeUndefined();
    expect(ravi.welcome.progress).toEqual({ 'class-average': 'not_started', 'receipt-line': 'not_started', fizzbuzz: 'not_started' });

    await dash.waitEvent((e) => e.type === 'student_joined' && e.studentId === kiran.studentId);
    await dash.waitEvent((e) => e.type === 'presence' && e.studentId === kiran.studentId);

    // Raw, un-normalized message from a client: the server normalizes and fingerprints it itself.
    const ack = await run(ravi.client, { ...TYPE_ERR, errorMessage: "name 'totl' is not defined", errorType: 'builtins.NameError' });
    expect(ack.ok).toBe(true);
    const nameEv = await dash.waitEvent((e) => e.type === 'run' && e.studentId === ravi.studentId);
    expect(nameEv.type === 'run' && nameEv.payload.errorMessage).toBe("name '<name>' is not defined");
    expect(nameEv.type === 'run' && nameEv.payload.errorType).toBe('NameError');

    // Two students hit the planted TypeError, one passes.
    expect((await run(ravi.client, TYPE_ERR)).ok).toBe(true);
    expect((await run(meera.client, { ...TYPE_ERR, fingerprint: 'forged' })).ok).toBe(true);
    expect((await run(kiran.client, { ...TYPE_ERR, result: 'pass', testsPassed: 3, errorType: null, errorMessage: null, failingTest: null })).ok).toBe(true);
    const fp = fingerprint({ ...TYPE_ERR })!;
    const meeraEv = await dash.waitEvent((e) => e.type === 'run' && e.studentId === meera.studentId);
    expect(meeraEv.type === 'run' && meeraEv.payload.fingerprint).toBe(fp);

    // Broadcast a hint from the dashboard owner.
    const hint = await ana.req('POST', `/api/rooms/${room.id}/hints`, { fingerprint: fp, text: 'Use str() or an f-string' });
    expect(hint.status).toBe(200);
    expect(new Set(hint.json.event.payload.recipients)).toEqual(new Set([ravi.studentId, meera.studentId]));

    const raviHint = await ravi.client.wait('hint');
    expect(raviHint.hint.text).toBe('Use str() or an f-string');
    await meera.client.wait('hint');
    await dash.waitEvent((e) => e.type === 'hint_sent');
    await new Promise((r) => setTimeout(r, 150));
    expect(kiran.client.messages.some((m) => m.t === 'hint')).toBe(false);

    // Hinting an unknown group fails cleanly.
    expect((await ana.req('POST', `/api/rooms/${room.id}/hints`, { fingerprint: '00000000000000', text: 'x' })).status).toBe(404);
    expect((await ana.req('POST', `/api/rooms/${room.id}/hints`, { fingerprint: fp, text: '  ' })).status).toBe(400);

    // Reconnecting restores progress and hints.
    ravi.client.close();
    const again = await Client.open(`${a.ws}/ws/student`);
    again.send({ t: 'hello', token: ravi.token });
    const w2 = await again.wait('welcome');
    expect(w2.progress['receipt-line']).toBe('failing');
    expect(w2.hints.map((h) => h.text)).toEqual(['Use str() or an f-string']);
    again.close();

    for (const c of [meera.client, kiran.client, dash]) c.close();
  });

  it('keeps one student’s runs in order even when sent back to back', async () => {
    const [a] = servers;
    const ana = await instructor(a!.base);
    const room = await createRoom(ana);
    const s = await joinStudent(a!.base, a!.ws, room.code, 'Ravi');
    const ids = ['x1', 'x2', 'x3', 'x4'];
    const pass = { ...TYPE_ERR, result: 'pass', testsPassed: 3, errorType: null, errorMessage: null, failingTest: null };
    s.client.send({ t: 'run', id: ids[0], signal: TYPE_ERR });
    s.client.send({ t: 'run', id: ids[1], signal: pass });
    s.client.send({ t: 'run', id: ids[2], signal: TYPE_ERR });
    s.client.send({ t: 'run', id: ids[3], signal: pass });
    for (const id of ids) await s.client.wait('ack', (m) => m.id === id);
    const events = (await db.query(`SELECT payload->>'result' AS r FROM events WHERE type = 'run' ORDER BY seq`)).rows.map((r) => r.r);
    expect(events).toEqual(['error', 'pass', 'error', 'pass']);
    s.client.close();
  });

  it('ignores a run the browser re-sends after a reconnect', async () => {
    const [a] = servers;
    const ana = await instructor(a!.base);
    const room = await createRoom(ana);
    const s = await joinStudent(a!.base, a!.ws, room.code, 'Ravi');
    s.client.send({ t: 'run', id: 'same-id', signal: TYPE_ERR });
    await s.client.wait('ack', (m) => m.id === 'same-id');
    s.client.close();
    const again = await Client.open(`${a!.ws}/ws/student`);
    again.send({ t: 'hello', token: s.token });
    await again.wait('welcome');
    again.send({ t: 'run', id: 'same-id', signal: TYPE_ERR });
    const ack = await again.wait('ack', (m) => m.id === 'same-id');
    expect(ack.ok).toBe(true);
    const n = (await db.query(`SELECT count(*)::int AS n FROM events WHERE type = 'run'`)).rows[0].n;
    expect(n).toBe(1);
    again.close();
  });

  it('records presence going offline and back online', async () => {
    const [a, b] = servers as [(typeof servers)[0], (typeof servers)[0]];
    const ana = await instructor(a.base);
    const room = await createRoom(ana);
    const dash = await Client.open(`${b.ws}/ws/dashboard/${room.id}`, ana.cookie);
    await dash.wait('snapshot');
    const s = await joinStudent(a.base, a.ws, room.code, 'Ravi');
    await dash.waitEvent((e) => e.type === 'presence' && e.payload.online === true);
    // Second tab on the other instance: still one "online", no flapping.
    const tab2 = await Client.open(`${b.ws}/ws/student`);
    tab2.send({ t: 'hello', token: s.token });
    await tab2.wait('welcome');
    s.client.close();
    await new Promise((r) => setTimeout(r, 200));
    const presence = () => dash.messages.filter((m) => m.t === 'event' && m.event.type === 'presence').map((m) => (m as any).event.payload.online);
    expect(presence()).toEqual([true]);
    tab2.close();
    await dash.waitEvent((e) => e.type === 'presence' && e.payload.online === false);
    expect(presence()).toEqual([true, false]);
    dash.close();
  });

  it('ends the lab: students are told, late runs are refused, joining is closed, report is ready', async () => {
    const [a, b] = servers as [(typeof servers)[0], (typeof servers)[0]];
    const ana = await instructor(a.base);
    const room = await createRoom(ana);
    const s1 = await joinStudent(a.base, a.ws, room.code, 'Ravi');
    const s2 = await joinStudent(b.base, b.ws, room.code, 'Meera');
    await run(s1.client, TYPE_ERR);
    await run(s2.client, TYPE_ERR);
    await run(s1.client, { ...TYPE_ERR, result: 'pass', testsPassed: 3, errorType: null, errorMessage: null, failingTest: null });

    const end = await ana.req('POST', `/api/rooms/${room.id}/end`, {});
    expect(end.status).toBe(200);
    expect(end.json.room.status).toBe('ended');
    await s1.client.wait('lab_ended');
    await s2.client.wait('lab_ended');
    const late = await run(s2.client, { ...TYPE_ERR, result: 'pass', testsPassed: 3, errorType: null, errorMessage: null, failingTest: null });
    expect(late).toMatchObject({ ok: false, error: 'lab_ended' });
    expect((await new Http(a.base).req('POST', '/api/join', { code: room.code, name: 'Late' })).status).toBe(404);
    // Ending twice is harmless.
    expect((await ana.req('POST', `/api/rooms/${room.id}/end`, {})).status).toBe(200);
    const ended = (await db.query(`SELECT count(*)::int AS n FROM events WHERE type = 'lab_ended'`)).rows[0].n;
    expect(ended).toBe(1);

    const rep = await ana.req('GET', `/api/rooms/${room.id}/report`);
    expect(rep.status).toBe(200);
    const r = rep.json.report;
    expect(r.studentCount).toBe(2);
    const ex2 = r.exercises.find((e: { exerciseId: string }) => e.exerciseId === 'receipt-line');
    expect(ex2).toMatchObject({ attempted: 2, finished: 1 });
    expect(r.lostTheClass.exerciseId).toBe('receipt-line');
    expect(r.topErrors[0]).toMatchObject({ errorType: 'TypeError', students: 2, recovered: 1 });

    // A fresh room can reuse nothing from the old one; the old code is free again.
    s1.client.close();
    s2.client.close();
  });

  it('refuses runs for exercises outside the lab and invalid tokens', async () => {
    const [a] = servers;
    const ana = await instructor(a!.base);
    const room = await createRoom(ana);
    const s = await joinStudent(a!.base, a!.ws, room.code, 'Ravi');
    expect(await run(s.client, { ...TYPE_ERR, exerciseId: 'nope' })).toMatchObject({ ok: false, error: 'unknown_exercise' });
    s.client.close();
    const bad = await Client.open(`${a!.ws}/ws/student`);
    bad.send({ t: 'hello', token: 'not-a-real-token-at-all' });
    await bad.wait('error');
    await new Promise((r) => bad.ws.once('close', r));
    expect(bad.closeCode).toBe(4401);
  });
});
