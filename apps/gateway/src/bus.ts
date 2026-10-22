/**
 * Room event bus. With Redis, every gateway instance publishes to and subscribes
 * from one channel per lab room, so any number of instances can serve the same
 * room. Without Redis, an in-process bus serves a single instance (dev/tests).
 */

import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import type { RoomEvent } from '@labpulse/shared';

export type RoomListener = (event: RoomEvent) => void;

export interface Bus {
  publish(roomId: string, event: RoomEvent): Promise<void>;
  /** Returns an unsubscribe function. Resolves once the subscription is active. */
  subscribe(roomId: string, listener: RoomListener): Promise<() => void>;
  /** Adjust a student's open-connection count across all instances; returns the new count. */
  presence(studentId: string, delta: 1 | -1): Promise<number>;
  close(): Promise<void>;
}

const channel = (roomId: string) => `lp:room:${roomId}`;

export class MemoryBus implements Bus {
  private emitter = new EventEmitter().setMaxListeners(0);
  private counts = new Map<string, number>();

  async publish(roomId: string, event: RoomEvent) {
    this.emitter.emit(channel(roomId), event);
  }

  async subscribe(roomId: string, listener: RoomListener) {
    this.emitter.on(channel(roomId), listener);
    return () => {
      this.emitter.off(channel(roomId), listener);
    };
  }

  async presence(studentId: string, delta: 1 | -1) {
    const n = Math.max(0, (this.counts.get(studentId) ?? 0) + delta);
    if (n === 0) this.counts.delete(studentId);
    else this.counts.set(studentId, n);
    return n;
  }

  async close() {
    this.emitter.removeAllListeners();
  }
}

export class RedisBus implements Bus {
  private pub: Redis;
  private sub: Redis;
  private listeners = new Map<string, Set<RoomListener>>();
  private pending = new Map<string, Promise<unknown>>();

  constructor(url: string) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 3 });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    this.sub.on('message', (ch: string, raw: string) => {
      const set = this.listeners.get(ch);
      if (!set || set.size === 0) return;
      let event: RoomEvent;
      try {
        event = JSON.parse(raw) as RoomEvent;
      } catch {
        return;
      }
      for (const l of set) {
        try {
          l(event);
        } catch {
          /* one bad listener must not break the others */
        }
      }
    });
  }

  async ready() {
    await Promise.all([this.pub.ping(), this.sub.ping()]);
  }

  async publish(roomId: string, event: RoomEvent) {
    await this.pub.publish(channel(roomId), JSON.stringify(event));
  }

  async subscribe(roomId: string, listener: RoomListener) {
    const ch = channel(roomId);
    let set = this.listeners.get(ch);
    if (!set) {
      set = new Set();
      this.listeners.set(ch, set);
      this.pending.set(ch, this.sub.subscribe(ch));
    }
    set.add(listener);
    await this.pending.get(ch);
    return () => {
      const s = this.listeners.get(ch);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) {
        this.listeners.delete(ch);
        this.pending.delete(ch);
        void this.sub.unsubscribe(ch).catch(() => {});
      }
    };
  }

  async presence(studentId: string, delta: 1 | -1) {
    const key = `lp:presence:${studentId}`;
    const n = delta === 1 ? await this.pub.incr(key) : await this.pub.decr(key);
    if (n <= 0) {
      await this.pub.del(key);
      return 0;
    }
    // Self-heal counts left behind by a crashed instance.
    await this.pub.expire(key, 6 * 60 * 60);
    return n;
  }

  async close() {
    this.listeners.clear();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
