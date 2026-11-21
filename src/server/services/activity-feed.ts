import { EventEmitter } from 'node:events';
import type { PluginHost } from '../core/plugin-host.js';
import type { EventHub } from '../core/event-hub.js';
import type { RunService } from '../core/run-service.js';
import type { ActivityEntry, ActivityNotice, ActivitySnapshot, AnyBridgeEvent } from '../../shared/contract.js';
import { get } from '../../shared/guards.js';
const terminal = new Set<unknown>(['completed', 'failed', 'interrupted']);
const stamp = (value: unknown): number => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value)) || 0;
/** A message the feed may show: its id, its text (or preview), when it was said. */
export interface NoticeSource { id?: string; text?: unknown; preview?: unknown; phase?: unknown; at?: unknown; timestamp?: unknown }

// Status and public, truncated assistant messages only. Never private reasoning.
class ActivityFeed {
  host: PluginHost; hub: EventHub; runs: RunService; intervalMs: number;
  entries: Map<string, ActivityEntry>; notices: ActivityNotice[]; knownMessages: Map<string, Set<string>>; nativeRunning: Set<string>;
  bus: EventEmitter; polling: boolean; timer: ReturnType<typeof setInterval> | null; clients: number; unsubscribe: () => void;
  constructor(host: PluginHost, hub: EventHub, runs: RunService, { intervalMs = 3000 }: { intervalMs?: number } = {}) {
    this.host = host; this.hub = hub; this.runs = runs; this.intervalMs = intervalMs;
    this.entries = new Map(); this.notices = []; this.knownMessages = new Map(); this.nativeRunning = new Set();
    this.bus = new EventEmitter(); this.bus.setMaxListeners(0);
    this.polling = false; this.timer = null; this.clients = 0;
    this.unsubscribe = hub.subscribeAll(event => this.record(event));
  }
  notice(engine: string, sessionId: string, message: NoticeSource, seed = false): boolean {
    if (message.phase === 'analysis' || message.phase === 'reasoning') return false;
    const key = this.hub.key(engine, sessionId);
    const known = this.knownMessages.get(key) || new Set<string>();
    this.knownMessages.set(key, known);
    if (!message.id || known.has(message.id)) return false;
    known.add(message.id); if (known.size > 120) { const oldest = known.values().next().value; if (oldest !== undefined) known.delete(oldest); }
    if (seed) return false;
    const preview = String(message.preview || message.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!preview) return false;
    const entry: ActivityEntry = this.entries.get(key) || { engine, sessionId, running: false, completedAt: 0 };
    entry.lastMessageAt = Date.now(); this.entries.set(key, entry);
    // When the message was said, not when it was first seen here: a late sighting stays old.
    const said = stamp(message.at || message.timestamp || 0), at = said > 0 && said <= Date.now() ? said : Date.now();
    this.notices.push({ id: `${key}:${message.id}`, messageId: message.id, engine, sessionId, preview, phase: String(message.phase || 'assistant'), at });
    this.notices.sort((a, b) => a.at - b.at);
    // Kept per engine: a talkative engine does not push out the last thing a quiet one said.
    const own = this.notices.filter(item => item.engine === engine);
    if (own.length > 40) this.notices.splice(this.notices.indexOf(own[0]!), 1);
    return true;
  }
  record(event: AnyBridgeEvent): void {
    if (event.type === 'assistant.notice' || (event.type === 'message.updated' && get(event.data, 'status') === 'completed')) {
      // Both carry a message: { id, text | preview, phase, at }.
      const data = event.data;
      const said: NoticeSource = { id: String(get(data, 'id') ?? ''), text: get(data, 'text'), preview: get(data, 'preview'), phase: get(data, 'phase'), at: get(data, 'at') };
      if (this.notice(event.engine, event.sessionId, said)) this.changed();
      return;
    }
    const ended = ['run.completed', 'run.failed', 'run.interrupted'].includes(event.type);
    if (event.type !== 'run.started' && !ended && event.type !== 'run.connection_lost') return;
    const key = this.hub.key(event.engine, event.sessionId), previous: Partial<ActivityEntry> = this.entries.get(key) || {};
    // An old snapshot/late event cannot rewrite an already confirmed terminal outcome.
    if (ended && previous.turnId === event.turnId && previous.confirmedTerminal) return;
    // A console run that lost track of its turn is not shown as working on its word alone:
    // from then on the desktop's own record says whether the chat runs (poll).
    this.entries.set(key, { ...previous, engine: event.engine, sessionId: event.sessionId, turnId: event.turnId,
      running: event.type === 'run.started' || (event.type === 'run.connection_lost' && this.nativeRunning.has(key)), outcome: ended ? event.type.slice(4) : null,
      startedAt: event.type === 'run.started' ? Date.parse(event.timestamp) || Date.now() : previous.startedAt || 0,
      confirmedTerminal: ended, completedAt: ended ? Date.parse(event.timestamp) : previous.completedAt || 0,
    });
    this.changed();
  }
  /** An engine has left the console: what it was doing and what it said leave the feed with it. */
  forget(engine: string): void {
    for (const store of [this.entries, this.knownMessages]) for (const key of [...store.keys()]) if (this.hub.owns(engine, key)) store.delete(key);
    for (const key of [...this.nativeRunning]) if (this.hub.owns(engine, key)) this.nativeRunning.delete(key);
    this.notices = this.notices.filter(item => item.engine !== engine);
    this.changed();
  }
  snapshot(): ActivitySnapshot { return { sessions: [...this.entries.values()], notices: this.notices, timestamp: Date.now() }; }
  changed(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 512) break;
      if (!entry.running) { this.entries.delete(key); this.knownMessages.delete(key); }
    }
    this.bus.emit('change', this.snapshot());
  }
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const results = await Promise.allSettled([...this.host.engines.values()].map(async engine => {
        const list = await engine.list(); let changed = false;
        // The engine left while its list was being read (its agent was switched off): nothing is written.
        if (this.host.engines.get(engine.id) !== engine) return false;
        for (const session of Array.isArray(list) ? list : []) {
          const key = this.hub.key(engine.id, session.id), previous = this.entries.get(key);
          const latest = session.metadata?.latestTurn;
          const confirmed = !!(latest && terminal.has(latest.status) && latest.completedAt != null && latest.statusEvidence);
          const token = confirmed && latest ? `${latest.id}:${latest.status}:${latest.completedAt}` : null;
          const initial = !previous;
          const activeRun = this.runs.get(engine.id, session.id);
          const running = latest?.status === 'running' || ['busy', 'running', 'inProgress'].includes(String(session.status));
          if (running) this.nativeRunning.add(key); else this.nativeRunning.delete(key);
          // What the turn in progress said is shown even when the chat is first seen mid-turn
          // (a chat started in the desktop, or one already working when the console opened).
          const since = activeRun ? stamp(activeRun.run.timestamp) : running ? stamp(session.metadata?.turnStartedAt || 0) : 0;
          for (const message of session.metadata?.recentMessages || []) {
            const currentSpeech = since > 0 && stamp(message.at) >= since;
            changed = this.notice(engine.id, session.id, message, previous?.nativeRevision == null && !currentSpeech) || changed;
          }
          if (activeRun && activeRun.run.status !== 'reconnecting') continue;
          const revision = String(session.updatedAt || '');
          // Idle/mtime and a finished shell command are not proof that the task ended.
          const finished = !initial && !running && confirmed && token !== previous.nativeTerminalToken && stamp(latest?.completedAt) > (previous.completedAt || 0);
          const outcome = finished ? latest?.status ?? null : running ? null : previous?.outcome || null;
          // A run seen here first starts when its turn did, so older speech is not shown as its.
          const startedAt = !running ? previous?.startedAt || 0 : (previous?.running && previous.startedAt) || stamp(session.metadata?.turnStartedAt || 0) || Date.now();
          const next: ActivityEntry = { ...previous, engine: engine.id, sessionId: session.id, title: session.title, running, startedAt,
            nativeRevision: revision, nativeTerminalToken: token || previous?.nativeTerminalToken || null,
            outcome, confirmedTerminal: finished || previous?.confirmedTerminal || false,
            completedAt: finished ? stamp(latest?.completedAt) : previous?.completedAt || 0 };
          if (JSON.stringify(next) !== JSON.stringify(previous)) { this.entries.set(key, next); changed = true; }
        }
        return changed;
      }));
      if (results.some(result => result.status === 'fulfilled' && result.value)) this.changed();
    } finally { this.polling = false; }
  }
  subscribe(listener: (snapshot: ActivitySnapshot) => void): () => void {
    this.clients++; this.bus.on('change', listener);
    if (!this.timer) { this.poll(); this.timer = setInterval(() => this.poll(), this.intervalMs); this.timer.unref?.(); }
    listener(this.snapshot());
    return () => { this.bus.off('change', listener); if (--this.clients === 0) { if (this.timer) clearInterval(this.timer); this.timer = null; } };
  }
  dispose(): void { this.unsubscribe(); if (this.timer) clearInterval(this.timer); this.bus.removeAllListeners(); }
}
export { ActivityFeed };
