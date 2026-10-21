/**
 * Shared fake Supabase client for social-memory tests.
 *
 * Not a test file itself (no `.test.ts` suffix -> Jest's testMatch skips
 * it); imported by the social-memory test suites that need to mock
 * `getSupabase()` directly (repository + the builders that touch tables
 * beyond the repository layer).
 *
 * Usage: pass an ordered array of query results, one per `.from(...)` call
 * the function under test is expected to make (verified by reading the
 * source). Chain methods (select/eq/in/or/.../order/limit) are recorded
 * but not applied — the "database" is whatever result is queued for that
 * call, same style as test/services/continuity/continuity-fetcher.test.ts.
 */

export interface QueryResult {
  data?: any[] | null;
  error?: any;
  /** Value returned by .maybeSingle() on this query, if called. */
  single?: any;
}

export interface RecordedQuery {
  table: string;
  calls: Array<[string, ...any[]]>;
}

export function makeSupabaseSequence(sequence: QueryResult[]) {
  const log: RecordedQuery[] = [];
  let idx = 0;

  const client: any = {
    from(table: string) {
      const calls: Array<[string, ...any[]]> = [];
      log.push({ table, calls });
      const spec: QueryResult = sequence[idx] ?? { data: [], error: null };
      idx += 1;

      const builder: any = {};
      const chainMethods = [
        'select',
        'eq',
        'neq',
        'gte',
        'lte',
        'gt',
        'lt',
        'in',
        'or',
        'order',
        'limit',
        'is',
      ];
      for (const m of chainMethods) {
        builder[m] = (...args: any[]) => {
          calls.push([m, ...args]);
          return builder;
        };
      }
      builder.maybeSingle = () => {
        calls.push(['maybeSingle']);
        return Promise.resolve({ data: spec.single ?? null, error: spec.error ?? null });
      };
      builder.then = (resolve: any, reject?: any) =>
        Promise.resolve({ data: spec.data ?? [], error: spec.error ?? null }).then(resolve, reject);
      builder.catch = (fn: any) => builder.then(undefined, fn);
      return builder;
    },
  };

  return { client, log };
}
