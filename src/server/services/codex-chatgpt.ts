import fs from 'node:fs';
import path from 'node:path';
import { readSqlite } from './sqlite-reader.js';
import { bag, get, list, parseJson } from '../../shared/guards.js';

export interface ChatgptProject { id: string; name: string; cwd: string }
// A type alias (not an interface), so it is readable as a ChatMode chat (which allows more fields).
export type ChatgptConversation = { id: string; title: string; updatedAt: string; local: boolean };
export function codexPinnedThreads(value: unknown): string[] {
  const raw = bag(value) || {};
  const owner = Object.entries(raw).filter(([key, atoms]) => key.startsWith('electron-owner-atoms') && Array.isArray(get(atoms,'app-server-pinned-thread-order-v1')));
  const current = owner.length === 1 ? get(owner[0]?.[1], 'app-server-pinned-thread-order-v1') : undefined;
  return [...new Set(list(current ?? raw['pinned-thread-ids']).filter((id): id is string => typeof id === 'string' && !!id))];
}

// The Codex desktop app's "ChatGPT" mode, as its sidebar shows it, read-only from the app's own
// files under ~/.codex:
//   sqlite/codex.db  local_thread_catalog   every conversation the sidebar lists, local threads
//                                           (host "local") and ChatGPT ones (host "chatgpt:…"),
//                                           with title and recency: "Recents", newest first
//   .codex-global-state.json                the ChatGPT projects (chatgpt-sidebar-state-v2), the
//                                           Codex projects (local-projects) and the order the
//                                           mode lists both in (unified-sidebar-project-order-v1)
// Only those keys are read. The ChatGPT conversations' messages are not on disk in readable form.
class CodexChatgpt {
  db: string; stateFile: string; state: { stamp: string; value: { projects: ChatgptProject[]; pins: string[] } };
  constructor({ codexHome }: { codexHome: string }) {
    this.db = path.join(codexHome, 'sqlite', 'codex.db');
    this.stateFile = path.join(codexHome, '.codex-global-state.json');
    this.state = { stamp: '', value: { projects: [], pins: [] } };
  }
  // (A read that fails, while the desktop is writing the file, answers what the last one read:
  // the chats have not gone anywhere.)
  rows: Array<Record<string, unknown>> = [];
  catalog(): Array<Record<string, unknown>> {
    try {
      return this.rows = readSqlite(this.db, "SELECT thread_id, display_title, host_id, source_recency_at, source_updated_at FROM local_thread_catalog WHERE COALESCE(missing_candidate, 0) = 0 AND COALESCE(thread_source, '') NOT IN ('guardian_review', 'subagent') ORDER BY COALESCE(source_recency_at, source_updated_at) DESC LIMIT 1000");
    } catch { return this.rows; }
  }
  projects(): ChatgptProject[] {
    try {
      const stat = fs.statSync(this.stateFile), stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === this.state.stamp) return this.state.value.projects;
      // The desktop's state file: only the keys named above are read, each narrowed where it is read.
      const raw = bag(parseJson(fs.readFileSync(this.stateFile, 'utf8'))) || {};
      const atoms: Record<string, unknown> = { ...bag(raw['electron-persisted-atom-state']) };
      for (const [key, value] of Object.entries(raw)) if (key.startsWith('electron-owner-atoms') && value && typeof value === 'object') Object.assign(atoms, value);
      const chatgpt = new Map<string, { name: string; cwd: string }>();
      for (const account of Object.values(bag(atoms['chatgpt-sidebar-state-v2'] || atoms['chatgpt-sidebar-state-v1']) || {})) for (const project of list(get(account, 'projects') || [])) if (get(project, 'id')) chatgpt.set(`chatgpt:project:${get(project, 'id')}`, { name: String(get(project, 'name') || ''), cwd: '' });
      const local = new Map(Object.entries(bag(raw['local-projects']) || {}).map(([id, project]) => [`codex:project:${id}`, { name: String(get(project, 'name') || ''), cwd: String(get(project, 'rootPaths', 0) || '') }]));
      const order = list(atoms['unified-sidebar-project-order-v1']);
      const all = new Map([...chatgpt, ...local]);
      // The order lists every project the mode shows (a Codex project backed by a ChatGPT one,
      // like "network", only once, as the ChatGPT project); without it, every project.
      const keys = order.length ? order.filter((key): key is string => typeof key === 'string' && all.has(key)) : [...all.keys()];
      const projects = keys.flatMap(key => { const project = all.get(key); return project ? [{ id: key, ...project }] : []; }).filter(project => project.name);
      this.state = { stamp, value: { projects, pins: codexPinnedThreads(raw) } };
      return projects;
    } catch { return this.state.value.projects; }
  }
  // { conversations: [{ id, title, updatedAt, local }] newest first, projects: [{ id, name, cwd }] }
  read(): { conversations: ChatgptConversation[]; projects: ChatgptProject[]; pins: string[] } {
    const seconds = (value: unknown) => (typeof value === 'number' && value > 0 ? new Date(value * (value < 1e12 ? 1000 : 1)).toISOString() : '');
    const conversations = this.catalog().map(row => ({ id: String(row.thread_id), title: String(row.display_title || ''), updatedAt: seconds(row.source_recency_at) || seconds(row.source_updated_at), local: row.host_id === 'local' }));
    return { conversations, projects: this.projects(), pins: this.state.value.pins };
  }
}

export { CodexChatgpt };
