// Steering a Codex turn that the desktop app is running. The desktop (ChatGPT.app) keeps a local
// IPC router (~/.codex/ipc/ipc.sock on macOS, the pipe \\.\pipe\codex-ipc on Windows) where its own windows coordinate: a window that does not own
// a thread asks the owner to act with "thread-follower-*" requests. We join briefly as one more
// follower and send "thread-follower-steer-turn"; the owning window delivers the message exactly as
// if it had been typed into its composer while the turn runs. Nothing is read from or written to
// the desktop's files. Frames are a 4-byte little-endian length followed by JSON.
// The router's messages are the desktop's private format: they are parsed as unknown and read
// through the guards, so a message nobody understands is skipped.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bag, get, isBag, list, parseJson } from '../shared/guards.js';

const STEER_VERSION = 1; // the desktop's protocol version for thread-follower-steer-turn
const INTERRUPT_VERSION = 4; // …and for thread-follower-interrupt-turn with an expected turn
const OWNER_VERSION = 1; // …for thread-owner-discovery
const READ_SETTINGS_VERSION = 1; // …for thread-follower-read-model-settings
const SETTINGS_VERSION = 2; // …and for thread-follower-update-thread-settings with a condition
// A window that owns a thread answers whether it does within milliseconds (4-16 ms measured). When
// none does, the router waits 10 s for a client that never answers before it says so; the console
// stops waiting long before that.
const OWNER_WAIT_MS = 500;

/** An error from the desktop's router, with the code the bridge tells apart ('timeout', 'no-client-found', …). */
export interface IpcError extends Error { code: string }
/** The socket the IPC is spoken over (net.Socket, or a stand-in in tests). */
export type Connect = (sock: string) => net.Socket;
export interface RequestOptions { version?: number; timeoutMs?: number; sock?: string; connect?: Connect }
export interface WatchOptions { sock?: string; connect?: Connect; hostId?: string; retryMs?: number }
/** One of the desktop's requests to the person, as its state holds it. */
export interface DesktopRequest { id: unknown; method: unknown; params: unknown }
export interface Watcher { close(): void }
/** An app-server input item, as the desktop's composer sends it. */
export type CodexInput = { type: string; [field: string]: unknown };

const ipcError = (message: string, code: string): IpcError => Object.assign(new Error(message), { code });

// Where the desktop's router listens: a socket under the Codex home on macOS; on Windows a named
// pipe, since Node and Electron cannot listen on a socket path there (the desktop's own code:
// `path.join("\\\\.\\pipe", "codex-ipc")`). net.createConnection takes either. CODEX_IPC_PATH
// overrides it on Windows (tests, or a Codex build that names its pipe otherwise).
function socketPath(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return process.env.CODEX_IPC_PATH || '\\\\.\\pipe\\codex-ipc';
  return path.join(codexHome, 'ipc', 'ipc.sock');
}

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Reads every complete frame out of `buffer`; answers what is left over.
function frames(buffer: Buffer, onMessage: (message: unknown) => boolean | void): Buffer {
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE(0);
    if (buffer.length < 4 + size) break;
    let message: unknown; try { message = parseJson(buffer.subarray(4, 4 + size).toString('utf8')); } catch { message = null; }
    buffer = buffer.subarray(4 + size);
    if (!message) continue;
    if (onMessage(message) === false) break;
  }
  return buffer;
}

// The router asks every client whether it can serve other clients' requests: we never can.
// Answers true when the message was one of those.
function refuseServing(socket: net.Socket, message: unknown): boolean {
  const type = get(message, 'type');
  if (type === 'client-discovery-request') { socket.write(frame({ type: 'client-discovery-response', requestId: get(message, 'requestId'), response: { canHandle: false } })); return true; }
  if (type === 'request') { socket.write(frame({ type: 'response', requestId: get(message, 'requestId'), resultType: 'error', error: 'unsupported' })); return true; }
  return false;
}

