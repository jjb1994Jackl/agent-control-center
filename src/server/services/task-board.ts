import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Express } from 'express';
import type { BridgeEvent } from '../../shared/contract.js';
import type { PluginHost } from '../core/plugin-host.js';
import type { EventHub } from '../core/event-hub.js';
import type { RunService } from '../core/run-service.js';
import { presentHistory } from '../core/presentation.js';
import { promptKey, stampOf } from '../../shared/turn-match.js';
import { grokDispatch, grokConfigured } from './grok-routine.js';
import { receiptPrompt, type GrokReader, type GrokReceipt } from './grok-desktop.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const marker = (id: string) => 'ACC/' + id + ':';
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
const statusOf = (error: unknown) => Number((error as { status?: number })?.status) || 500;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function workbenchId(value: unknown): string | undefined {
  if (value == null) return;
  if (typeof value !== 'string' || !uuid.test(value)) throw invalid('任务参数无效');
  return value.toLowerCase();
}
type Task = {
  id: string;
  engine: string;
  session: string;
  project: string;
  title: string;
  state: string;
  turn: string;
  preview: string;
  created: string;
  updated: string;
  result?: string;
  source: 'legacy' | 'workbench';
  session_name: string;
  native_turn: string;
  prompt_hash: string;
  sent_at: string;
  queue_item: string;
};
type Dispatch = { id: string; engine: string; session: string; project: string; prompt: string; sessionTitle?: string };

