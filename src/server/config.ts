import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, HERE } from './paths.js';
import type { BridgeConfig, Model } from '../shared/contract.js';
import { bag, list, get, str, parseJson } from '../shared/guards.js';
import { agentapiCommand, appAsar, bundledCodexCli, claudeCliName, claudeDesktopHome, findExecutable, installedClaudeCli } from './services/desktop-places.js';

function executable(env: string, candidates: Array<string | null | undefined>): string | null {
  if (process.env[env]) return process.env[env];
  return findExecutable(candidates);
}
function findClaude(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [], name = claudeCliName();
  function walk(dir: string, depth: number) {
    if (depth > 5) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file, depth + 1);
      else if (item.name === name) found.push(file);
    }
  }
  walk(root, 0);
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}
// The optional model catalog file: { <engine>: [{ id, name, … }] }; entries without an id are skipped.
function catalogsOf(value: unknown): Record<string, Model[]> {
  const out: Record<string, Model[]> = {};
  for (const [engine, models] of Object.entries(bag(value) || {})) {
    out[engine] = list(models).flatMap(item => { const id = str(get(item, 'id')); return id ? [{ ...bag(item), id, name: str(get(item, 'name')) || id }] : []; });
  }
  return out;
}
function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const home = os.homedir();
  const claudeDesktop = env.CLAUDE_DESKTOP_HOME || claudeDesktopHome({ env, home });
  const agentapi = env.AGENTAPI_BIN ? null : agentapiCommand(env.ANTIGRAVITY_HOME || path.join(home, '.gemini/antigravity'), { env, home });
  const agyHome = env.ANTIGRAVITY_HOME || path.join(home, '.gemini/antigravity');
  let catalogs: Record<string, Model[]> = {};
  if (env.BRIDGE_MODEL_CATALOG) catalogs = catalogsOf(parseJson(fs.readFileSync(env.BRIDGE_MODEL_CATALOG, 'utf8')));
  return {
    host: '127.0.0.1', port: Number(env.PORT || 4100), httpsPort: 0,
    certDir: env.BRIDGE_CERT_DIR || path.join(ROOT, '.certs'),
    uploadsDir: env.BRIDGE_UPLOADS_DIR || path.join(ROOT, 'uploads'),
    // The whole record of a long chat referred to from another, for an agent that reads files. Real chats: not committed.
    exportsDir: env.BRIDGE_EXPORTS_DIR || path.join(ROOT, 'exports'),
    pluginDir: env.BRIDGE_PLUGIN_DIR || path.join(HERE, 'plugins'),
    defaultCwd: env.BRIDGE_DEFAULT_CWD || home,
    codexBin: executable('CODEX_BIN', ['codex', bundledCodexCli()]),
    claudeBin: executable('CLAUDE_BIN', ['claude', installedClaudeCli(), ...findClaude(path.join(claudeDesktop, 'claude-code'))]),
    codexHome: env.CODEX_HOME || path.join(home, '.codex'),
    claudeHome: env.CLAUDE_HOME || path.join(home, '.claude'),
    chatgptAppAsar: env.CHATGPT_APP_ASAR || appAsar('codex'),
    claudeDesktopHome: claudeDesktop,
    claudeAppAsar: env.CLAUDE_APP_ASAR || appAsar('claude'),
    // Speech-to-text used by every engine's mic button; falls back to the engine's own.
    dictationEngine: env.BRIDGE_DICTATION_ENGINE || 'claude',
    // What the person chose in the console (which agents are on). Local to this checkout, not committed.
    settingsFile: env.BRIDGE_SETTINGS_FILE || path.join(ROOT, '.frontdesk.json'),
    agyHome, agentapiBin: env.AGENTAPI_BIN || agentapi?.[0] || null, agentapiArgs: env.AGENTAPI_BIN ? [] : agentapi?.[1] || [],
    catalogs,
  };
}
/** Invokes a Windows `.cmd`/`.bat` shim through `cmd.exe /d /s /c` with explicit quoting so Node 24 never warns on `shell: true`. */
function winSpawnArgs<T extends object = Record<string, unknown>>(
  file: string,
  args: readonly string[] = [],
  options: T = {} as T,
): [string, string[], T & { windowsVerbatimArguments?: boolean; windowsHide?: boolean }] {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const q = (s: string) => `"${String(s).replace(/\r?\n/g, ' ').replace(/"/g, '""').replace(/%/g, '%%')}"`;
    const line = [q(file), ...args.map(q)].join(' ');
    return [
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `"${line}"`],
      { ...options, windowsVerbatimArguments: true, windowsHide: true },
    ];
  }
  return [file, [...args], options];
}
export { loadConfig, winSpawnArgs };
