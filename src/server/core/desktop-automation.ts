// Runs an engine's desktop flow through macOS Accessibility (the "page object" pattern):
//   src/server/native/ax-driver.swift         the actions every flow shares (find, press, fill, menus, off-screen refresh)
//   src/server/native/<engine>-desktop.swift  what that engine's desktop is asked to do (send, new, settings…)
//   src/server/native/profiles/<engine>.json  what that desktop calls its controls (data, no code)
// The driver and the flow are compiled together, once per source version, into the person's cache
// (needs the Xcode command line tools); the profile is read each run, so renamed controls are a
// data change. Whether something really went out is decided by the engine's own record, not here.
//
// What makes a command slow is waiting on the desktop, so three things are kept between commands
// (the helper itself starts fresh each time, in a few milliseconds):
//   warmth        while the console is in use the page is read every few seconds (keepWarm), so the
//                 desktop does not put its accessibility tree away and a command never starts cold
//   the new page  while the person chooses a new chat's settings the desktop stays on its new-chat
//                 page (parked) and goes back to their conversation once the choosing is over
//   what it said  the page's controls as last read, and every menu's options for the page they were
//                 read on, so a menu the console has seen is not opened in the desktop again
// AX_TRACE=1 logs every command's time and round trips, and passes the helper's own step log through.
//
// Whether the profile still describes the desktop is watched from here too. A desktop update that
// renames a class leaves everything working in the language the profile's names were written in
// (the driver falls back to them) and breaks it in every other, so nobody testing in English would
// notice: about once a minute the warm read also asks the helper which controls have lost their
// mark (`warm check`), and what it says twice in a row is logged and shown with the engine's
// status (staleControls). A command that held something back says so in its answer (`ambiguous`,
// `unconfirmed`): that is logged as well.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

import { NATIVE } from '../paths.js';
import { helperCacheDir } from '../services/desktop-places.js';
import { arr, bag, bool, get, list, parseJson, str, text } from '../../shared/guards.js';
import type { NewControl, NewOption, NewPick } from '../../shared/contract.js';

/**
 * What the Swift helper prints (its last line, JSON): `ok`, and when it failed a `code` and an
 * `error` for the person. Each command adds its own fields (`trusted`, `running`, `pressed`,
 * `controls`, `messages`…); they stay unknown here and the engine's wrapper narrows the ones it reads.
 */
export interface HelperResult { ok: boolean; code?: string; error?: string; readonly [field: string]: unknown }
/** `onProgress`: what the helper says while it is still at work (its lines marked `progress`: a chat's reply as it is written). */
export interface RunOptions { input?: string | null; timeout?: number; env?: Record<string, string>; onProgress?: (seen: HelperResult) => void }
export type HelperRunner = (file: string, args: string[], options: RunOptions) => Promise<HelperResult>;
/** The desktop's own names for the settings a command applies, and the mode it acts in. */
export interface DesktopFlags { model?: string; effort?: string; mode?: string; space?: string }
export interface AutomationState { available: boolean; reason?: string; code?: string }
/** The new-chat page as the helper last described it: its controls and what its own menus show. */
interface PageView { controls: NewControl[]; shown: unknown; at: number }
const TRACE = !!process.env.AX_TRACE;
// A read of the page answers the requests that follow it at once (a pick, then the next card).
const VIEW_FRESH_MS = 10_000;
// A menu's options, for the page they were read on: long enough for one round of choosing (back
// and forth between the cards), short enough that a list the desktop has added to since (a new
// folder) is read again the next time its card comes up.
const OPTIONS_KEPT_MS = 60_000;
// The helper commands that work on the desktop's new-chat page and may leave it there (`--stay`):
// the shared driver's newPageCommands, and a flow's own (Codex: new-shown).
const NEW_PAGE = new Set(['new-controls', 'new-pick', 'new-leave', 'new-shown']);
// Every n-th warm read also checks the profile against the page: with a read every ten seconds,
// about once a minute. (The check reads the same page the warm read does; it presses nothing.)
const CHECK_EVERY = 6;
// A control is reported once this many checks in a row have named it: a page caught half drawn,
// or between two pages, names one once.
const CHECKS_TO_REPORT = 2;

