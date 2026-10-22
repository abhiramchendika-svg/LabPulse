/**
 * Live room state, derived purely from the event log.
 *
 * The gateway stores events; it never keeps per-user state in memory. The dashboard
 * (and the gateway, when it needs to know who is in a group) replays the log through
 * buildRoomState(). Because it's a pure function of (events, config, now), the same
 * numbers appear on the dashboard, in hint targeting and in the post-lab report.
 */

import type { RoomEvent, RunResult } from './types.js';

export interface RoomConfig {
  stuckMinutes: number;
  exercises: { id: string; title: string }[];
}

export type ExerciseStatus = 'not_started' | 'failing' | 'passing';

export interface StudentExerciseState {
  status: ExerciseStatus;
  everPassed: boolean;
  runs: number;
  lastResult: RunResult | null;
  lastFingerprint: string | null;
  lastRunAt: number | null;
  firstRunAt: number | null;
  firstPassAt: number | null;
  /** Start of the current run of non-passing results; null if the latest run passed. */
  failingSince: number | null;
  testsPassed: number;
  testsTotal: number;
}

export type StuckInfo =
  | { kind: 'error'; exerciseId: string; since: number; fingerprint: string | null }
  | { kind: 'idle'; exerciseId: string | null; since: number };

export interface StudentState {
  id: string;
  name: string;
  joinedAt: number;
  online: boolean;
  /** Last time the student did something: joined, ran code or edited. */
  lastActiveAt: number;
  lastRunAt: number | null;
  /** The exercise of the student's most recent run or edit. */
  currentExerciseId: string | null;
  exercises: Record<string, StudentExerciseState>;
  hintIds: string[];
  finishedCount: number;
  finishedAll: boolean;
  stuck: StuckInfo | null;
}

export interface HintState {
  hintId: string;
  text: string;
  sentAt: number;
  exerciseId: string;
  fingerprint: string;
  recipients: string[];
  /** Recipients still in the group right now. */
  stillInGroup: number;
  /** Recipients who have passed the exercise since the hint was sent. */
  resolved: number;
}

export interface ErrorGroup {
  fingerprint: string;
  exerciseId: string;
  result: Exclude<RunResult, 'pass'>;
  errorType: string | null;
  errorMessage: string | null;
  failingTest: string | null;
  /** Students whose latest run on this exercise has this fingerprint, longest-waiting first. */
  studentIds: string[];
  /** For each current member, when their current failing streak started. */
  memberSince: Record<string, number>;
  firstSeenAt: number;
  lastSeenAt: number;
  peakSize: number;
  /** Distinct students who have ever hit this fingerprint. */
  everAffected: number;
  occurrences: number;
  hints: HintState[];
}

export interface ExerciseProgress {
  exerciseId: string;
  title: string;
  notStarted: number;
  failing: number;
  passing: number;
  everPassed: number;
}

export interface RoomState {
  now: number;
  ended: boolean;
  endedAt: number | null;
  stuckMs: number;
  students: StudentState[];
  studentsById: Record<string, StudentState>;
  /** Groups with at least one current member, largest first. */
  groups: ErrorGroup[];
  /** Every group ever seen, including empty ones (for reports). */
  allGroups: Record<string, ErrorGroup>;
  progress: ExerciseProgress[];
  hints: HintState[];
  totals: {
    students: number;
    online: number;
    stuck: number;
    stuckOnError: number;
    idle: number;
    finishedAll: number;
    runs: number;
  };
}

function emptyExerciseState(): StudentExerciseState {
  return {
    status: 'not_started',
    everPassed: false,
    runs: 0,
    lastResult: null,
    lastFingerprint: null,
    lastRunAt: null,
    firstRunAt: null,
    firstPassAt: null,
    failingSince: null,
    testsPassed: 0,
    testsTotal: 0,
  };
}

/** Sort events into the order the server assigned them. */
export function sortEvents<T extends { seq: number }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

