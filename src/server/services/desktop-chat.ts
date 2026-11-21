import { randomUUID } from 'node:crypto';
import { EngineEvents, UnifiedTurn } from '../types.js';
import { throughFullscreen, FULLSCREEN_EVERY_MS, FULLSCREEN_HOLD_MS, type DesktopAutomation, type HelperResult } from '../core/desktop-automation.js';
import type { CapabilityFlags, CreateInput, CreateResult, History, SendInput, UnifiedSession } from '../../shared/contract.js';
import { get, list, messageOf } from '../../shared/guards.js';

/** A chat of the mode, as the plugin's list gives it. */
export interface ModeChat { id: string; title: string; updatedAt: string; projectId?: string; [extra: string]: unknown }
/** What a read of the page gave: the chat's turns, how much of it was read, whether a reply is still running. */
export interface ChatPage { turns: UnifiedTurn[]; total: number; read: number; running: boolean; restore: string }
type DesktopRunner = Pick<DesktopAutomation, 'run'> & Partial<Pick<DesktopAutomation, 'showSession'>>;

// A chat whose messages are not on disk (a desktop's cloud chat mode: Claude's "Claude",
// Codex's "ChatGPT"), read from the desktop's own window: the shared driver's read-chat opens it
// in its mode, reads the messages the page draws and puts the desktop back as it was
// (src/server/native/ax-driver.swift). Slow (seconds) and it moves the desktop, so it runs only when
// the person opens such a chat, and a read is kept until the chat changes (its `version`).
// A chat that is answering is read again as it goes, but the desktop is only moved for that every
// `awayMs`, and never while the person is in the desktop app (the driver's chat-status says both
// without moving anything); while a run here follows the chat (`held`), its reads are the latest.
// A read of a chat that has not changed since is good for hours (`ttlMs`): opening it again does not
// move the desktop. Only the chats used most recently are kept (`maxKept`), so a server left
// running does not hold every chat ever opened.
class DesktopChatReader {
  maxKept: number;
  automation: DesktopRunner; ttlMs: number; freshMs: number; awayMs: number; watchVisible: boolean; held: (id: string) => boolean;
  cache: Map<string, { version: string | null; at: number; value: ChatPage }>; reading: Map<string, Promise<ChatPage>>;
  failed = new Map<string, { at: number; error: Error }>(); retryMs: number;
  constructor(automation: DesktopRunner, { ttlMs = 6 * 60 * 60 * 1000, freshMs = 2 * 60 * 1000, awayMs = 20000, retryMs = 10000, maxKept = 200, watchVisible = false, held = () => false }: { ttlMs?: number; freshMs?: number; awayMs?: number; retryMs?: number; maxKept?: number; watchVisible?: boolean; held?: (id: string) => boolean } = {}) { this.maxKept = maxKept; this.automation = automation; this.ttlMs = ttlMs; this.freshMs = freshMs; this.awayMs = awayMs; this.retryMs = retryMs; this.watchVisible = watchVisible; this.held = held; this.cache = new Map(); this.reading = new Map(); }
  // { turns, total?, read?, running } or throws with the desktop's reason.
  // `titleNow`: the name the desktop's list has for the chat at this moment (a new chat is renamed
  // after its first message, and a read may have waited its turn behind another command).
  async read({ id, title, space, version = '', titleNow }: { id: string; title: string; space: string; version?: string; titleNow?: () => string }): Promise<ChatPage> {
    const key = `${space}\n${id}`, kept = this.cache.get(key);
    if (kept) { this.cache.delete(key); this.cache.set(key, kept); } // asked for again: the last to go
    const reading = this.reading.get(key);
    if (reading) return reading;
    const age = kept ? Date.now() - kept.at : Infinity;
    if (kept && (this.held(id) || (kept.value.running && age < 2000))) return kept.value;
    const job = (async () => {
      // Still answering when last read. On the page: read where it is. Elsewhere: only now and then,
      // and not while the person is in the desktop app.
      if (kept?.value.running && this.watchVisible) {
        const status = await this.automation.run(['chat-status', id], { settings: { space }, timeout: 10000 });
        if (status.ok && !status.shown && (status.front || age < this.awayMs)) return this.cache.get(key)?.value ?? kept.value;
      }
      // Just read while sending: good for any version for a short while (the list's time moves on).
      if (kept && !kept.value.running && ((kept.version === version && age < this.ttlMs) || (kept.version === null && age < this.freshMs))) {
        // A desktop-started reply can begin before its cached sidebar entry changes. Check the
        // visible conversation without moving the desktop, then read its new turn if it is busy.
        if (!this.watchVisible || age < 2000) return kept.value;
        const status = await this.automation.run(['chat-status', id], { settings: { space }, timeout: 10000 });
        if (!status.ok || !status.running) return this.cache.get(key)?.value ?? kept.value;
      }
      // A read that just failed is not tried again at once: the page asks every few seconds while
      // the chat is open, and each try moves the desktop.
      const failed = this.failed.get(key);
      if (failed && Date.now() - failed.at < this.retryMs) { if (kept) return kept.value; throw failed.error; }
      let result = await this.automation.run(['read-chat', title, id], { settings: { space }, timeout: 120000 });
      // Not in the sidebar under that name: asked for once more under the name it has by now.
      const renamed = !result?.ok && result?.code === 'not_found' ? titleNow?.() || '' : '';
      if (renamed && renamed !== title) result = await this.automation.run(['read-chat', renamed, id], { settings: { space }, timeout: 120000 });
      if (!result?.ok) {
        const error = Object.assign(new Error(result?.error || '桌面版没有读出这个聊天'), { code: result?.code });
        this.failed.set(key, { at: Date.now(), error });
        // What was read before is still the chat: shown until the desktop can be read again.
        const newer = this.cache.get(key);
        if (newer) return newer.value;
        throw error;
      }
      this.failed.delete(key);
      const newer = this.cache.get(key);
      if (newer && newer !== kept) return newer.value;
      const value = pageOf(id, result);
      this.keep(key, { version, at: Date.now(), value });
      return value;
    })().finally(() => { this.reading.delete(key); });
    this.reading.set(key, job);
    return job;
  }
  // What a send just read from the page, kept as the chat's latest read.
  remember(space: string, id: string, value: ChatPage): void { this.keep(`${space}\n${id}`, { version: null, at: Date.now(), value }); this.failed.delete(`${space}\n${id}`); }
  // Keeps a read as the chat's latest; past `maxKept`, the reads asked for longest ago go (never
  // one of a chat a run is following: that read is all the page has of it).
  private keep(key: string, entry: { version: string | null; at: number; value: ChatPage }): void {
    this.cache.delete(key); this.cache.set(key, entry);
    for (const old of this.cache.keys()) {
      if (this.cache.size <= this.maxKept) break;
      if (old !== key && !this.held(old.slice(old.indexOf('\n') + 1))) { this.cache.delete(old); this.failed.delete(old); }
    }
  }
}
// The driver's read-chat / chat-send result: { messages: [{ role, text }], total, read, running, restore, title, url }.
function pageOf(id: string, result: HelperResult): ChatPage {
  const turns = chatTurns(id, list(result.messages || [])), last = turns.at(-1), running = !!result.running;
  if (last && running) { last.status = 'running'; last.statusEvidence = 'desktop_page'; }
  if (last && result.interrupted === true) { last.status = 'interrupted'; last.statusEvidence = 'desktop_page'; }
  return { turns, total: Number(result.total || 0), read: Number(result.read || 0), running, restore: String(result.restore || '') };
}

