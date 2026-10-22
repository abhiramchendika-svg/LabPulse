import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from './api';

export interface Instructor {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  instructor: Instructor | null;
  loading: boolean;
  setInstructor: (i: Instructor | null) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>({ instructor: null, loading: true, setInstructor: () => {}, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [instructor, setInstructor] = useState<Instructor | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<{ instructor: Instructor | null }>('GET', '/api/auth/me')
      .then((r) => setInstructor(r.instructor))
      .catch(() => setInstructor(null))
      .finally(() => setLoading(false));
  }, []);
  const signOut = useCallback(async () => {
    await api('POST', '/api/auth/logout', {}).catch(() => {});
    setInstructor(null);
  }, []);
  return <Ctx.Provider value={{ instructor, loading, setInstructor, signOut }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/** Renders children only for a signed-in instructor; otherwise redirects to sign-in. */
export function RequireInstructor({ children }: { children: ReactNode }) {
  const { instructor, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="page-center">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }
  if (!instructor) return <Navigate to={`/teach/sign-in?next=${encodeURIComponent(location.pathname)}`} replace />;
  return <>{children}</>;
}
