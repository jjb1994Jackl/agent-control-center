// One turn, two records of it: the turn the console runs or follows (RunService) and the same
// turn as the desktop app writes it down. The server (a chat's history) and the page (the store)
// both have to tell that they are one, so the rule lives here, once.

/** What either record of a turn has to say for the two to be matched. */
export interface TurnMark { id?: string | null; nativeTurnId?: string | null | undefined; userPrompt?: string | null | undefined; timestamp?: string | number | null | undefined }

/** A time as either record gives it (ISO text, seconds or milliseconds), in milliseconds; 0 when it has none. */
export function stampOf(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return value == null ? 0 : Date.parse(String(value)) || 0;
}

// A character reference (`&#x20;`, `&#32;`) as the character it stands for; one out of range stays as written.
const reference = (whole: string, code: number): string => code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Text with its character references (`&#x20;`, `&#32;`, `&amp;`) as the characters they stand for. */
export function characterReferences(value: string): string {
  return value
    .replace(/&#x([0-9a-f]{1,6});/gi, (whole, hex: string) => reference(whole, parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});/g, (whole, dec: string) => reference(whole, Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_whole, name: string) => NAMED[name] ?? '');
}
/**
 * A message as the console and a desktop's record can both be compared by. A desktop composer may
 * keep what it was given in its own Markdown (Codex writes a line break as `\` and a newline, and
 * escapes punctuation and spaces), so backslashes, character references and how much white space
 * there is are left out of the comparison.
 */
export function promptKey(message: string | null | undefined): string {
  return characterReferences(String(message ?? '')).replace(/\\/g, '').replace(/\s+/g, ' ').trim();
}
/** Whether message `whole` begins with message `start` (only its first `limit` characters, when given); never for an empty `start`. */
export function promptStarts(whole: string | null | undefined, start: string | null | undefined, limit = Infinity): boolean {
  const begin = promptKey(start).slice(0, limit);
  return !!begin && promptKey(whole).startsWith(begin);
}

/**
 * Whether `native` (read from the desktop's record) is the turn `run` (the console's) stands for.
 * By id once the engine has named the desktop's turn. Until then by the message: the desktop's
 * prompt begins with what the person typed (an engine may add to it, e.g. the paths of the
 * attached files), and was written no earlier than the moment the person sent it (`slackMs`
 * allows for the two clocks being read at different points).
 */
export function sameTurn(native: TurnMark, run: TurnMark, slackMs = 5000): boolean {
  if (native.id != null && (native.id === run.id || native.id === run.nativeTurnId)) return true;
  if (!promptStarts(native.userPrompt, run.userPrompt)) return false;
  return stampOf(native.timestamp) >= stampOf(run.timestamp) - slackMs;
}
