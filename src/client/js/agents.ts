// The agents the console can connect, each with a switch: on, its plugin is set up on the server
// and it joins the rail; off, it leaves the rail and nothing of it runs. The same rows are drawn
// wherever agents are managed (the rail's "+" dialog, settings, and the page shown while no agent
// is on), so this file only writes the rows; app.ts owns the state and the requests. In settings
// the rows can also be edited (the console's own name for an agent, its idle and working faces as
// pictures of the person's own) and dragged into the rail's order.
import { t, say } from './i18n.js';
import type { AgentBusy, AgentEntry, EngineStatus } from '../../shared/contract.js';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ENTITIES[char] ?? char);

/** What the page knows about the switches beyond the server's list. */
export interface AgentsView {
  /** Agents being switched right now: id → the state they are going to. */
  pending: Map<string, boolean>;
  /** A switch-off the server held back because the console still holds work for the agent. */
  ask: { id: string; busy: AgentBusy } | null;
  /** Why the last switch of an agent failed (shown until it is tried again). */
  errors: Map<string, string>;
  /** The agent whose name and faces are open for editing (settings only). */
  editing: string | null;
  /** Edits on their way: agent id → what (a slot, 'label', 'order'). */
  saving: Map<string, string>;
  /** Why the last edit of an agent did not take. */
  editErrors: Map<string, string>;
}
export const newAgentsView = (): AgentsView => ({ pending: new Map(), ask: null, errors: new Map(), editing: null, saving: new Map(), editErrors: new Map() });

export interface AgentRowOptions {
  view: AgentsView;
  /** Each engine's reachability as last read (only agents that are on have one). */
  statuses: Record<string, EngineStatus | undefined>;
  /** The agent's face (its character or icon), as it looks idle, or working. */
  face: (entry: AgentEntry, working?: boolean) => string;
  /** Settings: each row has its edit button and drag handle. */
  editable?: boolean;
  /** An icon by its name (the page's lucide icons). */
  icon?: (name: string) => string;
}
/** The picture types a face can be (the server checks the bytes again). */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** The editor under a row: the name, the two faces, the order. */
function editor(entry: AgentEntry, index: number, count: number, options: AgentRowOptions): string {
  const { view, face } = options, id = escape(entry.id), saving = view.saving.get(entry.id), custom = entry.custom || {};
  const original = entry.defaultLabel || entry.label, error = view.editErrors.get(entry.id);
  const slot = (key: 'idle' | 'working', title: string) => {
    const own = !!custom[key], busy = saving === key;
    return `<div class="agent-slot${busy ? ' is-saving' : ''}">
      <span class="agent-slot-face">${face(entry, key === 'working')}</span>
      <span class="agent-slot-text"><span class="agent-slot-title">${escape(title)}</span><span class="agent-slot-note">${busy ? t('正在保存…') : own ? t('自己的图片') : t('默认形象')}</span></span>
      <span class="agent-slot-actions">
        <label class="secondary-button agent-upload">${own ? t('更换') : t('上传')}<input type="file" accept="${AVATAR_TYPES.join(',')}" data-agent-upload="${id}" data-slot="${key}" aria-label="${escape(t('上传 {name} {state}时的头像', { name: entry.label, state: title }))}"></label>
        ${own ? `<button type="button" class="text-button" data-agent-reset="${id}" data-slot="${key}">${t('恢复默认')}</button>` : ''}
      </span>
    </div>`;
  };
  return `<div class="agent-editor" data-agent-editor="${id}">
    <label class="agent-field"><span class="agent-field-title">${t('名称')}</span>
      <span class="agent-field-row"><input type="text" class="agent-label-input" data-agent-label="${id}" value="${escape(custom.label || '')}" placeholder="${escape(original)}" maxlength="40" autocomplete="off" spellcheck="false">${custom.label ? `<button type="button" class="text-button" data-agent-label-reset="${id}">${t('恢复默认')}</button>` : ''}</span></label>
    <div class="agent-field"><span class="agent-field-title">${t('头像图片')}</span><div class="agent-slots">${slot('idle', t('空闲'))}${slot('working', t('工作中'))}</div>
      <p class="field-help">${t('PNG、JPEG、GIF、WebP，最大 2 MB。静态图会居中裁成正方形；想让工作中的头像动起来，可以传 GIF。只传空闲图时，工作中也用它，外圈照常转。')}</p></div>
    <div class="agent-field"><span class="agent-field-title">${t('顺序')}</span><span class="agent-field-row">
      <button type="button" class="secondary-button" data-agent-move="${id}" data-step="-1"${index ? '' : ' disabled'}>${t('上移')}</button>
      <button type="button" class="secondary-button" data-agent-move="${id}" data-step="1"${index < count - 1 ? '' : ' disabled'}>${t('下移')}</button>
      <span class="agent-field-note">${t('也可以拖动左边的把手。Agent 栏和 ⌥ 数字键按这个顺序。')}</span></span></div>
    ${error ? `<p class="agent-edit-error" role="alert">${escape(say(error))}</p>` : ''}
  </div>`;
}

