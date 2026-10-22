import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ROOM_CODE_LENGTH } from '@labpulse/shared';
import { Logo } from '../components/Logo';
import { CodeInput, clean } from '../components/CodeTiles';
import { api } from '../lib/api';
import { useDocumentTitle } from '../lib/hooks';
import { getJson, getItem, setItem, setJson, STUDENT_KEY, type StudentSession } from '../lib/storage';

export function HomePage() {
  useDocumentTitle('Join a lab');
  const params = useParams();
  const navigate = useNavigate();
  const existing = getJson<StudentSession>(STUDENT_KEY);
  const [code, setCode] = useState(() => clean(params.code ?? '').slice(0, ROOM_CODE_LENGTH));
  const [name, setName] = useState(() => getItem('lp_name') ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const join = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (code.length !== ROOM_CODE_LENGTH) return setError(`Enter all ${ROOM_CODE_LENGTH} characters of the room code.`);
    if (!name.trim()) return setError('Enter your name so your instructor knows who you are.');
    // Rejoining the same room on this browser keeps the same identity.
    if (existing && existing.code === code && existing.name === name.trim()) {
      navigate('/lab');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ token: string; studentId: string; roomId: string }>('POST', '/api/join', { code, name });
      setJson(STUDENT_KEY, { token: r.token, studentId: r.studentId, roomId: r.roomId, name: name.trim(), code } satisfies StudentSession);
      setItem('lp_name', name.trim());
      navigate('/lab');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <header className="home-top">
        <Logo />
        <nav className="home-nav">
          <Link to="/privacy">What gets shared</Link>
          <Link to="/teach" className="btn btn-sm">
            Instructor sign in
          </Link>
        </nav>
      </header>

      <main className="home-main">
        <form className="join-card" onSubmit={join} noValidate>
          <h1>Join your lab</h1>
          <p className="join-lede">Type the code on the screen at the front of the room.</p>

          <CodeInput value={code} onChange={setCode} autoFocus={!code} />

          <label className="field join-name">
            <span>Your name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              autoComplete="name"
              placeholder="As your instructor knows you"
              autoFocus={!!code}
            />
          </label>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button className="btn btn-primary btn-lg join-submit" disabled={busy}>
            {busy ? 'Joining…' : 'Join lab'}
          </button>

          {existing && (
            <p className="join-resume">
              Still in lab <strong className="mono">{existing.code}</strong>?{' '}
              <Link to="/lab">Continue as {existing.name}</Link>
            </p>
          )}
        </form>

        <aside className="home-aside">
          <h2>Your code stays on your laptop</h2>
          <p>
            Your tests run here, in this browser. Your instructor only sees whether they passed and the kind of error you hit,
            so they can help everyone stuck on the same thing at once.
          </p>
          <Link to="/privacy">See exactly what is sent</Link>
        </aside>
      </main>
    </div>
  );
}
