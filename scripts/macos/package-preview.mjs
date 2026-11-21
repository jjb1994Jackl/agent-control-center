import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = fileURLToPath(new URL('../..', import.meta.url));
const arg = process.argv[2];
if (!arg) throw new Error('Usage: node scripts/macos/package-preview.mjs <new-output-directory>');
const out = path.resolve(arg);
const label = 'agent-control-center-mac-preview';
const additions = `install.sh doctor.sh uninstall.sh
docs/macos.md docs/compatibility.md docs/add-agent.md
docs/agents/qianwen.md docs/agents/qwenwork.md docs/agents/kimi.md docs/agents/workbuddy.md
examples/minimal.plugin.ts
scripts/configure-grok.sh scripts/start-local.mjs scripts/macos/AgentControlCenter-Info.plist scripts/macos/service-host.swift scripts/macos/manage.mjs scripts/macos/package-preview.mjs
src/client/tasks.css src/client/tasks.html src/client/tasks.ts
src/server/native/grok-desktop.swift src/server/native/profiles/grok.json src/server/plugins/grok.plugin.ts
src/server/services/grok-desktop.ts src/server/services/grok-routine.ts src/server/services/task-board.ts
test/grok-chat.test.ts test/grok-receipts.test.ts test/task-board.test.ts`.split(/\s+/);
const tracked = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const include = /^(?:(?:src|docs|test|skills|examples|scripts|probes|\.github)\/|(?:README(?:\.zh-CN)?\.md|LICENSE|AGENTS\.md|CLAUDE\.md|SECURITY\.md|CONTRIBUTING\.md|package(?:-lock)?\.json|tsconfig\.[\w-]+\.json|vite\.config\.ts|(?:install|uninstall|doctor)\.sh|\.gitignore|\.gitattributes)$)/;
const excluded = /^(?:docs\/images\/|docs\/skins\/[^/]+\/source\/|probes\/windows\/out\/)|(?:^|\/)(?:\.env(?:\.|$)|node_modules\/|logs\/)|\.(?:db|sqlite(?:3)?|jsonl|log|key|p12|pem|zip)$/i;
const sensitive = new RegExp([`/Users/${os.userInfo().username}/`, '工作' + '协作', '视频' + '自动化', '-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----', ['gh', '[pousr]_[A-Za-z0-9]{30,}'].join('')].join('|'));
const candidates = [...new Set([...tracked, ...additions])].filter(p => include.test(p) && !excluded.test(p)).sort();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-release-'));
try {
  const staged = path.join(scratch, label);
  for (const rel of candidates) {
    const file = path.join(root, rel);
    if (!fs.lstatSync(file).isFile()) throw new Error(`Unexpected non-file: ${rel}`);
    const bytes = fs.readFileSync(file);
    if (sensitive.test(bytes.toString('utf8'))) throw new Error(`Review private material in ${rel}`);
    const dest = path.join(staged, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    fs.chmodSync(dest, fs.statSync(file).mode & 0o111 ? 0o755 : 0o644);
  }
  fs.mkdirSync(out);
  const archive = path.join(out, `${label}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', staged, archive]);
  const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), `${hash}  ${label}.zip\n`);
  fs.writeFileSync(path.join(out, 'public-files.txt'), candidates.join('\n') + '\n');
  const zh = fs.readFileSync(path.join(staged, 'README.zh-CN.md'), 'utf8');
  const en = fs.readFileSync(path.join(staged, 'README.md'), 'utf8');
  const pages = path.join(out, 'pages');
  fs.mkdirSync(pages);
  for (const file of ['LICENSE', 'examples/minimal.plugin.ts']) {
    const copy = path.join(pages, file);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(path.join(staged, file), copy);
  }
  const markdown = candidates.filter(file => file.endsWith('.md'));
  for (const file of markdown) {
    const dest = path.join(pages, file + '.html');
    const body = marked.parse(fs.readFileSync(path.join(staged, file), 'utf8')).replace(/href="([^"#]+\.md)(#[^"]*)?"/g, 'href="$1.html$2"');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Control Center</title><style>body{margin:2rem auto;padding:0 1rem;max-width:52rem;font:16px/1.65 system-ui;color:#202925}a{color:#145d7d}code{background:#f0f4f2}pre,td,th{padding:.55rem;background:#f6f8f7;overflow:auto}table{border-collapse:collapse}h1,h2{border-bottom:1px solid #ced9d4}</style>${body}`);
  }
  const dependencies = [zh, en].flatMap(content => [...content.matchAll(/\]\(([^/()]+(?:\/[^()]+)?)\)/g)].map(match => match[1])).filter(ref => !ref.startsWith('https:'));
  if (dependencies.some(ref => !candidates.includes(ref))) throw new Error('README includes a file not present in the release');
  console.log(`${archive}\n${candidates.length} source files\nSHA-256 ${hash}`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