export function buildRoomState(
  rawEvents: readonly RoomEvent[],
  config: RoomConfig,
  now: number,
): RoomState {
  const events = sortEvents(rawEvents);
  const stuckMs = Math.max(0, config.stuckMinutes) * 60_000;
  const exerciseIds = config.exercises.map((e) => e.id);
  const knownExercise = new Set(exerciseIds);

  const students = new Map<string, StudentState>();
  const groups = new Map<string, ErrorGroup>();
  const groupMembers = new Map<string, Set<string>>();
  const groupEver = new Map<string, Set<string>>();
  const hints: HintState[] = [];
  let endedAt: number | null = null;
  let runs = 0;

  const ensureStudent = (id: string, ts: number, name?: string): StudentState => {
    let s = students.get(id);
    if (!s) {
      s = {
        id,
        name: name ?? 'Student',
        joinedAt: ts,
        online: false,
        lastActiveAt: ts,
        lastRunAt: null,
        currentExerciseId: null,
        exercises: Object.fromEntries(exerciseIds.map((x) => [x, emptyExerciseState()])),
        hintIds: [],
        finishedCount: 0,
        finishedAll: false,
        stuck: null,
      };
      students.set(id, s);
    }
    return s;
  };

  for (const ev of events) {
    // After the lab ends nothing changes the record.
    if (endedAt !== null) break;

    switch (ev.type) {
      case 'student_joined': {
        const s = ensureStudent(ev.studentId, ev.ts, ev.payload.name);
        s.name = ev.payload.name;
        s.online = true;
        break;
      }
      case 'presence': {
        const s = ensureStudent(ev.studentId, ev.ts);
        s.online = ev.payload.online;
        break;
      }
      case 'activity': {
        if (!knownExercise.has(ev.payload.exerciseId)) break;
        const s = ensureStudent(ev.studentId, ev.ts);
        s.lastActiveAt = Math.max(s.lastActiveAt, ev.ts);
        s.currentExerciseId = ev.payload.exerciseId;
        break;
      }
      case 'run': {
        const p = ev.payload;
        if (!knownExercise.has(p.exerciseId)) break;
        runs++;
        const s = ensureStudent(ev.studentId, ev.ts);
        const ex = s.exercises[p.exerciseId] ?? (s.exercises[p.exerciseId] = emptyExerciseState());
        s.lastActiveAt = Math.max(s.lastActiveAt, ev.ts);
        s.lastRunAt = ev.ts;
        s.currentExerciseId = p.exerciseId;

        // Leave the previous group for this exercise.
        if (ex.lastFingerprint) {
          const members = groupMembers.get(ex.lastFingerprint);
          const g = groups.get(ex.lastFingerprint);
          members?.delete(s.id);
          if (g) delete g.memberSince[s.id];
        }

        ex.runs++;
        ex.lastResult = p.result;
        ex.lastRunAt = ev.ts;
        ex.firstRunAt ??= ev.ts;
        ex.testsPassed = p.testsPassed;
        ex.testsTotal = p.testsTotal;

        if (p.result === 'pass') {
          ex.status = 'passing';
          ex.lastFingerprint = null;
          ex.failingSince = null;
          if (!ex.everPassed) {
            ex.everPassed = true;
            ex.firstPassAt = ev.ts;
          }
        } else {
          ex.status = 'failing';
          ex.failingSince ??= ev.ts;
          const fp = p.fingerprint;
          ex.lastFingerprint = fp;
          if (fp) {
            let g = groups.get(fp);
            if (!g) {
              g = {
                fingerprint: fp,
                exerciseId: p.exerciseId,
                result: p.result,
                errorType: p.errorType,
                errorMessage: p.errorMessage,
                failingTest: p.failingTest,
                studentIds: [],
                memberSince: {},
                firstSeenAt: ev.ts,
                lastSeenAt: ev.ts,
                peakSize: 0,
                everAffected: 0,
                occurrences: 0,
                hints: [],
              };
              groups.set(fp, g);
              groupMembers.set(fp, new Set());
              groupEver.set(fp, new Set());
            }
            g.lastSeenAt = ev.ts;
            g.occurrences++;
            const members = groupMembers.get(fp)!;
            members.add(s.id);
            g.memberSince[s.id] = ex.failingSince;
            g.peakSize = Math.max(g.peakSize, members.size);
            groupEver.get(fp)!.add(s.id);
          }
        }
        break;
      }
      case 'hint_sent': {
        const p = ev.payload;
        const h: HintState = {
          hintId: p.hintId,
          text: p.text,
          sentAt: ev.ts,
          exerciseId: p.exerciseId,
          fingerprint: p.fingerprint,
          recipients: [...p.recipients],
          stillInGroup: 0,
          resolved: 0,
        };
        hints.push(h);
        groups.get(p.fingerprint)?.hints.push(h);
        for (const r of p.recipients) students.get(r)?.hintIds.push(p.hintId);
        break;
      }
      case 'lab_ended': {
        endedAt = ev.ts;
        break;
      }
    }
  }

  const effectiveNow = endedAt ?? now;
  const ended = endedAt !== null;

  // Finalize groups.
  for (const [fp, g] of groups) {
    const members = groupMembers.get(fp)!;
    g.studentIds = [...members].sort(
      (a, b) => (g.memberSince[a] ?? 0) - (g.memberSince[b] ?? 0) || a.localeCompare(b),
    );
    g.everAffected = groupEver.get(fp)!.size;
  }

  // Finalize hints (needs final group membership and pass times).
  for (const h of hints) {
    const members = groupMembers.get(h.fingerprint) ?? new Set<string>();
    h.stillInGroup = h.recipients.filter((r) => members.has(r)).length;
    h.resolved = h.recipients.filter((r) => {
      const ex = students.get(r)?.exercises[h.exerciseId];
      return !!ex && ex.lastResult === 'pass' && ex.lastRunAt !== null && ex.lastRunAt >= h.sentAt;
    }).length;
  }

  // Finalize students: finished counts and stuck flags.
  let online = 0;
  let stuckOnError = 0;
  let idle = 0;
  let finishedAll = 0;
  for (const s of students.values()) {
    s.finishedCount = exerciseIds.filter((x) => s.exercises[x]?.everPassed).length;
    s.finishedAll = exerciseIds.length > 0 && s.finishedCount === exerciseIds.length;
    if (s.online) online++;
    if (s.finishedAll) finishedAll++;
    s.stuck = ended ? null : computeStuck(s, effectiveNow, stuckMs);
    if (s.stuck?.kind === 'error') stuckOnError++;
    if (s.stuck?.kind === 'idle') idle++;
  }

  const studentList = [...students.values()].sort(
    (a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id),
  );

  const progress: ExerciseProgress[] = config.exercises.map((e) => {
    const p: ExerciseProgress = {
      exerciseId: e.id,
      title: e.title,
      notStarted: 0,
      failing: 0,
      passing: 0,
      everPassed: 0,
    };
    for (const s of studentList) {
      const ex = s.exercises[e.id];
      if (!ex || ex.status === 'not_started') p.notStarted++;
      else if (ex.status === 'failing') p.failing++;
      else p.passing++;
      if (ex?.everPassed) p.everPassed++;
    }
    return p;
  });

  const exerciseOrder = new Map(exerciseIds.map((id, i) => [id, i]));
  const liveGroups = [...groups.values()]
    .filter((g) => g.studentIds.length > 0)
    .sort(
      (a, b) =>
        b.studentIds.length - a.studentIds.length ||
        (exerciseOrder.get(a.exerciseId) ?? 0) - (exerciseOrder.get(b.exerciseId) ?? 0) ||
        a.firstSeenAt - b.firstSeenAt,
    );

  return {
    now: effectiveNow,
    ended,
    endedAt,
    stuckMs,
    students: studentList,
    studentsById: Object.fromEntries(studentList.map((s) => [s.id, s])),
    groups: liveGroups,
    allGroups: Object.fromEntries(groups),
    progress,
    hints,
    totals: {
      students: studentList.length,
      online,
      stuck: stuckOnError + idle,
      stuckOnError,
      idle,
      finishedAll,
      runs,
    },
  };
}

function computeStuck(s: StudentState, now: number, stuckMs: number): StuckInfo | null {
  if (s.finishedAll) return null;
  const cur = s.currentExerciseId ? s.exercises[s.currentExerciseId] : undefined;
  if (cur && cur.status === 'failing' && cur.failingSince !== null && now - cur.failingSince >= stuckMs) {
    return {
      kind: 'error',
      exerciseId: s.currentExerciseId!,
      since: cur.failingSince,
      fingerprint: cur.lastFingerprint,
    };
  }
  if (now - s.lastActiveAt >= stuckMs) {
    return { kind: 'idle', exerciseId: s.currentExerciseId, since: s.lastActiveAt };
  }
  return null;
}
