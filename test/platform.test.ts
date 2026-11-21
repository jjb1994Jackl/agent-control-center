// Where the desktop apps and their data are, per platform (services/desktop-places.ts), and the
// pieces of the bridges that depend on it. Each case names its platform, so all of them run on any machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentapiCommand, antigravityApp, antigravityIconFile, appAsar, appIconFile, bundledCodexCli, claudeCliIn, claudeDesktopHome, findExecutable,
  helperCacheDir, installedClaudeCli, linkCommand, openLink, packageRoot, setPackageLookup, PACKAGES,
} from '../src/server/services/desktop-places.js';
import { readAppIcon } from '../src/server/services/app-assets.js';
import * as codexDesktop from '../src/server/codex-desktop.js';

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-places-'));

test('Claude desktop data: ~/Library on macOS; on Windows the Claude-Data folder that holds the sessions index', () => {
  assert.equal(claudeDesktopHome({ platform: 'darwin', home: '/Users/a', env: {} }), '/Users/a/Library/Application Support/Claude');
  const local = temp(), roaming = temp();
  // No Claude-Data yet: the older %APPDATA%\Claude.
  assert.equal(claudeDesktopHome({ platform: 'win32', home: '/h', env: { LOCALAPPDATA: local, APPDATA: roaming } }), path.join(roaming, 'Claude'));
  // A publisher folder without the index is not it; the one with it is.
  fs.mkdirSync(path.join(local, 'Claude-Data', 'claude_empty'), { recursive: true });
  fs.mkdirSync(path.join(local, 'Claude-Data', 'claude_abc', 'claude-code-sessions'), { recursive: true });
  fs.writeFileSync(path.join(local, 'Claude-Data', 'README.txt'), 'not a folder');
  assert.equal(claudeDesktopHome({ platform: 'win32', home: '/h', env: { LOCALAPPDATA: local, APPDATA: roaming } }), path.join(local, 'Claude-Data', 'claude_abc'));
});

test('Claude desktop\'s own CLI inside one of its version folders', () => {
  assert.equal(claudeCliIn('/c/2.1.3/abc', { platform: 'darwin' }), '/c/2.1.3/abc/claude.app/Contents/MacOS/claude');
  assert.equal(claudeCliIn('C:\\c\\2.1.3\\abc', { platform: 'win32' }), 'C:\\c\\2.1.3\\abc\\claude.exe');
});

