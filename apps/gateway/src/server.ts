import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import {
  buildReport,
  buildRoomState,
  createRoomSchema,
  fingerprint,
  joinSchema,
  loginSchema,
  normalizeErrorType,
  normalizeMessage,
  normalizeTestName,
  sendHintSchema,
  signupSchema,
  studentClientMessage,
  type RoomEvent,
  type RunSignal,
  type ServerMessage,
  type StudentHint,
} from '@labpulse/shared';
import type { Bus } from './bus.js';
import type { Config } from './config.js';
import { hashPassword, newToken, RateLimiter, TokenBucket, verifyPassword } from './auth.js';
import { loadLabs } from './labs.js';
import { Repo, roomInfo, type Instructor, type RoomRow } from './repo.js';

const SESSION_COOKIE = 'lp_session';
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 25_000;
const ACTIVITY_MIN_INTERVAL_MS = 20_000;

export interface ServerDeps {
  config: Config;
  repo: Repo;
  bus: Bus;
  /** Per-IP limits per minute. Joins are generous: a whole lab can share one NAT address. */
  limits?: { authPerMinute: number; joinsPerMinute: number };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    instructor?: Instructor;
  }
}

function send(socket: WebSocket, msg: ServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

export async function buildServer({ config, repo, bus, limits = { authPerMinute: 20, joinsPerMinute: 400 } }: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

  const loginLimiter = new RateLimiter(limits.authPerMinute, 60_000);
  const joinLimiter = new RateLimiter(limits.joinsPerMinute, 60_000);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues[0]?.message ?? 'Invalid request' });
    }
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : 'Bad request';
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: message });
    app.log.error({ err }, 'request failed');
    return reply.status(500).send({ error: 'Something went wrong on the server' });
  });

  /* --------------------------------------------------------------- helpers */

  const publish = async (roomId: string, ev: RoomEvent) => {
    try {
      await bus.publish(roomId, ev);
    } catch (err) {
      app.log.error({ err }, 'bus publish failed');
    }
  };

  const append = async (roomId: string, type: RoomEvent['type'], studentId: string | null, payload: unknown, ts?: number) => {
    const ev = await repo.appendEvent(roomId, type, studentId, payload, ts);
    await publish(roomId, ev);
    return ev;
  };

  const sessionInstructor = async (req: FastifyRequest): Promise<Instructor | null> => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return null;
    return repo.instructorForSession(token);
  };

  const requireInstructor = async (req: FastifyRequest): Promise<Instructor> => {
    const i = await sessionInstructor(req);
    if (!i) throw new HttpError(401, 'Please sign in');
    req.instructor = i;
    return i;
  };

  const requireOwnedRoom = async (req: FastifyRequest, roomId: string): Promise<{ instructor: Instructor; room: RoomRow }> => {
    const instructor = await requireInstructor(req);
    const room = await repo.getRoom(roomId);
    if (!room || room.instructorId !== instructor.id) throw new HttpError(404, 'Lab room not found');
    return { instructor, room };
  };

  const setSession = (reply: FastifyReply, token: string) => {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
  };

  const getLabs = async () => {
    const { labs, errors } = await loadLabs(config.exercisesDir);
    for (const e of errors) app.log.warn(e);
    return labs;
  };

  /* ------------------------------------------------------------------ auth */

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({
    publicUrl: config.publicUrl || null,
    signupRequiresCode: !!config.signupCode,
    pyodideUrl: config.pyodideUrl || null,
  }));

  app.post('/api/auth/signup', async (req, reply) => {
    if (!loginLimiter.allow(`signup:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
    const body = signupSchema.parse(req.body);
    if (config.signupCode && !sameSecret(body.inviteCode ?? '', config.signupCode)) {
      throw new HttpError(403, 'That invite code is not right. Ask whoever runs this LabPulse server for it.');
    }
    const created = await repo.createInstructor(body.email, body.name, await hashPassword(body.password));
    if (!created) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
    const token = newToken();
    await repo.createSession(created.id, token);
    setSession(reply, token);
    return { instructor: created };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (!loginLimiter.allow(`login:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
    const body = loginSchema.parse(req.body);
    const found = await repo.findInstructorByEmail(body.email);
    // Verify against a dummy hash when the account doesn't exist, so timing doesn't reveal it.
    const ok = await verifyPassword(body.password, found?.passwordHash ?? DUMMY_HASH);
    if (!found || !ok) throw new HttpError(401, 'Email or password is incorrect');
    const token = newToken();
    await repo.createSession(found.id, token);
    setSession(reply, token);
    return { instructor: { id: found.id, email: found.email, name: found.name } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await repo.deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    return { instructor: await sessionInstructor(req) };
  });

  /* ------------------------------------------------------------ labs/rooms */

  app.get('/api/labs', async (req) => {
    await requireInstructor(req);
    const labs = await getLabs();
    return {
      labs: labs.map((l) => ({
        id: l.id,
        title: l.title,
        description: l.description,
        exercises: l.exercises.map((e) => ({ id: e.id, title: e.title })),
      })),
    };
  });

  app.get('/api/rooms', async (req) => {
    const instructor = await requireInstructor(req);
    const rooms = await repo.listRooms(instructor.id);
    return { rooms: rooms.map((r) => ({ ...roomInfo(r), studentCount: r.studentCount })) };
  });

  app.post('/api/rooms', async (req) => {
    const instructor = await requireInstructor(req);
    const body = createRoomSchema.parse(req.body);
    const lab = (await getLabs()).find((l) => l.id === body.labId);
    if (!lab) throw new HttpError(400, 'That lab no longer exists in the exercises folder');
    const room = await repo.createRoom(instructor.id, body.title, lab, body.stuckMinutes);
    return { room: roomInfo(room) };
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id', async (req) => {
    const { room } = await requireOwnedRoom(req, req.params.id);
    return { room: roomInfo(room), lab: room.lab };
  });

  app.post<{ Params: { id: string } }>('/api/rooms/:id/hints', async (req) => {
    const { room } = await requireOwnedRoom(req, req.params.id);
    if (room.status !== 'live') throw new HttpError(409, 'This lab has ended');
    const body = sendHintSchema.parse(req.body);
    const events = await repo.listEvents(room.id);
    const state = buildRoomState(events, { stuckMinutes: room.stuckMinutes, exercises: room.lab.exercises }, Date.now());
    const group = state.allGroups[body.fingerprint];
    if (!group) throw new HttpError(404, 'That error group no longer exists');
    if (group.studentIds.length === 0) throw new HttpError(409, 'Everyone in this group has already moved on');
    const ev = await append(room.id, 'hint_sent', null, {
      hintId: crypto.randomUUID(),
      exerciseId: group.exerciseId,
      fingerprint: group.fingerprint,
      text: body.text,
      recipients: group.studentIds,
    });
    return { event: ev };
  });

  app.post<{ Params: { id: string } }>('/api/rooms/:id/end', async (req) => {
    const { room } = await requireOwnedRoom(req, req.params.id);
    const at = Date.now();
    if (await repo.endRoom(room.id, at)) {
      await append(room.id, 'lab_ended', null, {}, at);
    }
    const updated = await repo.getRoom(room.id);
    return { room: roomInfo(updated!) };
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id/report', async (req) => {
    const { room } = await requireOwnedRoom(req, req.params.id);
    const events = await repo.listEvents(room.id);
    const report = buildReport(events, { stuckMinutes: room.stuckMinutes, exercises: room.lab.exercises }, Date.now());
    return { room: roomInfo(room), report };
  });

  /* --------------------------------------------------------------- student */

  app.post('/api/join', async (req) => {
    if (!joinLimiter.allow(`join:${req.ip}`)) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
    const body = joinSchema.parse(req.body);
    const room = await repo.getLiveRoomByCode(body.code);
    if (!room) throw new HttpError(404, 'No live lab with that code. Check the code on the screen.');
    const token = newToken();
    const student = await repo.createStudent(room.id, body.name, token);
    await append(room.id, 'student_joined', student.id, { name: student.name }, student.joinedAt);
    return { token, studentId: student.id, roomId: room.id };
  });

  /* ------------------------------------------------------------ websockets */

  const alive = new WeakMap<WebSocket, boolean>();
  const sockets = new Set<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const s of sockets) {
      if (alive.get(s) === false) {
        s.terminate();
        continue;
      }
      alive.set(s, false);
      try {
        s.ping();
      } catch {
        /* closed */
      }
    }
  }, HEARTBEAT_MS);
  app.addHook('onClose', async () => clearInterval(heartbeat));

  const track = (socket: WebSocket) => {
    sockets.add(socket);
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.on('close', () => sockets.delete(socket));
  };

  app.get<{ Params: { id: string } }>('/ws/dashboard/:id', { websocket: true }, async (socket, req) => {
    track(socket);
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    socket.on('close', () => {
      closed = true;
      unsubscribe?.();
    });
    try {
      const instructor = await sessionInstructor(req);
      const room = instructor ? await repo.getRoom(req.params.id) : null;
      if (!instructor || !room || room.instructorId !== instructor.id) {
        send(socket, { t: 'error', message: 'Not allowed' });
        socket.close(4403, 'forbidden');
        return;
      }
      // Subscribe first and buffer, so nothing published during the snapshot load is lost.
      const buffered: RoomEvent[] = [];
      let lastSeq = -1;
      let live = false;
      const forward = (ev: RoomEvent) => {
        if (!live) {
          buffered.push(ev);
          return;
        }
        if (ev.seq <= lastSeq) return;
        lastSeq = ev.seq;
        send(socket, { t: 'event', event: ev });
      };
      unsubscribe = await bus.subscribe(room.id, forward);
      if (closed) {
        unsubscribe();
        return;
      }
      const events = await repo.listEvents(room.id);
      const fresh = await repo.getRoom(room.id);
      lastSeq = events.length ? events[events.length - 1]!.seq : -1;
      send(socket, { t: 'snapshot', serverNow: Date.now(), room: roomInfo(fresh ?? room), events });
      live = true;
      for (const ev of buffered.sort((a, b) => a.seq - b.seq)) forward(ev);
      socket.on('message', (raw) => {
        if (String(raw).includes('"ping"')) send(socket, { t: 'pong', serverNow: Date.now() });
      });
    } catch (err) {
      app.log.error({ err }, 'dashboard socket failed');
      socket.close(1011, 'server error');
    }
  });

  app.get('/ws/student', { websocket: true }, (socket) => {
    track(socket);
    let closed = false;
    let cleanup: (() => Promise<void>) | null = null;
    const helloTimer = setTimeout(() => socket.close(4401, 'no hello'), HELLO_TIMEOUT_MS);

    socket.on('close', () => {
      closed = true;
      clearTimeout(helloTimer);
      void cleanup?.();
    });

    socket.once('message', async (raw) => {
      clearTimeout(helloTimer);
      try {
        const hello = z.object({ t: z.literal('hello'), token: z.string().min(10).max(200) }).safeParse(JSON.parse(String(raw)));
        if (!hello.success) {
          socket.close(4400, 'bad hello');
          return;
        }
        const student = await repo.studentForToken(hello.data.token);
        const room = student ? await repo.getRoom(student.roomId) : null;
        if (!student || !room) {
          send(socket, { t: 'error', message: 'Your session for this lab is no longer valid. Join again with the room code.' });
          socket.close(4401, 'unknown student');
          return;
        }
        if (closed) return;
        await runStudentSession(socket, student.id, student.name, room, (fn) => {
          cleanup = fn;
          if (closed) void fn();
        });
      } catch (err) {
        app.log.error({ err }, 'student hello failed');
        socket.close(1011, 'server error');
      }
    });
  });

  async function runStudentSession(
    socket: WebSocket,
    studentId: string,
    name: string,
    room: RoomRow,
    setCleanup: (fn: () => Promise<void>) => void,
  ) {
    let roomLive = room.status === 'live';
    const exerciseIds = new Set(room.lab.exercises.map((e) => e.id));

    const unsubscribe = await bus.subscribe(room.id, (ev) => {
      if (ev.type === 'hint_sent' && ev.payload.recipients.includes(studentId)) {
        send(socket, {
          t: 'hint',
          hint: { hintId: ev.payload.hintId, exerciseId: ev.payload.exerciseId, text: ev.payload.text, sentAt: ev.ts },
        });
      } else if (ev.type === 'lab_ended') {
        roomLive = false;
        send(socket, { t: 'lab_ended' });
      }
    });

    // Presence changes are serialized per connection so "offline" can never be
    // recorded before the matching "online".
    let presenceChain: Promise<void> = Promise.resolve();
    let countedPresence = false;
    const chain = (fn: () => Promise<void>) => {
      presenceChain = presenceChain.then(fn).catch((err) => app.log.warn({ err }, 'presence update failed'));
      return presenceChain;
    };
    setCleanup(async () => {
      unsubscribe();
      await chain(async () => {
        if (!countedPresence) return;
        countedPresence = false;
        const n = await bus.presence(studentId, -1);
        if (n === 0 && roomLive) await append(room.id, 'presence', studentId, { online: false });
      });
    });

    const bucket = new TokenBucket(10, 2);
    let lastActivity = { exerciseId: '', at: 0 };

    // Messages from one student are handled strictly in order (a pass after a fail must stay after it).
    let messageChain: Promise<void> = Promise.resolve();
    socket.on('message', (raw) => {
      messageChain = messageChain.then(() => handleMessage(String(raw))).catch((err) => app.log.error({ err }, 'student message failed'));
    });

    const handleMessage = async (raw: string) => {
      let msg;
      try {
        msg = studentClientMessage.safeParse(JSON.parse(raw));
      } catch {
        return;
      }
      if (!msg.success) return;
      const m = msg.data;
      if (m.t === 'ping') {
        send(socket, { t: 'pong', serverNow: Date.now() });
        return;
      }
      if (!roomLive) {
        if (m.t === 'run') send(socket, { t: 'ack', id: m.id, ok: false, error: 'lab_ended' });
        return;
      }
      if (!bucket.take()) {
        if (m.t === 'run') send(socket, { t: 'ack', id: m.id, ok: false, error: 'rate_limited' });
        return;
      }
      try {
        if (m.t === 'run') {
          if (!exerciseIds.has(m.signal.exerciseId)) {
            send(socket, { t: 'ack', id: m.id, ok: false, error: 'unknown_exercise' });
            return;
          }
          const s = m.signal;
          const clean: RunSignal = {
            exerciseId: s.exerciseId,
            result: s.result,
            testsTotal: s.testsTotal,
            testsPassed: Math.min(s.testsPassed, s.testsTotal),
            errorType: s.result === 'pass' ? null : (normalizeErrorType(s.errorType) ?? (s.result === 'fail' ? 'AssertionError' : 'Error')),
            errorMessage: s.result === 'pass' ? null : normalizeMessage(s.errorMessage),
            failingTest: s.result === 'pass' ? null : normalizeTestName(s.failingTest),
          };
          // Re-check the room so a run that races the end of the lab isn't recorded.
          const current = await repo.getRoom(room.id);
          if (!current || current.status !== 'live') {
            roomLive = false;
            send(socket, { t: 'ack', id: m.id, ok: false, error: 'lab_ended' });
            return;
          }
          const ev = await repo.appendRunEvent(room.id, studentId, { ...clean, fingerprint: fingerprint(clean), runId: m.id });
          if (ev) await publish(room.id, ev);
          send(socket, { t: 'ack', id: m.id, ok: true });
        } else if (m.t === 'activity') {
          if (!exerciseIds.has(m.signal.exerciseId)) return;
          const now = Date.now();
          if (m.signal.exerciseId === lastActivity.exerciseId && now - lastActivity.at < ACTIVITY_MIN_INTERVAL_MS) return;
          lastActivity = { exerciseId: m.signal.exerciseId, at: now };
          await append(room.id, 'activity', studentId, { exerciseId: m.signal.exerciseId }, now);
        }
      } catch (err) {
        app.log.error({ err }, 'student message failed');
        if (m.t === 'run') send(socket, { t: 'ack', id: m.id, ok: false, error: 'server_error' });
      }
    };

    // Restore what this student already has: hints and per-exercise status.
    const mine = await repo.listStudentEvents(room.id, studentId);
    const hints: StudentHint[] = [];
    const progress: Record<string, 'not_started' | 'failing' | 'passing'> = {};
    for (const id of exerciseIds) progress[id] = 'not_started';
    for (const ev of mine) {
      if (ev.type === 'hint_sent' && ev.payload.recipients.includes(studentId)) {
        hints.push({ hintId: ev.payload.hintId, exerciseId: ev.payload.exerciseId, text: ev.payload.text, sentAt: ev.ts });
      } else if (ev.type === 'run' && exerciseIds.has(ev.payload.exerciseId)) {
        progress[ev.payload.exerciseId] = ev.payload.result === 'pass' ? 'passing' : 'failing';
      }
    }

    send(socket, {
      t: 'welcome',
      serverNow: Date.now(),
      studentId,
      name,
      room: roomInfo(room),
      lab: { ...room.lab, exercises: room.lab.exercises.map(({ hints: _h, ...rest }) => rest) },
      hints,
      progress,
    });

    await chain(async () => {
      if (!roomLive || socket.readyState !== socket.OPEN) return;
      countedPresence = true;
      const n = await bus.presence(studentId, 1);
      if (n === 1) await append(room.id, 'presence', studentId, { online: true });
    });
  }

  /* ---------------------------------------------------------------- static */

  const indexHtml = config.webDist ? path.join(config.webDist, 'index.html') : '';
  if (indexHtml && fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: true,
      index: false,
      // Serve the .br / .gz files made at build time when the browser accepts them.
      preCompressed: true,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.includes(`${path.sep}pyodide${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=86400');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
    const html = fs.readFileSync(indexHtml, 'utf8');
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.header('Cache-Control', 'no-cache').type('text/html').send(html);
    });
    app.get('/', (_req, reply) => reply.header('Cache-Control', 'no-cache').type('text/html').send(html));
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'Not found' }));
  }

  return app;
}

function sameSecret(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

// A real scrypt hash of a random string; used to equalize login timing for unknown emails.
const DUMMY_HASH =
  'scrypt$16384$c2FsdHNhbHRzYWx0c2FsdA==$4cJhbVXWMB8Q8mMw3wPtl1T1b9dD7cPS9t8kQyJt0aI=';
