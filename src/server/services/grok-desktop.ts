import { DesktopAutomation } from '../core/desktop-automation.js';
import type { Usage } from '../../shared/contract.js';
import { bag, get, list } from '../../shared/guards.js';
import type { CheckedUsage } from './usage-service.js';

const idShape = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const envelope = new RegExp(`^\\s*ACC_RECEIPT[ \\t\\r\\n]+(${idShape})[ \\t\\r\\n]+(COMPLETED|FAILED|WAITING)\\b[ \\t]*[:：]?`, 'im');
const legacy = new RegExp(`\\btaskId\\s*[:：]\\s*(${idShape})\\b`, 'gi');
const receiptId = new RegExp(`\\b${idShape}\\b`, 'gi');
type ReceiptState = 'completed' | 'failed' | 'waiting';
export type GrokReceipt = { id: string; state: ReceiptState; text: string };
export type GrokRead = { receipts: GrokReceipt[]; reason?: string };

export function receiptPrompt(prompt: string, id: string): string {
  return `${prompt}

[控制中心回执] 执行上面的任务。请主 Bot 在回到当前对话时保留以下作为独立首行（不要翻译或改写编号），下一行起放结果或等待原因：
ACC_RECEIPT ${id} <COMPLETED|FAILED|WAITING>
用实际状态替换尖括号内内容：成功完成用 COMPLETED，确认失败用 FAILED，需要我处理才能继续用 WAITING。不要把开始执行当成完成。`;
}

export function readGrokReceipts(messages: readonly unknown[], pending: ReadonlySet<string>): GrokReceipt[] {
  const result: GrokReceipt[] = [];
  for (const message of messages) {
    if (typeof message !== 'string' || message.length > 16000) continue;
    const marked = [...new Set([...message.matchAll(receiptId)].map(match => match[0].toLowerCase()).filter(id => pending.has(id)))];
    if (marked.length !== 1) continue;
    const match = envelope.exec(message);
    if (match && match[1]!.toLowerCase() === marked[0]) {
      const state = match[2]!.toLowerCase() as ReceiptState;
      const text = (message.slice(0, match.index) + message.slice(match.index + match[0].length)).trim();
      if (text) result.push({ id: marked[0]!, state, text });
      continue;
    }
    // V1 returned native prose; only accept an explicit success from the named routine.
    const old = [...message.matchAll(legacy)];
    const tag = old.length === 1 ? old[0] : undefined;
    if (tag && tag[1]?.toLowerCase() === marked[0]
        && /本机控制中心派单(?:任务)?(?:已完成|已跑通|成功完成)/.test(message)) {
      result.push({ id: marked[0]!, state: 'completed', text: message.replace(tag[0], '').trim() });
    }
  }
  return result;
}

export function grokUsageOf(raw: unknown): Usage | null {
  const used = get(raw, 'usedPercent');
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const reset = get(raw, 'resetLabel');
  return { available: true, windows: [{
    id: 'weekly', label: '每周用量', windowMinutes: 10080, usedPercent: used, remainingPercent: 100 - used,
    ...(typeof reset === 'string' && reset.length < 90 ? { resetLabel: reset } : {}),
  }] };
}

export class GrokDesktop {
  private readonly ax = new DesktopAutomation({ engine: 'grok', label: 'Grok Bot' });
  private lastUsage?: CheckedUsage;
  private readingUsage?: Promise<CheckedUsage>;
  native(args: string[], input?: string) {
    return this.ax.run(args, { timeout: 18000, ...(input === undefined ? {} : { input }) });
  }
  async receipts(ids: ReadonlySet<string>): Promise<GrokRead> {
    if (process.platform !== 'darwin') return { receipts: [], reason: 'Grok 回传目前需要 macOS 原应用' };
    const result = await this.ax.run(['receipts'], { input: [...ids].join('\n'), timeout: 14000 });
    if (!result.ok) return { receipts: [], reason: result.error || '暂时无法读取 Grok 回传' };
    return { receipts: readGrokReceipts(list(result['messages']), ids) };
  }
  async usage(refresh = false): Promise<CheckedUsage> {
    if (!refresh) return this.lastUsage ?? { available: false, checkedAt: 0, reason: '尚未读取。点击刷新 Grok 额度。' };
    if (this.readingUsage) return this.readingUsage;
    const read = this.refreshUsage();
    this.readingUsage = read;
    try { return await read; } finally { this.readingUsage = undefined; }
  }
  private async refreshUsage(): Promise<CheckedUsage> {
    if (process.platform !== 'darwin') return { available: false, checkedAt: 0, reason: 'Grok 额度目前需要 macOS 原应用' };
    const seen = await this.ax.run(['refresh-quota'], { timeout: 16000 });
    const usage = seen.ok && grokUsageOf(bag(seen['quota']));
    if (usage) return (this.lastUsage = { ...usage, checkedAt: Date.now() });
    return { ...(this.lastUsage ?? { available: false, checkedAt: 0 }), reason: seen.error || 'Grok 未返回本周额度' };
  }
}

export type GrokReader = Pick<GrokDesktop, 'receipts' | 'usage'>;
export const grokDesktop = new GrokDesktop();
