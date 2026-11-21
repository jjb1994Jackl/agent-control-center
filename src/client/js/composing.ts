// While the person types in the page, the server is told, so a Windows helper acting on a desktop app
// waits for a pause before its next action (POST /api/typing; uia-driver.cs, BeforeAct). An action
// makes the app take the foreground for a moment, and while it holds it (a menu open) what the person
// types goes to the app instead:
// - a word being composed with an input method (pinyin typed, not yet picked) is ended when the browser
//   loses the foreground: `composing`, said at the start and again while it goes on (the server's mark
//   lapses 1.5 s after it was last said);
// - keys typed reach the app's page while it holds the foreground: `keys`, said at most every 0.3 s while
//   the person types (the mark lapses 0.8 s after the last key, a pause in typing). A word composed is
//   followed by `keys`: the person usually goes on typing.
export type Typing = 'composing' | 'keys';
export const RENEW_MS = 600, KEYS_EVERY_MS = 300;
type Listen = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
// An object, not `true`: under Node 22's EventTarget (CI's tests) a listener added and removed with
// `true` stayed after the removal; browsers and Node 26 take either form.
const CAPTURE = { capture: true };
export function watchTyping(target: Listen, send: (typing: Typing) => void, now: () => number = () => Date.now()): () => void {
  let composingSaid = 0, keysSaid = 0;
  const composing = () => { if (!composingSaid || now() - composingSaid >= RENEW_MS) { composingSaid = now(); send('composing'); } };
  const ended = () => { composingSaid = 0; keysSaid = now(); send('keys'); };
  const key = (event: Event) => {
    if (composingSaid || (event as KeyboardEvent).isComposing) return;
    if (!keysSaid || now() - keysSaid >= KEYS_EVERY_MS) { keysSaid = now(); send('keys'); }
  };
  const listeners: Array<[string, (event: Event) => void]> = [['compositionstart', composing], ['compositionupdate', composing], ['compositionend', ended], ['keydown', key]];
  for (const [type, listener] of listeners) target.addEventListener(type, listener, CAPTURE);
  return () => { for (const [type, listener] of listeners) target.removeEventListener(type, listener, CAPTURE); };
}
