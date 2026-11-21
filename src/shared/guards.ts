// Narrowing for data whose shape nobody promised: native records (Claude's JSONL, Codex's
// app-server answers, Antigravity's language server, what accessibility reads out of a window)
// and anything else parsed from JSON. Such data enters the program as `unknown` and is read
// through these helpers, which behave like JavaScript's optional chaining: a missing or
// differently shaped value reads as undefined, so a record nobody understands is skipped as
// before, and no type assertion pretends to know its shape.

/** Any JSON object (or array, read by key the way `?.` does). */
export type Bag = { readonly [key: string]: unknown };

/** The value as an object whose keys can be read, or undefined (like `value?.` would allow). */
export function bag(value: unknown): Bag | undefined {
  return isBag(value) ? value : undefined;
}

/** True for a non-null object (arrays included), so its keys can be read (each as unknown). */
export function isBag(value: unknown): value is Bag { return typeof value === 'object' && value !== null; }

/** `value?.a?.b?.c`: follows the keys while each step is an object, else undefined. */
export function get(value: unknown, ...keys: Array<string | number>): unknown {
  let current = value;
  for (const key of keys) {
    if (!isBag(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** The value when it is a string, else undefined. */
export function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
/** The value when it is a string or null (a record's "not set"), else undefined. */
export function strOrNull(value: unknown): string | null | undefined { return value === null ? null : str(value); }
/** The value when it is a finite or infinite number (not NaN-checked), else undefined. */
export function num(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
/** The value when it is a boolean, else undefined. */
export function bool(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
/** The value when it is an array (of unknown items), else undefined. */
export function arr(value: unknown): unknown[] | undefined { return Array.isArray(value) ? value : undefined; }
/** The value when it is an array, else an empty one. */
export function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
/** `String(value ?? '')`, the way the JavaScript sources coerced text. */
export function text(value: unknown): string { return String(value ?? ''); }
/** True when the value is truthy, as JavaScript would test it. */
export function truthy(value: unknown): boolean { return !!value; }

/** Parse JSON without claiming a shape: the result is unknown until narrowed. */
export function parseJson(textValue: string): unknown { return JSON.parse(textValue); }

/** An Error with the extra fields the console reads (status, fallback, …). */
export function failure<T extends object>(message: string, extra: T): Error & T {
  return Object.assign(new Error(message), extra);
}

/** The message of a caught value (catch variables are unknown). */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** A numeric/string field of a caught value (status, code, fallback), without assuming it is an Error. */
export function errorField(error: unknown, key: string): unknown { return get(error, key); }
