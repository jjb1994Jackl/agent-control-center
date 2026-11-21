import './tasks.css';
import { createIcons, X, RefreshCw } from 'lucide';
import type { Usage, UsageWindow } from '../shared/contract';

type Task = { id: string; title: string; engine: string; project: string; session: string; session_name: string; source: string;
  preview: string; state: string; updated: string; result?: string };
type MeasuredUsage = Usage & { checkedAt: number };
type Quota = { id: string; label: string; enabled: boolean; usage?: MeasuredUsage };
type Filter = 'attention' | 'busy' | 'completed' | '';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const detail = el<HTMLDialogElement>('detail'), quotaDialog = el<HTMLDialogElement>('quota-dialog');
const filters = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-filter]'));
const names = new Map([['grok','Grok Bot'],['codex','Codex'],['claude','Claude'],['antigravity','Antigravity']]);
const stateNames: Record<string, string> = {
  sending:'正在提交', queued:'排队中', running:'进行中', waiting:'等待审批', completed:'已完成', uncertain:'送达待核对',
  accepted:'已受理，等回传', delivered:'已送达，等反馈', replied:'已回复', rejected:'派单失败', failed:'失败', interrupted:'已停止',
};
function kind(state: string): Filter {
  if (['waiting','failed','rejected','uncertain'].includes(state)) return 'attention';
  if (['sending','queued','running','accepted','delivered'].includes(state)) return 'busy';
  return state === 'completed' ? 'completed' : '';
}
const byPriority = (t: Task) => kind(t.state) === 'attention' ? 0 : kind(t.state) === 'busy' ? 1 : 2;
const time = (value: string | number) => new Date(value).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
const pct = (n: number) => (n > 0 && n < 0.1 ? '<0.1' : n.toLocaleString('zh-CN', { maximumFractionDigits:1 })) + '%';
const quotaName = (w: UsageWindow) => w.label || (w.windowMinutes === 300 ? '5 小时' : w.windowMinutes === 10080 ? '7 天' : w.windowMinutes ? w.windowMinutes + ' 分钟' : w.id);
const remaining = (w: UsageWindow) => w.remainingPercent == null ? '未获取' : '剩 ' + pct(w.remainingPercent);
const isRoutine = (t: Task) => t.engine === 'grok' && t.source !== 'workbench' && !t.session;
const agentOf = (t: Task) => names.get(t.engine) || t.engine;
const sessionOf = (t: Task) => t.session_name || (isRoutine(t) ? 'Routine · 历史记录' : t.project.split(/[/\\]/).filter(Boolean).at(-1) || (t.session ? '原会话' : '未关联会话'));
let rows: Task[] = [], quotas: Quota[] = [], filter: Filter = '', picked = '', pickedQuota = '', reading = false, readingQuotas = false;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, css = '') {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = css;
  return n;
}
function notice(id: string, text = '') { const p = el(id); p.textContent = text; p.hidden = !text; }
async function api<T>(url: string, post = false): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', method: post ? 'POST' : 'GET' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
function viewReceipt(t: Task) {
  picked = t.id;
  const fields = el('detail-fields'), response = node('dd', t.preview || '尚无回执');
  response.className = 'task-reply';
  fields.replaceChildren(node('dt', '任务'), node('dd', t.title), node('dt', '状态'),
    node('dd', stateNames[t.state] || t.state), node('dt', '回执'), response);
  if (!detail.open) detail.showModal();
  if (isRoutine(t)) void api<Task>('/api/tasks/' + encodeURIComponent(t.id)).then(value => {
    if (detail.open && picked === t.id && value.updated === t.updated && response.isConnected) response.textContent = value.result || value.preview || '尚无回执';
  }).catch(() => {});
}
function renderRows() {
  const root = el('rows');
  const focus = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.task : '';
  el('attention').textContent = String(rows.filter(t => kind(t.state) === 'attention').length);
  el('busy').textContent = String(rows.filter(t => kind(t.state) === 'busy').length);
  el('done').textContent = String(rows.filter(t => t.state === 'completed').length);
  root.replaceChildren();
  for (const t of rows.filter(t => !filter || kind(t.state) === filter).sort((a,b) => byPriority(a) - byPriority(b) || b.updated.localeCompare(a.updated))) {
    const row = node('div','','row'), first = node('div',''), target = node('div','');
    const title = t.session ? node('a',t.title,'title') : node('button',t.title,'title');
    if (title instanceof HTMLAnchorElement) title.href = '/#' + encodeURIComponent(t.engine) + '/' + encodeURIComponent(t.session);
    else title.onclick = () => viewReceipt(t);
    title.dataset.task = t.id;
    first.append(title, node('small',t.preview || '\u00a0','cut'));
    target.append(node('span',agentOf(t)),node('small',sessionOf(t),'cut'));
    const badge = node('span',stateNames[t.state] || t.state,'badge');
    badge.dataset.kind = kind(t.state) || t.state;
    const when = node('time',time(t.updated));
    when.dateTime = t.updated;
    row.append(first,target,badge,when); root.append(row);
    if (focus === t.id) title.focus({ preventScroll: true });
  }
  if (!root.children.length) root.append(node('p', rows.length ? '没有符合此状态的任务' : '还没有派单记录', 'empty'));
  if (detail.open) { const selected = rows.find(t => t.id === picked); if (selected) viewReceipt(selected); }
}
async function refresh() {
  if (reading) return;
  reading = true;
  try {
    const next = await api<Task[]>('/api/tasks');
    if (JSON.stringify(next) !== JSON.stringify(rows) || !el('rows').children.length) { rows = next; renderRows(); }
    if (rows.some(t => isRoutine(t) && ['accepted','uncertain','waiting'].includes(t.state))) {
      void api<{ reason?: string }>('/api/grok/sync').then(v => notice('grok-sync', v.reason ? '历史 Routine 回执：' + v.reason : '')).catch(() => {});
    } else notice('grok-sync');
    notice('error');
  } catch { notice('error','暂时无法读取任务，显示上次记录。'); }
  finally { reading = false; }
}
function showQuota(id: string) {
  const q = quotas.find(q => q.id === id);
  if (!q) { if (quotaDialog.open) quotaDialog.close(); return; }
  pickedQuota = id;
  el('quota-title').textContent = q.label + ' 额度';
  const fields = el('quota-fields');
  fields.replaceChildren();
  const windows = q.usage?.windows ?? [];
  if (!windows.length) fields.append(node('dd', q.usage?.reason || '未获取额度'));
  for (const w of windows) {
    const reset = w.resetsAt ? '重置：' + time(w.resetsAt * 1000) : w.resetLabel;
    fields.append(node('dt',quotaName(w)), node('dd',remaining(w) + (reset ? ' · ' + reset : '')));
  }
  el('quota-source').textContent = q.usage?.checkedAt ? '读取时间：' + time(q.usage.checkedAt) : '';
  if (!quotaDialog.open) quotaDialog.showModal();
}
function renderQuota() {
  const strip = el('usage-grid');
  strip.replaceChildren();
  for (const q of quotas) {
    const button = node('button','','usage-entry');
    const windows = q.usage?.windows || [];
    button.append(node('strong',q.label),node('span',windows.length ? windows.slice(0,2).map(w => quotaName(w) + ' ' + remaining(w)).join(' · ') + (windows.length > 2 ? ' · +' + (windows.length - 2) : '') : '未获取'));
    button.onclick = () => showQuota(q.id); strip.append(button);
  }
  if (!strip.children.length) strip.append(node('p','没有已启用的 Agent','muted'));
  if (quotaDialog.open) showQuota(pickedQuota);
}
async function refreshQuota(manual = false) {
  if (readingQuotas) return;
  readingQuotas = true;
  const button = el<HTMLButtonElement>('usage-refresh');
  button.disabled = true;
  try {
    const data = await api<{ engines: Quota[]; grokEnabled: boolean; grok?: MeasuredUsage }>('/api/tasks/usage/all');
    for (const q of data.engines) names.set(q.id,q.label);
    quotas = data.engines.filter(q => q.enabled);
    if (data.grokEnabled) {
      const fresh = manual ? await api<MeasuredUsage>('/api/grok/usage', true).catch(() => undefined) : undefined;
      quotas.push({ id:'grok', label:'Grok Bot', enabled:true, usage:fresh || data.grok });
    }
    renderQuota();
    if (rows.length) renderRows();
    notice('usage-error');
  } catch { notice('usage-error','暂时无法读取额度。'); }
  finally { readingQuotas = false; button.disabled = false; }
}

for (const button of filters) button.onclick = () => {
  const next = button.dataset.filter as Filter;
  filter = filter === next ? '' : next;
  for (const b of filters) b.setAttribute('aria-pressed',String(b.dataset.filter === filter));
  renderRows();
};
el('refresh').onclick = () => { void refresh(); };
el('detail-close').onclick = () => detail.close();
el('quota-close').onclick = () => quotaDialog.close();
el('usage-refresh').onclick = () => { void refreshQuota(true); };
if (new URLSearchParams(location.search).get('agent') === 'grok') history.replaceState(null,'','/tasks.html');
createIcons({ icons: { X, RefreshCw } });
void refresh(); void refreshQuota();
window.addEventListener('focus', () => { void refresh(); void refreshQuota(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 2200);
setInterval(() => { if (!document.hidden) void refreshQuota(); }, 60000);
