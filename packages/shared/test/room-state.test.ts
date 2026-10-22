import { describe, expect, it } from 'vitest';
import { buildRoomState } from '../src/room-state.js';
import { buildReport } from '../src/report.js';
import { fingerprint } from '../src/fingerprint.js';
import type { RoomEvent, RunSignal } from '../src/types.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const config = {
  stuckMinutes: 4,
  exercises: [
    { id: 'ex1', title: 'Average' },
    { id: 'ex2', title: 'Word count' },
    { id: 'ex3', title: 'FizzBuzz' },
  ],
};

class Log {
  events: RoomEvent[] = [];
  seq = 0;
  join(id: string, at: number, name = id) {
    this.events.push({ seq: ++this.seq, ts: T0 + at, type: 'student_joined', studentId: id, payload: { name } });
  }
  run(id: string, at: number, sig: Partial<RunSignal> & { exerciseId: string; result: RunSignal['result'] }) {
    const s: RunSignal = {
      testsPassed: sig.result === 'pass' ? 3 : 1,
      testsTotal: 3,
      errorType: null,
      errorMessage: null,
      failingTest: null,
      ...sig,
    };
    this.events.push({ seq: ++this.seq, ts: T0 + at, type: 'run', studentId: id, payload: { ...s, fingerprint: fingerprint(s) } });
  }
  typeErr(id: string, at: number, ex = 'ex2') {
    this.run(id, at, { exerciseId: ex, result: 'error', errorType: 'TypeError', errorMessage: "unsupported operand type(s) for +: 'int' and 'str'" });
  }
  nameErr(id: string, at: number, ex = 'ex2') {
    this.run(id, at, { exerciseId: ex, result: 'error', errorType: 'NameError', errorMessage: "name 'cnt' is not defined" });
  }
  pass(id: string, at: number, ex: string) {
    this.run(id, at, { exerciseId: ex, result: 'pass' });
  }
  activity(id: string, at: number, ex: string) {
    this.events.push({ seq: ++this.seq, ts: T0 + at, type: 'activity', studentId: id, payload: { exerciseId: ex } });
  }
  hint(at: number, fp: string, recipients: string[], ex = 'ex2') {
    this.events.push({
      seq: ++this.seq,
      ts: T0 + at,
      type: 'hint_sent',
      studentId: null,
      payload: { hintId: `h${this.seq}`, exerciseId: ex, fingerprint: fp, text: 'Convert with int()', recipients },
    });
  }
  end(at: number) {
    this.events.push({ seq: ++this.seq, ts: T0 + at, type: 'lab_ended', studentId: null, payload: {} });
  }
}

const TYPE_FP = fingerprint({
  exerciseId: 'ex2',
  result: 'error',
  errorType: 'TypeError',
  errorMessage: "unsupported operand type(s) for +: 'int' and 'str'",
  failingTest: null,
})!;

