import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { createApp } from '../src/server/server.js';
import { TaskBook } from '../src/server/services/task-board.js';
import { grokUsageOf, readGrokReceipts, receiptPrompt } from '../src/server/services/grok-desktop.js';

test('Grok accepts only known task IDs with explicit states, not unrelated or combined replies', () => {
  const a = randomUUID(), b = randomUUID(), unknown = randomUUID();
  assert.ok(receiptPrompt('My task', a).includes(a));
  assert.deepEqual(readGrokReceipts([
    `Working. taskId: ${a}`,
    `ACC_RECEIPT ${unknown} COMPLETED\nnot requested`,
    `ACC_RECEIPT ${a} COMPLETED\ncombined with ${b}`,
    `ACC_RECEIPT\n${b}\nWAITING\nNeed approval`,
    `ACC_RECEIPT ${a} FAILED\nTool unavailable`,
  ], new Set([a, b])), [
    { id: b, state: 'waiting', text: 'Need approval' },
    { id: a, state: 'failed', text: 'Tool unavailable' },
  ]);
});

test('Grok quota shows the source value and handles zero without inventing an exact reset date', () => {
  assert.equal(grokUsageOf({ usedPercent: -1 }), null);
  assert.equal(grokUsageOf({ usedPercent: '13%' }), null);
  assert.deepEqual(grokUsageOf({ usedPercent: 100, resetLabel: '2 days until reset' })?.windows, [{
    id: 'weekly', label: '每周用量', windowMinutes: 10080, usedPercent: 100, remainingPercent: 0, resetLabel: '2 days until reset',
  }]);
});

test('board persists matching Grok results, keeps them out of list polling and ignores terminal or foreign rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-grok-'));
  const file = join(dir, 'tasks.sqlite');
  const book = new TaskBook(file);
  const a = randomUUID(), b = randomUUID(), foreign = randomUUID();
  for (const [id, engine, state] of [[a, 'grok', 'accepted'], [b, 'grok', 'failed'], [foreign, 'codex', 'accepted']] as const) {
    book.reserve(id, engine, '', '', id);
    book.set(id, state, 'original');
  }
  book.db.close();
  const text = 'z'.repeat(500);
  const context = await createApp({
    host: new PluginHost(), taskFile: file,
    grok: {
      receipts: async ids => {
        assert.deepEqual([...ids], [a]);
        return { receipts: [a, b, foreign].map(id => ({ id, state: 'completed', text })) };
      },
      usage: async () => ({ available: false, checkedAt: 0 }),
    },
  });
  const server = context.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const api = 'http://127.0.0.1:' + addr.port + '/api/tasks';
  try {
    await fetch(api);
    let rows: Array<{ id: string; state: string; preview: string; result?: string }> = [];
    for (let i = 0; i < 30; i++) {
      rows = await (await fetch(api)).json() as typeof rows;
      if (rows.find(row => row.id === a)?.state === 'completed') break;
      await delay(10);
    }
    assert.equal(rows.find(row => row.id === a)?.state, 'completed');
    assert.equal(rows.find(row => row.id === a)?.preview.length, 320);
    assert.equal(rows.find(row => row.id === a)?.result, undefined);
    assert.equal(rows.find(row => row.id === b)?.state, 'failed');
    assert.equal(rows.find(row => row.id === foreign)?.state, 'accepted');
    assert.equal(((await (await fetch(api + '/' + a)).json()) as { result: string }).result, text);
  } finally {
    server.close();
    await context.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
