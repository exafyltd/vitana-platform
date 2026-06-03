/**
 * DEV-COMHU-0506 — ORB Recovery 6: greeting-policy ↔ cadence-signal wiring.
 *
 * Proves the end-to-end behavior the ORB-2+3 cadence writer enables: once
 * wake_cadence:last_turn_at / last_greeting_at are populated (the ORB-2+3 fix),
 * the authoritative greeting policy produces the RECOVERY buckets — never a
 * spurious first-time greeting on a quick reopen. This is the regression that
 * VTID-03172 tried (and failed) to fix at the prompt layer.
 */

import { fetchWakeCadenceSignals } from '../../src/services/wake-cadence-signals';
import { decideGreetingPolicy } from '../../src/orb/live/instruction/greeting-policy';
import type { GreetingPolicyInput } from '../../src/orb/live/instruction/greeting-policy';

function sbWithSignals(rows: Array<{ signal_name: string; value: unknown; last_seen_at: string }>) {
  const chain: any = {
    eq: () => chain,
    in: () => Promise.resolve({ data: rows, error: null }),
  };
  return {
    from: () => ({ select: () => chain }),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

const NOW = '2026-05-31T12:00:00.000Z';

describe('ORB Recovery: quick reopen does not re-greet (cadence → policy)', () => {
  it('recent turn (<5min) → policy skip (cross-surface continuation)', async () => {
    // last_turn_at 60s ago → recordWakeTurn would have written this on the prior turn.
    const signals = await fetchWakeCadenceSignals({
      supabase: sbWithSignals([
        { signal_name: 'wake_cadence:last_turn_at', value: { iso: '2026-05-31T11:59:00.000Z' }, last_seen_at: NOW },
      ]),
      tenantId: 't1',
      userId: 'u1',
      nowIso: NOW,
    });
    expect(signals.seconds_since_last_turn_anywhere).toBe(60);
    const policy = decideGreetingPolicy({ bucket: 'morning', ...signals } as GreetingPolicyInput);
    expect(policy).toBe('skip');
  });

  it('greeted <15min ago → policy skip (greet-once-per-window)', async () => {
    const signals = await fetchWakeCadenceSignals({
      supabase: sbWithSignals([
        // turn was a while ago (no continuation), but a greeting fired 5 min ago
        { signal_name: 'wake_cadence:last_turn_at', value: { iso: '2026-05-31T10:00:00.000Z' }, last_seen_at: NOW },
        { signal_name: 'wake_cadence:last_greeting_at', value: { iso: '2026-05-31T11:55:00.000Z' }, last_seen_at: NOW },
      ]),
      tenantId: 't1',
      userId: 'u1',
      nowIso: NOW,
    });
    expect(signals.time_since_last_greeting_today_ms).toBe(5 * 60 * 1000);
    const policy = decideGreetingPolicy({ bucket: 'morning', ...signals } as GreetingPolicyInput);
    expect(policy).toBe('skip');
  });

  it('no prior signals (genuinely fresh) → NOT skip (greets normally)', async () => {
    const signals = await fetchWakeCadenceSignals({
      supabase: sbWithSignals([]),
      tenantId: 't1',
      userId: 'u1',
      nowIso: NOW,
    });
    expect(signals.seconds_since_last_turn_anywhere).toBeUndefined();
    const policy = decideGreetingPolicy({ bucket: 'morning', ...signals } as GreetingPolicyInput);
    expect(policy).not.toBe('skip');
  });

  it('isReconnect forces skip regardless of cadence', () => {
    const policy = decideGreetingPolicy({ bucket: 'morning', isReconnect: true } as GreetingPolicyInput);
    expect(policy).toBe('skip');
  });
});