// One short-lived connection: initialize, send one request, wait for its response, close.
function request(method: string, params: unknown, { version = 0, timeoutMs = 30000, sock = socketPath(), connect = net.createConnection }: RequestOptions = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(sock);
    let buffer: Buffer = Buffer.alloc(0), clientId: unknown = null, settled = false;
    const initId = randomUUID(), requestId = randomUUID();
    const done = (err: Error | null, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => done(ipcError('Codex 桌面版没有响应', 'timeout')), timeoutMs);
    socket.on('error', (err: NodeJS.ErrnoException) => done(ipcError('连不上 Codex 桌面版', err.code || 'unavailable')));
    socket.on('close', () => done(ipcError('Codex 桌面版断开了连接', 'closed')));
    socket.on('connect', () => socket.write(frame({ type: 'request', requestId: initId, method: 'initialize', params: { clientType: 'desktop-bridge' }, version: 0 })));
    socket.on('data', (chunk: Buffer) => {
      buffer = frames(Buffer.concat([buffer, chunk]), message => {
        if (refuseServing(socket, message)) return;
        if (get(message, 'type') !== 'response') return;
        const id = get(message, 'requestId');
        if (id === initId) {
          if (get(message, 'resultType') !== 'success') { done(new Error('Codex 桌面版拒绝了连接')); return false; }
          clientId = get(message, 'result', 'clientId');
          socket.write(frame({ type: 'request', requestId, sourceClientId: clientId, version, method, params, timeoutMs }));
        } else if (id === requestId) {
          if (get(message, 'resultType') === 'error') { const code = String(get(message, 'error') || 'error'); done(ipcError(code, code)); return false; }
          done(null, get(message, 'result'));
        }
      });
    });
  });
}

// The desktop's composer sends text first, then pictures, in the app-server's input format.
function steer({ threadId, prompt, inputs, cwd }: { threadId: string; prompt: string; inputs: CodexInput[]; cwd?: string | null }, options?: RequestOptions): Promise<unknown> {
  const id = randomUUID();
  return request('thread-follower-steer-turn', {
    conversationId: threadId,
    clientUserMessageId: id,
    input: inputs,
    serviceTier: null,
    attachments: [],
    additionalContext: null,
    toolOutput: null,
    restoreMessage: {
      id, text: prompt, cwd: cwd || null, createdAt: Date.now(),
      context: { prompt, imageAttachments: [], fileAttachments: [], addedFiles: [], pastedTextAttachments: [] },
      responsesapiClientMetadata: { source: 'codex' },
    },
  }, { version: STEER_VERSION, ...options });
}

// Starts a turn in the window that owns the thread, as its own composer does when no turn runs.
// Only the message is given: the owner fills in the chat's cwd, model, effort, mode and
// permissions as for a message typed there (measured on Windows: the turn's turn_context matched
// the desktop's own turns).
const START_VERSION = 2;
function startTurn({ threadId, inputs }: { threadId: string; inputs: CodexInput[] }, options?: RequestOptions): Promise<unknown> {
  return request('thread-follower-start-turn', {
    conversationId: threadId,
    turnStart: { request: { threadId, clientUserMessageId: randomUUID(), input: inputs }, context: {} },
  }, { version: START_VERSION, timeoutMs: 20000, ...options });
}

// Stops the turn the desktop is running, as its own Stop button does ("user-stop"); only that
// turn, so a turn that has already ended is not mistaken for the next one.
function interrupt({ threadId, turnId }: { threadId: string; turnId: string }, options?: RequestOptions): Promise<unknown> {
  return request('thread-follower-interrupt-turn', { conversationId: threadId, mode: 'user-stop', expectedTurnId: turnId }, { version: INTERRUPT_VERSION, timeoutMs: 15000, ...options });
}

// ---- the thread as the owning window holds it while it runs ----
// The window that owns a thread keeps its live state and shares it with windows that follow the
// thread: a window says it follows ("thread-stream-following-changed"), the owner answers with a
// snapshot of the conversation's state, then sends patches as it changes
// ("thread-stream-state-changed"). The patches are immer's ({ op, path, value }). Two parts of it
// are read here: the app-server's requests to the person, and the turns with their items, whose
// reply text grows as the desktop draws it (the record on disk only has a reply once it is whole).
// A follower that missed a revision says it follows again and gets a new snapshot. Nothing is
// changed by following.
const FOLLOWING_VERSION = 1;

export interface Patch { op: unknown; path?: unknown; value?: unknown }

