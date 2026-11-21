// Agents switched on and off while the console runs: the plugin host, what the person's choice is
// kept in, the route the page calls, and the rows the page draws.
import { test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineEvents } from '../src/server/types.js';
import { dig, must, withStatus } from './support.js';
import { loadConfig } from '../src/server/config.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { SettingsStore } from '../src/server/core/settings-store.js';
import { EventHub } from '../src/server/core/event-hub.js';
import { RunService } from '../src/server/core/run-service.js';
import { createApp } from '../src/server/server.js';
import type { Character, Engine, History, PluginAbout, PluginSetup, UnifiedSession } from '../src/shared/contract.js';

// An engine that does nothing by itself; `emitters` are the runs the console started on it.
function engineOf(id: string, emitters: EngineEvents[] = []): Engine {
  return { id, label: id.toUpperCase(), capabilities: { interrupt: true },
    status: async () => ({ connected: true }), models: async () => [], list: async (): Promise<UnifiedSession[]> => [],
    read: async (): Promise<History> => ({ session: null, turns: [] }), create: async () => ({ id: 'new' }),
    send() { const emitter = new EngineEvents(); emitters.push(emitter); return emitter; },
  };
}
// A plugin that registers that engine and an asset, and records what happens to it.
function pluginOf(id: string, { installed, log = [], emitters = [] }: { installed?: boolean; log?: string[]; emitters?: EngineEvents[] } = {}): [PluginAbout, PluginSetup] {
  const about: PluginAbout = { id, label: id.toUpperCase(), accent: '#123456', priority: id === 'first' ? 1 : 2, ...(installed === undefined ? {} : { detect: () => (installed ? { installed, where: `/Applications/${id}.app` } : { installed }) }) };
  return [about, ({ registerEngine, registerAsset }) => { log.push(`setup ${id}`); registerAsset(`${id}-art`, () => null); registerEngine(engineOf(id, emitters)); return () => { log.push(`dispose ${id}`); }; }];
}

test('a plugin is known before it is set up, and switching it off takes back everything it registered', async () => {
  const host = new PluginHost(), log: string[] = [];
  host.add(...pluginOf('first', { installed: true, log })); host.add(...pluginOf('second', { installed: false, log }));
  assert.throws(() => host.add(...pluginOf('first')), /Duplicate plugin/);
  // Known, not set up: nothing ran, no engine is listed, the catalog says what was found.
  assert.equal(log.length, 0); assert.equal(host.engines.size, 0);
  assert.deepEqual((await host.catalog()).map(item => [item.id, item.enabled, item.installed, item.where]), [['first', false, true, '/Applications/first.app'], ['second', false, false, undefined]]);
  // Until the person chooses, an agent is on when its desktop app is found.
  await host.start();
  assert.deepEqual(log, ['setup first']); assert.deepEqual([...host.engines.keys()], ['first']); assert.ok(host.assets.has('first-art'));
  assert.deepEqual(host.manifests().map(item => item.id), ['first']);
  // Switching on one that was not found is the person's call; twice is once.
  await Promise.all([host.enable('second'), host.enable('second')]);
  assert.deepEqual(log, ['setup first', 'setup second']); assert.deepEqual(host.enginesOf('second'), ['second']);
  // Off: the engine is gone before whoever holds something of it is told, and before the plugin lets go.
  await host.disable('first', engines => { log.push(`removed ${engines.join()} (listed: ${host.engines.has('first')})`); });
  assert.deepEqual(log.slice(2), ['removed first (listed: false)', 'dispose first']);
  assert.equal(host.assets.has('first-art'), false); assert.throws(() => host.get('first'), withStatus(404));
  assert.deepEqual((await host.catalog()).map(item => item.enabled), [false, true]);
  await host.disable('first'); assert.equal(log.length, 4, 'off twice is once');
  // On again: set up afresh.
  await host.enable('first'); assert.deepEqual(log.at(-1), 'setup first'); assert.ok(host.engines.has('first'));
  await assert.rejects(host.enable('nobody'), withStatus(404));
  await host.dispose();
  assert.equal(host.engines.size, 0); assert.deepEqual(log.slice(-2).sort(), ['dispose first', 'dispose second']);
});

