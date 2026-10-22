/// <reference lib="webworker" />
// Runs Python in Pyodide, off the main thread so an infinite loop can't freeze the page.
import runnerSource from './runner.py?raw';

interface PyodideLike {
  runPython(code: string): unknown;
  globals: { get(name: string): (...args: unknown[]) => unknown };
}

declare const self: DedicatedWorkerGlobalScope;

let ready: Promise<PyodideLike> | null = null;
/** Where to load Pyodide from, in order of preference (a CDN first, then this server's own copy). */
let sources: string[] = ['/pyodide/'];

async function loadFrom(source: string): Promise<PyodideLike> {
  const base = new URL(source.endsWith('/') ? source : `${source}/`, self.location.origin).href;
  const mod = (await import(/* @vite-ignore */ `${base}pyodide.mjs`)) as {
    loadPyodide(opts: { indexURL: string }): Promise<PyodideLike>;
  };
  const py = await mod.loadPyodide({ indexURL: base });
  py.runPython(runnerSource);
  return py;
}

async function load(): Promise<PyodideLike> {
  let lastError: unknown = null;
  for (const source of sources) {
    try {
      return await loadFrom(source);
    } catch (err) {
      lastError = err;
      console.warn(`Pyodide failed to load from ${source}, trying the next source`, err);
    }
  }
  throw lastError ?? new Error('No Pyodide source configured');
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: 'init'; sources?: string[] } | { type: 'run'; id: number; code: string; tests: string };
  try {
    if (msg.type === 'init' && msg.sources?.length && !ready) sources = msg.sources;
    ready ??= load();
    const py = await ready;
    if (msg.type === 'init') {
      self.postMessage({ type: 'ready' });
      return;
    }
    const runJson = py.globals.get('run_json');
    const json = runJson(msg.code, msg.tests) as string;
    self.postMessage({ type: 'result', id: msg.id, summary: JSON.parse(json) });
  } catch (err) {
    self.postMessage({
      type: 'crash',
      id: msg.type === 'run' ? msg.id : -1,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
