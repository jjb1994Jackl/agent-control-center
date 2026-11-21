import { createHash } from 'node:crypto';
import { presentHistory } from '../core/presentation.js';
import type { PluginHost } from '../core/plugin-host.js';
import type { EventHub } from '../core/event-hub.js';
import type { RunService } from '../core/run-service.js';
import type { History } from '../../shared/contract.js';
import { list, parseJson } from '../../shared/guards.js';

interface Observer { refs: number; pending: boolean; stopped: boolean; digest: string; messages: Set<string>; held: string; timer?: ReturnType<typeof setInterval> }

// Native clients own storage. This adapter samples their read-only history when no
// console run is active; everything above this boundary consumes events only.
class SessionObserver {
  host: PluginHost; hub: EventHub; runs: RunService; intervalMs: number; observers: Map<string, Observer>;
  constructor(host: PluginHost, hub: EventHub, runs: RunService, { intervalMs = 3000 }: { intervalMs?: number } = {}) {
    this.host = host; this.hub = hub; this.runs = runs; this.intervalMs = intervalMs; this.observers = new Map();
  }
  acquire(engine: string, id: string): () => void {
    const key = this.hub.key(engine, id);
    let found = this.observers.get(key);
    if (!found) {
      const entry: Observer = { refs: 0, pending: false, stopped: false, digest: '', messages: new Set(), held: '[]' };
      found = entry;
      // What the desktop is holding for the running turn, sent even while a console run is live.
      const held = (history: History | null | undefined) => {
        const queue = JSON.stringify(history?.session?.metadata?.desktopQueue || []);
        if (queue !== entry.held) { entry.held = queue; this.hub.publish(engine, id, null, 'desktop.queue', { items: list(parseJson(queue)) }); }
      };
      const read = async () => {
        if (entry.stopped || entry.pending) return;
        if (this.runs.get(engine, id)) {
          entry.pending = true;
          try { held(await this.host.get(engine).read(id)); } catch {} finally { entry.pending = false; }
          return;
        }
        entry.pending = true;
        try {
          const history = await this.host.get(engine).read(id);
          entry.held = JSON.stringify(history?.session?.metadata?.desktopQueue || []);
          const snapshot = presentHistory(history);
          if (entry.stopped || this.runs.get(engine, id)) return;
          const messages = snapshot.turns.flatMap(turn => turn.messages || []).filter(message => message.text && message.phase !== 'analysis');
          if (entry.digest) for (const message of messages) if (!entry.messages.has(message.id)) this.hub.publish(engine, id, null, 'assistant.notice', { id: message.id, preview: message.text.replace(/\s+/g, ' ').slice(0, 200), phase: message.phase, at: message.at });
          entry.messages = new Set(messages.map(message => message.id));
          const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
          if (entry.digest && entry.digest !== digest) this.hub.publish(engine, id, null, 'session.snapshot', snapshot);
          entry.digest = digest;
        } catch { /* A draft has no native history yet. The normal read route reports errors. */ }
        finally { entry.pending = false; }
      };
      entry.timer = setInterval(read, this.intervalMs); entry.timer.unref?.(); read();
      this.observers.set(key, entry);
    }
    const entry = found;
    entry.refs++;
    return () => { if (--entry.refs === 0 && !entry.stopped) { entry.stopped = true; clearInterval(entry.timer); this.observers.delete(key); } };
  }
  /** An engine has left the console: its chats are no longer read (their streams are closed by the server). */
  release(engine: string): void { for (const [key, entry] of [...this.observers]) if (this.hub.owns(engine, key)) { entry.stopped = true; clearInterval(entry.timer); this.observers.delete(key); } }
  dispose(): void { for (const entry of this.observers.values()) { entry.stopped = true; clearInterval(entry.timer); } this.observers.clear(); }
}
export { SessionObserver };
