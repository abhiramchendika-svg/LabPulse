import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** Empty: use an in-process bus (single server only). */
  redisUrl: string;
  exercisesDir: string;
  /** Built web app to serve; empty to disable. */
  webDist: string;
  cookieSecure: boolean;
  logLevel: string;
  /** Address students type to reach LabPulse, e.g. http://192.168.1.20:8080. Shown on the join screen. */
  publicUrl: string;
  /** If set, creating an instructor account requires this invite code. */
  signupCode: string;
  /** Optional CDN for the Python runtime (saves ~12 MB of server bandwidth per student). */
  pyodideUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL ?? 'postgres://labpulse:labpulse@localhost:5432/labpulse',
    redisUrl: env.REDIS_URL ?? '',
    exercisesDir: env.EXERCISES_DIR ?? path.join(repoRoot, 'exercises'),
    webDist: env.WEB_DIST ?? path.join(repoRoot, 'apps/web/dist'),
    cookieSecure: env.COOKIE_SECURE === 'true',
    logLevel: env.LOG_LEVEL ?? 'warn',
    publicUrl: (env.PUBLIC_URL ?? '').trim().replace(/\/+$/, ''),
    signupCode: (env.INSTRUCTOR_SIGNUP_CODE ?? '').trim(),
    pyodideUrl: (env.PYODIDE_URL ?? '').trim(),
  };
}
