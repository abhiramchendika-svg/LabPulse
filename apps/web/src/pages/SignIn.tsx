import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';
import { useAuth, type Instructor } from '../lib/auth';
import { useDocumentTitle } from '../lib/hooks';

export function SignInPage() {
  const [mode, setMode] = useState<'sign-in' | 'create'>('sign-in');
  useDocumentTitle(mode === 'sign-in' ? 'Sign in' : 'Create account');
  const { instructor, loading, setInstructor } = useAuth();
  const [params] = useSearchParams();
  const next = params.get('next')?.startsWith('/teach') ? params.get('next')! : '/teach';
  const [form, setForm] = useState({ name: '', email: '', password: '', inviteCode: '' });
  const [needsCode, setNeedsCode] = useState(false);
  useEffect(() => {
    api<{ signupRequiresCode?: boolean }>('GET', '/api/config')
      .then((c) => setNeedsCode(!!c.signupRequiresCode))
      .catch(() => {});
  }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!loading && instructor) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r =
        mode === 'sign-in'
          ? await api<{ instructor: Instructor }>('POST', '/api/auth/login', { email: form.email, password: form.password })
          : await api<{ instructor: Instructor }>('POST', '/api/auth/signup', {
              name: form.name,
              email: form.email,
              password: form.password,
              ...(needsCode ? { inviteCode: form.inviteCode } : {}),
            });
      setInstructor(r.instructor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="auth-page">
      <Logo />
      <form className="auth-card" onSubmit={submit}>
        <h1>{mode === 'sign-in' ? 'Sign in to run a lab' : 'Create an instructor account'}</h1>
        {mode === 'create' && (
          <label className="field">
            <span>Name</span>
            <input className="input" value={form.name} onChange={set('name')} autoComplete="name" required maxLength={60} />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            minLength={mode === 'create' ? 8 : undefined}
            required
          />
          {mode === 'create' && <small className="field-hint">At least 8 characters.</small>}
        </label>
        {mode === 'create' && needsCode && (
          <label className="field">
            <span>Invite code</span>
            <input className="input" value={form.inviteCode} onChange={set('inviteCode')} autoComplete="off" required />
            <small className="field-hint">This server only lets invited instructors create accounts.</small>
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? 'One moment…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </button>
        <p className="auth-switch">
          {mode === 'sign-in' ? 'New to LabPulse?' : 'Already have an account?'}{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setMode(mode === 'sign-in' ? 'create' : 'sign-in');
              setError('');
            }}
          >
            {mode === 'sign-in' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </form>
    </div>
  );
}
