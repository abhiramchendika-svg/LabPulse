import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import './styles/base.css';
import './styles/app.css';
import { ToastProvider } from './components/Toasts';
import { AuthProvider } from './lib/auth';
import { HomePage } from './pages/Home';
import { SignInPage } from './pages/SignIn';
import { RoomsPage } from './pages/Rooms';
import { DashboardPage } from './pages/Dashboard';
import { ReportPage } from './pages/Report';
import { PrivacyPage } from './pages/Privacy';
import { NotFoundPage } from './pages/NotFound';

// The editor (Monaco + Python) is large; only students on /lab download it.
const StudentLabPage = lazy(() => import('./pages/StudentLab').then((m) => ({ default: m.StudentLabPage })));
const labFallback = (
  <div className="page-center">
    <div className="loading-block">
      <div className="spinner" />
      <p>Loading the editor…</p>
    </div>
  </div>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/j/:code" element={<HomePage />} />
            <Route
              path="/lab"
              element={
                <Suspense fallback={labFallback}>
                  <StudentLabPage />
                </Suspense>
              }
            />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/teach/sign-in" element={<SignInPage />} />
            <Route path="/teach" element={<RoomsPage />} />
            <Route path="/teach/rooms/:id" element={<DashboardPage />} />
            <Route path="/teach/rooms/:id/report" element={<ReportPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
