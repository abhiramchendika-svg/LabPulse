import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  explainError,
  normalizeErrorType,
  normalizeMessage,
  normalizeTestName,
  type LabDefinition,
  type RoomInfo,
  type RunSignal,
  type StudentHint,
} from '@labpulse/shared';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';
import { CodeEditor, resetModel, type CodeEditorHandle } from '../components/CodeEditor';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toasts';
import { PythonRunner, type RunSummary } from '../runner/python-runner';
import { api } from '../lib/api';
import { LiveSocket, type SocketStatus } from '../lib/socket';
import { getItem, getJson, removeItem, setItem, STUDENT_KEY, type StudentSession } from '../lib/storage';
import { useDocumentTitle } from '../lib/hooks';
import { timeOfDay } from '../lib/format';

type Status = 'not_started' | 'failing' | 'passing';

interface SentRecord {
  id: string;
  at: number;
  payload: { t: 'run'; signal: RunSignal } | { t: 'activity'; signal: { exerciseId: string } };
}

const ACTIVITY_EVERY_MS = 30_000;

function humanTest(name: string) {
  return name.replace(/^test_/, '').replace(/_/g, ' ');
}

export function StudentLabPage() {
  const session = getJson<StudentSession>(STUDENT_KEY);
  if (!session) return <Navigate to="/" replace />;
  return <StudentLab session={session} />;
}