test('the apps\' bundles: under /Applications on macOS, inside the MSIX package folder on Windows', () => {
  const asked: string[] = [];
  setPackageLookup(name => { asked.push(name); return name === PACKAGES.codex ? 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__x' : null; });
  try {
    assert.equal(appAsar('codex', { platform: 'darwin' }), '/Applications/ChatGPT.app/Contents/Resources/app.asar');
    assert.equal(appAsar('claude', { platform: 'darwin' }), '/Applications/Claude.app/Contents/Resources/app.asar');
    assert.equal(appIconFile('codex', { platform: 'darwin' }), '/Applications/ChatGPT.app/Contents/Resources/electron.icns');
    assert.equal(bundledCodexCli({ platform: 'darwin' }), '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
    assert.equal(asked.length, 0, 'macOS asks no package manager');
    assert.equal(appAsar('codex', { platform: 'win32' }), 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__x\\app\\resources\\app.asar');
    assert.equal(bundledCodexCli({ platform: 'win32' }), 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__x\\app\\resources\\codex.exe');
    // Not installed: no path at all, so `detect` finds nothing rather than a Mac path.
    assert.equal(appAsar('claude', { platform: 'win32' }), '');
    assert.equal(packageRoot('Claude', { platform: 'linux' }), null);
  } finally { setPackageLookup(null); }
});

test('a Windows app\'s icon is its package\'s largest tile logo, served as PNG', () => {
  const root = temp(), assets = path.join(root, 'Assets');
  fs.mkdirSync(assets);
  const png = (size: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size)]);
  fs.writeFileSync(path.join(assets, 'Square150x150Logo.scale-100.png'), png(30));
  fs.writeFileSync(path.join(assets, 'Square150x150Logo.scale-200.png'), png(90));
  fs.writeFileSync(path.join(assets, 'StoreLogo.png'), png(200));
  setPackageLookup(() => root);
  try {
    const file = appIconFile('claude', { platform: 'win32' });
    assert.equal(path.basename(file), 'Square150x150Logo.scale-200.png');
    assert.deepEqual(readAppIcon(file), { type: 'image/png', data: fs.readFileSync(file) });
  } finally { setPackageLookup(null); }
});

test('Antigravity, the helper cache and the Codex router, per platform', () => {
  assert.equal(antigravityApp({ platform: 'darwin' }), '/Applications/Antigravity.app/');
  assert.equal(antigravityApp({ platform: 'win32', home: 'C:\\Users\\a', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }), 'C:\\Users\\a\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe');
  assert.equal(helperCacheDir({ platform: 'darwin', home: '/Users/a', env: {} }), '/Users/a/Library/Caches/agent-frontdesk');
  assert.equal(helperCacheDir({ platform: 'win32', home: 'C:\\Users\\a', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }), 'C:\\Users\\a\\AppData\\Local\\agent-frontdesk');
  assert.equal(codexDesktop.socketPath('/Users/a/.codex', 'darwin'), path.join('/Users/a/.codex', 'ipc', 'ipc.sock'));
  assert.equal(codexDesktop.socketPath('C:\\Users\\a\\.codex', 'win32'), '\\\\.\\pipe\\codex-ipc');
});

test('a deep link goes to the app in the background on macOS, and to the shell\'s protocol handler on Windows with no cmd.exe', async () => {
  const link = 'codex://threads/new?path=C%3A%5Cw&prompt=a%20%26%20"b"';
  assert.deepEqual(linkCommand(link, { platform: 'darwin' }), ['/usr/bin/open', ['-g', link]]);
  assert.deepEqual(linkCommand(link, { platform: 'win32' }), ['rundll32.exe', ['url.dll,FileProtocolHandler', link]]);
  const ran: Array<[string, string[]]> = [];
  await openLink(link, { platform: 'win32', run: (file, args, _options, done) => { ran.push([file, args]); done(null); } });
  assert.deepEqual(ran, [['rundll32.exe', ['url.dll,FileProtocolHandler', link]]]);
  await assert.rejects(openLink(link, { platform: 'win32', run: (_file, _args, _options, done) => done(new Error('no handler')) }), /no handler/);
});

test('Antigravity\'s agentapi: its own file on macOS; on Windows the language server the .bat runs, started directly', () => {
  const local = temp(), bin = path.join(local, 'Programs', 'Antigravity', 'resources', 'bin');
  // Not installed: nothing to run (and no shell to fall back on).
  assert.equal(agentapiCommand('/nowhere', { platform: 'win32', home: '/h', env: { LOCALAPPDATA: local } }), null);
  fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'language_server.exe'), '');
  assert.deepEqual(agentapiCommand('/nowhere', { platform: 'win32', home: '/h', env: { LOCALAPPDATA: local } }), [path.join(bin, 'language_server.exe'), ['agentapi']]);
  if (process.platform !== 'win32') {
    const agy = temp(); fs.mkdirSync(path.join(agy, 'bin')); fs.writeFileSync(path.join(agy, 'bin', 'agentapi'), '', { mode: 0o755 });
    assert.deepEqual(agentapiCommand(agy, { platform: process.platform, env: { PATH: '' } }), [path.join(agy, 'bin', 'agentapi'), []]);
  }
});

test('finding a program: PATH with PATHEXT on Windows, where any existing file runs', () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'codex.exe'), '');
  assert.equal(findExecutable(['codex'], { platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE' } }), path.join(dir, 'codex.exe'));
  assert.equal(findExecutable(['missing', null, ''], { platform: 'win32', env: { PATH: dir } }), null);
  // An absolute candidate is taken as it is.
  assert.equal(findExecutable([path.join(dir, 'codex.exe')], { platform: 'win32', env: {} }), path.join(dir, 'codex.exe'));
});

test('Antigravity\'s icon and Claude Code\'s own CLI on Windows', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  assert.equal(antigravityIconFile({ platform: 'darwin' }), '/Applications/Antigravity.app/Contents/Resources/icon.icns');
  // readAppIcon reads the /icon.png inside an app.asar in place.
  assert.equal(antigravityIconFile({ platform: 'win32', home: 'C:\\Users\\a', env }), 'C:\\Users\\a\\AppData\\Local\\Programs\\Antigravity\\resources\\app.asar');
  assert.equal(installedClaudeCli({ platform: 'darwin', home: '/Users/a' }), '');
  assert.equal(installedClaudeCli({ platform: 'win32', home: os.homedir() }), path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
});

// The low-interruption rule on Windows, held by the sources themselves: no input is sent anywhere
// (no keys, no mouse, no clipboard, no UIA focus), and only the driver's "the window" section moves
// a window or hands the foreground anywhere. An engine's flow acts only through that section
// (Begin(park), HoldForeground, Activate(), BringForward), so whatever flow is added later is as quiet.
test('Windows: no flow sends input or moves a window itself; only the driver\'s window section does', () => {
  const native = path.join(import.meta.dirname, '../src/server/native');
  const code = (file: string): string[] => fs.readFileSync(path.join(native, file), 'utf8').split('\n').map(line => line.replace(/\/\/.*$/, ''));
  // (UIA's SetFocus as a call: the COM interface declares the method, which is never called.)
  const input = /\b(SendInput|keybd_event|mouse_event|SendKeys|Clipboard|SetClipboardData|PostMessage|SendMessage)\b|\.SetFocus\s*\(/;
  const window = /\b(SetForegroundWindow|SetWindowPos|SetWindowPlacement|ShowWindow|AttachThreadInput|SwitchToThisWindow|BringWindowToTop|MoveWindow|AllowSetForegroundWindow|LockSetForegroundWindow)\s*\(/;
  const flows = fs.readdirSync(native).filter(name => name.endsWith('-desktop.cs'));
  assert.ok(flows.includes('claude-desktop.cs'), 'the Windows flows are found');
  for (const flow of flows) code(flow).forEach((line, i) => {
    assert.doesNotMatch(line, input, `${flow}:${i + 1} sends input`);
    assert.doesNotMatch(line, window, `${flow}:${i + 1} moves a window or the foreground itself`);
  });
  const raw = fs.readFileSync(path.join(native, 'uia-driver.cs'), 'utf8').split('\n'), driver = code('uia-driver.cs');
  const start = raw.findIndex(line => line.includes('// ==== the window: parked, put back, brought forward ====')), end = raw.findIndex(line => line.includes('// ==== end of the window ===='));
  assert.ok(start > 0 && end > start, 'the window section is marked');
  driver.forEach((line, i) => {
    if (/\bstatic extern\b/.test(line)) return;   // declarations
    assert.doesNotMatch(line, input, `uia-driver.cs:${i + 1} sends input`);
    if (i < start || i > end) assert.doesNotMatch(line, window, `uia-driver.cs:${i + 1} moves a window or the foreground outside the window section`);
  });
  // A window closed to the tray is not acted on, parked or brought forward: the command says why.
  const body = (name: string) => { const from = raw.findIndex(line => new RegExp(`static \\w+ ${name}\\(\\)`).test(line)); return raw.slice(from, raw.findIndex((line, i) => i > from && /^ {8}\}/.test(line))).join('\n'); };
  for (const step of ['Park', 'BringForward', 'FailPageEmpty']) assert.match(body(step), /FailIfHidden\(\);/, `${step} refuses a hidden window`);
  assert.match(body('FailIfHidden'), /IsWindowVisible\(window\)[\s\S]*Fail\("hidden"/);
  // The park lock's own code: a flow's "busy" means the chat is running, and the Claude bridge then steers.
  assert.doesNotMatch(body('Park'), /Fail\("busy"/);
  // Codex's bridge opens a chat no window owns with `settings` (pickInDesktop), on Windows too, and
  // picks a model in its menu when the router cannot; an effort other than the chat's is refused
  // before anything is touched (the slider takes only arrow keys).
  const codex = fs.readFileSync(path.join(native, 'codex-desktop.cs'), 'utf8');
  assert.match(codex, /new\[\] \{[^}]*"settings"[^}]*\}\) flowCommands\.Add/);
  const settings = codex.slice(codex.indexOf('if (command == "settings")'), codex.indexOf('Out(', codex.indexOf('if (command == "settings")')));
  assert.ok(settings.indexOf('EffortCheck(false)') > 0 && settings.indexOf('EffortCheck(false)') < settings.indexOf('PickModel('), 'the effort is checked before the model menu is touched');
});

test('Windows: Antigravity takes only show-session and open-file, and finds a conversation by its address as the Mac driver does', () => {
  const native = path.join(import.meta.dirname, '../src/server/native');
  const flow = fs.readFileSync(path.join(native, 'antigravity-desktop.cs'), 'utf8'), driver = fs.readFileSync(path.join(native, 'uia-driver.cs'), 'utf8');
  const profile = JSON.parse(fs.readFileSync(path.join(native, 'profiles/antigravity.json'), 'utf8'));
  assert.equal(profile.windows.exe, 'Antigravity.exe');
  // No commands of its own, so `check` names only the two shared ones it takes (not the chat modes').
  assert.match(flow, /new\[\] \{ "show-session", "open-file" \}\) sharedTaken\.Add/);
  assert.doesNotMatch(flow, /flowCommands\.Add/);
  assert.match(driver, /"ported", flowCommands\.Concat\(Shared\(\)\)/);
  assert.match(driver, /if \(Shared\(\)\.Contains\(command\)\) RunShared\(\);/);
  // "sessionAddress": the page's document at that path, its sidebar row the link there, scrolled both ways to it.
  assert.match(driver, /static bool IsShown\(string title, string at\) \{ return at\.Length == 0 \? Current\(\) == title : Showing\(at\); \}/);
  assert.match(driver, /foreach \(bool downward in new\[\] \{ true, false \}\)/);
  // "sessionRowsBy": "title" (main, Claude): each row with the title is pressed until the page's address is the
  // session's; the deep link only for a command that brings the desktop to the front anyway; back and Stop by address.
  assert.match(driver, /if \(at\.Length > 0 && Setting\("sessionRowsBy"\) == "title"\)/);
  assert.match(driver, /bool linkable = MayFront && /);
  assert.match(driver, /static bool MayFront \{ get \{ return command == "open-file" \|\| command == "show-session"; \} \}/);
  const claudeFlow = fs.readFileSync(path.join(native, 'claude-desktop.cs'), 'utf8');
  assert.match(claudeFlow, /previousAt = StartedAddress\(\)/);
  assert.match(claudeFlow, /if \(!IsShown\(title, target\)\) break;/);
  // "fileLink": only the chat's own links count.
  assert.match(driver, /if \(shaped != null && !Fits\(e, shaped\)\) continue;/);
});

