// One round of the menu tests, started by node (as the Frontdesk server would start the helper).
// Usage: node --import tsx menu-run.mts <plan.json> <out.json>   (see README.md)
// plan: { waitSeconds, guard?: { engine, title }, steps: [{ label, engine, args: [...probe act args], pauseMs? }] }
// Before every step and after it: the foreground window, and which window is drawn at the centre of
// Codex's and Claude's windows. A guard checks the Claude window shows the named test chat first.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { REPO, TOOLS, PROBE, FG, DRIVER, profile, OWN_TITLE, mainWindow } from './common.mts';

const PROFILES: Record<string, string> = { codex: profile('codex'), claude: profile('claude') };
const [planFile, outFile] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile!, 'utf8'));
const json = (file: string, args: string[], env: Record<string, string> = {}): any => {
  try { return JSON.parse(execFileSync(file, args, { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 60000 }).trim().split('\n').at(-1)!); }
  catch (err: any) { try { return JSON.parse(String(err.stdout).trim().split('\n').at(-1)!); } catch { return { ok: false, error: String(err.message).slice(0, 200) }; } }
};
const windows = (): Record<string, string> => {
  const listing = json(PROBE, ['windows']);
  const pick = (exe: string) => (listing.windows || []).filter((w: any) => w.exe.toLowerCase() === exe && w.visible).sort((a: any, b: any) => Number(a.minimized) - Number(b.minimized) || b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3])[0]?.hwnd;
  return { codex: pick('chatgpt.exe'), claude: pick('claude.exe') };
};
const hwnds = windows();
const snap = () => {
  const fg = json(PROBE, ['fg']).foreground;
  const top = (engine: string) => hwnds[engine] ? json(PROBE, ['ontop', '--hwnd', hwnds[engine]!]).onTop?.exe ?? '?' : '-';
  // Whether Claude's window is cloaked (on another virtual desktop) and on the desktop the person is looking at.
  const claudeWindow = (json(PROBE, ['windows']).windows || []).find((w: any) => w.hwnd === hwnds.claude);
  return { fg: fg ? `${fg.exe} ${fg.hwnd}` : null, onTopCodex: top('codex'), onTopClaude: top('claude'), claudeCloaked: claudeWindow?.cloaked, claudeOnCurrentDesktop: claudeWindow?.onCurrentDesktop };
};
const beep = () => { try { execFileSync('powershell.exe', ['-NoProfile', '-Command', '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 600'], { windowsHide: true }); } catch {} };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const log: any[] = [{ hwnds, startedAt: new Date().toISOString() }];
const save = () => fs.writeFileSync(outFile!, JSON.stringify(log, null, 2));
beep();
await sleep((plan.waitSeconds ?? 10) * 1000);
beep();
if (plan.guard) {
  const probe = json(DRIVER, ['probe'], { AX_PROFILE: PROFILES[plan.guard.engine]! });
  const current = String(probe.current || '');
  log.push({ guard: plan.guard, current: current.slice(0, 80) });
  const wrong = plan.guard.title ? current !== plan.guard.title : (!current || current === (plan.guard.notTitle || OWN_TITLE));
  if (wrong) { log.push({ stopped: 'the Claude window does not show the test chat: nothing was done' }); save(); process.exit(2); }
}
log.push({ before: snap() });
for (const step of plan.steps) {
  // A pause of its own before this step (a beep, then the wait, then a beep): time to put Notepad back in front.
  if (step.waitSeconds) { beep(); await sleep(step.waitSeconds * 1000); beep(); }
  const before = snap();
  const result = json(PROBE, ['act', '--hwnd', hwnds[step.engine]!, '--profile', PROFILES[step.engine]!, ...step.args, '--wait', String(step.pauseMs ?? 900)]);
  const after = snap();
  log.push({ label: step.label, before, after, result: { ok: result.ok, name: result.target?.name, patterns: result.target?.patterns, used: result.used, code: result.code, refused: result.refused, error: result.error, menus: [result.before?.menus, result.after?.menus], rows: [result.before?.menuItems, result.after?.menuItems], fgChanged: result.foregroundChanged, cameForward: result.targetCameForward, onTop: [result.before?.onTop?.exe, result.after?.onTop?.exe], expandAfter: result.targetAfter?.expandState, valueTook: result.valueTookExactly, watch: result.after?.watch } });
  save();
}
save();
