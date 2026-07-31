/**
 * resolve_recipient — VTID-VOICE-STATUS-CONTRACT.
 *
 * THE BUG (root cause of a live "send a message to X... Vitana acts stupid,
 * tried several times and nothing worked" report): live-system-instruction.ts's
 * message-send-truthfulness HARD RULE tells the model it must call
 * resolve_recipient and read its STATUS — only "resolved" (one high-confidence
 * candidate) or an explicit pick from "ambiguous" gives it a real UUID. But
 * resolve_recipient never actually emitted a "STATUS:" prefix in its spoken
 * text, so the model had no reliable signal to follow that instruction by.
 *
 * These tests pin that all three outcomes (resolved / ambiguous / not_found)
 * now carry the documented STATUS marker.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import { tool_resolve_recipient } from '../../src/services/orb-tools-shared';

const id = { user_id: 'u1', tenant_id: 't1', role: 'community' } as never;

function makeStubSupabase(candidates: Array<Record<string, unknown>>) {
  return {
    rpc: async () => ({ data: candidates, error: null }),
  } as never;
}

describe('resolve_recipient — STATUS contract', () => {
  it('single high-confidence candidate → STATUS: resolved', async () => {
    const sb = makeStubSupabase([
      { user_id: 'r1', vitana_id: 'vit_r1', display_name: 'Mariia Maksina', score: 0.94, reason: 'name_match' },
    ]);
    const r = await tool_resolve_recipient({ spoken_name: 'Mariia Maksina' }, id, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^STATUS: resolved\b/);
    expect((r.result as { ambiguous: boolean }).ambiguous).toBe(false);
  });

  it('multiple close-scoring candidates → STATUS: ambiguous', async () => {
    const sb = makeStubSupabase([
      { user_id: 'r1', vitana_id: 'vit_r1', display_name: 'Dragan Red', score: 0.9, reason: 'name_match' },
      { user_id: 'r2', vitana_id: 'vit_r2', display_name: 'Dragan Blue', score: 0.88, reason: 'name_match' },
    ]);
    const r = await tool_resolve_recipient({ spoken_name: 'Dragan' }, id, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^STATUS: ambiguous\b/);
    expect((r.result as { ambiguous: boolean }).ambiguous).toBe(true);
  });

  it('low-confidence single candidate → STATUS: ambiguous (below the 0.85 floor)', async () => {
    const sb = makeStubSupabase([
      { user_id: 'r1', vitana_id: 'vit_r1', display_name: 'Someone Vague', score: 0.5, reason: 'fuzzy_match' },
    ]);
    const r = await tool_resolve_recipient({ spoken_name: 'Someone' }, id, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^STATUS: ambiguous\b/);
  });

  it('no candidates → STATUS: not_found', async () => {
    const sb = makeStubSupabase([]);
    const r = await tool_resolve_recipient({ spoken_name: 'Nobody Here' }, id, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^STATUS: not_found\b/);
  });
});
