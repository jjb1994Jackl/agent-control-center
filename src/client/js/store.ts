import { t } from './i18n.js';
import { sameTurn } from '../../shared/turn-match.js';
import type { Activity, Approval, BridgeEvent, BridgeEventMap, BridgeEventOf, BridgeEventType, MediaImage, PresentedArtifact, PresentedMessage, PresentedTurn, QueuedMessage, RunTurn, SessionHistoryResponse, TimeValue, TimelineEntry, UnifiedSession } from '../../shared/contract.js';

export const terminalStatuses = new Set<string>(['completed', 'failed', 'interrupted']);

/**
 * A turn as the page holds it: a turn read from the desktop's record (PresentedTurn) or one the
 * console runs (RunTurn), plus what the page adds while following it (source, warning, error).
 */
export interface PageTurn {
  /** null only for a turn made up for an event that came without one (see apply). */
  id: string | null;
  userPrompt: string;
  userImages?: MediaImage[];
  timestamp?: TimeValue | null;
  status: string;
  statusEvidence?: string | null;
  completedAt?: TimeValue | null;
  durationMs?: number;
  workedMs?: number;
  nativeTurnId?: string;
  /** 'console' while the console runs or follows it (RunService). */
  source?: 'console';
  warning?: string;
  error?: string;
  messages: PresentedMessage[];
  activities: Activity[];
  artifacts: PresentedArtifact[];
  approvals: Approval[];
  timeline: TimelineEntry[];
}
/** A full read of the conversation (GET /api/sessions/…, or a session.snapshot event). */
export interface Snapshot { session?: UnifiedSession | null; turns?: PresentedTurn[]; activeTurn?: RunTurn | null; queued?: QueuedMessage[]; queuePaused?: boolean; cursor?: string }

export function upsert<T extends { id: unknown }>(list: T[], value: T): void {
  const index = list.findIndex(item => item.id === value.id);
  if (index < 0) list.push(value); else list[index] = { ...list[index], ...value };
}
export function emptyTurn(id: string | null): PageTurn { return { id, userPrompt: '', status: 'running', messages: [], activities: [], artifacts: [], approvals: [], timeline: [] }; }

type Handler<K extends BridgeEventType> = (turn: PageTurn, data: BridgeEventMap[K]) => void;
type Handlers = { [K in BridgeEventType]?: Handler<K> };
// The handler for this event's type, given this event's data (the type ties the two together).
function dispatch<K extends BridgeEventType>(handlers: Handlers, turn: PageTurn, event: BridgeEventOf<K>): void {
  const handler = handlers[event.type];
  handler?.(turn, event.data);
}

