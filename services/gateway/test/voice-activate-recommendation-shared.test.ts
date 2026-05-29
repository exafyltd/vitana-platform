/**
 * VTID-02975: activate_recommendation reachable via the shared dispatcher.
 *
 * Closes the conversational-activation gap reported in the VTID-02969
 * live smoke test: the canonical autopilot REST endpoint activates
 * recommendations, and ORB voice send_chat_message returns next_actions
 * referencing them, but /api/v1/orb/tool previously returned 404 for
 * activate_recommendation and /api/v1/orb/chat rejected the spoken-yes
 * intent. After this lift, the same handler is reachable from:
 *   - Vertex voice (orb-live.ts case → dispatchOrbToolForVertex)
 *   - LiveKit (uses ORB_TOOL_REGISTRY directly)
 *   - /api/v1/orb/tool (HTTP wrapper around dispatchOrbTool)
 * No path-specific divergence is possible.
 *
 * These tests pin the contract:
 *   1. Dispatch via the shared registry succeeds (status new → activated).
 *   2. Already-active recs return ok:true + already_active:true (idempotent).
 *   3. Ownership: a rec owned by another user is rejected.
 *   4. Missing rec returns recommendation_not_found.
 *   5. Result.text is the celebratory close — what Gemini will speak.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  dispatchOrbTool,
  tool_activate_recommendation,
} from '../src/services/orb-tools-shared';

const SENDER_UUID = 'aaaa1111-1111-4111-8111-111111111111';
const OTHER_USER_UUID = 'bbbb2222-2222-4222-8222-222222222222';
const REC_UUID_NEW = 'cccc3333-3333-4333-8333-333333333333';
const REC_UUID_ACTIVATED = 'dddd4444-4444-4444-8444-444444444444';
const REC_UUID_FOREIGN = 'eeee5555-5555-4555-8555-555555555555';

interface CapturedUpdate {
  recId: string;
  patch: Record<string, unknown>;
}

function makeStubSupabase(opts: {
  recs: Record<string, { id: string; title?: string | null; summary?: string | null; status: string; user_id: string | null }>;
  updateError?: { message: string } | null;
  fetchError?: { message: string } | null;
  updates: CapturedUpdate[];
}) {
  return {
    from(table: string) {
      if (table !== 'autopilot_recommendations') {
        return {} as never;
      }
      return {
        select: () => ({
          eq: (_col: string, value: string) => ({
            maybeSingle: async () => ({
              data: opts.recs[value] ?? null,
              error: opts.fetchError ?? null,
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, value: string) => {
            opts.updates.push({ recId: value, patch });
            return { error: opts.updateError ?? null };
          },
        }),
      } as unknown;
    },
  } as never;
}

describe('VTID-02975 — activate_recommendation lifted to shared dispatcher', () => {
  test('1. status new → activated via shared dispatch (dispatchOrbTool path)', async () => {
    const updates: CapturedUpdate[] = [];
    const sb = makeStubSupabase({
      updates,
      recs: {
        [REC_UUID_NEW]: {
          id: REC_UUID_NEW,
          title: 'Investigate deploy failure: gateway',
          summary: 'Smoke test rec',
          status: 'new',
          user_id: SENDER_UUID,
        },
      },
    });

    const result = await dispatchOrbTool(
      'activate_recommendation',
      { id: REC_UUID_NEW },
      { user_id: SENDER_UUID, tenant_id: 'tenant-1', role: 'user', vitana_id: 'vit_send' },
      sb,
    );

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      const r = result.result as { title: string; already_active: boolean };
      expect(r.already_active).toBe(false);
      expect(r.title).toBe('Investigate deploy failure: gateway');
      expect(result.text).toMatch(/Done — "Investigate deploy failure: gateway" is on your active list/);
    }
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      recId: REC_UUID_NEW,
      patch: { status: 'activated' },
    });
  });

  test('2. already-activated rec returns ok:true + already_active:true (idempotent)', async () => {
    const updates: CapturedUpdate[] = [];
    const sb = makeStubSupabase({
      updates,
      recs: {
        [REC_UUID_ACTIVATED]: {
          id: REC_UUID_ACTIVATED,
          title: 'Already active rec',
          summary: null,
          status: 'activated',
          user_id: SENDER_UUID,
        },
      },
    });

    const result = await tool_activate_recommendation(
      { id: REC_UUID_ACTIVATED },
      { user_id: SENDER_UUID, tenant_id: 'tenant-1', role: 'user', vitana_id: 'vit_send' },
      sb,
    );

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      const r = result.result as { already_active: boolean };
      expect(r.already_active).toBe(true);
      expect(result.text).toMatch(/was already on your active list/);
    }
    // No UPDATE issued — idempotent.
    expect(updates).toHaveLength(0);
  });

  test('3. rec owned by another user → recommendation_belongs_to_another_user', async () => {
    const updates: CapturedUpdate[] = [];
    const sb = makeStubSupabase({
      updates,
      recs: {
        [REC_UUID_FOREIGN]: {
          id: REC_UUID_FOREIGN,
          title: 'Not yours',
          summary: null,
          status: 'new',
          user_id: OTHER_USER_UUID,
        },
      },
    });

    const result = await tool_activate_recommendation(
      { id: REC_UUID_FOREIGN },
      { user_id: SENDER_UUID, tenant_id: 'tenant-1', role: 'user', vitana_id: 'vit_send' },
      sb,
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe('recommendation_belongs_to_another_user');
    }
    expect(updates).toHaveLength(0); // never mutated
  });

  test('4. missing rec → recommendation_not_found', async () => {
    const updates: CapturedUpdate[] = [];
    const sb = makeStubSupabase({ updates, recs: {} });

    const result = await tool_activate_recommendation(
      { id: 'ffff6666-6666-4666-8666-666666666666' },
      { user_id: SENDER_UUID, tenant_id: 'tenant-1', role: 'user', vitana_id: 'vit_send' },
      sb,
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe('recommendation_not_found');
    }
    expect(updates).toHaveLength(0);
  });

  test('5. system-owned rec (user_id=null) is activatable by any user', async () => {
    // The original orb-live.ts logic: `rec.user_id && rec.user_id !== identity`
    // — null user_id means "system-wide recommendation", anyone can activate.
    const updates: CapturedUpdate[] = [];
    const sysRecId = '99999999-9999-4999-8999-999999999999';
    const sb = makeStubSupabase({
      updates,
      recs: {
        [sysRecId]: {
          id: sysRecId,
          title: 'System rec',
          summary: null,
          status: 'new',
          user_id: null,
        },
      },
    });

    const result = await tool_activate_recommendation(
      { id: sysRecId },
      { user_id: SENDER_UUID, tenant_id: 'tenant-1', role: 'user', vitana_id: 'vit_send' },
      sb,
    );

    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
  });

  test('6. missing id → "id is required"', async () => {
    const updates: CapturedUpdate[] = [];
    const sb = makeStubSupabase({ updates, recs: {} });

    const result = await tool_activate_recommendation(
      { id: '' },
      { user_id: SENDER_UUID, tenant_id: 'tenant-1', role: 'user', vitana_id: 'vit_send' },
      sb,
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe('id is required');
    }
  });

  test('7. dispatchOrbTool exposes activate_recommendation by name (no more "unknown tool")', async () => {
    // Regression guard for the gap the user reported: /api/v1/orb/tool used
    // to return 404 because activate_recommendation was not in
    // ORB_TOOL_REGISTRY. This test fails loud if anyone removes it.
    const sb = makeStubSupabase({
      updates: [],
      recs: {
        [REC_UUID_NEW]: {
          id: REC_UUID_NEW,
          title: 'Discoverable',
          summary: null,
          status: 'new',
          user_id: SENDER_UUID,
        },
      },
    });
    const r = await dispatchOrbTool(
      'activate_recommendation',
      { id: REC_UUID_NEW },
      { user_id: SENDER_UUID, tenant_id: 'tenant-1', role: 'user', vitana_id: 'vit_send' },
      sb,
    );
    if (r.ok === false) {
      expect(r.error).not.toMatch(/^unknown tool:/);
    }
    expect(r.ok).toBe(true);
  });
});
