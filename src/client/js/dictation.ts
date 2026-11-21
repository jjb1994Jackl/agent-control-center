import { t, say } from './i18n.js';
import { get, list, str } from '../../shared/guards.js';
import type { DictationSkip, DictationStart } from '../../shared/contract.js';
// Microphone capture as 16 kHz mono 16-bit PCM, the format both Claude's and
// Antigravity's speech services accept, sent in ~100 ms chunks.
const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) { const channel = inputs[0]?.[0]; if (channel) this.port.postMessage(channel.slice(0)); return true; }
}
registerProcessor('pcm-tap', PcmTap);`;

type Level = (peak: number) => void;
export class PcmRecorder {
  onChunk: (chunk: ArrayBuffer) => void; onLevel: Level | undefined; pending: Int16Array[] = []; size = 0;
  stream?: MediaStream; context?: AudioContext; source?: MediaStreamAudioSourceNode; node?: AudioWorkletNode;
  constructor(onChunk: (chunk: ArrayBuffer) => void, { onLevel }: { onLevel?: Level | undefined } = {}) { this.onChunk = onChunk; this.onLevel = onLevel; }
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    this.context = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await this.context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-tap');
    // The worklet above posts each block of samples as a Float32Array.
    this.node.port.onmessage = event => { if (event.data instanceof Float32Array) this.push(event.data); };
    this.source.connect(this.node);
  }
  push(samples: Float32Array): void {
    let peak = 0;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
      peak = Math.max(peak, Math.abs(value));
      pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    this.onLevel?.(peak);
    this.pending.push(pcm); this.size += pcm.length;
    if (this.size >= 1600) this.flush();
  }
  flush(): void {
    if (!this.size) return;
    const chunk = new Int16Array(this.size); let offset = 0;
    for (const part of this.pending) { chunk.set(part, offset); offset += part.length; }
    this.pending = []; this.size = 0;
    this.onChunk(chunk.buffer);
  }
  async stop(): Promise<void> {
    this.flush();
    this.source?.disconnect(); this.node?.disconnect();
    for (const track of this.stream?.getTracks() || []) track.stop();
    await this.context?.close().catch(() => {});
  }
}

const language = () => ((navigator.language || 'zh').split('-')[0] ?? '').toLowerCase();

export interface DictationCallbacks { onText(text: string | undefined): void; onError(message: string): void; onEnd(): void; onLevel?: Level }
export interface DictationSession { supported?: boolean; start(): Promise<DictationStart | void>; stop(): Promise<void>; cancel(): Promise<void> }

/** No agent's speech service could start; `skipped` says why for each. */
export class VoiceUnavailable extends Error {
  skipped: DictationSkip[];
  constructor(message: string, skipped: DictationSkip[]) { super(message); this.name = 'VoiceUnavailable'; this.skipped = skipped; }
}
const skipsOf = (value: unknown): DictationSkip[] => list(value).map(item => ({ engine: str(get(item, 'engine')) || '', label: str(get(item, 'label')) || '', reason: str(get(item, 'reason')) || '' }));

// Dictation through the console server, which relays to an agent's own speech service: the
// first of them that can start (shared/dictation.ts), for the chat of `engine`.
export function nativeDictation(engine: string, { onText, onError, onEnd, onLevel }: DictationCallbacks, { prefer = '' }: { prefer?: string } = {}): DictationSession {
  const base = `/api/dictation/${encodeURIComponent(engine)}`;
  let id: string | undefined, source: EventSource | null = null, chain: Promise<unknown> = Promise.resolve(), recorder: PcmRecorder | null = null, closed = false;
  const post = (path: string, body?: ArrayBuffer) => fetch(`${base}/${id}/${path}`, { method: 'POST', ...(body ? { headers: { 'Content-Type': 'application/octet-stream' }, body } : {}) });
  const close = () => { if (closed) return; closed = true; source?.close(); onEnd(); };
  return {
    async start() {
      const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: language(), ...(prefer ? { prefer } : {}) }) });
      const data: unknown = await response.json();
      if (!response.ok) {
        const skipped = skipsOf(get(data, 'skipped')), message = say(str(get(data, 'error'))) || t('无法开始听写');
        if (response.status === 409 && Array.isArray(get(data, 'skipped'))) throw new VoiceUnavailable(message, skipped);
        throw new Error(message);
      }
      id = str(get(data, 'id'));
      source = new EventSource(`${base}/${id}/events`);
      source.addEventListener('transcript', event => {
        const snapshot: unknown = JSON.parse(event.data), error = str(get(snapshot, 'error'));
        onText(str(get(snapshot, 'text')));
        if (error) onError(say(error));
        if (get(snapshot, 'final')) close();
      });
      source.onerror = () => { if (!closed) { onError(t('听写连接中断')); close(); } };
      recorder = new PcmRecorder(chunk => { chain = chain.then(() => post('audio', chunk)).catch(() => {}); }, { onLevel });
      try { await recorder.start(); } catch (err) { post('cancel'); close(); throw err; }
      return { id: id || '', engine: str(get(data, 'engine')) || '', label: str(get(data, 'label')) || '', skipped: skipsOf(get(data, 'skipped')) };
    },
    async stop() { await recorder?.stop(); await chain; if (id) await post('finish'); window.setTimeout(close, 10000); },
    async cancel() { await recorder?.stop(); if (id) post('cancel'); close(); },
  };
}

// For engines without their own speech service: the browser's recognizer.
export function browserDictation({ onText, onError, onEnd }: DictationCallbacks): DictationSession {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition: SpeechRecognition | null = null, finals = '', closed = false;
  const close = () => { if (!closed) { closed = true; onEnd(); } };
  return {
    supported: !!Recognition,
    async start() {
      if (!Recognition) throw new Error(t('当前浏览器不支持语音识别'));
      const listening = recognition = new Recognition();
      listening.lang = navigator.language || 'zh-CN'; listening.continuous = true; listening.interimResults = true;
      listening.onresult = event => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i], said = result?.[0]?.transcript;
          if (result?.isFinal) finals += said; else interim += said;
        }
        onText(finals + interim);
      };
      listening.onerror = event => { if (event.error !== 'aborted') onError(event.error === 'not-allowed' ? t('没有麦克风权限') : `${t('语音识别失败：')}${event.error}`); };
      listening.onend = close;
      listening.start();
    },
    async stop() { recognition?.stop(); },
    async cancel() { recognition?.abort(); close(); },
  };
}
