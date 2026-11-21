import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { grokTurns } from '../src/server/plugins/grok.plugin.js';
import { createApp } from '../src/server/server.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { UnifiedSession } from '../src/server/types.js';

test('Grok keeps group speakers distinct and identical prompts in separate turns', () => {
  const rows = [
    { author: 'Owner', user: true, text: 'same' },
    { author: 'Research Bot', text: 'one' },
    { author: 'Test Bot', text: 'two' },
    { author: 'Owner', user: true, text: 'same' },
  ];
  const turns = grokTurns(rows);
  assert.notEqual(turns[0]?.id, turns[1]?.id);
  assert.deepEqual(turns[0]?.messages.map(m => m.text), ['**Research Bot**\n\none', '**Test Bot**\n\ntwo']);
  assert.equal(turns[1]?.status, 'unknown');
  assert.deepEqual(grokTurns(rows).map(turn => turn.id), turns.map(turn => turn.id));
});

test('Grok reply correlation survives a clipped history and a changed clock label but ignores repeated text', () => {
  const old = { author:'You', user:true, text:'Earlier user message', stamp:' 10:02' };
  const sent = { author:'You', user:true, text:'Exact dispatch', stamp:' 10:37' };
  const response = { author:'Bot', text:'Exact answer' };
  const anchor = grokTurns([old,sent]).at(-1)?.id;
  assert.ok(anchor?.startsWith('grok-msg-'));
  assert.equal(grokTurns([{...sent,stamp:' 10:38',author:'你'},response])[0]?.id, anchor);
  assert.ok(grokTurns([sent,response,sent]).every(t => !t.id.startsWith('grok-msg-')));
});

test('a native chat is explicitly activated on selection and user messages do not create fake runs', async () => {
  const host = new PluginHost(), read: boolean[] = [], delivered: string[] = [];
  host.register({
    id: 'native-chat', label: 'Native Chat', capabilities: { create: false },
    list: () => [], models: () => [], status: () => ({ connected: true }),
    create: () => { throw Error('not supported'); }, send: () => { throw Error('not a run'); },
    read: (id, options) => {
      read.push(options?.activate === true);
      return { session: new UnifiedSession({ id, engine: 'native-chat' }), turns: [] };
    },
    blocked: id => id === 'duplicate' ? 'Ambiguous chat' : '',
    postMessage: (id, input) => {
      delivered.push(id + ':' + input.prompt);
      return { status: 'sent' };
    },
  });
  const context = await createApp({ host });
  const server = context.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const root = `http://127.0.0.1:${address.port}/api/sessions/native-chat/`;
  const post = (id: string) => fetch(root + id + '/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hello' }),
  });
  try {
    const opened = await fetch(root + 'target');
    assert.equal(opened.status, 200);
    assert.deepEqual(read, [true]);
    assert.equal((await post('duplicate')).status, 409);
    const sent = await post('target');
    assert.equal(sent.status, 202);
    assert.deepEqual(await sent.json(), { status: 'sent' });
    assert.deepEqual(delivered, ['target:hello']);
    assert.equal((await (await fetch(root + 'target')).json() as { activeTurn: unknown }).activeTurn, null);
  } finally {
    server.close();
    await context.dispose();
  }
});

test('grok macOS helper compiles cleanly with draft cleanup and group working-label support', async () => {
  if (process.platform !== 'darwin') return;
  const { DesktopAutomation } = await import('../src/server/core/desktop-automation.js');
  const ax = new DesktopAutomation({ engine: 'grok', label: 'Grok Bot' });
  const bin = await ax.helper();
  assert.ok(bin && bin.length > 0, 'grok Swift helper compiled');
});
