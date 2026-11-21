// Referring to another chat from a composer: the chats that can be picked (any agent's), and where
// the text the server makes of the picked one (POST …/transcript) goes in the message. The text is
// the server's whole: the page only puts it where the caret is, for the person to read or change.
import { t } from './i18n.js';
import type { TimeValue } from '../../shared/contract.js';

/** A chat as the lists give it: only what the picker reads. */
export interface ReferenceSource { id: string; title?: string | undefined; cwd?: string | undefined; updatedAt?: TimeValue | undefined }
export interface ReferenceChoice { engine: string; agent: string; accent: string; id: string; title: string; folder: string; updatedAt: number }
export const REFERENCE_ROWS = 60;

const stamp = (value: TimeValue | undefined): number => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value ?? '')) || 0;
const folderOf = (cwd: string | undefined): string => String(cwd || '').split('/').filter(Boolean).at(-1) || '';

/**
 * The chats the picker lists: every agent's, the newest first, without the one being written in.
 * `query` is looked for in the title, the folder and the agent's name; every word of it must be there.
 */
export function referenceChoices(
  engines: ReadonlyArray<{ id: string; label: string; accent?: string | null }>,
  sessions: Readonly<Record<string, ReadonlyArray<ReferenceSource> | undefined>>,
  { current = null, query = '', limit = REFERENCE_ROWS }: { current?: { engine: string; id: string } | null; query?: string; limit?: number } = {},
): ReferenceChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return engines.flatMap(engine => (sessions[engine.id] || [])
    .filter(session => !(current && current.engine === engine.id && current.id === session.id))
    .map((session): ReferenceChoice => ({ engine: engine.id, agent: engine.label, accent: engine.accent || '', id: session.id, title: session.title || '', folder: folderOf(session.cwd), updatedAt: stamp(session.updatedAt) })))
    .filter(item => { const text = `${item.title} ${item.folder} ${item.agent}`.toLowerCase(); return words.every(word => text.includes(word)); })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** The text with the reference put in at the caret, on lines of its own, and where the caret goes after it. */
export function insertReference(value: string, start: number, end: number, reference: string): { value: string; caret: number } {
  const before = value.slice(0, start), after = value.slice(end);
  const head = before && !before.endsWith('\n') ? `${before}\n` : before;
  const text = `${head}${reference}\n`;
  return { value: text + after.replace(/^\n/, ''), caret: text.length };
}

/** What a referred chat's card says under its name: how many turns, and about how many tokens it costs. */
export function referenceMeta({ turns, tokens }: { turns: number; tokens: number }): string {
  return t('{n} 轮 · 约 {tokens} tokens', { n: turns, tokens: tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k` });
}
