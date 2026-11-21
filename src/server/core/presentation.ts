import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyTool } from '../services/tool-catalog.js';
import type {
  Activity, Approval, BridgeEventArgs, EngineEmitter, EngineEventMap, EngineEventName, FileChange, MediaImage, PlanItem,
  PresentedArtifact, PresentedMessage, PresentedTurn, UnifiedSession, UnifiedTurn,
} from '../../shared/contract.js';
import { bag, get, list, str, type Bag } from '../../shared/guards.js';

const clip = (value: unknown, limit = 16000) => String(value ?? '').slice(0, limit);
const brief = (value: unknown) => clip(String(value || '').replace(/\s+/g, ' ').trim(), 220);
const STATUS: Record<string, string> = { inProgress: 'running', in_progress: 'running', error: 'failed', cancelled: 'interrupted' };
const statusOf = (value: unknown): string => (typeof value === 'string' && Object.hasOwn(STATUS, value) ? STATUS[value] : undefined) || (value ? String(value) : '') || 'completed';
const textOf = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => get(v, 'text') || get(v, 'content') || '').join('\n') : '';

// Two native in-chat things every desktop AI shows: its step list (plan) and images it
// produced or captured (screenshots). Images are served by the engine's media() method.
const MEDIA = /^\/api\/sessions\/[a-z][a-z0-9-]*\/[\w-]{1,200}\/media\/[\w.-]{1,200}$/;
const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);
const isPlanStatus = (value: unknown): value is PlanItem['status'] => typeof value === 'string' && PLAN_STATUS.has(value);
const planOf = (plan: unknown): PlanItem[] | undefined => Array.isArray(plan) ? plan.slice(0, 60).map((step: unknown): PlanItem => { const status = get(step, 'status'); return { content: brief(get(step, 'content') ?? get(step, 'step') ?? get(step, 'text') ?? ''), status: isPlanStatus(status) ? status : 'pending' }; }).filter(step => step.content) : undefined;
const imagesOf = (images: unknown): MediaImage[] | undefined => Array.isArray(images) ? images.filter(image => MEDIA.test(str(get(image, 'url')) || '')).slice(0, 12).map(image => ({ url: String(get(image, 'url')), alt: brief(get(image, 'alt') || '') })) : undefined;
// Files an edit changed, as line counts only (the patch itself never leaves the server).
// Accepts the engine's raw changes ({ path, kind, diff }) or counted ones ({ path, added, removed }).
function countDiff(diff: unknown, kind: string): { added: number; removed: number } {
  const text = String(diff || ''), lines = text.replace(/\n$/, '').split('\n');
  if (!text) return { added: 0, removed: 0 };
  if (!/^@@ /m.test(text)) return kind === 'delete' ? { added: 0, removed: lines.length } : { added: lines.length, removed: 0 };
  let added = 0, removed = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}
