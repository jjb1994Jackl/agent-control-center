import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentCustom, AvatarSlot, Character } from '../../shared/contract.js';
import type { SettingsStore } from './settings-store.js';

// What the person changed about an agent in the console's own settings: the name the console
// calls it by, the order of the rail, and two pictures of their own for its face, one while it is
// idle and one while it works. These are the console's own parts (the rail, the sidebar, the
// dialogs); the desktop apps are not touched. Nothing changed means the plugin's own name and
// character, exactly: what is merged here is only what the settings file names and what is
// still on disk, so a deleted picture falls back to the plugin's face instead of a broken one.
export const AVATAR_SLOTS: readonly AvatarSlot[] = ['idle', 'working'];
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const LABEL_MAX = 40;
// The picture formats taken, told by their first bytes, not by what the upload says it is. No
// SVG: opened at its own address it would run scripts as the console.
const FORMATS: Array<{ ext: string; type: string; test: (data: Buffer) => boolean }> = [
  { ext: 'png', type: 'image/png', test: data => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', type: 'image/jpeg', test: data => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
  { ext: 'gif', type: 'image/gif', test: data => /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1')) },
  { ext: 'webp', type: 'image/webp', test: data => data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP' },
];
export const imageFormat = (data: Buffer) => FORMATS.find(format => format.test(data)) ?? null;
const isSlot = (value: string): value is AvatarSlot => (AVATAR_SLOTS as readonly string[]).includes(value);
// A file this module wrote: "<agent>-<slot>-<hash>.<ext>" (the hash is also the address's version).
const FILE = /^([a-z0-9-]+)-(idle|working)-([0-9a-f]{10})\.(png|jpg|gif|webp)$/;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

interface Listed { id: string; label: string; character: Character | null }
export class AgentLooks {
  constructor(private settings: SettingsStore, private dir: string) {}
  /** The picture file behind a slot, when the settings name one that is still there. */
  private file(id: string, slot: AvatarSlot): string | null {
    const name = this.settings.custom(id)[slot], match = name ? FILE.exec(name) : null;
    if (!name || !match || match[1] !== id || match[2] !== slot || !this.dir) return null;
    const file = path.join(this.dir, name);
    return fs.existsSync(file) ? file : null;
  }
  /** The address the page draws a slot's picture from; the version changes with the picture (browsers keep it a day). */
  url(id: string, slot: AvatarSlot): string | null {
    const file = this.file(id, slot);
    return file ? `/api/characters/custom-${id}-${slot}?v=${FILE.exec(path.basename(file))?.[3] ?? ''}` : null;
  }
  /** GET /api/characters/custom-<agent>-<slot>: the picture, or null. */
  asset(name: string): { type: string; data: Buffer } | null {
    const match = /^custom-([a-z0-9-]+)-(idle|working)$/.exec(name), id = match?.[1], slot = match?.[2];
    if (!id || !slot || !isSlot(slot)) return null;
    const file = this.file(id, slot), format = file ? FORMATS.find(item => file.endsWith(`.${item.ext}`)) : null;
    return file && format ? { type: format.type, data: fs.readFileSync(file) } : null;
  }
  /** Keeps a picture for a slot (replacing the one before). */
  save(id: string, slot: string, data: Buffer): void {
    if (!isSlot(slot)) throw fail(404, `Unknown slot: ${slot}`);
    if (!this.dir) throw fail(503, '设置文件没有位置，图片存不下');
    if (!data.length) throw fail(400, '图片是空的');
    if (data.length > AVATAR_MAX_BYTES) throw fail(413, '图片不能超过 2 MB');
    const format = imageFormat(data);
    if (!format) throw fail(415, '只支持 PNG、JPEG、GIF、WebP 图片');
    const name = `${id}-${slot}-${crypto.createHash('sha256').update(data).digest('hex').slice(0, 10)}.${format.ext}`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), data);
    const before = this.settings.custom(id)[slot];
    this.settings.setCustom(id, { [slot]: name });
    if (before && before !== name) this.forget(before);
  }
  /** Puts the plugin's own face back for a slot. */
  remove(id: string, slot: string): void {
    if (!isSlot(slot)) throw fail(404, `Unknown slot: ${slot}`);
    const before = this.settings.custom(id)[slot];
    this.settings.setCustom(id, { [slot]: null });
    if (before) this.forget(before);
  }
  /** The name the console calls the agent by; empty or null puts the plugin's own back. */
  rename(id: string, label: unknown): void {
    if (label !== null && typeof label !== 'string') throw fail(400, 'Invalid label');
    const text = (label ?? '').replace(/\s+/g, ' ').trim();
    if (Array.from(text).length > LABEL_MAX) throw fail(400, '名称不能超过 40 个字');
    this.settings.setCustom(id, { label: text || null });
  }
  /** The rail's order: the given agents first, in that order. */
  reorder(ids: unknown, known: Set<string>): void {
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw fail(400, 'Invalid order');
    this.settings.setOrder(ids.filter(id => known.has(id)));
  }
  private forget(name: string): void {
    if (!FILE.test(name) || !this.dir) return;
    try { fs.rmSync(path.join(this.dir, name), { force: true }); } catch {}
  }
  /** An agent or engine as the page receives it, with what the person changed merged in. */
  apply<T extends Listed>(item: T): T & { defaultLabel?: string; custom?: AgentCustom } {
    const { label } = this.settings.custom(item.id), idle = this.url(item.id, 'idle'), working = this.url(item.id, 'working');
    if (!label && !idle && !working) return item;
    let character = item.character;
    if (idle) character = { kind: 'image', url: idle, fill: true };
    if (working) character = character ? { ...character, workingUrl: working } : { kind: 'image', url: working, fill: true };
    const custom: AgentCustom = { ...(label ? { label } : {}), ...(idle ? { idle } : {}), ...(working ? { working } : {}) };
    return { ...item, character, custom, ...(label && label !== item.label ? { label, defaultLabel: item.label } : {}) };
  }
  /** In the person's order; agents they never placed follow, in the plugins' own order. */
  sort<T extends { id: string }>(items: T[]): T[] {
    const order = this.settings.order(), rank = (id: string) => { const at = order.indexOf(id); return at < 0 ? order.length : at; };
    return items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index).map(({ item }) => item);
  }
}