// [{ role: 'user'|'assistant', text }] → turns: each of the person's messages opens a turn, the
// replies after it are its messages. A turn the page showed a reply for is completed by the
// desktop's own page; one without a reply is left unknown (nothing invented).
function chatTurns(id: string, messages: unknown[]): UnifiedTurn[] {
  const turns: UnifiedTurn[] = [];
  for (const [index, message] of messages.entries()) {
    const text = String(get(message, 'text') || '');
    if (!text) continue;
    const user = get(message, 'role') === 'user';
    if (user || !turns.length) turns.push(new UnifiedTurn({ id: `${id}:${index}`, userPrompt: user ? text : '', timestamp: '', status: 'unknown', messages: [], timeline: [] }));
    const turn = turns.at(-1), mid = `${id}:${index}:reply`;
    if (user || !turn) continue;
    turn.messages.push({ id: mid, phase: 'final_answer', text });
    turn.timeline.push({ kind: 'message', id: mid });
    turn.assistantReply = text; turn.status = 'completed'; turn.statusEvidence = 'desktop_page';
  }
  for (const turn of turns) for (const message of turn.messages.slice(0, -1)) message.phase = 'commentary';
  return turns;
}

// A plugin's read() for such a chat: its sidebar entry with the messages the desktop shows, or,
// when the desktop could not show them, the entry with the reason (and no messages).
async function readPage(reader: DesktopChatReader, session: UnifiedSession, space: string, version: string, noSend: string, titleNow?: () => string): Promise<History> {
  try {
    const page = await reader.read({ id: session.id, title: session.title, space, version, ...(titleNow ? { titleNow } : {}) });
    const { contentUnavailable: _, ...metadata } = session.metadata;
    // A long chat the page drew only in part says how much was read.
    const partial = page.total && page.read < page.total ? { readFromDesktop: { read: page.read, total: page.total } } : { readFromDesktop: true as const };
    return { session: { ...session, status: page.running ? 'busy' : 'idle', isDesktopActive: page.running, sendBlocked: noSend, metadata: { ...metadata, ...partial } }, turns: page.turns };
  } catch (err) {
    return { session: { ...session, metadata: { ...session.metadata, contentUnavailable: `${session.metadata.contentUnavailable}（这次也没能从桌面版界面读出来：${messageOf(err)}）` } }, turns: [] };
  }
}

