// One-off test of the desktop router's settings requests (route B), against a test chat.
// Usage: tsx settings-test.ts <repo> <threadId> <effort> [<expected current effort>]
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [repo, threadId, effort, expected] = process.argv.slice(2);
const desktop = await import(pathToFileURL(path.join(repo, 'src/server/codex-desktop.ts')).href);
const read = async () => desktop.request('thread-follower-read-model-settings', { conversationId: threadId }, { version: 1, timeoutMs: 15000 });
console.log('read before:', JSON.stringify(await read()));
const params: Record<string, unknown> = { conversationId: threadId, threadSettings: { effort } };
if (expected) params.condition = { ifModelEquals: null, ifEffortEquals: expected };
try { console.log('update:', JSON.stringify(await desktop.request('thread-follower-update-thread-settings', params, { version: 2, timeoutMs: 15000 }))); }
catch (err) { console.log('update failed:', (err as Error).message, (err as { code?: string }).code); }
console.log('read after:', JSON.stringify(await read()));
