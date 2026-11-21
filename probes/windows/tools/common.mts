// What the test runners in this folder share: where the built tools are, the repository, the
// profiles, and the two guards every runner keeps (the Claude window found anew each run, and the
// title of the chat the runner must never act on: the one whose session is running the tests).
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The repository this folder is in. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Where build-tools.ps1 puts the built helpers (FRONTDESK_TOOLS overrides it). */
export const TOOLS = process.env.FRONTDESK_TOOLS || path.join(process.env.LOCALAPPDATA || '', 'agent-frontdesk', 'tools');
export const PROBE = path.join(TOOLS, 'uia-probe.exe'), FG = path.join(TOOLS, 'fgtool.exe'), DRIVER = path.join(TOOLS, 'uia-driver.exe');
export const profile = (engine: string) => path.join(REPO, 'src', 'server', 'native', 'profiles', `${engine}.json`);
/** The title of the chat a runner must not act on (the session running the tests); required for Claude runs. */
export const OWN_TITLE = process.env.FRONTDESK_OWN_TITLE || '';
const json = (file: string, args: string[]): any => { try { return JSON.parse(execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim().split('\n').at(-1)!); } catch { return {}; } };
/** The app's main window now: the largest visible, non-minimized one of its exe. */
export function mainWindow(exe: string): string {
  const listing = json(PROBE, ['windows']);
  return (listing.windows || []).filter((w: any) => w.exe.toLowerCase() === exe && w.visible).sort((a: any, b: any) => Number(a.minimized) - Number(b.minimized) || b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3])[0]?.hwnd || '';
}
