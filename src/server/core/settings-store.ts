import fs from 'node:fs';
import path from 'node:path';
import { bag, get, list, messageOf, parseJson, str } from '../../shared/guards.js';

// What the person chose in the console, kept across restarts: which agents are switched on, the
// order of the rail, and what they changed about an agent (its name, the files of its two faces).
// Only choices are written. An agent the person never touched has no entry, and follows whether
// its desktop app is found on this machine (PluginHost.start), so installing an app later brings
// its agent in without anyone editing a file.
//   { "agents": { "claude": true, "antigravity": false }, "order": ["claude", "codex"],
//     "custom": { "codex": { "label": "Blue", "idle": "codex-idle-3fa1c2d4e5.png" } } }
export interface CustomChoice { label?: string; idle?: string; working?: string }
interface Choices { agents: Map<string, boolean>; order: string[]; custom: Map<string, CustomChoice> }
const FIELDS = ['label', 'idle', 'working'] as const;
class SettingsStore {
  file: string; private choices: Choices | null = null;
  constructor(file = '') { this.file = file; }
  private read(): Choices {
    if (this.choices) return this.choices;
    const choices: Choices = { agents: new Map(), order: [], custom: new Map() };
    // A missing or unreadable file is "nothing chosen yet"; an entry of the wrong shape is skipped.
    try {
      const saved = parseJson(fs.readFileSync(this.file, 'utf8'));
      for (const [id, on] of Object.entries(bag(get(saved, 'agents')) || {})) if (typeof on === 'boolean') choices.agents.set(id, on);
      choices.order = [...new Set(list(get(saved, 'order')).filter((id): id is string => typeof id === 'string' && !!id))];
      for (const [id, value] of Object.entries(bag(get(saved, 'custom')) || {})) {
        const custom: CustomChoice = {};
        for (const field of FIELDS) { const text = str(get(value, field)); if (text) custom[field] = text; }
        if (Object.keys(custom).length) choices.custom.set(id, custom);
      }
    } catch {}
    return this.choices = choices;
  }
  /** The person's choice for this agent; undefined when they made none. */
  agent(id: string): boolean | undefined { return this.read().agents.get(id); }
  /** Records the choice. A file that cannot be written keeps the choice until the server stops. */
  setAgent(id: string, on: boolean): void { this.read().agents.set(id, on); this.write(); }
  /** The rail's order as the person set it (agents they never placed are not in it). */
  order(): string[] { return [...this.read().order]; }
  setOrder(ids: string[]): void { this.read().order = [...new Set(ids)]; this.write(); }
  /** What the person changed about this agent; empty when nothing. */
  custom(id: string): CustomChoice { return { ...this.read().custom.get(id) }; }
  /** Changes some of it: a string sets a field, null puts the plugin's own back. */
  setCustom(id: string, change: { [K in keyof CustomChoice]?: string | null }): void {
    const custom = this.custom(id);
    for (const field of FIELDS) { const value = change[field]; if (value === undefined) continue; if (value) custom[field] = value; else delete custom[field]; }
    if (Object.keys(custom).length) this.read().custom.set(id, custom); else this.read().custom.delete(id);
    this.write();
  }
  private write(): void {
    if (!this.file) return;
    const { agents, order, custom } = this.read();
    try {
      let kept: Record<string, unknown> = {};
      try { kept = { ...bag(parseJson(fs.readFileSync(this.file, 'utf8'))) }; } catch {}
      // Only what was chosen is written: a file of switches alone stays { "agents": … }.
      delete kept['order']; delete kept['custom'];
      const next = { ...kept, agents: Object.fromEntries(agents), ...(order.length ? { order } : {}), ...(custom.size ? { custom: Object.fromEntries(custom) } : {}) };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const draft = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(draft, `${JSON.stringify(next, null, 2)}\n`);
      fs.renameSync(draft, this.file);
    } catch (err) { console.error(`Settings were not saved (${this.file}): ${messageOf(err)}`); }
  }
}
export { SettingsStore };
