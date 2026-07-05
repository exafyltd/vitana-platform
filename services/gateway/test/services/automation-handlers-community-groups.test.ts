/**
 * Autopilot Automations Phase 1 — community-groups domain.
 *
 * Two things pinned here:
 *
 * 1. Source-level wall: community_groups/community_memberships/
 *    community_meetups/community_meetup_attendance (VTID-01084, never
 *    deployed) and the app_users.id-instead-of-user_id mistake must not
 *    reappear in this file. Both were confirmed live bugs in several
 *    already-"IMPLEMENTED" handlers (AP-0202/0203/0207/0208/0210) — found
 *    while building the 5 PLANNED gaps in this domain, fixed alongside them.
 * 2. Behavior of the 5 newly-implemented automations (AP-0201, AP-0204,
 *    AP-0205, AP-0206, AP-0209), each against the real live schema
 *    (global_community_groups / global_community_group_members /
 *    global_messages / relationship_edges with source_type/source_id/
 *    target_type/target_id/edge_type).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  AUTOMATION_REGISTRY,
  getAutomation,
} from '../../src/services/automation-registry';
import { getHandler } from '../../src/services/automation-executor';
import { registerCommunityGroupsHandlers } from '../../src/services/automation-handlers/community-groups';
import { AutomationContext } from '../../src/types/automations';

registerCommunityGroupsHandlers();

const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'automation-handlers', 'community-groups.ts');

describe('community-groups — source-level wall against never-deployed / wrong-column tables', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  it('never references the never-deployed VTID-01084 tables', () => {
    expect(src).not.toMatch(/from\(['"]community_groups['"]\)/);
    expect(src).not.toMatch(/from\(['"]community_memberships['"]\)/);
    expect(src).not.toMatch(/from\(['"]community_meetups['"]\)/);
    expect(src).not.toMatch(/from\(['"]community_meetup_attendance['"]\)/);
  });

  it('never queries app_users by "id" (the real PK is user_id)', () => {
    const appUsersBlocks = src.split("from('app_users')").slice(1);
    for (const block of appUsersBlocks) {
      const nextFewLines = block.slice(0, 150);
      expect(nextFewLines).not.toMatch(/\.eq\(['"]id['"],/);
      expect(nextFewLines).not.toMatch(/\.in\(['"]id['"],/);
    }
  });

  it('uses the real live groups/events tables', () => {
    expect(src).toContain("from('global_community_groups')");
    expect(src).toContain("from('global_community_group_members')");
    expect(src).toContain("from('global_community_events')");
    expect(src).toContain("from('global_event_participants')");
  });
});

describe('registry — the 5 PLANNED community-groups gaps are now implemented', () => {
  const expected: Record<string, string> = {
    'AP-0201': 'runAutoCreateGroupFromInterestCluster',
    'AP-0204': 'runAutoSuggestMeetupFromGroupActivity',
    'AP-0205': 'runGroupHealthMonitor',
    'AP-0206': 'runCrossGroupIntroduction',
    'AP-0209': 'runGroupCreationFromMatchCluster',
  };

  for (const [id, handlerName] of Object.entries(expected)) {
    it(`${id} has status IMPLEMENTED with handler ${handlerName}`, () => {
      const def = getAutomation(id);
      expect(def?.status).toBe('IMPLEMENTED');
      expect(def?.handler).toBe(handlerName);
      expect(getHandler(handlerName)).toBeInstanceOf(Function);
    });
  }

  it('no community-groups automation marked IMPLEMENTED/LIVE is missing a handler', () => {
    const domain = AUTOMATION_REGISTRY.filter((d) => d.domain === 'community-groups');
    for (const def of domain) {
      if (def.status === 'IMPLEMENTED' || def.status === 'LIVE') {
        expect(def.handler).toBeTruthy();
      }
    }
  });
});

/**
 * Sequenced thenable Supabase fake: each table maps to a queue of results,
 * consumed in call order (FIFO), repeating the last entry once exhausted.
 * insert()/select()/eq()/etc all return `this`; resolving yields the queued
 * result. Enough to exercise multi-step handlers without a real client.
 */
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
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        ilike: () => chain,
        gte: () => chain,
        lte: () => chain,
        contains: () => chain,
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
      id: 'run-1',
      tenant_id: 't-1',
      automation_id: 'AP-TEST',
      trigger_type: 'heartbeat',
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
    queryTargetUsers: jest.fn(async () => queryTargetUsers),
  };
  return { ctx, notify };
}

