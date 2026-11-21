import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Express } from 'express';
import type { BridgeEvent } from '../../shared/contract.js';
import type { PluginHost } from '../core/plugin-host.js';
import type { EventHub } from '../core/event-hub.js';
import type { RunService } from '../core/run-service.js';
import { presentHistory } from '../core/presentation.js';
import { promptKey } from '../../shared/turn-match.js';
import { grokDispatch, grokConfigured } from './grok-routine.js';
import { receiptPrompt, type GrokReader, type GrokReceipt } from './grok-desktop.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const marker = (id: string) => 'ACC/' + id + ':';
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
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
};

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
    if (!this.db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'result'))
      this.db.exec("ALTER TABLE tasks ADD COLUMN result TEXT NOT NULL DEFAULT ''");
  }
  get(id: string) {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined;
  }
  list() {
    return this.db.prepare('SELECT id,engine,session,project,title,state,turn,preview,created,updated FROM tasks ORDER BY created DESC').all() as Task[];
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
  applyGrokReceipt(receipt: GrokReceipt) {
    const text = receipt.text.slice(0, 12000);
    this.db.prepare(`UPDATE tasks SET state=?,preview=?,result=?,updated=?
      WHERE id=? AND engine='grok' AND state IN ('accepted','uncertain','waiting') AND (state!=? OR result!=?)`)
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
        .prepare("SELECT id FROM tasks WHERE engine=? AND session=? AND state='queued'")
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
      const id = /^ACC\/([\da-f-]{36}):/i.exec(e.data.turn.userPrompt ?? '')?.[1];
      const t = id && book.get(id);
      if (t && t.engine === e.engine && t.session === e.sessionId && ['sending', 'queued'].includes(t.state))
        book.set(t.id, 'running', undefined, e.sessionId, e.turnId ?? undefined);
      return;
    }
    if (!e.turnId) return;
    const t = book.db
      .prepare('SELECT id,state FROM tasks WHERE engine=? AND session=? AND turn=?')
      .get(e.engine, e.sessionId, e.turnId);
    if (!t) return;
    const id = String(t.id);
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
  // Recovery only reads an exact marked turn. It never replays a send after a restart.
  let lastRecovery = 0,
    recovering = false;
  async function recover() {
    if (recovering || Date.now() - lastRecovery < 10000) return;
    lastRecovery = Date.now();
    recovering = true;
    try {
      const rows = book.db
        .prepare(
          "SELECT * FROM tasks WHERE state IN ('uncertain','accepted') AND session!='' AND engine!='grok' ORDER BY updated DESC LIMIT 48",
        )
        .all() as Task[];
      for (const t of rows) {
        if (closed) break;
        try {
          const engine = host.get(t.engine);
          const h = presentHistory(await engine.read(t.session));
          const turn = h.turns.find((v) => promptKey(v.userPrompt).startsWith(marker(t.id)));
          if (!turn) continue;
          const end = turn.statusEvidence && turn.completedAt ? turn.status : await engine.confirmTurnEnd?.(t.session,turn.id);
          if (!closed && end && ['completed', 'failed', 'interrupted'].includes(end) && ['uncertain', 'accepted'].includes(book.get(t.id)?.state ?? ''))
            book.set(
              t.id,
              end,
              turn.messages.filter((m) => m.phase !== 'analysis').at(-1)?.text,
              t.session,
              turn.id,
            );
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
      WHERE engine='grok' AND state IN ('accepted','uncertain','waiting') ORDER BY updated DESC LIMIT 48`)
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
  return () => {
    closed = true;
    off();
    book.db.close();
  };
}
