// Sends through the Claude desktop app itself (macOS Accessibility), so the desktop's own
// process runs the turn: same context, same prompt cache, same tools, and the message shows
// in the desktop as the person's own. The steps are src/server/native/claude-desktop.swift, on the
// shared driver (src/server/core/desktop-automation.ts); Claude's names for its controls are data in
// src/server/native/profiles/claude.json.
import { DesktopAutomation, NOT_TRUSTED, type AutomationOptions, type DesktopFlags, type HelperResult } from './core/desktop-automation.js';
import type { CardAction, NewPick, WrapUpCard } from '../shared/contract.js';

/** A session as the desktop's sidebar knows it: its title, and its local id when the index has one. */
export interface DesktopSession { title: string; localId?: string }

class ClaudeDesktop extends DesktopAutomation {
  constructor(options: Partial<AutomationOptions> = {}) { super({ engine: 'claude', label: 'Claude 桌面版', ...options }); }
  localId(session: DesktopSession): string { return session.localId ? `local_${session.localId.replace(/^local_/, '')}` : ''; }
  send(session: DesktopSession, text: string, settings?: DesktopFlags): Promise<HelperResult> { return this.run(['send', session.title, this.localId(session)], { input: text, settings }); }
  // Starts a new session in the desktop app itself, in `folder` ('' = wherever the desktop's
  // "New session" page starts), with `text` as its first message. `expect`: what the console
  // showed as chosen on that page ([{ control, option }]): checked there, and picked if the page
  // shows something else by now, before the message goes out.
  create(folder: string, text: string, settings?: DesktopFlags, expect: readonly NewPick[] = []): Promise<HelperResult> {
    return this.run(['new', folder || '-', ...expect.flatMap(item => [String(item.control), String(item.option)])], { input: text, settings });
  }
  // What the desktop's "New session" page asks for before the first message, and picks there:
  // the shared newControls / newPick (src/server/core/desktop-automation.ts).
  // Sends while a turn runs: the desktop queues the message into that turn (Send, then Send now).
  steer(session: DesktopSession, text: string, settings?: DesktopFlags): Promise<HelperResult> { return this.run(['send', session.title, this.localId(session), 'steer'], { input: text, settings }); }
  sendNow(session: DesktopSession): Promise<HelperResult> { return this.run(['send-now', session.title, this.localId(session)], { timeout: 30000 }); }
  // Answers the question card the desktop shows in this session: `option` by its label, or Skip.
  answer(session: DesktopSession, question: string, option: string | null): Promise<HelperResult> { return this.run(['answer', session.title, this.localId(session), question, ...(option == null ? [] : [option])], { timeout: 30000 }); }
  // The desktop's own buttons on this session's wrap-up card (found by its question, or recap), and one pressed by its place.
  card(session: DesktopSession, card: WrapUpCard): Promise<HelperResult> { return this.run(['card', session.title, this.localId(session), card.ask, card.recap, JSON.stringify(card.replies)], { timeout: 30000 }); }
  action(session: DesktopSession, action: CardAction): Promise<HelperResult> { return this.run(['action', session.title, this.localId(session), String(action.index), action.ask, action.recap, JSON.stringify(action.replies)], { timeout: 30000 }); }
  stop(session: DesktopSession): Promise<HelperResult> { return this.run(['stop', session.title, this.localId(session)], { timeout: 30000 }); }
}

export { ClaudeDesktop, NOT_TRUSTED };
