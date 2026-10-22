/**
 * Post-lab report: which exercise lost the class, the top errors, and time spent stuck.
 * Pure function of the event log, like the live room state.
 */

import { buildRoomState, sortEvents, type RoomConfig } from './room-state.js';
import type { RoomEvent, RunEvent } from './types.js';

export const HINT_EFFECT_WINDOW_MS = 5 * 60_000;

export interface ExerciseReport {
  exerciseId: string;
  title: string;
  /** Students who ran this exercise at least once. */
  attempted: number;
  /** Students who passed it at least once. */
  finished: number;
  /** finished / all students in the lab. */
  completionRate: number;
  /** (attempted - finished) / attempted: of those who tried, the share who never got it. */
  didNotFinishRate: number;
  /** Median time from a student's first run to their first pass (finishers only). */
  medianTimeToPassMs: number | null;
  /** Students who had at least one stuck streak on this exercise. */
  stuckStudents: number;
  /** Total length of stuck streaks on this exercise. */
  stuckMs: number;
  runs: number;
}

export interface TopError {
  fingerprint: string;
  exerciseId: string;
  exerciseTitle: string;
  result: 'fail' | 'error';
  errorType: string | null;
  errorMessage: string | null;
  failingTest: string | null;
  students: number;
  occurrences: number;
  /** Of the students who hit it, how many went on to pass that exercise. */
  recovered: number;
}

export interface HintReport {
  hintId: string;
  text: string;
  exerciseId: string;
  exerciseTitle: string;
  fingerprint: string;
  sentAt: number;
  recipients: number;
  /** Recipients with a passing run on the exercise within 5 minutes of the hint. */
  passedWithin5m: number;
  /** Recipients who passed the exercise any time after the hint. */
  passedByEnd: number;
}

export interface StudentReport {
  id: string;
  name: string;
  finished: number;
  runs: number;
  stuckMs: number;
  hintsReceived: number;
}

