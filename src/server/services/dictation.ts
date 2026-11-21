import { randomUUID } from 'node:crypto';
import type { PluginHost } from '../core/plugin-host.js';
import type { DictationInfo, DictationReady, DictationSkip, DictationSource, DictationStart, DictationStream, Engine } from '../../shared/contract.js';
import { messageOf } from '../../shared/guards.js';
import { dictationOrder } from '../../shared/dictation.js';

export interface Transcript { text: string; final: boolean; error: string }
interface DictationSession { id: string; engine: string; text: string; final: boolean; error: string; listeners: Set<(snapshot: Transcript) => void>; touched: number; stream: DictationStream | null; timer?: ReturnType<typeof setInterval> }

/** No speech service could start: `skipped` says why each one could not. */
export const NO_VOICE = '没有可用的语音识别';
const READY_MS = 15000, CHECK_MS = 5000;

// Relays microphone audio (16 kHz mono 16-bit PCM from the browser) to an engine's own
// speech-to-text and publishes the running transcript. Engines opt in with
// `dictate({ language, onText, onError, onEnd })`, returning { send, finish, cancel }, and may say
// beforehand whether it can start (`dictationReady()`). No engine's service is required: they are
// tried in the order of shared/dictation.ts, and the first that starts takes the session.
class DictationService {
  host: PluginHost; idleMs: number; preferred: string; sessions: Map<string, DictationSession>;
  private checks = new Map<string, { at: number; ready: Promise<DictationReady> }>();
  constructor(host: PluginHost, { idleMs = 60000, preferred = '' }: { idleMs?: number; preferred?: string } = {}) { this.host = host; this.idleMs = idleMs; this.preferred = preferred; this.sessions = new Map(); }

  private providers(): Engine[] { return [...this.host.engines.values()].filter(engine => typeof engine.dictate === 'function'); }
  /** Whether this engine's service can start; a check is kept for a few seconds, a failed one never fails the caller. */
  readiness(engine: Engine, { fresh = false }: { fresh?: boolean } = {}): Promise<DictationReady> {
    const kept = this.checks.get(engine.id);
    if (!fresh && kept && Date.now() - kept.at < READY_MS) return kept.ready;
    const check = async (): Promise<DictationReady> => {
      if (!engine.dictationReady) return { ready: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<DictationReady>(resolve => { timer = setTimeout(() => resolve({ ready: true }), CHECK_MS); timer.unref?.(); });
      try {
        const answer = await Promise.race([Promise.resolve(engine.dictationReady()), late]);
        return answer.ready ? { ready: true } : { ready: false, reason: answer.reason || `${engine.label} 语音识别暂时不可用` };
      } catch (err) { return { ready: false, reason: messageOf(err) || `${engine.label} 语音识别暂时不可用` }; }
      finally { clearTimeout(timer); }
    };
    const ready = check();
    this.checks.set(engine.id, { at: Date.now(), ready });
    return ready;
  }
  /** Every agent's speech service, in the order the agents were switched on, with whether it can start now. */
  async sources(): Promise<DictationInfo> {
    const sources = await Promise.all(this.providers().map(async (engine): Promise<DictationSource> => {
      const { ready, reason } = await this.readiness(engine);
      return { engine: engine.id, label: engine.label, ready, ...(reason ? { reason } : {}) };
    }));
    return { preferred: this.preferred, sources };
  }

  // `current`: the agent the text is typed for; `prefer`: the person's pick (shared/dictation.ts).
  async start(current: string, { language = 'zh', prefer }: { language?: string; prefer?: string } = {}): Promise<DictationStart> {
    const providers = this.providers();
    const order = dictationOrder(providers.map(engine => engine.id), { ...(prefer ? { prefer } : {}), preferred: this.preferred, current });
    const id = randomUUID();
    const session: DictationSession = { id, engine: '', text: '', final: false, error: '', listeners: new Set(), touched: Date.now(), stream: null };
    const publish = () => { for (const listener of session.listeners) listener(this.snapshot(session)); };
    this.sessions.set(id, session);
    const skipped: DictationSkip[] = [];
    for (const engineId of order) {
      const engine = providers.find(item => item.id === engineId);
      if (!engine?.dictate) continue;
      const check = await this.readiness(engine, { fresh: true });
      if (!check.ready) { skipped.push({ engine: engine.id, label: engine.label, reason: check.reason || '' }); continue; }
      // What a service that failed to start reports afterwards is not this session's.
      const mine = () => session.engine === engine.id;
      try {
        session.engine = engine.id;
        session.stream = await engine.dictate({
          language,
          onText: text => { if (mine()) { session.text = text; publish(); } },
          onError: message => { if (mine()) { session.error = String(message || '语音识别失败'); publish(); } },
          onEnd: () => { if (mine()) { session.final = true; publish(); setTimeout(() => this.drop(id), 5000).unref?.(); } },
        });
      } catch (err) {
        session.engine = ''; session.error = ''; session.text = '';
        this.checks.delete(engine.id);
        skipped.push({ engine: engine.id, label: engine.label, reason: messageOf(err) || '语音识别失败' });
        continue;
      }
      session.timer = setInterval(() => { if (Date.now() - session.touched > this.idleMs) this.cancel(id); }, 5000);
      session.timer.unref?.();
      return { id, engine: engine.id, label: engine.label, skipped };
    }
    this.sessions.delete(id);
    throw Object.assign(new Error(NO_VOICE), { status: 409, skipped });
  }
  get(id: string): DictationSession {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('听写已结束'), { status: 404 });
    session.touched = Date.now();
    return session;
  }
  snapshot(session: DictationSession): Transcript { return { text: session.text, final: session.final, error: session.error }; }
  subscribe(id: string, listener: (snapshot: Transcript) => void): () => void {
    const session = this.get(id);
    session.listeners.add(listener); listener(this.snapshot(session));
    return () => { session.listeners.delete(listener); };
  }
  // The stream is set once start() has it; audio before that is a programming error, as before.
  audio(id: string, chunk: Uint8Array): void { this.streamOf(id).send(chunk); }
  finish(id: string): void { this.streamOf(id).finish(); }
  streamOf(id: string): DictationStream { const stream = this.get(id).stream; if (!stream) throw new TypeError('Cannot read properties of null'); return stream; }
  cancel(id: string): void { const session = this.sessions.get(id); if (!session) return; session.stream?.cancel(); session.final = true; this.drop(id); }
  drop(id: string): void { const session = this.sessions.get(id); if (!session) return; clearInterval(session.timer); session.listeners.clear(); this.sessions.delete(id); }
  /** An engine has left the console: what it was transcribing ends, and its last check is forgotten. */
  release(engine: string): void { this.checks.delete(engine); for (const session of [...this.sessions.values()]) if (session.engine === engine) this.cancel(session.id); }
  dispose(): void { for (const id of [...this.sessions.keys()]) this.cancel(id); }
}
export { DictationService };
