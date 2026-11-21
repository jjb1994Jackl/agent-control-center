// Node's own WebSocket (undici), which takes `headers` in its second argument: what Claude's
// speech stream needs to carry the sign-in (claude-bridge.ts, dictate).
// A handler slot the platform WebSocket fills with its own event types (MessageEvent, CloseEvent):
// written in method form so either the platform's handlers or a test stand-in's fit it.
type Handler<E> = { handle(event: E): void }['handle'] | null;
/** The socket dictation needs: the platform WebSocket, or a stand-in in tests. */
export interface VoiceSocket {
  binaryType: string; readyState: number;
  send(data: string | ArrayBufferLike | Uint8Array): void; close(): void;
  onopen: Handler<unknown>;
  onmessage: Handler<{ data: unknown }>;
  onerror: Handler<unknown>;
  onclose: Handler<{ code: number; reason: string }>;
}
export type VoiceSocketClass = new (url: string, init: { headers: Record<string, string> }) => VoiceSocket;
/**
 * Escape hatch, on purpose: where TypeScript's DOM library is loaded too (the tests, which also
 * import page modules), the global is declared as the browser's constructor, which takes no
 * headers; so it is read by name, and a function there is taken to be undici's class.
 */
const isSocketClass = (value: unknown): value is VoiceSocketClass => typeof value === 'function';
export const globalSocket = (): VoiceSocketClass | undefined => { const found: unknown = Reflect.get(globalThis, 'WebSocket'); return isSocketClass(found) ? found : undefined; };
