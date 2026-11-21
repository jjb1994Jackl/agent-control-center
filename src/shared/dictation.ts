// Which speech-to-text the microphone uses. Dictation is the console's own feature (it only
// types text into the composer), so any agent's speech service can serve any chat, and none of
// them is required: they are tried in this order, the first one that can start wins, and the
// browser's own recognizer comes after all of them, in the page.
//   1. the person's pick in the console's settings (`prefer`, unless it is "auto"),
//   2. the console's default (BRIDGE_DICTATION_ENGINE, `preferred`),
//   3. the agent the text is being typed for (`current`),
//   4. every other agent that has one, in the order the console switched them on (`engines`).
// "browser" as the pick skips the agents' services altogether.
export const AUTO_VOICE = 'auto';
export const BROWSER_VOICE = 'browser';
export function dictationOrder(engines: string[], { prefer = AUTO_VOICE, preferred = '', current = '' }: { prefer?: string; preferred?: string; current?: string } = {}): string[] {
  if (prefer === BROWSER_VOICE) return [];
  return [...new Set([prefer, preferred, current, ...engines].filter(id => !!id && engines.includes(id)))];
}