// The helper's output line, read as a HelperResult: anything else counts as a crash.
function helperResultOf(value: unknown, crashed: () => HelperResult): HelperResult {
  const result = bag(value);
  if (!result) return crashed();
  const code = get(result, 'code'), error = get(result, 'error');
  return { ...result, ok: get(result, 'ok') === true, ...(typeof code === 'string' ? { code } : {}), ...(error != null ? { error: String(error) } : {}) };
}
const DRIVER = path.join(NATIVE, 'ax-driver.swift');
const WINDOWS_DRIVER = path.join(NATIVE, 'uia-driver.cs');
// The csc.exe of .NET Framework 4.x (64-bit first), or null.
function cscPath(windir = process.env['WINDIR'] || 'C:\\Windows'): string | null {
  for (const dir of ['Framework64', 'Framework']) {
    const file = path.join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(file)) return file;
  }
  return null;
}
// Windows has no accessibility permission; what can stop the helper is a desktop app that runs at a
// higher integrity level (as administrator) than the console: UIPI lets it read the window, not act on it.
const WINDOWS_NOT_TRUSTED = '桌面版以更高的权限运行（例如以管理员身份），工作台能读到它的界面但不能操作：请用相同的权限运行两者';
// An engine with no Windows flow yet (<engine>-desktop.cs) presses nothing there. One that has one
// says which commands it ports (`check` → `ported`); the others answer `not_ported` themselves.
const WINDOWS_NOT_PORTED = 'Windows 上的桌面代发还在移植中，暂时不能通过窗口操作发送';
// One wording for every engine (the page translates it by this exact text).
const NOT_TRUSTED = '桌面代发需要辅助功能权限：在「系统设置 → 隐私与安全性 → 辅助功能」里允许运行工作台服务的程序（例如终端），然后重启工作台';

// The helper's answer is read as soon as its line is written, not when the process ends: the Windows
// helper finishes a park after answering (a minimized window's saved bounds, up to a few seconds:
// uia-driver.cs, FinishPark), and the person need not wait for that. A park the next command makes
// meanwhile waits for the machine's park lock, which the finishing helper still holds.
function run(file: string, args: string[], { input, timeout = 30000, env, onProgress }: RunOptions = {}): Promise<HelperResult> {
  return new Promise(resolve => {
    let answered = false, pending = '';
    const answer = (result: HelperResult) => { if (!answered) { answered = true; resolve(result); } };
    const child = execFile(file, args, { timeout, maxBuffer: 64 << 20, env: { ...process.env, ...env }, windowsHide: true }, (err, stdout, stderr) => {
      if (TRACE && stderr) process.stderr.write(stderr);
      // `unanswered`: the helper was stopped (its timeout) or ended without its answer, so ran no clean-up.
      const crashed = (): HelperResult => ({ ok: false, code: 'crashed', unanswered: true, error: err?.killed ? '桌面版没有及时响应' : '桌面代发程序没有正常返回' });
      let result: HelperResult;
      // (The answer is the last line that is not one of the helper's progress lines: a helper stopped
      // while it was still reporting has given none.)
      const last = String(stdout).trim().split('\n').at(-1) ?? '';
      try { const value = parseJson(last); result = get(value, 'progress') === true ? crashed() : helperResultOf(value, crashed); } catch { result = crashed(); }
      answer(result);
    });
    child.stdout?.on('data', (chunk: string | Buffer) => {
      pending += String(chunk);
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        // Only an answer with a park report: any other helper ends right after answering.
        let value: unknown; try { value = parseJson(line.trim()); } catch { continue; }
        if (get(value, 'progress') === true) { try { onProgress?.(helperResultOf(value, () => ({ ok: false }))); } catch {} continue; }
        if (typeof get(value, 'ok') === 'boolean' && bag(get(value, 'parked'))) answer(helperResultOf(value, () => ({ ok: false, code: 'crashed' })));
      }
    });
    if (input != null) child.stdin?.end(input);
  });
}

