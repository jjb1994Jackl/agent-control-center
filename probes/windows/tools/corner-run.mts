// Claude behind another app, parked off screen with one corner left, then put back (corner.cs).
// Usage: node corner-run.mts <fill|menu> <out dir>
//   fill: Value.SetValue on the composer, wait for Send, Invoke Send
//   menu: model menu → Effort → Medium, read the button; the same back to High; read it
// Refuses unless the Claude window shows a chat other than FRONTDESK_OWN_TITLE and another app is in front.
// The screen recorder's frames go to <out dir>\screen: they show the person's screen, keep them in out\.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS, PROBE, FG, DRIVER, profile, OWN_TITLE, mainWindow } from './common.mts';

const [what, outDir] = process.argv.slice(2);
// close: an open model menu left by a run is closed by picking the current Effort (High) again.
// GUARD_STEPS=off: the watchdog only logs during the steps and gives the foreground back after them.
if (!['fill', 'menu', 'close'].includes(what!) || !outDir) { console.error('usage: corner-run.mts <fill|menu|close> <out dir>'); process.exit(4); }
if (!OWN_TITLE) { console.error('set FRONTDESK_OWN_TITLE to the title of the chat these tests must not touch'); process.exit(4); }
const PROFILE = profile('claude'), CLAUDE = mainWindow('claude.exe');
const TEXT = process.env.TEXT || 'Frontdesk 挪角测试：请只回复 OK，不要运行任何命令。';
const run = (file: string, args: string[], env: Record<string, string> = {}): any => {
  try { return JSON.parse(execFileSync(file, args, { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 180000, maxBuffer: 64 << 20 }).trim().split('\n').at(-1)!); }
  catch (err: any) { try { return JSON.parse(String(err.stdout).trim().split('\n').at(-1)!); } catch { return { ok: false, error: String(err.message).slice(0, 300) }; } }
};
fs.mkdirSync(outDir, { recursive: true });
const stop = (why: string, code: number) => { fs.writeFileSync(path.join(outDir, 'stopped.json'), JSON.stringify({ stopped: why })); console.log(JSON.stringify({ stopped: why })); process.exit(code); };

const current = String(run(DRIVER, ['probe'], { AX_PROFILE: PROFILE }).current || '');
if (!current || current === OWN_TITLE) stop('the Claude window does not show the test chat', 2);
const fg = run(FG, ['fg']);
if (String(fg.exe).toLowerCase() === 'claude.exe') stop('Claude is in front', 3);
const composer = run(PROBE, ['act', '--hwnd', CLAUDE, '--profile', PROFILE, '--locator', 'composer', '--do', 'inspect']);
// ONLY_IF_CURRENT: text an earlier run of ours left unsent; the fill may replace exactly that and nothing else.
const ONLY_IF = process.env.ONLY_IF_CURRENT || '';
if (what === 'fill' && !ONLY_IF && (composer.target?.valueLength ?? 99) > 1) stop(`the composer is not empty (${composer.target?.valueLength} characters)`, 5);

const read = (label: string) => ({ label, args: { locator: 'modelMenu', do: 'inspect', names: true } });
const steps = what === 'fill'
  ? [
      { label: 'fill', args: { locator: 'composer', do: 'setvalue', text: TEXT, ...(ONLY_IF ? { 'only-if-current': ONLY_IF } : {}) }, until: { found: 'send' }, timeoutMs: 15000 },
      { label: 'send', args: { locator: 'send', do: 'invoke' } },
      { label: 'composer after', args: { locator: 'composer', do: 'inspect' } },
    ]
  : what === 'close'
  ? [
      read('button before'),
      { label: 'open Effort', args: { role: 'AXMenuItem', prefix: 'Effort', do: 'expand' }, until: { menus: '>=2' } },
      { label: 'pick High (current)', args: { role: 'AXMenuItem', prefix: 'High', do: 'invoke' }, until: { menus: '==0' }, timeoutMs: 3000 },
      read('button after'),
    ]
  : [
      read('button before'),
      { label: 'open model menu', args: { locator: 'modelMenu', do: 'expand' }, until: { menus: '>=1' } },
      { label: 'open Effort', args: { role: 'AXMenuItem', prefix: 'Effort', do: 'expand' }, until: { menus: '>=2' } },
      { label: 'pick Medium', args: { role: 'AXMenuItem', prefix: 'Medium', do: 'invoke' }, until: { menus: '==0' }, timeoutMs: 3000 },
      read('button after Medium'),
      { label: 'open model menu again', args: { locator: 'modelMenu', do: 'expand' }, until: { menus: '>=1' } },
      { label: 'open Effort again', args: { role: 'AXMenuItem', prefix: 'Effort', do: 'expand' }, until: { menus: '>=2' } },
      { label: 'pick High', args: { role: 'AXMenuItem', prefix: 'High', do: 'invoke' }, until: { menus: '==0' }, timeoutMs: 3000 },
      read('button after High'),
    ];
const stepsFile = path.join(outDir, 'steps.json');
fs.writeFileSync(stepsFile, JSON.stringify(steps));
const result = run(path.join(TOOLS, 'corner.exe'), ['run', '--claude', CLAUDE, '--probe', PROBE, '--profile', PROFILE, '--steps', stepsFile,
  '--out', path.join(outDir, 'corner.json'), '--cap', path.join(TOOLS, 'screencap.exe'), '--capdir', path.join(outDir, 'screen'), '--park', process.env.PARK || 'true', '--guard-steps', process.env.GUARD_STEPS || 'on', '--tail', process.env.TAIL || '6000']);
// The guard's check after the run: which chat the window shows now.
result.shownAfter = String(run(DRIVER, ['probe'], { AX_PROFILE: PROFILE }).current || '') === current ? 'the test chat' : 'another chat';
result.text = what === 'fill' ? TEXT : undefined;
fs.writeFileSync(path.join(outDir, 'corner.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ check: result.check, seqOk: result.seq?.ok, out: outDir }));
