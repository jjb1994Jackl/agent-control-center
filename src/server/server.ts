import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import compression from 'compression';
import { pathToFileURL } from 'node:url';
import { ROOT, PUBLIC } from './paths.js';
import { loadConfig } from './config.js';
import { PluginHost } from './core/plugin-host.js';
import { SettingsStore } from './core/settings-store.js';
import { AgentLooks, AVATAR_MAX_BYTES } from './core/agent-looks.js';
import { EventHub } from './core/event-hub.js';
import { RunService } from './core/run-service.js';
import { ActivityFeed } from './services/activity-feed.js';
import { UsageService } from './services/usage-service.js';
import { SessionObserver } from './services/session-observer.js';
import { DictationService } from './services/dictation.js';
import { presentHistory } from './core/presentation.js';
import { AttachmentStore, ATTACHMENTS_ONLY_PROMPT, isUploadError } from './core/attachments.js';
import { previewFile, resolveFile } from './services/file-preview.js';
import { TranscriptStore } from './services/transcript-export.js';
import { revealFile, fileManager } from './services/reveal.js';
import { markTyping } from './core/desktop-automation.js';
import { mountTasks, workbenchId } from './services/task-board.js';
import { grokDesktop, type GrokReader } from './services/grok-desktop.js';
import os from 'node:os';
import { arr, errorField, get, list, messageOf, str } from '../shared/guards.js';
import { sameTurn } from '../shared/turn-match.js';
import type { BridgeConfig, CreateInput, EnginesResponse, CreateResult, DesktopSettings, Engine, NewControl, SendInput, UnifiedSession, WrapUpCard } from '../shared/contract.js';

// The engine a route's :engine names, found once by app.param (express keeps it on the request).
declare module 'express-serve-static-core' { interface Request { engine?: Engine } }
const engineOf = (req: Request): Engine => { if (!req.engine) throw Object.assign(new Error('Unknown engine'), { status: 404 }); return req.engine; };
// What a caught value says, without assuming it is an Error: its status (else `fallback`) and message.
const statusOf = (err: unknown, fallback = 500): number => Number(errorField(err, 'status')) || fallback;
/** A chat just created here, listed until its engine lists it. */
type Draft = CreateResult & { engine: string; cwd: string; title: string; updatedAt: string };
export interface AppOptions { config?: BridgeConfig; host?: PluginHost; hub?: EventHub; taskFile?: string; grok?: GrokReader }

