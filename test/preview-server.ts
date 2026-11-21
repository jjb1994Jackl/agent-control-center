import { EngineEvents } from '../src/server/types.js';
import { fake } from './support.js';
import { loadConfig } from '../src/server/config.js';
import type { Character, History, UnifiedSession, UnifiedStep, UnifiedTurn } from '../src/shared/contract.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { createApp } from '../src/server/server.js';
import { desktopCard } from '../src/server/core/presentation.js';
// Three deterministic providers for interaction acceptance. No real agent is called.
// They carry each agent's colour and the faces the page already serves, so what is looked at
// here is the page people get.
const host = new PluginHost();
const FACES: Record<string, Character | undefined> = {
  claude: { kind: 'image', url: '/assets/characters/claude.svg', pixelated: true },
  antigravity: { kind: 'image', url: '/assets/characters/antigravity.svg', standIn: true },
};
for (const [index, id, label, prefix, accent] of [[0, 'codex', 'Codex', 'CX', '#5B7BFA'], [1, 'claude', 'Claude', 'CL', '#D97757'], [2, 'antigravity', 'Antigravity', 'AG', '#4285F4']] as const) {
  const face = FACES[id], identity = { id, label, priority: index + 1, accent, ...(face ? { character: face } : {}) };
  const sessions: UnifiedSession[] = [
    fake<UnifiedSession>({ id: 'acceptance', engine: id, title: `${label} · 快捷切换验收`, cwd: '/workspace/agent-frontdesk', updatedAt: new Date().toISOString(), status: 'idle' }),
    fake<UnifiedSession>({ id: 'empty', engine: id, title: `${label} · 待开始的聊天`, cwd: '/workspace/agent-frontdesk', updatedAt: new Date().toISOString(), status: 'idle' }),
  ];
  const history: UnifiedTurn[] = [fake<UnifiedTurn>({ id: 'sample-turn', timestamp: new Date().toISOString(), userPrompt: '把控制台做成能一键调度多个引擎的工作台', status: 'completed', statusEvidence: 'sample_task_complete', completedAt: new Date().toISOString(), messages: [
    { id: 'brief', phase: 'commentary', text: '先保留每个聊天的输入和界面，再接入跨引擎状态提醒与真实额度显示。' },
    { id: 'answer', phase: 'final_answer', text: '**像和几个 AI 同事聊天一样**\n\n- 品牌头像和名字标识每一位发言者\n- 新发言弹出截断预览，点击就能回到聊天\n- 工具出错或临时重试时，任务仍保持执行中\n\n这是独立验收样例。发送后会先模拟重试和一条命令失败，然后继续执行，最后才确认完成。额度为测试数据。' },
  ], steps: [fake<UnifiedStep>({ id: 'command', type: 'command', detail: 'npm test', output: 'Acceptance checks passed', durationMs: 1024, status: 'completed' })], artifacts: [{ path: '/workspace/agent-frontdesk/docs/quick-switch.md', title: '快捷工作台验收记录', summary: '草稿保留、执行状态与未读提醒' }] })];
  const running = new Map<string, EngineEvents>();
  // Each is a plugin (so the page can switch it on and off); Antigravity plays the one whose desktop app is not on this machine.
  host.add({ ...identity, detect: () => ({ installed: id !== 'antigravity' }) }, ({ registerEngine }) => { registerEngine({ ...identity, prefix, capabilities: { attachments: true, cwd: true, interrupt: true, showInDesktop: id === 'claude' },
    status: async () => ({ connected: true }), models: async () => [], list: async () => sessions.map(session => ({ ...session })),
    usage: async () => index === 0 ? { available: true, windows: [{ id: 'primary', usedPercent: 34, remainingPercent: 66, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, { id: 'secondary', usedPercent: 50, remainingPercent: 50, windowMinutes: 10080 }] } : { available: false, reason: '验收样例：此引擎未公开额度' },
    read: async sessionId => fake<History>({ session: sessions.find(session => session.id === sessionId) || null, turns: sessionId === 'acceptance' ? history : [] }),
    create: async () => { const session = fake<UnifiedSession>({ id: `draft-${Date.now()}`, title: '新建聊天', cwd: '/workspace/agent-frontdesk', engine: id, updatedAt: new Date().toISOString(), status: 'idle' }); sessions.unshift(session); return { ...session }; },
    send: (sessionId, input) => {
      const emitter = new EngineEvents(), timers: NodeJS.Timeout[] = [], timestamp = new Date().toISOString();
      const session = sessions.find(session => session.id === sessionId);
      if (!session) throw Object.assign(new Error('Unknown session'), { status: 404 });
      session.status = 'busy';
      const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
      at(100, () => emitter.emit('item_started', { item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: '正在检查切换、草稿和后台状态提醒' } }));
      at(250, () => emitter.emit('item_completed', { item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: '我先检查一下执行日志，确认任务还在继续。' } }));
      at(300, () => emitter.emit('item_started', { item: { type: 'commandExecution', id: 'live-cmd', command: 'npm test' } }));
      at(600, () => emitter.emit('delta', { type: 'command_output', itemId: 'live-cmd', output: 'Checking workspace state…\n' }));
      at(1000, () => emitter.emit('warning', { message: '模拟临时连接重试，任务仍在执行', retrying: true }));
      at(1400, () => emitter.emit('item_completed', { item: { type: 'commandExecution', id: 'live-cmd', command: 'npm test', aggregatedOutput: 'A single command returned exit code 1', status: 'failed' } }));
      at(1800, () => emitter.emit('item_completed', { item: { type: 'agentMessage', id: 'continued', phase: 'commentary', text: '这条命令有返回错误，我会继续检查，整个任务还没有结束。' } }));
      at(2200, () => emitter.emit('item_started', { item: { type: 'commandExecution', id: 'second-cmd', command: 'npm run check' } }));
      // Claude plays a turn that waits on a dialog of its desktop app for a while.
      if (id === 'claude') {
        at(2400, () => emitter.emit('approval', desktopCard('desktop:dialog', 'Claude 桌面版在等你批准', 'Claude 想用电脑操作 ChatGPT：查看写作块怎么显示。请在 Claude 桌面版里允许或拒绝，这一轮才会继续。')));
        at(8000, () => emitter.emit('approval_resolved', { id: 'desktop:dialog' }));
      }
      // The reply grows as the desktop writes it, then its record has it whole.
      const reply = '验收任务完成。可以从顶部绿点一键回到此聊天继续工作。';
      for (let part = 1; part < 6; part++) at(8600 + part * 250, () => emitter.emit('item_started', { item: { type: 'agentMessage', id: 'live-reply', phase: 'final_answer', text: reply.slice(0, Math.ceil(reply.length * part / 6)) } }));
      at(10000, () => {
        session.status = 'idle'; session.updatedAt = new Date().toISOString();
        if (sessionId === 'acceptance') history.push(fake<UnifiedTurn>({ id: `turn-${Date.now()}`, timestamp, userPrompt: input.prompt, status: 'completed', assistantReply: reply, steps: [fake<UnifiedStep>({ id: 'live-cmd', type: 'command', detail: 'npm test', output: 'Acceptance complete', status: 'completed' })], artifacts: [] }));
        emitter.emit('item_completed', { item: { type: 'commandExecution', id: 'second-cmd', command: 'npm run check', aggregatedOutput: 'Acceptance complete', status: 'completed', durationMs: 10000 } });
        emitter.emit('item_completed', { item: { type: 'agentMessage', id: 'live-reply', phase: 'final_answer', text: reply } });
        emitter.emit('completed', {}); running.delete(sessionId);
      });
      emitter.on('interrupt', () => { timers.forEach(clearTimeout); session.status = 'idle'; running.delete(sessionId); });
      running.set(sessionId, emitter); return emitter;
    }, interrupt: async sessionId => running.get(sessionId)?.emit('interrupt'),
    ...(id === 'claude' ? { show: async (sessionId: string) => { console.log(`show in desktop: ${sessionId}`); } } : {}),
  }); });
}
createApp({ host, config: { ...loadConfig(), uploadsDir: '/private/tmp/agent-frontdesk-preview-uploads', exportsDir: '/private/tmp/agent-frontdesk-preview-exports', settingsFile: process.env.BRIDGE_SETTINGS_FILE || '/private/tmp/agent-frontdesk-preview-settings.json', defaultCwd: '/workspace/agent-frontdesk' } }).then(context => {
  const server = context.app.listen(Number(process.env.PORT || 4102), '127.0.0.1', () => console.log('Quick-switch acceptance fixture ready'));
  const close = async () => { await context.dispose(); server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
});