function changesOf(input: unknown): FileChange[] | undefined {
  if (!Array.isArray(input) || !input.length) return undefined;
  return input.filter(change => get(change, 'path')).slice(0, 200).map((change): FileChange => {
    const kind = String(get(change, 'kind', 'type') || get(change, 'kind') || 'update');
    const added = get(change, 'added');
    const counted = typeof added === 'number' ? { added, removed: Number(get(change, 'removed') || 0) } : countDiff(get(change, 'diff') || get(change, 'patch'), kind);
    return { path: String(get(change, 'path')).slice(0, 400), kind: ['add', 'delete', 'update'].includes(kind) ? kind : 'update', ...counted };
  });
}
// Codex app-server item types that arrive raw while a run is live.
function nativeItem(item: Bag): Bag {
  const type = get(item, 'type');
  const tool = () => `${get(item, 'server') || get(item, 'namespace') || 'tool'}.${get(item, 'tool') || ''}`;
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') { const args = get(item, 'arguments'); return { ...item, type: 'tool_call', name: tool(), title: `Called · ${tool()}`, detail: args && Object.keys(bag(args) || {}).length ? JSON.stringify(args, null, 2) : '', output: textOf(get(item, 'result', 'content') || get(item, 'contentItems')), status: get(item, 'success') === false ? 'failed' : get(item, 'status') }; }
  if (type === 'imageView') return { ...item, type: 'image_view', title: `Viewed · ${get(item, 'path') || 'image'}`, detail: get(item, 'path') || '', paths: get(item, 'path') ? [get(item, 'path')] : [] };
  if (type === 'contextCompaction') return { ...item, type: 'notice', title: get(item, 'completedAtMs') ? 'Context automatically compacted' : 'Compacting context', status: get(item, 'completedAtMs') ? 'completed' : 'running' };
  if (type === 'fileChange' && !get(item, 'title')) return { ...item, title: `Edited · ${list(get(item, 'changes')).map(c => get(c, 'path')).filter(Boolean).join(', ') || 'Files'}` };
  return item;
}
const KINDS: Record<string, string> = {
  commandExecution: 'command', command: 'command', fileChange: 'file_change',
  file_change: 'file_change', reasoning: 'reasoning', webSearch: 'web_search', web_search: 'web_search',
  notice: 'notice', background_task: 'background_task', stop_task: 'stop_task', image_view: 'image_view', user_message: 'user_message',
};
// The address a preview opened is the first web address its result names.
const addressOf = (output: unknown): string => String(output || '').match(/\bhttps?:\/\/[^\s"'<>)\]]+/)?.[0]?.replace(/[.,;:]+$/, '') || '';
/** One tool step (a UnifiedStep from history, or a raw item from a live run) as the page draws it. */
function activityOf(raw: object, status?: unknown): Activity {
  const item = nativeItem(bag(raw) || {});
  const kind = String(get(item, 'type') || 'tool_call');
  const command = get(item, 'command') || get(item, 'detail') || '';
  const tool = classifyTool(String(get(item, 'name') || get(item, 'tool') || get(item, 'type') || ''), get(item, 'input') || get(item, 'arguments') || {});
  const mapped = (Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined) || tool.type;
  const titles: Record<string, string> = {
    command: get(item, 'title') && get(item, 'title') !== 'Ran command' ? brief(get(item, 'title')) : `Ran command · ${brief(command || tool.command) || 'Shell'}`,
    file_change: tool.type === 'file_change' ? String(tool.summary) : brief(get(item, 'title')) || 'Updated files', reasoning: '正在处理任务',
    web_search: `Searched · ${brief(get(item, 'query') || get(item, 'detail') || tool.summary)}`,
  };
  const title = (Object.hasOwn(titles, mapped) ? titles[mapped] : undefined) || brief(get(item, 'title') || tool.summary || get(item, 'name') || kind);
  const plan = planOf(get(item, 'plan')), images = imagesOf(get(item, 'images')), changes = changesOf(get(item, 'changes'));
  const paths = get(item, 'paths') || tool.paths || list(get(item, 'changes')).map(c => get(c, 'path')).filter(Boolean);
  const output = ['reasoning', 'file_change'].includes(mapped) ? '' : clip(get(item, 'aggregatedOutput') || get(item, 'output') || get(item, 'stdout') || textOf(get(item, 'result', 'content')));
  const url = mapped === 'preview' ? addressOf(output) : '';
  return {
    id: String(get(item, 'id') || randomUUID()), kind: mapped, title,
    status: statusOf(status || get(item, 'status')),
    // Private reasoning and patches never enter the public event stream.
    detail: ['reasoning', 'file_change'].includes(mapped) ? '' : clip(mapped === 'command' ? command || tool.command : get(item, 'detail') || tool.detail),
    output,
    durationMs: Number(get(item, 'durationMs') || 0),
    // Paths come from native records: anything that is not text is shown as text.
    paths: list(paths).map(String),
    ...(plan ? { plan } : {}),
    ...(images?.length ? { images } : {}),
    ...(changes ? { changes } : {}),
    ...(url ? { url } : {}),
  };
}
function artifactOf(item: unknown): PresentedArtifact | null {
  if (!get(item, 'path') && !get(item, 'url')) return null;
  const location = String(get(item, 'path') || get(item, 'url'));
  return { id: String(get(item, 'id') || location), kind: String(get(item, 'kind') || 'file'), title: String(get(item, 'title') || path.basename(location)), path: String(get(item, 'path') || ''), url: /^\/uploads\//.test(str(get(item, 'url')) || '') ? String(get(item, 'url')) : '', summary: brief(get(item, 'summary')) };
}
// Engines record times as ISO text, epoch seconds or epoch milliseconds; the page reads ISO.
const isoOf = (value: unknown): string | null => { if (value == null || value === '') return null; const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value)); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
// The agent's own question as a card in the chat: one single-answer question has its options as
// the card's buttons (plus Skip); a form of several, or a multiple choice, is answered in the
// desktop app and says so. `questions`: [{ question, multi, options: [{ id, label }] }].
export interface Question { question?: string; multi?: boolean; options?: Array<{ id: string | number; label?: string }> }
// `desktop`: the engine can take the person to the chat in its desktop app (showInDesktop).
function questionCard(id: string, questions: Question[] = [], app = '', { desktop = false }: { desktop?: boolean } = {}): Approval {
  const [only] = questions;
  if (questions.length === 1 && only && !only.multi && only.options?.length) return { id, title: String(only.question || ''), detail: '', decisions: [...only.options.map(option => ({ id: `option:${option.id}`, label: String(option.label || '') })), { id: 'decline', label: '跳过' }] };
  return { id, title: questions.map(item => item.question).filter(Boolean).join('\n') || `${app} 有问题要问你`, detail: `这组问题要在 ${app} 桌面端回答`, decisions: desktop ? [SHOW_DESKTOP] : [] };
}
// What the person can only do in the desktop app itself (a dialog it shows, waiting on them):
// a card that says so, whose one button takes them to the chat there (Approval: 'desktop').
const SHOW_DESKTOP = 'desktop';
function desktopCard(id: string, title: string, detail = ''): Approval { return { id, title, detail, decisions: [SHOW_DESKTOP] }; }
// The session's status as the history reads it (a string, or an object with `type` from older adapters).
const sessionBusy = (session: UnifiedSession | null | undefined): boolean => { const status: unknown = session?.status; const type = get(status, 'type') || status; return type === 'busy' || type === 'running'; };
function presentHistory<H extends { turns?: UnifiedTurn[]; session?: UnifiedSession | null }>(history: H): Omit<H, 'turns'> & { turns: PresentedTurn[] } {
  const turns: UnifiedTurn[] = history.turns || [];
  const busy = sessionBusy(history.session);
  return { ...history, turns: turns.map((turn, index): PresentedTurn => ({
    timeline: turn.timeline || [],
    id: turn.id, userPrompt: turn.userPrompt, userImages: imagesOf(turn.userImages) || [], timestamp: isoOf(turn.timestamp), durationMs: Number(turn.durationMs) || 0, workedMs: Number(turn.workedMs) || 0, status: busy && index === turns.length - 1 && !turn.statusEvidence ? 'running' : statusOf(turn.status || 'unknown'), statusEvidence: turn.statusEvidence || null, completedAt: isoOf(turn.completedAt),
    messages: turn.messages?.length ? turn.messages.filter(message => !['analysis', 'reasoning'].includes(String(message.phase))) : [{ id: `${turn.id}:reply`, phase: 'final_answer', text: turn.assistantReply || '' }],
    activities: (turn.steps || []).map(step => activityOf(step)),
    // An agent that edits the same file several times names it once.
    artifacts: [...new Map((turn.artifacts || []).map(artifactOf).filter((item): item is PresentedArtifact => !!item).map(item => [item.path || item.url || item.id, item])).values()],
    ...(turn.approvals?.length ? { approvals: turn.approvals } : {}),
  })) };
}

/** The public events a run publishes (RunService gives each one to the journal). */
export type Emit = (...args: BridgeEventArgs) => void;

function bindEvents(emitter: EngineEmitter, emit: Emit): () => void {
  // Providers may report a late process error after a terminal event/disposal.
  if (!emitter.listenerCount('error')) emitter.on('error', () => {});
  const subscriptions: Array<() => void> = [];
  const messages = new Map<string, PresentedMessage>();
  const activities = new Map<string, Activity>();
  let lastToolId: string | undefined;
  const on = <K extends EngineEventName>(event: K, fn: (...args: EngineEventMap[K]) => void) => { emitter.on(event, fn); subscriptions.push(() => emitter.off(event, fn)); };
  const upsert = (activity: Activity) => { activities.set(activity.id, activity); lastToolId = activity.id; emit('activity.upsert', activity); };
  const message = (id: string, text: string, phase: unknown, replace = false, status: 'streaming' | 'completed' = 'streaming') => {
    if (phase === 'analysis' || phase === 'reasoning') return;
    const previous = messages.get(id);
    const next: PresentedMessage = { id, status, phase: String(phase || previous?.phase || 'assistant'), text: replace ? text : (previous?.text || '') + text };
    messages.set(id, next); emit('message.updated', next);
  };
  const itemEvent = (data: unknown, status: unknown) => {
    const item = bag(get(data, 'item') || data) || {};
    if (get(item, 'type') === 'agentMessage') {
      message(String(get(item, 'id')), textOf(get(item, 'text') || get(item, 'content')), get(item, 'phase'), true, status === 'running' ? 'streaming' : 'completed');
    } else if (!['userMessage', 'sleep'].includes(String(get(item, 'type')))) {
      const next = activityOf(item, status), previous = activities.get(String(get(item, 'id')));
      if (!next.output && previous?.output) next.output = previous.output;
      upsert({ ...previous, ...next });
    }
  };
  on('item_started', data => itemEvent(data, 'running'));
  on('item_completed', data => itemEvent(data, get(data, 'item', 'status') || 'completed'));
  on('delta', data => {
    const id = data.itemId || data.id;
    switch (data.type) {
      case 'agent_message': message(id || 'reply', data.text || '', data.phase); break;
      case 'reasoning': upsert({ id: id || 'working', kind: 'reasoning', title: '正在处理任务', status: 'running', detail: '', output: '', durationMs: 0, paths: [] }); break;
      case 'command_output': {
        const key = id || lastToolId || 'command';
        const old: Activity = activities.get(key) || { id: key, kind: 'command', title: 'Ran command', detail: '', status: 'running', output: '', durationMs: 0, paths: [] };
        upsert({ ...old, output: clip((old.output || '') + (data.output || '')) });
        break;
      }
      case 'tool_call': {
        const tool = classifyTool(data.name, data.input || {});
        upsert(activityOf({ id: id || randomUUID(), type: tool.type, name: data.name, input: data.input, command: tool.command, detail: tool.detail, title: get(data.input, 'description') || get(data.input, 'toolSummary') || tool.summary, paths: tool.paths, plan: data.plan }, data.plan ? 'completed' : 'running'));
        break;
      }
      case 'tool_result': {
        const old = id ? activities.get(id) : undefined;
        if (old) {
          const images = imagesOf(data.images);
          const url = old.kind === 'preview' && !data.isError ? addressOf(data.output) : '';
          upsert({ ...old, status: data.isError ? 'failed' : 'completed', output: old.kind === 'file_change' ? '' : clip(data.output), ...(images?.length ? { images } : {}), ...(url ? { url } : {}) });
        }
        break;
      }
      // File patches deliberately carry no presentation payload.
      case 'file_patch': break;
    }
  });
  // A file card is drawn only where the engine says its desktop shows one (an `artifact` event, the
  // same thing its history lists): a file the agent merely read or edited is not one by itself.
  on('artifact', data => { const artifact = artifactOf(data); if (artifact) emit('artifact.upsert', artifact); });
  on('approval_resolved', data => emit('approval.resolved', { id: String(data.id) }));
  on('approval', data => emit('approval.requested', { id: String(data.id), title: brief(data.title || '需要批准操作'), detail: clip(data.detail), decisions: (data.decisions || ['accept', 'decline']).slice(0, 12).map(item => typeof item === 'string' ? item : { id: String(get(item, 'id') ?? ''), label: brief(get(item, 'label')) }) }));
  on('completed', data => {
    for (const value of [...messages.values()]) if (value.status !== 'completed') message(value.id, value.text, value.phase, true, 'completed');
    if (data?.reply && !messages.size && !['Finished turn', '已完成。'].includes(data.reply)) message('reply', data.reply, 'final_answer', true, 'completed');
    if (data?.code && data.code !== 0) emit('run.failed', { message: `Engine exited (${data.code})` });
    else if (data?.turn?.status === 'failed') emit('run.failed', { message: data.turn.error?.message || '执行失败' });
    else if (data?.turn?.status === 'interrupted') emit('run.interrupted', {});
    else emit('run.completed', {});
  });
  on('warning', data => emit('run.warning', { message: data.message || '引擎正在重试', retrying: data.retrying !== false, awaitingEnd: !!data.awaitingEnd }));
  on('error', err => {
    const message = get(err, 'message') ? String(get(err, 'message')) : String(err);
    if (get(err, 'transport') || get(err, 'terminal') === false) emit('run.connection_lost', { message }); else emit('run.failed', { message });
  });
  return () => { for (const off of subscriptions) off(); };
}
export { presentHistory, bindEvents, activityOf, artifactOf, changesOf, questionCard, desktopCard, SHOW_DESKTOP, isoOf };
