import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parseJson } from '../../shared/guards.js';

// Reads complete UTF-8 records only, including when a writer splits a line or code point.
export interface JsonlTail { read(): void; close(): void }
// Each record is handed over as parsed JSON of unknown shape; the reader narrows it.
function tailJsonl(file: string, offset: number, onRecord: (record: unknown) => void, { interval = 400, onError = (_err: unknown) => {} }: { interval?: number; onError?: (err: unknown) => void } = {}): JsonlTail {
  let position = offset, pending = '', decoder = new StringDecoder('utf8'), stopped = false;
  const read = () => {
    if (stopped || !fs.existsSync(file)) return;
    try {
      const size = fs.statSync(file).size;
      if (size < position) { position = 0; pending = ''; decoder = new StringDecoder('utf8'); }
      if (size === position) return;
      const fd = fs.openSync(file, 'r');
      try {
        while (position < size) {
          const buffer = Buffer.alloc(Math.min(65536, size - position));
          const count = fs.readSync(fd, buffer, 0, buffer.length, position);
          if (!count) break;
          position += count;
          pending += decoder.write(buffer.subarray(0, count));
          let index;
          while ((index = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, index); pending = pending.slice(index + 1);
            try { if (line.trim()) onRecord(parseJson(line)); } catch (err) { if (!(err instanceof SyntaxError)) onError(err); }
          }
        }
      } finally { fs.closeSync(fd); }
    } catch (err) { onError(err); }
  };
  const timer = setInterval(read, interval); timer.unref?.();
  return { read, close() { stopped = true; clearInterval(timer); } };
}
export { tailJsonl };
