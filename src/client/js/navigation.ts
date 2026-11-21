import { t, say } from './i18n.js';
import type { ActivityEntry, Usage } from '../../shared/contract.js';

export const viewKey = (engine: string, sessionId: string | null = null): string => JSON.stringify([engine, sessionId]);
/** Whether a key (as viewKey writes it) is one of this engine's views. */
export const isViewOf = (engine: string, key: string): boolean => key.startsWith(`${JSON.stringify([engine]).slice(0, -1)},`);
/** The part of Web Storage these books use (tests pass a Map-backed stand-in). */
export interface StoreLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
// What this page wrote under its own key earlier. Trust boundary: the page is the only writer of
// these keys, so the caller names the shape; JSON.parse returns any. A broken value reads as empty.
function read<T>(storage: StoreLike | null | undefined, key: string, fallback: T): T { try { return JSON.parse(storage?.getItem(key) || 'null') || fallback; } catch { return fallback; } }

/** A file the composer holds (an upload's answer), kept with the draft. */
/** An uploaded file (POST /api/upload answers with these: no local path, the server finds it by `filename`), or the part of one a test gives. */
/** `reference`: the attachment is another chat the console wrote out (the composer's "+"), drawn as a card naming it. */
export interface DraftAttachment { filename: string; originalname?: string; mimetype?: string; size?: number; url?: string; reference?: { agent: string; title: string; turns: number; tokens: number } }
export interface Draft { text: string; attachments: DraftAttachment[]; model?: string; effort?: string; picks?: { model?: string; effort?: string }; selectionStart?: number | null; selectionEnd?: number | null }

export class DraftBook {
  storage: StoreLike | null | undefined; key = 'desktop-bridge:drafts:v1'; entries: Map<string, Draft>;
  constructor(storage?: StoreLike | null) { this.storage = storage; this.entries = new Map(Object.entries(read<Record<string, Draft>>(storage, this.key, {}))); }
  get(key: string): Draft { return structuredClone(this.entries.get(key) || { text: '', attachments: [], model: '', effort: '' }); }
  set(key: string, value: Draft): void { this.entries.set(key, structuredClone(value)); this.persist(); }
  persist(): void { try { this.storage?.setItem(this.key, JSON.stringify(Object.fromEntries(this.entries))); } catch { /* In-memory drafts still survive switching if browser storage is full. */ } }
  append(key: string, files: DraftAttachment[]): void { const draft = this.get(key); draft.attachments = [...(draft.attachments || []), ...files]; this.set(key, draft); }
  clearSent(key: string, text: string, attachments: DraftAttachment[]): Draft {
    const draft = this.get(key), sent = new Set(attachments.map(item => item.filename));
    if (draft.text === text) draft.text = '';
    draft.attachments = (draft.attachments || []).filter(item => !sent.has(item.filename));
    this.set(key, draft); return draft;
  }
}
/** What decides whether a chat has news: its activity entry (or the same fields from elsewhere). */
export type ActivityLike = Pick<ActivityEntry, 'engine' | 'sessionId'> & Partial<Pick<ActivityEntry, 'completedAt' | 'lastMessageAt' | 'running'>>;
export class ReadMarkers {
  storage: StoreLike | null | undefined; key = 'desktop-bridge:read:v1'; entries: Record<string, number>;
  constructor(storage?: StoreLike | null) { this.storage = storage; this.entries = read<Record<string, number>>(storage, this.key, {}); }
  unread(entry: ActivityLike): boolean { return Math.max(entry.completedAt || 0, entry.lastMessageAt || 0) > 0 && Math.max(entry.completedAt || 0, entry.lastMessageAt || 0) > (this.entries[viewKey(entry.engine, entry.sessionId)] || 0); }
  mark(engine: string, sessionId: string, timestamp = Date.now()): void {
    const key = viewKey(engine, sessionId); this.entries[key] = Math.max(this.entries[key] || 0, timestamp);
    try { this.storage?.setItem(this.key, JSON.stringify(this.entries)); } catch {}
  }
}
export function preferredSession(engine: string, sessions: ReadonlyArray<{ id: string }>, remembered: string | null | undefined, activity: ActivityLike[], markers: ReadMarkers): string | null {
  const unread = activity.filter(item => item.engine === engine && markers.unread(item)).sort((a, b) => Math.max(b.completedAt || 0, b.lastMessageAt || 0) - Math.max(a.completedAt || 0, a.lastMessageAt || 0));
  return unread[0]?.sessionId || remembered || activity.find(item => item.engine === engine && item.running)?.sessionId || sessions[0]?.id || null;
}
export function quotaLabel(usage: Usage | null | undefined): string {
  if (!usage?.available || !usage.windows?.length) return say(usage?.short) || (usage?.reason?.startsWith('暂时') ? t('额度暂不可用') : t('额度未公开'));
  // Without a time window (per-model quotas), the tightest model is what matters.
  const first = usage.windows[0];
  if (first && !first.windowMinutes) return `${first.label} ${Math.round(Number(first.remainingPercent))}%`;
  return usage.windows.slice(0, 2).map(window => {
    const minutes = window.windowMinutes ?? 0; // null and 0 both read as no window (—), as before
    const period = minutes >= 1440 ? `${Math.round(minutes / 1440)}d` : minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes || '—'}m`;
    return `${period} ${Math.round(Number(window.remainingPercent))}%`;
  }).join(' · ');
}
