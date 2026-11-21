import fs from 'node:fs';
import path from 'node:path';

// Reads a value an Electron desktop app keeps in its IndexedDB, read-only, from the files alone
// (no Chromium, no running app). Large values live as blob files under
// "<origin>.indexeddb.blob/<db>/<xx>/<n>": a Blink header (0xff <version>), a 0x02 marker when
// the value is snappy-compressed, then a V8 structured-clone payload (0xff <version> …).
// Only the tags a JSON-like value uses are read; anything else stops the read (null).

type Cursor = { i: number };
function varint(buf: Buffer, at: Cursor): number {
  let value = 0, shift = 0, byte: number;
  do { byte = buf[at.i++] ?? 0; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return value;
}

// Raw snappy block (no framing): the uncompressed length, then literals and back-references.
function unsnappy(buf: Buffer): Buffer {
  const at = { i: 0 }, size = varint(buf, at), out = Buffer.alloc(size);
  let o = 0;
  while (at.i < buf.length) {
    const tag = buf[at.i++] ?? 0, kind = tag & 3;
    if (kind === 0) {
      let length = tag >> 2;
      if (length >= 60) { const bytes = length - 59; length = buf.readUIntLE(at.i, bytes); at.i += bytes; }
      length += 1; buf.copy(out, o, at.i, at.i + length); at.i += length; o += length;
      continue;
    }
    let length: number, offset: number;
    if (kind === 1) { length = ((tag >> 2) & 7) + 4; offset = ((tag >> 5) << 8) | (buf[at.i++] ?? 0); }
    else if (kind === 2) { length = (tag >> 2) + 1; offset = buf.readUInt16LE(at.i); at.i += 2; }
    else { length = (tag >> 2) + 1; offset = buf.readUInt32LE(at.i); at.i += 4; }
    if (!offset || offset > o) throw new Error('bad snappy offset');
    for (let k = 0; k < length; k++, o++) out[o] = out[o - offset] ?? 0;
  }
  if (o !== size) throw new Error('bad snappy length');
  return out;
}

// V8's structured-clone format, for plain data: objects, arrays, strings, numbers, booleans, null.
// What comes out is whatever the app stored: unknown until the reader narrows it.
function deserialize(buf: Buffer): unknown {
  const at: Cursor = { i: 0 }, refs: unknown[] = [];
  const peek = (code: number) => buf[at.i] === code && (at.i++, true);
  const value = (): unknown => {
    // Past the end there is no tag (undefined): that stops the read below, as an unknown tag.
    let tag: number | undefined = buf[at.i++];
    while (tag === 0x00) tag = buf[at.i++]; // padding
    if (tag === 0xff) { varint(buf, at); return value(); } // version
    switch (String.fromCharCode(tag ?? 0)) {
      case '_': return undefined;
      case '0': return null;
      case 'T': return true;
      case 'F': return false;
      case 'I': { const z = varint(buf, at); return z % 2 ? -(z + 1) / 2 : z / 2; }
      case 'U': return varint(buf, at);
      case 'N': { const v = buf.readDoubleLE(at.i); at.i += 8; return v; }
      case 'D': { const v = new Date(buf.readDoubleLE(at.i)); at.i += 8; refs.push(v); return v; }
      case '"': { const n = varint(buf, at), v = buf.toString('latin1', at.i, at.i + n); at.i += n; return v; }
      case 'c': { const n = varint(buf, at), v = buf.toString('utf16le', at.i, at.i + n); at.i += n; return v; }
      case 'S': { const n = varint(buf, at), v = buf.toString('utf8', at.i, at.i + n); at.i += n; return v; }
      case '^': return refs[varint(buf, at)];
      // Keys are set the way JavaScript would set them (property keys are strings).
      case 'o': { const o: Record<string, unknown> = {}; refs.push(o); while (!peek(0x7b)) { const k = value(); o[String(k)] = value(); } varint(buf, at); return o; }
      case 'A': { const a: unknown[] = new Array(varint(buf, at)); refs.push(a); for (let k = 0; k < a.length; k++) a[k] = value(); while (!peek(0x24)) { const k = value(); Reflect.set(a, String(k), value()); } varint(buf, at); varint(buf, at); return a; }
      case 'a': { const a: unknown[] = new Array(varint(buf, at)); refs.push(a); while (!peek(0x40)) { const k = value(); Reflect.set(a, String(k), value()); } varint(buf, at); varint(buf, at); return a; }
      case ';': { const m = new Map<unknown, unknown>(); refs.push(m); while (!peek(0x3a)) m.set(value(), value()); varint(buf, at); return m; }
      case "'": { const s = new Set<unknown>(); refs.push(s); while (!peek(0x2c)) s.add(value()); varint(buf, at); return s; }
      default: throw new Error(`unsupported clone tag ${tag}`);
    }
  };
  return value();
}

// A Blink-wrapped IndexedDB value (a blob file's bytes) → the JS value, or null.
function readValue(bytes: Buffer): unknown {
  try {
    if (bytes[0] !== 0xff) return null;
    let payload = bytes.subarray(2), start = 0;
    // Compressed: the snappy block holds a Blink header of its own, then V8's version tag.
    if (payload[0] === 0x02) { payload = unsnappy(payload.subarray(1)); start = payload.indexOf(0xff, 2); }
    return start < 0 ? null : deserialize(payload.subarray(start));
  } catch { return null; }
}

// The newest blob value under `dir` that `accept(value)` takes, cached by file and mtime.
class BlobStore {
  dir: string; accept: (value: unknown) => boolean; cache: { key: string; value: unknown };
  constructor(dir: string, accept: (value: unknown) => boolean) { this.dir = dir; this.accept = accept; this.cache = { key: '', value: null }; }
  files(): Array<{ file: string; mtime: number; size: number }> {
    const out: Array<{ file: string; mtime: number; size: number }> = [];
    const walk = (dir: string, depth: number) => { let entries: fs.Dirent[] = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const item of entries) { const file = path.join(dir, item.name); if (item.isDirectory() && depth < 3) walk(file, depth + 1); else if (item.isFile()) { try { const stat = fs.statSync(file); if (stat.size < 64 << 20) out.push({ file, mtime: stat.mtimeMs, size: stat.size }); } catch {} } } };
    walk(this.dir, 0);
    return out.sort((a, b) => b.mtime - a.mtime);
  }
  read(): unknown {
    for (const { file, mtime, size } of this.files()) {
      const key = `${file}:${mtime}:${size}`;
      if (key === this.cache.key) return this.cache.value;
      let value: unknown = null;
      try { value = readValue(fs.readFileSync(file)); } catch {}
      if (value && this.accept(value)) { this.cache = { key, value }; return value; }
    }
    return null;
  }
}

export { unsnappy, deserialize, readValue, BlobStore };
