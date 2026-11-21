// Where the project lives, found the same way from the sources (src/server, run by tsx) and from
// the build (dist/server): the nearest folder above with this project's package.json. Files that
// are not compiled (the Swift helpers and their profiles, uploads, certificates) are found from it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, parseJson } from '../shared/guards.js';

function findRoot(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    try {
      const name = get(parseJson(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), 'name');
      if (name === 'agent-control-center' || name === 'agent-frontdesk') return dir;
    } catch {}
    if (path.dirname(dir) === dir) throw new Error('Agent Control Center: project root not found');
  }
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = findRoot(HERE);
// The Swift helpers and their profiles stay in the sources; they are compiled on demand.
const NATIVE = path.join(ROOT, 'src/server/native');
// The built page (vite build). In development Vite serves the page itself.
const PUBLIC = path.join(ROOT, 'dist/public');
export { ROOT, NATIVE, PUBLIC, HERE };
