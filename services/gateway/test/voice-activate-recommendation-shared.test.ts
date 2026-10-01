/**
 * activate_recommendation on the shared ORB tool registry.
 *
 * VTID-02975 lifted it into the shared dispatcher (Vertex, LiveKit,
 * /api/v1/orb/tool). VTID-04464 closed the ownerless-row bypass. VTID-04493
 * (Community Autopilot CA-1) made it delegate to the canonical community
 * activation, so a spoken "yes" produces the same calendar slot, OASIS event
 * and notification as the popup's Go button. Owner / source_type / status
 * checks live in that canonical function and are covered by
 * test/routes/autopilot-recommendations.test.ts; this file pins the delegation,
 * the error mapping and the pending-CTA fallback.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

jest.mock('../src/routes/autopilot-recommendations', () => ({
  activateCommunityAutopilotRecommendation: jest.fn(),
}));

import { activateCommunityAutopilotRecommendation } from '../src/routes/autopilot-recommendations';
import { dispatchOrbTool, tool_activate_recommendation } from '../src/services/orb-tools-shared';
import { mapActivationError } from '../src/services/orb-tools/community-autopilot-tools';

const activate = activateCommunityAutopilotRecommendation as jest.Mock;

const USER = 'aaaa1111-1111-4111-8111-111111111111';
const REC = 'cccc3333-3333-4333-8333-333333333333';
const IDENT = { user_id: USER, tenant_id: 'tenant-1', role: 'community', vitana_id: 'vit_send' };

function stubSb(opts: { pendingCta?: unknown; deletes?: string[] } = {}) {
  return {
    from(table: string) {
      if (table !== 'orb_session_state') return {} as never;
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: opts.pendingCta ?? null, error: null }) }),
          }),
        }),
        delete: () => ({
          eq: () => ({
            eq: async () => {
              opts.deletes?.push('pending_cta');
              return { error: null };
            },
          }),
        }),
      } as unknown;
    },
  } as never;
}

beforeEach(() => activate.mockReset());

describe('activate_recommendation → canonical community activation (VTID-04493)', () => {
  test('1. dispatches by name and delegates with the caller, tenant and skipReplenish', async () => {
    activate.mockResolvedValue({ ok: true, httpStatus: 200, title: 'Evening walk', calendar_event_id: 'ev-9' });
    const r = await dispatchOrbTool('activate_recommendation', { id: REC }, IDENT, stubSb());
    expect(r.ok).toBe(true);
    expect(activate).toHaveBeenCalledWith(USER, REC, { tenantId: 'tenant-1', skipReplenish: true, channel: 'voice', confirmed: false });
    if (r.ok === true) {
      expect(r.result).toMatchObject({ title: 'Evening walk', already_active: false, calendar_event_id: 'ev-9' });
      expect(r.text).toMatch(/Activated "Evening walk"; a calendar slot was booked/);
    }
  });

  test('2. already-activated is idempotent', async () => {
    activate.mockResolvedValue({ ok: true, httpStatus: 200, already_activated: true, title: 'Walk' });
    const r = await tool_activate_recommendation({ id: REC }, IDENT, stubSb());
    expect(r.ok).toBe(true);
    if (r.ok === true) expect((r.result as { already_active: boolean }).already_active).toBe(true);
  });

  test.each([
    [403, 'Recommendation belongs to another user', 'recommendation_belongs_to_another_user'],
    [403, 'Not a community recommendation', 'not_a_community_recommendation'],
    [404, 'Recommendation not found', 'recommendation_not_found'],
    [400, 'Cannot activate recommendation in status: rejected', 'recommendation_not_activatable:rejected'],
    [401, 'Authentication required', 'not_signed_in'],
  ])('3. canonical %s "%s" → %s', async (httpStatus, error, code) => {
    activate.mockResolvedValue({ ok: false, httpStatus, error });
    const r = await tool_activate_recommendation({ id: REC }, IDENT, stubSb());
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toBe(code);
    expect(mapActivationError(httpStatus, error)).toBe(code);
  });

  test('4. anonymous caller never reaches the activation', async () => {
    const r = await tool_activate_recommendation({ id: REC }, { ...IDENT, user_id: '' }, stubSb());
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toBe('not_signed_in');
    expect(activate).not.toHaveBeenCalled();
  });

  test('5. missing id and no pending offer → "id is required"', async () => {
    const r = await tool_activate_recommendation({ id: '' }, IDENT, stubSb());
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toBe('id is required');
    expect(activate).not.toHaveBeenCalled();
  });

  test('6. empty id resolves the pending offer and consumes it only after success', async () => {
    activate.mockResolvedValue({ ok: true, httpStatus: 200, title: 'Focus block' });
    const deletes: string[] = [];
    const sb = stubSb({
      deletes,
      pendingCta: {
        value: { tool: 'activate_recommendation', payload: { id: REC } },
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });
    const r = await tool_activate_recommendation({ id: '' }, IDENT, sb);
    expect(r.ok).toBe(true);
    expect(activate).toHaveBeenCalledWith(USER, REC, expect.any(Object));
    await new Promise((res) => setTimeout(res, 20));
    expect(deletes).toContain('pending_cta');
  });

  test('7. a failed activation keeps the pending offer for a retry', async () => {
    activate.mockResolvedValue({ ok: false, httpStatus: 503, error: 'Supabase not configured' });
    const deletes: string[] = [];
    const sb = stubSb({
      deletes,
      pendingCta: {
        value: { tool: 'activate_recommendation', payload: { id: REC } },
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });
    const r = await tool_activate_recommendation({ id: '' }, IDENT, sb);
    expect(r.ok).toBe(false);
    await new Promise((res) => setTimeout(res, 20));
    expect(deletes).toHaveLength(0);
  });
});
