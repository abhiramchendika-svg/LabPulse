/**
 * Core domain types shared by the gateway, the dashboard and the student client.
 *
 * Privacy contract: the only things a student client ever sends are a RunSignal
 * (test results + a normalized error) and an ActivitySignal (which exercise they
 * are working on). Source code and keystrokes never leave the student's machine.
 */

export type RunResult = 'pass' | 'fail' | 'error';

/** One exercise inside a lab, as delivered to the browser. */
export interface Exercise {
  id: string;
  title: string;
  /** Markdown prompt shown to the student. */
  prompt: string;
  /** Python starter code. */
  starter: string;
  /** Python test module. Test functions are named test_* and import from `solution`. */
  tests: string;
  /** Optional instructor hint suggestions keyed by error type (e.g. "TypeError") or "fail:<test_name>". */
  hints?: Record<string, string>;
}

export interface LabDefinition {
  id: string;
  title: string;
  description: string;
  language: 'python';
  exercises: Exercise[];
}

/** What a student client sends after each run. Nothing else about the run leaves the laptop. */
export interface RunSignal {
  exerciseId: string;
  result: RunResult;
  testsPassed: number;
  testsTotal: number;
  /** Python exception class name, e.g. "TypeError". Null for a pass. */
  errorType: string | null;
  /** Normalized message: no file paths, line numbers, identifiers or literal values. */
  errorMessage: string | null;
  /** Name of the first failing test, when the run failed or errored inside a test. */
  failingTest: string | null;
}

export interface ActivitySignal {
  exerciseId: string;
}

export type RoomStatus = 'live' | 'ended';

export interface RoomInfo {
  id: string;
  code: string;
  title: string;
  labId: string;
  labTitle: string;
  stuckMinutes: number;
  status: RoomStatus;
  createdAt: number;
  endedAt: number | null;
  exercises: Pick<Exercise, 'id' | 'title'>[];
}

/* ------------------------------------------------------------------ events */

interface EventBase {
  /** Global, monotonically increasing sequence number (Postgres bigserial). */
  seq: number;
  /** Server timestamp, ms since epoch. All timing uses server time. */
  ts: number;
}

export interface StudentJoinedEvent extends EventBase {
  type: 'student_joined';
  studentId: string;
  payload: { name: string };
}

export interface PresenceEvent extends EventBase {
  type: 'presence';
  studentId: string;
  payload: { online: boolean };
}

export interface RunEvent extends EventBase {
  type: 'run';
  studentId: string;
  /** runId is the client's id for the run; the server uses it to ignore re-sent duplicates. */
  payload: RunSignal & { fingerprint: string | null; runId?: string };
}

export interface ActivityEvent extends EventBase {
  type: 'activity';
  studentId: string;
  payload: ActivitySignal;
}

export interface HintSentEvent extends EventBase {
  type: 'hint_sent';
  studentId: null;
  payload: {
    hintId: string;
    exerciseId: string;
    fingerprint: string;
    text: string;
    recipients: string[];
  };
}

export interface LabEndedEvent extends EventBase {
  type: 'lab_ended';
  studentId: null;
  payload: Record<string, never>;
}

export type RoomEvent =
  | StudentJoinedEvent
  | PresenceEvent
  | RunEvent
  | ActivityEvent
  | HintSentEvent
  | LabEndedEvent;

export type RoomEventType = RoomEvent['type'];