/**
 * The person is typing in the console's page (client/js/composing.ts): the Windows helper waits before
 * each action while the time written here has not passed (uia-driver.cs, BeforeAct). An action's grab
 * of the foreground would end a word being composed, and keys typed while the app holds the foreground
 * (a menu open) go to the app's page. `composing` lasts until renewed (the page renews it while the word
 * goes on, and a word the page never ends lapses by itself); `keys` lasts until a pause in typing.
 */
export const COMPOSING_MS = 1500, KEYS_PAUSE_MS = 800;
export function markTyping(typing: 'composing' | 'keys', { dir = helperCacheDir(), now = Date.now() }: { dir?: string; now?: number } = {}): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'person-typing'), String(now + (typing === 'composing' ? COMPOSING_MS : KEYS_PAUSE_MS)));
  } catch { /* the helper then just does not wait */ }
}

/**
 * An exclusive full-screen program (a game) is in front: the Windows helper did nothing and answered
 * `fullscreen` (uia-driver.cs, ExclusiveFullscreen). A command with no run of its own the page shows as
 * waiting and can stop (a new chat, a chat mode's message, a settings change before a message) is tried
 * again every `everyMs` until the program has left the front, for at most `maxMs`; `held` is told once,
 * when it starts waiting. Still full screen after that: nothing was done, and the answer says so.
 * (A message to a session Claude's bridge sends waits as long as it takes: its run shows it and Stop takes it back.)
 */
export const FULLSCREEN_EVERY_MS = 3000, FULLSCREEN_HOLD_MS = 120_000;
export const FULLSCREEN_GAVE_UP = '前台的程序一直独占全屏，工作台没有操作桌面版：离开它后再发一次';
export async function throughFullscreen(attempt: () => Promise<HelperResult>, { everyMs = FULLSCREEN_EVERY_MS, maxMs = FULLSCREEN_HOLD_MS, held }: { everyMs?: number; maxMs?: number; held?: () => void } = {}): Promise<HelperResult> {
  const until = Date.now() + maxMs;
  let result = await attempt();
  if (result.ok || result.code !== 'fullscreen') return result;
  held?.();
  while (!result.ok && result.code === 'fullscreen' && Date.now() + everyMs <= until) {
    await new Promise(resolve => setTimeout(resolve, everyMs));
    result = await attempt();
  }
  return !result.ok && result.code === 'fullscreen' ? { ...result, error: FULLSCREEN_GAVE_UP } : result;
}

export interface AutomationOptions { engine: string; label?: string; cacheDir?: string; platform?: string; runner?: HelperRunner; parkMs?: number; warmEveryMs?: number }
/** A Windows park, as the helper reported it: `issues` names what it did not put back. */
export interface ParkNote { at: number; command: string; ms: number; heldMs: number; grabs: number; issues: string[] }
// A menu change holds the foreground about half a second (measured); several in one command, a few
// times that. Longer means the app kept it.
const HELD_TOO_LONG_MS = 4000;
/** What a park report says did not come back: `placement` (the window is not where it was), `z-order`, `foreground`, `held`. */
export function parkIssues(park: Record<string, unknown>): string[] {
  return [
    park['placementBack'] === false ? 'placement' : '',
    park['underSame'] === false ? 'z-order' : '',
    park['foregroundBack'] === false ? 'foreground' : '',
    Number(park['heldMs'] || 0) > HELD_TOO_LONG_MS ? 'held' : '',
  ].filter(Boolean);
}

