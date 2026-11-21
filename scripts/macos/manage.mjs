import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
const root = fileURLToPath(new URL('../..', import.meta.url));
const name = 'Agent Control Center Preview';
const label = 'io.github.agentcontrolcenter.preview.' + createHash('sha256').update(home).digest('hex').slice(0, 12);
const base = path.join(home, 'Library/Application Support', name);
const bundle = path.join(home, 'Applications', `${name}.app`);
const runtime = path.join(base, 'runtime'), control = path.join(base, 'control');
const receipt = path.join(base, 'install.json');
const data = path.join(base, 'data'), logs = path.join(base, 'logs');
const startup = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
const sessionOnly = path.join(base, `${label}.plist`);
const domain = `gui/${process.getuid()}`, job = `${domain}/${label}`;
const host = path.join(bundle, 'Contents/MacOS/AgentControlCenter');
const previewId = 'io.github.agentcontrolcenter.preview';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const launch = '/bin/launchctl';
const command = (bin, args, options = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 30000, ...options });
function run(bin, args, options) {
  const result = command(bin, args, options);
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || `${bin} ${args[0]} failed`);
  return result.stdout?.trim() || '';
}
const loaded = () => command(launch, ['print', job]).status === 0;
async function stop(port) {
  if (!loaded()) return;
  const result = command(launch, ['bootout', job]);
  if (result.status !== 0 && !result.stderr?.includes('No such process'))
    throw new Error(result.stderr?.trim() || 'Could not stop the workbench.');
  for (let i = 0; i < 80; i++) {
    if (!loaded() && await portFree(port)) return;
    await delay(125);
  }
  throw new Error('The previous workbench did not exit; the installation was not replaced.');
}
const load = login => run(launch, ['bootstrap', domain, login ? startup : sessionOnly]);
const config = () => JSON.parse(fs.readFileSync(receipt, 'utf8'));
const write = (file, value, mode = 0o600) => {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, value, { mode, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
};
const xml = value => String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const plistValue = value => {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (Number.isInteger(value)) return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`;
  if (typeof value === 'object') return `<dict>${Object.entries(value).map(([key, val]) => `<key>${xml(key)}</key>${plistValue(val)}`).join('\n')}</dict>`;
  return `<string>${xml(value)}</string>`;
};
const plist = value => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(value)}</plist>\n`;
const url = (port, route = '') => `http://127.0.0.1:${port}/${route}`;
async function api(port, route) {
  const res = await fetch(url(port, route), { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function alive(port) {
  if (!loaded()) return false;
  try { return (await api(port, 'api/health')).instance === label; }
  catch { return false; }
}
async function wait(port) {
  for (let i = 0; i < 60; i++) {
    if (await alive(port)) return;
    await delay(250);
  }
  throw new Error(`Workbench did not start. See ${path.join(logs, 'server-error.log')}`);
}
async function portFree(port) {
  const server = net.createServer();
  return new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
async function checkIdle(port) {
  if (!await alive(port)) return;
  const activities = await api(port, 'api/activity');
  const tasks = await api(port, 'api/tasks');
  if (JSON.stringify(activities).includes('"running"') || tasks.some(item => ['sending', 'queued', 'running', 'waiting'].includes(item.state)))
    throw new Error('Finish or cancel active workbench tasks before stopping/upgrading the service.');
}
function makeHost() {
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  if (fs.existsSync(bundle)) {
    if (run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')]) !== previewId)
      throw new Error(`Another app already exists at ${bundle}`);
    run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
    return;
  }
  // Keep the locally signed bundle unchanged across ordinary server upgrades (macOS permission identity).
  const temp = fs.mkdtempSync(path.join(path.dirname(bundle), '.acc-host-'));
  try {
    const staged = path.join(temp, 'Host.app');
    const contents = path.join(staged, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    const info = fs.readFileSync(path.join(root, 'scripts/macos/AgentControlCenter-Info.plist'), 'utf8')
      .replaceAll('Agent Control Center', name)
      .replace('</dict>', `<key>ACCLauncherFile</key><string>${xml(control)}</string>\n</dict>`);
    fs.writeFileSync(path.join(contents, 'Info.plist'), info);
    run('/usr/bin/xcrun', ['swiftc', '-O', path.join(root, 'scripts/macos/service-host.swift'), '-o', path.join(contents, 'MacOS/AgentControlCenter')], { timeout: 180000 });
    run('/usr/bin/codesign', ['--sign', '-', staged]);
    run('/usr/bin/codesign', ['--verify', '--strict', staged]);
    fs.renameSync(staged, bundle);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function registration(port, login) {
  return plist({ Label: label, ProgramArguments: [host, '--serve', process.execPath, path.join(runtime, 'scripts/start-local.mjs')],
    WorkingDirectory: runtime, RunAtLoad: true, KeepAlive: login, ThrottleInterval: 10, LimitLoadToSessionType: 'Aqua',
    StandardOutPath: path.join(logs, 'server.log'), StandardErrorPath: path.join(logs, 'server-error.log'),
    EnvironmentVariables: { HOME: home, PATH: [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
      ACC_MANAGED: '1', ACC_INSTANCE: label, ACC_START_DESKTOPS: login ? '1' : '0', PORT: String(port), ACC_TASK_FILE: path.join(data, 'tasks.sqlite'),
      BRIDGE_SETTINGS_FILE: path.join(data, 'agents.json'), BRIDGE_UPLOADS_DIR: path.join(data, 'uploads'), BRIDGE_EXPORTS_DIR: path.join(data, 'exports') } });
}
async function install(args) {
  if (args.some(arg => !['--login', '--no-login', '--no-open'].includes(arg)) || (args.includes('--login') && args.includes('--no-login')))
    throw new Error('Usage: ./install.sh [--login | --no-login] [--no-open]');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'darwin' || major < 22 || (major === 22 && minor < 16)) throw new Error('macOS and Node.js 22.16+ are required. https://nodejs.org/');
  run(launch, ['print', domain]);
  const npm = command('npm', ['--version']);
  if (npm.status !== 0) throw new Error('npm is required. Reinstall Node.js with npm.');
  if (command('/usr/bin/xcode-select', ['-p']).status !== 0) throw new Error('Install Apple Command Line Tools: xcode-select --install');
  const previous = fs.existsSync(receipt) ? config() : null;
  const port = Number(process.env.PORT || previous?.port || 4100);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
  if (!(previous?.port === port && await alive(port)) && !await portFree(port)) throw new Error(`Port ${port} is already in use. Try PORT=4101 ./install.sh.`);
  let login = args.includes('--login') || (!args.includes('--no-login') && previous?.login === true);
  if (!previous && !args.some(arg => ['--login', '--no-login'].includes(arg)) && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { login = /^(y|yes)$/i.test((await prompt.question('Start at Mac login and open enabled Agents in the background? 登录 Mac 后自启？ [y/N] ')).trim()); }
    finally { prompt.close(); }
  }
  for (const dir of [base, data, logs]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(startup), { recursive: true });
  const stage = fs.mkdtempSync(path.join(base, '.build-'));
  const backup = path.join(stage, 'previous'), next = path.join(stage, 'next');
  fs.mkdirSync(next);
  let replaced = false;
  try {
    for (const file of ['package.json', 'package-lock.json', 'tsconfig.base.json', 'tsconfig.server.json', 'vite.config.ts', 'src', 'scripts', 'docs', 'skills', 'LICENSE'])
      fs.cpSync(path.join(root, file), path.join(next, file), { recursive: true });
    const npmOptions = { cwd: next, stdio: 'inherit', timeout: 600000 };
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], npmOptions);
    run('npm', ['run', 'build'], npmOptions);
    run('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], npmOptions);
    makeHost();
    if (previous) await checkIdle(previous.port);
    const wasLoaded = loaded();
    const oldControl = fs.existsSync(control) ? fs.readFileSync(control) : null;
    const oldPlist = previous ? fs.readFileSync(previous.login ? startup : sessionOnly) : null;
    if (previous) await stop(previous.port);
    try {
      write(control, `#!/bin/sh\nexport HOME=${shellQuote(home)}\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(runtime, 'scripts/macos/manage.mjs'))} "$@"\n`, 0o700);
      if (fs.existsSync(runtime)) fs.renameSync(runtime, backup);
      fs.renameSync(next, runtime);
      replaced = true;
      fs.rmSync(login ? sessionOnly : startup, { force: true });
      write(login ? startup : sessionOnly, registration(port, login));
      run('/usr/bin/plutil', ['-lint', login ? startup : sessionOnly]);
      write(receipt, JSON.stringify({ port, login }) + '\n');
      load(login);
      await wait(port);
    } catch (error) {
      await stop(port);
      if (replaced) fs.rmSync(runtime, { recursive: true, force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, runtime);
      for (const file of [startup, sessionOnly, receipt]) fs.rmSync(file, { force: true });
      if (oldControl) write(control, oldControl, 0o700);
      else fs.rmSync(control, { force: true });
      if (previous && oldPlist) {
        write(previous.login ? startup : sessionOnly, oldPlist);
        write(receipt, JSON.stringify(previous) + '\n');
        if (wasLoaded) load(previous.login);
      }
      throw error;
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  const startPage = url(port, previous ? '' : '?setup=1');
  console.log(`Workbench: ${startPage}\nDiagnostics: "${control}" doctor`);
  if (!args.includes('--no-open')) run('/usr/bin/open', [startPage]);
}

async function main([action = 'launch', ...args]) {
  if (action === 'install') return install(args);
  const { port, login } = config();
  if (action === 'launch') {
    if (!await alive(port)) {
      if (!await portFree(port)) throw new Error('Workbench port is in use. Run doctor.');
      if (loaded()) run(launch, ['kickstart', job]); else load(login);
      await wait(port);
    }
    run('/usr/bin/open', [url(port)]);
  } else if (action === 'doctor') {
    const online = await alive(port);
    console.log(`Workbench: ${online ? url(port) : await portFree(port) ? 'not running' : 'port in use or still starting'}\nLogin startup: ${login ? 'on' : 'off'}\nLogs: ${logs}`);
    // This probe is a separate GUI service, so it does not inherit the calling Terminal's access.
    const probe = `${label}.doctor.${process.pid}`;
    const check = path.join(logs, `${probe}.log`);
    try {
      run(launch, ['submit', '-l', probe, '-o', check, '--', host, '--check-accessibility']);
      for (let i = 0; i < 20 && !fs.existsSync(check); i++) await delay(100);
      let grant = '';
      for (let i = 0; i < 10 && !grant; i++) { grant = fs.existsSync(check) ? fs.readFileSync(check, 'utf8').trim() : ''; if (!grant) await delay(100); }
      console.log(grant || 'Accessibility: could not verify');
      if (grant.endsWith('not granted')) console.log(`System Settings > Privacy & Security > Accessibility > ${bundle}`);
    } finally {
      command(launch, ['remove', probe]);
      fs.rmSync(check, { force: true });
    }
    if (!online) { process.exitCode = 1; return; }
    const { agents } = await api(port, 'api/engines');
    const status = await api(port, 'api/status');
    for (const a of agents) console.log(`${a.label}: ${a.installed === false ? 'app not found' : !a.enabled ? 'off' : status[a.id]?.connected ? 'connected' : 'not connected (open the original app and check sign-in or permissions)'}`);
  } else if (action === 'uninstall') {
    await checkIdle(port);
    await stop(port);
    for (const file of [startup, sessionOnly, receipt, control, runtime, bundle]) fs.rmSync(file, { force: true, recursive: file === runtime || file === bundle });
    console.log(`Removed the preview and its login job. Personal data remains in ${data}.`);
  } else throw new Error(`Unknown action: ${action}`);
}

main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
