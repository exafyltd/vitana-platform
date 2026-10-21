/**
 * Swallowed-error regression tests — AP-0908 (runBehaviorPreferenceInference)
 * and AP-0909 (runRelationshipGraphProjection).
 *
 * AP-0908's fetchExistingPreferenceFacts (memory_facts) gates "skip facts
 * that already have this value" — an unchecked error here silently
 * rewrote every fact unconditionally, so it is intentionally log-only
 * (console.error) + graceful degradation, not fail-closed.
 *
 * AP-0909's fetchExistingPersonNode / fetchExistingSuggestedEdge /
 * fetchExistingConnectedEdge (relationship_nodes / relationship_edges)
 * each gate against creating a duplicate node/edge — an unchecked error
 * there previously fell through as "nothing exists yet" and inserted a
 * duplicate; this pins the fail-closed fix (ctx.log + skip that fact/pair).
 */

import { getHandler } from '../../src/services/automation-executor';
import { registerMemoryIntelligenceHandlers } from '../../src/services/automation-handlers/memory-intelligence';
import { AutomationContext } from '../../src/types/automations';

registerMemoryIntelligenceHandlers();

function makeFakeSupabase(
  resultsByTable: Record<string, Array<{ data?: any; count?: number; error?: any }>>,
  rpcResults: Record<string, { data?: any; error?: any }> = {},
) {
  const cursors: Record<string, number> = {};
  return {
    from(table: string) {
      const queue = resultsByTable[table] || [{ data: [], error: null }];
      const idx = Math.min(cursors[table] || 0, queue.length - 1);
      cursors[table] = (cursors[table] || 0) + 1;
      const result = queue[idx];
      const chain: any = {
        select: () => chain,
        insert: () => chain,
        update: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        is: () => chain,
        like: () => chain,
        overlaps: () => chain,
        contains: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
    rpc(name: string) {
      return Promise.resolve(rpcResults[name] ?? { data: null, error: null });
    },
  };
}

function makeCtx(
  supabase: any,
  metadata: Record<string, unknown> = {},
  queryTargetUsers: Array<{ user_id: string; active_role: string }> = []
): { ctx: AutomationContext; notify: jest.Mock; log: jest.Mock } {
  const notify = jest.fn();
  const log = jest.fn();
  const ctx: AutomationContext = {
    tenantId: 't-1',
    targetRoles: 'all',
    supabase,
    run: {
      id: 'run-1', tenant_id: 't-1', automation_id: 'AP-TEST', trigger_type: 'heartbeat',
      target_roles: 'all', status: 'running', users_affected: 0, actions_taken: 0,
      metadata, started_at: new Date().toISOString(),
    },
    log,
    notify,
    emitEvent: jest.fn(async () => {}),
    queryTargetUsers: jest.fn(async () => queryTargetUsers),
  };
  return { ctx, notify, log };
}

describe('runBehaviorPreferenceInference (AP-0908)', () => {
  const routines = {
    data: [{ user_id: 'u1', routine_kind: 'time_of_day_preference', metadata: { time_of_day: 'morning' } }],
    error: null,
  };

  it('writes the derived preference fact when it differs from the existing one', async () => {
    const supabase = makeFakeSupabase(
      { user_routines: [routines], memory_facts: [{ data: [], error: null }] },
      { write_fact: { data: 'fact-id', error: null } },
    );
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runBehaviorPreferenceInference')!;
    const result = await handler(ctx);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('logs (does not silence) a fetchExistingPreferenceFacts error, and degrades to rewriting facts unconditionally', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeFakeSupabase(
      { user_routines: [routines], memory_facts: [{ data: null, error: { message: 'db timeout' } }] },
      { write_fact: { data: 'fact-id', error: null } },
    );
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runBehaviorPreferenceInference')!;
    const result = await handler(ctx);
    // Degrades gracefully: still writes the fact rather than silently skipping the whole run.
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchExistingPreferenceFacts failed'));
    consoleErrorSpy.mockRestore();
  });
});

describe('runRelationshipGraphProjection (AP-0909)', () => {
  const nameFact = {
    data: [{ user_id: 'u1', fact_key: 'spouse_name', fact_value: 'Maria', extracted_at: new Date().toISOString() }],
    error: null,
  };

  it('creates a person node and suggested edge when neither already exists', async () => {
    const supabase = makeFakeSupabase({
      memory_facts: [nameFact],
      relationship_nodes: [
        { data: null, error: null }, // fetchExistingPersonNode -> none
        { data: { id: 'node-1' }, error: null }, // insertPersonNode -> created
      ],
      relationship_edges: [{ data: null, error: null }, { data: null, error: null }], // fetchExistingSuggestedEdge -> none; insert
      user_follows: [{ data: [], error: null }],
    });
    const { ctx, log } = makeCtx(supabase);
    const handler = getHandler('runRelationshipGraphProjection')!;
    const result = await handler(ctx);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 2 });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
  });

  it('skips (does not create a duplicate person node) when fetchExistingPersonNode errors, and logs it', async () => {
    const supabase = makeFakeSupabase({
      memory_facts: [nameFact],
      relationship_nodes: [{ data: null, error: { message: 'db timeout' } }],
      user_follows: [{ data: [], error: null }],
    });
    const { ctx, log } = makeCtx(supabase);
    const handler = getHandler('runRelationshipGraphProjection')!;
    const result = await handler(ctx);
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('existing-node lookup failed'));
  });

  it('skips (does not create a duplicate suggested edge) when fetchExistingSuggestedEdge errors, and logs it', async () => {
    const supabase = makeFakeSupabase({
      memory_facts: [nameFact],
      relationship_nodes: [
        { data: null, error: null },
        { data: { id: 'node-1' }, error: null },
      ],
      relationship_edges: [{ data: null, error: { message: 'db timeout' } }],
      user_follows: [{ data: [], error: null }],
    });
    const { ctx, log } = makeCtx(supabase);
    const handler = getHandler('runRelationshipGraphProjection')!;
    const result = await handler(ctx);
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('existing-edge lookup failed'));
  });

  it('skips (does not create a duplicate connected edge) when fetchExistingConnectedEdge errors, and logs it', async () => {
    const supabase = makeFakeSupabase({
      memory_facts: [{ data: [], error: null }],
      user_follows: [{ data: [{ follower_id: 'a', following_id: 'b' }, { follower_id: 'b', following_id: 'a' }], error: null }],
      relationship_edges: [{ data: null, error: { message: 'db timeout' } }],
    });
    const { ctx, log } = makeCtx(supabase);
    const handler = getHandler('runRelationshipGraphProjection')!;
    const result = await handler(ctx);
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('existing-connected-edge lookup failed'));
  });
});
