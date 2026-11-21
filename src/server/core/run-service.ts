import { randomUUID } from 'node:crypto';
import { presentHistory, bindEvents, type Emit } from './presentation.js';
import type { PluginHost } from './plugin-host.js';
import type { EventHub } from './event-hub.js';
import type { AgentBusy, Attachment, CreateInput, EngineEmitter, QueuedMessage, RunTurn, SendInput } from '../../shared/contract.js';
import { get, messageOf } from '../../shared/guards.js';

const terminal = new Set<string>(['run.completed', 'run.failed', 'run.interrupted']);
const isTerminal = (type: string): type is 'run.completed' | 'run.failed' | 'run.interrupted' => terminal.has(type);

/** A turn the console runs: the public turn, the engine's emitter, and the timers that watch it. */
export interface RunRecord {
  run: RunTurn;
  emitter: EngineEmitter | null;
  dispose: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  reconciler: ReturnType<typeof setInterval> | null;
  reconciling: boolean;
  emit: Emit;
}
interface QueueItem { id: string; input: SendInput; at: string; dispatchId?: string }
// What an engine threw on purpose: `fallback: 'queue'` sends a steer to the queue instead.
const fallbackOf = (err: unknown) => get(err, 'fallback');
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

class RunService {
  host: PluginHost; hub: EventHub; active: Map<string, RunRecord>; timeoutMs: number;
  queues: Map<string, QueueItem[]>; draining: Map<string, boolean>; pollMs: number;
  private paused = new Set<string>();
  constructor(host: PluginHost, hub: EventHub, { timeoutMs = 30 * 60 * 1000 }: { timeoutMs?: number } = {}) {
    this.host = host; this.hub = hub; this.active = new Map(); this.timeoutMs = timeoutMs;
    // Messages waiting for the session's current turn to end, per session (kept in memory).
    this.queues = new Map(); this.draining = new Map(); this.pollMs = 3000;
  }
  get(engine: string, id: string): RunRecord | undefined { return this.active.get(this.hub.key(engine, id)); }
  start(engineId: string, id: string, input: SendInput | CreateInput, { observe = false, at, dispatchId }: { observe?: boolean; at?: string; dispatchId?: string } = {}): { turnId: string; cursor: string } {
    const engine = this.host.get(engineId), key = this.hub.key(engineId, id);
    if (this.active.has(key)) throw failure('当前会话已有任务正在执行', 409);
    const run: RunTurn = { id: randomUUID(), userPrompt: input.prompt, timestamp: at || new Date().toISOString(), status: 'running', messages: [], activities: [], artifacts: [], approvals: [], timeline: [] };
    const record: RunRecord = { run, emitter: null, dispose: () => {}, timer: null, reconciler: null, reconciling: false, emit: () => {} };
    this.active.set(key, record); this.hub.pinned.add(key);
    const emit: Emit = (...event) => {
      if (this.active.get(key) !== record) return;
      if (record.emitter?.turnId) run.nativeTurnId = record.emitter.turnId;
      const [type] = event;
      if (type === 'message.updated' || type === 'activity.upsert') run.warning = '';
      switch (event[0]) {
        case 'message.updated': upsertEntry(run, run.messages, event[1], 'message'); break;
        case 'activity.upsert': upsertEntry(run, run.activities, event[1], 'activity'); break;
        case 'artifact.upsert': upsertEntry(run, run.artifacts, event[1], 'artifact'); break;
        case 'approval.requested': upsertEntry(run, run.approvals, event[1], null); break;
        case 'approval.resolved': { const resolved = event[1].id; run.approvals = run.approvals.filter(item => item.id !== resolved); break; }
        case 'run.warning': run.warning = event[1].message; if (event[1].awaitingEnd) this.reconcile(engineId, id, record); break;
        case 'run.connection_lost': run.status = 'reconnecting'; run.warning = event[1].message; this.reconcile(engineId, id, record); break;
        default: break;
      }
      if (isTerminal(type)) {
        run.status = type.slice(4); run.statusEvidence = 'run_event'; run.completedAt = Date.now();
        if (type === 'run.failed') record.emitter?.emit('interrupt');
        record.dispose(); if (record.timer) clearTimeout(record.timer); if (record.reconciler) clearInterval(record.reconciler);
        this.active.delete(key); this.hub.pinned.delete(key);
        // The next queued message goes out once this turn has ended.
        if (this.queues.get(key)?.length) setTimeout(() => this.drain(engineId, id), 400).unref?.();
      }
      // The turn's end says which of the desktop's turns it was: a record that carries no time
      // (a chat read from the desktop's page) can only be matched to it by that.
      if (isTerminal(event[0]) && run.nativeTurnId) this.hub.publish(engineId, id, run.id, event[0], { ...event[1], nativeTurnId: run.nativeTurnId });
      else this.hub.publish(engineId, id, run.id, ...event);
    };
    record.emit = emit;
    emit('run.started', { turn: run, ...(dispatchId ? { dispatchId } : {}) });
    // Defer so listeners exist before synchronous provider errors or first events.
    queueMicrotask(() => {
      try {
        if (observe) {
          if (!engine.observe) throw new Error(`${engine.id} cannot observe a turn`);
          record.emitter = engine.observe(id, input);
        } else record.emitter = engine.send(id, sendInputOf(input));
        record.dispose = bindEvents(record.emitter, emit);
      } catch (err) { emit('run.failed', { message: messageOf(err) }); }
    });
    record.timer = setTimeout(() => {
      emit('run.connection_lost', { message: '正在重新确认引擎状态，任务没有被判定失败' });
    }, this.timeoutMs);
    record.timer.unref?.();
    return { turnId: run.id, cursor: this.hub.cursor(engineId, id) };
  }
  reconcile(engineId: string, id: string, record: RunRecord): void {
    if (record.reconciler) return;
    const read = async () => {
      if (record.reconciling || this.get(engineId, id) !== record) return;
      record.reconciling = true;
      try {
        const history = await this.host.get(engineId).read(id);
        const nativeId = record.emitter?.turnId;
        const turn = history.turns?.find(turn => turn.id === nativeId);
        if (!turn?.statusEvidence) return;
        const presented = presentHistory({ turns: [turn] }).turns[0];
        if (!presented) return;
        for (const message of presented.messages) record.emit('message.updated', { ...message, status: 'completed' });
        for (const activity of presented.activities) record.emit('activity.upsert', activity);
        if (turn.completedAt != null) {
          if (turn.status === 'completed') record.emit('run.completed', {});
          else if (turn.status === 'failed') record.emit('run.failed', {});
          else if (turn.status === 'interrupted') record.emit('run.interrupted', {});
        }
      } catch { /* Transport loss is unknown, not proof of task failure. */ }
      finally { record.reconciling = false; }
    };
    record.reconciler = setInterval(read, 2000); record.reconciler.unref?.(); read();
  }
  // Steer: add a message to the turn that is running now (the engine delivers it at its next
  // step, as its desktop does when you type while it works).
  async steer(engineId: string, id: string, input: SendInput, dispatchId?: string): Promise<{ status: string; id?: string; reason?: string }> {
    try { return await this.deliver(engineId, id, input); }
    catch (err) { if (fallbackOf(err) === 'queue') return { ...this.enqueue(engineId, id, input, dispatchId), reason: messageOf(err) }; throw err; }
  }
  async deliver(engineId: string, id: string, input: SendInput): Promise<{ status: string }> {
    const engine = this.host.get(engineId), record = this.get(engineId, id);
    if (!engine.steer) throw failure('这个引擎不支持在运行中插话，可以排队到这一轮结束后发送', 501);
    const result = await engine.steer(id, input, record?.emitter);
    // Engines whose record shows the message as its own prompt (Claude) need no extra bubble.
    if (record && get(result, 'shown') !== false) record.emit('activity.upsert', { id: randomUUID(), kind: 'user_message', title: input.prompt.slice(0, 4000), detail: '', output: '', status: 'completed', durationMs: 0, paths: [] });
    return { status: 'steered' };
  }
  // A queued message can still join the running turn: it leaves the queue only once delivered,
  // and goes back to its place if the turn still cannot take it.
  async steerQueued(engineId: string, id: string, itemId: string): Promise<{ status: string }> {
    const key = this.hub.key(engineId, id), list = this.queues.get(key) || [];
    const index = list.findIndex(item => item.id === itemId);
    if (index < 0) throw failure('这条排队消息已经发出或不存在', 409);
    const [item] = list.splice(index, 1);
    if (!item) throw failure('这条排队消息已经发出或不存在', 409);
    if (!list.length) this.queues.delete(key);
    this.publishQueue(engineId, id);
    try { return await this.deliver(engineId, id, item.input); }
    catch (err) {
      const back = this.queues.get(key) || [];
      back.splice(Math.min(index, back.length), 0, item); this.queues.set(key, back); this.hub.pinned.add(key);
      this.publishQueue(engineId, id);
      if (!this.active.has(key)) setTimeout(() => this.drain(engineId, id), 0).unref?.();
      if (fallbackOf(err) === 'queue') throw failure(`${messageOf(err).replace(/，?消息已排队$/, '')}，消息还在队列里`, 409);
      throw err;
    }
  }
  queued(engineId: string, id: string): QueuedMessage[] {
    return (this.queues.get(this.hub.key(engineId, id)) || []).map(item => ({ id: item.id, prompt: item.input.prompt, attachments: item.input.attachments?.length || 0, at: item.at }));
  }
  queuePaused(engine: string, id: string): boolean { return this.paused.has(this.hub.key(engine,id)); }
  pauseQueue(engine: string, id: string, paused: boolean): { paused: boolean } {
    const key = this.hub.key(engine,id);
    if (paused && !this.queues.has(key)) return { paused: this.paused.has(key) };
    if (paused) this.paused.add(key); else this.paused.delete(key);
    this.publishQueue(engine,id);
    if (!paused && this.queues.has(key)) void this.drain(engine,id);
    return { paused };
  }
  publishQueue(engineId: string, id: string): void { this.hub.publish(engineId, id, null, 'queue.updated', { items: this.queued(engineId, id), paused: this.queuePaused(engineId,id) }); }
  enqueue(engineId: string, id: string, input: SendInput, dispatchId?: string): { status: string; id: string } {
    const key = this.hub.key(engineId, id), list = this.queues.get(key) || [];
    if (list.length >= 20) throw failure('排队的消息太多了', 429);
    const item = { id: randomUUID(), input, at: new Date().toISOString(), ...(dispatchId ? { dispatchId } : {}) };
    list.push(item); this.queues.set(key, list); this.hub.pinned.add(key);
    this.publishQueue(engineId, id);
    if (!this.active.has(key)) setTimeout(() => this.drain(engineId, id), 0).unref?.();
    return { status: 'queued', id: item.id };
  }
  dequeue(engineId: string, id: string, itemId: string): { status: string; prompt: string; attachments: Array<Omit<Attachment, 'path'>> } {
    const key = this.hub.key(engineId, id), list = this.queues.get(key) || [];
    const index = list.findIndex(item => item.id === itemId);
    if (index < 0) throw failure('这条排队消息已经发出或不存在', 409);
    const [item] = list.splice(index, 1); if (!list.length) this.queues.delete(key);
    if (!item) throw failure('这条排队消息已经发出或不存在', 409);
    this.publishQueue(engineId, id);
    // The removed message comes back so the page can put it into the composer for editing.
    const attachments = (item.input.attachments || []).map(({ path: _local, ...file }) => file);
    return { status: 'removed', prompt: item.input.prompt, attachments };
  }
  // Sends the first queued message once nothing runs: no turn of ours, and the desktop's own
  // record shows no running turn (a turn started in the desktop app is waited for too).
  async drain(engineId: string, id: string): Promise<void> {
    const key = this.hub.key(engineId, id);
    if (this.draining.get(key)) return;
    this.draining.set(key, true);
    try {
      while (this.queues.get(key)?.length && !this.active.has(key) && !this.paused.has(key)) {
        let busy = false;
        try {
          const history = await this.host.get(engineId).read(id);
          const status: unknown = history?.session?.status;
          const type = get(status, 'type') || status;
          busy = type === 'busy' || type === 'running' || history?.turns?.at(-1)?.status === 'running';
        } catch { busy = true; } // An unreadable desktop session is not known to be idle.
        if (this.active.has(key) || this.paused.has(key)) break;
        if (busy) { await new Promise<void>(resolve => { setTimeout(resolve, this.pollMs).unref?.(); }); continue; }
        const item = this.queues.get(key)?.shift();
        if (!item) break;
        if (!this.queues.get(key)?.length) this.queues.delete(key);
        this.publishQueue(engineId, id);
        this.start(engineId, id, item.input, { dispatchId: item.dispatchId });
        break;
      }
    } finally {
      this.draining.delete(key);
      if (!this.queues.has(key) && !this.active.has(key)) this.hub.pinned.delete(key);
    }
  }
  async interrupt(engineId: string, id: string, expected?: string): Promise<unknown> {
    const engine = this.host.get(engineId), record = this.get(engineId, id);
    if (!record && !engine.capabilities.desktopInterrupt) throw failure('没有正在执行的任务', 409);
    if (!engine.capabilities.interrupt || !engine.interrupt) throw failure('请在原桌面端停止此任务', 501);
    const changed = () => failure('当前执行轮次已变化，请刷新后再停止', 409);
    if (record && expected && ![record.run.id, record.run.nativeTurnId, record.emitter?.turnId].includes(expected)) throw changed();
    if (!record) {
      if (!expected) throw changed();
      const history = await engine.read(id), reported = history.session?.metadata?.latestTurn;
      const latest = reported?.status === 'running' ? reported : history.turns?.at(-1);
      if (this.get(engineId,id) || history.session?.id !== id || history.session.capabilities?.interrupt === false ||
        latest?.id !== expected || (latest.status !== 'running' && !(latest.status === 'unknown' && history.session.status === 'busy'))) throw changed();
    }
    // Stopping one turn must not immediately start the next message from the workbench queue.
    if (this.queues.has(this.hub.key(engineId,id))) this.pauseQueue(engineId,id,true);
    // An engine that confirms the stop from its own records (the turn may have ended on its
    // own at that moment) returns { pending: true } and reports the final status itself.
    const result = await engine.interrupt(id, record?.emitter, record ? undefined : expected);
    if (!get(result, 'pending')) record?.emit('run.interrupted', {});
    return result;
  }
  async decide(engineId: string, id: string, approvalId: string, decision: unknown): Promise<void> {
    const engine = this.host.get(engineId), record = this.get(engineId, id);
    const approval = record?.run.approvals.find(item => item.id === approvalId);
    if (!record || !approval || !approval.decisions.some(item => (typeof item === 'string' ? item : item.id) === decision) || !engine.decide) throw failure('审批不存在或已失效', 409);
    await engine.decide(approvalId, String(decision));
    record.run.approvals = record.run.approvals.filter(item => item.id !== approvalId);
    record.emit('approval.resolved', { id: approvalId });
  }
  /** What the console holds for an engine: the turns it follows and the messages waiting to go out. */
  holding(engineId: string): AgentBusy {
    const own = (key: string) => this.hub.owns(engineId, key);
    return { running: [...this.active.keys()].filter(own).length, queued: [...this.queues].filter(([key]) => own(key)).reduce((sum, [, items]) => sum + items.length, 0) };
  }
  // The console stops following a turn. The turn itself is the desktop's and goes on there:
  // 'interrupt' on the emitter only tells the engine to stop watching it for the console.
  private drop(record: RunRecord): void { if (record.timer) clearTimeout(record.timer); if (record.reconciler) clearInterval(record.reconciler); record.emitter?.emit('interrupt'); record.dispose(); }
  /** An engine has left the console (its agent was switched off): nothing of it is followed or sent any more. */
  release(engineId: string): void {
    for (const [key, record] of [...this.active]) if (this.hub.owns(engineId, key)) { this.active.delete(key); this.drop(record); }
    for (const key of [...this.queues.keys()]) if (this.hub.owns(engineId, key)) this.queues.delete(key);
    for (const key of this.paused) if (this.hub.owns(engineId,key)) this.paused.delete(key);
  }
  dispose(): void {
    for (const record of this.active.values()) this.drop(record);
    this.active.clear();
  }
}

// A console turn's lists take each entry once, by id, in the order first seen; the timeline
// records where a message, tool step or artifact first appeared.
function upsertEntry<T extends { id: string }>(run: RunTurn, items: T[], data: T, kind: 'message' | 'activity' | 'artifact' | null): void {
  const index = items.findIndex(item => item.id === data.id);
  if (index >= 0) { items[index] = data; return; }
  items.push(data);
  if (kind) run.timeline.push({ kind, id: data.id });
}
// What a send needs: the prompt and attachments are always there (the server fills them in).
function sendInputOf(input: SendInput | CreateInput): SendInput { return { ...input, prompt: input.prompt ?? '', attachments: input.attachments ?? [] }; }

export { RunService };
