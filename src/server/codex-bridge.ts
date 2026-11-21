// The Codex engine: threads read from the console's own app-server (`codex app-server --stdio`),
// every turn run by the Codex desktop app. The app-server's answers are its own JSON-RPC format:
// they enter as unknown and are read through the guards, so a field that is missing or shaped
// differently reads as nothing, as optional chaining did.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { NATIVE } from './paths.js';
import { loadConfig, winSpawnArgs } from './config.js';
import EventEmitter from 'node:events';
import { CodexLifecycle, resolveCodexTurn } from './services/codex-lifecycle.js';
import { changesOf, questionCard } from './core/presentation.js';
import { withAttachments } from './core/attachments.js';
import { characterReferences, promptStarts } from '../shared/turn-match.js';
import * as codexDesktop from './codex-desktop.js';
import type { CodexDesktopIpc, CodexInput, DesktopRequest, ThreadSettings } from './codex-desktop.js';
import { DesktopAutomation, throughFullscreen, FULLSCREEN_EVERY_MS, FULLSCREEN_HOLD_MS, type DesktopFlags } from './core/desktop-automation.js';
import { CodexProjects } from './services/codex-projects.js';
import { openLink } from './services/desktop-places.js';
import { UnifiedSession, UnifiedTurn, UnifiedStep, EngineEvents } from './types.js';
import { arr, bag, errorField, get, isBag, list, messageOf, num, parseJson, str, strOrNull, text } from '../shared/guards.js';
import type {
  Approval, Attachment, BridgeConfig, CreateInput, CreateResult, DesktopSettings, EngineEmitter, EngineItem,
  EngineStatus, FileTarget, History, Model, Project, SendInput, TimeValue, Usage, UsageWindow,
} from '../shared/contract.js';

// Reasoning summaries arrive as text or as a list of parts; an empty list means nothing to show.
const reasoningText = (item: unknown): string => text([get(item, 'summary'), get(item, 'content')].map(value => Array.isArray(value) ? value.map((part: unknown) => typeof part === 'string' ? part : get(part, 'text') || '').join('\n') : value || '').find(Boolean) || '');

const STATUS: Readonly<Record<string, string>> = { inProgress: 'running', in_progress: 'running', error: 'failed', declined: 'failed', cancelled: 'interrupted' };
const statusOf = (value: unknown): string => String((typeof value === 'string' && Object.hasOwn(STATUS, value) ? STATUS[value] : undefined) || value || 'completed');
// App-server times are epoch seconds (or milliseconds); answers ms.
const msOf = (value: number): number => value < 1e12 ? value * 1000 : value;
function workedMs(turn: unknown): number {
  const items = [...list(get(turn, 'items'))].reverse();
  const answer = items.find(item => get(item, 'type') === 'agentMessage' && get(item, 'phase') === 'final_answer') || items.find(item => get(item, 'type') === 'agentMessage');
  const startedAt = get(turn, 'startedAt');
  const start = typeof startedAt === 'number' ? msOf(startedAt) : Date.parse(text(startedAt));
  const answeredAt = num(get(answer, 'startedAtMs'));
  return answeredAt && start ? Math.max(0, answeredAt - start) : 0;
}
// App-server times are epoch seconds; the page reads ISO times.
const epoch = (value: unknown): TimeValue | undefined => typeof value === 'number' ? new Date(msOf(value)).toISOString() : timeOf(value);
// A time as the record gives it (ISO text or a number), else nothing.
const timeOf = (value: unknown): TimeValue | undefined => typeof value === 'string' || typeof value === 'number' ? value : undefined;

const EFFORT_NAMES = bag(get(parseJson(fs.readFileSync(path.join(NATIVE, 'profiles/codex.json'), 'utf8')), 'effortNames')) || {};
// "GPT-6.1 Sol Medium", as the desktop's model button shows it → { model, effort } in the console's
// ids. The button writes the name with spaces where the model list may have dashes.
const loose = (value: unknown): string => String(value || '').toLowerCase().replace(/[-\s]+/g, ' ').trim();
function shownSettings(shownText: unknown, models: Model[] = []): DesktopSettings {
  const shown = loose(shownText), out: DesktopSettings = {};
  const model = models.filter(item => shown === loose(item.name) || shown.startsWith(`${loose(item.name)} `)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!model) return out;
  out.model = model.id;
  const rest = shown.slice(loose(model.name).length).trim();
  const effort = Object.keys(EFFORT_NAMES).find(id => loose(EFFORT_NAMES[id]) === rest);
  if (effort) out.effort = effort;
  return out;
}

// What the desktop waits on the person for, as a card in the chat (its id: thread and request):
// the agent's own question (request_user_input), or running a command / changing files.
function askCard(threadId: string, request: unknown): Approval | null {
  const id = `${threadId}:${get(request, 'id')}`, params = get(request, 'params') || {}, method = get(request, 'method');
  if (method === 'item/tool/requestUserInput') {
    return questionCard(id, list(get(params, 'questions')).map(item => ({ question: text(get(item, 'question') || get(item, 'header') || ''), multi: false, options: get(item, 'isSecret') ? [] : list(get(item, 'options')).map(option => ({ id: String(get(option, 'label')), label: text(get(option, 'label')) })) })), 'Codex');
  }
  const command = get(params, 'command');
  if (method === 'item/commandExecution/requestApproval') return { id, title: 'Codex 要运行这条命令', detail: [arr(command)?.join(' ') ?? command, get(params, 'reason')].filter(Boolean).join('\n'), decisions: ['accept', 'decline'] };
  if (method === 'item/fileChange/requestApproval') return { id, title: 'Codex 要修改文件', detail: [get(params, 'reason'), get(params, 'grantRoot')].filter(Boolean).join('\n'), decisions: ['accept', 'decline'] };
  return null;
}