// Applies immer patches to a plain value, in place where it can; answers the new value.
// The value is the desktop's state (unknown): keys are written with Reflect, since no type is
// claimed for the object being patched.
function applyPatches(base: unknown, patches: readonly Patch[]): unknown {
  let root = base;
  for (const { op, path: rawPath, value } of patches) {
    const at = list(rawPath);
    if (!at.length) { root = op === 'remove' ? undefined : value; continue; }
    let parent: unknown = root;
    for (const key of at.slice(0, -1)) { if (parent == null) break; parent = get(parent, String(key)); }
    if (parent == null || typeof parent !== 'object') continue;
    const last = at[at.length - 1];
    if (Array.isArray(parent)) {
      const items: unknown[] = parent;
      const index = last === '-' ? items.length : Number(last);
      if (last === 'length') items.length = Number(value);
      else if (op === 'add') items.splice(index, 0, value);
      else if (op === 'remove') items.splice(index, 1);
      else items[index] = value;
    } else if (op === 'remove') Reflect.deleteProperty(parent, String(last));
    else Reflect.set(parent, String(last), value);
  }
  return root;
}

const requestsOf = (value: unknown): DesktopRequest[] => list(value).filter(isBag).map(item => ({ ...item, id: item['id'], method: item['method'], params: item['params'] }));
// The owner's turns: the ones it is running, and the ones its history holds (keyed entities, each
// with its `turnId` and app-server items).
const turnsOf = (state: unknown): unknown[] => [...list(get(state, 'turns')), ...Object.values(bag(get(state, 'turnHistory', 'history', 'entitiesByKey')) || {})];

/** What the owning window holds for a thread, as `watch` reports it. The turns are the owner's live objects: read them, keep nothing. */
export interface LiveThread { requests: DesktopRequest[]; turns: unknown[] }

// Follows one thread while `watch` is open: onChange({ requests, turns }) each time the owner's
// state changes (often, while a reply is being written). Answers { close() }.
function watch(conversationId: string, onChange: (live: LiveThread) => void, { sock = socketPath(), connect = net.createConnection, hostId = 'local', retryMs = 2000 }: WatchOptions = {}): Watcher {
  const socket = connect(sock);
  let buffer: Buffer = Buffer.alloc(0), clientId: unknown = null, revision: unknown = null, state: unknown = null, closed = false;
  const initId = randomUUID();
  const follow = (on: boolean) => clientId && !socket.destroyed && socket.write(frame({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: clientId, params: { conversationId, hostId, following: on }, version: FOLLOWING_VERSION }));
  // The requests are copied: a card keeps its request after the owner's state has moved on.
  const changed = () => onChange({ requests: requestsOf(structuredClone(get(state, 'requests'))), turns: turnsOf(state) });
  // Until a snapshot comes (the desktop takes the thread on once it starts the turn), ask again.
  const timer = setInterval(() => { if (revision == null) follow(true); }, retryMs);
  timer.unref?.();
  socket.on('error', () => {});
  socket.on('connect', () => socket.write(frame({ type: 'request', requestId: initId, method: 'initialize', params: { clientType: 'desktop-bridge' }, version: 0 })));
  socket.on('data', (chunk: Buffer) => {
    buffer = frames(Buffer.concat([buffer, chunk]), message => {
      if (refuseServing(socket, message)) return;
      const type = get(message, 'type');
      if (type === 'response' && get(message, 'requestId') === initId) { clientId = get(message, 'result', 'clientId'); follow(true); return; }
      if (type !== 'broadcast' || get(message, 'method') !== 'thread-stream-state-changed' || get(message, 'params', 'conversationId') !== conversationId) return;
      const change = get(message, 'params', 'change') || {};
      const kind = get(change, 'type');
      if (kind === 'snapshot') { revision = get(change, 'revision'); state = get(change, 'conversationState') || {}; changed(); }
      else if (kind === 'patches') {
        // Patches before the first snapshot are for the owner's other followers; the retry asks again.
        if (revision == null) return;
        if (get(change, 'baseRevision') !== revision) { revision = null; follow(true); return; }
        revision = get(change, 'revision');
        const patches = list(get(change, 'patches')).map((item): Patch => ({ op: get(item, 'op'), value: get(item, 'value'), path: list(get(item, 'path')) }));
        if (patches.length) { state = applyPatches(state, patches) || {}; changed(); }
      }
    });
  });
  return { close() { if (closed) return; closed = true; clearInterval(timer); follow(false); setTimeout(() => socket.destroy(), 200).unref?.(); } };
}

