/**
 * Autopilot Automations Phase 1 — connect-people domain gap closure.
 *
 * AP-0106 ("People You Know Are Here" Social Proof) and AP-0110 (Opportunity
 * Surfacing with Social Layer) were PLANNED-only entries with no handler.
 * This pins: both are now IMPLEMENTED with a registered handler, and each
 * handler's core behavior (notify when social overlap exists, no-op when it
 * doesn't).
 */

import {
  AUTOMATION_REGISTRY,
  getAutomation,
} from '../../src/services/automation-registry';
import { registerHandler, getHandler } from '../../src/services/automation-executor';
import { registerConnectPeopleHandlers } from '../../src/services/automation-handlers/connect-people';
import { AutomationContext } from '../../src/types/automations';

registerConnectPeopleHandlers();

/**
 * Minimal thenable Supabase query-builder fake. Every chain method returns
 * `this`; resolving the chain (via await / .then) yields the configured
 * result for that table. Enough to exercise the two handlers under test
 * without a real Supabase client.
 */
function makeFakeSupabase(resultsByTable: Record<string, { data?: any; count?: number; error?: any }>) {
  return {
    from(table: string) {
      const result = resultsByTable[table] || { data: [], error: null };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  };
}

function makeCtx(supabase: any, metadata: Record<string, unknown>): { ctx: AutomationContext; notify: jest.Mock } {
  const notify = jest.fn();
  const ctx: AutomationContext = {
    tenantId: 't-1',
    targetRoles: 'all',
    supabase,
    run: {
      id: 'run-1',
      tenant_id: 't-1',
      automation_id: 'AP-TEST',
      trigger_type: 'event',
      target_roles: 'all',
      status: 'running',
      users_affected: 0,
      actions_taken: 0,
      metadata,
      started_at: new Date().toISOString(),
    },
    log: jest.fn(),
    notify,
    emitEvent: jest.fn(async () => {}),
    queryTargetUsers: jest.fn(async () => []),
  };
  return { ctx, notify };
}

describe('registry — AP-0106 and AP-0110 are implemented', () => {
  it('AP-0106 has status IMPLEMENTED and a registered handler', () => {
    const def = getAutomation('AP-0106');
    expect(def?.status).toBe('IMPLEMENTED');
    expect(def?.handler).toBe('runPeopleYouKnowSocialProof');
    expect(getHandler(def!.handler!)).toBeInstanceOf(Function);
  });

  it('AP-0110 has status IMPLEMENTED and a registered handler', () => {
    const def = getAutomation('AP-0110');
    expect(def?.status).toBe('IMPLEMENTED');
    expect(def?.handler).toBe('runOpportunitySocialLayer');
    expect(getHandler(def!.handler!)).toBeInstanceOf(Function);
  });

  it('no PLANNED automation in connect-people is missing a handler if IMPLEMENTED', () => {
    const connectPeople = AUTOMATION_REGISTRY.filter(d => d.domain === 'connect-people');
    for (const def of connectPeople) {
      if (def.status === 'IMPLEMENTED' || def.status === 'LIVE') {
        expect(def.handler).toBeTruthy();
      }
    }
  });
});

describe('runPeopleYouKnowSocialProof (AP-0106)', () => {
  it('notifies the viewer when connections are members of the viewed group', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: { data: [{ target_id: 'friend-1' }], error: null },
      global_community_group_members: { data: [{ user_id: 'friend-1' }], error: null },
      app_users: { data: [{ display_name: 'Alex' }], error: null },
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'viewer-1', group_id: 'group-1' });

    const handler = getHandler('runPeopleYouKnowSocialProof')!;
    const result = await handler(ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('viewer-1');
    expect(notify.mock.calls[0][2].body).toContain('Alex');
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when the viewer has no connections', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: { data: [], error: null },
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'viewer-1', group_id: 'group-1' });

    const handler = getHandler('runPeopleYouKnowSocialProof')!;
    const result = await handler(ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('is a no-op when required payload fields are missing', async () => {
    const supabase = makeFakeSupabase({});
    const { ctx, notify } = makeCtx(supabase, {});

    const handler = getHandler('runPeopleYouKnowSocialProof')!;
    const result = await handler(ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runOpportunitySocialLayer (AP-0110)', () => {
  it('notifies the user when connections engaged with a similar opportunity', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: { data: [{ target_id: 'friend-1' }, { target_id: 'friend-2' }], error: null },
      contextual_opportunities: {
        data: [{ id: 'o-1', user_id: 'friend-1' }],
        count: 1,
        error: null,
      },
    });
    const { ctx, notify } = makeCtx(supabase, {
      user_id: 'viewer-1',
      opportunity_id: 'opp-1',
      opportunity_type: 'health_checkin',
    });

    const handler = getHandler('runOpportunitySocialLayer')!;
    const result = await handler(ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('viewer-1');
    expect(notify.mock.calls[0][2].data.opportunity_id).toBe('opp-1');
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when no connections engaged with a similar opportunity', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: { data: [{ target_id: 'friend-1' }], error: null },
      contextual_opportunities: { data: [], count: 0, error: null },
    });
    const { ctx, notify } = makeCtx(supabase, {
      user_id: 'viewer-1',
      opportunity_id: 'opp-1',
      opportunity_type: 'health_checkin',
    });

    const handler = getHandler('runOpportunitySocialLayer')!;
    const result = await handler(ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});
