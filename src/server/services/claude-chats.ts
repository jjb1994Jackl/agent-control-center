import path from 'node:path';
import { BlobStore } from './chromium-idb.js';
import { get, list, str } from '../../shared/guards.js';

// A type alias (not an interface), so it is readable as a ChatMode chat (which allows more fields).
export type ClaudeChat = { id: string; title: string; updatedAt: string; projectId: string; projectName: string; starred: boolean };
export interface ClaudeChatProject { id: string; name: string; starred: boolean }

// The Claude desktop app's "Claude" mode (its chats and projects, as its sidebar shows them),
// read-only from the app's own saved query cache: the Claude window keeps the lists it last
// fetched in its IndexedDB ("keyval-store", a persisted query client), so they are on disk.
// Only the list queries are read (chat_conversation_list, project_list); nothing else in that
// cache (account, settings) is looked at or kept. The chats' messages are not in it.
class ClaudeChats {
  store: BlobStore;
  constructor({ desktopHome }: { desktopHome: string }) {
    this.store = new BlobStore(path.join(desktopHome, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob'), value => Array.isArray(get(value, 'clientState', 'queries')));
  }
  read(): { chats: ClaudeChat[]; projects: ClaudeChatProject[] } {
    // The cached queries are the app's own data: every key read below is narrowed where it is read.
    const queries = list(get(this.store.read(), 'clientState', 'queries'));
    const rows = (name: string, filter: (key: unknown[]) => boolean = () => true) => queries.filter(query => { const key = get(query, 'queryKey'); return Array.isArray(key) && key[0] === name && filter(key); })
      .flatMap((query): unknown[] => { const data = get(query, 'state', 'data'); const pages = get(data, 'pages'); return Array.isArray(pages) ? pages.flatMap(page => get(page, 'data') || []) : Array.isArray(data) ? data : Array.isArray(get(data, 'data')) ? list(get(data, 'data')) : []; })
      .filter(row => row && typeof get(row, 'uuid') === 'string');
    const seen = new Set<string>(), chats: ClaudeChat[] = [];
    // The sidebar's Recents (newest first) and its pinned chats.
    for (const row of rows('chat_conversation_list')) {
      const uuid = String(get(row, 'uuid'));
      if (seen.has(uuid) || get(row, 'is_archived') || get(row, 'is_temporary')) continue;
      seen.add(uuid);
      chats.push({ id: uuid, title: String(get(row, 'name') || ''), updatedAt: String(get(row, 'updated_at') || get(row, 'created_at') || ''), projectId: String(get(row, 'project_uuid') || ''), projectName: String(get(row, 'project', 'name') || ''), starred: !!get(row, 'is_starred') });
    }
    chats.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    // The sidebar lists the pinned (starred) projects; a project a listed chat is in comes along.
    const known = new Map<string, ClaudeChatProject>();
    for (const row of rows('project_list')) { const uuid = String(get(row, 'uuid')); if (!get(row, 'archived_at') && !known.has(uuid)) known.set(uuid, { id: uuid, name: String(get(row, 'name') || ''), starred: !!get(row, 'is_starred') }); }
    const projects = [...known.values()].filter(project => project.starred);
    for (const chat of chats) if (chat.projectId && !projects.some(project => project.id === chat.projectId)) projects.push({ id: chat.projectId, name: known.get(chat.projectId)?.name || chat.projectName || chat.projectId, starred: false });
    return { chats, projects };
  }
}

export { ClaudeChats };
