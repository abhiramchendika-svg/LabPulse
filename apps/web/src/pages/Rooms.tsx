import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomInfo } from '@labpulse/shared';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';
import { RequireInstructor, useAuth } from '../lib/auth';
import { dateTime, plural } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';

interface LabSummary {
  id: string;
  title: string;
  description: string;
  exercises: { id: string; title: string }[];
}

type RoomListItem = RoomInfo & { studentCount: number };

export function RoomsPage() {
  return (
    <RequireInstructor>
      <Rooms />
    </RequireInstructor>
  );
}

function Rooms() {
  useDocumentTitle('Your labs');
  const { instructor, signOut } = useAuth();
  const navigate = useNavigate();
  const [labs, setLabs] = useState<LabSummary[] | null>(null);
  const [rooms, setRooms] = useState<RoomListItem[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [title, setTitle] = useState('');
  const [labId, setLabId] = useState('');
  const [stuckMinutes, setStuckMinutes] = useState(5);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api<{ labs: LabSummary[] }>('GET', '/api/labs'), api<{ rooms: RoomListItem[] }>('GET', '/api/rooms')])
      .then(([l, r]) => {
        setLabs(l.labs);
        setRooms(r.rooms);
        if (l.labs[0]) setLabId((cur) => cur || l.labs[0]!.id);
      })
      .catch((err) => setLoadError((err as Error).message));
  }, []);

  const selected = labs?.find((l) => l.id === labId);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api<{ room: RoomInfo }>('POST', '/api/rooms', {
        title: title.trim() || selected?.title || 'Lab',
        labId,
        stuckMinutes,
      });
      navigate(`/teach/rooms/${r.room.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const live = rooms?.filter((r) => r.status === 'live') ?? [];
  const past = rooms?.filter((r) => r.status === 'ended') ?? [];

  return (
    <div className="teach">
      <header className="teach-top">
        <Logo to="/teach" />
        <div className="teach-user">
          <span>{instructor?.name}</span>
          <button className="btn btn-sm btn-quiet" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="teach-main">
        <section className="start-lab" aria-labelledby="start-title">
          <h1 id="start-title">Start a lab</h1>
          {loadError && <p className="form-error">{loadError}</p>}
          {labs && labs.length === 0 && (
            <p className="empty-note">
              No exercise sets found. Add a folder to <code>exercises/</code> (see the README) and reload this page.
            </p>
          )}
          {labs && labs.length > 0 && (
            <form onSubmit={create} className="start-form">
              <fieldset className="lab-options">
                <legend>Exercise set</legend>
                {labs.map((l) => (
                  <label key={l.id} className="lab-option" data-selected={l.id === labId}>
                    <input type="radio" name="lab" value={l.id} checked={l.id === labId} onChange={() => setLabId(l.id)} />
                    <span className="lab-option-title">{l.title}</span>
                    {l.description && <span className="lab-option-desc">{l.description}</span>}
                    <ol className="lab-option-exercises">
                      {l.exercises.map((ex) => (
                        <li key={ex.id}>{ex.title}</li>
                      ))}
                    </ol>
                  </label>
                ))}
              </fieldset>
              <div className="start-fields">
                <label className="field">
                  <span>Session name</span>
                  <input
                    className="input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={selected ? `${selected.title}, CSE section B` : 'CSE section B'}
                    maxLength={80}
                  />
                </label>
                <label className="field">
                  <span>Flag a student as stuck after</span>
                  <select className="select" value={stuckMinutes} onChange={(e) => setStuckMinutes(Number(e.target.value))}>
                    {[2, 3, 4, 5, 7, 10, 15].map((m) => (
                      <option key={m} value={m}>
                        {m} minutes without a passing run
                      </option>
                    ))}
                  </select>
                </label>
                {error && <p className="form-error">{error}</p>}
                <button className="btn btn-primary btn-lg" disabled={busy || !labId}>
                  {busy ? 'Opening…' : 'Open the lab'}
                </button>
              </div>
            </form>
          )}
          {!labs && !loadError && <div className="spinner" aria-label="Loading" />}
        </section>

        {live.length > 0 && <RoomList title="Running now" rooms={live} />}
        {past.length > 0 && <RoomList title="Past labs" rooms={past} />}
      </main>
    </div>
  );
}

function RoomList({ title, rooms }: { title: string; rooms: RoomListItem[] }) {
  return (
    <section className="room-list" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {rooms.map((r) => (
          <li key={r.id}>
            <Link to={r.status === 'live' ? `/teach/rooms/${r.id}` : `/teach/rooms/${r.id}/report`} className="room-row">
              <span className="room-row-title">{r.title}</span>
              <span className="room-row-lab">{r.labTitle}</span>
              <span className="room-row-meta num">{plural(r.studentCount, 'student')}</span>
              <span className="room-row-meta">{dateTime(r.createdAt)}</span>
              {r.status === 'live' ? (
                <span className="pill" data-tone="pass">
                  Live, code <span className="mono">{r.code}</span>
                </span>
              ) : (
                <span className="pill">Report</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
