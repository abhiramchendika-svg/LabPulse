// Development: gateway (auto-restart) on :8080 and the Vite dev server on :5173.
// Needs Postgres and Redis: `docker compose up -d postgres redis`.
import { spawn } from 'node:child_process';

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://labpulse:labpulse@localhost:5432/labpulse',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  WEB_DIST: '',
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args) => spawn(npm, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });

const build = run(['run', 'build', '-w', '@labpulse/shared']);
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const procs = [run(['run', 'dev', '-w', '@labpulse/gateway']), run(['run', 'dev', '-w', '@labpulse/web'])];
  console.log('\n  LabPulse dev: open http://localhost:5173\n');
  const stop = () => procs.forEach((p) => p.kill());
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  procs.forEach((p) => p.on('exit', (c) => c && stop()));
});
