/**
 * Autopilot Automations Phase 1 — sharing-growth (AP-0400 series).
 *
 * Registry/handler wiring checks for every automation in the domain, plus
 * a few deeper behavioral tests for representative handlers.
 */

import {
  AUTOMATION_REGISTRY,
  getAutomation,
} from '../../src/services/automation-registry';
import { getHandler } from '../../src/services/automation-executor';
import { registerSharingGrowthHandlers } from '../../src/services/automation-handlers/sharing-growth';
import { AutomationContext } from '../../src/types/automations';

registerSharingGrowthHandlers();

function makeFakeSupabase(resultsByTable: Record<string, Array<{ data?: any; count?: number; error?: any }>>) {
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
        upsert: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        ilike: () => chain,
        like: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        gt: () => chain,
        contains: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
    rpc: jest.fn(async () => ({ data: null, error: null })),
  };
}

function makeCtx(
  supabase: any,
  metadata: Record<string, unknown> = {},
  queryTargetUsers: Array<{ user_id: string; active_role: string }> = []
): { ctx: AutomationContext; notify: jest.Mock } {
  const notify = jest.fn();
  const ctx: AutomationContext = {
    tenantId: 't-1',
    targetRoles: 'all',
    supabase,
    run: {
      id: 'run-1', tenant_id: 't-1', automation_id: 'AP-TEST', trigger_type: 'heartbeat',
      target_roles: 'all', status: 'running', users_affected: 0, actions_taken: 0,
      metadata, started_at: new Date().toISOString(),
    },
    log: jest.fn(),
    notify,
    emitEvent: jest.fn(async () => {}),
    queryTargetUsers: jest.fn(async () => queryTargetUsers),
  };
  return { ctx, notify };
}

describe('registry wiring — sharing-growth', () => {
  const expected: Record<string, string> = {
    'AP-0401': 'generateWhatsAppEventLink',
    'AP-0402': 'generateWhatsAppGroupInvite',
    'AP-0403': 'runSocialMediaEventCardGenerator',
    'AP-0404': 'runInviteAfterPositive',
    'AP-0405': 'runReferralReward',
    'AP-0406': 'runAutoPostCommunityHighlights',
    'AP-0407': 'runUserProfileShareCard',
    'AP-0408': 'runEventCountdownSharePrompt',
    'AP-0409': 'runWeeklyRecapShare',
    'AP-0410': 'runViralLoopOnboarding',
    'AP-0411': 'runBringYourCircleInviteWave',
    'AP-0412': 'runProgressToStoryShare',
  };

  for (const [id, handlerName] of Object.entries(expected)) {
    it(`${id} has status IMPLEMENTED with handler ${handlerName}`, () => {
      const def = getAutomation(id);
      expect(def?.status).toBe('IMPLEMENTED');
      expect(def?.handler).toBe(handlerName);
      expect(getHandler(handlerName)).toBeInstanceOf(Function);
    });
  }

  it('no sharing-growth automation marked IMPLEMENTED is missing a handler', () => {
    for (const def of AUTOMATION_REGISTRY.filter((d) => d.domain === 'sharing-growth')) {
      if (def.status === 'IMPLEMENTED' || def.status === 'LIVE') {
        expect(def.handler).toBeTruthy();
      }
    }
  });
});

describe('runReferralReward (AP-0405)', () => {
  it('credits the referrer when a matching created referral is signed up', async () => {
    const supabase = makeFakeSupabase({
      referrals: [{ data: [{ id: 'ref-1' }], error: null }],
      app_users: [{ data: { display_name: 'Alex' }, error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { referrer_id: 'u1', referred_id: 'u2' });
    const handler = getHandler('runReferralReward')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('increment_wallet_balance', expect.objectContaining({
      p_user_id: 'u1', p_currency_type: 'CREDITS',
    }));
    expect(result).toEqual({ usersAffected: 2, actionsTaken: 3 });
  });

  it('is a no-op when there is no matching created referral (already processed)', async () => {
    const supabase = makeFakeSupabase({
      referrals: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { referrer_id: 'u1', referred_id: 'u2' });
    const handler = getHandler('runReferralReward')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runBringYourCircleInviteWave (AP-0411)', () => {
  it('sends an invite-wave prompt when no recent wave was sent', async () => {
    const supabase = makeFakeSupabase({
      daily_matches: [{ data: { user_id: 'u1' }, error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { match_id: 'm-1' });
    const handler = getHandler('runBringYourCircleInviteWave')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op within the cooldown window', async () => {
    const supabase = makeFakeSupabase({
      daily_matches: [{ data: { user_id: 'u1' }, error: null }],
      user_notifications: [{ data: [{ id: 'n-1' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { match_id: 'm-1' });
    const handler = getHandler('runBringYourCircleInviteWave')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('is a no-op when the match cannot be resolved', async () => {
    const supabase = makeFakeSupabase({
      daily_matches: [{ data: null, error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { match_id: 'missing' });
    const handler = getHandler('runBringYourCircleInviteWave')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runWeeklyRecapShare (AP-0409)', () => {
  it('skips users with zero activity in the window', async () => {
    const supabase = makeFakeSupabase({
      daily_matches: [{ count: 0, data: [], error: null }],
      chat_messages: [{ count: 0, data: [], error: null }],
      global_event_participants: [{ count: 0, data: [], error: null }],
      global_community_group_members: [{ count: 0, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runWeeklyRecapShare')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('sends a recap when the user had activity in the window', async () => {
    const supabase = makeFakeSupabase({
      daily_matches: [{ count: 3, data: [], error: null }],
      chat_messages: [{ count: 2, data: [], error: null }],
      global_event_participants: [{ count: 1, data: [], error: null }],
      global_community_group_members: [{ count: 0, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runWeeklyRecapShare')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('runSocialMediaEventCardGenerator (AP-0403)', () => {
  it('generates a share card for a recently-created event without one yet', async () => {
    const supabase = makeFakeSupabase({
      global_community_events: [{ data: [{ id: 'e1', title: 'Sunset Run', start_time: new Date().toISOString(), created_by: 'u1', participant_count: 4, slug: 'sunset-run' }], error: null }],
      sharing_links: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSocialMediaEventCardGenerator')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 2 });
  });

  it('skips an event that already has a social card', async () => {
    const supabase = makeFakeSupabase({
      global_community_events: [{ data: [{ id: 'e1', title: 'Sunset Run', start_time: new Date().toISOString(), created_by: 'u1', participant_count: 4, slug: 'sunset-run' }], error: null }],
      sharing_links: [{ data: [{ id: 'link-1' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSocialMediaEventCardGenerator')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});