// A desktop's chat mode (Claude's "Claude", Codex's "ChatGPT"): its chats live in the cloud and
// the desktop's window is the way in, so everything goes through the shared driver's chat
// commands (src/server/native/ax-driver.swift), in that mode:
//   chats    the plugin's list of the mode's chats (`list`: () => [{ id, title, updatedAt, projectId? }]),
//            with the ones started here until that list has them
//   create   a new chat, in one of the mode's projects or in none: the desktop's own new-chat page
//            takes the first message
//   send     a message into a chat (not while it is answering: the desktop has no queue there)
//   read     its messages, as the page draws them (readPage)
// A reply counts as finished only when the page shows it and no longer shows its stop button;
// until then the run keeps looking, every `pollMs`, without moving the desktop: the driver's
// chat-status says whether the chat is the one on the page (then it is read where it is) and
// whether the person is in the desktop app. A chat that is not on the page can only be read by
// bringing it up for a moment, so that is done seldom (after `awayMs`, then twice as long each
// time, up to `awayMaxMs`) and never while the person is in the desktop app; the run says so.
// The chat is asked for by the name the desktop's list has for it now (a new chat is named, and
// may be renamed, after its first message) and by its id.
// `idFrom`: where the new chat's id is in the page's address, for desktops that have one
// (Claude: "https://claude.ai/chat/<id>"); otherwise it is the new entry in `list`.
// The mode's own model and settings apply: nothing picked here goes with these messages.
// What a chat mode's chats take from the console, as a space's `capabilities` (plugin-contract.md,
// "桌面版的模式"): no folder, no model, effort or permission picks (the mode's own apply), no
// attachments or steering. A plugin with a verified stop action can opt in to it.
// Every message of a chat mode goes through the desktop's window, which on Windows takes the focus for a moment.
const CHAT_CAPABILITIES: Readonly<CapabilityFlags> = Object.freeze({ takesFocus: process.platform === 'win32', cwd: false, models: false, reasoning: false, permissions: false, attachments: false, steer: false, interrupt: false, newOptions: false, newSettings: false, cardActions: false });
// `sidebar`: everything the mode's sidebar lists besides its chats (Codex's ChatGPT mode lists the
// Codex threads in its Recents too), for sharedTitle.
export interface ChatModeOptions { automation: DesktopRunner; space: string; list: () => ModeChat[]; sidebar?: () => ReadonlyArray<{ id: string; title: string }>; idFrom?: RegExp | null; waitSeconds?: number; pollMs?: number; awayMs?: number; awayMaxMs?: number; followMs?: number; label?: string; watchVisible?: boolean }
type ModeInput = Partial<SendInput> & CreateInput;
class ChatMode {
  automation: DesktopRunner; space: string; list: () => ModeChat[]; sidebar: () => ReadonlyArray<{ id: string; title: string }>; idFrom: RegExp | null; waitSeconds: number; pollMs: number; awayMs: number; awayMaxMs: number; followMs: number; label: string;
  reader: DesktopChatReader; made: Map<string, ModeChat>; starts: Map<string, EngineEvents>;
  following = new Map<string, (result: HelperResult) => void>();
  // The chats the list had as each new chat in the making was asked for: until create() answers,
  // a chat that is in none of them may be the one being made, with the helper still on its page.
  making = new Set<Set<string>>();
  beingMade(id: string): boolean { for (const known of this.making) if (!known.has(id)) return true; return false; }
  // How a message waits out a full-screen program in front (throughFullscreen).
  fullscreenRetryMs = FULLSCREEN_EVERY_MS; fullscreenHoldMs = FULLSCREEN_HOLD_MS;
  constructor({ automation, space, list, sidebar = () => [], idFrom = null, waitSeconds = 60, pollMs = 20000, awayMs = 15000, awayMaxMs = 60000, followMs = 30 * 60 * 1000, label = '桌面版', watchVisible = false }: ChatModeOptions) {
    this.automation = automation; this.space = space; this.list = list; this.sidebar = sidebar; this.idFrom = idFrom; this.waitSeconds = waitSeconds; this.pollMs = pollMs; this.awayMs = awayMs; this.awayMaxMs = awayMaxMs; this.followMs = followMs; this.label = label;
    this.reader = new DesktopChatReader(automation, { watchVisible, awayMs, held: id => this.following.has(id) || this.beingMade(id) }); this.made = new Map(); this.starts = new Map();
  }
  // A desktop whose page has no address (Codex) names a new chat only in its list, and the list
  // gains it late: measured, ten seconds after the message went out, when the reply was written.
  // So the console gives such a chat an id of its own as soon as the message is out, and the chat
  // goes by it from then on: once the list has the chat (the entry that was not there before),
  // its entry is shown under that id instead of twice.
  standins = new Map<string, { known: Set<string>; began: number; title: string; real: string; chat: ModeChat }>();
  /** The desktop's own id for a chat, where the console knows it by one it gave. */
  realOf(id: string): string { return this.standins.get(id)?.real || id; }
  chats(): ModeChat[] {
    let listed: ModeChat[] = []; try { listed = this.list() || []; } catch {}
    const taken = new Set([...this.standins.values()].map(stand => stand.real).filter(Boolean));
    for (const [id, stand] of this.standins) {
      if (stand.real) continue;
      const fresh = listed.filter(chat => !stand.known.has(chat.id) && !taken.has(chat.id) && !this.standins.has(chat.id));
      // The one entry the list has gained since: the helper holds the desktop while the chat is made,
      // so a second one can only have come from another device at that moment, and then the name
      // the page gave the chat tells them apart. (Not by the name alone: while the desktop is still
      // naming a chat, the page and the list show the name half written, each its own way.)
      const recent = fresh.filter(chat => (Date.parse(chat.updatedAt) || 0) >= stand.began - 5000);
      const alike = (title: string) => !!title && !!stand.title && (title.startsWith(stand.title) || stand.title.startsWith(title));
      const hit = recent.length === 1 ? recent[0] : recent.find(chat => alike(chat.title.trim()));
      if (hit) { stand.real = hit.id; taken.add(hit.id); }
    }
    const shownAs = new Map([...this.standins].filter(([, stand]) => stand.real).map(([id, stand]) => [stand.real, id]));
    if (shownAs.size) listed = listed.map(chat => { const id = shownAs.get(chat.id); return id ? { ...chat, id } : chat; });
    const ids = new Set(listed.map(chat => chat.id));
    for (const id of [...this.made.keys()]) if (ids.has(id)) this.made.delete(id);
    // A chat given its id here stays one of the mode's chats whatever the list says at the moment
    // (not there yet, or a read of the desktop's files that came back empty).
    const own = [...this.standins].filter(([id]) => !ids.has(id)).map(([, stand]) => stand.chat);
    return [...own, ...this.made.values(), ...listed];
  }
  get(id: string): ModeChat | null { return this.chats().find(chat => chat.id === id) || null; }
  // A chat is brought up by its title in the desktop's sidebar: a row carries no id (nor does Codex's
  // page address), so where another entry of that sidebar has the same title, the wrong one could
  // open. Measured on Windows: a message for Codex's ChatGPT chat "回复 OK" went to the Codex thread
  // of that name, which the ChatGPT mode's Recents lists too. Such a chat is not driven ('' when it can be).
  sharedTitle(id: string): string {
    const chat = this.get(id);
    if (!chat) return '';
    const title = chat.title.trim();
    let entries: ReadonlyArray<{ id: string; title: string }> = [];
    try { entries = [...this.chats(), ...(this.sidebar() || [])]; } catch {}
    // (The chat's own entry under the desktop's id is not another chat; nor, while a new chat has
    // not been matched to its entry yet, is an entry the list gained since it was started.)
    const stand = this.standins.get(id), own = stand?.real || id;
    return entries.some(item => item.id !== id && item.id !== own && !(stand && !stand.real && !stand.known.has(item.id)) && String(item.title || '').trim() === title)
      ? `${this.label}的侧栏里有不止一个叫「${title}」的会话，工作台分不清是哪一个，没有操作：在桌面版里给它改个名字再试` : '';
  }
  has(id: string | null | undefined): boolean { return !!id && !!this.get(id); }
  // Why this message cannot go to the mode ('' when it can).
  refuse(input: ModeInput = {}): string {
    if ((input.attachments || []).length) return `${this.label}这个模式的聊天还不能从工作台带附件，请在桌面版里添加`;
    if (input.model || input.reasoningEffort || input.permissionMode) return `${this.label}这个模式的模型和设置要在桌面版里选，工作台发的消息用桌面版当前的设置`;
    return '';
  }
  async create(input: ModeInput = {}, project: { id: string; name: string } | null = null): Promise<CreateResult> {
    const fail = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
    const prompt = input.prompt || fail('请输入首条消息', 400);
    const refused = this.refuse(input); if (refused) fail(refused);
    const known = new Set(this.chats().map(chat => chat.id)), began = Date.now();
    this.making.add(known);
    let kept = false;
    try { return await this.make(prompt, project, known, began, release => { kept = true; void release.then(() => this.making.delete(known), () => this.making.delete(known)); }); }
    finally { if (!kept) this.making.delete(known); }
  }
  // `keep`: the chat is handed over while its helper is still at work; `making` holds until it is back.
  private async make(prompt: string, project: { id: string; name: string } | null, known: Set<string>, began: number, keep: (until: Promise<unknown>) => void): Promise<CreateResult> {
    const fail = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
    const firstLine = (prompt.split('\n')[0] ?? '').slice(0, 80);
    // What the helper says while it stays on the chat (the driver's progress lines): that the
    // message went out, then the chat as the page shows it, as the reply is written.
    const watching: Array<(seen: HelperResult) => void> = [];
    let out: () => void = () => {};
    const sent = new Promise<'sent'>(resolve => { out = () => resolve('sent'); });
    const onProgress = (seen: HelperResult) => { if (seen['sent'] === true) out(); for (const tell of [...watching]) tell(seen); };
    const job = throughFullscreen(() => this.automation.run(['chat-new', project?.name || '-', String(this.waitSeconds)], { input: prompt, settings: { space: this.space }, timeout: (this.waitSeconds + 90) * 1000, onProgress }), { everyMs: this.fullscreenRetryMs, maxMs: this.fullscreenHoldMs });
    // A desktop whose page has no address names the new chat only in its list, and the helper stays
    // on the chat until the reply is done (`waitSeconds`): the person is not left looking at an empty
    // page for as long as that takes. The chat is handed over as soon as the message is out, under
    // an id given here (standins), and the reply is shown as the helper reports it; with a helper
    // that reports nothing meanwhile, as soon as the list has the one new chat.
    if (!this.idFrom && this.waitSeconds > 0) {
      let done = false; void job.then(() => { done = true; }, () => { done = true; });
      while (!done) {
        const first = await Promise.race([sent, job.then(() => null, () => null), new Promise<null>(resolve => setTimeout(() => resolve(null), 700))]);
        if (done) break;
        if (first === 'sent') {
          const id = randomUUID(), chat: ModeChat = { id, title: firstLine, updatedAt: new Date().toISOString(), projectId: project?.id || '' };
          const stand = { known, began, title: '', real: '', chat };
          this.standins.set(id, stand);
          // The name the page gives the chat (half written at first): only to tell its list entry from another.
          const named = (seen: HelperResult) => { const title = typeof seen['title'] === 'string' ? seen['title'].trim() : ''; if (title) stand.title = title; };
          watching.push(named);
          void job.then(result => { if (result?.ok) named(result); }, () => {});
          keep(job);
          this.reader.remember(this.space, id, { turns: [], total: 0, read: 0, running: true, restore: '' });
          this.starts.set(id, this.follow(chat, prompt, job, undefined, { live: tell => { watching.push(tell); } }));
          return { id, started: true, title: chat.title };
        }
        const fresh = this.chats().filter(chat => !known.has(chat.id) && (Date.parse(chat.updatedAt) || 0) >= began - 5000);
        const early = fresh.length === 1 ? fresh[0] : undefined;
        if (!early) continue;
        const chat: ModeChat = { ...early, title: early.title || firstLine, projectId: project?.id || '' };
        this.reader.remember(this.space, chat.id, { turns: [], total: 0, read: 0, running: true, restore: '' });
        this.starts.set(chat.id, this.follow(chat, prompt, job));
        return { id: chat.id, started: true, title: chat.title };
      }
    }
    const result = await job;
    if (!result?.ok) fail(result?.error || `没能在${this.label}里新建聊天`);
    // Its id: from the page's address, or the entry the desktop's list gained.
    let id = this.idFrom ? String(result.url || '').match(this.idFrom)?.[1] || '' : '';
    const title = result.title ? String(result.title) : '';
    for (let tries = 0; !id && tries < 30; tries++) {
      const fresh = this.chats().filter(chat => !known.has(chat.id));
      id = (fresh.find(chat => title && chat.title === title) || (tries > 10 ? fresh[0] : null))?.id || '';
      if (!id) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!id) fail(`消息已在${this.label}里发出，但还没在它的列表里看到这个新聊天，请到桌面版里查看`, 504);
    const chat: ModeChat = { id, title: title || firstLine, updatedAt: new Date().toISOString(), projectId: project?.id || '' };
    if (!known.has(id) && !this.get(id)) this.made.set(id, chat);
    // What the helper read is the chat's latest read from here on (nothing of it read yet: opening
    // it shows the run's own turn): either way opening the chat does not drive the desktop again.
    this.reader.remember(this.space, id, list(result.messages).length ? pageOf(id, result) : { turns: [], total: 0, read: 0, running: true, restore: '' });
    this.starts.set(id, this.follow(chat, prompt, result));
    return { id, started: true, title: chat.title };
  }
  // The run create() started, handed over once to whoever follows it.
  observe(id: string): EngineEvents {
    const emitter = this.starts.get(id);
    if (!emitter) throw Object.assign(new Error('没有正在执行的任务'), { status: 409 });
    this.starts.delete(id);
    return emitter;
  }
  send(id: string, input: ModeInput = {}): EngineEvents {
    const emitter = new EngineEvents();
    queueMicrotask(async () => {
      const chat = this.get(id), refused = this.refuse(input) || this.sharedTitle(id);
      if (!chat || refused) { emitter.emit('error', new Error(refused || `这个聊天不在${this.label}的列表里`)); return; }
      const held = () => emitter.emit('warning', { message: '前台的程序独占全屏，消息先留在工作台，你离开它后自动发出', retrying: true });
      // The reply is shown as the helper reports it while it stays on the chat (see make).
      const watching: Array<(seen: HelperResult) => void> = [];
      const job = throughFullscreen(() => this.automation.run(['chat-send', chat.title, String(this.waitSeconds)], { input: input.prompt, settings: { space: this.space }, timeout: (this.waitSeconds + 90) * 1000, onProgress: seen => { for (const tell of [...watching]) tell(seen); } }), { everyMs: this.fullscreenRetryMs, maxMs: this.fullscreenHoldMs, held });
      this.follow(chat, input.prompt, job, emitter, { live: tell => { watching.push(tell); }, failed: result => new Error(result?.error || `没能把消息交给${this.label}`) });
    });
    return emitter;
  }
  // Takes the person to this chat in the desktop app, in this mode.
  async show(id: string): Promise<HelperResult> {
    const chat = this.get(id);
    if (!chat) throw Object.assign(new Error(`这个聊天不在${this.label}的列表里`), { status: 404 });
    const shared = this.sharedTitle(id);
    if (shared) throw Object.assign(new Error(shared), { status: 409 });
    const result = await this.automation.showSession?.({ title: chat.title, space: this.space }) ?? { ok: false };
    if (!result.ok) throw Object.assign(new Error(result.error || `没能在${this.label}里打开这个会话`), { status: 409 });
    return result;
  }
  async interrupt(id: string): Promise<{ pending: boolean }> {
    const chat = this.get(id);
    if (!chat) throw Object.assign(new Error(`这个聊天不在${this.label}的列表里`), { status: 404 });
    const finish = this.following.get(id);
    const result = await this.automation.run(['chat-stop', chat.title, id], { settings: { space: this.space }, timeout: 45000 });
    if (!result.ok || result.interrupted !== true || result.running) {
      throw Object.assign(new Error(result.error || `没能确认${this.label}已停止回复`), { status: 409 });
    }
    this.reader.remember(this.space, id, pageOf(id, result));
    if (finish && this.following.get(id) === finish) finish(result);
    return { pending: false };
  }
  // Reports the reply to `prompt` from what the page showed, and looks again while it is not done.
  // `first`: what the send answered, or the send itself while its helper is still on the chat.
  // `live`: hands over a listener for what the helper reports while it is at work. `failed`: a send
  // that did not go out ends the run with this error (without it, the chat exists: the reply is looked for).
  follow(chat: ModeChat, prompt: string | undefined, first: HelperResult | Promise<HelperResult>, emitter = new EngineEvents(), { live, failed }: { live?: (tell: (seen: HelperResult) => void) => void; failed?: (result: HelperResult | null) => Error } = {}): EngineEvents {
    const until = Date.now() + this.followMs, sent = String(prompt || '').trim().slice(0, 200);
    let ended = false, timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      ended = true;
      clearTimeout(timer);
      if (this.following.get(chat.id) === interrupted) this.following.delete(chat.id);
      emitter.off('interrupt', cleanup);
    };
    // `partial`: the page as it is while the reply is being written. Only the turn of this message
    // counts then (the page may not have it yet: the turn before is not this reply).
    const publish = (result: HelperResult, partial = false) => {
      const page = pageOf(chat.id, result);
      if (!page.turns.length) return false;
      this.reader.remember(this.space, chat.id, page);
      const turn = [...page.turns].reverse().find(item => item.userPrompt.trim().startsWith(sent) || sent.startsWith(item.userPrompt.trim().slice(0, 200))) || (partial ? undefined : page.turns.at(-1));
      if (!turn) return false;
      emitter.turnId = turn.id;
      const writing = page.running ? turn.messages.at(-1) : undefined;
      for (const message of turn.messages) emitter.emit(message === writing ? 'item_started' : 'item_completed', { item: { type: 'agentMessage', id: message.id, text: message.text, phase: message.phase } });
      if (turn.messages.length) said = ''; // a message on the page takes the run's note away: say it again
      return turn.status === 'completed' && !page.running;
    };
    const interrupted = (result: HelperResult) => {
      cleanup(); publish(result);
      emitter.emit('completed', { turn: { status: 'interrupted' } });
    };
    this.following.set(chat.id, interrupted);
    emitter.on('interrupt', cleanup);
    const complete = () => { cleanup(); emitter.emit('completed', {}); };
    const waiting = `${this.label}还在回复，工作台会隔一会儿去桌面版里看一眼`, inUse = `你正在用${this.label}，工作台先不把它切到这个聊天；等你离开它，或在桌面版里打开这个聊天，再接着看回复`;
    let said = '', away = this.awayMs, nextAway = Date.now() + away;
    const say = (message: string) => { if (message !== said) { said = message; emitter.emit('warning', { message, retrying: false }); } };
    const again = () => { timer = setTimeout(look, this.pollMs); timer.unref?.(); };
    const look = async () => {
      if (ended) return;
      if (Date.now() > until) { cleanup(); emitter.emit('warning', { message: `${this.label}里这条回复还没结束，工作台不再跟进，请到桌面版里查看`, retrying: false }); return; }
      const status = await this.automation.run(['chat-status', chat.id], { settings: { space: this.space }, timeout: 10000 });
      if (ended) return;
      // Not the chat on the page: reading it moves the desktop.
      if (!(status?.ok && status.shown)) {
        if (status?.ok && status.front) { say(inUse); again(); return; }
        say(waiting);
        if (Date.now() < nextAway) { again(); return; }
        away = Math.min(away * 2, Math.max(this.awayMaxMs, this.awayMs)); nextAway = Date.now() + away;
        // (A new chat may be named like another one: then it is not brought up by that name.)
        const shared = this.sharedTitle(chat.id);
        if (shared) { cleanup(); emitter.emit('warning', { message: `${shared}；这条回复请到桌面版里查看`, retrying: false }); return; }
      }
      const result = await this.automation.run(['read-chat', this.get(chat.id)?.title || chat.title, chat.id], { settings: { space: this.space }, timeout: 120000 });
      if (ended) return;
      if (result?.ok && publish(result)) { complete(); return; }
      again();
    };
    live?.(seen => { if (!ended && list(seen['messages']).length) publish({ ...seen, running: true }, true); });
    // Let the caller subscribe first.
    timer = setTimeout(() => {
      void Promise.resolve(first).then(result => {
        if (ended) return;
        if (failed && !result?.ok) { cleanup(); emitter.emit('error', failed(result)); return; }
        // (A send whose helper did not come back with the page: the chat is in the desktop's list,
        // so the message went out, and the reply is looked for like any other.)
        if (result?.ok && publish(result)) complete();
        else { say(waiting); again(); }
      }, () => { if (ended) return; if (failed) { cleanup(); emitter.emit('error', failed(null)); } else { say(waiting); again(); } });
    }, 50);
    return emitter;
  }
  read(session: UnifiedSession, version: string, noSend = ''): Promise<History> {
    const shared = this.sharedTitle(session.id);
    if (shared) return Promise.resolve({ session: { ...session, sendBlocked: shared, metadata: { ...session.metadata, contentUnavailable: shared } }, turns: [] });
    // The desktop's list can show a new chat before create() has answered for it, and the person
    // can open it then: the helper is still on that chat, so a read would wait behind it and then
    // look for a name the chat no longer has. It is shown as the run's own turn until the send is back.
    if (this.beingMade(session.id) && !this.reader.cache.has(`${this.space}\n${session.id}`)) this.reader.remember(this.space, session.id, { turns: [], total: 0, read: 0, running: true, restore: '' });
    return readPage(this.reader, session, this.space, version, noSend, () => this.get(session.id)?.title || '');
  }
}

export { DesktopChatReader, ChatMode, CHAT_CAPABILITIES, chatTurns, readPage };
