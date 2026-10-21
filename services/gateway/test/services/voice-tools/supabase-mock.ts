/**
 * Shared generic Supabase query-builder mock for voice-tools test suites.
 *
 * Unlike the memory-broker mock (which records precise filter columns),
 * this mock is intentionally chain-method-agnostic: the voice-tools files
 * under test call a wide variety of PostgREST builder methods (.select,
 * .eq, .in, .ilike, .or, .filter, .order, .limit, .upsert, .gte, .not)
 * across many tables, and several tables are legitimately queried more
 * than once per call with different intent (e.g. global_community_profiles
 * for both is_visible=true and is_visible=false).
 *
 * Usage:
 *   const mock = createQueryMock();
 *   mock.setTable('app_users', { data: [...], error: null }); // reusable default
 *   mock.queueTable('global_community_profiles', { data: [...], error: null }); // consumed once, then falls back to default/empty
 *   mock.setRpc('some_rpc', { data: {...}, error: null });
 *   await someFn(mock.client, ...);
 *   mock.calls // recorded call log for assertions
 */

export interface MockResp {
  data: unknown;
  error: { message: string } | null;
}

export interface RecordedCall {
  table: string;
  steps: Array<{ method: string; args: unknown[] }>;
}

export type QueryStep = { method: string; args: unknown[] };
export type Responder = (steps: QueryStep[]) => MockResp;

export function createQueryMock() {
  const queues = new Map<string, MockResp[]>();
  const defaults = new Map<string, MockResp>();
  const responders = new Map<string, Responder>();
  const rpcResponses = new Map<string, MockResp>();
  const calls: RecordedCall[] = [];
  const rpcCalls: Array<{ name: string; params: unknown }> = [];

  function nextFor(table: string, steps: QueryStep[]): MockResp {
    // A responder (query-shape-aware) takes priority — it lets a single
    // table name serve multiple, differently-filtered query call sites
    // correctly (e.g. `profiles` queried both by `.in(user_id)` for pool
    // hydration and by `.filter('service_offerings::text', 'ilike', ...)`
    // for a keyword scan — a plain canned response can't tell those apart).
    const r = responders.get(table);
    if (r) return r(steps);
    const q = queues.get(table);
    if (q && q.length > 0) return q.shift()!;
    return defaults.get(table) ?? { data: [], error: null };
  }

  function setTable(table: string, resp: MockResp) {
    defaults.set(table, resp);
  }

  function queueTable(table: string, resp: MockResp) {
    if (!queues.has(table)) queues.set(table, []);
    queues.get(table)!.push(resp);
  }

  function setResponder(table: string, fn: Responder) {
    responders.set(table, fn);
  }

  function setRpc(name: string, resp: MockResp) {
    rpcResponses.set(name, resp);
  }

  const CHAIN_METHODS = [
    'select', 'eq', 'neq', 'in', 'order', 'limit', 'gt', 'gte', 'lt', 'lte',
    'ilike', 'or', 'filter', 'is', 'not', 'upsert', 'match',
  ];

  function makeChain(table: string) {
    const steps: QueryStep[] = [];
    const chain: any = {};
    for (const m of CHAIN_METHODS) {
      chain[m] = jest.fn((...args: unknown[]) => {
        steps.push({ method: m, args });
        return chain;
      });
    }
    chain.maybeSingle = jest.fn(() => {
      calls.push({ table, steps: [...steps] });
      return Promise.resolve(nextFor(table, steps));
    });
    chain.single = jest.fn(() => {
      calls.push({ table, steps: [...steps] });
      return Promise.resolve(nextFor(table, steps));
    });
    // Thenable — supports `await sb.from(t).select(...)` without a
    // terminal .maybeSingle()/.single() call.
    chain.then = (resolve: (v: MockResp) => unknown, reject?: (e: unknown) => unknown) => {
      calls.push({ table, steps: [...steps] });
      return Promise.resolve(nextFor(table, steps)).then(resolve, reject);
    };
    return chain;
  }

  const client: any = {
    from: jest.fn((table: string) => makeChain(table)),
    rpc: jest.fn((name: string, params: unknown) => {
      rpcCalls.push({ name, params });
      const r = rpcResponses.get(name) ?? { data: null, error: null };
      return Promise.resolve(r);
    }),
  };

  return { client, setTable, queueTable, setResponder, setRpc, calls, rpcCalls };
}

/**
 * Guards against the exact b9acd92 incident class: a voice tool returning
 * something that is not a well-formed, JSON-serializable plain object
 * (undefined, a bare primitive, an array, etc.) would break Nova's
 * toolResult stream. Every path through every voice tool must pass this.
 *
 * Also asserts `ok` is a strict boolean, which holds for every tool result
 * in this codebase EXCEPT superlatives.ts's `askWhoIs`, which deliberately
 * uses a third `ok: 'clarify'` sentinel — use `assertWellFormedObject` for
 * that one instead.
 */
export function assertWellFormedToolResult(result: unknown): void {
  assertWellFormedObject(result);
  expect(typeof (result as any).ok).toBe('boolean');
}

/**
 * Same well-formed/serializable-object guard as assertWellFormedToolResult,
 * but without requiring `ok` to be strictly boolean — for the one voice-tool
 * shape (askWhoIs's clarify response) that intentionally uses a non-boolean
 * `ok` sentinel while still needing to be a safe, parseable object.
 */
export function assertWellFormedObject(result: unknown): void {
  expect(result).not.toBeUndefined();
  expect(result).not.toBeNull();
  expect(typeof result).toBe('object');
  expect(Array.isArray(result)).toBe(false);
  expect(() => JSON.stringify(result)).not.toThrow();
  expect('ok' in (result as object)).toBe(true);
}
