/**
 * Autopilot Automations — onboarding-growth (AP-1300 series) schema-drift
 * fixes. This domain shipped before this session's schema-verification
 * pass and had the same never-deployed-table bugs found everywhere else:
 * user_topic_profile -> user_interests, community_groups/community_memberships
 * -> global_community_groups/global_community_group_members,
 * community_meetups/community_meetup_attendance -> global_community_events/
 * global_event_participants, relationship_edges' real column set, app_users'
 * user_id PK, and credit_wallet() -> increment_wallet_balance().
 */

import * as fs from 'fs';
import * as path from 'path';

import { getAutomation } from '../../src/services/automation-registry';
import { getHandler } from '../../src/services/automation-executor';
import { registerOnboardingGrowthHandlers } from '../../src/services/automation-handlers/onboarding-growth';
import { AutomationContext } from '../../src/types/automations';

registerOnboardingGrowthHandlers();

const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'automation-handlers', 'onboarding-growth.ts');

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
        upsert: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        ilike: () => chain,
        like: () => chain,
        gte: () => chain,
        lte: () => chain,
        overlaps: () => chain,
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

function makeCtx(supabase: any, metadata: Record<string, unknown> = {}) {
  const notify = jest.fn();
  const ctx: AutomationContext = {
    tenantId: 't-1',
    targetRoles: 'all',
    supabase,
    run: {
      id: 'run-1', tenant_id: 't-1', automation_id: 'AP-TEST', trigger_type: 'event',
      target_roles: 'all', status: 'running', users_affected: 0, actions_taken: 0,
      metadata, started_at: new Date().toISOString(),
    },
    log: jest.fn(),
    notify,
    emitEvent: jest.fn(async () => {}),
    queryTargetUsers: jest.fn(async () => []),
  };
  return { ctx, notify };
}

describe('onboarding-growth — source-level wall against never-deployed / wrong tables', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  it('never references the never-deployed VTID-01084/legacy tables', () => {
    expect(src).not.toMatch(/from\(['"]user_topic_profile['"]\)/);
    expect(src).not.toMatch(/from\(['"]community_groups['"]\)/);
    expect(src).not.toMatch(/from\(['"]community_memberships['"]\)/);
    expect(src).not.toMatch(/from\(['"]community_meetups['"]\)/);
    expect(src).not.toMatch(/from\(['"]community_meetup_attendance['"]\)/);
  });

  it('uses the real live tables instead', () => {
    expect(src).toContain("from('user_interests')");
    expect(src).toContain("from('global_community_groups')");
    expect(src).toContain("from('global_community_group_members')");
    expect(src).toContain("from('global_community_events')");
    expect(src).toContain("from('global_event_participants')");
  });

  it('never queries app_users by "id" (the real PK is user_id)', () => {
    expect(src).not.toMatch(/from\(['"]app_users['"]\)[\s\S]{0,200}\.eq\(['"]id['"],/);
  });

  it('relationship_edges queries use the real column set, not user_id/relationship_type/context', () => {
    expect(src).not.toMatch(/\.eq\(['"]relationship_type['"],/);
    expect(src).not.toContain('context: JSON.stringify(');
    expect(src).toContain("eq('edge_type', 'suggested')");
  });

  it('no longer calls the nonexistent credit_wallet RPC', () => {
    expect(src).not.toContain("rpc('credit_wallet'");
    expect(src).toContain("rpc('increment_wallet_balance'");
  });

  it('registry: all AP-1300 automations marked IMPLEMENTED have a registered handler', () => {
    for (const id of ['AP-1301', 'AP-1302', 'AP-1303', 'AP-1304', 'AP-1305', 'AP-1306', 'AP-1307']) {
      const def = getAutomation(id);
      if (def?.status === 'IMPLEMENTED' || def?.status === 'LIVE') {
        expect(def.handler).toBeTruthy();
        expect(getHandler(def.handler!)).toBeInstanceOf(Function);
      }
    }
  });
});

describe('runOrbGuidedOnboarding (AP-1301)', () => {
  it('sends a welcome message and credits the onboarding bonus', async () => {
    const supabase = makeFakeSupabase({
      app_users: [{ data: { display_name: 'Alex', created_at: new Date().toISOString() }, error: null }],
      user_interests: [{ count: 0, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1' });
    const handler = getHandler('runOrbGuidedOnboarding')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('increment_wallet_balance', expect.objectContaining({ p_user_id: 'u1' }));
    expect(result.usersAffected).toBe(1);
  });
});

describe('runContactBookSyncAndInvite (AP-1303)', () => {
  it('finds existing contacts by email and suggests connections', async () => {
    const supabase = makeFakeSupabase({
      app_users: [{ data: [{ user_id: 'friend-1', email: 'friend@x.com' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', contacts: [{ email: 'friend@x.com' }] });
    const handler = getHandler('runContactBookSyncAndInvite')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalled();
    expect(result.usersAffected).toBeGreaterThan(0);
  });
});
