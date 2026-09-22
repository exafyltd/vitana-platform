/**
 * VTID-04291: contract test for the capabilities Aurora-migration data-access
 * seam (`src/capabilities/index-repository.ts`).
 *
 * The file's own header carries `impact-allow-no-test` with the rationale
 * "pure data-access seam (thin Supabase query wrappers, no independent
 * request-handling behavior)". That rationale still holds — there is nothing
 * here to mock into a Supabase client and no branch logic of ours to
 * exercise; every method chain is a one-to-one pass-through.
 *
 * What IS worth pinning is the thing the dead-code-scanner-v1 false positive
 * actually put at risk: these five exports are the seam's public surface and
 * are consumed through a namespace import
 *   `import * as repo from './index-repository'`
 * in capabilities/index.ts. A symbol grep cannot see that usage, so renaming
 * or dropping an export here would pass static analysis and only blow up at
 * runtime as `repo.fetchX is not a function`. This test asserts the surface
 * exists, is callable, and that each wrapper returns the Supabase query
 * builder it delegates to (so a future Aurora swap-in keeps the same shape).
 *
 * The stub below is a minimal thenable query builder — deliberately not a
 * jest.mock of @supabase/supabase-js, so the real module executes.
 */

import * as repo from '../../src/capabilities/index-repository';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Records every chain call so we can assert what was actually queried. */
function makeQueryBuilderStub() {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, args]);
    return builder;
  };
  for (const method of ['select', 'insert', 'eq', 'order', 'limit', 'maybeSingle']) {
    builder[method] = record(method);
  }
  return { builder, calls };
}

function makeClientStub() {
  const calls: Array<[string, unknown[]]> = [];
  const { builder, calls: builderCalls } = makeQueryBuilderStub();
  const client = {
    from: (table: string) => {
      calls.push(['from', [table]]);
      return builder;
    },
  };
  return { client, calls, builderCalls };
}

describe('capabilities/index-repository exports', () => {
  it('exports fetchActiveSocialConnectionProviders as a function', () => {
    expect(typeof repo.fetchActiveSocialConnectionProviders).toBe('function');
  });

  it('exports fetchUserCapabilityPreference as a function', () => {
    expect(typeof repo.fetchUserCapabilityPreference).toBe('function');
  });

  it('exports insertCapabilityPlayLog as a function', () => {
    expect(typeof repo.insertCapabilityPlayLog).toBe('function');
  });

  it('exports countUserCapabilityPreferences as a function', () => {
    expect(typeof repo.countUserCapabilityPreferences).toBe('function');
  });

  it('exports fetchRecentSuccessfulCapabilityPlays as a function', () => {
    expect(typeof repo.fetchRecentSuccessfulCapabilityPlays).toBe('function');
  });
});

describe('capabilities/index-repository query shapes', () => {
  it('queries active social connections by provider for the user', async () => {
    const { client, calls, builderCalls } = makeClientStub();
    await repo.fetchActiveSocialConnectionProviders(client as unknown as SupabaseClient, 'user-1');
    expect(calls).toEqual([['from', ['social_connections']]]);
    expect(builderCalls).toEqual([
      ['select', ['provider']],
      ['eq', ['user_id', 'user-1']],
      ['eq', ['is_active', true]],
    ]);
  });

  it('reads a single capability preference by user + capability', async () => {
    const { client, calls, builderCalls } = makeClientStub();
    await repo.fetchUserCapabilityPreference(client as unknown as SupabaseClient, 'user-1', 'music.play');
    expect(calls).toEqual([['from', ['user_capability_preferences']]]);
    expect(builderCalls).toEqual([
      ['select', ['preferred_connector_id, set_method']],
      ['eq', ['user_id', 'user-1']],
      ['eq', ['capability_id', 'music.play']],
      ['maybeSingle', []],
    ]);
  });

  it('inserts a capability play-log row verbatim', async () => {
    const { client, calls, builderCalls } = makeClientStub();
    const row = { user_id: 'user-1', capability_id: 'music.play', ok: true };
    await repo.insertCapabilityPlayLog(client as unknown as SupabaseClient, row);
    expect(calls).toEqual([['from', ['capability_play_log']]]);
    expect(builderCalls).toEqual([['insert', [row]]]);
  });

  it('counts preferences head-only with an exact count', async () => {
    const { client, calls, builderCalls } = makeClientStub();
    await repo.countUserCapabilityPreferences(client as unknown as SupabaseClient, 'user-1', 'email.read');
    expect(calls).toEqual([['from', ['user_capability_preferences']]]);
    expect(builderCalls).toEqual([
      ['select', ['id', { count: 'exact', head: true }]],
      ['eq', ['user_id', 'user-1']],
      ['eq', ['capability_id', 'email.read']],
    ]);
  });

  it('returns recent successful plays, newest first, capped by the limit', async () => {
    const { client, calls, builderCalls } = makeClientStub();
    await repo.fetchRecentSuccessfulCapabilityPlays(client as unknown as SupabaseClient, 'user-1', 'music.play', 3);
    expect(calls).toEqual([['from', ['capability_play_log']]]);
    expect(builderCalls).toEqual([
      ['select', ['connector_id']],
      ['eq', ['user_id', 'user-1']],
      ['eq', ['capability_id', 'music.play']],
      ['eq', ['ok', true]],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [3]],
    ]);
  });
});