/** The line under an agent's name: where it stands, in the person's words. */
export function agentNote(entry: AgentEntry, { view, statuses }: Pick<AgentRowOptions, 'view' | 'statuses'>): { text: string; tone: 'on' | 'off' | 'warn' | 'busy' } {
  const going = view.pending.get(entry.id);
  if (going === true) return { text: t('正在接上它的桌面版…'), tone: 'busy' };
  if (going === false) return { text: t('正在移除…'), tone: 'busy' };
  const failed = view.errors.get(entry.id) || entry.error;
  if (failed && !entry.enabled) return { text: t('没能启用：{reason}', { reason: say(failed) }), tone: 'warn' };
  if (entry.enabled) {
    const status = statuses[entry.id];
    if (!status) return { text: t('已启用'), tone: 'on' };
    if (status.connected) return { text: t('已启用 · 桌面版已连接'), tone: 'on' };
    return { text: status.error ? t('已启用 · 桌面版没连上：{reason}', { reason: say(status.error) }) : t('已启用 · 桌面版没连上'), tone: 'warn' };
  }
  if (entry.installed === true) return { text: t('未启用 · 这台电脑上有它的桌面版'), tone: 'off' };
  if (entry.installed === false) return { text: t('未启用 · 这台电脑上没找到它的桌面版'), tone: 'off' };
  return { text: t('未启用'), tone: 'off' };
}

/** What switching off would drop, said plainly before it is done. */
export function busyText(name: string, busy: AgentBusy): string {
  return [
    busy.running ? t('工作台正跟着 {name} 的 {n} 轮任务，移除后它会在桌面版里继续跑，只是这里不再显示。', { name, n: busy.running }) : '',
    busy.queued ? t('还有 {n} 条消息排着队等发给 {name}，移除后它们不会发出。', { name, n: busy.queued }) : '',
  ].filter(Boolean).join(' ');
}

/** One row per agent: its face, its name, where it stands, and its switch. */
export function agentRows(agents: AgentEntry[], options: AgentRowOptions): string {
  const { view, face, editable, icon = () => '' } = options;
  if (!agents.length) return `<p class="agent-none">${t('这个工作台还没有集成任何 Agent')}</p>`;
  return `<div class="agent-list${editable ? ' is-editable' : ''}" role="list">${agents.map((entry, index) => {
    const going = view.pending.get(entry.id), on = going ?? entry.enabled, note = agentNote(entry, options);
    const ask = view.ask?.id === entry.id ? view.ask : null;
    // A switch on its way is marked busy, not disabled, so it keeps the keyboard; a second press does nothing (app.ts, toggleAgent).
    const where = entry.where ? ` title="${escape(entry.where)}"` : '';
    const editing = editable && view.editing === entry.id;
    // Settings: dragged by its handle into the rail's order; its pencil opens the editor below it.
    const grip = editable ? `<span class="agent-grip" draggable="true" data-agent-grip="${escape(entry.id)}" title="${escape(t('拖动调整顺序'))}" aria-hidden="true">${icon('grip-vertical')}</span>` : '';
    const edit = editable ? `<button type="button" class="icon-button agent-edit" data-agent-edit="${escape(entry.id)}" aria-expanded="${editing}" aria-label="${escape(t('编辑 {name} 的名称和头像', { name: entry.label }))}" title="${escape(t('编辑名称、头像和顺序'))}">${icon('pencil')}</button>` : '';
    const renamed = entry.defaultLabel ? `<span class="agent-original">${escape(entry.defaultLabel)}</span>` : '';
    return `<div class="agent-row${on ? ' is-on' : ''}${going !== undefined ? ' is-pending' : ''}${editing ? ' is-editing' : ''}" role="listitem" data-agent="${escape(entry.id)}" style="--hue:${escape(entry.accent || 'var(--accent)')}">
      ${grip}<span class="agent-face">${face(entry)}</span>
      <span class="agent-text"><span class="agent-name">${escape(entry.label)}${renamed}</span><span class="agent-note is-${note.tone}"${where}>${escape(note.text)}</span></span>
      ${edit}<button type="button" class="switch" role="switch" aria-checked="${on}" data-agent-toggle="${escape(entry.id)}" aria-label="${escape(t('启用 {name}', { name: entry.label }))}"${going !== undefined ? ' aria-busy="true"' : ''}><span class="switch-knob" aria-hidden="true"></span></button>
        ${editing ? editor(entry, index, agents.length, options) : ''}
      ${ask ? `<div class="agent-ask" role="alert"><p>${escape(busyText(entry.label, ask.busy))}</p><span class="agent-ask-actions"><button type="button" class="secondary-button" data-agent-cancel>${t('先留着')}</button><button type="button" class="secondary-button is-danger" data-agent-force="${escape(entry.id)}">${t('仍然移除')}</button></span></div>` : ''}
    </div>`;
  }).join('')}</div>`;
}