async function createApp({ config = loadConfig(), host: given, hub = new EventHub(), taskFile, grok = given ? undefined : grokDesktop }: AppOptions = {}) {
  const host = given || new PluginHost({ config });
  // Which agents are on: the person's choice (settings), else whether the agent's desktop app is
  // on this machine. A host handed in with its engines already registered keeps exactly those.
  const settings = new SettingsStore(config.settingsFile);
  // The names, order and faces the person gave the agents; their pictures sit beside the settings file.
  const looks = new AgentLooks(settings, config.settingsFile ? path.join(path.dirname(config.settingsFile), '.frontdesk-avatars') : '');
  if (!host.engines.size && !host.plugins.size) await host.discover(config.pluginDir);
  await host.start(id => settings.agent(id) ?? (process.env.ACC_MANAGED === '1' ? false : undefined));
  const runs = new RunService(host, hub);
  const drafts = new Map<string, Draft>();
  const activity = new ActivityFeed(host, hub, runs);
  const usage = new UsageService(host);
  const streams = new Set<Response>();
  // The pages following the overview (told when the agents change), and each engine's open chat streams.
  const overviews = new Set<Response>(), chatStreams = new Map<string, Set<Response>>();
  const observer = new SessionObserver(host, hub, runs);
  const dictation = new DictationService(host, { preferred: config.dictationEngine });
  const app = express();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    if (!['127.0.0.1','localhost','[::1]'].includes(req.hostname)) return res.sendStatus(403);
    next();
  });
  // The console is a remote window: over a network its answers are mostly waiting for bytes (the
  // lists and a chat's history are hundreds of kilobytes of JSON, the page's script a megabyte),
  // so what compresses is compressed. Never an event stream: each event goes out as it is written.
  app.use(compression({ threshold: 1024, filter: (req, res) => !/^text\/event-stream/.test(String(res.getHeader('Content-Type') || '')) && compression.filter(req, res) }));
  app.use(express.json({ limit: '1mb' }));
  // A local console: accept mutations from the same origin only.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    }
    next();
  });
  // Attached files: kept, described and checked in one place (core/attachments.ts).
  app.get('/api/health', (_req, res) => res.json({ service: 'agent-control-center', instance: process.env.ACC_INSTANCE || null }));
  const tasks = mountTasks(app, host, hub, runs, taskFile ?? (given ? ':memory:' : process.env.ACC_TASK_FILE || path.join(os.homedir(), 'Library/Application Support/Agent Control Center/tasks.sqlite')), grok);
  const attachments = new AttachmentStore(config.uploadsDir);
  const transcripts = new TranscriptStore(config.exportsDir);
  app.post('/api/upload', attachments.receive, (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: '请选择文件' });
    res.json({ files: attachments.describe(files) });
  });
  // Download, rather than execute user-uploaded HTML/SVG in the console origin.
  app.get('/uploads/:filename', (req, res, next) => {
    const name = path.basename(req.params.filename);
    // `root` keeps the dot-folder check to the file itself; the project may live under ~/.gemini.
    res.download(name, name, { root: attachments.dir }, err => { if (err) next(err); });
  });
  // One call to every engine (or the one selected), keyed by engine id. A new chat shows in its
  // engine's list (as a draft) until the engine lists it.
  const call = async (engine: Engine, method: 'status' | 'models' | 'list'): Promise<unknown> => {
    if (method !== 'list') return engine[method]();
    // Without the recent replies each engine attaches for the activity feed (ActivityFeed asks the
    // engine itself): the page never reads them, and they were most of a list's bytes.
    const result: Array<UnifiedSession | Draft> = (await engine.list()).map(session => {
      if (!session.metadata?.recentMessages) return session;
      const { recentMessages: _, ...metadata } = session.metadata;
      return { ...session, metadata };
    });
    const ids = new Set(result.map(item => item.id));
    for (const draft of drafts.values()) if (draft.engine === engine.id && !ids.has(draft.id)) result.unshift(draft);
    return result;
  };
  const collect = async (method: 'status' | 'models' | 'list', selected?: unknown) => Object.fromEntries(await Promise.all(
    (selected ? [host.get(String(selected))] : [...host.engines.values()]).map(async engine => {
      try { return [engine.id, await call(engine, method)]; }
      catch (err) { return [engine.id, method === 'status' ? { connected: false, error: messageOf(err) } : { error: messageOf(err), data: [] }]; }
    })
  ));
  app.get('/api/usage', async (req, res) => res.json(await usage.all()));
  app.get('/api/tasks/usage/all', async (_req, res) => {
    const [engines, catalog] = await Promise.all([usage.all(), host.catalog()]);
    return res.set('Cache-Control', 'no-store').json({
      engines: catalog.filter(engine => engine.id !== 'grok').map(engine => ({ id: engine.id, label: engine.label, enabled: engine.enabled,
        usage: engines[engine.id] })),
      grok: engines.grok,
      grokEnabled: host.engines.has('grok'),
    });
  });
  app.post('/api/grok/usage', async (_req, res) => {
    if (!host.engines.has('grok')) return res.set('Cache-Control', 'no-store').json({ available: false, checkedAt: 0 });
    return res.set('Cache-Control', 'no-store').json(await grok?.usage(true) ?? { available: false, checkedAt: 0 });
  });
  app.get('/api/activity', (req, res) => res.json(activity.snapshot()));
  // The person typing in the page (desktop-automation.ts, markTyping). Only a page on this machine
  // counts: the foreground a Windows helper's action takes is this machine's.
  app.post('/api/typing', (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
    const typing = get(req.body, 'typing');
    if (local && process.platform === 'win32' && (typing === 'composing' || typing === 'keys')) markTyping(typing);
    res.json({ ok: true });
  });
  app.get('/api/activity/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders(); streams.add(res);
    const unsubscribe = activity.subscribe(snapshot => { if (!res.destroyed && !res.writableEnded) {
      if (res.writableLength > 1024 * 1024) { res.end(); return; }
      res.write(`event: activity\ndata: ${JSON.stringify(snapshot)}\n\n`);
    } });
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000); timer.unref?.();
    overviews.add(res);
    res.on('close', () => { clearInterval(timer); unsubscribe(); streams.delete(res); overviews.delete(res); });
  });
  // The agents switched on (`engines`) and every agent the console knows, on or off (`agents`).
  const manifest = async (): Promise<EnginesResponse> => {
    return { engines: looks.sort(host.manifests().map(item => looks.apply(item))), agents: looks.sort((await host.catalog()).map(item => looks.apply(item))), defaultCwd: config.defaultCwd, projectDir: ROOT, httpsPort: config.httpsPort || null, fileManager: fileManager(), dictation: await dictation.sources() };
  };
  app.get('/api/engines', async (req, res) => res.json(await manifest()));
  // An engine has left the console: nothing of it is followed, read, sent or shown any more. What
  // it was running goes on in its desktop app, which never depended on the console.
  const release = (engine: string) => {
    runs.release(engine); observer.release(engine); dictation.release(engine); usage.forget(engine);
    for (const key of [...drafts.keys()]) if (hub.owns(engine, key)) drafts.delete(key);
    for (const res of chatStreams.get(engine) || []) res.end();
    chatStreams.delete(engine);
    hub.forget(engine); activity.forget(engine);
  };
  // Switches an agent on or off: { enabled }. On runs its plugin's setup (its bridge starts and its
  // engine joins the lists); off takes its engine out and lets the plugin release what it holds.
  // Off while the console follows a turn of it or holds messages for it answers 409 with the
  // counts (`busy`); `force: true` goes ahead (the turn goes on in the desktop, the waiting
  // messages are dropped). Every open page is told, and the choice is kept for the next start.
  // Every page redraws its rail when the agents change: switched, renamed, reordered, a new face.
  const agentsChanged = () => { for (const page of overviews) if (!page.destroyed && !page.writableEnded) page.write('event: engines\ndata: {}\n\n'); };
  // The rail's order: { order: [ids] }, the agents named first, the rest after in the plugins' order.
  app.put('/api/agents/order', async (req, res) => {
    looks.reorder(get(req.body, 'order'), new Set(host.plugins.keys()));
    agentsChanged(); res.json(await manifest());
  });
  // What the console calls an agent: { label }, an empty or null label puts the plugin's own back.
  app.patch('/api/agents/:id', async (req, res) => {
    if (!host.plugins.has(req.params.id)) return res.status(404).json({ error: `Unknown plugin: ${req.params.id}` });
    looks.rename(req.params.id, get(req.body, 'label') ?? null);
    agentsChanged(); res.json(await manifest());
  });
  // A picture of the person's own for an agent's face while it is idle or working (the body is
  // the image itself); DELETE puts the plugin's own face back.
  app.put('/api/agents/:id/avatar/:slot', express.raw({ type: () => true, limit: AVATAR_MAX_BYTES }), async (req, res) => {
    if (!host.plugins.has(req.params.id)) return res.status(404).json({ error: `Unknown plugin: ${req.params.id}` });
    looks.save(req.params.id, req.params.slot, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    agentsChanged(); res.json(await manifest());
  });
  app.delete('/api/agents/:id/avatar/:slot', async (req, res) => {
    if (!host.plugins.has(req.params.id)) return res.status(404).json({ error: `Unknown plugin: ${req.params.id}` });
    looks.remove(req.params.id, req.params.slot);
    agentsChanged(); res.json(await manifest());
  });
  app.put('/api/agents/:id', async (req, res) => {
    const id = req.params.id, on: unknown = get(req.body, 'enabled');
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'Invalid enabled' });
    if (!host.plugins.has(id)) return res.status(404).json({ error: `Unknown plugin: ${id}` });
    if (on) {
      try { await host.enable(id); }
      catch (err) { return res.status(statusOf(err)).json({ error: messageOf(err), ...await manifest() }); }
    } else {
      const busy = host.enginesOf(id).map(engine => runs.holding(engine)).reduce((sum, item) => ({ running: sum.running + item.running, queued: sum.queued + item.queued }), { running: 0, queued: 0 });
      if ((busy.running || busy.queued) && get(req.body, 'force') !== true) return res.status(409).json({ error: '工作台还在跟着它的任务', busy });
      await host.disable(id, engines => engines.forEach(release));
    }
    settings.setAgent(id, on);
    agentsChanged();
    res.json(await manifest());
  });
  app.get('/api/status', async (req, res) => res.json(await collect('status')));
  app.get('/api/models', async (req, res) => res.json(await collect('models')));
  app.get('/api/sessions', async (req, res) => res.json(await collect('list', req.query.engine)));
  // The desktop's own project list (optional per engine): empty projects and their order for
  // the sidebar, and where a new chat can start.
  app.get('/api/projects', async (req, res) => res.json(Object.fromEntries(await Promise.all(
    [...host.engines.values()].filter(engine => typeof engine.projects === 'function').map(async engine => {
      try { return [engine.id, (await engine.projects?.() || []).filter(item => item?.id).slice(0, 500).map(item => ({ id: String(item.id), name: String(item.name || ''), cwd: String(item.cwd || ''), ...(item.space ? { space: String(item.space) } : {}) }))]; }
      catch { return [engine.id, []]; }
    })
  ))));
  // A request about one engine is the console in use with it: its desktop is kept ready (keepWarm).
  // Not the ones a chat on screen makes by itself (its pictures, its event stream): only what the
  // person does (opening a chat, the new-chat page, sending) says a command may follow.
  app.param('engine', (req, res, next, id) => {
    try {
      req.engine = host.get(id);
      if (!/\/(media|events)(\/|$)/.test(req.path)) { try { req.engine.keepWarm?.(); } catch {} }
      next();
    } catch (err) { next(err); }
  });
  app.param('id', (req, res, next, id: string) => {
    if (!/^[\w-]{1,200}$/.test(id)) return res.status(400).json({ error: 'Invalid session id' });
    next();
  });
  // Engines may mirror a session they cannot safely write to (for example one that
  // is open in its desktop client); refuse before a run is created.
  const sendBlocked = async (engine: Engine, id: string | null): Promise<string> => engine.capabilities.sendBlocked || (await engine.blocked?.(id)) || '';
  // What an engine's desktop app asks for before a new chat's first message (optional per
  // engine): its controls, read live from the desktop, and one pick made there. A pick answers
  // with the controls as they are afterwards, since one pick can bring up the next.
  const controlsOf = (list: unknown): NewControl[] => (arr(list) || []).slice(0, 20).map((item): NewControl => {
    const options = arr(get(item, 'options'));
    return {
      kind: get(item, 'kind') === 'toggle' ? 'toggle' : 'menu', label: String(get(item, 'label') || ''), value: String(get(item, 'value') || ''),
      // A menu whose options were not read comes without them (the page reads them when needed).
      options: !options ? undefined : options.slice(0, 200).map(option => ({ label: String(get(option, 'label') || ''), section: String(get(option, 'section') || ''), selected: !!get(option, 'selected') })).filter(option => option.label),
    };
  }).filter(item => item.label);
  // `settings` (optional): the model, effort and permission mode the desktop's page shows now, in
  // the console's ids; the composer's menus start on them.
  const settingsOf = (value: unknown): DesktopSettings | undefined => { const out: DesktopSettings = {}; for (const key of ['model', 'effort', 'permissionMode'] as const) { const shown = str(get(value, key)); if (shown) out[key] = shown.slice(0, 200); } return Object.keys(out).length ? out : undefined; };
  // `?read=<label>` (repeatable): only those menus' options are read, the rest come with their values.
  // `?fresh=1`: the person asked to read the desktop again (nothing answered from an earlier read).
  app.get('/api/new-options/:engine', async (req, res) => {
    // An engine whose page asks nothing first may still say what it will start with (newSettings).
    const engine = engineOf(req);
    if (typeof engine.newOptions !== 'function') {
      if (typeof engine.newSettings !== 'function') return res.json({ controls: [] });
      try { const result = await engine.newSettings(); return res.json({ controls: [], settings: settingsOf(result?.settings) }); }
      catch (err) { return res.status(statusOf(err)).json({ error: messageOf(err) }); }
    }
    const asked: unknown = req.query['read'];
    const read = (Array.isArray(asked) ? asked : asked ? [asked] : []).map(item => String(item).slice(0, 200)).filter(Boolean).slice(0, 20);
    try { const result = await engine.newOptions({ read, fresh: req.query['fresh'] === '1' }); res.json({ controls: controlsOf(result?.controls), settings: settingsOf(result?.settings) }); }
    catch (err) { res.status(statusOf(err)).json({ error: messageOf(err) }); }
  });
  // { control, option }, or { picks: [{ control, option }…] } made in order. Answers `picked`: the
  // controls that took their pick (their options are not read again).
  app.post('/api/new-options/:engine', async (req, res) => {
    const engine = engineOf(req), body: unknown = req.body;
    // Bound: an engine's methods may use `this`, as when they were called on it.
    const pickOne = engine.pickNewOption?.bind(engine);
    if (typeof pickOne !== 'function') return res.status(501).json({ error: '这个引擎没有新建选项' });
    const picks = (arr(get(body, 'picks')) || [body]).slice(0, 10)
      .map(item => ({ control: String(get(item, 'control') || '').slice(0, 200), option: String(get(item, 'option') || '').slice(0, 500) }));
    if (!picks.length || picks.some(item => !item.control || !item.option)) return res.status(400).json({ error: '缺少要选的项和选项' });
    const picked = (names: unknown) => (arr(names) || []).map(String).slice(0, 10);
    try {
      let result: unknown;
      if (typeof engine.pickNewOptions === 'function') result = await engine.pickNewOptions(picks);
      else {
        // An engine that picks one at a time: one call each.
        const done: string[] = [];
        for (const item of picks) {
          try { result = await pickOne(item.control, item.option); done.push(item.control); }
          catch (err) { throw Object.assign(err instanceof Error ? err : new Error(String(err)), { picked: done }); }
        }
        result = { ...(typeof result === 'object' ? result : {}), picked: done };
      }
      res.json({ controls: controlsOf(get(result, 'controls')), picked: picked(get(result, 'picked')), settings: settingsOf(get(result, 'settings')) });
    } catch (err) { const controls = errorField(err, 'controls'); res.status(statusOf(err)).json({ error: messageOf(err), controls: controls ? controlsOf(controls) : undefined, picked: picked(errorField(err, 'picked')) }); }
  });
  app.get('/api/sessions/:engine/:id', async (req, res) => {
    const { engine, id } = req.params, target = engineOf(req);
    // A draft stands in for the session until the engine can read it.
    let history: { session: (UnifiedSession | Draft) & { capabilities?: unknown; sendBlocked?: string; isDesktopActive?: boolean } | null | undefined; turns: ReturnType<typeof presentHistory>['turns'] };
    try { const presented = presentHistory(await target.read(id, { activate: true })); history = presented; }
    catch (err) {
      const draft = drafts.get(hub.key(engine, id));
      if (!draft) throw err;
      history = { session: draft, turns: [] };
    }
    if (history.session) history.session.sendBlocked = history.session.sendBlocked || await sendBlocked(target, id);
    const active = runs.get(engine, id);
    if (active) {
      // The turn the console follows is in the desktop's record too: it is shown once, as the
      // console's turn, with the message as the desktop wrote it down (shared/turn-match.ts).
      const run = active.run, mark = { ...run, nativeTurnId: active.emitter?.turnId || run.nativeTurnId };
      const twin = history.turns.find(turn => sameTurn(turn, mark));
      if (twin) { run.nativeTurnId = twin.id; run.userPrompt = twin.userPrompt; run.userImages = twin.userImages; }
      history.turns = history.turns.filter(turn => turn !== twin);
    }
    res.json({ ...history, activeTurn: active?.run || null, queued: runs.queued(engine, id), queuePaused: runs.queuePaused(engine,id), cursor: hub.cursor(engine, id) });
  });
  // The request's message, checked field by field (the body is whatever the page sent).
  const validateInput = (body: unknown = {}): SendInput & CreateInput => {
    const input: Partial<Record<'prompt' | 'cwd' | 'model' | 'reasoningEffort' | 'permissionMode' | 'title' | 'space' | 'projectId', string>> = {};
    const permissionMode = get(body, 'permissionMode');
    if (permissionMode != null && !/^[A-Za-z]{1,32}$/.test(String(permissionMode))) throw Object.assign(new Error('Invalid permissionMode'), { status: 400 });
    for (const key of ['prompt', 'cwd', 'model', 'reasoningEffort', 'permissionMode', 'title', 'space', 'projectId'] as const) {
      const value = get(body, key);
      if (value != null && typeof value !== 'string') throw Object.assign(new Error(`Invalid ${key}`), { status: 400 });
      if (value) input[key] = value.trim();
    }
    // What the new-chat page was showing as chosen (a new chat only): [{ control, option }].
    const expected = get(body, 'expect');
    if (expected != null && (!Array.isArray(expected) || expected.length > 20)) throw Object.assign(new Error('Invalid expect'), { status: 400 });
    const expect = (arr(expected) || []).map(item => ({ control: String(get(item, 'control') || '').slice(0, 200), option: String(get(item, 'option') || '').slice(0, 500) })).filter(item => item.control && item.option);
    const files = attachments.resolve(get(body, 'attachments'));
    // Files with nothing typed still make a message (a new chat's first one too).
    return { ...input, ...(expect.length ? { expect } : {}), prompt: input.prompt || (files.length ? ATTACHMENTS_ONLY_PROMPT : ''), attachments: files };
  };
  const refusal = (message: string) => Object.assign(new Error(message), { status: 409 });
  async function nativeMessage(engine: Engine, session: string, input: SendInput, id?: string) {
    const { observedTurnId, sessionTitle, ...sent } = await engine.postMessage!(session, input);
    if (id) {
      tasks.book.link(id, { nativeTurn: observedTurnId, sessionTitle });
      tasks.book.set(id, sent.status === 'sent' ? 'delivered' : 'uncertain', sent.reason);
    }
    return sent;
  }
  const dispatchContent = (input: CreateInput | SendInput) => [input.prompt, input.attachments?.map(file => file.filename)];
  app.post('/api/sessions/:engine', async (req, res) => {
    const engine = engineOf(req), input = validateInput(req.body), dispatchId = workbenchId(get(req.body, 'dispatchId'));
    const direct = !!(engine.spaces?.find(space => space.id === input.space)?.capabilities?.createRequiresPrompt ?? engine.capabilities.createRequiresPrompt);
    if ((direct || dispatchId) && !input.prompt) return res.status(400).json({ error: '请输入首条消息' });
    const result = await tasks.once(dispatchId, ['create', engine.id, input.cwd, input.space, input.projectId, ...dispatchContent(input)], async () => {
      const blocked = await sendBlocked(engine, null);
      if (blocked) throw refusal(blocked);
      if (dispatchId) tasks.book.reserveWorkbench({ id: dispatchId, engine: engine.id, session: '', project: input.cwd || '', prompt: input.prompt });
      // A managed first message is one operation, even when the native engine needs create + send.
      const asked = new Date().toISOString();
      const session: CreateResult & { run?: unknown; dispatchUncertain?: boolean } = await engine.create(dispatchId && !direct ? { ...input, prompt: '', attachments: [] } : input);
      if (!session?.id) throw new Error('引擎未返回会话 ID');
      const title = str(session.title) || input.title || input.prompt.split('\n')[0]?.slice(0,96) || '新建聊天';
      drafts.set(hub.key(engine.id, session.id), { ...session, engine: engine.id, cwd: session.cwd || input.cwd || '', title, updatedAt: new Date().toISOString() });
      const oldest = drafts.keys().next().value;
      if (drafts.size > 128 && oldest !== undefined) drafts.delete(oldest);
      if (dispatchId) tasks.book.link(dispatchId, { session: session.id, sessionTitle: title });
      if (session.started && engine.observe) session.run = runs.start(engine.id, session.id, input, { observe: true, at: asked, dispatchId });
      else if (dispatchId && !session.started && !direct) {
        if (engine.postMessage) session.dispatchUncertain = (await nativeMessage(engine, session.id, input, dispatchId)).status === 'uncertain';
        else session.run = runs.start(engine.id, session.id, input, { dispatchId });
      }
      else if (dispatchId) {
        if (session.started) tasks.book.link(dispatchId, { sentAt: asked });
        tasks.book.set(dispatchId, session.started ? 'delivered' : 'uncertain');
        session.dispatchUncertain = !session.started;
      }
      return session;
    });
    res.json(result);
  });
  app.post('/api/sessions/:engine/:id/messages', async (req, res) => {
    const engine = engineOf(req), session = req.params.id, input = validateInput(req.body);
    const dispatchId = workbenchId(get(req.body, 'dispatchId')), mode = get(req.body, 'mode');
    if (!input.prompt) return res.status(400).json({ error: '请输入消息或添加附件' });
    const result = await tasks.once(dispatchId, ['message', engine.id, session, ...dispatchContent(input)], async () => {
      const blocked = await sendBlocked(engine, session);
      if (blocked) throw refusal(blocked);
      const reserve = () => { if (dispatchId) tasks.book.reserveWorkbench({ id: dispatchId, engine: engine.id, session,
        project: input.cwd || '', prompt: input.prompt, sessionTitle: str(get(req.body, 'sessionTitle')) || '' }); };
      if (!engine.postMessage && mode === 'steer') {
        const steered = await runs.steer(engine.id, session, input, dispatchId);
        if (dispatchId && steered.status === 'queued') {
          reserve(); tasks.book.link(dispatchId, { queueItem: steered.id }); tasks.book.set(dispatchId, 'queued');
        }
        return steered;
      }
      reserve();
      if (engine.postMessage) return nativeMessage(engine, session, input, dispatchId);
      if (mode === 'queue') {
        const queued = runs.enqueue(engine.id, session, input, dispatchId);
        if (dispatchId) { tasks.book.link(dispatchId, { queueItem: queued.id }); tasks.book.set(dispatchId, 'queued'); }
        return queued;
      }
      return runs.start(engine.id, session, input, { dispatchId });
    });
    res.status(202).json(result);
  });
  // Deliver the message the desktop is holding for the running turn right away (its Send now).
  app.post('/api/sessions/:engine/:id/send-now', async (req, res) => {
    const engine = engineOf(req);
    if (!engine.sendNow) return res.status(501).json({ error: '这个引擎没有立即发送' });
    res.json(await engine.sendNow(req.params.id));
  });
  app.post('/api/sessions/:engine/:id/queue/:itemId/steer', async (req, res) => {
    const result = await runs.steerQueued(req.params.engine, req.params.id, String(req.params.itemId));
    tasks.book.queuedAction(req.params.engine, req.params.id, String(req.params.itemId), true);
    res.json(result);
  });
  app.put('/api/sessions/:engine/:id/queue/pause', (req,res) => {
    const paused = get(req.body,'paused');
    if (typeof paused !== 'boolean') return res.status(400).json({ error: 'Invalid pause state' });
    return res.json(runs.pauseQueue(req.params.engine,req.params.id,paused));
  });
  app.delete('/api/sessions/:engine/:id/queue/:itemId', (req, res) => {
    const result = runs.dequeue(req.params.engine, req.params.id, String(req.params.itemId));
    tasks.book.queuedAction(req.params.engine, req.params.id, String(req.params.itemId), false);
    res.json(result);
  });
  // Images inside a session (screenshots in tool results, generated images), served by the engine.
  app.get('/api/sessions/:engine/:id/media/:key', async (req, res) => {
    const engine = engineOf(req);
    if (!/^[\w.-]{1,200}$/.test(req.params.key) || !engine.media) return res.status(404).json({ error: 'Not found' });
    const media = await engine.media(req.params.id, req.params.key);
    if (!media?.data || !/^image\/(png|jpeg|gif|webp)$/.test(media.type || '')) return res.status(404).json({ error: 'Not found' });
    res.set({ 'Content-Type': media.type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }).send(media.data);
  });
  // A file named in a reply, read-only and only from the session's own working directory.
  // POST keeps local paths out of URLs and access logs.
  // Besides the working directory, an engine may name folders it keeps for the chat (fileRoots).
  const fileScope = async (engine: Engine, id: string) => {
    let cwd = '', roots: string[] = [];
    try { cwd = (await engine.read(id))?.session?.cwd || ''; } catch {}
    try { roots = typeof engine.fileRoots === 'function' ? (await engine.fileRoots(id) || []).filter((root: unknown) => typeof root === 'string' && path.isAbsolute(root)) : []; } catch {}
    return { cwd, roots };
  };
  app.post('/api/sessions/:engine/:id/file', async (req, res) => {
    const { cwd, roots } = await fileScope(engineOf(req), req.params.id);
    try { res.set('Cache-Control', 'no-store').json(previewFile(cwd, get(req.body, 'path'), roots)); }
    catch (err) { res.status(statusOf(err)).json({ error: errorField(err, 'status') ? messageOf(err) : '读取文件失败' }); }
  });
  // The same file, shown where the person works with it: `where: 'finder'` selects it in the
  // system's file manager; `where: 'desktop'` asks the engine to open it in its desktop app, in this
  // chat (capabilities.openFile). Only files inside the session's working directory.
  app.post('/api/sessions/:engine/:id/reveal', async (req, res) => {
    const engine = engineOf(req), body: unknown = req.body;
    const { cwd, roots } = await fileScope(engine, req.params.id);
    try {
      const { file, relative } = resolveFile(cwd, get(body, 'path'), roots);
      if (get(body, 'where') === 'desktop') {
        if (!engine.capabilities?.openFile || typeof engine.openFile !== 'function') return res.status(404).json({ error: '这个 AI 的桌面版不支持打开文件' });
        const result = await engine.openFile(req.params.id, { path: String(get(body, 'path')), absolute: file, relative, label: String(get(body, 'label') || '').slice(0, 200) });
        return res.json({ status: 'opened', pressed: get(result, 'pressed') !== false });
      }
      await revealFile(file);
      res.json({ status: 'revealed' });
    } catch (err) { res.status(statusOf(err)).json({ error: errorField(err, 'status') ? messageOf(err) : '没能打开这个文件' }); }
  });
  // Takes the person to this chat in the engine's desktop app (capabilities.showInDesktop).
  app.post('/api/sessions/:engine/:id/show', async (req, res) => {
    const engine = engineOf(req);
    if (!engine.capabilities?.showInDesktop || typeof engine.show !== 'function') return res.status(404).json({ error: '这个 AI 的桌面版不支持打开会话' });
    try { await engine.show(req.params.id); res.json({ status: 'shown' }); }
    catch (err) { res.status(statusOf(err)).json({ error: errorField(err, 'status') ? messageOf(err) : '没能在桌面版里打开这个会话' }); }
  });
  // This chat as the text another chat's message carries to refer to it (services/transcript-export.ts),
  // read from the desktop's own record at this moment. `file: true` is sent by a page whose agent can
  // read this computer's files: a long chat, shortened in the text, is then also written whole as a
  // file the text points to. `attach: true`, by a page whose agent takes files: the text is also kept
  // as an attached file (core/attachments.ts), so it goes with the message as the agent's files do
  // and the composer and the desktop's chat show a card, not the whole text. A chat with nothing in
  // it is not referred to.
  app.post('/api/sessions/:engine/:id/transcript', async (req, res) => {
    const engine = engineOf(req), history = presentHistory(await engine.read(req.params.id));
    if (!history.session) return res.status(404).json({ error: '没有找到这个聊天' });
    if (!history.turns.length) return res.status(409).json({ error: history.session.metadata?.contentUnavailable || '这个聊天还没有内容可以引用' });
    const reference = transcripts.reference(engine.id, history.session, history.turns, engine.label, { file: get(req.body, 'file') === true });
    const attachment = get(req.body, 'attach') === true ? attachments.keep(reference.text, { stem: `chat-${engine.id}`, name: `${reference.title || 'chat'}.md` }) : undefined;
    res.set('Cache-Control', 'no-store').json({ ...reference, ...(attachment ? { attachment } : {}) });
  });
  app.post('/api/sessions/:engine/:id/interrupt', async (req, res) => {
    const result = await runs.interrupt(req.params.engine, req.params.id, str(get(req.body,'turnId')) || undefined);
    res.json({ status: get(result, 'pending') ? 'stopping' : 'interrupted', queuePaused: runs.queuePaused(req.params.engine, req.params.id) });
  });
  // The desktop's own buttons on the session's wrap-up card (commit, open a PR…): read from the
  // desktop app (their names are its own, not in the record), then one pressed there by its place
  // among them (capabilities.cardActions). What a button starts is the desktop's to run.
  const cardOf = (body: unknown): WrapUpCard => ({
    ask: String(str(get(body, 'ask')) || '').slice(0, 2000), recap: String(str(get(body, 'recap')) || '').slice(0, 2000),
    replies: list(get(body, 'replies')).map(item => String(str(item) || '').slice(0, 200)).filter(Boolean).slice(0, 8),
  });
  const cardEngine = (engine: Engine) => (engine.capabilities?.cardActions && engine.readCard && engine.pressAction ? { readCard: engine.readCard.bind(engine), pressAction: engine.pressAction.bind(engine) } : null);
  app.post('/api/sessions/:engine/:id/card', async (req, res) => {
    const card = cardOf(req.body), engine = cardEngine(engineOf(req));
    if (!card.ask && !card.recap) return res.status(400).json({ error: '缺少卡片的内容' });
    if (!engine) return res.status(501).json({ error: '这个操作只能在桌面版里点' });
    try { res.set('Cache-Control', 'no-store').json(await engine.readCard(req.params.id, card)); }
    catch (err) { res.status(statusOf(err)).json({ error: errorField(err, 'status') ? messageOf(err) : '没能从桌面版读出这张卡片' }); }
  });
  app.post('/api/sessions/:engine/:id/actions', async (req, res) => {
    const card = cardOf(req.body), index = get(req.body, 'index'), label = String(str(get(req.body, 'label')) || '').slice(0, 200);
    if ((!card.ask && !card.recap) || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 16) return res.status(400).json({ error: '缺少要按的按钮' });
    const engine = cardEngine(engineOf(req));
    if (!engine) return res.status(501).json({ error: '这个操作只能在桌面版里点' });
    try {
      const result = await engine.pressAction(req.params.id, { ...card, index, label });
      res.json({ status: 'pressed', pressed: get(result, 'pressed') !== false });
    } catch (err) { res.status(statusOf(err)).json({ error: errorField(err, 'status') ? messageOf(err) : '没能在桌面版里按下这个按钮' }); }
  });
  app.post('/api/sessions/:engine/:id/approvals/:approvalId', async (req, res) => {
    await runs.decide(req.params.engine, req.params.id, req.params.approvalId, get(req.body, 'decision')); res.json({ status: 'resolved' });
  });
  app.get('/api/sessions/:engine/:id/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders(); streams.add(res);
    const send = (event: { id?: unknown; type?: unknown }) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.writableLength > 1024 * 1024) { res.end(); return; }
      res.write(`${event.id ? `id: ${event.id}\n` : ''}event: ${event.type === 'stream.reset' ? 'reset' : 'bridge'}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const after: unknown = req.query['after'];
    // Node joins a repeated unknown header into one string; an array never arrives here.
    const cursor = str(req.headers['last-event-id']) || str(after);
    const unsubscribe = hub.subscribe(req.params.engine, req.params.id, cursor, send);
    const releaseObserver = observer.acquire(req.params.engine, req.params.id);
    res.write(`event: ready\ndata: ${JSON.stringify({ cursor: hub.cursor(req.params.engine, req.params.id), activeTurn: runs.get(req.params.engine, req.params.id)?.run || null })}\n\n`);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000); heartbeat.unref?.();
    const open = chatStreams.get(req.params.engine) || new Set<Response>();
    chatStreams.set(req.params.engine, open.add(res));
    res.on('close', () => { clearInterval(heartbeat); unsubscribe(); releaseObserver(); streams.delete(res); open.delete(res); });
  });
  // Dictation: the browser streams 16 kHz PCM to an agent's own speech service. Any agent's can
  // serve any chat and none is required: the person's pick, the default (BRIDGE_DICTATION_ENGINE),
  // the agent being typed for, then the others, the first that can start (shared/dictation.ts).
  // When none can, the answer says why for each, and the page uses the browser's recognizer.
  app.get('/api/dictation', async (req, res) => res.json(await dictation.sources()));
  app.post('/api/dictation/:engine', async (req, res) => {
    const asked = str(get(req.body, 'language')), prefer = str(get(req.body, 'prefer')) || '';
    const language = asked && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(asked) ? asked : 'zh';
    try { res.json(await dictation.start(req.params.engine, { language, ...(/^[\w-]{1,64}$/.test(prefer) ? { prefer } : {}) })); }
    catch (err) { res.status(statusOf(err)).json({ error: messageOf(err), skipped: list(errorField(err, 'skipped')) }); }
  });
  app.post('/api/dictation/:engine/:id/audio', express.raw({ type: 'application/octet-stream', limit: '1mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty audio' });
    dictation.audio(req.params.id, req.body); res.status(204).end();
  });
  app.post('/api/dictation/:engine/:id/finish', (req, res) => { dictation.finish(req.params.id); res.status(204).end(); });
  app.post('/api/dictation/:engine/:id/cancel', (req, res) => { dictation.cancel(req.params.id); res.status(204).end(); });
  app.get('/api/dictation/:engine/:id/events', (req, res) => {
    const session = dictation.get(req.params.id);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders(); streams.add(res);
    const unsubscribe = dictation.subscribe(session.id, snapshot => {
      if (res.writableEnded) return;
      res.write(`event: transcript\ndata: ${JSON.stringify(snapshot)}\n\n`);
      if (snapshot.final) res.end();
    });
    res.on('close', () => { unsubscribe(); streams.delete(res); });
  });
  // Character art read from an installed desktop app (see src/server/services/app-assets.ts).
  app.get('/api/characters/:name', (req, res) => {
    const asset = looks.asset(req.params.name) || host.asset(req.params.name);
    if (!asset) return res.status(404).json({ error: 'Character not available' });
    res.set({ 'Content-Type': asset.type, 'Cache-Control': 'private, max-age=86400' }).send(asset.data);
  });
  // The page's built files carry a hash of their content in their name ("index-Cu2kkF6P.js"): a
  // browser that has one never needs to ask for it again. The page itself is always asked for.
  app.use(express.static(PUBLIC, { setHeaders: (res, file) => {
    if (/[\\/]assets[\\/][^\\/]+-[\w-]{8}\.\w+$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  } }));
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    res.status(statusOf(err, isUploadError(err) ? 400 : 500)).json({ error: messageOf(err) || '服务异常' });
  });
  return { app, host, hub, runs, activity, async dispose() { for (const res of streams) res.end(); tasks.close(); activity.dispose(); observer.dispose(); dictation.dispose(); runs.dispose(); await host.dispose(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) createApp().then(context => {
  const config = loadConfig();
  const server = context.app.listen(config.port, config.host, () => console.log(`Agent Control Center · http://127.0.0.1:${config.port}/tasks.html`));
  const close = async () => { server.close(); await context.dispose(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}).catch((err: unknown) => { console.error(messageOf(err)); process.exitCode = 1; });
export { createApp };
