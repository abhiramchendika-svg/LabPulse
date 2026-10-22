import { Link } from 'react-router-dom';

export function Logo({ to = '/', size = 'md' }: { to?: string; size?: 'md' | 'lg' }) {
  return (
    <Link to={to} className={`logo logo-${size}`} aria-label="LabPulse home">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="currentColor" />
        <path d="M5 17h6l2.5-6 4 11 3-8 1.5 3H27" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>LabPulse</span>
    </Link>
  );
}
