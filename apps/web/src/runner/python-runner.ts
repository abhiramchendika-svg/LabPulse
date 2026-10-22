import type { RunResult } from '@labpulse/shared';

export interface TestRecord {
  name: string;
  status: 'pass' | 'fail' | 'error';
  message: string | null;
  errorType: string | null;
  line: number | null;
}

/** Full local result. Stays on this machine; only a RunSignal is ever sent. */
export interface RunSummary {
  result: RunResult;
  testsPassed: number;
  testsTotal: number;
  errorType: string | null;
  errorMessage: string | null;
  failingTest: string | null;
  line: number | null;
  traceback: string | null;
  tests: TestRecord[];
  stdout: string;
  durationMs: number;
}

export const RUN_TIMEOUT_MS = 6000;

type Pending = { resolve: (s: RunSummary) => void; reject: (e: Error) => void; timer: number | null; started: number };

/**
 * Owns the Pyodide worker. A run that exceeds the timeout (an infinite loop) kills
 * the worker and reports a Timeout error; a fresh worker is started for the next run.
 */
export class PythonRunner {
  private worker!: Worker;
  private ready!: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  onStatus?: (s: 'loading' | 'ready' | 'failed') => void;

  /** @param sources Pyodide locations to try in order; the server's own copy is always the last resort. */
  constructor(private sources: string[] = []) {
    this.spawn();
  }

  private spawn() {
    this.onStatus?.('loading');
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise<void>((resolve, reject) => {
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { type: string; id?: number; summary?: Omit<RunSummary, 'durationMs'>; message?: string };
        if (d.type === 'ready') {
          this.onStatus?.('ready');
          resolve();
        } else if (d.type === 'crash' && d.id === -1) {
          this.onStatus?.('failed');
          reject(new Error(d.message ?? 'Python failed to load'));
        } else if (d.id !== undefined) {
          const p = this.pending.get(d.id);
          if (!p) return;
          this.pending.delete(d.id);
          if (p.timer) window.clearTimeout(p.timer);
          if (d.type === 'result' && d.summary) p.resolve({ ...d.summary, durationMs: performance.now() - p.started });
          else p.reject(new Error(d.message ?? 'Python crashed'));
        }
      };
      this.worker.addEventListener('message', onMsg);
      this.worker.addEventListener('error', (ev) => {
        this.onStatus?.('failed');
        reject(new Error(ev.message || 'Python worker failed to start'));
      });
    });
    this.ready.catch(() => {});
    this.worker.postMessage({ type: 'init', sources: [...this.sources.filter(Boolean), '/pyodide/'] });
  }

  whenReady() {
    return this.ready;
  }

  async run(code: string, tests: string): Promise<RunSummary> {
    await this.ready;
    const id = this.nextId++;
    return new Promise<RunSummary>((resolve, reject) => {
      const started = performance.now();
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.worker.terminate();
        // Fail anything else that was queued on the dead worker.
        for (const [, p] of this.pending) p.reject(new Error('Runner restarted'));
        this.pending.clear();
        this.spawn();
        resolve({
          result: 'error',
          testsPassed: 0,
          testsTotal: 0,
          errorType: 'Timeout',
          errorMessage: `Your code ran for more than ${RUN_TIMEOUT_MS / 1000} seconds (probably an infinite loop)`,
          failingTest: null,
          line: null,
          traceback: null,
          tests: [],
          stdout: '',
          durationMs: performance.now() - started,
        });
      }, RUN_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, started });
      this.worker.postMessage({ type: 'run', id, code, tests });
    });
  }

  dispose() {
    this.worker.terminate();
    for (const [, p] of this.pending) {
      if (p.timer) window.clearTimeout(p.timer);
      p.reject(new Error('Runner closed'));
    }
    this.pending.clear();
  }
}
