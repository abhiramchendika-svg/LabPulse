import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  buildRoomState,
  explainError,
  type ErrorGroup,
  type LabDefinition,
  type RoomEvent,
  type RoomInfo,
  type RoomState,
  type StudentState,
} from '@labpulse/shared';
import { Logo } from '../components/Logo';
import { CodeDisplay } from '../components/CodeTiles';
import { GroupCard, errorLine } from '../components/GroupCard';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { RequireInstructor } from '../lib/auth';
import { clock, minutes, plural } from '../lib/format';
import { useDocumentTitle, useNow } from '../lib/hooks';
import { LiveSocket, type SocketStatus } from '../lib/socket';
import { getItem, setItem } from '../lib/storage';

/** Groups stay on screen this long after a hint, even once empty, so you can see it reach zero. */
const RESOLVED_VISIBLE_MS = 10 * 60_000;

export function DashboardPage() {
  return (
    <RequireInstructor>
      <Dashboard />
    </RequireInstructor>
  );
}

function Dashboard() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [lab, setLab] = useState<LabDefinition | null>(null);
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [loadError, setLoadError] = useState('');
  const [projector, setProjector] = useState(() => getItem('lp_projector') === '1');
  const [showJoin, setShowJoin] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const seen = useRef(new Set<number>());

  useDocumentTitle(room ? room.title : 'Lab');

  useEffect(() => {
    api<{ room: RoomInfo; lab: LabDefinition }>('GET', `/api/rooms/${id}`)
      .then((r) => {
        setRoom(r.room);
        setLab(r.lab);
      })
      .catch((err) => setLoadError((err as Error).message));
  }, [id]);

  useEffect(() => {
    const sock = new LiveSocket({
      path: `/ws/dashboard/${id}`,
      onStatus: setStatus,
      fatalCodes: [4403],
      onFatal: () => setLoadError('Lab room not found'),
      onMessage: (m) => {
        if (m.t === 'snapshot') {
          seen.current = new Set(m.events.map((e) => e.seq));
          setEvents(m.events);
          setRoom(m.room);
          setOffset(m.serverNow - Date.now());
        } else if (m.t === 'event') {
          if (seen.current.has(m.event.seq)) return;
          seen.current.add(m.event.seq);
          setEvents((prev) => [...prev, m.event]);
          if (m.event.type === 'lab_ended') {
            const at = m.event.ts;
            setRoom((r) => (r ? { ...r, status: 'ended', endedAt: at } : r));
          }
        }
      },
    });
    return () => sock.close();
  }, [id]);

  const now = useNow(1000, offset);
  const config = useMemo(() => (room ? { stuckMinutes: room.stuckMinutes, exercises: room.exercises } : null), [room]);
  const state = useMemo(() => (config ? buildRoomState(events, config, now) : null), [events, config, now]);

  // Projector mode replaces names with a stable number in join order.
  const nameOf = useCallback(
    (sid: string) => {
      if (!state) return '';
      const s = state.studentsById[sid];
      if (!projector) return s?.name ?? 'Student';
      const idx = state.students.findIndex((x) => x.id === sid);
      return `Student ${idx + 1}`;
    },
    [state, projector],
  );

  const toggleProjector = () => {
    setProjector((p) => {
      setItem('lp_projector', p ? '0' : '1');
      return !p;
    });
  };

  const suggestionFor = useCallback(
    (g: ErrorGroup) => {
      const hints = lab?.exercises.find((e) => e.id === g.exerciseId)?.hints ?? {};
      const key = g.result === 'fail' ? `fail:${g.failingTest}` : g.errorType ?? '';
      return hints[key] ?? (g.result === 'fail' ? hints.AssertionError : undefined) ?? explainError(g.errorType, g.result).hint;
    },
    [lab],
  );

  const sendHint = async (g: ErrorGroup, text: string) => {
    try {
      const r = await api<{ event: { payload: { recipients: string[] } } }>('POST', `/api/rooms/${id}/hints`, { fingerprint: g.fingerprint, text });
      toast(`Hint sent to ${plural(r.event.payload.recipients.length, 'student')}`);
      return true;
    } catch (err) {
      toast((err as Error).message, 'error');
      return false;
    }
  };

  const endLab = async () => {
    setEnding(true);
    try {
      await api('POST', `/api/rooms/${id}/end`, {});
      navigate(`/teach/rooms/${id}/report`);
    } catch (err) {
      toast((err as Error).message, 'error');
      setEnding(false);
      setConfirmEnd(false);
    }
  };

  if (loadError) {
    return (
      <div className="page-center">
        <div className="empty-card">
          <h1>{loadError}</h1>
          <p>It may belong to another instructor account, or the link is wrong.</p>
          <Link className="btn" to="/teach">
            Back to your labs
          </Link>
        </div>
      </div>
    );
  }

  if (!room || !state) {
    return (
      <div className="page-center">
        <div className="spinner" aria-label="Loading the lab" />
      </div>
    );
  }

  const live = room.status === 'live';
  const titles = Object.fromEntries(room.exercises.map((e) => [e.id, e.title]));
  const startedAt = room.createdAt;

  return (
    <div className="dash" data-projector={projector}>
      <header className="dash-top">
        <Logo to="/teach" />
        <div className="dash-title">
          <h1>{room.title}</h1>
          <p>{room.labTitle}</p>
        </div>
        {live ? (
          <button className="dash-code" onClick={() => setShowJoin(true)} title="Show the join screen">
            <span className="dash-code-label">Room code</span>
            <span className="mono dash-code-value">{room.code}</span>
          </button>
        ) : (
          <span className="pill">Lab ended</span>
        )}
        <div className="dash-clock num" aria-label="Time since the lab opened">
          {clock((room.endedAt ?? now) - startedAt)}
        </div>
        <ConnectionBadge status={status} />
        <div className="dash-actions">
          <label className="switch">
            <input type="checkbox" checked={projector} onChange={toggleProjector} />
            <span className="switch-track" aria-hidden="true" />
            <span>Hide names</span>
          </label>
          <Link className="btn btn-sm" to={`/teach/rooms/${id}/report`}>
            Report
          </Link>
          {live && (
            <button className="btn btn-sm btn-danger" onClick={() => setConfirmEnd(true)}>
              End lab
            </button>
          )}
        </div>
      </header>

      {state.students.length === 0 && live ? (
        <JoinScreen code={room.code} inline />
      ) : (
        <main className="dash-main">
          <Summary state={state} />
          <div className="dash-columns">
            <section className="dash-groups" aria-labelledby="groups-title">
              <div className="section-head">
                <h2 id="groups-title">Same mistake, same time</h2>
                <p>Students grouped by the error they hit last. Help a whole group with one hint.</p>
              </div>
              <Groups
                state={state}
                titles={titles}
                now={now}
                nameOf={nameOf}
                hideNames={projector}
                live={live}
                suggestionFor={suggestionFor}
                onSendHint={sendHint}
              />
            </section>
            <aside className="dash-side">
              <StuckList state={state} titles={titles} now={now} nameOf={nameOf} />
              <Progress state={state} />
            </aside>
          </div>
          <Everyone state={state} titles={titles} nameOf={nameOf} />
        </main>
      )}

      {showJoin && (
        <div className="join-overlay" role="dialog" aria-modal="true" aria-label="Join screen">
          <button className="btn join-overlay-close" onClick={() => setShowJoin(false)} autoFocus>
            Close
          </button>
          <JoinScreen code={room.code} />
        </div>
      )}

      {confirmEnd && (
        <Modal title="End this lab?" onClose={() => setConfirmEnd(false)}>
          <p>
            Students stop sharing results and the room code stops working. You'll go straight to the post-lab report.
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmEnd(false)} data-autofocus>
              Keep it running
            </button>
            <button className="btn btn-primary" onClick={() => void endLab()} disabled={ending}>
              {ending ? 'Ending…' : 'End lab and see report'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ConnectionBadge({ status }: { status: SocketStatus }) {
  if (status === 'open') return <span className="conn" data-state="open" title="Live">Live</span>;
  return (
    <span className="conn" data-state="down" role="status">
      {status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
    </span>
  );
}

function useJoinAddress() {
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  useEffect(() => {
    api<{ publicUrl: string | null }>('GET', '/api/config')
      .then((r) => setPublicUrl(r.publicUrl))
      .catch(() => setPublicUrl(null));
  }, []);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const address = publicUrl ? publicUrl.replace(/^https?:\/\//, '') : location.host;
  return { address, unreachable: !publicUrl && local };
}

function JoinScreen({ code, inline }: { code: string; inline?: boolean }) {
  const { address, unreachable } = useJoinAddress();
  return (
    <section className={`join-screen ${inline ? 'join-screen-inline' : ''}`} aria-label="How students join">
      <p className="join-screen-step">Students open</p>
      <p className="join-screen-url mono">{address}</p>
      <p className="join-screen-step">and enter this code</p>
      <CodeDisplay code={code} size="xl" />
      {unreachable && (
        <p className="join-screen-warn" role="note">
          Students can't reach <strong>localhost</strong>. Set <code>PUBLIC_URL</code> to this computer's network address (see the
          README), or open this page using that address.
        </p>
      )}
      {inline && <p className="join-screen-wait">Waiting for the first student to join. They'll appear here as they arrive.</p>}
    </section>
  );
}

function Summary({ state }: { state: RoomState }) {
  const t = state.totals;
  return (
    <div className="summary" role="status">
      <div className="summary-item">
        <span className="summary-n num">{t.students}</span>
        <span>in the lab{t.students !== t.online && !state.ended ? `, ${t.online} online` : ''}</span>
      </div>
      <div className="summary-item" data-tone={t.stuck > 0 ? 'stuck' : undefined}>
        <span className="summary-n num">{t.stuck}</span>
        <span>need help now</span>
      </div>
      <div className="summary-item" data-tone="pass">
        <span className="summary-n num">{t.finishedAll}</span>
        <span>finished every exercise</span>
      </div>
      <div className="summary-item">
        <span className="summary-n num">{t.runs}</span>
        <span>test runs</span>
      </div>
    </div>
  );
}

function Groups({
  state,
  titles,
  now,
  nameOf,
  hideNames,
  live,
  suggestionFor,
  onSendHint,
}: {
  state: RoomState;
  titles: Record<string, string>;
  now: number;
  nameOf: (id: string) => string;
  hideNames: boolean;
  live: boolean;
  suggestionFor: (g: ErrorGroup) => string;
  onSendHint: (g: ErrorGroup, text: string) => Promise<boolean>;
}) {
  const shared = state.groups.filter((g) => g.studentIds.length >= 2 || g.hints.length > 0);
  const recentlyResolved = Object.values(state.allGroups).filter(
    (g) => g.studentIds.length === 0 && g.hints.length > 0 && now - g.hints[g.hints.length - 1]!.sentAt < RESOLVED_VISIBLE_MS,
  );
  const singles = state.groups.filter((g) => g.studentIds.length === 1 && g.hints.length === 0);

  if (shared.length === 0 && recentlyResolved.length === 0 && singles.length === 0) {
    return (
      <div className="groups-empty">
        <p>No one is failing right now.</p>
        <p>When two or more students hit the same error, they'll show up here as one group.</p>
      </div>
    );
  }

  return (
    <>
      <div className="group-list">
        {[...shared, ...recentlyResolved].map((g) => (
          <GroupCard
            key={g.fingerprint}
            group={g}
            exerciseTitle={titles[g.exerciseId] ?? g.exerciseId}
            now={now}
            nameOf={nameOf}
            hideNames={hideNames}
            suggestion={suggestionFor(g)}
            live={live}
            statusOf={(sid) => state.studentsById[sid]?.exercises[g.exerciseId]?.status ?? 'not_started'}
            onSendHint={(text) => onSendHint(g, text)}
          />
        ))}
      </div>
      {singles.length > 0 && (
        <details className="singles" open={shared.length === 0}>
          <summary>
            Errors only one student has hit ({singles.length})
          </summary>
          <ul>
            {singles.map((g) => (
              <li key={g.fingerprint}>
                <span className="singles-who">{nameOf(g.studentIds[0]!)}</span>
                <span className="singles-ex">{titles[g.exerciseId]}</span>
                <code className="singles-err">{errorLine(g)}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function StuckList({ state, titles, now, nameOf }: { state: RoomState; titles: Record<string, string>; now: number; nameOf: (id: string) => string }) {
  const stuck = state.students.filter((s) => s.stuck).sort((a, b) => a.stuck!.since - b.stuck!.since);
  const threshold = Math.round(state.stuckMs / 60_000);
  return (
    <section className="side-card" aria-labelledby="stuck-title">
      <div className="side-head">
        <h2 id="stuck-title">Needs help</h2>
        <span className="pill" data-tone={stuck.length ? 'stuck' : undefined}>
          {stuck.length}
        </span>
      </div>
      {stuck.length === 0 ? (
        <p className="side-empty">Nobody has gone {threshold} minutes without progress.</p>
      ) : (
        <ul className="stuck-list">
          {stuck.map((s) => {
            const info = s.stuck!;
            const g = info.kind === 'error' && info.fingerprint ? state.allGroups[info.fingerprint] : undefined;
            return (
              <li key={s.id} className="stuck-row" data-kind={info.kind}>
                <span className="stuck-mark" aria-hidden="true" />
                <div>
                  <p className="stuck-name">
                    {nameOf(s.id)}
                    {!s.online && <span className="offline-tag">offline</span>}
                  </p>
                  <p className="stuck-why">
                    {info.kind === 'error'
                      ? `No passing run for ${minutes(now - info.since)} on ${titles[info.exerciseId] ?? info.exerciseId}`
                      : `No activity for ${minutes(now - info.since)}`}
                  </p>
                  {g && <p className="stuck-err">{explainError(g.errorType, g.result).label}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Progress({ state }: { state: RoomState }) {
  const total = Math.max(1, state.students.length);
  return (
    <section className="side-card" aria-labelledby="progress-title">
      <div className="side-head">
        <h2 id="progress-title">Exercise progress</h2>
      </div>
      <ol className="progress-list">
        {state.progress.map((p, i) => (
          <li key={p.exerciseId}>
            <div className="progress-label">
              <span className="progress-step num">{i + 1}</span>
              <span className="progress-title">{p.title}</span>
              <span className="progress-done num">
                {p.everPassed}/{state.students.length} done
              </span>
            </div>
            <div className="bar" role="img" aria-label={`${p.passing} passing, ${p.failing} failing, ${p.notStarted} not started`}>
              {p.passing > 0 && <span className="bar-seg" data-status="passing" style={{ flexGrow: p.passing / total }} title={`${p.passing} passing`} />}
              {p.failing > 0 && <span className="bar-seg" data-status="failing" style={{ flexGrow: p.failing / total }} title={`${p.failing} failing`} />}
              {p.notStarted > 0 && <span className="bar-seg" data-status="not_started" style={{ flexGrow: p.notStarted / total }} title={`${p.notStarted} not started`} />}
            </div>
            <div className="bar-legend num">
              <span>
                <i className="status-dot" data-status="passing" /> {p.passing} passing
              </span>
              <span>
                <i className="status-dot" data-status="failing" /> {p.failing} failing
              </span>
              <span>
                <i className="status-dot" data-status="not_started" /> {p.notStarted} not started
              </span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function studentTone(s: StudentState) {
  if (s.stuck) return 'stuck';
  if (s.finishedAll) return 'done';
  return undefined;
}

function Everyone({ state, titles, nameOf }: { state: RoomState; titles: Record<string, string>; nameOf: (id: string) => string }) {
  return (
    <section className="everyone" aria-labelledby="everyone-title">
      <div className="section-head">
        <h2 id="everyone-title">Everyone</h2>
        <p>One tile per student, one mark per exercise.</p>
      </div>
      <ul className="seat-grid">
        {state.students.map((s) => (
          <li key={s.id} className="seat-tile" data-tone={studentTone(s)} data-online={s.online}>
            <span className="seat-name">{nameOf(s.id)}</span>
            <span className="seat-pips">
              {state.progress.map((p) => {
                const ex = s.exercises[p.exerciseId];
                const st = ex?.status ?? 'not_started';
                return <i key={p.exerciseId} className="status-dot" data-status={st} title={`${titles[p.exerciseId]}: ${st.replace('_', ' ')}`} />;
              })}
            </span>
            {s.stuck && <span className="seat-flag">{s.stuck.kind === 'error' ? 'stuck' : 'idle'}</span>}
            {!s.stuck && s.finishedAll && <span className="seat-flag seat-flag-done">done</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
