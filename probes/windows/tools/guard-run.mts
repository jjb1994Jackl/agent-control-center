// Claude on the person's desktop, behind Notepad, with a watchdog that gives the foreground back the moment
// Claude takes it. Phase A: fill + Send. Phase B: the model menu, Effort to Medium and back to High.
// Usage: node guard-run.mts <out.json>
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { REPO, TOOLS, PROBE, FG, DRIVER, profile, OWN_TITLE, mainWindow } from './common.mts';
// The watchdog (fgtool guard) stops when this file appears next to it.
const STOP = `${TOOLS}\guard.stop`;

const PROFILE = profile('claude');
const CLAUDE = mainWindow('claude.exe'), MINE = OWN_TITLE;
if (!MINE) { console.error('set FRONTDESK_OWN_TITLE to the title of the chat these tests must not touch'); process.exit(4); }
const TEXT = 'Frontdesk 看门狗测试：请只回复 OK，不要运行任何命令。';
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
try { fs.rmSync(STOP); } catch {}

beep(); await sleep(25000); beep();
const current = String(run(DRIVER, ['probe'], { AX_PROFILE: PROFILE }).current || '');
if (!current || current === MINE) { log.stopped = 'the Claude window does not show the test chat'; save(); process.exit(2); }
const original = run(FG, ['fg']); log.original = original;
if (original.exe?.toLowerCase() === 'claude.exe') { log.stopped = 'Claude was in front at the start'; save(); process.exit(3); }
const t0 = Date.now(), at = () => Date.now() - t0;
const guard = spawn(FG, ['guard', '90000', original.hwnd, CLAUDE], { windowsHide: true });
let guarded = ''; guard.stdout.on('data', chunk => { guarded += chunk; });
await sleep(300);
const ev = (what: string, r: any = {}) => log.events.push({ t: at(), what, ok: r.ok, used: r.used, code: r.code, refused: r.refused, name: r.target?.name, menus: [r.before?.menus, r.after?.menus] });
const until = async (want: (menus: number) => boolean, ms = 6000) => { const end = at() + ms; while (at() < end) { const s = act('--locator', 'modelMenu', '--do', 'inspect'); if (want(s.state?.menus ?? -1)) return true; await sleep(150); } return false; };

// Phase A: fill + Send.
ev('A fill', act('--locator', 'composer', '--do', 'setvalue', '--text', TEXT, '--wait', '100'));
let seen = false; for (const end = at() + 15000; at() < end;) { if (act('--locator', 'send', '--do', 'inspect').ok) { seen = true; break; } await sleep(150); }
log.events.push({ t: at(), what: seen ? 'A send seen' : 'A send never seen' });
if (seen) ev('A send', act('--locator', 'send', '--do', 'invoke', '--wait', '100'));
await sleep(2000);
// Phase B: Effort to Medium, then back to High.
ev('B read before', act('--locator', 'modelMenu', '--do', 'inspect', '--names'));
ev('B open', act('--locator', 'modelMenu', '--do', 'expand', '--wait', '200')); await until(m => m >= 1);
ev('B effort', act('--role', 'AXMenuItem', '--prefix', 'Effort', '--do', 'expand', '--wait', '200')); await until(m => m >= 2);
ev('B pick Medium', act('--role', 'AXMenuItem', '--prefix', 'Medium', '--do', 'invoke', '--wait', '400')); await until(m => m === 0, 3000);
ev('B read Medium', act('--locator', 'modelMenu', '--do', 'inspect', '--names'));
ev('B open again', act('--locator', 'modelMenu', '--do', 'expand', '--wait', '200')); await until(m => m >= 1);
ev('B effort again', act('--role', 'AXMenuItem', '--prefix', 'Effort', '--do', 'expand', '--wait', '200')); await until(m => m >= 2);
ev('B pick High', act('--role', 'AXMenuItem', '--prefix', 'High', '--do', 'invoke', '--wait', '400')); await until(m => m === 0, 3000);
ev('B read High', act('--locator', 'modelMenu', '--do', 'inspect', '--names'));
await sleep(1500);
fs.writeFileSync(STOP, '');
await new Promise(resolve => guard.on('exit', resolve));
try { fs.rmSync(STOP); } catch {}
try { log.guard = JSON.parse(guarded.trim()); } catch { log.guard = guarded; }
save();
