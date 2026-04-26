/**
 * VTID-01965: Healing Summary + Shadow Comparison Tests
 *
 * Verifies the aggregation logic that drives the Healing dashboard
 * (PR #8). Both endpoints are read-only and side-effect-free; tests
 * mock the Supabase reads and assert the computed shape.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  buildHealingSummary,
  buildShadowComparison,
} from '../src/services/voice-healing-summary';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => mockFetch.mockReset());

describe('VTID-01965: Healing Summary', () => {
  test('empty everywhere → all per_class counts zero, debt at week4 SLO', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_history')) return Promise.resolve(jsonResp([]));
      if (url.includes('voice_healing_quarantine')) return Promise.resolve(jsonResp([]));
      if (url.includes('voice_architecture_reports')) return Promise.resolve(jsonResp([]));
      throw new Error('unexpected: ' + url);
    });
    const s = await buildHealingSummary();
    expect(s.per_class.length).toBe(11);
    for (const c of s.per_class) {
      expect(c.dispatch_count_24h).toBe(0);
      expect(c.fix_success_rate_7d).toBeNull();
      expect(c.avg_recurrence_after_fix_ms_7d).toBeNull();
      expect(c.quarantine_status).toBe('active');
    }
    expect(s.unknown_class_debt.unknown_pct_24h).toBe(0);
    expect(s.unknown_class_debt.slo_band).toBe('week4');
  });

  test('counts dispatches per class across windows', async () => {
    const recent = new Date().toISOString();
    const day_ago = new Date(Date.now() - 24 * 3600_000 + 60_000).toISOString();
    const week_ago = new Date(Date.now() - 6 * 24 * 3600_000).toISOString();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_history')) {
        // Approx: each window includes its own historical rows, but our
        // test fakes Supabase returning the same set for all windows. The
        // function then re-filters server-side, so we still get correct
        // per-window counts because the returned rows ARE in-window for the
        // queried since.
        return Promise.resolve(
          jsonResp([
            { class: 'voice.config_missing', normalized_signature: 'sigA', dispatched_at: recent, verdict: 'ok', recurrence_after_fix_ms: 600000 },
            { class: 'voice.config_missing', normalized_signature: 'sigA', dispatched_at: day_ago, verdict: 'rollback', recurrence_after_fix_ms: null },
            { class: 'voice.auth_rejected', normalized_signature: 'sigB', dispatched_at: week_ago, verdict: 'ok', recurrence_after_fix_ms: 7200000 },
          ]),
        );
      }
      if (url.includes('voice_healing_quarantine')) return Promise.resolve(jsonResp([]));
      if (url.includes('voice_architecture_reports')) return Promise.resolve(jsonResp([]));
      throw new Error('unexpected: ' + url);
    });
    const s = await buildHealingSummary();
    const cm = s.per_class.find((c) => c.class === 'voice.config_missing')!;
    expect(cm.dispatch_count_24h + cm.dispatch_count_7d + cm.dispatch_count_30d).toBeGreaterThan(0);
    // success rate when both ok and rollback present: 1 ok / 2 verdicted = 50%
    expect(cm.fix_success_rate_7d).toBe(50);
    expect(cm.rollback_count_7d).toBe(1);
  });

  test('quarantine_status reflects current quarantine row', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_history')) return Promise.resolve(jsonResp([]));
      if (url.includes('voice_healing_quarantine')) {
        return Promise.resolve(
          jsonResp([
            { class: 'voice.config_missing', normalized_signature: 's', status: 'quarantined', probation_until: null },
            { class: 'voice.auth_rejected', normalized_signature: 's', status: 'probation', probation_until: '2099-01-01T00:00:00Z' },
          ]),
        );
      }
      if (url.includes('voice_architecture_reports')) return Promise.resolve(jsonResp([]));
      throw new Error('unexpected: ' + url);
    });
    const s = await buildHealingSummary();
    const cm = s.per_class.find((c) => c.class === 'voice.config_missing')!;
    expect(cm.quarantine_status).toBe('quarantined');
    const ar = s.per_class.find((c) => c.class === 'voice.auth_rejected')!;
    expect(ar.quarantine_status).toBe('probation');
    expect(ar.probation_until).toBe('2099-01-01T00:00:00Z');
  });

  test('latest_investigation_report_id is set per class', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_history')) return Promise.resolve(jsonResp([]));
      if (url.includes('voice_healing_quarantine')) return Promise.resolve(jsonResp([]));
      if (url.includes('voice_architecture_reports')) {
        return Promise.resolve(
          jsonResp([
            { id: 'report-1', class: 'voice.config_missing', generated_at: '2026-04-25T22:00:00Z' },
            { id: 'report-0', class: 'voice.config_missing', generated_at: '2026-04-24T10:00:00Z' },
            { id: 'report-2', class: 'voice.tts_failed', generated_at: '2026-04-25T18:00:00Z' },
          ]),
        );
      }
      throw new Error('unexpected: ' + url);
    });
    const s = await buildHealingSummary();
    const cm = s.per_class.find((c) => c.class === 'voice.config_missing')!;
    // Most-recent first — service iterates in order and only sets first hit.
    expect(cm.latest_investigation_report_id).toBe('report-1');
    const tts = s.per_class.find((c) => c.class === 'voice.tts_failed')!;
    expect(tts.latest_investigation_report_id).toBe('report-2');
    const auth = s.per_class.find((c) => c.class === 'voice.auth_rejected')!;
    expect(auth.latest_investigation_report_id).toBeNull();
  });

  test('unknown-class debt SLO bands', async () => {
    const recent = new Date().toISOString();
    // 8 unknown out of 10 → 80% → over_slo
    const rows = [
      ...Array.from({ length: 8 }, () => ({
        class: 'voice.unknown',
        normalized_signature: 'unknown',
        dispatched_at: recent,
        verdict: 'ok',
        recurrence_after_fix_ms: null,
      })),
      ...Array.from({ length: 2 }, () => ({
        class: 'voice.config_missing',
        normalized_signature: 'sigA',
        dispatched_at: recent,
        verdict: 'ok',
        recurrence_after_fix_ms: null,
      })),
    ];
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_history')) return Promise.resolve(jsonResp(rows));
      if (url.includes('voice_healing_quarantine')) return Promise.resolve(jsonResp([]));
      if (url.includes('voice_architecture_reports')) return Promise.resolve(jsonResp([]));
      throw new Error('unexpected: ' + url);
    });
    const s = await buildHealingSummary();
    expect(s.unknown_class_debt.unknown_count_24h).toBe(8);
    expect(s.unknown_class_debt.total_count_24h).toBe(10);
    expect(s.unknown_class_debt.unknown_pct_24h).toBe(80);
    expect(s.unknown_class_debt.slo_band).toBe('over_slo');
  });
});

describe('VTID-01965: Shadow Comparison', () => {
  test('matches shadow decisions to history rows within ±15min window', async () => {
    const t = new Date().toISOString();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_shadow_log')) {
        return Promise.resolve(
          jsonResp([
            {
              decided_at: t,
              mode: 'shadow',
              action: 'dispatched',
              class: 'voice.config_missing',
              normalized_signature: 'sigA',
              spec_hash: 'h',
            },
            {
              decided_at: t,
              mode: 'shadow',
              action: 'sentinel_quarantined',
              class: 'voice.auth_rejected',
              normalized_signature: 'sigB',
              spec_hash: null,
            },
          ]),
        );
      }
      if (url.includes('voice_healing_history')) {
        // Only one of the shadow rows has a matching history row.
        return Promise.resolve(
          jsonResp([
            {
              class: 'voice.config_missing',
              normalized_signature: 'sigA',
              dispatched_at: t,
              verdict: 'ok',
              recurrence_after_fix_ms: 60000,
            },
          ]),
        );
      }
      throw new Error('unexpected: ' + url);
    });
    const c = await buildShadowComparison(48);
    expect(c.window_hours).toBe(48);
    expect(c.total_shadow_decisions).toBe(2);
    expect(c.match_rate).toBe(50);
    const matched = c.rows.find((r) => r.matched_actual);
    expect(matched?.actual_verdict).toBe('ok');
  });

  test('by_action aggregates counts per action', async () => {
    const t = new Date().toISOString();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_shadow_log')) {
        return Promise.resolve(
          jsonResp([
            { decided_at: t, mode: 'shadow', action: 'dispatched', class: 'voice.config_missing', normalized_signature: 's', spec_hash: 'h' },
            { decided_at: t, mode: 'shadow', action: 'dispatched', class: 'voice.config_missing', normalized_signature: 's', spec_hash: 'h' },
            { decided_at: t, mode: 'shadow', action: 'dedupe_hit', class: 'voice.config_missing', normalized_signature: 's', spec_hash: 'h' },
          ]),
        );
      }
      if (url.includes('voice_healing_history')) return Promise.resolve(jsonResp([]));
      throw new Error('unexpected: ' + url);
    });
    const c = await buildShadowComparison(24);
    expect(c.by_action.dispatched).toBe(2);
    expect(c.by_action.dedupe_hit).toBe(1);
  });

  test('empty shadow log → zero counts, match_rate 0', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('voice_healing_shadow_log')) return Promise.resolve(jsonResp([]));
      if (url.includes('voice_healing_history')) return Promise.resolve(jsonResp([]));
      throw new Error('unexpected: ' + url);
    });
    const c = await buildShadowComparison(48);
    expect(c.total_shadow_decisions).toBe(0);
    expect(c.match_rate).toBe(0);
    expect(c.rows.length).toBe(0);
  });
});