export class ConversationStore {
  /** The last event's id; null when the stream's first frame said so (no event yet). */
  turns: PageTurn[] = []; cursor: string | null = ''; seen = new Set<string>(); handlers: Handlers = {};
  queue?: QueuedMessage[];
  queuePaused = false;
  /** Bumped by the page when it restores a run, so a cached view knows to redraw. */
  revision?: number;
  register<K extends BridgeEventType>(type: K, handler: Handler<K>): void { Object.assign(this.handlers, { [type]: handler }); }
  load(history: SessionHistoryResponse): void {
    this.turns = (history.turns || []).map(turn => ({ ...emptyTurn(turn.id), ...turn }));
    this.cursor = history.cursor || ''; this.seen.clear(); this.queue = history.queued || []; this.queuePaused = !!history.queuePaused;
    if (history.activeTurn) this.restore(history.activeTurn);
  }
  restore(turn: RunTurn): void { upsert(this.turns, { ...emptyTurn(turn.id), ...structuredClone(turn), source: 'console' }); }
  reconcile(snapshot: Snapshot): void {
    if (Array.isArray(snapshot.queued)) this.queue = snapshot.queued;
    if (typeof snapshot.queuePaused === 'boolean') this.queuePaused = snapshot.queuePaused;
    // A full read says which run the server still follows. A console turn it no longer has
    // (the run ended while we were away, or the server restarted) stops being protected:
    // the native history decides, and if it has nothing yet the turn is marked unconfirmed.
    if ('activeTurn' in snapshot) for (const turn of this.turns) {
      if (turn.source !== 'console' || !['running', 'reconnecting'].includes(turn.status) || turn.id === snapshot.activeTurn?.id) continue;
      turn.status = 'unknown'; turn.warning = t('工作台没有在跟踪这一轮了（例如服务重启过），结果以桌面版的记录为准');
      for (const activity of turn.activities) if (activity.status === 'running') activity.status = 'unknown';
    }
    // A turn the console still follows is in the desktop's record too (shared/turn-match.ts): it
    // is shown once, as the console's turn, with the message as the desktop wrote it down.
    const followed = this.turns.filter(turn => turn.source === 'console' && ['running', 'reconnecting'].includes(turn.status));
    for (const turn of followed) if (turn.id === snapshot.activeTurn?.id && snapshot.activeTurn?.nativeTurnId) turn.nativeTurnId = snapshot.activeTurn.nativeTurnId;
    const read: PageTurn[] = (snapshot.turns || []).map(turn => ({ ...emptyTurn(turn.id), ...turn }));
    const native = read.filter(turn => {
      const local = followed.find(local => sameTurn(turn, local));
      if (local) { local.nativeTurnId = turn.id ?? undefined; local.userPrompt = turn.userPrompt; if (turn.userImages) local.userImages = turn.userImages; }
      return !local;
    });
    // A console turn that has ended gives way to the desktop's record of it, once that record
    // says how it ended (or the console's own does not either).
    const pending = this.turns.filter(turn => turn.source === 'console' && !native.some(other => sameTurn(other, turn) && (other.status !== 'unknown' || turn.status === 'unknown')));
    this.turns = [...native, ...pending];
  }
  apply(event: BridgeEvent): boolean {
    if (event.id && this.seen.has(event.id)) return false;
    if (event.id) {
      this.seen.add(event.id); this.cursor = event.id;
      const oldest = this.seen.size > 1200 ? this.seen.values().next().value : undefined;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    let turn = this.turns.find(turn => turn.id === event.turnId);
    // The page handles the events that come without a turn (queue, notices, snapshots) before
    // they get here; one that still did would get a turn of its own with a null id, as before.
    if (!turn) { turn = emptyTurn(event.turnId); this.turns.push(turn); }
    dispatch(this.handlers, turn, event);
    return true;
  }
  get active(): PageTurn | undefined { return [...this.turns].reverse().find(turn => ['running', 'reconnecting'].includes(turn.status)); }
}

// Adds or updates an item, and places a new one in the turn's timeline.
function track<T extends { id: string }>(turn: PageTurn, list: T[], data: T, kind?: TimelineEntry['kind']): void {
  const exists = list.some(item => item.id === data.id);
  upsert(list, data);
  if (!exists && kind) (turn.timeline ||= []).push({ kind, id: data.id });
}
export function createStore(): ConversationStore {
  const store = new ConversationStore();
  store.register('run.started', (turn, data) => Object.assign(turn, emptyTurn(turn.id), structuredClone(data.turn), { source: 'console' as const }));
  store.register('message.updated', (turn, data) => { turn.warning = ''; track(turn, turn.messages, data, 'message'); });
  store.register('activity.upsert', (turn, data) => { turn.warning = ''; track(turn, turn.activities, data, 'activity'); });
  store.register('artifact.upsert', (turn, data) => track(turn, turn.artifacts, data, 'artifact'));
  store.register('approval.requested', (turn, data) => track(turn, turn.approvals, data));
  store.register('approval.resolved', (turn, data) => { turn.approvals = turn.approvals.filter(item => item.id !== data.id); });
  store.register('run.warning', (turn, data) => { turn.warning = data.message; });
  store.register('run.connection_lost', (turn, data) => { turn.status = 'reconnecting'; turn.warning = data.message; });
  const finish = (status: string) => (turn: PageTurn, data: { message?: string; nativeTurnId?: string }) => {
    if (data.nativeTurnId) turn.nativeTurnId = data.nativeTurnId;
    if (terminalStatuses.has(turn.status)) return;
    turn.status = status; turn.statusEvidence = 'run_event'; turn.error = data.message || '';
    for (const message of turn.messages) message.status = 'completed';
    for (const activity of turn.activities) if (activity.status === 'running') activity.status = status === 'completed' ? 'completed' : 'interrupted';
    turn.approvals = [];
    const candidates = turn.messages.filter(message => !['commentary', 'final_answer'].includes(message.phase || ''));
    for (const message of candidates) message.phase = message === candidates.at(-1) ? 'final_answer' : 'commentary';
  };
  store.register('run.completed', finish('completed'));
  store.register('run.failed', finish('failed'));
  store.register('run.interrupted', finish('interrupted'));
  return store;
}
