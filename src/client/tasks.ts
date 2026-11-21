import './tasks.css';
import { createIcons, Plus, X, RefreshCw, Send } from 'lucide';
import type { UnifiedSession, Project, Usage, UsageWindow } from '../shared/contract';

type Task = {
  id: string;
  title: string;
  engine: string;
  project: string;
  session: string;
  turn: string;
  preview: string;
  state: string;
  updated: string;
  result?: string;
};
type MeasuredUsage = Usage & { checkedAt: number };
type QuotaItem = { id: string; label: string; enabled: boolean; usage?: MeasuredUsage };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sel = (id: string) => el<HTMLSelectElement>(id);
const eng = sel('engine'),
  project = el<HTMLInputElement>('project'),
  session = sel('session'),
  compose = el<HTMLDialogElement>('compose'),
  detail = el<HTMLDialogElement>('detail');
const names: Record<string, string> = { grok: 'Grok Bot' };
const canCreate = new Map<string, boolean>();
const grokOnly = new URLSearchParams(location.search).get('agent') === 'grok';
const states: Record<string, string> = {
  sending: '正在提交',
  queued: '排队中',
  running: '执行中',
  waiting: '等待确认',
  completed: '已完成',
  uncertain: '待核对',
  accepted: '已受理 · 等回传',
  failed: '失败',
  interrupted: '已停止',
};
const kind = (s: string) =>
  ['running', 'sending', 'queued'].includes(s)
    ? 'busy'
    : ['uncertain', 'failed', 'waiting'].includes(s)
      ? 'attention'
      : s;
let rows: Task[] = [],
  sessions: UnifiedSession[] = [],
  projects: Project[] = [],
  selected = '',
  ready = false,
  readSeq = 0,
  receipt = '',
  locked = false;
