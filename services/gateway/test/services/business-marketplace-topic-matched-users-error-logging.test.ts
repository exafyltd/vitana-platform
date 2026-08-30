/**
 * automation-handlers/business-marketplace.ts — previously zero test
 * coverage for runServiceListingDistribution (AP-1101).
 *
 * docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md Addendum 5 flags `user_topic_profile`
 * as the single highest-value unresolved finding: 5 call sites, only
 * spot-checked. This is one of them — `fetchTopicMatchedUsers()` queries
 * `user_topic_profile`, which does not exist in live Supabase, so every
 * real call errors. The handler previously destructured only `{ data:
 * matchingUsers }`, discarding the error, so the loop below silently
 * iterated zero users — meaning AP-1101 (notify users with matching
 * interests when a new service is listed) has never actually notified
 * anyone in production, with nothing in logs. This pins that the error is
 * now logged, without changing the (unfixed) zero-matches fallback.
 */

const mockFetchServiceCatalogSummary = jest.fn();
const mockFetchTopicMatchedUsers = jest.fn();
const mockUpsertServiceRelationshipEdge = jest.fn();

jest.mock('../../src/services/automation-handlers/business-marketplace-repository', () => ({
  fetchServiceCatalogSummary: (...args: unknown[]) => mockFetchServiceCatalogSummary(...args),
  fetchTopicMatchedUsers: (...args: unknown[]) => mockFetchTopicMatchedUsers(...args),
  upsertServiceRelationshipEdge: (...args: unknown[]) => mockUpsertServiceRelationshipEdge(...args),
}));

import { registerBusinessMarketplaceHandlers } from '../../src/services/automation-handlers/business-marketplace';
import { getHandler } from '../../src/services/automation-executor';
import type { AutomationContext } from '../../src/types/automations';

function buildCtx(metadata: Record<string, unknown>): AutomationContext {
  return {
    tenantId: 't1',
    targetRoles: 'ALL' as any,
    supabase: {},
    run: {
      id: 'run1',
      tenant_id: 't1',
      automation_id: 'AP-1101',
      trigger_type: 'event' as any,
      target_roles: 'ALL' as any,
      status: 'running' as any,
      users_affected: 0,
      actions_taken: 0,
      metadata,
      started_at: new Date().toISOString(),
    },
    log: () => {},
    notify: () => {},
    emitEvent: async () => {},
    queryTargetUsers: async () => [],
  };
}

describe('runServiceListingDistribution (AP-1101) — fetchTopicMatchedUsers error visibility', () => {
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    registerBusinessMarketplaceHandlers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchServiceCatalogSummary.mockResolvedValue({
      data: { name: 'Yoga', service_type: 'service', topic_keys: ['fitness'] },
    });
    mockUpsertServiceRelationshipEdge.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('logs via console.warn when fetchTopicMatchedUsers errors (the user_topic_profile-does-not-exist shape), instead of silently notifying nobody', async () => {
    mockFetchTopicMatchedUsers.mockResolvedValue({
      data: null,
      error: { message: 'relation "user_topic_profile" does not exist' },
    });

    const handler = getHandler('runServiceListingDistribution')!;
    const result = await handler(buildCtx({ service_id: 'svc1', user_id: 'creator1' }));

    // Documented, unchanged behavior: an errored match query still means
    // zero users get notified this run — this fix only adds visibility.
    expect(result.usersAffected).toBe(0);
    expect(mockUpsertServiceRelationshipEdge).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchTopicMatchedUsers failed'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('relation "user_topic_profile" does not exist'),
    );
  });

  it('logs nothing when fetchTopicMatchedUsers succeeds and correctly notifies matched users', async () => {
    mockFetchTopicMatchedUsers.mockResolvedValue({
      data: [{ user_id: 'u2', score: 80 }],
      error: null,
    });

    const handler = getHandler('runServiceListingDistribution')!;
    const result = await handler(buildCtx({ service_id: 'svc1', user_id: 'creator1' }));

    expect(result.usersAffected).toBe(1);
    expect(mockUpsertServiceRelationshipEdge).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
