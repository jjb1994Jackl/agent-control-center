import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { grokDesktop } from '../services/grok-desktop.js';
import { EngineEvents, UnifiedSession, UnifiedTurn } from '../types.js';
import type { History, UnifiedMessage, PluginAbout, PluginSetup } from '../../shared/contract.js';
import { get, list } from '../../shared/guards.js';
import { promptKey } from '../../shared/turn-match.js';

const bundle = '/Applications/Grok Bot.app';
const identity = { id: 'grok', label: 'Grok Bot', description: 'Grok Bot desktop', priority: 40, accent: '#777F8C' } as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 28);
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
const chooseChat = '请先选择一个已有聊天';
const ambiguous = 'Grok 有多个同名会话，在原应用改名后再试';
const offline = 'Grok 当前离线，显示最近读取的消息';

export const about: PluginAbout = {
  ...identity,
  appIcon: () => path.join(bundle, 'Contents/Resources/icon.icns'),
  desktopBundle: () => bundle,
  detect: () => ({ installed: process.platform === 'darwin' && fs.existsSync(bundle), where: bundle }),
};

export function grokTurns(raw: unknown): UnifiedTurn[] {
  const turns: UnifiedTurn[] = [];
  const occurrence = new Map<string, number>();
  const rows = list(raw).slice(-85);
  const anchor = (row: unknown) => {
    const body = get(row, 'text');
    return get(row, 'user') === true && typeof body === 'string' && promptKey(body) ? 'grok-msg-' + hash(promptKey(body)) : '';
  };
  const candidates = new Map<string, number>();
  for (const row of rows) {
    const id = anchor(row);
    if (id) candidates.set(id, (candidates.get(id) || 0) + 1);
  }
  const keyOf = (author: string, text: string) => {
    const base = hash(author + '\0' + text), count = (occurrence.get(base) ?? 0) + 1;
    occurrence.set(base, count);
    return base + '-' + count;
  };
  for (const row of rows) {
    const author = get(row, 'author'), body = get(row, 'text');
    if (typeof author !== 'string' || typeof body !== 'string' || !body.trim()) continue;
    const key = keyOf(author, body);
    if (get(row, 'user') === true) {
      const observed = anchor(row);
      // The desktop can replace a provisional clock label or clip earlier rows. Only exact,
      // unique self-message text can be used here; repeated messages remain display-only.
      turns.push(new UnifiedTurn({ id: candidates.get(observed) === 1 ? observed : key, userPrompt: body, status: 'unknown', timestamp: '' }));
    } else {
      let last = turns.at(-1);
      if (!last) { last = new UnifiedTurn({ id: 'before-' + key, status: 'unknown', timestamp: '' }); turns.push(last); }
      const name = author.replace(/[\r\n*_<>&]/g, '').trim();
      const message: UnifiedMessage = { id: key, text: (name ? `**${name}**\n\n` : '') + body, phase: 'final_answer', status: 'completed' };
      last.messages.push(message);
      last.timeline.push({ kind: 'message', id: key });
    }
  }
  return turns;
}