class DesktopAutomation {
  engine: string; label: string; flow: string; profile: string; cacheDir: string; platform: string; runner: HelperRunner;
  binary: string | null; building: Promise<string | null> | null; state: AutomationState | null; checkedAt: number;
  queue: Promise<unknown>; waiting = 0;
  // The conversation the person had on screen before the desktop was left on its new-chat page.
  // `space`: the mode the person had, when the page was parked in another (the helper's previousSpace).
  parked: { previous: string; space: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  parkMs: number; warmEveryMs: number; warmUntil = 0; warmTimer: ReturnType<typeof setInterval> | null = null;
  view: PageView | null = null; options = new Map<string, { options: NewOption[]; at: number }>();
  // The profile's locators the last checks named (how many checks in a row), and the ones reported.
  beats = 0; suspects = new Map<string, number>(); stale: string[] = [];
  // engine: the flow and profile name ('claude' → claude-desktop.swift + profiles/claude.json);
  // label: how the person knows the app ("Claude 桌面版").
  constructor({ engine, label, cacheDir = helperCacheDir(), platform = process.platform, runner = run, parkMs = 45_000, warmEveryMs = 10_000 }: AutomationOptions) {
    this.engine = engine; this.label = label || engine; this.parkMs = parkMs; this.warmEveryMs = warmEveryMs;
    this.flow = path.join(NATIVE, `${engine}-desktop.swift`);
    this.profile = path.join(NATIVE, 'profiles', `${engine}.json`);
    this.cacheDir = cacheDir; this.platform = platform; this.runner = runner;
    this.binary = null; this.building = null; this.state = null; this.checkedAt = 0;
    this.queue = Promise.resolve();
  }
  async helper(): Promise<string | null> {
    if (this.binary) return this.binary;
    if (this.platform === 'win32') return this.windowsHelper();
    if (!this.building) this.building = (async () => {
      const source = Buffer.concat([fs.readFileSync(DRIVER), Buffer.from('\n'), fs.readFileSync(this.flow)]);
      const base = path.join(this.cacheDir, `${this.engine}-desktop-${createHash('sha1').update(source).digest('hex').slice(0, 12)}`);
      if (!fs.existsSync(base)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        // swiftc runs top-level code only from one file, so the driver and the flow become one.
        fs.writeFileSync(`${base}.swift`, source);
        await new Promise<void>((resolve, reject) => execFile('/usr/bin/xcrun', ['swiftc', '-O', `${base}.swift`, '-o', `${base}.tmp`], { timeout: 300000 }, err => err ? reject(err) : resolve()));
        fs.renameSync(`${base}.tmp`, base); fs.rmSync(`${base}.swift`, { force: true });
        this.prune(base);
      }
      return (this.binary = base);
    })().catch(() => null).finally(() => { this.building = null; });
    return this.building;
  }
  // Windows: the C# driver (uia-driver.cs) and the engine's flow (<engine>-desktop.cs, once there is
  // one), compiled with the csc.exe of .NET Framework 4.x that Windows ships: the twin of swiftc,
  // nothing downloaded or signed. Cached the same way, as <engine>-desktop-<hash>.exe.
  windowsHelper(): Promise<string | null> {
    if (!this.building) this.building = (async () => {
      const flow = path.join(NATIVE, `${this.engine}-desktop.cs`);
      const sources = [WINDOWS_DRIVER, ...(fs.existsSync(flow) ? [flow] : [])];
      const hash = createHash('sha1');
      for (const file of sources) hash.update(fs.readFileSync(file)).update('\n');
      const base = path.join(this.cacheDir, `${this.engine}-desktop-${hash.digest('hex').slice(0, 12)}.exe`);
      if (!fs.existsSync(base)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        const csc = cscPath();
        if (!csc) throw new Error('no csc.exe');
        const tmp = `${base}.tmp.exe`;
        await new Promise<void>((resolve, reject) => execFile(csc, ['/nologo', '/target:exe', '/langversion:5', '/platform:anycpu', '/optimize+', '/codepage:65001', `/out:${tmp}`,
          '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Web.Extensions.dll', ...sources], { timeout: 300000, windowsHide: true }, err => err ? reject(err) : resolve()));
        fs.renameSync(tmp, base);
        this.prune(base);
      }
      return (this.binary = base);
    })().catch(() => null).finally(() => { this.building = null; });
    return this.building;
  }
  // Every source version leaves a helper behind; the ones not built or run for a month are removed.
  // Another checkout's server may still be running an old one: a server that finds its helper gone
  // builds it again (run).
  prune(current: string): void {
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        const file = path.join(this.cacheDir, name);
        if (!name.startsWith(`${this.engine}-desktop-`) || file === current) continue;
        const { mtimeMs, atimeMs } = fs.statSync(file);
        if (Date.now() - Math.max(mtimeMs, atimeMs) > 30 * 24 * 3600_000) fs.rmSync(file, { recursive: true, force: true });
      }
    } catch {}
  }
  // { available, reason, code }. Cached briefly: permission and the app being open change rarely.
  async check(): Promise<AutomationState> {
    if (this.platform !== 'darwin' && this.platform !== 'win32') return { available: false, reason: '桌面代发只支持 macOS 和 Windows' };
    if (this.state && Date.now() - this.checkedAt < 10000) return this.state;
    const file = await this.helper();
    const windows = this.platform === 'win32';
    let state: AutomationState;
    if (!file) state = { available: false, reason: windows ? '桌面代发程序编译失败（需要 Windows 自带的 .NET Framework 4 的 csc.exe）' : '桌面代发程序编译失败（需要 Xcode 命令行工具：xcode-select --install）' };
    else {
      const result = await this.runner(file, ['check'], { timeout: 5000, env: { AX_PROFILE: this.profile } });
      state = !result.ok ? { available: false, ...(result.error !== undefined ? { reason: result.error } : {}) }
        : !result.trusted ? { available: false, reason: windows ? WINDOWS_NOT_TRUSTED : NOT_TRUSTED, code: 'not_trusted' }
        : !result.running ? { available: false, reason: `${this.label}没有在运行`, code: 'not_running' }
        // Windows: available once the engine has a flow there (<engine>-desktop.cs). Which commands it
        // ports is the engine's own: Claude's sends through its window, Codex's only starts new chats
        // (everything else of Codex's goes through its app-server and router).
        : windows && !list(result['ported']).length ? { available: false, reason: WINDOWS_NOT_PORTED, code: 'not_ported' }
        : { available: true };
    }
    this.state = state; this.checkedAt = Date.now();
    return state;
  }
  // One action at a time: they share the desktop's single window.
  serial<T>(task: () => Promise<T>): Promise<T> {
    this.waiting++;
    const next = this.queue.then(task, task).finally(() => { this.waiting--; });
    this.queue = next.catch(() => {});
    return next;
  }
  // `settings`: { model, effort, mode, space } as the desktop's own menus (or its profile) name them.
  // `space`: the desktop mode the command acts in (profile "spaces"; default its "home").
  flags(settings: DesktopFlags = {}): string[] { return (['model', 'effort', 'mode', 'space'] as const).flatMap(key => { const value = settings[key]; return value ? [`--${key}`, value] : []; }); }
  async run(args: string[], { input, timeout = 60000, settings, onProgress }: { input?: string | null; timeout?: number; settings?: DesktopFlags; onProgress?: (seen: HelperResult) => void } = {}): Promise<HelperResult> {
    const built = await this.helper();
    if (!built) return { ok: false, error: '桌面代发程序不可用' };
    return this.serial(async () => {
      const began = Date.now();
      const extra = [...this.flags(settings), ...this.returning(args, settings)];
      let file = built;
      let result = await this.runner(file, [...args, ...extra], { input, timeout, env: { AX_PROFILE: this.profile }, ...(onProgress ? { onProgress } : {}) });
      // The helper was removed from the cache while this server ran (another checkout cleaned up):
      // nothing was done, so it is built again and the command run once more.
      if (!result.ok && result.code === 'crashed' && this.binary === file && !fs.existsSync(file)) {
        this.binary = null;
        const again = await this.helper();
        if (again) { file = again; result = await this.runner(file, [...args, ...extra], { input, timeout, env: { AX_PROFILE: this.profile }, ...(onProgress ? { onProgress } : {}) }); }
      }
      // Windows: a helper stopped mid-park (past its timeout) runs no clean-up and leaves the window
      // off screen. It is put back now (the helper's `restore`), not at the next helper's start.
      if (this.platform === 'win32' && !result.ok && result['unanswered'] === true) {
        const restored = await this.runner(file, ['restore'], { timeout: 15000, env: { AX_PROFILE: this.profile } }).catch(() => null);
        if (Number(restored?.['restored'] || 0) > 0) console.warn(`[ax ${this.engine}] ${args[0]}: the helper stopped while ${this.label}'s window was parked; it was put back`);
      }
      this.noteParked(args[0] || '', result);
      if (TRACE) console.error(`[ax ${this.engine}] ${args[0]} ${Date.now() - began}ms (helper ${String(result['ms'] ?? '?')}ms, ${String(result['reads'] ?? '?')} reads)${result.ok ? '' : ` failed: ${result.code || result.error || ''}`}${result['via'] ? ` via ${JSON.stringify(result['via'])}` : ''}`);
      // Held back rather than guessed at: the profile needs a look, whoever was at the console.
      for (const field of ['ambiguous', 'unconfirmed']) if (result[field] !== undefined) console.warn(`[ax ${this.engine}] ${args[0]}: ${field} ${JSON.stringify(result[field])} (src/server/native/profiles/${this.engine}.json)`);
      return result;
    });
  }
  // ---- what a Windows park left (uia-driver.cs, "the window") ----
  // Every acting command reports its park: how long, how often the page took the foreground and for
  // how long the app was let keep it, and whether placement, z-order and foreground came back. What
  // did not come back is kept as the engine's last park (EngineStatus `park`) and logged: the window
  // not where the person left it is theirs to know about.
  lastPark: ParkNote | null = null;
  noteParked(command: string, result: HelperResult): void {
    const park = bag(result['parked']);
    if (!park) return;
    const issues = parkIssues(park);
    this.lastPark = { at: Date.now(), command, ms: Number(park['ms'] || 0), heldMs: Number(park['heldMs'] || 0), grabs: Number(park['grabs'] || 0), issues };
    if (issues.length) console.warn(`[ax ${this.engine}] ${command}: the park did not put everything back: ${issues.join(', ')} ${JSON.stringify(park)}`);
  }
  // The last park, while it is recent and something did not come back.
  parkTrouble(withinMs = 10 * 60_000): ParkNote | null { const last = this.lastPark; return last && last.issues.length && Date.now() - last.at < withinMs ? last : null; }

  // With the desktop parked on its new-chat page, a command is told which conversation the person
  // had before (`--previous`) and, when the page is in another mode than theirs, which mode
  // (`--previous-space`). A new-page command stays parked; any other one goes back there itself
  // when it is done, so the parking ends with it. A command in another of the desktop's modes
  // leaves the page as it is: its own mode has no such conversation to return to.
  returning(args: string[], settings: DesktopFlags = {}): string[] {
    const parked = this.parked, command = args[0] || '';
    if (!parked || command === 'warm' || command === 'check') return [];
    const back = this.backTo(parked);
    if (NEW_PAGE.has(command)) return back;
    if (settings.space) return [];
    this.unpark(); this.view = null;
    return back;
  }
  backTo(parked: { previous: string; space: string }): string[] { return ['--previous', parked.previous, ...(parked.space ? ['--previous-space', parked.space] : [])]; }
  unpark(): void { if (this.parked?.timer) clearTimeout(this.parked.timer); this.parked = null; }

  // ---- keeping warm ----
  // Called whenever the console shows it is in use: for a few minutes from then the page is read
  // every few seconds (the helper's `warm`: about a tenth of a second, nothing is pressed), which
  // keeps the desktop's accessibility tree built. Skipped while a command is running or waiting
  // (it reads the page itself), and it stops by itself once the console has gone quiet.
  keepWarm(ms = 3 * 60_000): void {
    if ((this.platform !== 'darwin' && this.platform !== 'win32') || this.warmEveryMs <= 0) return;
    const idle = Date.now() > this.warmUntil;
    this.warmUntil = Date.now() + ms;
    const beat = () => {
      if (Date.now() > this.warmUntil) { if (this.warmTimer) clearInterval(this.warmTimer); this.warmTimer = null; return; }
      if (this.waiting) return;
      // (Not the first read: that one starts the page's tree building and may find it half built.)
      const check = ++this.beats % CHECK_EVERY === 0;
      void this.run(check ? ['warm', 'check'] : ['warm'], { timeout: 5000 }).then(result => { if (check) this.checked(result); }).catch(() => {});
    };
    if (!this.warmTimer) { this.warmTimer = setInterval(beat, this.warmEveryMs); this.warmTimer.unref?.(); }
    if (idle) beat(); // the first sign of use starts the tree building before the first command needs it
  }
  // What a `warm check` said: `drift` (controls a mark of the page no longer finds, though their
  // name or place still does) and `differ` (controls whose ways found different things). A read
  // that did not check (the page was not built yet) says nothing either way.
  checked(result: HelperResult): void {
    if (!result.ok || result['checked'] !== true) return;
    const named = new Set([...list(result['drift']), ...list(result['differ'])].map(String));
    for (const key of [...this.suspects.keys()]) if (!named.has(key)) this.suspects.delete(key);
    for (const key of named) this.suspects.set(key, (this.suspects.get(key) ?? 0) + 1);
    const stale = [...this.suspects].filter(([, seen]) => seen >= CHECKS_TO_REPORT).map(([key]) => key).sort();
    if (stale.join() === this.stale.join()) return;
    this.stale = stale;
    console.warn(stale.length
      ? `[ax ${this.engine}] ${this.label}的界面和 src/server/native/profiles/${this.engine}.json 对不上了：${stale.join('、')} 现在只能按名字或位置找到（非英文界面下可能找不到）。用辅助程序的 inspect / probe 更新这些控件的认法`
      : `[ax ${this.engine}] ${this.label}的界面和配置重新对上了`);
  }
  /** The profile's locators the desktop no longer matches (see `checked`): shown with the engine's status. */
  staleControls(): string[] { return this.stale; }

  // ---- the new-chat page ----
  // One of the helper's new-page commands, with the desktop left on the page afterwards (`--stay`).
  // The first one remembers the conversation it left, and the mode when it had to switch to reach
  // the page; `parkMs` after the last one the desktop is sent back to both (leaveNewPage), unless
  // another command has gone back there already.
  async newPage(args: string[]): Promise<HelperResult> {
    const result = await this.run([...args, '--stay']);
    const previous = str(result['previous']), space = str(result['previousSpace']);
    if (result['stayed'] === true && (previous || space || this.parked)) {
      const timer = setTimeout(() => { void this.leaveNewPage(); }, this.parkMs);
      timer.unref?.();
      const kept = previous || this.parked?.previous || '', keptSpace = space || this.parked?.space || '';
      this.unpark();
      this.parked = { previous: kept, space: keptSpace, timer };
    }
    // Every answer describes the page as it is now.
    if (result['controls'] !== undefined) this.see(newControlsOf(result['controls']), result['shown']);
    // A command that ended without saying where it left the desktop (it crashed, or was stopped
    // for taking too long) may have left it on the page: it is sent back now rather than at the
    // end of a parking nobody is renewing.
    if (!result.ok && result['stayed'] === undefined && this.parked) void this.leaveNewPage();
    return result;
  }
  // The desktop goes back to the person's conversation and mode, if it is still on the page, nobody
  // is writing there and the person is not in the desktop app (the helper's new-leave decides:
  // somebody who has come to the desktop, or started a chat of their own on that page, keeps it).
  // Either way the parking is over.
  async leaveNewPage(): Promise<void> {
    const parked = this.parked;
    if (!parked) return;
    this.unpark();
    await this.run(['new-leave', ...this.backTo(parked)], { timeout: 20000 }).catch(() => {});
  }
  // A menu's options belong to the page they were read on: the same menu lists other things once
  // another control has changed (a folder menu under another environment), and marks another row.
  optionsKey(label: string, controls: readonly NewControl[]): string { return `${label}\n${JSON.stringify(controls.map(item => [item.label, item.value]))}`; }
  see(controls: NewControl[], shown: unknown): void {
    for (const item of controls) if (item.options) this.options.set(this.optionsKey(item.label, controls), { options: item.options, at: Date.now() });
    this.view = { controls: controls.map(({ options: _, ...rest }) => rest), shown, at: Date.now() };
  }
  // The controls with the options the console already has for them.
  remembered(controls: readonly NewControl[]): NewControl[] {
    return controls.map(item => {
      if (item.kind !== 'menu' || item.options) return item;
      const kept = this.options.get(this.optionsKey(item.label, controls));
      return kept && Date.now() - kept.at < OPTIONS_KEPT_MS ? { ...item, options: kept.options } : item;
    });
  }
  // What the page asks for: { ok, controls: [{ kind, label, value, options? }], shown }. `read`:
  // the menus whose options are wanted; a menu is opened in the desktop (about a second) only when
  // its options for this page are not known yet. `fresh`: forget what is known and read it all again.
  async newControls(read: readonly string[] = [], { fresh = false }: { fresh?: boolean } = {}): Promise<HelperResult> {
    if (fresh) { this.view = null; this.options.clear(); }
    let view = this.view, last: HelperResult | null = null;
    if (!view || Date.now() - view.at > VIEW_FRESH_MS) {
      last = await this.newPage(['new-controls']);
      if (!last.ok) return last;
      view = this.view;
    }
    const missing = (controls: readonly NewControl[]) => read.map(String).filter(label => this.remembered(controls).some(item => item.label === label && item.kind === 'menu' && !item.options));
    const unread = view ? missing(view.controls) : [];
    if (unread.length) {
      last = await this.newPage(['new-controls', ...unread]);
      if (!last.ok) return last;
      view = this.view;
    }
    return { ...last, ok: true, controls: this.remembered(view?.controls || []), shown: view?.shown };
  }
  // `picks`: [{ control, option }], made in order on the page; answers the controls as they are
  // afterwards (with the options already known for them) and `picked`, the controls that took theirs.
  async newPick(picks: readonly NewPick[] | string, option?: string): Promise<HelperResult> {
    const wanted = typeof picks === 'string' ? [{ control: picks, option: String(option) }] : picks;
    const result = await this.newPage(['new-pick', ...wanted.flatMap(item => [String(item.control), String(item.option)])]);
    return result['controls'] === undefined ? result : { ...result, controls: this.remembered(newControlsOf(result['controls'])) };
  }
  // Opens a file from the chat in the desktop itself (the driver's open-file): the conversation
  // (`title`, plus `localId` where the profile's sessionLink needs one) is shown, the chat's own
  // link to the file pressed, and the desktop brought to the front. { ok, pressed }: pressed is
  // false when no link in the chat matched (the conversation is still shown).
  openFile({ title, localId, path: file, absolute, label }: { title?: string; localId?: string | null; path?: string; absolute?: string; label?: string }): Promise<HelperResult> {
    return this.run(['open-file', String(title || ''), localId || '-', String(file || ''), String(absolute || ''), String(label || '')], { timeout: 30000 });
  }
  // Takes the person to a conversation in the desktop itself (the driver's show-session): shown
  // in its mode (`space`, default the profile's home) and the desktop brought to the front.
  showSession({ title, localId, space }: { title?: string; localId?: string | null; space?: string }): Promise<HelperResult> {
    return this.run(['show-session', String(title || ''), localId || '-'], { timeout: 30000, settings: space ? { space } : {} });
  }
}

// What a helper's `controls` say (the "New session" page's menus and toggles, ax-driver.swift's
// describe()): each { kind, label, value, options? }. An entry of any other kind is not a control.
function newControlsOf(value: unknown): NewControl[] {
  return list(value).flatMap((item): NewControl[] => {
    const kind = get(item, 'kind');
    if (kind !== 'menu' && kind !== 'toggle') return [];
    const options = arr(get(item, 'options'));
    return [{ kind, label: text(get(item, 'label')), value: text(get(item, 'value')),
      ...(options ? { options: options.map((option): NewOption => ({ label: text(get(option, 'label')), section: str(get(option, 'section')), selected: bool(get(option, 'selected')) })) } : {}) }];
  });
}

export { DesktopAutomation, run, NOT_TRUSTED, newControlsOf };
