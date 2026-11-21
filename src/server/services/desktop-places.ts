// Where each desktop app and its data live on this platform, and how a link is opened without
// bringing an app forward. Everything platform-specific about places is here, so the bridges and
// plugins ask for "Claude's data folder" or "Codex's app.asar" and never hard-code a path.
// On macOS the apps are bundles under /Applications. On Windows Claude and Codex are packaged
// (MSIX) apps: their install folders are known only to the package manager, and Claude keeps its
// data in a folder of its own under %LOCALAPPDATA%\Claude-Data rather than in %APPDATA%.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

export interface PlaceOptions { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string }
const opts = ({ platform = process.platform, env = process.env, home = os.homedir() }: PlaceOptions = {}) => ({ platform, env, home });
// path.win32 / path.posix by the platform asked about, so the answers can be tested on either.
const pathFor = (platform: NodeJS.Platform) => platform === 'win32' ? path.win32 : path.posix;

// ---------- packaged (MSIX) apps on Windows ----------
/** The package names of the desktop apps that ship as MSIX packages on Windows. */
export const PACKAGES = { claude: 'Claude', codex: 'OpenAI.Codex' } as const;
type PackageLookup = (name: string) => string | null;
const packageRoots = new Map<string, string | null>();
// Asked once per name and remembered: the newest installed version's folder, or null.
const lookUpPackage: PackageLookup = name => {
  if (packageRoots.has(name)) return packageRoots.get(name) ?? null;
  let root: string | null = null;
  try {
    root = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-AppxPackage -Name '${name}' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation`],
    { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim() || null;
  } catch {}
  packageRoots.set(name, root);
  return root;
};
let packageLookup: PackageLookup = lookUpPackage;
/** For tests: answers package folders without asking Windows. */
export function setPackageLookup(lookup: PackageLookup | null): void { packageLookup = lookup || lookUpPackage; }
/** The install folder of a packaged app on Windows, or null (elsewhere, or not installed). */
export function packageRoot(name: string, { platform = process.platform }: PlaceOptions = {}): string | null {
  return platform === 'win32' ? packageLookup(name) : null;
}

// ---------- Claude ----------
/** Claude desktop's own data folder (sessions index, its copy of the claude CLI). */
export function claudeDesktopHome(options: PlaceOptions = {}): string {
  const { platform, env, home } = opts(options), p = pathFor(platform);
  if (platform === 'darwin') return p.join(home, 'Library/Application Support/Claude');
  if (platform === 'win32') {
    // These are real folders looked at on disk, so they are joined the way this machine joins them.
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    // One folder per publisher ("claude_<id>"); the one holding the sessions index, newest first.
    // %APPDATA%\Claude is where older versions kept it (it now holds only a pointer file).
    const base = path.join(local, 'Claude-Data');
    try {
      const folders = fs.readdirSync(base, { withFileTypes: true }).filter(item => item.isDirectory() && item.name.startsWith('claude_'))
        .map(item => path.join(base, item.name)).filter(dir => fs.existsSync(path.join(dir, 'claude-code-sessions')))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (folders[0]) return folders[0];
    } catch {}
    return path.join(roaming, 'Claude');
  }
  return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'Claude');
}
/** Where, inside one version folder of Claude desktop's claude-code, its CLI is. */
export function claudeCliIn(buildDir: string, { platform = process.platform }: PlaceOptions = {}): string {
  const p = pathFor(platform);
  return platform === 'darwin' ? p.join(buildDir, 'claude.app/Contents/MacOS/claude') : p.join(buildDir, platform === 'win32' ? 'claude.exe' : 'claude');
}
/** The file name of the claude CLI on this platform. */
export const claudeCliName = ({ platform = process.platform }: PlaceOptions = {}): string => platform === 'win32' ? 'claude.exe' : 'claude';

// ---------- the apps' bundles ----------
export type DesktopApp = 'claude' | 'codex';
const MAC_APPS: Record<DesktopApp, string> = { claude: '/Applications/Claude.app', codex: '/Applications/ChatGPT.app' };
/** Login-service only: start an enabled plugin's installed app without taking focus. */
export function startDesktopAtLogin(bundle: string | undefined): void {
  if (process.platform !== 'darwin' || process.env.ACC_START_DESKTOPS !== '1' || !bundle || !path.isAbsolute(bundle)) return;
  const app = path.resolve(bundle);
  if (!app.endsWith('.app') || !fs.existsSync(path.join(app, 'Contents/Info.plist'))) return;
  execFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Contents/Info.plist')], { timeout: 2000 }, (error, stdout) => {
    const bundleId = stdout.trim();
    if (error || !/^[a-zA-Z0-9.-]+$/.test(bundleId)) return;
    execFile('/usr/bin/lsappinfo', ['find', 'bundleID=' + bundleId], { timeout: 2000 }, (lookupError, found) => {
      if (lookupError || found.trim()) return;
      execFile('/usr/bin/open', ['-g', '-a', app], { timeout: 15000 }, launchError => {
        if (launchError) console.warn('Unable to start the desktop app in the background:', path.basename(app));
      });
    });
  });
}
// Where a per-user (not packaged) install would put the app on Windows: %LOCALAPPDATA%\Programs\<name>.
// Not seen on a machine yet (both apps were MSIX packages wherever this was checked), so only asked
// after the package, and only when the file is there.
const WIN_PROGRAMS: Record<DesktopApp, string> = { claude: 'Claude', codex: 'ChatGPT' };
function unpackaged(app: DesktopApp, rest: string[], { env, home }: { env: NodeJS.ProcessEnv; home: string }): string {
  const file = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', WIN_PROGRAMS[app], ...rest);
  return fs.existsSync(file) ? file : '';
}
/** The app's app.asar (its page code and artwork), or '' when the app is not installed here. */
export function appAsar(app: DesktopApp, options: PlaceOptions = {}): string {
  const o = opts(options);
  if (o.platform === 'darwin') return `${MAC_APPS[app]}/Contents/Resources/app.asar`;
  if (o.platform !== 'win32') return '';
  const root = packageRoot(PACKAGES[app], o);
  return root ? path.win32.join(root, 'app', 'resources', 'app.asar') : unpackaged(app, ['resources', 'app.asar'], o);
}
/** The codex CLI the desktop ships, or '' (it is then looked for on PATH). */
export function bundledCodexCli(options: PlaceOptions = {}): string {
  const o = opts(options);
  if (o.platform === 'darwin') return '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  if (o.platform !== 'win32') return '';
  const root = packageRoot(PACKAGES.codex, o);
  return root ? path.win32.join(root, 'app', 'resources', 'codex.exe') : unpackaged('codex', ['resources', 'codex-cli', 'bin', 'codex.exe'], o);
}
/** Where Claude Code's own installer puts its CLI on Windows (~\.local\bin\claude.exe), or ''. */
export function installedClaudeCli(options: PlaceOptions = {}): string {
  const { platform, home } = opts(options);
  return platform === 'win32' ? path.join(home, '.local', 'bin', 'claude.exe') : '';
}
/** The app's icon file: an .icns next to its app.asar on macOS, the package's tile logo (PNG) on Windows. */
export function appIconFile(app: DesktopApp, options: PlaceOptions & { asar?: string } = {}): string {
  const { platform } = opts(options);
  if (platform === 'darwin') return path.posix.join(path.posix.dirname(options.asar || appAsar(app, { platform })), 'electron.icns');
  const root = packageRoot(PACKAGES[app], { platform });
  return root ? largestLogo(root) : '';
}
// A package's tile logo comes in scales ("Square150x150Logo.scale-200.png"); the largest file is the sharpest.
function largestLogo(root: string): string {
  for (const dir of ['Assets', 'assets'].map(name => path.join(root, name))) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const logos = names.filter(name => /^Square150x150Logo.*\.png$/i.test(name)).map(name => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    if (logos[0]) return logos[0];
  }
  return '';
}

// ---------- Antigravity ----------
/** The Antigravity app (a bundle on macOS, its exe on Windows), or '' where unknown. */
export function antigravityApp(options: PlaceOptions = {}): string {
  const { platform, env, home } = opts(options);
  if (platform === 'darwin') return '/Applications/Antigravity.app/';
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'Antigravity.exe');
  return '';
}

/**
 * How Antigravity's agentapi is run, as [program, arguments before the command], or null.
 * macOS: the `agentapi` it installs under ~/.gemini/antigravity/bin, or one on PATH. Windows: that
 * file is agentapi.bat, which only runs `<app>\resources\bin\language_server.exe agentapi %*`; the
 * exe is started directly, as Node cannot start a .bat without a shell and its quoting.
 */
export function agentapiCommand(agyHome: string, options: PlaceOptions = {}): [string, string[]] | null {
  const { platform, env, home } = opts(options);
  if (platform === 'win32') {
    // A real file looked for on disk: joined the way this machine joins paths.
    const server = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe');
    return fs.existsSync(server) ? [server, ['agentapi']] : null;
  }
  const found = findExecutable([path.join(agyHome, 'bin', 'agentapi'), 'agentapi'], options);
  return found ? [found, []] : null;
}

/**
 * Antigravity's icon file: its .icns on macOS; on Windows its app.asar, whose /icon.png the console
 * reads in place (readAppIcon). '' where the app ships none the console can read.
 */
export function antigravityIconFile(options: PlaceOptions = {}): string {
  const { platform, env, home } = opts(options);
  if (platform === 'darwin') return '/Applications/Antigravity.app/Contents/Resources/icon.icns';
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'resources', 'app.asar');
  return '';
}

// ---------- the native helper's cache ----------
/** Where compiled native helpers are kept, per source hash. */
export function helperCacheDir(options: PlaceOptions = {}): string {
  const { platform, env, home } = opts(options), p = pathFor(platform);
  if (platform === 'darwin') return p.join(home, 'Library/Caches/agent-frontdesk');
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'agent-frontdesk');
  return p.join(env.XDG_CACHE_HOME || p.join(home, '.cache'), 'agent-frontdesk');
}

// ---------- opening links ----------
type Runner = (file: string, args: string[], options: { timeout: number; windowsHide?: boolean }, done: (err: Error | null) => void) => unknown;
/**
 * How a deep link is handed to the app it belongs to. macOS: `open -g`, which does not bring the
 * app forward. Windows has no such flag: the link goes to the shell's protocol handler
 * (url.dll's FileProtocolHandler, the same as typing it into Run), with no cmd.exe in between,
 * so `&` and quotes in the link need no escaping. Whether the app then comes forward is the app's.
 */
export function linkCommand(link: string, { platform = process.platform }: PlaceOptions = {}): [string, string[]] {
  if (platform === 'darwin') return ['/usr/bin/open', ['-g', link]];
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', link]];
  return ['xdg-open', [link]];
}
export function openLink(link: string, { platform = process.platform, run = execFile as unknown as Runner }: PlaceOptions & { run?: Runner } = {}): Promise<void> {
  const [file, args] = linkCommand(link, { platform });
  return new Promise((resolve, reject) => { run(file, args, { timeout: 15000, windowsHide: true }, err => err ? reject(err) : resolve()); });
}

// ---------- finding a program ----------
/** The first runnable file among `candidates`: a bare name is looked for on PATH (with PATHEXT on Windows). */
export function findExecutable(candidates: Array<string | null | undefined>, options: PlaceOptions = {}): string | null {
  // Real files looked at on disk: joined the way this machine joins them.
  const { platform, env } = opts(options), p = path;
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map(ext => ext.toLowerCase())] : [''];
  const paths = candidates.filter((item): item is string => !!item).flatMap(candidate => p.isAbsolute(candidate) ? [candidate] :
    (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean).flatMap(dir => exts.map(ext => p.join(dir, candidate + ext))));
  return paths.find(file => {
    try {
      // Windows has no execute bit: a file that exists is runnable.
      if (platform === 'win32') return fs.statSync(file).isFile();
      fs.accessSync(file, fs.constants.X_OK); return true;
    } catch { return false; }
  }) || null;
}