test('Windows: a helper stopped mid-park is followed by `restore`, and a park that left something out is reported', async () => {
  const { DesktopAutomation } = await import('../src/server/core/desktop-automation.js');
  const ran: string[] = [];
  let answer: Record<string, unknown> = { ok: false, code: 'crashed', unanswered: true, error: '桌面版没有及时响应' };
  const desktop = new DesktopAutomation({ engine: 'claude', platform: 'win32', warmEveryMs: 0,
    runner: async (_file, args) => { ran.push(args[0] || ''); return args[0] === 'restore' ? { ok: true, restored: 1 } : { ok: false, ...answer }; } });
  // (A file that exists: a helper missing from the cache is built again and run once more.)
  desktop.binary = process.execPath;
  const warn = console.warn; console.warn = () => {};
  try {
    await desktop.run(['send', 'chat', 'local_1']);
    assert.deepEqual(ran, ['send', 'restore']);
    // A failure the helper answered itself (a crash it caught too) has put the window back already.
    ran.length = 0; answer = { ok: false, code: 'not_found', parked: { ms: 900, grabs: 2, heldMs: 0, placementBack: true, underSame: true, foregroundBack: true } };
    await desktop.run(['send', 'chat', 'local_1']);
    assert.deepEqual(ran, ['send']);
    assert.equal(desktop.parkTrouble(), null);
    answer = { ok: true, parked: { ms: 1400, grabs: 3, heldMs: 5200, placementBack: false, underSame: true, foregroundBack: true } };
    await desktop.run(['settings', 'chat', 'local_1']);
    assert.deepEqual(desktop.parkTrouble()?.issues, ['placement', 'held']);
    assert.equal(desktop.parkTrouble()?.command, 'settings');
    assert.equal(desktop.parkTrouble(0), null, 'only while recent');
  } finally { console.warn = warn; }
  // macOS has no parks to put back.
  const mac = new DesktopAutomation({ engine: 'claude', platform: 'darwin', warmEveryMs: 0, runner: async (_file, args) => { ran.push(`mac ${args[0]}`); return { ok: false, code: 'crashed' }; } });
  mac.binary = process.execPath; ran.length = 0;
  await mac.run(['send']);
  assert.deepEqual(ran, ['mac send']);
});