function StudentLab({ session }: { session: StudentSession }) {
  const toast = useToast();
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [lab, setLab] = useState<LabDefinition | null>(null);
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [invalid, setInvalid] = useState(false);
  const [ended, setEnded] = useState(false);
  const [hints, setHints] = useState<StudentHint[]>([]);
  const [freshHint, setFreshHint] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Status>>({});
  const [current, setCurrent] = useState<string>(() => getItem(`lp_current:${session.roomId}`) ?? '');
  const [results, setResults] = useState<Record<string, RunSummary & { stale?: boolean }>>({});
  const [running, setRunning] = useState(false);
  const [runnerState, setRunnerState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [sent, setSent] = useState<SentRecord[]>([]);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const sock = useRef<LiveSocket | null>(null);
  const runner = useRef<PythonRunner | null>(null);
  const pending = useRef(new Map<string, RunSignal>());
  const lastActivity = useRef({ exerciseId: '', at: 0 });
  const editorHandle = useRef<CodeEditorHandle | null>(null);
  const welcomed = useRef(false);
  const endedRef = useRef(false);

  useDocumentTitle(lab ? lab.title : 'Lab');

  const codeKey = (exId: string) => `lp_code:${session.roomId}:${exId}`;

  /* ----------------------------------------------------------- connection */

  // Runs are kept until the server acknowledges them, and re-sent after a reconnect,
  // so a flaky lab network never silently drops a result.
  const sendRun = useCallback((id: string, signal: RunSignal) => {
    if (welcomed.current && sock.current?.send({ t: 'run', id, signal })) {
      setSent((s) => (s.some((r) => r.id === id) ? s : [{ id, at: Date.now(), payload: { t: 'run' as const, signal } }, ...s].slice(0, 30)));
    }
  }, []);

  const transmit = useCallback(
    (payload: SentRecord['payload']) => {
      if (endedRef.current) return;
      if (payload.t === 'run') {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        pending.current.set(id, payload.signal);
        sendRun(id, payload.signal);
        return;
      }
      if (welcomed.current && sock.current?.send(payload)) {
        setSent((s) => [{ id: `a${Date.now()}`, at: Date.now(), payload }, ...s].slice(0, 30));
      }
    },
    [sendRun],
  );

  useEffect(() => {
    let r: PythonRunner | null = null;
    let cancelled = false;
    api<{ pyodideUrl?: string | null }>('GET', '/api/config')
      .catch(() => ({ pyodideUrl: null }))
      .then((cfg) => {
        if (cancelled) return;
        r = new PythonRunner(cfg.pyodideUrl ? [cfg.pyodideUrl] : []);
        r.onStatus = setRunnerState;
        runner.current = r;
        r.whenReady().then(
          () => setRunnerState('ready'),
          () => setRunnerState('failed'),
        );
      });
    return () => {
      cancelled = true;
      r?.dispose();
    };
  }, []);

  useEffect(() => {
    const s = new LiveSocket({
      path: '/ws/student',
      hello: () => ({ t: 'hello', token: session.token }),
      onStatus: (st) => {
        setStatus(st);
        if (st !== 'open') welcomed.current = false;
      },
      fatalCodes: [4401],
      onFatal: () => setInvalid(true),
      onMessage: (m) => {
        if (m.t === 'welcome') {
          welcomed.current = true;
          setRoom(m.room);
          setLab(m.lab);
          setHints([...m.hints].reverse());
          setProgress(m.progress);
          const isEnded = m.room.status === 'ended';
          endedRef.current = isEnded;
          setEnded(isEnded);
          setCurrent((c) => (c && m.lab.exercises.some((e) => e.id === c) ? c : m.lab.exercises[0]?.id ?? ''));
          // Re-send runs the server hasn't acknowledged yet, oldest first.
          if (isEnded) pending.current.clear();
          for (const [id, signal] of pending.current) sendRun(id, signal);
        } else if (m.t === 'ack') {
          pending.current.delete(m.id);
        } else if (m.t === 'hint') {
          setHints((h) => (h.some((x) => x.hintId === m.hint.hintId) ? h : [m.hint, ...h]));
          setFreshHint(m.hint.hintId);
          toast('New hint from your instructor');
        } else if (m.t === 'lab_ended') {
          endedRef.current = true;
          pending.current.clear();
          setEnded(true);
        }
      },
    });
    sock.current = s;
    return () => s.close();
  }, [session.token, sendRun, toast]);

  useEffect(() => {
    if (current) setItem(`lp_current:${session.roomId}`, current);
  }, [current, session.roomId]);

  /* ------------------------------------------------------------- exercise */

  const exercise = lab?.exercises.find((e) => e.id === current) ?? lab?.exercises[0];
  const exerciseIndex = lab && exercise ? lab.exercises.indexOf(exercise) : 0;
  const result = exercise ? results[exercise.id] : undefined;

  const initialCode = useMemo(() => {
    if (!exercise) return '';
    return getItem(codeKey(exercise.id)) ?? exercise.starter;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise?.id]);

  const sendActivity = useCallback(
    (exerciseId: string) => {
      const now = Date.now();
      if (lastActivity.current.exerciseId === exerciseId && now - lastActivity.current.at < ACTIVITY_EVERY_MS) return;
      lastActivity.current = { exerciseId, at: now };
      transmit({ t: 'activity', signal: { exerciseId } });
    },
    [transmit],
  );

  const onCodeChange = useCallback(
    (value: string) => {
      if (!exercise) return;
      setItem(codeKey(exercise.id), value);
      sendActivity(exercise.id);
      setResults((r) => {
        const cur = r[exercise.id];
        return cur && !cur.stale ? { ...r, [exercise.id]: { ...cur, stale: true } } : r;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exercise?.id, sendActivity],
  );

  const run = useCallback(async () => {
    if (!exercise || !runner.current || running) return;
    setRunning(true);
    const code = getItem(codeKey(exercise.id)) ?? exercise.starter;
    try {
      const summary = await runner.current.run(code, exercise.tests);
      setResults((r) => ({ ...r, [exercise.id]: summary }));
      setProgress((p) => ({ ...p, [exercise.id]: summary.result === 'pass' ? 'passing' : 'failing' }));
      const pass = summary.result === 'pass';
      // The only thing that leaves this laptop about a run:
      const signal: RunSignal = {
        exerciseId: exercise.id,
        result: summary.result,
        testsPassed: summary.testsPassed,
        testsTotal: summary.testsTotal,
        errorType: pass ? null : normalizeErrorType(summary.errorType),
        errorMessage: pass ? null : normalizeMessage(summary.errorMessage),
        failingTest: pass ? null : normalizeTestName(summary.failingTest),
      };
      transmit({ t: 'run', signal });
      lastActivity.current = { exerciseId: exercise.id, at: Date.now() };
    } catch (err) {
      toast(`Couldn't run your code: ${(err as Error).message}`, 'error');
    } finally {
      setRunning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise?.id, running, transmit, toast]);

  const switchTo = (id: string) => {
    setCurrent(id);
    sendActivity(id);
  };

  const resetCode = () => {
    if (!exercise) return;
    removeItem(codeKey(exercise.id));
    resetModel(`${session.roomId}:${exercise.id}`, exercise.starter);
    setResults((r) => {
      const n = { ...r };
      delete n[exercise.id];
      return n;
    });
    setConfirmReset(false);
  };

  /* --------------------------------------------------------------- render */

  if (invalid) {
    removeItem(STUDENT_KEY);
    return (
      <div className="page-center">
        <div className="empty-card">
          <h1>This lab session isn't available any more</h1>
          <p>Join again with the room code on the screen.</p>
          <Link className="btn btn-primary" to="/">
            Join a lab
          </Link>
        </div>
      </div>
    );
  }

  if (!lab || !exercise || !room) {
    return (
      <div className="page-center">
        <div className="loading-block">
          <div className="spinner" />
          <p>{status === 'reconnecting' ? 'Trying to reach the lab server…' : 'Opening your lab…'}</p>
        </div>
      </div>
    );
  }

  const latestHint = hints.find((h) => h.exerciseId === exercise.id) ?? hints[0];
  const otherHints = hints.filter((h) => h !== latestHint);

  return (
    <div className="lab">
      <header className="lab-top">
        <Logo to="/lab" />
        <div className="lab-title">
          <h1>{lab.title}</h1>
          <p>{room.title}</p>
        </div>
        <div className="lab-who">
          <span className="conn" data-state={status === 'open' ? 'open' : 'down'}>
            {status === 'open' ? `Connected as ${session.name}` : 'Reconnecting… your results will be sent when it’s back'}
          </span>
          <button className="btn btn-sm" onClick={() => setShowPrivacy(true)}>
            What's shared
          </button>
        </div>
      </header>

      {ended && (
        <div className="lab-banner" role="status">
          The lab has ended. You can keep practicing here; results are no longer shared.
        </div>
      )}

      <div className="lab-body">
        <nav className="lab-rail" aria-label="Exercises">
          <ol className="steps">
            {lab.exercises.map((e, i) => {
              const st = progress[e.id] ?? 'not_started';
              return (
                <li key={e.id}>
                  <button className="step" aria-current={e.id === exercise.id ? 'step' : undefined} onClick={() => switchTo(e.id)}>
                    <span className="step-n num" data-status={st}>
                      {st === 'passing' ? '✓' : i + 1}
                    </span>
                    <span className="step-title">{e.title}</span>
                    <span className="visually-hidden">{st.replace('_', ' ')}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="prompt">
            <Markdown source={exercise.prompt || `# ${exercise.title}`} />
          </div>
        </nav>

        <section className="lab-editor" aria-label="Your code">
          <div className="editor-bar">
            <span className="editor-file mono">
              {exerciseIndex + 1}. {exercise.title}
            </span>
            <div className="editor-actions">
              <button className="btn btn-sm btn-quiet" onClick={() => setConfirmReset(true)}>
                Reset code
              </button>
              <button
                className="btn btn-primary run-btn"
                onClick={() => void run()}
                disabled={running || runnerState !== 'ready'}
                title="Ctrl + Enter"
              >
                {runnerState === 'loading' ? 'Loading Python…' : running ? 'Running…' : 'Run tests'}
                {runnerState === 'ready' && !running && <kbd>Ctrl ↵</kbd>}
              </button>
            </div>
          </div>
          <CodeEditor
            modelKey={`${session.roomId}:${exercise.id}`}
            initialValue={initialCode}
            errorLine={result && !result.stale ? result.line : null}
            errorMessage={result && !result.stale ? `${result.errorType}: ${result.errorMessage}` : null}
            onChange={onCodeChange}
            onRun={() => void run()}
            handleRef={(h) => (editorHandle.current = h)}
          />
          {runnerState === 'failed' && (
            <p className="form-error editor-error">Python couldn't load in this browser. Try reloading the page, or use a recent Chrome, Edge or Firefox.</p>
          )}
        </section>

        <aside className="lab-results" aria-label="Results">
          {latestHint && (
            <div className="hint-card" data-fresh={freshHint === latestHint.hintId} onAnimationEnd={() => setFreshHint(null)}>
              <p className="hint-card-from">
                From your instructor, {timeOfDay(latestHint.sentAt)}
              </p>
              <p className="hint-card-text">{latestHint.text}</p>
              {otherHints.length > 0 && (
                <details className="hint-older">
                  <summary>{otherHints.length} earlier</summary>
                  <ul>
                    {otherHints.map((h) => (
                      <li key={h.hintId}>
                        <span>{timeOfDay(h.sentAt)}</span> {h.text}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          <Results result={result} running={running} onLine={(l) => editorHandle.current?.revealLine(l)} />
        </aside>
      </div>

      {showPrivacy && (
        <Modal title="What your instructor sees" onClose={() => setShowPrivacy(false)}>
          <p>
            After each run, LabPulse sends whether your tests passed and the type of error, with names and values removed. It also
            says which exercise you're working on. Your code, your output and your keystrokes stay on this laptop.
          </p>
          <div className="sent-log">
            <p className="sent-log-head">Last messages sent from this browser</p>
            {sent.length === 0 ? (
              <p className="sent-log-empty">Nothing yet. Run your tests and it will appear here.</p>
            ) : (
              <ul>
                {sent.slice(0, 8).map((r) => (
                  <li key={r.id}>
                    <span className="sent-log-time">{timeOfDay(r.at)}</span>
                    <pre>{JSON.stringify(r.payload.signal, null, 2)}</pre>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="modal-actions">
            <Link to="/privacy" target="_blank" className="btn btn-quiet">
              Full privacy details
            </Link>
            <button className="btn btn-primary" onClick={() => setShowPrivacy(false)}>
              Done
            </button>
          </div>
        </Modal>
      )}

      {confirmReset && (
        <Modal title="Reset this exercise?" onClose={() => setConfirmReset(false)}>
          <p>Your code for “{exercise.title}” goes back to the starter code. This can't be undone.</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmReset(false)} data-autofocus>
              Keep my code
            </button>
            <button className="btn btn-primary" onClick={resetCode}>
              Reset code
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Results({ result, running, onLine }: { result?: RunSummary & { stale?: boolean }; running: boolean; onLine: (line: number) => void }) {
  if (!result) {
    return (
      <div className="results-empty">
        <p>{running ? 'Running your tests…' : 'Run the tests to check your code.'}</p>
        <p className="results-empty-sub">Your code runs here in the browser. Nothing is uploaded.</p>
      </div>
    );
  }

  const pass = result.result === 'pass';
  const explanation = result.result !== 'pass' ? explainError(result.errorType, result.result) : null;
  const headline = pass
    ? `All ${result.testsTotal} tests pass`
    : result.result === 'fail'
      ? `${result.testsPassed} of ${result.testsTotal} tests pass`
      : result.errorType === 'Timeout'
        ? 'Your code took too long'
        : result.line
          ? `${result.errorType} on line ${result.line}`
          : `${result.errorType}`;

  return (
    <div className="results" data-result={result.result} data-stale={result.stale || undefined} aria-live="polite">
      <div className="results-head">
        <span className="results-icon" aria-hidden="true">
          {pass ? '✓' : '!'}
        </span>
        <div>
          <h2>{headline}</h2>
          {explanation && <p className="results-explain">{explanation.label}</p>}
          {result.stale && <p className="results-stale">You've changed the code since this run.</p>}
        </div>
      </div>

      {!pass && result.result === 'error' && (
        <div className="results-error">
          <pre>{result.traceback || `${result.errorType}: ${result.errorMessage}`}</pre>
          {result.line && (
            <button className="btn btn-sm" onClick={() => onLine(result.line!)}>
              Go to line {result.line}
            </button>
          )}
        </div>
      )}

      {result.tests.length > 0 && (
        <ul className="test-list">
          {result.tests.map((t) => (
            <li key={t.name} data-status={t.status}>
              <span className="test-mark" aria-hidden="true">
                {t.status === 'pass' ? '✓' : '✗'}
              </span>
              <div>
                <p className="test-name">{humanTest(t.name)}</p>
                {t.message && t.status !== 'pass' && (
                  <p className="test-msg mono">
                    {t.status === 'error' && t.message === result.errorMessage && t.errorType === result.errorType ? `Same ${t.errorType}` : t.message}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {result.stdout && (
        <details className="stdout" open={!pass}>
          <summary>Printed output</summary>
          <pre>{result.stdout}</pre>
        </details>
      )}
    </div>
  );
}
