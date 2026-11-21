// Files the person attaches in the console, in one place: where they are kept, what the page is
// told about them, what a message may name, and how they reach an engine whose channel takes
// text only. An engine adapter never builds any of this itself.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import type { RequestHandler } from 'express';
import { get } from '../../shared/guards.js';
import type { Attachment } from '../../shared/contract.js';

export const MAX_ATTACHMENTS = 10;
const MAX_BYTES = 100 * 1024 * 1024;
/** The message a send gets when the person attached files and typed nothing. */
export const ATTACHMENTS_ONLY_PROMPT = '请查看并分析附件';

/** An uploaded file as the page knows it: no local path, the server finds the file by `filename`. */
export interface UploadedFile { filename: string; originalname: string; mimetype: string; size: number; url: string }

// What kind of file it is comes from the stored name's extension (given by the server at upload),
// never from what the page says.
const IMAGE_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
const typeOf = (filename: string): string => IMAGE_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
// A name goes into a message on a line of its own: one line, no control characters, not endless.
const labelOf = (value: unknown, fallback: string): string => String(value ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, 200) || fallback;
// Multer reads the multipart filename as Latin-1; browsers send UTF-8 ("截屏…" arrives garbled).
function decoded(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || /[^\u0000-\u00ff]/.test(value)) return value;
  const text = Buffer.from(value, 'latin1').toString('utf8');
  return text.includes('\ufffd') ? value : text;
}
/** An upload the store refused (too big, too many): the person's to fix, not a server fault. */
export const isUploadError = (err: unknown): boolean => err instanceof multer.MulterError;
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

/**
 * How attachments go into a channel that takes text (a desktop app's composer). The engine's
 * adapter says which way its desktop reads them:
 * - 'mention': `@path`, the desktop's own way of referring to a file. It then attaches the file
 *   itself (its text, or the picture) to the message, as when the person adds one there.
 *   Claude's desktop does (checked 2026-11-16: a text file and a picture both arrived that way).
 * - 'note': one line per file naming it and where it is on this machine, for a desktop with no
 *   such reference; the agent reads the file itself.
 */
export type AttachmentStyle = 'mention' | 'note';
// A path with a space in it is quoted, so the reference ends where the path does.
const mentionOf = (file: string): string => /\s/.test(file) ? `@"${file}"` : `@${file}`;
export function attachmentRefs(attachments: readonly Attachment[] | undefined, style: AttachmentStyle = 'note'): string[] {
  const files = attachments || [];
  if (style === 'mention') return files.length ? [files.map(item => mentionOf(item.path)).join(' ')] : [];
  return files.map(item => `附件 ${labelOf(item.originalname, path.basename(item.path))}：${item.path}`);
}
/** The message with its attachments, as one text. */
export const withAttachments = (prompt: string | undefined, attachments: readonly Attachment[] | undefined, style: AttachmentStyle = 'note'): string =>
  [prompt, ...attachmentRefs(attachments, style)].filter(Boolean).join('\n\n');

export class AttachmentStore {
  readonly dir: string;
  /** Express middleware for POST /api/upload (field `files`). */
  readonly receive: RequestHandler;
  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.receive = multer({
      storage: multer.diskStorage({ destination: dir, filename: (_req, file, done) => done(null, `${randomUUID()}${path.extname(file.originalname).replace(/[^.a-z0-9]/gi, '').toLowerCase()}`) }),
      limits: { fileSize: MAX_BYTES, files: MAX_ATTACHMENTS },
    }).array('files', MAX_ATTACHMENTS);
  }
  /** What the page is told about the files of one upload. */
  describe(files: readonly Express.Multer.File[]): UploadedFile[] {
    return files.map(file => ({ filename: file.filename, originalname: labelOf(decoded(file.originalname), file.filename), mimetype: typeOf(file.filename), size: file.size, url: `/uploads/${file.filename}` }));
  }
  /**
   * Text the console made itself (another chat, referred to), kept as an attached file like an
   * upload, so it reaches each engine the way its files do. `stem` starts the stored name.
   */
  keep(text: string, { stem, name }: { stem: string; name: string }): UploadedFile {
    const filename = `${stem.replace(/[^\w-]/g, '').slice(0, 40) || 'note'}-${randomUUID().slice(0, 8)}.md`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, filename), text);
    return { filename, originalname: labelOf(name, filename), mimetype: 'text/markdown', size: Buffer.byteLength(text), url: `/uploads/${filename}` };
  }
  /** The stored file a name stands for; null when there is none (the name never leaves the folder). */
  locate(filename: unknown): string | null {
    const name = path.basename(String(filename || ''));
    if (!/^[\w-]+(\.[a-z0-9]+)?$/i.test(name)) return null;
    const file = path.join(this.dir, name);
    try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
  }
  /**
   * The attachments a message names (whatever the page sent), as an engine gets them. Only a file
   * this store holds is accepted, and only its display name is taken from the page.
   */
  resolve(items: unknown): Attachment[] {
    if (items == null) return [];
    if (!Array.isArray(items) || items.length > MAX_ATTACHMENTS) throw failure('Invalid attachments', 400);
    const seen = new Set<string>();
    return items.flatMap((item: unknown): Attachment[] => {
      const file = this.locate(get(item, 'filename'));
      if (!file) throw failure('附件不存在，请重新上传', 400);
      const filename = path.basename(file);
      if (seen.has(filename)) return [];
      seen.add(filename);
      return [{ filename, path: file, originalname: labelOf(get(item, 'originalname'), filename), mimetype: typeOf(filename), url: `/uploads/${filename}` }];
    });
  }
}