describe('buildRoomState', () => {
  it('groups students on the same error and shrinks the group as they fix it', () => {
    const log = new Log();
    for (const s of ['a', 'b', 'c', 'd']) log.join(s, 0);
    log.typeErr('a', 1 * MIN);
    log.typeErr('b', 2 * MIN);
    log.typeErr('c', 3 * MIN);
    log.nameErr('d', 3 * MIN);

    let st = buildRoomState(log.events, config, T0 + 4 * MIN);
    expect(st.groups).toHaveLength(2);
    expect(st.groups[0]!.fingerprint).toBe(TYPE_FP);
    expect(st.groups[0]!.studentIds).toEqual(['a', 'b', 'c']); // longest-waiting first
    expect(st.groups[0]!.peakSize).toBe(3);

    log.hint(4 * MIN, TYPE_FP, ['a', 'b', 'c']);
    log.pass('a', 5 * MIN, 'ex2');
    log.pass('b', 5.5 * MIN, 'ex2');

    st = buildRoomState(log.events, config, T0 + 6 * MIN);
    const g = st.groups.find((x) => x.fingerprint === TYPE_FP)!;
    expect(g.studentIds).toEqual(['c']);
    expect(g.peakSize).toBe(3);
    expect(g.everAffected).toBe(3);
    expect(g.hints[0]!.recipients).toHaveLength(3);
    expect(g.hints[0]!.stillInGroup).toBe(1);
    expect(g.hints[0]!.resolved).toBe(2);
    expect(st.studentsById.a!.hintIds).toHaveLength(1);
  });

  it('moves a student between groups when their error changes', () => {
    const log = new Log();
    log.join('a', 0);
    log.typeErr('a', 1 * MIN);
    log.nameErr('a', 2 * MIN);
    const st = buildRoomState(log.events, config, T0 + 3 * MIN);
    expect(st.groups).toHaveLength(1);
    expect(st.groups[0]!.errorType).toBe('NameError');
    // The failing streak started at the first error, not the latest one.
    expect(st.groups[0]!.memberSince.a).toBe(T0 + 1 * MIN);
  });

  it('flags error-stuck after N minutes without a passing run, even while still running code', () => {
    const log = new Log();
    log.join('a', 0);
    log.typeErr('a', 1 * MIN);
    log.typeErr('a', 3 * MIN);
    log.typeErr('a', 4.9 * MIN);
    expect(buildRoomState(log.events, config, T0 + 4.9 * MIN).studentsById.a!.stuck).toBeNull();
    const st = buildRoomState(log.events, config, T0 + 5 * MIN);
    expect(st.studentsById.a!.stuck).toEqual({ kind: 'error', exerciseId: 'ex2', since: T0 + 1 * MIN, fingerprint: TYPE_FP });
    expect(st.totals.stuckOnError).toBe(1);
  });

  it('clears stuck when the student passes', () => {
    const log = new Log();
    log.join('a', 0);
    log.typeErr('a', 1 * MIN);
    log.pass('a', 6 * MIN, 'ex2');
    const st = buildRoomState(log.events, config, T0 + 7 * MIN);
    expect(st.studentsById.a!.stuck).toBeNull();
    expect(st.groups).toHaveLength(0);
  });

  it('flags idle students with no activity, but editing counts as activity', () => {
    const log = new Log();
    log.join('a', 0);
    log.join('b', 0);
    log.activity('b', 3 * MIN, 'ex1');
    const st = buildRoomState(log.events, config, T0 + 5 * MIN);
    expect(st.studentsById.a!.stuck).toEqual({ kind: 'idle', exerciseId: null, since: T0 });
    expect(st.studentsById.b!.stuck).toBeNull();
    expect(st.totals.idle).toBe(1);
  });

  it('never flags a student who finished everything', () => {
    const log = new Log();
    log.join('a', 0);
    for (const ex of ['ex1', 'ex2', 'ex3']) log.pass('a', 1 * MIN, ex);
    const st = buildRoomState(log.events, config, T0 + 60 * MIN);
    expect(st.studentsById.a!.finishedAll).toBe(true);
    expect(st.studentsById.a!.stuck).toBeNull();
  });

  it('computes per-exercise progress from the latest run', () => {
    const log = new Log();
    for (const s of ['a', 'b', 'c']) log.join(s, 0);
    log.pass('a', 1 * MIN, 'ex1');
    log.typeErr('b', 1 * MIN, 'ex1');
    log.pass('c', 1 * MIN, 'ex1');
    log.typeErr('c', 2 * MIN, 'ex1'); // broke it again: latest status failing, but ever passed
    const st = buildRoomState(log.events, config, T0 + 3 * MIN);
    expect(st.progress[0]).toMatchObject({ exerciseId: 'ex1', notStarted: 0, failing: 2, passing: 1, everPassed: 2 });
    expect(st.progress[1]).toMatchObject({ notStarted: 3, failing: 0, passing: 0 });
  });

  it('ignores events after the lab ends and stops stuck timers', () => {
    const log = new Log();
    log.join('a', 0);
    log.typeErr('a', 1 * MIN);
    log.end(2 * MIN);
    log.pass('a', 3 * MIN, 'ex2');
    const st = buildRoomState(log.events, config, T0 + 100 * MIN);
    expect(st.ended).toBe(true);
    expect(st.now).toBe(T0 + 2 * MIN);
    expect(st.studentsById.a!.exercises.ex2!.everPassed).toBe(false);
    expect(st.studentsById.a!.stuck).toBeNull();
  });

  it('is independent of event arrival order (sorted by seq)', () => {
    const log = new Log();
    for (const s of ['a', 'b']) log.join(s, 0);
    log.typeErr('a', 1 * MIN);
    log.pass('a', 2 * MIN, 'ex2');
    log.typeErr('b', 2 * MIN);
    const shuffled = [...log.events].reverse();
    expect(buildRoomState(shuffled, config, T0 + 5 * MIN)).toEqual(buildRoomState(log.events, config, T0 + 5 * MIN));
  });

  it('ignores runs for unknown exercises', () => {
    const log = new Log();
    log.join('a', 0);
    log.typeErr('a', 1 * MIN, 'nope');
    const st = buildRoomState(log.events, config, T0 + 2 * MIN);
    expect(st.groups).toHaveLength(0);
    expect(st.totals.runs).toBe(0);
  });
});