test('the person\'s choice comes before what was found, and a plugin that fails to set up stays off with its reason', async () => {
  const host = new PluginHost(), log: string[] = [];
  host.add(...pluginOf('first', { installed: true, log })); host.add(...pluginOf('second', { installed: false, log }));
  host.add({ id: 'unknown-presence', label: 'No detect' }, ({ registerEngine }) => { registerEngine(engineOf('unknown-presence')); });
  host.add({ id: 'broken', label: 'Broken', detect: () => { throw new Error('cannot look'); } }, ({ registerEngine, registerAsset }) => { registerAsset('broken-art', () => null); registerEngine(engineOf('broken')); throw new Error('its app is too old'); });
  const errors: unknown[] = [], original = console.error; console.error = (...args: unknown[]) => { errors.push(args); };
  try { await host.start(id => ({ first: false, second: true } as Record<string, boolean>)[id]); } finally { console.error = original; }
  // first: chosen off though found. second: chosen on though not found. No detect, or one that throws: counts as found.
  assert.deepEqual([...host.engines.keys()].sort(), ['second', 'unknown-presence']);
  assert.equal(errors.length, 1, 'the failure is logged, the others still start');
  const broken = must((await host.catalog()).find(item => item.id === 'broken'));
  assert.equal(broken.enabled, false); assert.equal(broken.error, 'its app is too old'); assert.equal(broken.installed, null);
  assert.equal(host.assets.has('broken-art'), false, 'what it registered before failing is taken back');
  await assert.rejects(host.enable('broken'), /too old/);
  await host.dispose();
});

