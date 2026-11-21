import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/server.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { EngineEvents, UnifiedSession } from '../src/server/types.js';
import { TaskBook } from '../src/server/services/task-board.js';
import { sendRoutine } from '../src/server/services/grok-routine.js';
import { AntigravityBridge } from '../src/server/antigravity-bridge.js';
import { fileURLToPath } from 'node:url';

test('discovered session-only plugin dispatches and reconciles two distinct replies without resending', async () => {
  const host = new PluginHost();
  await host.discover(fileURLToPath(new URL('../examples/', import.meta.url)));
  const context = await createApp({ host }), server = context.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const url = `http://127.0.0.1:${addr.port}/api`;
  const submit = (id: string, session: string) => fetch(url + '/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, engine: 'demo-agent', session, prompt: `Check ${session}` }),
  });
  try {
    assert.equal(host.engines.has('demo-agent'), false);
    await host.enable('demo-agent');
    const manifest = await (await fetch(url + '/engines')).json() as { engines: { id: string; capabilities: { create: boolean } }[] };
    assert.equal(manifest.engines.find(e => e.id === 'demo-agent')?.capabilities.create, false);
    assert.equal((await submit(randomUUID(), '')).status, 400);
    const one = randomUUID(), two = randomUUID();
    const results = await Promise.all([submit(one, 'first'), submit(one, 'first'), submit(two, 'second')]);
    assert.ok(results.every(r => r.ok));
    const first = await results[0]!.json() as { state: string };
    assert.equal(first.state, 'accepted');
    type Row = { id: string; state: string; preview: string };
    let rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      rows = await (await fetch(url + '/tasks')).json() as Row[];
      if (rows.length === 2 && rows.every(r => r.state === 'completed')) break;
      await delay(10);
    }
    assert.equal(rows.find(r => r.id === one)?.preview, 'Reply from first: Check first');
    assert.equal(rows.find(r => r.id === two)?.preview, 'Reply from second: Check second');
    assert.equal((await host.get('demo-agent').read('first')).turns.length, 1);
  } finally { server.close(); await context.dispose(); }
});

test('native recovery accepts a settled answer only in the selected idle turn', async () => {
  const bridge=new AntigravityBridge({agyHome:tmpdir(),agentapiBin:null,catalogs:{}},{});
  bridge.row=()=>({not_fully_idle:0,last_user_input_step_index:-1});
  const step=(type:string,status='DONE')=>({type:'CORTEX_STEP_TYPE_'+type,status:'CORTEX_STEP_STATUS_'+status});
  let steps=[step('USER_INPUT'),step('PLANNER_RESPONSE','RUNNING')];
  bridge.ls=async()=>({steps});
  try {
    assert.equal(await bridge.confirmTurnEnd('one','turn-0'),null);
    steps=[step('USER_INPUT'),step('USER_INPUT'),step('PLANNER_RESPONSE')];
    assert.equal(await bridge.confirmTurnEnd('one','turn-0'),null);
    steps=[step('USER_INPUT'),step('PLANNER_RESPONSE')];
    assert.equal(await bridge.confirmTurnEnd('one','turn-0'),'completed');
    bridge.row=()=>({not_fully_idle:1});
    assert.equal(await bridge.confirmTurnEnd('one','turn-0'),null);
  } finally {bridge.dispose();}
});

test('a pending approval is isolated to its own task; a duplicate dispatch never runs again', async () => {
  const host = new PluginHost(),
    emitters: EngineEvents[] = [];
  for (const id of ['alpha', 'beta'])
    host.register({
      id,
      label: id,
      capabilities: {},
      list: async () => [],
      status: async () => ({ connected: true }),
      models: async () => [],
      create: async () => ({ id: 'one' }),
      read: async () => ({ session: new UnifiedSession({ id: 'one', engine: id }), turns: [] }),
      send() {
        const emitter = new EngineEvents();
        emitters.push(emitter);
        return emitter;
      },
    });
  const context = await createApp({ host }),
    server = context.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const url = 'http://127.0.0.1:' + addr.port + '/api/tasks';
  const submit = (id: string, engine: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, engine, session: 'one', prompt: 'sample' }),
    });
  try {
    const a = randomUUID(),
      b = randomUUID();
    await submit(a, 'alpha');
    await submit(a, 'alpha');
    await submit(b, 'beta');
    for (let i = 0; i < 50 && emitters.length < 2; i++) await delay(10);
    assert.equal(emitters.length, 2);
    emitters[0]!.emit('approval', { id: 'hold', title: 'review' });
    emitters[1]!.emit('completed', { reply: 'B' });
    const rows = (await (await fetch(url)).json()) as { id: string; state: string; preview: string }[];
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.id === a)?.state, 'waiting');
    assert.equal(rows.find((r) => r.id === b)?.state, 'completed');
    assert.equal(rows.find((r) => r.id === b)?.preview, 'B');
    emitters[0]!.emit('approval_resolved', { id: 'hold' });
    assert.equal(((await (await fetch(url)).json()) as typeof rows).find((r) => r.id === a)?.state, 'running');
  } finally {
    server.close();
    await context.dispose();
  }
});

test('reopening SQLite preserves completed tasks and flags pending deliveries without replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-ledger-')),
    file = join(dir, 'tasks.sqlite');
  try {
    const db = new TaskBook(file);
    db.reserve('a', 'alpha', '1', '', 'A');
    db.reserve('b', 'beta', '2', '', 'B');
    db.set('b', 'completed', 'B', '2', 'native-b');
    db.db.close();
    const reopened = new TaskBook(file);
    assert.equal(reopened.get('a')?.state, 'uncertain');
    assert.equal(reopened.get('b')?.turn, 'native-b');
    assert.equal(reopened.reserve('a', 'alpha', '1', '', 'again'), false);
    assert.equal(reopened.list().length, 2);
    reopened.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Grok gets only the task number and prompt; HTTP acceptance is not task completion', async () => {
  const send: typeof fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { taskId: '123', prompt: 'check' });
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake');
    return new Response(null, { status: 200 });
  };
  assert.equal(
    (await sendRoutine('https://example.invalid/routine', 'fake', '123', 'check', send)).state,
    'accepted',
  );
  assert.equal(
    (
      await sendRoutine(
        'https://example.invalid/routine',
        'fake',
        '123',
        'check',
        async () => new Response(null, { status: 401 }),
      )
    ).state,
    'failed',
  );
  await assert.rejects(sendRoutine('http://example.invalid', 'fake', '123', 'check', send));
});