// Answers what the desktop asked for, through the window that owns the thread, as its own card does.
// `requestId` is the request's id as the desktop holds it.
const answerUserInput = ({ threadId, requestId, response }: { threadId: string; requestId: unknown; response: unknown }, options?: RequestOptions): Promise<unknown> => request('thread-follower-submit-user-input', { conversationId: threadId, requestId, response }, { version: 1, timeoutMs: 15000, ...options });
const decideApproval = ({ threadId, requestId, kind, decision }: { threadId: string; requestId: unknown; kind: 'fileChange' | 'commandExecution'; decision: 'accept' | 'decline' }, options?: RequestOptions): Promise<unknown> => request(kind === 'fileChange' ? 'thread-follower-file-approval-decision' : 'thread-follower-command-approval-decision', { conversationId: threadId, requestId, decision }, { version: 1, timeoutMs: 15000, ...options });

// ---- the model and effort a chat's next turn runs with ----
// The window that owns a thread holds its settings for the next turn. A follower can read them and
// ask the owner to change them; the owner then does what its own model menu does
// (updateThreadSettingsForNextTurn: the desktop's app-server records it and its composer shows it).
// Only a thread the desktop has loaded since it started has an owner.

// Whether a desktop window owns this thread; false when none answers in time.
async function owns(threadId: string, { waitMs = OWNER_WAIT_MS, ...options }: RequestOptions & { waitMs?: number } = {}): Promise<boolean> {
  try { await request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, { version: OWNER_VERSION, timeoutMs: waitMs, ...options }); return true; }
  catch { return false; }
}
/** The next turn's model and effort, as the owning window holds them. */
export interface ThreadSettings { model: string | null; effort: string | null }
async function readSettings(threadId: string, options?: RequestOptions): Promise<ThreadSettings> {
  const result = await request('thread-follower-read-model-settings', { conversationId: threadId }, { version: READ_SETTINGS_VERSION, timeoutMs: 3000, ...options });
  const model = get(result, 'settings', 'model'), effort = get(result, 'settings', 'reasoningEffort');
  return { model: typeof model === 'string' ? model : null, effort: typeof effort === 'string' ? effort : null };
}
// Sets the next turn's model and effort, as the desktop's model menu does (it always sends both).
// Applied only while the owner still holds `from`, so a pick made meanwhile in the desktop is not
// overwritten; answers whether it was applied.
async function updateSettings({ threadId, to, from }: { threadId: string; to: { model: string; effort: string | null }; from: ThreadSettings }, options?: RequestOptions): Promise<boolean> {
  const result = await request('thread-follower-update-thread-settings', {
    conversationId: threadId,
    threadSettings: { model: to.model, effort: to.effort },
    activeTurnId: null,
    condition: { ifModelEquals: from.model, ifEffortEquals: from.effort },
  }, { version: SETTINGS_VERSION, timeoutMs: 5000, ...options });
  return get(result, 'applied') === true;
}
/** Router errors that mean no window of the desktop has this chat (or the desktop is not there): nothing was asked of it. */
const NOT_REACHED = new Set(['no-client-found', 'ENOENT', 'ECONNREFUSED', 'EPIPE', 'unavailable', 'closed']);
const unreached = (err: unknown): boolean => NOT_REACHED.has(String(get(err, 'code') || ''));

/** What the bridge uses of the desktop's IPC; a stand-in replaces it in tests. */
export interface CodexDesktopIpc {
  steer: typeof steer;
  startTurn?: typeof startTurn;
  interrupt: typeof interrupt;
  watch?: typeof watch;
  answerUserInput: typeof answerUserInput;
  decideApproval: typeof decideApproval;
  owns?: typeof owns;
  readSettings?: typeof readSettings;
  updateSettings?: typeof updateSettings;
}

export { socketPath, frame, request, steer, startTurn, interrupt, unreached, applyPatches, watch, answerUserInput, decideApproval, owns, readSettings, updateSettings };
