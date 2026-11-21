import type { PluginAbout, PluginSetup } from '../src/shared/contract.js';
import { EngineEvents, UnifiedSession, UnifiedTurn } from '../src/server/types.js';

// Test fixture, not an integration with a vendor. The normal server does not discover this directory.
export const about: PluginAbout = { id: 'demo-agent', label: 'Demo Agent', detect: () => ({ installed: false }) };
export const setup: PluginSetup = ({ registerEngine }) => {
  const conversations = new Map<string, UnifiedTurn[]>([['first', []], ['second', []]]);
  const session = (id: string) => new UnifiedSession({ id, engine: about.id, title: `Example ${id}` });
  function history(id: string) {
    const turns = conversations.get(id);
    if (!turns) throw Object.assign(new Error('Unknown example conversation'), { status: 404 });
    return { session: session(id), turns };
  }
  registerEngine({
    id: about.id, label: about.label,
    capabilities: { send: true, create: false, models: false, reasoning: false, permissions: false },
    list: () => [...conversations.keys()].map(session),
    read: history,
    status: () => ({ connected: true }),
    models: () => [],
    create: () => { throw new Error('Select an existing example conversation'); },
    // A real native-chat adapter replaces this with a confirmed send into the selected app session.
    postMessage(id, input) {
      const { turns } = history(id), turn = `demo-${turns.length + 1}`;
      const text = `Reply from ${id}: ${input.prompt.split('\n').at(-1)}`;
      turns.push(new UnifiedTurn({ id: turn, userPrompt: input.prompt, status: 'completed',
        completedAt: new Date().toISOString(), statusEvidence: 'demo-only',
        messages: [{ id: turn + '-reply', phase: 'final_answer', status: 'completed', text }] }));
      return { status: 'sent' };
    },
    send() {
      const events = new EngineEvents();
      queueMicrotask(() => events.emit('error', new Error('The example uses postMessage')));
      return events;
    },
  });
};