export interface LabReport {
  generatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  stuckMinutes: number;
  studentCount: number;
  finishedAll: number;
  totalRuns: number;
  exercises: ExerciseReport[];
  /** The exercise with the highest did-not-finish rate among those who attempted it. */
  lostTheClass: (ExerciseReport & { lostStudents: number }) | null;
  topErrors: TopError[];
  stuck: {
    /** Sum of all stuck streaks. */
    totalMs: number;
    studentsEverStuck: number;
    /** Median of each stuck student's total stuck time. */
    medianPerStuckStudentMs: number | null;
  };
  /** Metric 1: time from first error to the next passing run, per recovered streak. */
  recovery: { medianMs: number | null; samples: number; unrecovered: number };
  hints: HintReport[];
  students: StudentReport[];
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

interface Streak {
  studentId: string;
  exerciseId: string;
  start: number;
  end: number;
  recovered: boolean;
}

export function buildReport(rawEvents: readonly RoomEvent[], config: RoomConfig, now: number): LabReport {
  const events = sortEvents(rawEvents);
  const state = buildRoomState(events, config, now);
  const end = state.endedAt ?? now;
  const stuckMs = state.stuckMs;
  const titles = new Map(config.exercises.map((e) => [e.id, e.title]));

  // Only events up to the end of the lab count.
  const counted = events.filter((e) => state.endedAt === null || e.ts <= state.endedAt);
  const runEvents = counted.filter((e): e is RunEvent => e.type === 'run' && titles.has(e.payload.exerciseId));
  const startedAt = counted.length > 0 ? counted[0]!.ts : null;

  // Failing streaks per (student, exercise): first non-pass -> next pass (or lab end).
  const open = new Map<string, Streak>();
  const streaks: Streak[] = [];
  for (const ev of runEvents) {
    const key = `${ev.studentId}\u0000${ev.payload.exerciseId}`;
    const cur = open.get(key);
    if (ev.payload.result === 'pass') {
      if (cur) {
        cur.end = ev.ts;
        cur.recovered = true;
        streaks.push(cur);
        open.delete(key);
      }
    } else if (!cur) {
      open.set(key, { studentId: ev.studentId, exerciseId: ev.payload.exerciseId, start: ev.ts, end: ev.ts, recovered: false });
    }
  }
  for (const s of open.values()) {
    s.end = Math.max(s.start, end);
    streaks.push(s);
  }

  const stuckStreaks = streaks.filter((s) => s.end - s.start >= stuckMs);
  const recoverySamples = streaks.filter((s) => s.recovered).map((s) => s.end - s.start);

  const stuckByStudent = new Map<string, number>();
  for (const s of stuckStreaks) stuckByStudent.set(s.studentId, (stuckByStudent.get(s.studentId) ?? 0) + (s.end - s.start));

  const studentCount = state.students.length;

  const exercises: ExerciseReport[] = config.exercises.map((e) => {
    let attempted = 0;
    let finished = 0;
    const timeToPass: number[] = [];
    for (const s of state.students) {
      const ex = s.exercises[e.id];
      if (!ex || ex.runs === 0) continue;
      attempted++;
      if (ex.everPassed) {
        finished++;
        if (ex.firstRunAt !== null && ex.firstPassAt !== null) timeToPass.push(ex.firstPassAt - ex.firstRunAt);
      }
    }
    const exStuck = stuckStreaks.filter((s) => s.exerciseId === e.id);
    return {
      exerciseId: e.id,
      title: e.title,
      attempted,
      finished,
      completionRate: studentCount === 0 ? 0 : finished / studentCount,
      didNotFinishRate: attempted === 0 ? 0 : (attempted - finished) / attempted,
      medianTimeToPassMs: median(timeToPass),
      stuckStudents: new Set(exStuck.map((s) => s.studentId)).size,
      stuckMs: exStuck.reduce((acc, s) => acc + (s.end - s.start), 0),
      runs: runEvents.filter((r) => r.payload.exerciseId === e.id).length,
    };
  });

  let lostTheClass: LabReport['lostTheClass'] = null;
  for (const ex of exercises) {
    const lost = ex.attempted - ex.finished;
    if (lost <= 0) continue;
    if (
      !lostTheClass ||
      ex.didNotFinishRate > lostTheClass.didNotFinishRate ||
      (ex.didNotFinishRate === lostTheClass.didNotFinishRate && lost > lostTheClass.lostStudents)
    ) {
      lostTheClass = { ...ex, lostStudents: lost };
    }
  }

  const topErrors: TopError[] = Object.values(state.allGroups)
    .map((g) => {
      // Students who hit this fingerprint at any point.
      const hitBy = new Set(runEvents.filter((r) => r.payload.fingerprint === g.fingerprint).map((r) => r.studentId));
      const recovered = [...hitBy].filter((id) => state.studentsById[id]?.exercises[g.exerciseId]?.everPassed).length;
      return {
        fingerprint: g.fingerprint,
        exerciseId: g.exerciseId,
        exerciseTitle: titles.get(g.exerciseId) ?? g.exerciseId,
        result: g.result,
        errorType: g.errorType,
        errorMessage: g.errorMessage,
        failingTest: g.failingTest,
        students: g.everAffected,
        occurrences: g.occurrences,
        recovered,
      };
    })
    .sort((a, b) => b.students - a.students || b.occurrences - a.occurrences || a.fingerprint.localeCompare(b.fingerprint))
    .slice(0, 5);

  const hints: HintReport[] = state.hints.map((h) => {
    let within = 0;
    let byEnd = 0;
    for (const r of h.recipients) {
      const passes = runEvents.filter(
        (ev) => ev.studentId === r && ev.payload.exerciseId === h.exerciseId && ev.payload.result === 'pass' && ev.ts >= h.sentAt,
      );
      if (passes.length > 0) byEnd++;
      if (passes.some((p) => p.ts - h.sentAt <= HINT_EFFECT_WINDOW_MS)) within++;
    }
    return {
      hintId: h.hintId,
      text: h.text,
      exerciseId: h.exerciseId,
      exerciseTitle: titles.get(h.exerciseId) ?? h.exerciseId,
      fingerprint: h.fingerprint,
      sentAt: h.sentAt,
      recipients: h.recipients.length,
      passedWithin5m: within,
      passedByEnd: byEnd,
    };
  });

  const students: StudentReport[] = state.students.map((s) => ({
    id: s.id,
    name: s.name,
    finished: s.finishedCount,
    runs: Object.values(s.exercises).reduce((acc, e) => acc + e.runs, 0),
    stuckMs: stuckByStudent.get(s.id) ?? 0,
    hintsReceived: s.hintIds.length,
  }));

  return {
    generatedAt: now,
    startedAt,
    endedAt: state.endedAt,
    durationMs: startedAt === null ? 0 : Math.max(0, end - startedAt),
    stuckMinutes: config.stuckMinutes,
    studentCount,
    finishedAll: state.totals.finishedAll,
    totalRuns: runEvents.length,
    exercises,
    lostTheClass,
    topErrors,
    stuck: {
      totalMs: stuckStreaks.reduce((acc, s) => acc + (s.end - s.start), 0),
      studentsEverStuck: stuckByStudent.size,
      medianPerStuckStudentMs: median([...stuckByStudent.values()]),
    },
    recovery: {
      medianMs: median(recoverySamples),
      samples: recoverySamples.length,
      unrecovered: streaks.filter((s) => !s.recovered).length,
    },
    hints,
    students,
  };
}
