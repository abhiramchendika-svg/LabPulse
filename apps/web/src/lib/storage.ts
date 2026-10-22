// localStorage can throw (private windows, blocked site data). Everything here
// degrades to in-memory storage so the page still works.
const memory = new Map<string, string>();

export function getItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export function setItem(key: string, value: string): void {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* in-memory only */
  }
}

export function removeItem(key: string): void {
  memory.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getJson<T>(key: string): T | null {
  const raw = getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setJson(key: string, value: unknown): void {
  setItem(key, JSON.stringify(value));
}

export interface StudentSession {
  token: string;
  studentId: string;
  roomId: string;
  name: string;
  code: string;
}

export const STUDENT_KEY = 'lp_student';