describe('buildReport', () => {
  // The 5-minute demo: 10 students, planted bug in exercise 2.
  function demo() {
    const log = new Log();
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    ids.forEach((s) => log.join(s, 0, s.toUpperCase()));
    ids.forEach((s) => log.pass(s, 2 * MIN, 'ex1'));
    // 9 hit the TypeError on ex2, one passes straight away.
    ids.slice(0, 9).forEach((s, i) => log.typeErr(s, 3 * MIN + i * 1000));
    log.pass('s9', 3 * MIN, 'ex2');
    log.hint(8 * MIN, TYPE_FP, ids.slice(0, 9));
    // 7 recover within 5 minutes of the hint, 2 never do.
    ids.slice(0, 7).forEach((s, i) => log.pass(s, 9 * MIN + i * 1000, 'ex2'));
    // 3 move on and finish ex3.
    ['s0', 's1', 's9'].forEach((s) => log.pass(s, 12 * MIN, 'ex3'));
    log.end(20 * MIN);
    return log;
  }

  it('finds the exercise that lost the class', () => {
    const r = buildReport(demo().events, config, T0 + 30 * MIN);
    expect(r.studentCount).toBe(10);
    expect(r.exercises.map((e) => [e.exerciseId, e.attempted, e.finished])).toEqual([
      ['ex1', 10, 10],
      ['ex2', 10, 8],
      ['ex3', 3, 3],
    ]);
    expect(r.lostTheClass?.exerciseId).toBe('ex2');
    expect(r.lostTheClass?.lostStudents).toBe(2);
    expect(r.lostTheClass?.didNotFinishRate).toBeCloseTo(0.2);
    expect(r.exercises[1]!.completionRate).toBeCloseTo(0.8);
    expect(r.finishedAll).toBe(3);
  });

  it('ranks top errors by students affected', () => {
    const r = buildReport(demo().events, config, T0 + 30 * MIN);
    expect(r.topErrors).toHaveLength(1);
    expect(r.topErrors[0]).toMatchObject({ fingerprint: TYPE_FP, students: 9, occurrences: 9, recovered: 7, errorType: 'TypeError' });
  });

  it('measures stuck time and recovery', () => {
    const r = buildReport(demo().events, config, T0 + 30 * MIN);
    // 7 recovered streaks of ~6 minutes, 2 unrecovered streaks closed at lab end (~17 min).
    expect(r.recovery.samples).toBe(7);
    expect(r.recovery.unrecovered).toBe(2);
    expect(r.recovery.medianMs).toBe(6 * MIN); // s3: 3m+3s -> 9m+3s
    expect(r.stuck.studentsEverStuck).toBe(9); // every streak >= 4 minutes
    expect(r.exercises[1]!.stuckStudents).toBe(9);
    const s8 = r.students.find((s) => s.id === 's8')!;
    expect(s8.stuckMs).toBe(20 * MIN - (3 * MIN + 8000));
  });

  it('measures hint effect', () => {
    const r = buildReport(demo().events, config, T0 + 30 * MIN);
    expect(r.hints).toHaveLength(1);
    expect(r.hints[0]).toMatchObject({ recipients: 9, passedWithin5m: 7, passedByEnd: 7, exerciseTitle: 'Word count' });
  });

  it('handles an empty lab', () => {
    const r = buildReport([], config, T0);
    expect(r.studentCount).toBe(0);
    expect(r.lostTheClass).toBeNull();
    expect(r.recovery.medianMs).toBeNull();
    expect(r.durationMs).toBe(0);
  });

  it('does not count stuck streaks shorter than the threshold', () => {
    const log = new Log();
    log.join('a', 0);
    log.typeErr('a', 1 * MIN);
    log.pass('a', 3 * MIN, 'ex2');
    log.end(10 * MIN);
    const r = buildReport(log.events, config, T0 + 10 * MIN);
    expect(r.stuck.totalMs).toBe(0);
    expect(r.recovery.medianMs).toBe(2 * MIN);
  });
});
