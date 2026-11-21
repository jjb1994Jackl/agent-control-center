// Test 3 on desktop 2: Claude's model menu and its Effort submenu, a real change and back, then the
// foreground given back. Usage: node menu2-run.mts <out.json>
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { REPO, TOOLS, PROBE, FG, DRIVER, profile, OWN_TITLE, mainWindow } from './common.mts';

const PROFILE = profile('claude');
const CLAUDE = mainWindow('claude.exe'), MINE = OWN_TITLE;
if (!MINE) { console.error('set FRONTDESK_OWN_TITLE to the title of the chat these tests must not touch'); process.exit(4); }
const out = process.argv[2]!;
const run = (file: string, args: string[], env: Record<string, string> = {}): any => {
  try { return JSON.parse(execFileSync(file, args, { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 30000 }).trim().split('\n').at(-1)!); }
  catch (err: any) { try { return JSON.parse(String(err.stdout).trim().split('\n').at(-1)!); } catch { return { ok: false, error: String(err.message).slice(0, 200) }; } }
};
const act = (...args: string[]) => run(PROBE, ['act', '--hwnd', CLAUDE, '--profile', PROFILE, ...args]);
const beep = () => { try { execFileSync('powershell.exe', ['-NoProfile', '-Command', '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 600'], { windowsHide: true }); } catch {} };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const log: any = { events: [] };
const save = () => fs.writeFileSync(out, JSON.stringify(log, null, 2));

beep(); await sleep(15000); beep();
const current = String(run(DRIVER, ['probe'], { AX_PROFILE: PROFILE }).current || '');
if (!current || current === MINE) { log.stopped = 'the Claude window does not show the test chat'; save(); process.exit(2); }
const original = run(FG, ['fg']); log.original = original;
const t0 = Date.now(), at = () => Date.now() - t0;
const watcher = spawn(FG, ['watch', '30000', original.hwnd], { windowsHide: true });
let watched = ''; watcher.stdout.on('data', chunk => { watched += chunk; });
const step = (what: string, ...args: string[]) => { const r = act(...args); log.events.push({ t: at(), what, ok: r.ok, used: r.used, code: r.code, refused: r.refused, name: r.target?.name, menus: [r.before?.menus, r.after?.menus] }); return r; };
// Waits until the open menus number `want` (the tree of a cloaked window can lag).
const until = async (want: (menus: number) => boolean, ms = 6000) => { const end = at() + ms; while (at() < end) { const s = act('--locator', 'modelMenu', '--do', 'inspect'); if (want(s.state?.menus ?? -1)) return s.state?.menus; await sleep(200); } return null; };

step('read: the model button before', '--locator', 'modelMenu', '--do', 'inspect', '--names');
step('open: Expand on the model button', '--locator', 'modelMenu', '--do', 'expand', '--wait', '300');
log.events.push({ t: at(), what: 'menu seen open', menus: await until(m => m >= 1) });
step('submenu: Expand on Effort', '--role', 'AXMenuItem', '--prefix', 'Effort', '--do', 'expand', '--wait', '300');
log.events.push({ t: at(), what: 'submenu seen open', menus: await until(m => m >= 2) });
step('pick: Invoke on Medium', '--role', 'AXMenuItem', '--prefix', 'Medium', '--do', 'invoke', '--wait', '600');
log.events.push({ t: at(), what: 'menus after the pick', menus: await until(m => m === 0, 3000) });
step('read: the model button after Medium', '--locator', 'modelMenu', '--do', 'inspect', '--names');
// Back to High, the same way.
step('open again: Expand', '--locator', 'modelMenu', '--do', 'expand', '--wait', '300'); await until(m => m >= 1);
step('submenu again: Expand on Effort', '--role', 'AXMenuItem', '--prefix', 'Effort', '--do', 'expand', '--wait', '300'); await until(m => m >= 2);
step('restore: Invoke on High', '--role', 'AXMenuItem', '--prefix', 'High', '--do', 'invoke', '--wait', '600'); await until(m => m === 0, 3000);
step('read: the model button after High', '--locator', 'modelMenu', '--do', 'inspect', '--names');
log.events.push({ t: at(), what: 'foreground given back', ...run(FG, ['restore', original.hwnd]) });
await new Promise(resolve => watcher.on('exit', resolve));
try { log.foreground = JSON.parse(watched.trim()).changes; } catch { log.foreground = watched; }
save();
