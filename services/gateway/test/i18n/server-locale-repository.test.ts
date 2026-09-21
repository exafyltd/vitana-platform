/**
 * i18n/server-locale-repository.ts — first genuine query-level coverage.
 *
 * Before this file, all 6 referencing suites wholesale jest.mock'ed
 * i18n/server-locale.ts itself, so none of these five queries was actually
 * executed by a test. That is how the schema drift below survived: none of
 * them was ever rendered into SQL.
 *
 * The drift (fixed in the same diff): fetchLatestPreferredLanguageFact
 * ordered `memory_facts` by `created_at`, a column that table does not have
 * (its timestamps are extracted_at / superseded_at / updated_at — see
 * services/preference-facts-repository.ts, which orders by extracted_at).
 * PostgREST rejects an unknown order column, so the last-resort locale
 * fallback in i18n/server-locale.ts never returned a row.
 *
 * A hand-built functional fake client (no jest.mock()) records every chained
 * call's arguments, matching the rig used by
 * test/orb/context/providers/match-journey-fetcher-repository.test.ts.
 */

import * as repo from '../../src/i18n/server-locale-repository';

interface RecordedCall {
  method: string;
  args: any[];
}

/**
 * Chainable, call-recording fake SupabaseClient. Every builder method
 * returns the same chain (so ordering of the chain is irrelevant to the
 * rig) and both `.maybeSingle()` and awaiting the chain resolve to
 * `{ data, error }`.
 */
function makeSupabaseStub(response: { data?: any; error?: any } = {}) {
  const calls: RecordedCall[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'like', 'order', 'limit', 'range']) {
    chain[m] = record(m);
  }
  chain.single = jest.fn(() => Promise.resolve(resolved));
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });

  return { from, calls, chain };
}

describe('server-locale-repository', () => {
  describe('fetchAppUserLocale', () => {
    it('reads app_users.locale scoped by user_id, single row', async () => {
      const sb = makeSupabaseStub({ data: { locale: 'en-US' } });
      const res = await repo.fetchAppUserLocale(sb as any, 'u1');

      expect(res).toEqual({ data: { locale: 'en-US' }, error: null });
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['locale'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      // MUST terminate on maybeSingle — the caller destructures { data } and a
      // zero-row lookup is normal, not an error.
      expect(sb.chain.maybeSingle).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchUserPreferenceSttLanguage', () => {
    it('reads user_preferences.stt_language scoped by user_id, single row', async () => {
      const sb = makeSupabaseStub({ data: { stt_language: 'de-DE' } });
      const res = await repo.fetchUserPreferenceSttLanguage(sb as any, 'u1');

      expect(res).toEqual({ data: { stt_language: 'de-DE' }, error: null });
      expect(sb.from).toHaveBeenCalledWith('user_preferences');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['stt_language'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.chain.maybeSingle).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchLatestPreferredLanguageFact', () => {
    // Regression guard for the schema drift this diff fixes: memory_facts has
    // no created_at column, so ordering by it makes PostgREST reject the query.
    it('orders memory_facts by extracted_at (never the non-existent created_at)', async () => {
      const sb = makeSupabaseStub({ data: { fact_value: 'de' } });
      await repo.fetchLatestPreferredLanguageFact(sb as any, 'u1');

      expect(sb.from).toHaveBeenCalledWith('memory_facts');
      expect(sb.calls).toContainEqual({
        method: 'order',
        args: ['extracted_at', { ascending: false }],
      });
      expect(sb.calls).not.toContainEqual({
        method: 'order',
        args: ['created_at', { ascending: false }],
      });
    });

    it('scopes by user_id + fact_key=preferred_language and takes the newest single row', async () => {
      const sb = makeSupabaseStub({ data: { fact_value: 'de' } });
      const res = await repo.fetchLatestPreferredLanguageFact(sb as any, 'u1');

      expect(res).toEqual({ data: { fact_value: 'de' }, error: null });
      expect(sb.calls).toContainEqual({ method: 'select', args: ['fact_value'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['fact_key', 'preferred_language'] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
      expect(sb.chain.maybeSingle).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchAppUserLocalesForIds', () => {
    it('bulk-reads user_id + locale for the given ids, awaited as a list', async () => {
      const sb = makeSupabaseStub({
        data: [
          { user_id: 'u1', locale: 'de' },
          { user_id: 'u2', locale: null },
        ],
      });
      const res = await repo.fetchAppUserLocalesForIds(sb as any, ['u1', 'u2']);

      expect(res).toEqual({
        data: [
          { user_id: 'u1', locale: 'de' },
          { user_id: 'u2', locale: null },
        ],
        error: null,
      });
      expect(sb.from).toHaveBeenCalledWith('app_users');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['user_id, locale'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', ['u1', 'u2']] });
      // A list query must stay awaited — a maybeSingle here would throw on
      // multiple rows and drop every id's locale.
      expect(sb.chain.maybeSingle).not.toHaveBeenCalled();
    });

    it('passes an empty id array straight through (caller short-circuits)', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchAppUserLocalesForIds(sb as any, []);

      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', []] });
    });
  });

  describe('fetchUserPreferenceSttLanguagesForIds', () => {
    it('bulk-reads user_id + stt_language for the given ids, awaited as a list', async () => {
      const sb = makeSupabaseStub({
        data: [
          { user_id: 'u1', stt_language: 'en-US' },
          { user_id: 'u2', stt_language: 'de-DE' },
        ],
      });
      const res = await repo.fetchUserPreferenceSttLanguagesForIds(sb as any, ['u1', 'u2']);

      expect(res).toEqual({
        data: [
          { user_id: 'u1', stt_language: 'en-US' },
          { user_id: 'u2', stt_language: 'de-DE' },
        ],
        error: null,
      });
      expect(sb.from).toHaveBeenCalledWith('user_preferences');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['user_id, stt_language'] });
      expect(sb.calls).toContainEqual({ method: 'in', args: ['user_id', ['u1', 'u2']] });
      expect(sb.chain.maybeSingle).not.toHaveBeenCalled();
    });
  });
});