describe('runAutoCreateGroupFromInterestCluster (AP-0201)', () => {
  it('creates a group and notifies members when a cluster meets the threshold', async () => {
    const clusterUsers = ['u1', 'u2', 'u3', 'u4', 'u5'].map((user_id) => ({
      user_id, interest: 'pickleball', confidence_score: 0.9,
    }));
    const supabase = makeFakeSupabase({
      user_interests: [{ data: clusterUsers, error: null }],
      global_community_groups: [
        { data: null, error: null }, // existing-group check: none found
        { data: { id: 'g-1', name: 'Pickleball Circle' }, error: null }, // insert().select().single()
      ],
      global_community_group_members: [{ data: null, error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);

    const handler = getHandler('runAutoCreateGroupFromInterestCluster')!;
    const result = await handler(ctx);

    expect(notify).toHaveBeenCalledTimes(5);
    expect(result.usersAffected).toBe(5);
  });

  it('is a no-op when no interest cluster meets the minimum user threshold', async () => {
    const supabase = makeFakeSupabase({
      user_interests: [{ data: [{ user_id: 'u1', interest: 'pickleball', confidence_score: 0.9 }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);

    const handler = getHandler('runAutoCreateGroupFromInterestCluster')!;
    const result = await handler(ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runAutoSuggestMeetupFromGroupActivity (AP-0204)', () => {
  it('notifies the creator when message volume spikes and no recent suggestion exists', async () => {
    const supabase = makeFakeSupabase({
      global_community_groups: [{ data: [{ id: 'g-1', name: 'Runners', created_by: 'creator-1', chat_thread_id: 't-1' }], error: null }],
      global_messages: [{ data: [], count: 20, error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);

    const handler = getHandler('runAutoSuggestMeetupFromGroupActivity')!;
    const result = await handler(ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('creator-1');
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when message volume is below the spike threshold', async () => {
    const supabase = makeFakeSupabase({
      global_community_groups: [{ data: [{ id: 'g-1', name: 'Runners', created_by: 'creator-1', chat_thread_id: 't-1' }], error: null }],
      global_messages: [{ data: [], count: 2, error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);

    const handler = getHandler('runAutoSuggestMeetupFromGroupActivity')!;
    const result = await handler(ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runGroupHealthMonitor (AP-0205)', () => {
  it('reports dormant and empty groups to ops/admin users', async () => {
    const supabase = makeFakeSupabase({
      global_community_groups: [{
        data: [
          { id: 'g-1', name: 'Active Group', member_count: 5 },
          { id: 'g-2', name: 'Empty Group', member_count: 0 },
        ],
        error: null,
      }],
      group_posts: [{ data: null, error: null }], // no recent post -> dormant
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'admin-1', active_role: 'admin' }]);

    const handler = getHandler('runGroupHealthMonitor')!;
    const result = await handler(ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('admin-1');
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when there are no dormant or empty groups', async () => {
    const supabase = makeFakeSupabase({
      global_community_groups: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'admin-1', active_role: 'admin' }]);

    const handler = getHandler('runGroupHealthMonitor')!;
    const result = await handler(ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runCrossGroupIntroduction (AP-0206)', () => {
  it('introduces two users who share 2+ groups and have no existing edge', async () => {
    const supabase = makeFakeSupabase({
      global_community_group_members: [{
        data: [
          { user_id: 'u1', group_id: 'g-1' },
          { user_id: 'u1', group_id: 'g-2' },
          { user_id: 'u2', group_id: 'g-1' },
          { user_id: 'u2', group_id: 'g-2' },
        ],
        error: null,
      }],
      relationship_edges: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);

    const handler = getHandler('runCrossGroupIntroduction')!;
    const result = await handler(ctx);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ usersAffected: 2, actionsTaken: 2 });
  });

  it('is a no-op when users share fewer than 2 groups', async () => {
    const supabase = makeFakeSupabase({
      global_community_group_members: [{
        data: [
          { user_id: 'u1', group_id: 'g-1' },
          { user_id: 'u2', group_id: 'g-1' },
        ],
        error: null,
      }],
    });
    const { ctx, notify } = makeCtx(supabase);

    const handler = getHandler('runCrossGroupIntroduction')!;
    const result = await handler(ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runGroupCreationFromMatchCluster (AP-0209)', () => {
  it('creates a group for a mutually-connected triangle with no shared group yet', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: [{
        data: [
          { source_id: 'u1', target_id: 'u2' },
          { source_id: 'u2', target_id: 'u1' },
          { source_id: 'u1', target_id: 'u3' },
          { source_id: 'u3', target_id: 'u1' },
          { source_id: 'u2', target_id: 'u3' },
          { source_id: 'u3', target_id: 'u2' },
        ],
        error: null,
      }],
      global_community_group_members: [{ data: [], error: null }, { data: null, error: null }],
      global_community_groups: [{ data: { id: 'g-new', name: 'Your Match Circle' }, error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);

    const handler = getHandler('runGroupCreationFromMatchCluster')!;
    const result = await handler(ctx);

    expect(notify).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ usersAffected: 3, actionsTaken: 4 });
  });

  it('is a no-op when no fully-connected triangle exists', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: [{
        data: [
          { source_id: 'u1', target_id: 'u2' },
          { source_id: 'u2', target_id: 'u3' },
        ],
        error: null,
      }],
    });
    const { ctx, notify } = makeCtx(supabase);

    const handler = getHandler('runGroupCreationFromMatchCluster')!;
    const result = await handler(ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});