export const setup: PluginSetup = ({ registerEngine }) => {
  let catalog = new Map<string, { title: string; duplicate: boolean; pin?: number }>();
  const snapshots = new Map<string, History>();
  const sessionOf = (id: string, title: string, sendBlocked = '', running = false) =>
    new UnifiedSession({ id, engine: 'grok', title, updatedAt: 0, sendBlocked, status: running ? 'busy' : 'idle', isDesktopActive: running, metadata: { group: null, nativePin: catalog.get(id)?.pin } });
  async function refreshCatalog() {
    const result = await grokDesktop.native(['list-chats']);
    if (!result.ok) throw fail(result.error || '暂时无法读取 Grok 会话');
    const counts = new Map<string, number>();
    for (const title of list(result['chats'])) if (typeof title === 'string' && title && title.length <= 500)
      counts.set(title, (counts.get(title) || 0) + 1);
    const pins = new Map(list(result['pinned']).map((title,index) => [title,index]));
    catalog = new Map([...counts].map(([title, count]) => [hash(title), { title, duplicate: count > 1, pin: pins.get(title) }]));
    for (const id of snapshots.keys()) if (!catalog.has(id)) snapshots.delete(id);
    return [...catalog].map(([id, { title, duplicate }]) => sessionOf(id, title, duplicate ? ambiguous : ''));
  }
  async function resolve(id: string) {
    if (!catalog.has(id)) await refreshCatalog();
    const chat = catalog.get(id);
    if (!chat) throw fail('Grok 会话不在原应用的列表中', 404);
    return chat;
  }
  registerEngine({
    ...identity,
    prefix: 'GB',
    capabilities: { send: true, create: false, models: false, reasoning: false, permissions: false, interrupt: true, desktopInterrupt: true },
    look: { userTime: false, replyTime: 'none' },
    list: refreshCatalog,
    models: () => [],
    usage: () => grokDesktop.usage(),
    status: async () => {
      const result = await grokDesktop.native(['check']);
      return { connected: result.ok && result['trusted'] === true && result['running'] === true,
        ...(result.error ? { error: result.error } : {}) };
    },
    blocked: async id => !id ? chooseChat : (await resolve(id)).duplicate ? ambiguous : '',
    create: () => { throw fail(chooseChat); },
    read: async (id, { activate = false } = {}) => {
      const { title, duplicate } = await resolve(id);
      if (duplicate) return { session: sessionOf(id, title, ambiguous), turns: [] };
      const result = await grokDesktop.native([activate ? 'grok-chat-read' : 'grok-chat-peek'], title);
      if (!result.ok) {
        const previous = snapshots.get(id);
        if (!activate && previous) return previous;
        throw fail(result.error || '暂时无法读取 Grok 会话');
      }
      const turns = grokTurns(result['messages']), running = result['running'] === true;
      const turn = turns.at(-1);
      if (running && turn?.id.startsWith('grok-msg-')) { turn.status = 'running'; turn.statusEvidence = 'desktop_page'; }
      const history = { session: { ...sessionOf(id, title, result['offline'] === true ? offline : '', running), capabilities: { interrupt: result['canStop'] === true && turn?.status === 'running' } }, turns };
      snapshots.set(id, history);
      if (snapshots.size > 24) snapshots.delete(snapshots.keys().next().value!);
      return history;
    },
    interrupt: async (id, _emitter, expected) => {
      const { title, duplicate } = await resolve(id), last = snapshots.get(id)?.turns?.at(-1);
      if (duplicate || !expected || last?.id !== expected || last.status !== 'running') throw fail('当前执行轮次已变化，请刷新后再停止');
      const stopped = await grokDesktop.native(['grok-chat-stop'], JSON.stringify({ title, prompt: last.userPrompt }));
      if (!stopped.ok) throw fail(stopped.error || 'Grok 没有确认收到停止请求');
      return { pending: true };
    },
    postMessage: async (id, input) => {
      const { title, duplicate } = await resolve(id);
      if (duplicate) throw fail(ambiguous);
      if (!input.prompt || input.prompt.length > 32000 || input.attachments.length)
        throw fail('Grok 当前只支持发送文本', 400);
      const result = await grokDesktop.native(['grok-chat-send'], JSON.stringify({ title, prompt: input.prompt }));
      if (!result.ok && result.code !== 'crashed') throw fail(result.error || 'Grok 消息未发出');
      if (result['delivery'] !== 'sent')
        return { status: 'uncertain', reason: '无法确认 Grok 是否收到消息，请核对会话，不要重复发送' };
      const seen = grokTurns(result['observed']).at(-1);
      const observedTurnId = seen?.id.startsWith('grok-msg-') && promptKey(seen.userPrompt) === promptKey(input.prompt) ? seen.id : undefined;
      return { status: 'sent', observedTurnId, sessionTitle: title };
    },
    send: () => {
      const emitter = new EngineEvents();
      queueMicrotask(() => emitter.emit('error', new Error('Use the native Grok chat channel')));
      return emitter;
    },
  });
};
