import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AnyBridgeEvent, BridgeEventArgs } from '../../shared/contract.js';
import { get } from '../../shared/guards.js';

/** What a subscriber receives: a journal event, or the reset that tells it to read history again. */
export type HubMessage = AnyBridgeEvent | { type: 'stream.reset'; data: Record<string, never>; id?: undefined };
type Journal = { seq: number; events: AnyBridgeEvent[]; bytes: number; sizes: number[] };

// A bounded journal per conversation. A cursor is local to this server epoch.
class EventHub {
  bus: EventEmitter;
  journals: Map<string, Journal>;
  maxEvents: number; maxSessions: number; maxBytes: number;
  epoch: string;
  pinned: Set<string>;
  constructor({ maxEvents = 600, maxSessions = 128, maxBytes = 2 * 1024 * 1024 }: { maxEvents?: number; maxSessions?: number; maxBytes?: number } = {}) {
    this.bus = new EventEmitter(); this.bus.setMaxListeners(0);
    this.journals = new Map(); this.maxEvents = maxEvents; this.maxSessions = maxSessions; this.maxBytes = maxBytes;
    this.epoch = randomUUID(); this.pinned = new Set();
  }
  key(engine: string, sessionId: string): string { return JSON.stringify([engine, sessionId]); }
  /** Whether a key (as key() writes it) is one of this engine's conversations. */
  owns(engine: string, key: string): boolean { return key.startsWith(`${JSON.stringify([engine]).slice(0, -1)},`); }
  /** An engine has left the console: its journals go with it (nobody can read them any more). */
  forget(engine: string): void { for (const key of [...this.journals.keys()]) if (this.owns(engine, key)) { this.journals.delete(key); this.pinned.delete(key); this.bus.removeAllListeners(key); } }
  publish(engine: string, sessionId: string, turnId: string | null, ...[type, data]: BridgeEventArgs): AnyBridgeEvent {
    const key = this.key(engine, sessionId);
    const journal = this.journals.get(key) || { seq: 0, events: [], bytes: 0, sizes: [] };
    this.journals.delete(key); this.journals.set(key, journal);
    const event: AnyBridgeEvent = { id: `${this.epoch}:${++journal.seq}`, seq: journal.seq, engine, sessionId, turnId, type, data: structuredClone(data), timestamp: new Date().toISOString() };
    // A reply being written is published again and again, whole each time: of a run of updates to
    // one message the journal keeps the latest, so a long reply does not push the rest of the run out.
    const last = journal.events.at(-1);
    if (type === 'message.updated' && last?.type === 'message.updated' && last.turnId === turnId && get(last.data, 'id') === get(data, 'id')) { journal.events.pop(); journal.bytes -= journal.sizes.pop() ?? 0; }
    journal.events.push(event);
    const bytes = Buffer.byteLength(JSON.stringify(event));
    journal.bytes += bytes; journal.sizes.push(bytes);
    while (journal.events.length > 1 && (journal.events.length > this.maxEvents || journal.bytes > this.maxBytes)) { journal.events.shift(); journal.bytes -= journal.sizes.shift() ?? 0; }
    for (const [oldest] of this.journals) {
      if (this.journals.size <= this.maxSessions) break;
      if (!this.pinned.has(oldest) && this.bus.listenerCount(oldest) === 0) this.journals.delete(oldest);
    }
    this.bus.emit(key, event);
    this.bus.emit('all', event);
    return event;
  }
  subscribeAll(listener: (event: AnyBridgeEvent) => void): () => void { this.bus.on('all', listener); return () => this.bus.off('all', listener); }
  cursor(engine: string, id: string): string { return `${this.epoch}:${this.journals.get(this.key(engine, id))?.seq || 0}`; }
  subscribe(engine: string, id: string, cursor: string | undefined | null, listener: (event: HubMessage) => void): () => void {
    const key = this.key(engine, id);
    const journal = this.journals.get(key);
    if (cursor && cursor !== this.cursor(engine, id)) {
      const prefix = `${this.epoch}:`;
      const seq = cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : -1;
      if (!Number.isSafeInteger(seq) || seq < (journal?.events[0]?.seq || 1) - 1 || seq > (journal?.seq || 0)) listener({ type: 'stream.reset', data: {} });
      else for (const event of journal?.events || []) if (event.seq > seq) listener(event);
    }
    this.bus.on(key, listener);
    return () => this.bus.off(key, listener);
  }
}
export { EventHub };
