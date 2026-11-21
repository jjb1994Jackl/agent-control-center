import fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { bag, get, list, parseJson } from '../../shared/guards.js';
import type { TimeValue } from '../../shared/contract.js';
const terminal = new Set<unknown>(['completed', 'failed', 'interrupted']);

/** A turn as the task lifecycle records it: started, then completed or aborted (with the record's time). */
export interface LifecycleTurn { id: string; status: string; statusEvidence: string; startedAt?: TimeValue | null; completedAt: TimeValue | null }
/** Something the assistant said, from the log: public text only. */
export interface LifecycleMessage { id: string; turnId: string | null; preview: string; phase: string; at: number }
export interface LifecycleEntry {
  offset: number; buffer: string; decoder: StringDecoder; turns: Map<string, LifecycleTurn>; messages: LifecycleMessage[];
  currentTurnId: string | null; latest: LifecycleTurn | null; cwd: string; pendingRead?: Promise<void> | null;
}

// thread/read synthesizes "interrupted" for an unloaded, still-running desktop
// turn. The append-only task lifecycle is the authority for those conversations.
class CodexLifecycle {
  files: Map<string, LifecycleEntry>; maxFiles: number;
  constructor({ maxFiles = 64 }: { maxFiles?: number } = {}) { this.files = new Map(); this.maxFiles = maxFiles; }
  async read(file: string | null | undefined): Promise<Pick<LifecycleEntry, 'turns' | 'messages'> & Partial<LifecycleEntry>> {
    if (!file) return { turns: new Map(), messages: [] };
    const entry = this.files.get(file) || this.fresh();
    this.files.delete(file); this.files.set(file, entry);
    while (this.files.size > this.maxFiles) { const oldest = this.files.keys().next().value; if (oldest === undefined) break; this.files.delete(oldest); }
    if (!entry.pendingRead) entry.pendingRead = this.update(file, entry).finally(() => { entry.pendingRead = null; });
    await entry.pendingRead;
    return entry;
  }
  fresh(): LifecycleEntry { return { offset: 0, buffer: '', decoder: new StringDecoder('utf8'), turns: new Map(), messages: [], currentTurnId: null, latest: null, cwd: '' }; }
  async update(file: string, entry: LifecycleEntry): Promise<void> {
    let handle: fs.FileHandle | undefined;
    try {
      const size = (await fs.stat(file)).size;
      if (size < entry.offset) Object.assign(entry, this.fresh());
      if (size === entry.offset) return;
      handle = await fs.open(file, 'r');
      while (entry.offset < size) {
        const bytes = Buffer.alloc(Math.min(65536, size - entry.offset));
        const read = await handle.read(bytes, 0, bytes.length, entry.offset);
        if (!read.bytesRead) break;
        entry.offset += read.bytesRead;
        entry.buffer += entry.decoder.write(bytes.subarray(0, read.bytesRead));
        let index;
        while ((index = entry.buffer.indexOf('\n')) >= 0) {
          const line = entry.buffer.slice(0, index); entry.buffer = entry.buffer.slice(index + 1);
          let record: unknown; try { record = parseJson(line); } catch { continue; }
          this.record(entry, record);
        }
      }
    } catch { /* Missing/inaccessible logs are unknown, never a fabricated terminal state. */ }
    finally { await handle?.close(); }
  }
  // One log record (JSON of unknown shape): only the lifecycle events and public assistant text are read.
  record(entry: LifecycleEntry, record: unknown): void {
    // A record's time is ISO text (or a number); anything else is no time.
    const type = get(record, 'type'), stamped = get(record, 'timestamp'), timestamp = timeOf(stamped);
    const payload = bag(get(record, 'payload')) || {};
    // A conversation moved to another project keeps its first folder in thread/list;
    // each turn records the folder it really ran in.
    if (type === 'turn_context' && typeof payload.cwd === 'string') entry.cwd = payload.cwd;
    if (type === 'event_msg') {
      const id = payload.turn_id ? String(payload.turn_id) : entry.currentTurnId;
      if (payload.type === 'task_started' && id) {
        entry.currentTurnId = id;
        const turn: LifecycleTurn = { id, status: 'running', statusEvidence: 'task_started', startedAt: timestamp, completedAt: null };
        entry.turns.set(id, turn); entry.latest = turn;
      } else if (id && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) {
        const turn: LifecycleTurn = { ...entry.turns.get(id), id, status: payload.type === 'task_complete' ? 'completed' : 'interrupted', statusEvidence: payload.type, completedAt: timestamp };
        entry.turns.set(id, turn); if (!entry.currentTurnId || entry.currentTurnId === id) entry.latest = turn;
      }
      while (entry.turns.size > 256) { const oldest = entry.turns.keys().next().value; if (oldest === undefined) break; entry.turns.delete(oldest); }
    } else if (type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.channel !== 'analysis' && payload.phase !== 'analysis') {
      const text = list(payload.content || []).filter(item => get(item, 'type') === 'output_text' || get(item, 'type') === 'text').map(item => get(item, 'text') || '').join('\n').trim();
      if (!text) return;
      const preview = text.replace(/\s+/g, ' ').slice(0, 200);
      const id = payload.id ? String(payload.id) : createHash('sha256').update(`${entry.currentTurnId}:${stamped}:${preview}`).digest('hex').slice(0, 24);
      const message: LifecycleMessage = { id, turnId: entry.currentTurnId, preview, phase: String(payload.phase || 'assistant'), at: Date.parse(String(stamped)) || 0 };
      if (!entry.messages.some(item => item.id === id)) entry.messages.push(message);
      if (entry.messages.length > 24) entry.messages.shift();
    }
  }
}
/** The status a Codex turn shows: the lifecycle log wins over thread/read's synthesized status. */
const timeOf = (value: unknown): TimeValue | null => typeof value === 'number' || typeof value === 'string' ? value : null;
export interface ResolvedTurn { status: string; statusEvidence: string; completedAt: TimeValue | null }
function resolveCodexTurn(raw: { status?: unknown; completedAt?: unknown }, lifecycle?: LifecycleTurn | null): ResolvedTurn {
  const end = typeof raw.completedAt === 'number' ? raw.completedAt : Date.parse(String(raw.completedAt)) || 0;
  if (lifecycle?.status === 'running' && end > 0 && terminal.has(raw.status)) return { status: String(raw.status), statusEvidence: 'completed_at', completedAt: timeOf(raw.completedAt) };
  if (lifecycle) return { status: lifecycle.status, statusEvidence: lifecycle.statusEvidence, completedAt: timeOf(lifecycle.completedAt) || null };
  if (end > 0 && terminal.has(raw.status)) return { status: String(raw.status), statusEvidence: 'completed_at', completedAt: timeOf(raw.completedAt) };
  if (raw.status === 'inProgress' || raw.status === 'running' || raw.status === 'in_progress') return { status: 'running', statusEvidence: 'native_running', completedAt: null };
  return { status: 'unknown', statusEvidence: 'unconfirmed', completedAt: null };
}
export { CodexLifecycle, resolveCodexTurn };