// Fewer grabs of the foreground on Windows, and none in the middle of a word the person is composing:
// every action that can make a parked page take the foreground waits first for the page to be live
// and for the person (BeforeAct), and a command that parked the window leaves it on its conversation.
test('Windows: every page action waits in BeforeAct, and a parked command does not go back to the previous conversation', () => {
  const native = path.join(import.meta.dirname, '../src/server/native');
  const raw = fs.readFileSync(path.join(native, 'uia-driver.cs'), 'utf8').split('\n');
  const body = (signature: RegExp) => { const from = raw.findIndex(line => signature.test(line)); assert.ok(from > 0, String(signature)); return raw.slice(from, raw.findIndex((line, i) => i > from && /^ {8}\}/.test(line))).join('\n'); };
  for (const action of [/static bool Press\(Node/, /static bool Expand\(Node/, /static bool Collapse\(Node/, /static bool SetValue\(Node/, /static bool Activate\(Node/, /static bool Toggle\(Node/, /static void ScrollIntoView\(/, /static void OpenLink\(/]) {
    assert.match(body(action), /BeforeAct\(\);/, `${action} waits in BeforeAct`);
  }
  const before = body(/static void BeforeAct\(\)/);
  assert.match(before, /if \(!Parking\.Active \|\| Parking\.Held\) return;/);
  assert.ok(before.indexOf('TypingUntil() > NowMs()') > 0 && before.indexOf('TypingUntil() > NowMs()') < before.indexOf('PageLive()'), 'the person first, then the page right before the action');
  assert.match(before, /Nudge\(\);\s*while \(!PageLive\(\) && shown\.ElapsedMilliseconds < SettleMs\(\)\)/);
  // A raised corner is nudged, so Chromium counts the page as shown again (a z-order change alone does not make it count).
  assert.match(body(/static bool RaiseCorner\(\)/), /Nudge\(\);\s*return CornerUp\(\);/);
  assert.match(body(/static bool PageLive\(\)/), /Chrome_RenderWidgetHostHWND/);
  // An exclusive full-screen program in front (QUNS_RUNNING_D3D_FULL_SCREEN): nothing is parked or pressed.
  const park = body(/static bool Park\(\)/);
  assert.ok(park.indexOf('ExclusiveFullscreen()') > 0 && park.indexOf('ExclusiveFullscreen()') < park.indexOf('TakeParkLock('), 'the full-screen check comes before the park');
  assert.match(body(/static bool ExclusiveFullscreen\(\)/) || raw.find(line => line.includes('static bool ExclusiveFullscreen()')) || '', /SHQueryUserNotificationState\(out state\) == 0 && state == 3/);
  // Deadlines outside the window section run on ActClock, which leaves out what BeforeAct waited: a
  // fill's few seconds are not spent waiting for the person.
  const start = raw.findIndex(line => line.includes('// ==== the window: parked, put back, brought forward ====')), end = raw.findIndex(line => line.includes('// ==== end of the window ===='));
  raw.forEach((line, i) => { if (i < start || i > end) assert.doesNotMatch(line, /DateTime\.UtcNow/, `uia-driver.cs:${i + 1} keeps a deadline on the wall clock`); });
  assert.match(raw.find(line => line.includes('static DateTime ActClock')) ?? '', /Parking\.SettledMs \+ Parking\.PersonMs/);
  // Going back: through ReturnTo in every flow, which leaves a parked window where it is but never on the new-chat page.
  for (const flow of ['claude-desktop.cs', 'codex-desktop.cs', 'uia-driver.cs']) {
    const text = fs.readFileSync(path.join(native, flow), 'utf8');
    assert.match(text, /Action back = \(\) =>[\s\S]{0,400}?ReturnTo\(previous/, `${flow} goes back through ReturnTo`);
    assert.doesNotMatch(text, /Action back = \(\) => \{[^}]*Show\(previous/, `${flow} does not show the previous conversation itself`);
  }
  assert.match(body(/static void ReturnTo\(string previous, string previousAt = ""\)/), /Parking\.Active && !staying && !newPageNames\.Contains\(command\) && Current\(\)\.Length > 0/);
  // The answer goes out before the rest of the park (a minimized window's saved bounds) is finished.
  const out = body(/static void Out\(Dictionary/);
  assert.ok(out.indexOf('Unpark(false)') >= 0 && out.indexOf('Console.WriteLine') < out.indexOf('FinishPark();'), 'the answer is written before FinishPark');
});

test('The person typing in the page marks the time the Windows helper waits until: a word being composed, renewed while it goes on, then a pause in keys', async () => {
  const { markTyping, COMPOSING_MS, KEYS_PAUSE_MS } = await import('../src/server/core/desktop-automation.js');
  const dir = temp(), file = path.join(dir, 'person-typing');
  markTyping('composing', { dir, now: 1000 });
  assert.equal(fs.readFileSync(file, 'utf8'), String(1000 + COMPOSING_MS));
  markTyping('keys', { dir, now: 2000 });
  assert.equal(fs.readFileSync(file, 'utf8'), String(2000 + KEYS_PAUSE_MS));

  const { watchTyping, RENEW_MS, KEYS_EVERY_MS } = await import('../src/client/js/composing.js');
  const target = new EventTarget(), said: string[] = [];
  let now = 0;
  const stop = watchTyping(target, typing => said.push(typing), () => now);
  const key = (isComposing = false) => target.dispatchEvent(Object.assign(new Event('keydown'), { isComposing }));
  key(); now = KEYS_EVERY_MS - 1; key(); now = KEYS_EVERY_MS; key();           // keys: at most every 0.3 s
  assert.deepEqual(said, ['keys', 'keys']);
  target.dispatchEvent(new Event('compositionstart')); key(true);              // a word: the keys inside it are its own
  now += RENEW_MS - 1; target.dispatchEvent(new Event('compositionupdate'));
  now += 1; target.dispatchEvent(new Event('compositionupdate'));
  target.dispatchEvent(new Event('compositionend'));                          // then a pause in keys is waited for
  assert.deepEqual(said, ['keys', 'keys', 'composing', 'composing', 'keys']);
  stop();
  target.dispatchEvent(new Event('compositionstart')); key();
  assert.equal(said.length, 5, 'nothing is said once stopped');
});

test('A command with no run of its own waits out an exclusive full-screen program for a while, then says nothing was done', async () => {
  const { throughFullscreen, FULLSCREEN_GAVE_UP } = await import('../src/server/core/desktop-automation.js');
  let left = 2, tries = 0, held = 0;
  const attempt = async () => { tries++; return left-- > 0 ? { ok: false, code: 'fullscreen', error: '前台的程序独占全屏，工作台没有操作Codex 桌面版' } : { ok: true }; };
  assert.deepEqual(await throughFullscreen(attempt, { everyMs: 5, maxMs: 1000, held: () => { held++; } }), { ok: true });
  assert.equal(tries, 3, 'tried again until the program was gone');
  assert.equal(held, 1, 'told once that it waits');

  left = Infinity; tries = 0; held = 0;
  const gaveUp = await throughFullscreen(attempt, { everyMs: 5, maxMs: 30, held: () => { held++; } });
  assert.equal(gaveUp.ok, false);
  assert.equal(gaveUp.code, 'fullscreen');
  assert.equal(gaveUp.error, FULLSCREEN_GAVE_UP, 'the answer says it gave up and what to do');
  assert.ok(tries >= 2 && tries <= 8, `a bounded number of tries (${tries})`);

  // Anything else answers at once, untouched.
  tries = 0;
  assert.deepEqual(await throughFullscreen(async () => { tries++; return { ok: false, code: 'not_found', error: 'x' }; }, { everyMs: 5 }), { ok: false, code: 'not_found', error: 'x' });
  assert.equal(tries, 1);
});

test('Sending through a desktop window says it takes the focus on Windows: every message of a chat mode', async () => {
  const { CHAT_CAPABILITIES } = await import('../src/server/services/desktop-chat.js');
  assert.equal(CHAT_CAPABILITIES.takesFocus, process.platform === 'win32');
});
