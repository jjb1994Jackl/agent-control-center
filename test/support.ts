// Small helpers the tests share. Only tests import this file.
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { errorField } from '../src/shared/guards.js';
import type { PluginHost } from '../src/server/core/plugin-host.js';
import type { RunService } from '../src/server/core/run-service.js';
import type { BridgeEventMap, BridgeEventOf, BridgeEventType, Engine } from '../src/shared/contract.js';

// The code under test unrefs its timers (a poller must never keep the server alive by itself), so
// a test that waits on one leaves nothing holding the event loop. Node 22's test runner then ends
// the file ("Promise resolution is still pending but the event loop has already resolved") and
// cancels every test after it. One timer of the tests' own holds the loop until the file is done.
const hold = setInterval(() => {}, 1000);
after(() => clearInterval(hold));

/**
 * A stand-in for a collaborator the code under test receives (a host, a desktop helper, an IPC
 * client), given only the members the test exercises. The members it does give are checked
 * against T; the ones it leaves out are not there, and a test that reaches one fails.
 *
 * Escape hatch, on purpose: the overload says T while the body returns the partial object as it
 * is. Tests replace real collaborators with partial ones all the time; spelling out every member of
 * a 26-method class for each fake would bury what the test is about. Only tests use this.
 */
export function fake<T extends object>(partial: Partial<T>): T;
export function fake(partial: object): object { return partial; }

/** The item at `index`, failing the test when there is none (lists are read with noUncheckedIndexedAccess). */
export function at<T>(list: ArrayLike<T> | undefined | null, index: number): T {
  const item = list?.[index < 0 ? list.length + index : index];
  assert.ok(item !== undefined, `expected an item at ${index}`);
  return item;
}

/** The value, failing the test when it is null or undefined. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  assert.ok(value !== null && value !== undefined, `expected a ${what}`);
  return value;
}

/** For assert.throws / assert.rejects: the error carries this status. */
export const withStatus = (status: number) => (error: unknown): boolean => errorField(error, 'status') === status;

/** A host holding these engines, each given only what the test reads. */
export const hostOf = (...engines: Array<Partial<Engine> & { id: string }>): PluginHost => fake<PluginHost>({ engines: new Map(engines.map(engine => [engine.id, fake<Engine>(engine)])) });
/** A run service with no run in progress. */
export const noRuns = (): RunService => fake<RunService>({ get: () => undefined });
/** A method the code under test must have but this test never calls. */
export const unused = (): never => { throw new Error('not used by this test'); };
/** The methods every engine registers (PluginHost checks for them), for an engine whose test calls none of them. */
export const required = { status: unused, models: unused, list: unused, read: unused, create: unused, send: unused };
/** A value inside parsed JSON or an event's data, by its path ('engines', 0, 'id'); undefined where the path stops. */
export function dig(value: unknown, ...path: Array<string | number>): unknown {
  let here = value;
  for (const key of path) here = Array.isArray(here) && typeof key === 'number' ? here.at(key) : errorField(here, String(key));
  return here;
}
/** A conversation event as the page receives it, given only its type and data (and its id and turn when the test needs them). */
export function bridgeEvent<K extends BridgeEventType>(type: K, data: BridgeEventMap[K], extra: { id?: string; turnId?: string } = {}): BridgeEventOf<K> { return fake<BridgeEventOf<K>>({ type, data, ...extra }); }
/** A fetch answer: only what the code under test reads (ok, status, json). */
export const respond = (body: unknown, { ok = true, status = 200 } = {}): Response => fake<Response>({ ok, status, json: async () => body });