test('choices are kept in a file that holds only choices', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-settings-')), file = path.join(directory, 'nested', 'settings.json');
  try {
    const store = new SettingsStore(file);
    assert.equal(store.agent('claude'), undefined, 'no file: nothing chosen');
    store.setAgent('claude', false); store.setAgent('codex', true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { agents: { claude: false, codex: true } });
    // Another start reads them back; what else the file holds is kept; a broken file is nothing chosen.
    fs.writeFileSync(file, JSON.stringify({ other: 1, agents: { claude: false, odd: 'yes' } }));
    const again = new SettingsStore(file);
    assert.equal(again.agent('claude'), false); assert.equal(again.agent('odd'), undefined);
    again.setAgent('claude', true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { other: 1, agents: { claude: true } });
    fs.writeFileSync(file, '{ not json'); assert.equal(new SettingsStore(file).agent('claude'), undefined);
    assert.doesNotThrow(() => new SettingsStore().setAgent('claude', true), 'no file to write: kept in memory');
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('the console lets go of an engine that left: its runs, queued messages and journals', async () => {
  const host = new PluginHost(), hub = new EventHub(), emitters: EngineEvents[] = [];
  host.register(engineOf('one', emitters)); host.register(engineOf('other'));
  const runs = new RunService(host, hub);
  runs.start('one', 'a', { prompt: 'go', attachments: [] }); runs.start('other', 'a', { prompt: 'go', attachments: [] });
  runs.enqueue('one', 'a', { prompt: 'next', attachments: [] }); runs.enqueue('one', 'a', { prompt: 'and then', attachments: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runs.holding('one'), { running: 1, queued: 2 }); assert.deepEqual(runs.holding('other'), { running: 1, queued: 0 }); assert.deepEqual(runs.holding('on'), { running: 0, queued: 0 }, 'not a prefix match');
  let stopped = 0; must(emitters[0]).on('interrupt', () => { stopped++; });
  runs.release('one'); hub.forget('one');
  assert.equal(stopped, 1, 'the engine is told to stop watching the turn for the console');
  assert.deepEqual(runs.holding('one'), { running: 0, queued: 0 }); assert.equal(runs.get('one', 'a'), undefined);
  assert.ok(runs.get('other', 'a'), 'another engine\'s run is untouched'); assert.equal(hub.cursor('one', 'a').endsWith(':0'), true);
  // What the engine still emits for the dropped run reaches nobody.
  const seen: string[] = []; hub.subscribeAll(event => seen.push(event.type));
  must(emitters[0]).emit('completed', {});
  assert.deepEqual(seen, []);
  runs.dispose();
});

test('PUT /api/agents/:id switches an agent on and off for every page, and keeps the choice', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-agents-')), settingsFile = path.join(directory, 'settings.json');
  const host = new PluginHost(), log: string[] = [], emitters: EngineEvents[] = [];
  host.add(...pluginOf('first', { installed: true, log, emitters })); host.add(...pluginOf('second', { installed: false, log }));
  const context = await createApp({ host, config: { ...loadConfig(), uploadsDir: directory, settingsFile } });
  const server = context.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(), base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  t.after(async () => { await context.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true }); });
  const call = async (url: string, method = 'GET', body?: unknown): Promise<{ status: number; data: unknown }> => { const response = await fetch(base + url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  const listed = async () => { const { data } = await call('/api/engines'); return { engines: (dig(data, 'engines') as Array<{ id: string }>).map(item => item.id), agents: (dig(data, 'agents') as Array<{ id: string; enabled: boolean }>).map(item => `${item.id}:${item.enabled}`) }; };
  // Started by what was found: first on, second off. No file is written until the person chooses.
  assert.deepEqual(await listed(), { engines: ['first'], agents: ['first:true', 'second:false'] });
  assert.equal(fs.existsSync(settingsFile), false);
  // A page following the overview is told when the agents change.
  const overview = await fetch(`${base}/api/activity/events`), reader = must(overview.body).getReader(); let heard = '';
  const hears = async (text: string) => { while (!heard.includes(text)) { const { value, done } = await reader.read(); if (done) throw new Error(`stream ended before ${text}`); heard += Buffer.from(value).toString(); } };
  t.after(() => reader.cancel().catch(() => {}));
  // On: the engine joins every list; the answer is the new state.
  const on = await call('/api/agents/second', 'PUT', { enabled: true });
  assert.equal(on.status, 200); assert.deepEqual((dig(on.data, 'engines') as Array<{ id: string }>).map(item => item.id), ['first', 'second']);
  assert.deepEqual(Object.keys(must((await call('/api/status')).data as Record<string, unknown>)).sort(), ['first', 'second']);
  await hears('event: engines');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { agents: { second: true } });
  // Off while the console follows a turn of it and holds a message for it: held back, with the counts.
  assert.equal((await call('/api/sessions/first/chat/messages', 'POST', { prompt: 'work' })).status, 202);
  assert.equal((await call('/api/sessions/first/chat/messages', 'POST', { prompt: 'later', mode: 'queue' })).status, 202);
  const stream = await fetch(`${base}/api/sessions/first/chat/events`), chat = must(stream.body).getReader();
  const held = await call('/api/agents/first', 'PUT', { enabled: false });
  assert.equal(held.status, 409); assert.deepEqual(dig(held.data, 'busy'), { running: 1, queued: 1 });
  assert.deepEqual((await listed()).engines, ['first', 'second'], 'nothing changed');
  // The person's word (`force`): the engine leaves, the plugin lets go, the chat's stream ends, its activity is gone.
  let stopped = 0; must(emitters[0]).on('interrupt', () => { stopped++; });
  const off = await call('/api/agents/first', 'PUT', { enabled: false, force: true });
  assert.equal(off.status, 200); assert.deepEqual(await listed(), { engines: ['second'], agents: ['first:false', 'second:true'] });
  assert.equal(stopped, 1); assert.equal(log.at(-1), 'dispose first');
  for (;;) { const { done } = await chat.read(); if (done) break; }
  assert.equal((await call('/api/sessions/first/chat')).status, 404);
  assert.equal((await fetch(`${base}/api/sessions/first/chat/events`)).status, 404, 'a page that reconnects is told the engine is gone');
  assert.deepEqual((dig((await call('/api/activity')).data, 'sessions') as Array<{ engine: string }>).filter(item => item.engine === 'first'), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { agents: { second: true, first: false } });
  // Bad requests.
  assert.equal((await call('/api/agents/nobody', 'PUT', { enabled: true })).status, 404);
  assert.equal((await call('/api/agents/first', 'PUT', { enabled: 'yes' })).status, 400);
  // The next start follows the choices, not what is found.
  const restarted = new PluginHost(); restarted.add(...pluginOf('first', { installed: true })); restarted.add(...pluginOf('second', { installed: false }));
  const next = await createApp({ host: restarted, config: { ...loadConfig(), uploadsDir: directory, settingsFile } });
  assert.deepEqual([...restarted.engines.keys()], ['second']);
  await next.dispose();
});

test('a plugin that fails when switched on answers with its reason and stays off', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-agents-')), settingsFile = path.join(directory, 'settings.json');
  const host = new PluginHost();
  host.add({ id: 'broken', label: 'Broken', detect: () => ({ installed: false }) }, () => { throw new Error('its app is too old'); });
  const context = await createApp({ host, config: { ...loadConfig(), uploadsDir: directory, settingsFile } });
  const server = context.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(), base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  t.after(async () => { await context.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true }); });
  const response = await fetch(`${base}/api/agents/broken`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) }), data: unknown = await response.json();
  assert.equal(response.status, 500); assert.equal(dig(data, 'error'), 'its app is too old');
  assert.equal(dig(data, 'agents', 0, 'enabled'), false); assert.equal(dig(data, 'agents', 0, 'error'), 'its app is too old'); assert.deepEqual(dig(data, 'engines'), []);
  assert.equal(fs.existsSync(settingsFile), false, 'a choice that did not take is not kept');
});

