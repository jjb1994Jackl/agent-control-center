import { say } from './i18n.js';
import { get, str } from '../../shared/guards.js';
import type { BridgeEvent, RunTurn } from '../../shared/contract.js';

export interface RequestOptions { method?: string; body?: BodyInit | null; headers?: Record<string, string>; signal?: AbortSignal }
/**
 * The server's JSON answer. Trust boundary, on purpose: the page and the server are built from
 * the same contract (src/shared/contract.ts), so the caller names the shape it asked for; the
 * value comes from response.json(), which is typed as any by the DOM library.
 */
export async function request<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data: T = await response.json();
  if (!response.ok) throw new Error(say(str(get(data, 'error')) || '') || `Request failed (${response.status})`);
  return data;
}
/** The server's answer whatever its status, for a request whose refusal carries data the page acts on (same trust boundary as request). */
export async function answer<T = unknown>(url: string, options: RequestOptions = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data: T = await response.json();
  return { ok: response.ok, status: response.status, data };
}
export const sessionUrl = (engine: string, id: string): string => `/api/sessions/${encodeURIComponent(engine)}/${encodeURIComponent(id)}`;
export interface StreamHandlers { event(data: BridgeEvent): void; ready(data: StreamReady): void; reset(): void; error(): void }
/** The stream's first frame: where it starts, and the run the server is following, if any. */
export interface StreamReady { cursor: string | null; activeTurn: RunTurn | null }
// The stream's frames are JSON the server wrote from the same contract (see request above).
const frame = <T>(message: MessageEvent<string>): T => JSON.parse(message.data);
export function connect(engine: string, id: string, cursor: string | null | undefined, { event, ready, reset, error }: StreamHandlers): EventSource {
  const source = new EventSource(`${sessionUrl(engine, id)}/events${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`);
  source.addEventListener('bridge', message => event(frame<BridgeEvent>(message)));
  source.addEventListener('ready', message => ready(frame<StreamReady>(message)));
  source.addEventListener('reset', reset);
  source.onerror = error;
  return source;
}
