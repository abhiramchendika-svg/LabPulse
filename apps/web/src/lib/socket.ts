import type { ServerMessage } from '@labpulse/shared';

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveSocketOptions {
  path: string;
  /** Sent first on every (re)connect. */
  hello?: () => unknown;
  onMessage: (msg: ServerMessage) => void;
  onStatus?: (status: SocketStatus) => void;
  /** Close codes that mean "stop trying" (auth failures). */
  fatalCodes?: number[];
  onFatal?: (code: number) => void;
}

/** WebSocket with automatic reconnect and backoff. */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private timer: number | null = null;
  private pingTimer: number | null = null;

  constructor(private opts: LiveSocketOptions) {
    this.connect();
  }

  private url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${this.opts.path}`;
  }

  private connect() {
    if (this.stopped) return;
    this.opts.onStatus?.(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      const hello = this.opts.hello?.();
      if (hello) ws.send(JSON.stringify(hello));
      this.opts.onStatus?.('open');
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), 20_000);
    };
    ws.onmessage = (e) => {
      try {
        this.opts.onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch (err) {
        console.error('Bad message', err);
      }
    };
    ws.onclose = (e) => {
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (this.opts.fatalCodes?.includes(e.code)) {
        this.stopped = true;
        this.opts.onStatus?.('closed');
        this.opts.onFatal?.(e.code);
        return;
      }
      this.attempts++;
      this.opts.onStatus?.('reconnecting');
      const delay = Math.min(10_000, 500 * 2 ** Math.min(this.attempts, 5)) * (0.75 + Math.random() * 0.5);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: unknown): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  close() {
    this.stopped = true;
    if (this.timer) window.clearTimeout(this.timer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }
}