test('built-in plugins say who they are without being set up', async () => {
  const host = new PluginHost({ config: { ...loadConfig(), claudeAppAsar: '/nowhere/Claude.app/Contents/Resources/app.asar', claudeDesktopHome: '/nowhere/claude', chatgptAppAsar: os.tmpdir() } });
  await host.discover(loadConfig().pluginDir);
  const catalog = await host.catalog();
  assert.deepEqual(catalog.map(item => item.id), ['codex', 'claude', 'antigravity', 'grok'], 'in the rail\'s order');
  assert.equal(host.engines.size, 0, 'none was set up');
  for (const item of catalog) { assert.ok(item.label && item.accent, item.id); assert.equal(typeof item.installed, 'boolean', item.id); }
  // Found or not by what is on the machine: a path that is there, a path that is not.
  assert.equal(must(catalog.find(item => item.id === 'codex')).installed, true); assert.equal(must(catalog.find(item => item.id === 'claude')).installed, false);
});

test('each agent\'s row says where it stands, and asks before dropping work', async () => {
  const { agentRows, agentNote, busyText, newAgentsView } = await import('../src/client/js/agents.js');
  const entry = (id: string, enabled: boolean, installed: boolean | null, error?: string) => ({ id, label: id, accent: null, character: null, enabled, installed, ...(error ? { error } : {}) });
  const view = newAgentsView(), statuses = { on: { connected: true }, away: { connected: false, error: 'not running' } };
  const note = (item: ReturnType<typeof entry>) => agentNote(item, { view, statuses }).text;
  assert.equal(note(entry('on', true, true)), '已启用 · 桌面版已连接'); assert.match(note(entry('away', true, true)), /没连上：not running$/); assert.equal(note(entry('new', true, null)), '已启用');
  assert.equal(note(entry('off', false, true)), '未启用 · 这台电脑上有它的桌面版'); assert.equal(note(entry('none', false, false)), '未启用 · 这台电脑上没找到它的桌面版'); assert.equal(note(entry('odd', false, null)), '未启用');
  assert.equal(note(entry('bad', false, true, 'too old')), '没能启用：too old');
  // While it is being switched the row shows where it is going, and takes no second click's meaning.
  view.pending.set('off', true);
  const html = agentRows([entry('on', true, true), entry('off', false, true), entry('<x>', false, null)], { view, statuses, face: () => '<i></i>' });
  assert.match(html, /data-agent-toggle="on"[^>]*|aria-checked="true"/); assert.match(html, /is-on is-pending" role="listitem" data-agent="off"/);
  assert.match(html, /正在接上它的桌面版…/); assert.doesNotMatch(html, /<x>/);
  // Held back by the server: the row says what would be dropped and offers both answers.
  view.pending.clear(); view.ask = { id: 'on', busy: { running: 1, queued: 2 } };
  const asked = agentRows([entry('on', true, true)], { view, statuses, face: () => '' });
  assert.match(asked, /data-agent-force="on"/); assert.match(asked, /data-agent-cancel/); assert.match(asked, /1 轮任务/); assert.match(asked, /2 条消息/);
  assert.equal(busyText('X', { running: 0, queued: 3 }), '还有 3 条消息排着队等发给 X，移除后它们不会发出。');
  assert.match(agentRows([], { view, statuses, face: () => '' }), /agent-none/);
});

test('the rail\'s order and what the person changed about an agent are kept with the switches', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-settings-')), file = path.join(directory, 'settings.json');
  try {
    const store = new SettingsStore(file);
    assert.deepEqual(store.order(), []); assert.deepEqual(store.custom('codex'), {});
    store.setAgent('codex', true); store.setOrder(['claude', 'codex', 'claude']); store.setCustom('codex', { label: 'Blue', idle: 'codex-idle-0123456789.png' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { agents: { codex: true }, order: ['claude', 'codex'], custom: { codex: { label: 'Blue', idle: 'codex-idle-0123456789.png' } } });
    const again = new SettingsStore(file);
    assert.deepEqual(again.order(), ['claude', 'codex']); assert.deepEqual(again.custom('codex'), { label: 'Blue', idle: 'codex-idle-0123456789.png' });
    // null puts the plugin's own back; nothing left of an agent leaves no entry, nothing left at all no key.
    again.setCustom('codex', { label: null }); again.setCustom('codex', { idle: null }); again.setOrder([]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { agents: { codex: true } });
    fs.writeFileSync(file, JSON.stringify({ order: 'x', custom: { a: { label: 7, idle: 'a-idle-0123456789.png' }, b: 'no' } }));
    const odd = new SettingsStore(file);
    assert.deepEqual(odd.order(), []); assert.deepEqual(odd.custom('a'), { idle: 'a-idle-0123456789.png' }); assert.deepEqual(odd.custom('b'), {});
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('an agent\'s name, faces and place in the rail are the person\'s, and nothing changed is exactly the plugin\'s own', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-looks-')), settingsFile = path.join(directory, 'settings.json'), pictures = path.join(directory, '.frontdesk-avatars');
  const host = new PluginHost();
  const sprite: Character = { kind: 'sprite', url: '/api/characters/one-art', columns: 2, rows: 2, cell: [10, 10], idle: [0, 0], working: { row: 1, frames: 2 } };
  const plugin = (id: string, priority: number): [PluginAbout, PluginSetup] => [{ id, label: id.toUpperCase(), priority, character: sprite }, ({ registerEngine }) => { registerEngine({ ...engineOf(id), priority, character: sprite }); }];
  host.add(...plugin('one', 1)); host.add(...plugin('two', 2)); host.add(...plugin('three', 3));
  const context = await createApp({ host, config: { ...loadConfig(), uploadsDir: directory, settingsFile } });
  const server = context.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(), base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  t.after(async () => { await context.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true }); });
  type Listed = { id: string; label: string; defaultLabel?: string; character: Record<string, unknown> | null; custom?: Record<string, string> };
  const send = async (url: string, method: string, body?: unknown, type = 'application/json') => { const response = await fetch(base + url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': type }, body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as { engines: Listed[]; agents: Listed[]; error?: string } }; };
  const one = async () => { const { data } = await send('/api/engines', 'GET'); return { engine: must(data.engines.find(item => item.id === 'one')), agent: must(data.agents.find(item => item.id === 'one')) }; };
  // First use: the plugin's own name and face, and nothing written.
  assert.deepEqual((await one()).engine.character, sprite); assert.equal((await one()).engine.label, 'ONE'); assert.equal((await one()).agent.custom, undefined);
  assert.equal(fs.existsSync(settingsFile), false);
  // A name of the console's own, trimmed; the plugin's own is still known; empty puts it back.
  const renamed = await send('/api/agents/one', 'PATCH', { label: '  Blue   one ' });
  assert.equal(renamed.status, 200); assert.equal(must(renamed.data.engines.find(item => item.id === 'one')).label, 'Blue one');
  assert.deepEqual([(await one()).agent.label, (await one()).agent.defaultLabel, (await one()).agent.custom], ['Blue one', 'ONE', { label: 'Blue one' }]);
  assert.equal((await send('/api/agents/one', 'PATCH', { label: 'x'.repeat(41) })).status, 400);
  assert.equal((await send('/api/agents/one', 'PATCH', { label: 3 })).status, 400);
  await send('/api/agents/one', 'PATCH', { label: '' });
  assert.equal((await one()).engine.label, 'ONE'); assert.equal((await one()).engine.defaultLabel, undefined);
  // A working picture over the plugin's sprite: the sprite stays for idle.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a picture')]);
  const gif = Buffer.from('GIF89a and frames');
  assert.equal((await send('/api/agents/one/avatar/working', 'PUT', gif, 'image/gif')).status, 200);
  const working = (await one()).engine.character;
  assert.equal(dig(working, 'kind'), 'sprite'); assert.match(String(dig(working, 'workingUrl')), /^\/api\/characters\/custom-one-working\?v=[0-9a-f]{10}$/);
  // An idle picture: it fills the face; the address serves it with its type.
  await send('/api/agents/one/avatar/idle', 'PUT', png, 'image/png');
  const both = must((await one()).engine.character), idleUrl = String(both['url']);
  assert.equal(both['kind'], 'image'); assert.equal(both['fill'], true); assert.match(idleUrl, /^\/api\/characters\/custom-one-idle\?v=[0-9a-f]{10}$/); assert.ok(both['workingUrl']);
  const served = await fetch(base + idleUrl);
  assert.equal(served.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  // A new picture replaces the file before it; a broken or foreign one is refused and changes nothing.
  const other = Buffer.concat([png, Buffer.from('2')]);
  await send('/api/agents/one/avatar/idle', 'PUT', other, 'image/png');
  assert.equal(fs.readdirSync(pictures).filter(name => name.startsWith('one-idle-')).length, 1);
  const svg = await send('/api/agents/one/avatar/idle', 'PUT', Buffer.from('<svg onload="x"/>'), 'image/svg+xml');
  assert.equal(svg.status, 415); assert.equal(svg.data.error, '只支持 PNG、JPEG、GIF、WebP 图片');
  assert.equal((await send('/api/agents/one/avatar/idle', 'PUT', Buffer.alloc(0), 'image/png')).status, 400);
  assert.equal((await send('/api/agents/one/avatar/idle', 'PUT', Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]), 'image/png')).status, 413);
  assert.equal((await send('/api/agents/one/avatar/elsewhere', 'PUT', png, 'image/png')).status, 404);
  assert.equal((await send('/api/agents/nobody/avatar/idle', 'PUT', png, 'image/png')).status, 404);
  assert.equal((await fetch(`${base}/api/characters/custom-two-idle`)).status, 404, 'no picture, no file served');
  // A picture gone from disk falls back to the plugin's face, not a broken one.
  for (const name of fs.readdirSync(pictures).filter(item => item.startsWith('one-working-'))) fs.rmSync(path.join(pictures, name));
  assert.equal(dig((await one()).engine.character, 'workingUrl'), undefined);
  // Back to the plugin's own: the settings forget it, the file goes.
  await send('/api/agents/one/avatar/idle', 'DELETE'); await send('/api/agents/one/avatar/working', 'DELETE');
  assert.deepEqual((await one()).engine.character, sprite); assert.deepEqual(fs.readdirSync(pictures), []);
  // The order: the agents named first, the rest after in the plugins' order; unknown ids are dropped.
  const ordered = await send('/api/agents/order', 'PUT', { order: ['three', 'nobody', 'one'] });
  assert.deepEqual(ordered.data.engines.map(item => item.id), ['three', 'one', 'two']); assert.deepEqual(ordered.data.agents.map(item => item.id), ['three', 'one', 'two']);
  assert.equal((await send('/api/agents/order', 'PUT', { order: 'three' })).status, 400);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { agents: {}, order: ['three', 'one'] });
});

test('in settings an agent\'s row opens its name, faces and order, and a working picture takes the face\'s place', async () => {
  const { agentRows, newAgentsView } = await import('../src/client/js/agents.js');
  const { character } = await import('../src/client/js/renderers.js');
  const view = newAgentsView(), entry = { id: 'one', label: 'Blue', defaultLabel: 'ONE', accent: null, character: null, enabled: true, installed: true, custom: { label: 'Blue', idle: '/api/characters/custom-one-idle?v=0123456789' } };
  const face = (_: unknown, working?: boolean) => (working ? '<i working></i>' : '<i idle></i>');
  const plain = agentRows([entry], { view, statuses: {}, face });
  assert.doesNotMatch(plain, /data-agent-edit|data-agent-grip/, 'not in the rail\'s dialog');
  const closed = agentRows([entry, { ...entry, id: 'two', custom: undefined, defaultLabel: undefined }], { view, statuses: {}, face, editable: true });
  assert.match(closed, /data-agent-grip="one"/); assert.match(closed, /data-agent-edit="one" aria-expanded="false"/); assert.match(closed, /agent-original">ONE</); assert.doesNotMatch(closed, /data-agent-editor/);
  view.editing = 'one'; view.saving.set('one', 'working'); view.editErrors.set('one', '图片是空的');
  const open = agentRows([entry, { ...entry, id: 'two' }], { view, statuses: {}, face, editable: true });
  assert.match(open, /data-agent-label="one" value="Blue" placeholder="ONE"/);
  assert.match(open, /data-agent-reset="one" data-slot="idle"/); assert.doesNotMatch(open, /data-agent-reset="one" data-slot="working"/);
  assert.match(open, /<i working><\/i>/); assert.match(open, /正在保存…/); assert.match(open, /role="alert">图片是空的/);
  assert.match(open, /data-agent-move="one" data-step="-1" disabled/); assert.match(open, /data-agent-move="one" data-step="1">/);
  // The face: a picture of the person's own fills it, a working one shows only while it works.
  const drawn = character({ character: { kind: 'image', url: '/api/characters/custom-one-idle?v=0123456789', fill: true, workingUrl: '/api/characters/custom-one-working?v=abcdef0123' } }, { working: true });
  assert.match(drawn, /class="character is-working has-working"/); assert.match(drawn, /character-image is-fill" src="\/api\/characters\/custom-one-idle/); assert.match(drawn, /character-working" src="\/api\/characters\/custom-one-working/);
  assert.doesNotMatch(character({ character: { kind: 'image', url: '/elsewhere.png', workingUrl: 'javascript:x' } }), /elsewhere|javascript/);
});

test("an agent's app icon is read from the installed app whether the agent is on or off, and is no one's icon when the app is not there", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-appicon-')), file = path.join(dir, 'app.icns');
  // An .icns holding one 256-pixel PNG.
  const png = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(256, 16);
  const entry = Buffer.alloc(8); entry.write('ic08', 'latin1'); entry.writeUInt32BE(png.length + 8, 4);
  const head = Buffer.alloc(8); head.write('icns', 'latin1'); head.writeUInt32BE(png.length + 16, 4);
  try {
    const host = new PluginHost({ config: { defaultCwd: dir } });
    const [here, setupHere] = pluginOf('first', { installed: true }), [gone, setupGone] = pluginOf('second', { installed: true });
    // Given as a path, or found from the configuration.
    host.add({ ...here, appIcon: config => path.join(config.defaultCwd || '', 'app.icns') }, setupHere);
    host.add({ ...gone, appIcon: path.join(dir, 'missing.icns') }, setupGone);
    // Without the file there is no icon to name (the page draws the prefix), and nothing is served.
    assert.deepEqual((await host.catalog()).map(item => item.iconUrl), [undefined, undefined]);
    assert.equal(host.asset('first-icon'), null);
    fs.writeFileSync(file, Buffer.concat([head, entry, png]));
    // Off: the agent's row already has it.
    assert.deepEqual((await host.catalog()).map(item => [item.enabled, item.iconUrl]), [[false, '/api/characters/first-icon'], [false, undefined]]);
    assert.equal(host.asset('first-icon')?.type, 'image/png');
    // On: its engine has it too, unless the engine names an icon of its own.
    await host.start();
    assert.deepEqual(host.manifests().map(item => [item.id, item.iconUrl]), [['first', '/api/characters/first-icon'], ['second', undefined]]);
    assert.equal(host.asset('second-icon'), null); assert.equal(host.asset('nobody-icon'), null);
    // What a plugin registered itself is still served under its own name.
    assert.equal(host.assets.has('first-art'), true);
    await host.dispose();
    assert.equal(host.asset('first-icon')?.type, 'image/png');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
