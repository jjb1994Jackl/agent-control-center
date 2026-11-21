import type { PluginHost } from '../core/plugin-host.js';
import type { Engine, Usage } from '../../shared/contract.js';
import { messageOf } from '../../shared/guards.js';

export type CheckedUsage = Usage & { checkedAt: number };
class UsageService {
  host: PluginHost; ttlMs: number; cache: Map<string, CheckedUsage>; pending: Map<string, Promise<CheckedUsage>>;
  constructor(host: PluginHost, { ttlMs = 60000 }: { ttlMs?: number } = {}) { this.host = host; this.ttlMs = ttlMs; this.cache = new Map(); this.pending = new Map(); }
  async read(engine: Engine): Promise<CheckedUsage> {
    const previous = this.cache.get(engine.id);
    if (previous && Date.now() - previous.checkedAt < this.ttlMs) return previous;
    const waiting = this.pending.get(engine.id);
    if (waiting) return waiting;
    const request = (async () => {
      let data: Usage;
      try { data = engine.usage ? await engine.usage() : { available: false, reason: '原生引擎未公开额度' }; }
      catch (error) { data = { available: false, reason: `暂时无法读取额度：${messageOf(error)}` }; }
      const result: CheckedUsage = { ...data, checkedAt: Date.now() };
      // (Not kept for an engine that left while it was being read.)
      if (this.host.engines.get(engine.id) === engine) this.cache.set(engine.id, result);
      return result;
    })();
    this.pending.set(engine.id, request);
    try { return await request; } finally { if (this.pending.get(engine.id) === request) this.pending.delete(engine.id); }
  }
  /** An engine has left the console: what was read for it is not shown again if it comes back. */
  forget(engine: string): void { this.cache.delete(engine); this.pending.delete(engine); }
  async all(): Promise<Record<string, CheckedUsage>> { return Object.fromEntries(await Promise.all([...this.host.engines.values()].map(async engine => [engine.id, await this.read(engine)]))); }
}
export { UsageService };
