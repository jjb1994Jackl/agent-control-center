import './tasks.css';
import { createIcons, X, RefreshCw } from 'lucide';
import type { Usage, UsageWindow } from '../shared/contract';

type Task = { id: string; title: string; engine: string; project: string; session: string; session_name: string; source: string;
  preview: string; state: string; updated: string; result?: string };
type MeasuredUsage = Usage & { checkedAt: number };
type Quota = { id: string; label: string; enabled: boolean; usage?: MeasuredUsage };
type Filter = 'attention' | 'busy' | 'replied' | 'done' | '';

const isEn = () => document.documentElement.lang === 'en';
const loc = () => (isEn() ? 'en-US' : 'zh-CN');
const copy = {
  zh: {
    pageTitle: '总览 · Agent Control Center', nav: '主要导航', overview: '总览', workbench: '工作台', heading: '任务总览',
    filterGroup: '按状态筛选', attention: '待处理', busy: '进行中', replied: '已回复', done: '已结束',
    usageHeading: 'Agent 额度', refreshUsage: '刷新额度', loadingUsage: '正在读取额度…',
    recordsHeading: '派单记录', refreshTasks: '刷新任务', colTask: '任务 / 最新回复', colAgent: 'Agent / 会话',
    colState: '状态', colUpdated: '最近更新', quotaTitle: '额度详情', detailTitle: '任务详情', close: '关闭',
    routineHistory: 'Routine · 历史记录', nativeChat: '原会话', noSession: '未关联会话', noReceipt: '尚无回执',
    fieldTask: '任务', fieldState: '状态', fieldReceipt: '回执', emptyFiltered: '没有符合此状态的任务', emptyAll: '还没有派单记录',
    syncPrefix: '历史 Routine 回执：', loadTasksError: '暂时无法读取任务，显示上次记录。',
    quotaSuffix: ' 额度', quotaMissing: '未获取额度', quotaUnavailable: '未获取', grokRefreshHint: '未获取 · 点刷新读取',
    resetPrefix: '重置：', readAtPrefix: '读取时间：', noEnabledAgents: '没有已启用的 Agent', loadUsageError: '暂时无法读取额度。',
    remPrefix: '剩 ', hours5: '5 小时', days7: '7 天', minutesSuffix: ' 分钟',
  },
  en: {
    pageTitle: 'Overview · Agent Control Center', nav: 'Main navigation', overview: 'Overview', workbench: 'Workbench', heading: 'Task Overview',
    filterGroup: 'Filter by status', attention: 'Needs attention', busy: 'In progress', replied: 'Replied', done: 'Finished',
    usageHeading: 'Agent Quota', refreshUsage: 'Refresh quota', loadingUsage: 'Loading quota…',
    recordsHeading: 'Dispatches', refreshTasks: 'Refresh tasks', colTask: 'Task / Latest reply', colAgent: 'Agent / Chat',
    colState: 'Status', colUpdated: 'Updated', quotaTitle: 'Quota Details', detailTitle: 'Task Details', close: 'Close',
    routineHistory: 'Routine · Legacy', nativeChat: 'Original chat', noSession: 'Unlinked chat', noReceipt: 'No receipt yet',
    fieldTask: 'Task', fieldState: 'Status', fieldReceipt: 'Receipt', emptyFiltered: 'No tasks match this filter', emptyAll: 'No dispatches yet',
    syncPrefix: 'Legacy Routine receipts: ', loadTasksError: 'Unable to load tasks right now. Showing last snapshot.',
    quotaSuffix: ' Quota', quotaMissing: 'Quota unavailable', quotaUnavailable: 'Unavailable', grokRefreshHint: 'Not read · click refresh',
    resetPrefix: 'Resets: ', readAtPrefix: 'Checked: ', noEnabledAgents: 'No enabled agents', loadUsageError: 'Unable to load quota right now.',
    remPrefix: '', hours5: '5h', days7: '7d', minutesSuffix: 'm',
  },
} as const;
const tr = <K extends keyof typeof copy.zh>(key: K): string => (isEn() ? copy.en[key] : copy.zh[key]);

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const detail = el<HTMLDialogElement>('detail'), quotaDialog = el<HTMLDialogElement>('quota-dialog');
const filters = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-filter]'));
const names = new Map([['grok', 'Grok Bot'], ['codex', 'Codex'], ['claude', 'Claude'], ['antigravity', 'Antigravity']]);
const stateLabels: Record<string, [string, string]> = {
  sending: ['正在提交', 'Submitting'], queued: ['排队中', 'Queued'], running: ['进行中', 'Running'],
  waiting: ['等待审批', 'Awaiting approval'], completed: ['已完成', 'Completed'], uncertain: ['送达待核对', 'Check delivery'],
  accepted: ['已受理，等回传', 'Accepted'], delivered: ['已送达，等反馈', 'Delivered'], replied: ['已回复', 'Replied'],
  rejected: ['派单失败', 'Dispatch failed'], failed: ['失败', 'Failed'], interrupted: ['已停止', 'Stopped'],
};
const stateName = (state: string) => {
  const pair = stateLabels[state];
  return pair ? (isEn() ? pair[1] : pair[0]) : state;
};
function kind(state: string): Filter {
  if (['waiting', 'failed', 'rejected', 'uncertain'].includes(state)) return 'attention';
  if (['sending', 'queued', 'running', 'accepted', 'delivered'].includes(state)) return 'busy';
  if (state === 'replied') return 'replied';
  return ['completed', 'interrupted'].includes(state) ? 'done' : '';
}
function badgeKind(state: string): string {
  if (state === 'completed') return 'completed';
  if (state === 'replied') return 'replied';
  return kind(state) === 'done' ? state : kind(state) || state;
}
const byPriority = (t: Task) => {
  const bucket = kind(t.state);
  return bucket === 'attention' ? 0 : bucket === 'busy' ? 1 : bucket === 'replied' ? 2 : 3;
};
const time = (value: string | number) => new Date(value).toLocaleString(loc(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const pct = (n: number) => (n > 0 && n < 0.1 ? '<0.1' : n.toLocaleString(loc(), { maximumFractionDigits: 1 })) + '%';
const quotaName = (w: UsageWindow) => {
  if (w.label) return isEn() && w.label === '每周用量' ? 'Weekly' : w.label;
  return w.windowMinutes === 300 ? tr('hours5') : w.windowMinutes === 10080 ? tr('days7') : w.windowMinutes ? w.windowMinutes + tr('minutesSuffix') : w.id;
};
const remaining = (w: UsageWindow) => w.remainingPercent == null ? tr('quotaUnavailable') : tr('remPrefix') + pct(w.remainingPercent) + (isEn() ? ' left' : '');
const isRoutine = (t: Task) => t.engine === 'grok' && t.source !== 'workbench' && !t.session;
const agentOf = (t: Task) => names.get(t.engine) || t.engine;
const sessionOf = (t: Task) => t.session_name || (isRoutine(t) ? tr('routineHistory') : t.project.split(/[/\\]/).filter(Boolean).at(-1) || (t.session ? tr('nativeChat') : tr('noSession')));
const taskStamp = (t: Task) => `${t.updated}|${t.state}|${t.preview}`;

let rows: Task[] = [], quotas: Quota[] = [], filter: Filter = '', picked = '', pickedStamp = '', pickedQuota = '', reading = false, readingQuotas = false;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, css = '') {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = css;
  return n;
}
function applyStaticI18n() {
  document.title = tr('pageTitle');
  for (const item of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = item.dataset.i18n as keyof typeof copy.zh;
    if (key in copy.zh) item.textContent = tr(key);
  }
  for (const item of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    const key = item.dataset.i18nAria as keyof typeof copy.zh;
    if (key in copy.zh) item.setAttribute('aria-label', tr(key));
  }
  for (const item of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = item.dataset.i18nTitle as keyof typeof copy.zh;
    if (key in copy.zh) { const text = tr(key); item.title = text; item.setAttribute('aria-label', text); }
  }
}
function notice(id: string, text = '') { const p = el(id); p.textContent = text; p.hidden = !text; }
async function api<T>(url: string, post = false): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', method: post ? 'POST' : 'GET' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
function viewReceipt(t: Task, force = false) {
  const stamp = taskStamp(t);
  if (!force && detail.open && picked === t.id && pickedStamp === stamp) return;
  picked = t.id;
  pickedStamp = stamp;
  const fields = el('detail-fields'), response = node('dd', t.preview || tr('noReceipt'));
  response.className = 'task-reply';
  fields.replaceChildren(node('dt', tr('fieldTask')), node('dd', t.title), node('dt', tr('fieldState')),
    node('dd', stateName(t.state)), node('dt', tr('fieldReceipt')), response);
  if (!detail.open) detail.showModal();
  if (isRoutine(t)) void api<Task>('/api/tasks/' + encodeURIComponent(t.id)).then(value => {
    if (detail.open && picked === t.id && value.updated === t.updated && response.isConnected) response.textContent = value.result || value.preview || tr('noReceipt');
  }).catch(() => {});
}
function renderRows() {
  const root = el('rows');
  const focus = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.task : '';
  el('attention').textContent = String(rows.filter(t => kind(t.state) === 'attention').length);
  el('busy').textContent = String(rows.filter(t => kind(t.state) === 'busy').length);
  el('replied').textContent = String(rows.filter(t => kind(t.state) === 'replied').length);
  el('done').textContent = String(rows.filter(t => kind(t.state) === 'done').length);
  root.replaceChildren();
  for (const t of rows.filter(t => !filter || kind(t.state) === filter).sort((a, b) => byPriority(a) - byPriority(b) || b.updated.localeCompare(a.updated))) {
    const row = node('div', '', 'row'), first = node('div', ''), target = node('div', '');
    const title = t.session ? node('a', t.title, 'title') : node('button', t.title, 'title');
    if (title instanceof HTMLAnchorElement) title.href = '/#' + encodeURIComponent(t.engine) + '/' + encodeURIComponent(t.session);
    else title.onclick = () => viewReceipt(t, true);
    title.dataset.task = t.id;
    first.append(title, node('small', t.preview || '\u00a0', 'cut'));
    target.append(node('span', agentOf(t)), node('small', sessionOf(t), 'cut'));
    const badge = node('span', stateName(t.state), 'badge');
    badge.dataset.kind = badgeKind(t.state);
    const when = node('time', time(t.updated));
    when.dateTime = t.updated;
    row.append(first, target, badge, when); root.append(row);
    if (focus === t.id) title.focus({ preventScroll: true });
  }
  if (!root.children.length) root.append(node('p', rows.length ? tr('emptyFiltered') : tr('emptyAll'), 'empty'));
  if (detail.open) { const selected = rows.find(t => t.id === picked); if (selected) viewReceipt(selected); }
}
async function refresh() {
  if (reading) return;
  reading = true;
  try {
    const next = await api<Task[]>('/api/tasks');
    if (JSON.stringify(next) !== JSON.stringify(rows) || !el('rows').children.length) { rows = next; renderRows(); }
    if (rows.some(t => isRoutine(t) && ['accepted', 'uncertain', 'waiting'].includes(t.state))) {
      void api<{ reason?: string }>('/api/grok/sync').then(v => notice('grok-sync', v.reason ? tr('syncPrefix') + v.reason : '')).catch(() => {});
    } else notice('grok-sync');
    notice('error');
  } catch { notice('error', tr('loadTasksError')); }
  finally { reading = false; }
}
function showQuota(id: string) {
  const q = quotas.find(q => q.id === id);
  if (!q) { if (quotaDialog.open) quotaDialog.close(); return; }
  pickedQuota = id;
  el('quota-title').textContent = q.label + tr('quotaSuffix');
  const fields = el('quota-fields');
  fields.replaceChildren();
  const windows = q.usage?.windows ?? [];
  if (!windows.length) fields.append(node('dd', q.usage?.reason || tr('quotaMissing')));
  for (const w of windows) {
    const reset = w.resetsAt ? tr('resetPrefix') + time(w.resetsAt * 1000) : w.resetLabel;
    fields.append(node('dt', quotaName(w)), node('dd', remaining(w) + (reset ? ' · ' + reset : '')));
  }
  el('quota-source').textContent = q.usage?.checkedAt ? tr('readAtPrefix') + time(q.usage.checkedAt) : '';
  if (!quotaDialog.open) quotaDialog.showModal();
}
function renderQuota() {
  const strip = el('usage-grid');
  strip.replaceChildren();
  for (const q of quotas) {
    const button = node('button', '', 'usage-entry');
    const windows = q.usage?.windows || [];
    const summary = node('span', '');
    if (windows.length) {
      windows.slice(0, 2).forEach((w, index) => {
        if (index > 0) summary.append(' · ');
        summary.append(node('span', quotaName(w) + ' ' + remaining(w), 'nowrap'));
      });
      if (windows.length > 2) summary.append(' · +' + (windows.length - 2));
    } else {
      summary.textContent = q.id === 'grok' ? tr('grokRefreshHint') : tr('quotaUnavailable');
    }
    button.append(node('strong', q.label), summary);
    button.onclick = () => showQuota(q.id); strip.append(button);
  }
  if (!strip.children.length) strip.append(node('p', tr('noEnabledAgents'), 'muted'));
  if (quotaDialog.open) showQuota(pickedQuota);
}
async function refreshQuota(manual = false) {
  if (readingQuotas) return;
  readingQuotas = true;
  const button = el<HTMLButtonElement>('usage-refresh');
  button.disabled = true;
  try {
    const data = await api<{ engines: Quota[]; grokEnabled: boolean; grok?: MeasuredUsage }>('/api/tasks/usage/all');
    for (const q of data.engines) names.set(q.id, q.label);
    quotas = data.engines.filter(q => q.enabled);
    if (data.grokEnabled) {
      const fresh = manual ? await api<MeasuredUsage>('/api/grok/usage', true).catch(() => undefined) : undefined;
      quotas.push({ id: 'grok', label: 'Grok Bot', enabled: true, usage: fresh || data.grok });
    }
    renderQuota();
    if (rows.length) renderRows();
    notice('usage-error');
  } catch { notice('usage-error', tr('loadUsageError')); }
  finally { readingQuotas = false; button.disabled = false; }
}

for (const dialog of [detail, quotaDialog]) {
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
}
for (const button of filters) button.onclick = () => {
  const next = button.dataset.filter as Filter;
  filter = filter === next ? '' : next;
  for (const b of filters) b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  renderRows();
};
el('refresh').onclick = () => { void refresh(); };
el('detail-close').onclick = () => detail.close();
el('quota-close').onclick = () => quotaDialog.close();
el('usage-refresh').onclick = () => { void refreshQuota(true); };
window.addEventListener('storage', event => {
  if (event.key === 'desktop-bridge:theme') {
    if (event.newValue === 'light' || event.newValue === 'dark') document.documentElement.dataset.theme = event.newValue;
    else delete document.documentElement.dataset.theme;
  }
  if (event.key === 'desktop-bridge:lang') {
    document.documentElement.lang = event.newValue === 'en' ? 'en' : 'zh-CN';
    applyStaticI18n(); renderQuota(); renderRows();
  }
});
if (new URLSearchParams(location.search).get('agent') === 'grok') history.replaceState(null, '', '/tasks.html');
applyStaticI18n();
createIcons({ icons: { X, RefreshCw } });
void refresh(); void refreshQuota();
window.addEventListener('focus', () => { void refresh(); void refreshQuota(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 2200);
setInterval(() => { if (!document.hidden) void refreshQuota(); }, 60000);
