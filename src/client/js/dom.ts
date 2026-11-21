// Typed access to the page's elements and to what events point at. Each lookup checks the kind
// with instanceof, so a missing or different element shows up where it is looked up instead of
// later as undefined. Without a kind, the default is HTMLElement (what the page's markup is).
type Kind<T extends Element> = abstract new () => T;

/** The element with this id, which the page's markup must have. */
export function byId<T extends HTMLElement>(id: string, kind: Kind<T>): T;
export function byId(id: string): HTMLElement;
export function byId(id: string, kind: Kind<HTMLElement> = HTMLElement): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof kind)) throw new Error(`#${id} is missing from the page`);
  return element;
}
/** The first element under root matching selector, when it is of this kind. */
export function find<T extends Element>(root: ParentNode | null | undefined, selector: string, kind: Kind<T>): T | null;
export function find(root: ParentNode | null | undefined, selector: string): HTMLElement | null;
export function find(root: ParentNode | null | undefined, selector: string, kind: Kind<Element> = HTMLElement): Element | null {
  const element = root?.querySelector(selector);
  return element instanceof kind ? element : null;
}
/** Every element under root matching selector that is of this kind. */
export function findAll<T extends Element>(root: ParentNode | null | undefined, selector: string, kind: Kind<T>): T[];
export function findAll(root: ParentNode | null | undefined, selector: string): HTMLElement[];
export function findAll(root: ParentNode | null | undefined, selector: string, kind: Kind<Element> = HTMLElement): Element[] {
  return [...root?.querySelectorAll(selector) || []].filter(element => element instanceof kind);
}
/** What an event points at, as a node (null for window and other targets that are not nodes). */
export const nodeOf = (target: EventTarget | null | undefined): Node | null => target instanceof Node ? target : null;
/** The nearest element (the target itself or an ancestor) matching selector. A text node or window has none. */
export function closest<T extends Element>(target: EventTarget | null | undefined, selector: string, kind: Kind<T>): T | null;
export function closest(target: EventTarget | null | undefined, selector: string): HTMLElement | null;
export function closest(target: EventTarget | null | undefined, selector: string, kind: Kind<Element> = HTMLElement): Element | null {
  const element = target instanceof Element ? target.closest(selector) : null;
  return element instanceof kind ? element : null;
}
