// Tests 1 + 2 on desktop 2: fill, wait for Send to show in the tree, Send, give the foreground back.
// Usage: node focus-run.mts <out.json>
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { REPO, TOOLS, PROBE, FG, DRIVER, profile, OWN_TITLE, mainWindow } from './common.mts';

const PROFILE = profile('claude');
const CLAUDE = mainWindow('claude.exe'), MINE = OWN_TITLE;
if (!MINE) { console.error('set FRONTDESK_OWN_TITLE to the title of the chat these tests must not touch'); process.exit(4); }
const TEXT = process.env.TEXT || 'Frontdesk 焦点归还测试：请只回复 OK，不要运行任何命令。';
const NUDGE = process.env.NUDGE !== '0', LIMIT = Number(process.env.LIMIT || 12000);
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
const original = run(FG, ['fg']);
log.original = original;
// One clock for everything: the watcher's, started now.
const t0 = Date.now(), at = () => Date.now() - t0;
const watcher = spawn(FG, ['watch', String(LIMIT + 8000), original.hwnd], { windowsHide: true });
let watched = ''; watcher.stdout.on('data', chunk => { watched += chunk; });
const ev = (what: string, extra: object = {}) => log.events.push({ t: at(), what, ...extra });

ev('fill start');
const fill = act('--locator', 'composer', '--do', 'setvalue', '--text', TEXT, '--wait', '100');
ev('fill done', { ok: fill.ok, used: fill.used, refused: fill.refused });
let sendAt: number | null = null, nudged = false, tries = 0;
while (at() < LIMIT) {
  tries++;
  const look = act('--locator', 'send', '--do', 'inspect');
  if (look.ok) { sendAt = at(); break; }
  if (NUDGE && !nudged && at() > 2500) { nudged = true; const scroll = act('--locator', 'composer', '--do', 'scroll', '--wait', '100'); ev('nudge: ScrollIntoView on the composer', { ok: scroll.ok }); }
  await sleep(150);
}
ev(sendAt ? 'send seen in the tree' : 'send never seen', { tries });
if (sendAt) {
  const send = act('--locator', 'send', '--do', 'invoke', '--wait', '100');
  ev('send invoked', { ok: send.ok, used: send.used });
  const back = run(FG, ['restore', original.hwnd]);
  ev('foreground given back', back);
}
await new Promise(resolve => watcher.on('exit', resolve));
try { log.foreground = JSON.parse(watched.trim()).changes; } catch { log.foreground = watched; }
save();