// How often a reply the desktop is writing is passed on: its owner's state changes with every few words.
const REPLY_MS = 150;
// An item from the desktop's record as the events carry it. The record's items are objects with a
// type and an id; anything else is not an item.
// Codex's composer keeps a message in its Markdown and the desktop shows it rendered; the console's
// bubble is plain text, so what rendering takes away goes here too: a line break written as `\` and
// a newline, a backslash before punctuation, character references. Code keeps its text as written.
function composerText(markdown: string): string {
  return markdown.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, index) => index % 2 ? part
    : characterReferences(part.replace(/\\(\n|[!-/:-@[-`{-~])/g, '$1'))).join('');
}
const itemOf = (value: unknown): EngineItem | null => isBag(value) ? { ...value, type: text(value['type']), id: text(value['id']) } : null;

/** The run send() and create() hand out: the console's events, plus where its message is. */
class CodexRun extends EngineEvents {
  /** The message's place in the thread's queue, until the desktop takes it. */
  queuedId: unknown;
}

type Reply = (message: unknown) => void;
interface Ask { threadId: string; request: DesktopRequest }

class CodexBridge extends EventEmitter {
  codexBin: string | null | undefined;
  desktop: CodexDesktopIpc;
  asks: Map<string, Ask>;
  ui: DesktopAutomation;
  starts: Map<string, CodexRun>;
  config: Partial<BridgeConfig>;
  lifecycle: CodexLifecycle;
  projectIndex: CodexProjects;
  starting: Promise<void> | null;
  stopping: boolean;
  proc: ChildProcessWithoutNullStreams | null;
  rl: readline.Interface | null;
  reqId: number;
  pending: Map<number, Reply>;
  followMs: number;
  isReady: boolean;
  accountInfo: unknown;

  constructor(config: Partial<BridgeConfig> = loadConfig()) {
    super();
    this.codexBin = config.codexBin;
    this.desktop = codexDesktop; // the desktop's IPC (steer, stop, what it asks); replaceable in tests
    this.asks = new Map(); // card id → { threadId, request }: what the desktop is waiting on the person for
    this.ui = new DesktopAutomation({ engine: 'codex', label: 'Codex 桌面版' }); // its window, through Accessibility
    this.starts = new Map(); // threadId -> the run create() started, until observed
    this.config = config;
    // Every listed thread's log stays indexed, so a refresh reads only what was appended.
    this.lifecycle = new CodexLifecycle({ maxFiles: 1024 });
    this.projectIndex = new CodexProjects({ codexHome: config.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex') });
    this.starting = null;
    this.stopping = false;
    this.proc = null;
    this.rl = null;
    this.reqId = 1;
    this.pending = new Map();
    this.followMs = 800; // how often a running turn's record is read (shortened in tests)
    this.isReady = false;
    this.accountInfo = null;
  }

  async start(): Promise<void> {
    if (this.isReady) return;
    if (this.starting) return this.starting;
    const bin = this.codexBin;
    if (!bin) throw new Error('未发现 Codex，请设置 CODEX_BIN');
    this.starting = (async () => {
      // A codex.cmd shim (an npm install) goes through cmd.exe, quoted by winSpawnArgs; the desktop's
      // own codex.exe starts directly. No console window either way.
      const [cmd, cmdArgs, cmdOpts] = winSpawnArgs(bin, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      const proc = spawn(cmd, cmdArgs, cmdOpts);
      this.proc = proc;
      proc.on('error', err => this.failPending(err));
      proc.on('exit', code => {
        this.isReady = false; this.proc = null;
        this.failPending(new Error(`Codex app-server exited (${code})`));
      });
      proc.stderr.on('data', () => {});
      proc.stdin.on('error', err => this.failPending(err));
      this.rl = readline.createInterface({ input: proc.stdout });
      this.rl.on('line', line => { try { this.handleMessage(parseJson(line)); } catch {} });
      await this.send('initialize', {
        clientInfo: { name: 'agent-frontdesk', version: '2.0.0' },
        capabilities: { experimentalApi: true }
      });
      proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      this.isReady = true;
    })();
    try { await this.starting; }
    catch (err) { this.proc?.kill(); this.proc = null; throw err; }
    finally { this.starting = null; }
  }

  failPending(err: Error): void {
    Object.assign(err, { transport: true });
    this.isReady = false;
    for (const resolve of this.pending.values()) resolve({ error: { message: err.message } });
    this.pending.clear();
  }

  dispose(): void {
    this.stopping = true;
    for (const emitter of this.starts.values()) emitter.emit('interrupt');
    this.failPending(new Error('Bridge stopped'));
    this.rl?.close(); this.proc?.kill();
  }

  // One JSON-RPC request to the app-server; answers its whole response message.
  send(method: string, params: unknown = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const proc = this.proc;
      if (!proc || proc.killed) {
        return reject(new Error('Codex app-server is not running'));
      }
      const id = this.reqId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(Object.assign(new Error(`Timeout waiting for response to ${method}`), { transport: true }));
        }
      }, 30000);

      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        const error = get(msg, 'error');
        if (error) {
          reject(new Error(text(get(error, 'message')) || JSON.stringify(error)));
        } else {
          resolve(msg);
        }
      });

      proc.stdin.write(JSON.stringify({ method, id, params }) + '\n', err => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }

  handleMessage(msg: unknown): void {
    const id = get(msg, 'id'), method = get(msg, 'method');
    // The app-server asks its client to approve what its own turns do; this one runs none
    // (the desktop app runs every turn and is asked; its requests reach the chat through watchAsks).
    if (id != null && method) {
      this.proc?.stdin.write(JSON.stringify({ id, error: { code: -32601, message: 'Unsupported client request; use the desktop client' } }) + '\n');
      return;
    }
    const resolve = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (id && resolve && typeof id === 'number') {
      this.pending.delete(id);
      resolve(msg);
      return;
    }
    if (method === 'account/updated') this.accountInfo = get(msg, 'params');
  }

  async getStatus(): Promise<EngineStatus> {
    let error;
    try { await this.start(); } catch (err) { error = messageOf(err); }
    const park = this.ui.parkTrouble?.();
    return {
      connected: this.isReady, error,
      account: this.accountInfo,
      engine: 'codex',
      ...(this.ui.staleControls?.().length ? { stale: this.ui.staleControls() } : {}),
      ...(park ? { park: { command: park.command, issues: park.issues, at: park.at } } : {}),
    };
  }

  async getUsage(): Promise<Usage> {
    await this.start();
    const response = await this.send('account/rateLimits/read');
    const limit = get(response, 'result', 'rateLimits');
    const windows = ['primary', 'secondary'].flatMap((key): UsageWindow[] => {
      const window = get(limit, key), usedPercent = get(window, 'usedPercent');
      if (typeof usedPercent !== 'number') return [];
      return [{ id: key, usedPercent: Math.max(0, Math.min(100, usedPercent)),
        remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
        windowMinutes: num(get(window, 'windowDurationMins')), resetsAt: num(get(window, 'resetsAt')) || null }];
    });
    return { available: !!windows.length, windows, plan: str(get(limit, 'planType')) || null,
      reason: windows.length ? undefined : '引擎没有返回额度窗口' };
  }

  // Every page of a list method (the app-server returns 25 rows at a time by default).
  async listAll(method: string, params: Record<string, unknown> = {}, { pages = 40 }: { pages?: number } = {}): Promise<unknown[]> {
    const rows: unknown[] = []; let cursor: unknown = null;
    for (let page = 0; page < pages; page++) {
      const res = await this.send(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
      rows.push(...list(get(res, 'result', 'data')));
      cursor = get(res, 'result', 'nextCursor');
      if (!cursor) break;
    }
    return rows;
  }

  // Projects as the desktop sidebar lists them. An older app-server without project/list
  // has none: every thread is then a plain chat.
  async projectTree(): Promise<ReturnType<CodexProjects['index']>> {
    let rows: unknown[] = [];
    try { rows = await this.listAll('project/list'); } catch (err) { if (errorField(err, 'transport')) throw err; }
    return this.projectIndex.index(rows);
  }

  async listProjects(): Promise<Project[]> {
    await this.start();
    return (await this.projectTree()).projects.map(project => ({ id: project.id, name: project.name, cwd: project.roots[0] || '' }));
  }

  async listThreads(): Promise<UnifiedSession[]> {
    await this.start();
    const [rows, tree] = await Promise.all([this.listAll('thread/list'), this.projectTree()]);
    const threads = [...new Map(rows.map(thread => [get(thread, 'id'), thread])).values()];
    return Promise.all(threads.map(async t => {
      const log = await this.lifecycle.read(str(get(t, 'path')));
      const shownStatus = get(t, 'status', 'type') || get(t, 'status');
      const nativeRunning = typeof shownStatus === 'string' && ['busy', 'active', 'running'].includes(shownStatus);
      const cwd = text(log.cwd || get(t, 'cwd'));
      const id = text(get(t, 'id'));
      const project = tree.resolve({ id, projectId: get(t, 'projectId'), cwd });
      return new UnifiedSession({
        id, engine: 'codex', title: this.titleOf(t),
        updatedAt: timeOf(get(t, 'updatedAt') || get(t, 'createdAt')), cwd,
        status: nativeRunning || log.latest?.status === 'running' ? 'busy' : log.latest ? 'idle' : 'unknown',
        isDesktopActive: true,
        metadata: { model: strOrNull(get(t, 'model')), modelProvider: get(t, 'modelProvider'), historyMode: get(t, 'historyMode'),
          // What the next turn runs with, as the desktop shows it: the console's menus start on it.
          desktop: { model: text(get(t, 'model')), effort: text(get(t, 'reasoningEffort')) },
          // The thread's project in the desktop sidebar; null = a chat outside every project.
          group: project ? { id: project.id, name: project.name, cwd: project.roots[0] || '' } : null,
          parentId: text(get(t, 'parentThreadId')),
          latestTurn: log.latest, recentMessages: log.messages, turnStartedAt: log.latest?.startedAt || 0 },
      });
    }));
  }

  async getThread(threadId: string): Promise<History> {
    await this.start();
    let res: unknown;
    try {
      res = await this.send('thread/read', { threadId, includeTurns: true });
    } catch (err) {
      if (messageOf(err).includes('list_turns is not supported yet')) {
        res = await this.send('thread/read', { threadId, includeTurns: false });
      } else {
        throw err;
      }
    }
    const rawThread = get(res, 'result', 'thread') || {};
    const turns = list(get(rawThread, 'turns'));
    const lifecycle = await this.lifecycle.read(str(get(rawThread, 'path')));

    const unifiedTurns = turns.map(rawTurn => {
      const items = list(get(rawTurn, 'items'));
      let userPrompt = '', sawPrompt = false;
      let assistantReply = '';
      const steps: UnifiedStep[] = [];
      const messages: Array<{ id: string; phase: string; text: string }> = [];
      const field = (item: unknown, key: string): unknown => get(item, key);

      for (const item of items) {
        const type = field(item, 'type'), id = text(field(item, 'id'));
        if (type === 'userMessage') {
          const said = composerText(list(field(item, 'content')).map(c => text(get(c, 'text'))).join('\n'));
          // The first is the turn's prompt; later ones were sent into the running turn (steer).
          if (!sawPrompt) { userPrompt = said; sawPrompt = true; }
          else steps.push(new UnifiedStep({ id, type: 'user_message', title: said, status: 'completed' }));
        } else if (type === 'agentMessage') {
          const content = field(item, 'content');
          const said = text(field(item, 'text') || (content ? list(content).map(c => text(get(c, 'text'))).join('') : ''));
          if (said) {
            messages.push({ id, phase: text(field(item, 'phase') || 'assistant'), text: said });
            assistantReply += (assistantReply ? '\n' : '') + said;
          }
        } else if (type === 'commandExecution') {
          steps.push(new UnifiedStep({
            id,
            type: 'command',
            title: `Terminal: ${field(item, 'command') || 'Shell Command'}`,
            detail: text(field(item, 'command')),
            output: text(field(item, 'aggregatedOutput') || field(item, 'output') || field(item, 'stdout') || ''),
            status: text(field(item, 'status') || 'completed'),
            durationMs: num(field(item, 'durationMs')) || 0
          }));
        } else if (type === 'fileChange') {
          const changes = list(field(item, 'changes'));
          const fileList = changes.map(c => get(c, 'path')).filter(Boolean).map(String);
          steps.push(new UnifiedStep({
            id,
            type: 'file_change',
            title: `Edited · ${fileList.join(', ') || 'Files'}`,
            detail: fileList.join('\n'),
            paths: fileList,
            changes: changesOf(changes),
            status: statusOf(field(item, 'status'))
          }));
        } else if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
          const result = get(item, 'result', 'content') || field(item, 'contentItems') || [];
          const args = bag(field(item, 'arguments'));
          const name = `${field(item, 'server') || field(item, 'namespace') || 'tool'}.${field(item, 'tool') || ''}`;
          steps.push(new UnifiedStep({
            id,
            type: 'tool_call',
            name,
            title: `Called · ${name}`,
            detail: args && Object.keys(args).length ? JSON.stringify(args, null, 2) : '',
            output: list(result).map(c => text(get(c, 'text'))).join('\n'),
            status: field(item, 'success') === false ? 'failed' : statusOf(field(item, 'status')),
            durationMs: num(field(item, 'durationMs')) || 0
          }));
        } else if (type === 'imageView') {
          const viewed = field(item, 'path');
          steps.push(new UnifiedStep({ id, type: 'image_view', title: `Viewed · ${viewed || 'image'}`, detail: text(viewed), paths: viewed ? [String(viewed)] : null, status: 'completed' }));
        } else if (type === 'contextCompaction') {
          const done = field(item, 'completedAtMs');
          steps.push(new UnifiedStep({ id, type: 'notice', title: done ? 'Context automatically compacted' : 'Compacting context', status: done ? 'completed' : 'running' }));
        } else if (type === 'reasoning') {
          const thought = reasoningText(item);
          if (thought) {
            steps.push(new UnifiedStep({
              id,
              type: 'reasoning',
              title: 'Model Reasoning',
              detail: thought,
              status: 'completed'
            }));
          }
        } else if (type === 'webSearch') {
          steps.push(new UnifiedStep({
            id,
            type: 'web_search',
            title: `Web Search: ${field(item, 'query') || ''}`,
            detail: text(field(item, 'query')),
            output: JSON.stringify(field(item, 'results') || [], null, 2),
            status: 'completed'
          }));
        }
      }

      const firstPrompt = items.findIndex(other => get(other, 'type') === 'userMessage');
      const turnId = text(get(rawTurn, 'id'));
      return new UnifiedTurn({
        id: turnId,
        userPrompt,
        timestamp: epoch(get(rawTurn, 'startedAt')),
        durationMs: num(get(rawTurn, 'durationMs')) || 0,
        // The desktop's "Worked for": from the turn's start to the start of its final answer.
        workedMs: workedMs(rawTurn),
        ...resolveCodexTurn(bag(rawTurn) || {}, lifecycle.turns.get(turnId)),
        steps,
        assistantReply,
        artifacts: [], messages, timeline: items.filter((item, index) => !(get(item, 'type') === 'userMessage' && index === firstPrompt) && get(item, 'type') !== 'sleep' && !(get(item, 'type') === 'reasoning' && !reasoningText(item))).map(item => ({ kind: get(item, 'type') === 'agentMessage' ? 'message' : 'activity', id: text(get(item, 'id')) }))
      });
    });

    return {
      session: new UnifiedSession({
        id: text(get(rawThread, 'id')),
        engine: 'codex',
        title: text(get(rawThread, 'name') || get(rawThread, 'title') || get(rawThread, 'preview') || 'Codex Chat'),
        updatedAt: timeOf(get(rawThread, 'updatedAt')),
        cwd: text(get(rawThread, 'cwd')),
        status: unifiedTurns.at(-1)?.status === 'running' || lifecycle.latest?.status === 'running' ? 'busy' : lifecycle.latest ? 'idle' : 'unknown',
        isDesktopActive: true,
        metadata: {
          model: strOrNull(get(rawThread, 'model')),
          reasoningEffort: get(rawThread, 'reasoningEffort'),
          desktop: { model: text(get(rawThread, 'model')), effort: text(get(rawThread, 'reasoningEffort')) },
          modelProvider: get(rawThread, 'modelProvider'), latestTurn: lifecycle.latest
        }
      }),
      turns: unifiedTurns
    };
  }

  async getModels(): Promise<Model[]> {
    await this.start();
    try {
      const res = await this.send('model/list', {});
      return list(get(res, 'result', 'data')).map(m => ({
        id: text(get(m, 'id') || get(m, 'model')),
        name: text(get(m, 'displayName') || get(m, 'id')),
        description: text(get(m, 'description')),
        isDefault: !!get(m, 'isDefault'),
        reasoningEfforts: list(get(m, 'supportedReasoningEfforts')).map(r => text(get(r, 'reasoningEffort'))),
        defaultReasoningEffort: text(get(m, 'defaultReasoningEffort') || 'low')
      }));
    } catch (err) {
      console.error('[Codex Bridge] Error fetching models:', err);
      return this.config.catalogs?.['codex'] || [];
    }
  }

  buildCodexInputs(prompt: string | undefined, attachments: readonly Attachment[] | undefined): CodexInput[] {
    const inputs: CodexInput[] = [];
    let extraText = '';

    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        const isImage = att.mimetype?.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(att.originalname || att.filename || '');
        if (isImage && att.path) {
          inputs.push({
            type: 'localImage',
            path: att.path,
            detail: null
          });
        } else if (att.path) {
          inputs.push({
            type: 'mention',
            name: att.originalname || path.basename(att.path),
            path: att.path
          });
          extraText += `\n[Attached File: ${att.originalname || path.basename(att.path)} (${att.path})]`;
        }
      }
    }

    const fullText = extraText ? `${prompt}\n${extraText}` : prompt;
    inputs.unshift({
      type: 'text',
      text: fullText,
      text_elements: []
    });

    return inputs;
  }

  // ---- every turn runs in the Codex desktop app ----
  // Codex lets one process write a thread at a time (~/.codex/thread-writer-locks): whichever
  // app-server has the thread loaded. The console's own app-server only reads and queues, so it
  // never holds that lock; the desktop's own app-server runs every turn:
  //  - a new chat is started on the desktop's New chat page (Accessibility, src/server/native/codex-desktop.swift);
  //  - a message to a chat is put in the thread's official queue (thread/queue/add) and the desktop
  //    is asked to take it (codex://threads/wake/<id>, opened in the background: the desktop's
  //    app-server resumes the thread and runs what is queued, without showing its window);
  //  - a message for the running turn goes to the desktop window that owns it (thread-follower IPC).
  // The desktop's model and effort follow the chat; a different pick in the console is made in the
  // desktop first (pickInDesktop), and when it cannot be made nothing is sent.

  // The chat's name as the desktop's sidebar shows it.
  titleOf(thread: unknown): string { return String(get(thread, 'name') || get(thread, 'title') || text(get(thread, 'preview')).trim().split('\n')[0]?.slice(0, 120) || 'Codex Chat'); }
  // What the desktop's menus call the console's picks: a model's display name, an effort as is
  // (src/server/native/profiles/codex.json maps efforts to the desktop's level names).
  async desktopSettings({ model, reasoningEffort }: { model?: string; reasoningEffort?: string } = {}, current: { model?: unknown; reasoningEffort?: unknown } = {}): Promise<DesktopFlags> {
    const wanted: DesktopFlags = {};
    if (model && model !== current.model) {
      const known = (await this.getModels().catch((): Model[] => [])).find(item => item.id === model);
      if (!known) throw Object.assign(new Error('没能确定这个模型在 Codex 桌面版里叫什么，没有发送'), { status: 409 });
      wanted.model = known.name;
    }
    if (reasoningEffort && reasoningEffort !== current.reasoningEffort) wanted.effort = reasoningEffort;
    return wanted;
  }
  // What the desktop's New chat page will start a chat with: its model button ("GPT-6.1 Sol Medium"),
  // in the console's ids. Read from the page, since the desktop remembers what was last picked
  // there; a name it does not know is left out rather than guessed.
  async newSettings(): Promise<{ settings: DesktopSettings }> {
    const state = await this.ui.check();
    if (!state.available) throw Object.assign(new Error(state.reason), { status: 409 });
    // Left on that page while the console shows a new chat, and taken back afterwards (newPage).
    const result = await this.ui.newPage(['new-shown']);
    if (!result.ok) throw Object.assign(new Error(result.error || '没能读到 Codex 桌面版新建页的模型'), { status: 409 });
    return { settings: shownSettings(get(result, 'shown', 'model'), await this.getModels().catch((): Model[] => [])) };
  }
  // A file from the chat, opened in the desktop: the chat is shown there and its link pressed.
  async openFile(threadId: string, file: FileTarget): Promise<unknown> {
    const state = await this.ui.check();
    if (!state.available) throw Object.assign(new Error(state.reason), { status: 409 });
    const result = await this.ui.openFile({ title: this.titleOf(await this.readThread(threadId)), ...file });
    if (!result.ok) throw Object.assign(new Error(result.error || '没能在 Codex 桌面版里打开这个文件'), { status: 409 });
    return result;
  }
  // Takes the person to this thread in the desktop app.
  async show(threadId: string): Promise<unknown> {
    const state = await this.ui.check();
    if (!state.available) throw Object.assign(new Error(state.reason), { status: 409 });
    const result = await this.ui.showSession({ title: this.titleOf(await this.readThread(threadId)) });
    if (!result.ok) throw Object.assign(new Error(result.error || '没能在 Codex 桌面版里打开这个会话'), { status: 409 });
    return result;
  }
  async readThread(threadId: string, includeTurns = false): Promise<unknown> {
    await this.start();
    return get(await this.send('thread/read', { threadId, includeTurns }), 'result', 'thread') || {};
  }

  async create(input: CreateInput = {}): Promise<CreateResult> {
    function refuse(reason: string | undefined): never { throw Object.assign(new Error(reason), { status: 409 }); }
    if (!input.prompt && !(input.attachments || []).length) throw Object.assign(new Error('请输入首条消息'), { status: 400 });
    const state = await this.ui.check();
    if (!state.available) refuse(state.reason);
    await this.start();
    // The project is picked by its name in the desktop's project menu; no cwd = outside every project.
    let project = ':none';
    if (input.cwd) {
      const normCwd = (p: string) => {
        const resolved = path.resolve(p);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      };
      const cwd = normCwd(input.cwd);
      const match = (await this.listProjects()).find(item => item.cwd && normCwd(item.cwd) === cwd);
      if (!match) refuse('这个文件夹不是 Codex 桌面版里的项目，请在桌面版里先把它加为项目');
      project = match.name;
    }
    let wanted: DesktopFlags;
    try { wanted = await this.desktopSettings(input); } catch (err) { refuse(messageOf(err)); }
    // The desktop's composer takes text; attachments go in as their paths.
    const message = withAttachments(input.prompt, input.attachments);
    const known = new Set(list(get(await this.send('thread/list', { limit: 50 }), 'result', 'data')).map(thread => get(thread, 'id')));
    // With a full-screen program in front, the request waits a while for it to go (throughFullscreen).
    const result = await throughFullscreen(() => this.ui.run(['new', project], { input: message, settings: wanted }), this.held());
    if (!result.ok) refuse(result.error || '没能在 Codex 桌面版里新建聊天');
    const thread = await this.newDesktopThread(known, message);
    if (!thread) throw Object.assign(new Error('消息已在 Codex 桌面版里发出，但还没在它的聊天列表里看到这个新聊天，请到桌面版里查看'), { status: 504 });
    const id = text(get(thread, 'id'));
    const emitter = new CodexRun();
    this.starts.set(id, emitter);
    this.follow(id, { prompt: message, known: new Set(), emitter });
    return { id, cwd: text(get(thread, 'cwd') || input.cwd || ''), started: true };
  }
  // The chat the desktop just made: a thread that was not listed before, opened with this message.
  async newDesktopThread(known: ReadonlySet<unknown>, message: string, timeoutMs = 25000): Promise<unknown> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const rows = list(get(await this.send('thread/list', { limit: 50 }).catch(() => null), 'result', 'data'));
      const fresh = rows.filter(thread => !known.has(get(thread, 'id')) && !get(thread, 'parentThreadId'));
      const hit = fresh.find(thread => promptStarts(text(get(thread, 'preview')), message, 60)) || (fresh.length === 1 ? fresh[0] : null);
      if (hit) return hit;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return null;
  }
  // The run create() started, handed over once to whoever follows it.
  observe(id: string): EngineEmitter {
    const emitter = this.starts.get(id);
    if (!emitter) throw Object.assign(new Error('没有正在执行的任务'), { status: 409 });
    this.starts.delete(id);
    return emitter;
  }

  startTurn({ threadId, prompt, model, reasoningEffort, attachments }: Partial<SendInput> & { threadId: string; prompt: string }): CodexRun {
    const emitter = new CodexRun();
    (async () => {
      const thread = await this.readThread(threadId, true);
      const known = new Set(list(get(thread, 'turns')).map(turn => get(turn, 'id')));
      // A different model or effort is picked in the desktop first.
      await this.pickInDesktop(thread, { model, reasoningEffort }, () => emitter.emit('warning', { message: '前台的程序独占全屏，消息先留在工作台，你离开它后自动发出', retrying: true }));
      const inputs = this.buildCodexInputs(prompt, attachments);
      // After a stopped turn the desktop holds its queue: every queued message shows as paused
      // until the person sends one, so a queued message would wait there (measured on Windows; the
      // desktop's own code, so the Mac's too). The window that owns the chat starts the turn
      // instead, as its composer does when no turn runs. With no window on the chat it is queued.
      const paused = get(list(get(thread, 'turns')).at(-1), 'status') === 'interrupted';
      if (paused && this.desktop.startTurn) {
        try {
          await this.desktop.startTurn({ threadId, inputs });
          this.follow(threadId, { prompt, known, emitter });
          return;
        } catch (err) {
          if (errorField(err, 'code') === 'timeout') throw Object.assign(new Error('Codex 桌面版没有确认开始这一轮，请在桌面版里看一下这条消息有没有发出'), { terminal: true });
          if (!codexDesktop.unreached(err)) throw Object.assign(new Error(`没能让 Codex 桌面版开始这一轮（${messageOf(err)}），没有发送`), { terminal: true });
        }
      }
      const queued = await this.send('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input: inputs });
      emitter.queuedId = get(queued, 'result', 'queuedSubmission', 'id');
      await this.wake(threadId);
      this.follow(threadId, { prompt, known, emitter, paused });
    })().catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      emitter.emit('error', Object.assign(error, { terminal: Boolean(errorField(error, 'terminal') ?? !errorField(error, 'transport')) }));
    });
    return emitter;
  }
  // A different model or effort for the chat's next turn is set in the desktop itself, so the
  // desktop shows and keeps it; when it cannot be, this throws why and nothing is sent.
  //  1. The window that owns the chat sets it as its own model menu does, asked over the desktop's
  //     IPC (codex-desktop.ts): no window is touched, and it takes a tenth of a second.
  //  2. No window owns it (the desktop has not loaded it since it started): the chat is opened in
  //     the desktop's sidebar in the background and the window goes back to where it was
  //     (Accessibility, about 1.5 s). The chat is then owned, by its id, and set as in 1. A chat the
  //     sidebar does not show cannot be opened this way, nor picked in the menu: not sent.
  //  3. Neither works (the IPC has changed, or the sidebar opened another chat of the same name):
  //     the desktop's model menu and Power slider pick it (5-7 s), unless another chat has the same
  //     name, since the menu finds the chat by its name.
  // `held`: told when the desktop's window cannot be worked yet (a full-screen program in front), and the change waits for it.
  async pickInDesktop(thread: unknown, { model, reasoningEffort }: { model?: string | undefined; reasoningEffort?: string | undefined }, held?: () => void): Promise<void> {
    const refuse = (message: string): never => { throw Object.assign(new Error(message), { terminal: true }); };
    const threadId = text(get(thread, 'id'));
    const current = { model: text(get(thread, 'model')), effort: text(get(thread, 'reasoningEffort')) };
    const to = { model: model || current.model, effort: reasoningEffort || current.effort || null };
    if (to.model === current.model && to.effort === (current.effort || null)) return;
    const known = (await this.getModels().catch((): Model[] => [])).find(item => item.id === to.model);
    if (to.model !== current.model && !known) refuse('没能确定这个模型在 Codex 桌面版里叫什么，没有发送');
    if (to.effort && known?.reasoningEfforts?.length && !known.reasoningEfforts.includes(to.effort)) refuse(`Codex 桌面版里 ${known.name} 没有「${to.effort}」这一档推理强度，没有发送`);
    const title = this.titleOf(thread);
    const ipc = this.desktop;
    if (ipc.owns && ipc.readSettings && ipc.updateSettings) {
      let owned = await ipc.owns(threadId);
      if (!owned && (await this.ui.check()).available) {
        const opened = await throughFullscreen(() => this.ui.run(['settings', title]), this.held(held));
        // The menu finds the chat in the sidebar the same way: not there, so no use trying it.
        if (!opened.ok) refuse(`${opened.error || '没能在 Codex 桌面版里打开这个聊天'}，没有发送`);
        owned = await ipc.owns(threadId, { waitMs: 2000 });
      }
      if (owned) {
        let from: ThreadSettings | null = null;
        try { from = await ipc.readSettings(threadId); } catch { /* the menu below */ }
        if (from && from.model === to.model && from.effort === to.effort) return;
        if (from) {
          let applied: boolean | null = null;
          try { applied = await ipc.updateSettings({ threadId, to, from }); } catch { /* the menu below */ }
          // Not applied: the chat's settings changed in the desktop since they were read.
          if (applied === false) refuse('Codex 桌面版里这个聊天的模型刚被改过，没有发送，请再发一次');
          const now = applied ? await ipc.readSettings(threadId).catch(() => null) : null;
          if (now && now.model === to.model && now.effort === to.effort) return;
        }
      }
    }
    // The menu finds the chat by its name in the sidebar; with two chats of that name it could set another's.
    if (await this.sharesName(threadId, title)) refuse(`Codex 桌面版里有不止一个叫「${title}」的聊天，没法确定要换的是哪一个，没有发送；请先在桌面版里打开这个聊天`);
    const wanted = await this.desktopSettings({ model, reasoningEffort }, { model: current.model, reasoningEffort: current.effort });
    const state = await this.ui.check();
    if (!state.available) refuse(`要换模型或推理强度得在 Codex 桌面版里换，但${state.reason}，没有发送`);
    const result = await throughFullscreen(() => this.ui.run(['settings', title], { settings: wanted }), this.held(held));
    if (!result.ok) refuse(`${result.error || '没能在 Codex 桌面版里换模型'}，没有发送`);
  }
  // How a command through the window waits out a full-screen program in front (throughFullscreen).
  fullscreenRetryMs = FULLSCREEN_EVERY_MS;
  fullscreenHoldMs = FULLSCREEN_HOLD_MS;
  held(held?: () => void): { everyMs: number; maxMs: number; held?: () => void } { return { everyMs: this.fullscreenRetryMs, maxMs: this.fullscreenHoldMs, ...(held ? { held } : {}) }; }
  // Whether another recent chat has this name in the desktop's sidebar.
  async sharesName(threadId: string, title: string): Promise<boolean> {
    const rows = list(get(await this.send('thread/list', { limit: 100 }).catch(() => null), 'result', 'data'));
    return rows.some(row => get(row, 'id') !== threadId && !get(row, 'parentThreadId') && this.titleOf(row) === title);
  }
  // Asks the desktop to run what the thread has queued. `open -g` keeps it in the background;
  // a desktop that is not running starts just to do this.
  wake(threadId: string): Promise<void> {
    return openLink(`codex://threads/wake/${threadId}`).catch((err: unknown) => { throw Object.assign(new Error('没能唤起 Codex 桌面版来处理这条消息'), { cause: err }); });
  }
  // Follows the desktop's record of the thread: the first turn not in `known` that carries this
  // message, item by item, until the record says how it ended. The record has a reply only once it
  // is whole; while it is being written, its text so far is taken from the window that owns the
  // thread (see codex-desktop.ts watch), as that window draws it.
  // `paused`: queued after a stopped turn, where the desktop may hold it (startTurn).
  follow(threadId: string, { prompt, known, emitter, paused = false }: { prompt: string; known: ReadonlySet<unknown>; emitter: CodexRun; paused?: boolean }): void {
    const seen = new Map<string, string>(), started = Date.now();
    let polling = false, warned = false;
    const writing = this.followReplies(emitter, id => seen.has(id));
    const asks = this.watchAsks(threadId, emitter, writing.update);
    const stop = () => { clearInterval(timer); asks.close(); writing.close(); };
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const thread = await this.readThread(threadId, true);
        const turn = list(get(thread, 'turns')).find(candidate => !known.has(get(candidate, 'id')) && list(get(candidate, 'items')).some(item => {
          if (get(item, 'type') !== 'userMessage') return false;
          // The desktop writes the message down in its composer's Markdown (shared/turn-match.ts).
          return promptStarts(list(get(item, 'content')).map(part => text(get(part, 'text'))).join('\n'), prompt, 200);
        }));
        if (!turn) {
          if (!warned && Date.now() - started > 20000) {
            warned = true;
            emitter.emit('warning', { message: paused ? '消息已排进 Codex 桌面版的队列，但上一轮是被停止的，桌面版会先暂停它：在桌面版里打开这个会话把它发出去，或在这里停止撤回' : '消息已排进 Codex 桌面版的队列，正在等桌面版接手', retrying: true });
          }
          return;
        }
        const turnId = text(get(turn, 'id'));
        emitter.turnId = turnId; emitter.queuedId = null;
        for (const raw of list(get(turn, 'items'))) {
          const item = itemOf(raw);
          if (!item) continue;
          const serialized = JSON.stringify(raw);
          if (seen.get(item.id) !== serialized) { emitter.emit(item.status === 'inProgress' ? 'item_started' : 'item_completed', { item }); seen.set(item.id, serialized); }
        }
        const log = await this.lifecycle.read(str(get(thread, 'path')));
        const resolved = resolveCodexTurn(bag(turn) || {}, log.turns.get(turnId));
        if (['completed', 'failed', 'interrupted'].includes(resolved.status)) { stop(); emitter.emit('completed', { turn: { ...bag(turn), ...resolved } }); }
      } catch (err) { emitter.emit('warning', { message: messageOf(err), retrying: true }); }
      finally { polling = false; }
    }, this.followMs);
    timer.unref?.();
    emitter.once('interrupt', stop);
  }

  // The replies of the followed turn as the owning window has them so far (`update` takes its turns;
  // the turn is the run's, once the record named it). A reply goes out as the desktop writes it, at
  // most every REPLY_MS, until the record holds it (`recorded`): from then on the record's is shown.
  followReplies(emitter: CodexRun, recorded: (id: string) => boolean): { update(turns: unknown[]): void; close(): void } {
    const shown = new Map<string, string>();
    let latest: unknown[] = [], timer: ReturnType<typeof setTimeout> | null = null, closed = false;
    const flush = () => {
      timer = null;
      const turn = emitter.turnId ? latest.find(candidate => (get(candidate, 'turnId') || get(candidate, 'id')) === emitter.turnId) : null;
      for (const raw of list(get(turn, 'items'))) {
        const id = text(get(raw, 'id')), said = text(get(raw, 'text'));
        if (get(raw, 'type') !== 'agentMessage' || !id || !said || recorded(id) || shown.get(id) === said) continue;
        shown.set(id, said);
        // Unfinished until the record has it: the end of a reply is the record's to say.
        emitter.emit('item_started', { item: { type: 'agentMessage', id, text: said, phase: str(get(raw, 'phase')) } });
      }
    };
    return {
      update(turns) { if (closed) return; latest = turns; timer ||= setTimeout(flush, REPLY_MS); },
      close() { closed = true; if (timer) clearTimeout(timer); timer = null; },
    };
  }
  // The desktop's requests to the person while this turn runs, as cards; one answered (here or in
  // the desktop) leaves the desktop's state, and its card goes. `onTurns` is given the owner's turns.
  watchAsks(threadId: string, emitter: EngineEmitter, onTurns?: (turns: unknown[]) => void): { close(): void } {
    const open = new Set<string>();
    const watcher = this.desktop.watch?.(threadId, ({ requests, turns }) => {
      onTurns?.(turns);
      const now = new Set<string>();
      for (const request of requests) {
        const card = askCard(threadId, request);
        if (!card) continue;
        now.add(card.id);
        if (!open.has(card.id)) { open.add(card.id); this.asks.set(card.id, { threadId, request }); emitter.emit('approval', card); }
      }
      for (const id of open) if (!now.has(id)) { open.delete(id); this.asks.delete(id); emitter.emit('approval_resolved', { id }); }
    });
    return { close: () => { watcher?.close(); for (const id of open) this.asks.delete(id); } };
  }
  // Answered through the window that owns the thread, as its own card would be. Skipping a
  // question answers it with nothing, as the desktop does when a turn is stopped.
  async decide(id: string, decision: string): Promise<void> {
    const ask = this.asks.get(id);
    if (!ask) throw Object.assign(new Error('这个问题已经回答过了'), { status: 409 });
    const { threadId, request } = ask;
    try {
      if (request.method === 'item/tool/requestUserInput') {
        const question = list(get(request.params, 'questions'))[0], option = decision === 'decline' ? null : String(decision).replace(/^option:/, '');
        await this.desktop.answerUserInput({ threadId, requestId: request.id, response: { answers: option && question ? { [String(get(question, 'id'))]: { answers: [option] } } : {} } });
      } else {
        await this.desktop.decideApproval({ threadId, requestId: request.id, kind: request.method === 'item/fileChange/requestApproval' ? 'fileChange' : 'commandExecution', decision: decision === 'accept' ? 'accept' : 'decline' });
      }
    } catch (err) { throw Object.assign(new Error(`没能在 Codex 桌面版里回答（${messageOf(err)}），请到桌面版里操作`), { status: 409 }); }
    this.asks.delete(id);
  }

  // A message for the running turn goes to the desktop window that owns the thread, as its own
  // composer does mid-turn. When no window owns it, the message waits for the turn to end.
  async steerTurn(threadId: string, { prompt = '', attachments }: Partial<SendInput> = {}): Promise<{ via: string }> {
    const inputs = this.buildCodexInputs(prompt, attachments);
    try {
      const said = inputs.filter(item => item.type === 'text'), rest = inputs.filter(item => item.type !== 'text');
      await this.desktop.steer({ threadId, prompt, inputs: [...said, ...rest] });
      return { via: 'desktop' };
    } catch (err) {
      if (errorField(err, 'code') === 'timeout') throw Object.assign(new Error('Codex 桌面版没有确认收到这条消息，请在桌面版看一下是否已插入'), { status: 504 });
      throw Object.assign(new Error(`这一轮没法插进去（${messageOf(err)}），消息已排队`), { fallback: 'queue', cause: err });
    }
  }

  // Stops the turn in the desktop (its own Stop); a message still waiting in the queue is taken
  // back instead. The record then says how the turn ended.
  async interruptTurn(threadId: string, emitter?: EngineEmitter | null): Promise<{ pending?: boolean }> {
    const queuedId = get(emitter, 'queuedId');
    if (queuedId && !emitter?.turnId) {
      await this.send('thread/queue/delete', { threadId, queuedSubmissionId: queuedId });
      emitter?.emit('interrupt');
      return {};
    }
    if (!emitter?.turnId) throw new Error('桌面版还没开始这一轮，请稍后重试或在桌面端停止');
    try { await this.desktop.interrupt({ threadId, turnId: emitter.turnId }); }
    catch (err) { throw Object.assign(new Error(`没能让 Codex 桌面版停下（${messageOf(err)}），请在桌面端停止`), { status: 409 }); }
    return { pending: true };
  }
}

export { CodexBridge, CodexRun, shownSettings, askCard, composerText };