let quotas: QuotaItem[] = [], quotaLoading = false, activeQuota = '';
const fullReplies = new Map<string, { updated: string; text: string }>();
const short = (p: string) => p.split('/').filter(Boolean).at(-1) || p || '默认项目';
function node(tag: string, text: string, cl = '') {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = cl;
  return n;
}
function notice(id: string, text = '') {
  const p = el(id);
  p.textContent = text;
  p.hidden = !text;
}
async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(
    url,
    body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  const v = await r.json();
  if (!r.ok) throw Error(v.error || String(r.status));
  return v;
}
function show(t: Task) {
  selected = t.id;
  const dl = el('detail-fields');
  dl.replaceChildren();
  for (const [k, v] of [
    ['任务', t.title],
    ['Agent', names[t.engine] || t.engine],
    ['状态', states[t.state]],
    ['项目', t.project],
    ['最新回复 / 回执', fullReplies.get(t.id)?.updated === t.updated ? fullReplies.get(t.id)?.text : t.preview],
    ['派单编号', t.id],
    ['原会话', t.session],
    ['轮次', t.turn],
  ])
    if (v) {
      const value = node('dd', v);
      if (k === '最新回复 / 回执') value.id = 'task-reply';
      dl.append(node('dt', k!), value);
    }
  const a = el<HTMLAnchorElement>('chat');
  a.hidden = !t.session || t.engine === 'grok';
  a.href = '/#' + encodeURIComponent(t.engine) + '/' + encodeURIComponent(t.session);
  if (!detail.open) detail.showModal();
  if (t.engine === 'grok' && ['completed', 'failed', 'waiting'].includes(t.state)
      && fullReplies.get(t.id)?.updated !== t.updated) {
    void api<Task>('/api/tasks/' + encodeURIComponent(t.id)).then(result => {
      if (result.updated !== t.updated) return;
      const text = result.result || t.preview;
      fullReplies.set(t.id, { updated: t.updated, text });
      const reply = document.getElementById('task-reply');
      if (detail.open && selected === t.id && rows.find(v => v.id === t.id)?.updated === t.updated && reply)
        reply.textContent = text;
    }).catch(() => {});
  }
}
function render() {
  const filter = sel('filter').value;
  const scoped = grokOnly ? rows.filter(t => t.engine === 'grok') : rows;
  for (const [id, n] of [
    ['total', scoped.length],
    ['busy', scoped.filter((t) => kind(t.state) === 'busy').length],
    ['attention', scoped.filter((t) => kind(t.state) === 'attention').length],
    ['done', scoped.filter((t) => t.state === 'completed').length],
  ])
    el(String(id)).textContent = String(n);
  const root = el('rows');
  root.replaceChildren();
  for (const t of scoped.filter((v) => filter === 'all' || kind(v.state) === filter)) {
    const r = node('div', '', 'row'),
      first = node('div', ''),
      second = node('div', ''),
      title = node('button', t.title, 'title');
    title.onclick = () => show(t);
    first.append(title, node('small', t.preview || '编号 ' + t.id.slice(0, 8), 'cut'));
    second.append(
      node('span', names[t.engine] || t.engine),
      node('small', t.engine === 'grok' ? 'Routine' : short(t.project), 'cut'),
    );
    const badge = node('span', states[t.state] || t.state, 'badge');
    badge.dataset.kind = kind(t.state);
    const time = node(
      'time',
      new Date(t.updated).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    r.append(first, second, badge, time);
    root.append(r);
  }
  if (!root.children.length) root.append(node('p', scoped.length ? '没有匹配的任务' : '还没有派单记录', 'empty'));
  if (detail.open) {
    const t = rows.find((v) => v.id === selected);
    if (t) show(t);
  }
}
async function refresh() {
  try {
    const data = await api<Task[]>('/api/tasks');
    if (JSON.stringify(data) !== JSON.stringify(rows) || !el('rows').children.length) {
      rows = data;
      render();
    }
    if (rows.some(t => t.engine === 'grok' && ['accepted', 'uncertain', 'waiting'].includes(t.state))) {
      void api<{ reason?: string }>('/api/grok/sync')
        .then(sync => notice('grok-sync', sync.reason ? 'Grok 回传：' + sync.reason : ''))
        .catch(() => {});
    } else notice('grok-sync');
    notice('error');
  } catch {
    notice('error', '无法连接本机控制台，未重新发送任务。');
  }
}
function quotaName(w: UsageWindow) {
  if (w.label) return w.label;
  if (w.windowMinutes === 300) return '5 小时';
  if (w.windowMinutes === 10080) return '7 天';
  return w.windowMinutes ? w.windowMinutes + ' 分钟' : w.id;
}
const pct = (n: number) => (n > 0 && n < 0.1 ? '<0.1' : n.toLocaleString('zh-CN', { maximumFractionDigits: 1 })) + '%';
const timeOfQuota = (ms: number) => new Date(ms).toLocaleString('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
function quotaDetails(id: string) {
  const provider = quotas.find(q => q.id === id);
  if (!provider) return;
  activeQuota = id;
  el('quota-title').textContent = provider.label + ' 额度';
  const fields = el('quota-fields');
  fields.replaceChildren();
  const windows = provider.usage?.windows ?? [];
  if (!provider.enabled || !windows.length) fields.append(node('dd', provider.enabled ? provider.usage?.reason || '未返回额度' : '当前未启用'));
  for (const w of windows) {
    fields.append(node('dt', quotaName(w)), node('dd', w.remainingPercent == null ? '剩余未知' : '剩余 ' + pct(w.remainingPercent)));
    const reset = w.resetsAt ? '重置：' + timeOfQuota(w.resetsAt * 1000) : w.resetLabel;
    if (reset) fields.append(node('small', reset));
  }
  el('quota-source').textContent = provider.usage?.checkedAt
    ? '读取时间：' + timeOfQuota(provider.usage.checkedAt) : '';
  if (!el<HTMLDialogElement>('quota-dialog').open) el<HTMLDialogElement>('quota-dialog').showModal();
}
function renderUsage() {
  const grid = el('usage-grid');
  grid.replaceChildren();
  for (const q of quotas) {
    const entry = node('button', '', 'usage-entry');
    const windows = (q.usage?.windows ?? []).filter(w => w.remainingPercent != null);
    const amounts = windows.map(w => w.remainingPercent!);
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    const summary = !q.enabled ? '未启用' : !windows.length ? '未读取'
      : windows.length > 3 ? '剩余 ' + pct(min) + (min === max ? '' : '–' + pct(max))
      : windows.map(w => quotaName(w) + ' 剩 ' + pct(w.remainingPercent!)).join(' · ');
    entry.dataset.low = String(min < 10);
    entry.append(node('strong', q.label), node('span', summary));
    if (q.usage?.checkedAt) entry.append(node('small', timeOfQuota(q.usage.checkedAt) + ' 更新'));
    entry.onclick = () => quotaDetails(q.id);
    grid.append(entry);
  }
  if (el<HTMLDialogElement>('quota-dialog').open) quotaDetails(activeQuota);
}
async function refreshUsage(manual = false) {
  if (quotaLoading) return;
  quotaLoading = true;
  const button = el<HTMLButtonElement>('usage-refresh');
  button.disabled = true;
  let readError = '';
  try {
    const [all, grok] = await Promise.all([
      api<{ engines: QuotaItem[]; grok?: MeasuredUsage }>('/api/tasks/usage/all'),
      manual ? api<MeasuredUsage>('/api/grok/usage', {}).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    quotas = [...all.engines, { id: 'grok', label: 'Grok Bot', enabled: true, usage: grok ?? all.grok }];
    renderUsage();
    if (manual) readError = grok?.reason || (!grok ? '未能刷新 Grok 额度' : '');
  } catch {
    readError = '暂时无法读取额度';
  } finally {
    notice('usage-error', readError);
    quotaLoading = false;
    button.disabled = false;
  }
}
function choices() {
  const current = project.value;
  session.replaceChildren();
  if (canCreate.get(eng.value)) session.add(new Option('新建独立会话', ''));
  for (const s of sessions.filter(
    (s) =>
      (!current || s.cwd === current) &&
      !s.sendBlocked &&
      s.metadata?.space !== 'chatgpt' &&
      s.metadata?.space !== 'chat',
  ))
    session.add(new Option(s.title || s.id, s.id));
  if (ready) el<HTMLButtonElement>('send').disabled = !session.options.length;
}
async function targets() {
  const seq = ++readSeq,
    e = eng.value,
    g = e === 'grok';
  ready = false;
  notice('compose-error');
  el<HTMLButtonElement>('send').disabled = true;
  for (const id of ['project-label', 'session-label']) el(id).hidden = g;
  el('grok-note').hidden = !g;
  try {
    if (g) {
      const { configured } = await api<{ configured: boolean }>('/api/grok/available');
      if (seq !== readSeq) return;
      if (!configured)
        throw Error(
          '尚未连接指定 Routine。请按安装说明配置自己的 Routine，再重新打开派单。',
        );
    } else {
      const data = await api<Record<string, UnifiedSession[]>>('/api/sessions?engine=' + encodeURIComponent(e));
      if (seq !== readSeq) return;
      if (!Array.isArray(data[e])) throw Error('读取会话失败，请检查桌面应用。');
      sessions = data[e]!;
      const all = new Set(
        [...projects.filter((p) => !p.space).map((p) => p.cwd), ...sessions.map((s) => s.cwd || '')].filter(
          Boolean,
        ),
      );
      project.value = '';
      el('projects').replaceChildren(...Array.from(all, (p) => new Option(p, p)));
      choices();
    }
    ready = true;
    el<HTMLButtonElement>('send').disabled = !g && !session.options.length;
  } catch (e) {
    if (seq === readSeq) notice('compose-error', String(e));
  }
}
async function populate() {
  if (grokOnly) {
    eng.replaceChildren(new Option('Grok Bot · Routine', 'grok'));
    eng.disabled = false;
    return targets();
  }
  const m = await api<{ engines: { id: string; label: string; capabilities: { send?: boolean; create?: boolean; sendBlocked?: string } }[] }>('/api/engines');
  canCreate.clear();
  eng.replaceChildren();
  for (const e of m.engines) {
    if (e.id === 'grok' || e.capabilities.send === false || e.capabilities.sendBlocked) continue;
    names[e.id] = e.label;
    canCreate.set(e.id, e.capabilities.create !== false);
    eng.add(new Option(e.label, e.id));
  }
  eng.add(new Option('Grok Bot · Routine', 'grok'));
  const map = await api<Record<string, Project[]>>('/api/projects');
  const load = () => {
    projects = map[eng.value] || [];
    void targets();
  };
  eng.onchange = load;
  eng.disabled = false;
  load();
  render();
}
el('new').onclick = () => {
  if (!locked) {
    compose.showModal();
    ready = false;
    eng.disabled = true;
    notice('compose-error');
    el<HTMLButtonElement>('send').disabled = true;
    void populate().catch((e) => notice('compose-error', String(e)));
  }
};
el('close').onclick = () => {
  if (!locked) compose.close();
};
el('detail-close').onclick = () => detail.close();
el('quota-close').onclick = () => el<HTMLDialogElement>('quota-dialog').close();
el('usage-refresh').onclick = () => { void refreshUsage(true); };
compose.oncancel = (e) => {
  if (locked) e.preventDefault();
};
project.oninput = choices;
sel('filter').onchange = render;
el('refresh').onclick = () => {
  void refresh();
};
el<HTMLFormElement>('dispatch').onsubmit = async (event) => {
  event.preventDefault();
  if (!ready || locked || (eng.value !== 'grok' && !session.options.length)) return;
  const prompt = el<HTMLTextAreaElement>('prompt').value.trim();
  if (!prompt) return;
  const g = eng.value === 'grok',
    s = g ? '' : session.value;
  const payload = {
    engine: eng.value,
    prompt,
    session: s,
    project: g
      ? ''
      : s
        ? sessions.find((item) => item.id === s)?.cwd ||
          rows.find((item) => item.engine === eng.value && item.session === s)?.project ||
          ''
        : project.value.trim(),
  };
  const signature = JSON.stringify(payload);
  let previous: { signature: string; id: string } | null = null;
  try {
    previous = JSON.parse(sessionStorage.getItem('acc-pending') || 'null');
  } catch {}
  // Keep only the request digest in the tab, never the prompt or credentials.
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature))),
  ).join('.');
  if (locked) return;
  locked = true;
  const button = el<HTMLButtonElement>('send');
  button.disabled = true;
  receipt = previous?.signature === digest ? previous.id : crypto.randomUUID();
  try {
    sessionStorage.setItem('acc-pending', JSON.stringify({ signature: digest, id: receipt }));
    const task = await api<Task>('/api/tasks', { id: receipt, ...payload });
    sessionStorage.removeItem('acc-pending');
    el<HTMLTextAreaElement>('prompt').value = '';
    compose.close();
    await refresh();
    show(rows.find((t) => t.id === task.id) || task);
  } catch {
    notice('compose-error', '没有收到派单回执。请先核对任务表；原内容重试沿用同一编号。');
  } finally {
    locked = false;
    button.disabled = !ready;
  }
};
createIcons({ icons: { Plus, X, RefreshCw, Send } });
if (grokOnly) {
  el('nav-all').removeAttribute('aria-current');
  el('nav-grok').setAttribute('aria-current', 'page');
  el('board-title').textContent = names.grok!;
  document.title = 'Grok Bot · Agent Control Center';
}
void refresh();
void refreshUsage();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 2200);
setInterval(() => {
  if (!document.hidden) void refreshUsage();
}, 60_000);
