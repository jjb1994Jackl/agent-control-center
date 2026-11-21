// "Show in Finder": the system's own file manager, with the file selected. Shared by every engine;
// the file is one resolveFile (file-preview.js) has already checked. Runs on the machine the
// console's server runs on, which is the desktop's machine.
import path from 'node:path';
import { execFile } from 'node:child_process';

// What the page calls the file manager, by the server's platform.
const FILE_MANAGERS: Partial<Record<string, string>> = { darwin: 'finder', win32: 'explorer' };
const fileManager = (platform: string = process.platform): string => FILE_MANAGERS[platform] || 'files';

function command(file: string, platform: string = process.platform): [string, string[]] {
  if (platform === 'darwin') return ['/usr/bin/open', ['-R', file]];
  if (platform === 'win32') return ['explorer.exe', [`/select,${file}`]];
  return ['xdg-open', [path.dirname(file)]];
}

// The runner is execFile, or a stand-in in tests that calls back the same way.
type Runner = (bin: string, args: string[], options: { timeout: number }, done: (err: (Error & { code?: unknown }) | null) => void) => unknown;
function revealFile(file: string, { platform = process.platform, runner = execFile }: { platform?: string; runner?: Runner } = {}): Promise<void> {
  const [bin, args] = command(file, platform);
  return new Promise<void>((resolve, reject) => runner(bin, args, { timeout: 10000 }, err => {
    // explorer.exe answers 1 even when it did open the folder.
    if (err && !(platform === 'win32' && err.code === 1)) reject(Object.assign(new Error('没能在文件管理器里显示这个文件'), { status: 500, cause: err }));
    else resolve();
  }));
}

export { revealFile, fileManager, command };
