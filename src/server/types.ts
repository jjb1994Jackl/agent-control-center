// Unified data format for sessions, turns, steps, and artifacts.
// This common layer normalizes Codex app-server responses, Claude Code jsonl transcripts and
// Antigravity transcripts. The shapes are the plugin contract's (src/shared/contract.ts).
import { EventEmitter } from 'node:events';
import type {
  Approval, EngineEmitter, EngineEventMap, EngineEventName,
  UnifiedStep as Step, UnifiedTurn as Turn, UnifiedSession as Session, UnifiedMessage, TimelineEntry, Artifact,
  MediaImage, PlanItem, FileChange, SessionMetadata, SessionStatus, StepType, StepStatus, TurnStatus, TimeValue,
} from '../shared/contract.js';

export interface StepInit {
  id?: string | null;
  type: StepType | string;
  title?: string;
  name?: string;
  input?: unknown;
  paths?: string[] | null;
  plan?: PlanItem[] | null;
  images?: MediaImage[] | null;
  changes?: FileChange[] | null;
  detail?: string;
  output?: string;
  patch?: string;
  status?: StepStatus | string;
  durationMs?: number;
}

class UnifiedStep implements Step {
  id: string; type: StepType | string; title: string | undefined; name: string; input: unknown;
  paths?: string[]; plan?: PlanItem[]; images?: MediaImage[]; changes?: FileChange[];
  detail: string; output: string; patch: string; status: StepStatus | string; durationMs: number;
  /** Server-side only: a command still running in the background after its tool call returned. */
  background?: boolean;
  constructor({ id, type, title, name = '', input = null, paths = null, plan = null, images = null, changes = null, detail = '', output = '', patch = '', status = 'completed', durationMs = 0 }: StepInit) {
    this.id = id || Math.random().toString(36).slice(2);
    // type: 'reasoning' | 'tool_call' | 'command' | 'file_change' | 'web_search' | 'info'
    this.type = type;
    this.title = title;
    // Native tool name and arguments let the shared tool catalog summarize the step.
    this.name = name;
    this.input = input;
    if (paths) this.paths = paths;
    // The AI's step list ([{ content, status }]) and images ([{ url, alt }]) served by the engine's media().
    if (plan) this.plan = plan;
    if (images) this.images = images;
    // Files an edit changed, as line counts only: [{ path, kind, added, removed }].
    if (changes) this.changes = changes;
    this.detail = detail;
    this.output = output;
    this.patch = patch;
    this.status = status; // 'running' | 'completed' | 'failed' | 'interrupted'
    this.durationMs = durationMs;
  }
}

export interface TurnInit {
  id?: string | null;
  userPrompt?: string;
  timestamp?: TimeValue;
  status?: TurnStatus | string;
  steps?: Step[];
  assistantReply?: string;
  artifacts?: Artifact[];
  messages?: UnifiedMessage[];
  timeline?: TimelineEntry[];
  statusEvidence?: string | null;
  completedAt?: TimeValue | null;
  userImages?: MediaImage[];
  durationMs?: number;
  workedMs?: number;
}

class UnifiedTurn implements Turn {
  id: string; userPrompt: string; timestamp: TimeValue; status: TurnStatus | string;
  statusEvidence: string | null; completedAt: TimeValue | null; steps: Step[]; assistantReply: string;
  artifacts: Artifact[]; messages: UnifiedMessage[]; timeline: TimelineEntry[]; userImages: MediaImage[];
  durationMs: number; workedMs: number; approvals?: Approval[];
  constructor({ id, userPrompt = '', timestamp = new Date().toISOString(), status = 'completed', steps = [], assistantReply = '', artifacts = [], messages = [], timeline = [], statusEvidence = null, completedAt = null, userImages = [], durationMs = 0, workedMs = 0 }: TurnInit) {
    this.id = id || Math.random().toString(36).slice(2);
    this.userPrompt = userPrompt;
    this.timestamp = timestamp;
    this.status = status;
    this.statusEvidence = statusEvidence; this.completedAt = completedAt;
    this.steps = steps;
    this.assistantReply = assistantReply;
    this.artifacts = artifacts;
    this.messages = messages;
    this.timeline = timeline;
    // Pictures the person attached to their message: [{ url, alt }], url from the engine's media().
    this.userImages = userImages;
    // How long the turn ran (ms), and how long before its final answer began, when recorded.
    this.durationMs = durationMs;
    this.workedMs = workedMs;
  }
}

export interface SessionInit {
  id: string;
  engine: string;
  title?: string;
  updatedAt?: TimeValue | null;
  cwd?: string;
  status?: SessionStatus;
  isDesktopActive?: boolean;
  sendBlocked?: string;
  metadata?: SessionMetadata;
}

class UnifiedSession implements Session {
  id: string; engine: string; title: string; updatedAt: TimeValue; cwd: string; status: SessionStatus;
  isDesktopActive: boolean; sendBlocked: string; metadata: SessionMetadata;
  constructor({ id, engine, title, updatedAt, cwd = '', status = 'idle', isDesktopActive = false, sendBlocked = '', metadata = {} }: SessionInit) {
    this.id = id;
    this.engine = engine; // 'codex' | 'claude' | 'antigravity'
    this.title = title || 'Untitled Session';
    this.updatedAt = updatedAt || new Date().toISOString();
    this.cwd = cwd;
    this.status = status; // 'idle' | 'busy'
    this.isDesktopActive = isDesktopActive;
    // A non-empty reason means the console can mirror this session but must not write to it.
    this.sendBlocked = sendBlocked;
    this.metadata = metadata;
  }
}

// Messages followed by tool work are progress notes; the last one is the answer.
function assignPhases<T extends Pick<Turn, 'timeline' | 'messages' | 'assistantReply'>>(turn: T): T {
  const order = turn.timeline.map(entry => entry.kind);
  turn.timeline.forEach((entry, index) => {
    if (entry.kind !== 'message') return;
    const message = turn.messages.find(item => item.id === entry.id);
    if (message) message.phase = order.slice(index + 1).includes('activity') ? 'commentary' : 'final_answer';
  });
  const answers = turn.messages.filter(message => message.phase === 'final_answer');
  for (const message of answers.slice(0, -1)) message.phase = 'commentary';
  turn.assistantReply = answers.at(-1)?.text || turn.messages.at(-1)?.text || '';
  return turn;
}

/** The emitter send() and observe() return: Node's EventEmitter, typed by the contract's events. */
// Each method narrows Node's (string, any[]) signature to the contract's event map.
class EngineEvents extends EventEmitter implements EngineEmitter {
  turnId?: string | null;
  override on<K extends EngineEventName>(event: K, listener: (...args: EngineEventMap[K]) => void): this { return super.on(event, listener); }
  override once<K extends EngineEventName>(event: K, listener: (...args: EngineEventMap[K]) => void): this { return super.once(event, listener); }
  override off<K extends EngineEventName>(event: K, listener: (...args: EngineEventMap[K]) => void): this { return super.off(event, listener); }
  override emit<K extends EngineEventName>(event: K, ...args: EngineEventMap[K]): boolean { return super.emit(event, ...args); }
  override listenerCount(event: EngineEventName): number { return super.listenerCount(event); }
}

export {
  EngineEvents,
  UnifiedStep,
  UnifiedTurn,
  UnifiedSession,
  assignPhases,
};
