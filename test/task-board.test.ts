import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/server.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { EngineEvents, UnifiedSession, UnifiedTurn } from '../src/server/types.js';
import { TaskBook } from '../src/server/services/task-board.js';
import { sendRoutine } from '../src/server/services/grok-routine.js';
import { AntigravityBridge } from '../src/server/antigravity-bridge.js';
import { fileURLToPath } from 'node:url';

async function serve(host: PluginHost, args: Omit<Parameters<typeof createApp>[0] & object, 'host'> = {}) {
  const app = await createApp({ ...args, host }), server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const info = server.address();
  assert.ok(info && typeof info === 'object');
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(`http://127.0.0.1:${info.port}/api` + path, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { ...app, request, async close() { server.close(); await app.dispose(); } };
}

test('workbench creates and sends exactly once, tracks a new queued turn and merges inserted messages', async () => {
  const host = new PluginHost(), sends: string[] = [], steers: string[] = [], emitters: EngineEvents[] = [];
  let creates = 0;
  const target = new UnifiedSession({id:'native-1',engine:'sample',title:'Native 1'});
  host.register({ id:'sample', label:'Sample', capabilities:{ steer:true }, list: () => [target], models: () => [],
    read: () => ({ session: target, turns: [] }), status: () => ({ connected:true }),
    create(input) { creates++; assert.equal(input.prompt, ''); return {id:target.id}; },
    send(_id,input) { sends.push(input.prompt); const events = new EngineEvents(); emitters.push(events); return events; },
    steer(_id,input) { steers.push(input.prompt); return {}; },
  });
  const s = await serve(host), path = '/sessions/sample/native-1/messages';
  try {
    const create = { dispatchId:randomUUID(), prompt:'exact first prompt' };
    assert.ok((await s.request('/sessions/sample', create)).ok);
    assert.ok((await s.request('/sessions/sample', create)).ok);
    assert.equal(creates,1);
    const appended = { dispatchId:randomUUID(), prompt:'additional instructions', mode:'steer' };
    await s.request(path, appended); await s.request(path, appended);
    assert.deepEqual(steers,['additional instructions']);
    const join = { dispatchId:randomUUID(), prompt:'queue then insert', mode:'queue' };
    const q = await (await s.request(path, join)).json() as { id: string };
    assert.ok((await s.request('/sessions/sample/native-1/queue/' + q.id + '/steer', {})).ok);
    assert.deepEqual(steers,['additional instructions','queue then insert']);
    const next = { dispatchId:randomUUID(), prompt:'truly independent', mode:'queue' };
    await s.request(path,next);
    emitters[0]!.emit('approval',{id:'approval',title:'A review'});
    type Row = { id: string; state: string };
    const rows = async () => await (await s.request('/tasks')).json() as Row[];
    const before = await rows();
    assert.equal(before.length,2);
    assert.equal(before.find(r=>r.id === create.dispatchId)?.state,'waiting');
    assert.equal(before.find(r=>r.id === next.dispatchId)?.state,'queued');
    emitters[0]!.emit('completed',{reply:'first reply'});
    for (let i=0;i<100 && sends.length<2;i++) await delay(10);
    assert.deepEqual(sends,['exact first prompt','truly independent']);
    emitters[1]!.emit('completed',{reply:'second reply'});
    assert.deepEqual((await rows()).map(r=>r.state),['completed','completed']);
  } finally { await s.close(); }
});

test('native group replies use the observed turn in the selected group, and persisted IDs prevent delivery twice', async () => {
  const folder = mkdtempSync(join(tmpdir(),'acc-workbench-'));
  const deliveries: string[] = [];
  const groups = ['group-one','group-two'], markers = ['GROUP-A','GROUP-B'];
  function agent() {
    const host = new PluginHost();
    host.register({id:'grok',label:'Grok Bot',capabilities:{create:false}, list: () => [], models: () => [], status: () => ({ connected:true }),
      create: () => { throw Error('not supported'); }, send: () => { throw Error('use native post'); },
      read: id => ({ session:new UnifiedSession({id,engine:'grok'}), turns:[new UnifiedTurn({id:'observed',userPrompt:'look up',status:'unknown',
        messages:[{id:'reply',text:'Reply in '+id,phase:'final_answer',status:'completed'}]})] }),
      postMessage: (id,input) => { deliveries.push(id + ':' + input.prompt); return { status:'sent', observedTurnId:'observed', sessionTitle:'Native '+id }; },
    });
    return host;
  }
  const first = await serve(agent(),{taskFile:join(folder,'tasks.sqlite')});
  const bodies = markers.map(prompt=>({dispatchId:randomUUID(),prompt}));
  const route = (i:number) => '/sessions/grok/'+groups[i]+'/messages';
  try {
    for (const [i,body] of bodies.entries()) assert.equal((await first.request(route(i),body)).status,202);
    const one = await (await first.request('/tasks/'+bodies[0]!.dispatchId)).json() as { state:string };
    assert.equal(one.state,'delivered');
  } finally { await first.close(); }
  const restarted = await serve(agent(),{taskFile:join(folder,'tasks.sqlite')});
  try {
    for (const [i,body] of bodies.entries()) assert.equal((await restarted.request(route(i),body)).status,202);
    assert.deepEqual(deliveries,['group-one:GROUP-A','group-two:GROUP-B']);
    type Row = { id:string; state:string; session_name:string; preview:string };
    await restarted.request('/tasks');
    await delay(20);
    const rows = await (await restarted.request('/tasks')).json() as Row[];
    for (const [i,body] of bodies.entries()) {
      const task = rows.find(row=>row.id === body.dispatchId);
      assert.equal(task?.state,'replied');
      assert.equal(task?.preview,'Reply in ' + groups[i]);
      assert.equal(task?.session_name,'Native ' + groups[i]);
    }
  } finally { await restarted.close(); rmSync(folder,{recursive:true,force:true}); }
});

test('previous Grok dispatches can recover with an exact unique prompt, but two matching dispatches in one group stay unassigned', async () => {
  const dir = mkdtempSync(join(tmpdir(),'acc-grok-correlation-')), file = join(dir,'tasks.sqlite');
  const prompt = 'Exact message', id = randomUUID(), copy = randomUUID();
  const book = new TaskBook(file);
  for (const [dispatch,session] of [[id,'one'],[copy,'two'],[randomUUID(),'two']] as const) {
    book.reserveWorkbench({id:dispatch,engine:'grok',session,project:'',prompt});
    book.link(dispatch,{nativeTurn:'grok-legacy-observed'}); book.set(dispatch,'delivered');
  }
  book.db.close();
  const host = new PluginHost(), turn = 'grok-msg-' + createHash('sha256').update(prompt).digest('hex').slice(0,28);
  host.register({id:'grok',label:'Grok',capabilities:{},status:()=>({connected:true}),list:()=>[],models:()=>[],
    create:()=>({id:'one'}),send:()=>{throw new Error('unexpected resend');},
    read:id=>({session:new UnifiedSession({id,engine:'grok'}),turns:[new UnifiedTurn({id:turn,userPrompt:prompt,status:'unknown',assistantReply:'Confirmed reply'})]}),
  });
  const s = await serve(host,{taskFile:file});
  try {
    await s.request('/tasks'); await delay(20);
    const rows = await (await s.request('/tasks')).json() as {id:string;state:string}[];
    assert.equal(rows.find(t=>t.id===id)?.state,'replied');
    assert.equal(rows.find(t=>t.id===copy)?.state,'delivered');
  } finally { await s.close(); rmSync(dir,{recursive:true,force:true}); }
});

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