export class TaskBook {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    // Only the owner may recover unfinished rows. A second launcher must not mark live work uncertain.
    this.db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, engine TEXT NOT NULL, session TEXT NOT NULL, project TEXT NOT NULL,
      title TEXT NOT NULL, state TEXT NOT NULL, turn TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_turn ON tasks(engine,session,turn);
      UPDATE tasks SET state='uncertain' WHERE state IN ('sending','queued','running','waiting');`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
    for (const name of ['result','session_name','native_turn','prompt_hash','sent_at','queue_item','source'])
      if (!columns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${name === 'source' ? 'legacy' : ''}'`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS workbench_requests (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL DEFAULT ''
    )`);
  }
  get(id: string) {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined;
  }
  list() {
    return this.db.prepare(`SELECT id,engine,session,project,title,state,turn,preview,created,updated,source,session_name
      FROM tasks WHERE state != 'merged' ORDER BY updated DESC`).all() as Task[];
  }
  reserve(id: string, engine: string, session: string, project: string, title: string) {
    const at = new Date().toISOString();
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO tasks(id,engine,session,project,title,state,created,updated) VALUES(?,?,?,?,?,'sending',?,?)",
        )
        .run(id, engine, session, project, title, at, at).changes !== 0
    );
  }
  set(id: string, state: string, preview?: string, session?: string, turn?: string) {
    this.db
      .prepare(
        'UPDATE tasks SET state=?, preview=coalesce(?,preview),session=coalesce(?,session),turn=coalesce(?,turn),updated=? WHERE id=?',
      )
      .run(state, preview?.slice(0, 320) ?? null, session ?? null, turn ?? null, new Date().toISOString(), id);
  }
  reserveWorkbench({ id, engine, session, project, prompt, sessionTitle = '' }: Dispatch) {
    const title = prompt.split('\n')[0]?.trim().slice(0,96) || '工作台任务';
    if (!this.reserve(id, engine, session, project, title)) throw invalid('此任务编号已存在');
    this.db.prepare("UPDATE tasks SET source='workbench',session_name=?,prompt_hash=? WHERE id=?")
      .run(sessionTitle.trim().slice(0,240), digest(promptKey(prompt)), id);
  }
  link(id: string, { session, sessionTitle, nativeTurn, queueItem, sentAt }: { session?: string; sessionTitle?: string; nativeTurn?: string; queueItem?: string; sentAt?: string }) {
    this.db.prepare(`UPDATE tasks SET session=coalesce(?,session), session_name=coalesce(?,session_name),
      native_turn=coalesce(?,native_turn), queue_item=coalesce(?,queue_item), sent_at=coalesce(?,sent_at) WHERE id=?`)
      .run(session ?? null, sessionTitle?.slice(0,240) || null, nativeTurn || null, queueItem ?? null, sentAt ?? null, id);
  }
  queuedAction(engine: string, session: string, queueItem: string, merged: boolean) {
    const row = this.db.prepare("SELECT id FROM tasks WHERE engine=? AND session=? AND queue_item=? AND state='queued'").get(engine, session, queueItem);
    if (row) this.set(String(row.id), merged ? 'merged' : 'interrupted', merged ? undefined : '已从队列移除，未下发');
  }
  applyGrokReceipt(receipt: GrokReceipt) {
    const text = receipt.text.slice(0, 12000);
    this.db.prepare(`UPDATE tasks SET state=?,preview=?,result=?,updated=?
      WHERE id=? AND engine='grok' AND source='legacy' AND state IN ('accepted','uncertain','waiting') AND (state!=? OR result!=?)`)
      .run(receipt.state, text.slice(0, 320), text, new Date().toISOString(), receipt.id, receipt.state, text);
  }
}

export function mountTasks(app: Express, host: PluginHost, hub: EventHub, runs: RunService, file: string, grok?: GrokReader) {
  const book = new TaskBook(file);
  let closed = false;
  const off = hub.subscribeAll((event) => {
    const e = event as BridgeEvent;
    if (e.type === 'queue.updated') {
      const pending = new Set(e.data.items.map((item) => promptKey(item.prompt).split(' ', 1)[0]));
      const queued = book.db
        .prepare("SELECT id FROM tasks WHERE engine=? AND session=? AND state='queued' AND source='legacy'")
        .all(e.engine, e.sessionId);
      // Draining first removes the queue item, then emits run.started synchronously.
      for (const row of queued)
        if (!pending.has(marker(String(row.id))))
          queueMicrotask(() => {
            if (!closed && book.get(String(row.id))?.state === 'queued') book.set(String(row.id), 'uncertain');
          });
      return;
    }
    if (e.type === 'run.started') {
      const id = e.data.dispatchId || /^ACC\/([\da-f-]{36}):/i.exec(e.data.turn.userPrompt ?? '')?.[1];
      const t = id && book.get(id);
      if (t && t.engine === e.engine && t.session === e.sessionId && ['sending', 'queued'].includes(t.state)) {
        book.set(t.id, 'running', undefined, e.sessionId, e.turnId ?? undefined);
        book.link(t.id, { sentAt: String(e.data.turn.timestamp), queueItem: '' });
      }
      return;
    }
    if (!e.turnId) return;
    const t = book.db
      .prepare('SELECT id,state FROM tasks WHERE engine=? AND session=? AND turn=?')
      .get(e.engine, e.sessionId, e.turnId);
    if (!t) return;
    const id = String(t.id);
    book.link(id, { nativeTurn: 'nativeTurnId' in e.data && typeof e.data.nativeTurnId === 'string' ? e.data.nativeTurnId : runs.get(e.engine, e.sessionId)?.run.nativeTurnId || undefined });
    if (e.type === 'message.updated' && e.data.phase !== 'analysis') book.set(id, String(t.state), e.data.text);
    if (e.type === 'approval.requested') book.set(id, 'waiting');
    if (e.type === 'approval.resolved' && !runs.get(e.engine, e.sessionId)?.run.approvals.length)
      book.set(id, 'running');
    if (e.type === 'run.connection_lost' || (e.type === 'run.warning' && e.data.awaitingEnd))
      book.set(id, 'uncertain');
    if (e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.interrupted')
      book.set(
        id,
        e.type.slice(4),
        e.type === 'run.failed' ? e.data.message : undefined,
        undefined,
        e.data.nativeTurnId,
      );
  });
  // Recovery reads the session and exact turn evidence. It never replays a send after a restart.
  let lastRecovery = 0,
    recovering = false;
  async function recover() {
    if (recovering || Date.now() - lastRecovery < 10000) return;
    lastRecovery = Date.now();
    recovering = true;
    try {
      const rows = book.db
        .prepare(
          `SELECT * FROM tasks WHERE state IN ('uncertain','accepted','delivered','replied') AND session!=''
            AND ((source='legacy' AND engine!='grok') OR (source='workbench' AND (native_turn!='' OR sent_at!='')))
            ORDER BY updated DESC LIMIT 80`,
        )
        .all() as Task[];
      const histories = new Map<string, ReturnType<typeof presentHistory>>();
      for (const t of rows) {
        if (closed) break;
        try {
          const engine = host.get(t.engine);
          let nativeTurn = t.native_turn;
          if (t.engine === 'grok' && t.source === 'workbench' && nativeTurn.startsWith('grok-')) {
            // A sent receipt proved the text appeared in this group. The desktop has no stable
            // date/ID here, so don't use a visible message to resolve older or repeated dispatches.
            const horizon = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            if (t.created < horizon || book.db.prepare(`SELECT 1 FROM tasks WHERE engine='grok' AND session=?
              AND source='workbench' AND prompt_hash=? AND id!=? AND created>=? AND state NOT IN ('rejected','merged') LIMIT 1`)
              .get(t.session,t.prompt_hash,t.id,horizon)) continue;
            nativeTurn = 'grok-msg-' + t.prompt_hash.slice(0,28);
          }
          const key = hub.key(t.engine, t.session);
          let h = histories.get(key);
          if (!h) { h = presentHistory(await engine.read(t.session)); histories.set(key, h); }
          if (h.session?.id !== t.session) continue;
          const candidates = t.source === 'legacy'
            ? h.turns.filter(v => promptKey(v.userPrompt).startsWith(marker(t.id)))
            : nativeTurn ? h.turns.filter(v => v.id === nativeTurn)
            : h.turns.filter(v => stampOf(v.timestamp) >= stampOf(t.sent_at) && digest(promptKey(v.userPrompt)) === t.prompt_hash);
          const turn = candidates.length === 1 ? candidates[0] : undefined;
          if (!turn) continue;
          const end = turn.statusEvidence && turn.completedAt ? turn.status : await engine.confirmTurnEnd?.(t.session,turn.id);
          if (closed) break;
          const current = book.get(t.id);
          if (!current || !['uncertain','accepted','delivered','replied'].includes(current.state)) continue;
          const reply = turn.messages.filter(m => m.phase !== 'analysis').at(-1)?.text;
          if (end && ['completed', 'failed', 'interrupted'].includes(end)) book.set(t.id, end, reply, t.session, turn.id);
          else if (t.source === 'workbench' && reply && (current.state !== 'replied' || current.preview !== reply.slice(0,320)))
            book.set(t.id, 'replied', reply);
        } catch {
          /* An unavailable desktop supplies no evidence. */
        }
      }
    } finally {
      recovering = false;
    }
  }
  let grokSync: { checkedAt: number; reason?: string } = { checkedAt: 0 };
  let grokRead: Promise<void> | undefined;
  async function syncGrok() {
    if (!grok || closed) return;
    if (grokRead) return grokRead;
    if (Date.now() - grokSync.checkedAt < 5000) return;
    const ids = new Set(book.db.prepare(`SELECT id FROM tasks
      WHERE engine='grok' AND source='legacy' AND state IN ('accepted','uncertain','waiting') ORDER BY updated DESC LIMIT 48`)
      .all().map(row => String(row.id).toLowerCase()));
    if (!ids.size) { grokSync = { checkedAt: 0 }; return; }
    grokRead = (async () => {
      try {
        const seen = await grok.receipts(ids);
        if (closed) return;
        for (const entry of seen.receipts) if (ids.has(entry.id)) book.applyGrokReceipt(entry);
        grokSync = { checkedAt: Date.now(), ...(seen.reason ? { reason: seen.reason } : {}) };
      } catch {
        grokSync = { checkedAt: Date.now(), reason: '暂时无法读取 Grok 回传' };
      } finally { grokRead = undefined; }
    })();
    return grokRead;
  }
  app.get('/api/tasks', (_req, res) => {
    void recover();
    void syncGrok();
    res.set('Cache-Control', 'no-store').json(book.list());
  });
  app.get('/api/tasks/:id', (req, res) => {
    const task = book.get(req.params.id);
    if (!task) return res.sendStatus(404);
    return res.set('Cache-Control', 'no-store').json(task);
  });
  app.get('/api/grok/sync', (_req, res) => res.set('Cache-Control', 'no-store').json(grokSync));
  app.get('/api/grok/available', async (_req, res) => res.json({ configured: await grokConfigured() }));
  app.post('/api/tasks', async (req, res) => {
    const { id, engine, prompt, session = '', project = '', title = '' } = req.body ?? {};
    if (
      typeof id !== 'string' ||
      !uuid.test(id) ||
      typeof engine !== 'string' ||
      typeof prompt !== 'string' ||
      !prompt.trim() ||
      prompt.length > 32000 ||
      typeof session !== 'string' ||
      (session && !/^[\w-]{1,200}$/.test(session)) ||
      typeof project !== 'string' ||
      project.length > 2048 ||
      typeof title !== 'string'
    )
      throw invalid('任务参数无效');
    const prev = book.get(id);
    if (prev) return res.json(prev);
    if (engine !== 'grok' && !host.engines.has(engine)) throw invalid('该 Agent 未启用');
    if (engine === 'grok' && (project || session)) throw invalid('Grok 不接受项目或会话参数');
    const desktop = engine === 'grok' ? undefined : host.get(engine);
    if (desktop && (desktop.capabilities.send === false || (!session && desktop.capabilities.create === false)))
      throw invalid('此 Agent 不支持该派单方式');
    if (!book.reserve(
      id,
      engine,
      session,
      project,
      title.trim().slice(0, 96) || prompt.trim().split('\n')[0]!.slice(0, 96),
    )) return res.json(book.get(id));
    try {
      if (engine === 'grok') {
        const result = await grokDispatch(id, receiptPrompt(prompt, id));
        book.set(id, result.state, result.note);
      } else {
        const agent = host.get(engine);
        const blocked = agent.capabilities.sendBlocked || (await agent.blocked?.(session || null));
        if (blocked) throw invalid(blocked);
        const input = { prompt: marker(id) + '\n' + prompt.trim(), cwd: project || undefined };
        if (session) {
          // Verify the selected session exists; RunService serializes turns even if another was started natively.
          const history = await agent.read(session);
          if (!history.session || history.session.id !== session) throw invalid('未找到此会话');
          if (agent.postMessage) {
            const sent = await agent.postMessage(session, { ...input, attachments: [] });
            book.set(id, sent.status === 'sent' ? 'accepted' : 'uncertain', sent.reason);
          } else {
            book.set(id, 'queued');
            runs.enqueue(engine, session, { ...input, attachments: [] });
          }
        } else {
          const at = new Date().toISOString();
          const created = await agent.create({ ...input, title: book.get(id)!.title });
          book.set(id, 'sending', undefined, created.id);
          if (created.started && !agent.observe) book.set(id, 'uncertain', '已发送，无法跟踪原生会话');
          else runs.start(engine, created.id, input, { observe: !!created.started, at });
        }
      }
    } catch (err) {
      const code = (err as { status?: number })?.status;
      book.set(
        id,
        code && code >= 400 && code < 500 ? 'failed' : 'uncertain',
        err instanceof Error ? err.message : '无法确认发送结果',
      );
    }
    return res.status(202).json(book.get(id));
  });
  async function once<T>(id: string | undefined, scope: unknown[], operation: () => T | Promise<T>): Promise<T> {
    if (!id) return operation();
    const hash = digest(JSON.stringify(scope));
    const created = book.db.prepare('INSERT OR IGNORE INTO workbench_requests(id,fingerprint) VALUES(?,?)').run(id, hash);
    if (!created.changes) {
      const previous = book.db.prepare('SELECT fingerprint,response FROM workbench_requests WHERE id=?').get(id);
      if (previous?.fingerprint !== hash) throw invalid('此任务编号已存在');
      if (typeof previous.response === 'string' && previous.response) {
        const saved = JSON.parse(previous.response) as { value: T; failure?: { message: string; status: number } };
        if (saved.failure) throw Object.assign(new Error(saved.failure.message), { status: saved.failure.status });
        return saved.value;
      }
      throw Object.assign(new Error('上次送达尚未确认，请核对总览或原会话，不要重复发送'), { status: 425 });
    }
    try {
      const response = await operation();
      book.db.prepare('UPDATE workbench_requests SET response=? WHERE id=?').run(JSON.stringify({ value: response }), id);
      return response;
    } catch (error) {
      const status = statusOf(error);
      if (book.get(id)?.state === 'sending') book.set(id, status < 500 ? 'rejected' : 'uncertain', error instanceof Error ? error.message : undefined);
      if (status < 500) book.db.prepare('UPDATE workbench_requests SET response=? WHERE id=?')
        .run(JSON.stringify({ failure: { status, message: error instanceof Error ? error.message : '任务未发送' } }), id);
      throw error;
    }
  }
  return { book, once, close: () => {
    closed = true;
    off();
    book.db.close();
  } };
}
