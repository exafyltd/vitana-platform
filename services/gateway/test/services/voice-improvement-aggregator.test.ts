/**
 * VTID-02865: Unit tests for the pure helpers in voice-improvement-aggregator.
 * The networked sources are intentionally not tested here — they're covered
 * by integration smoke after deploy.
 */

import {
  composeQualityScore,
  sortActionItems,
  dedupeActionItems,
  isZombieEscalation,
  type ActionItem,
} from '../../src/services/voice-improvement-aggregator';

function makeItem(partial: Partial<ActionItem> & { id: string; severity: ActionItem['severity'] }): ActionItem {
  return {
    id: partial.id,
    source: partial.source ?? 'autopilot_recommendation',
    severity: partial.severity,
    title: partial.title ?? `t-${partial.id}`,
    description: partial.description ?? '',
    evidence: partial.evidence ?? [],
    affected_sessions: partial.affected_sessions ?? null,
    affected_cohort: partial.affected_cohort ?? null,
    likely_owner: partial.likely_owner ?? null,
    source_files: partial.source_files ?? [],
    confidence: partial.confidence ?? 0.5,
    recommended_action: partial.recommended_action ?? '',
    available_actions: partial.available_actions ?? ['investigate'],
    source_ref: partial.source_ref ?? { table: 't', id: partial.id },
    detected_at: partial.detected_at ?? '2026-05-10T00:00:00Z',
  };
}

describe('composeQualityScore', () => {
  it('returns 100 for an empty queue', () => {
    expect(composeQualityScore([])).toBe(100);
  });

  it('subtracts 15 per critical, 5 per warning, 1 per info', () => {
    const items: ActionItem[] = [
      makeItem({ id: 'a', severity: 'critical' }),
      makeItem({ id: 'b', severity: 'warning' }),
      makeItem({ id: 'c', severity: 'warning' }),
      makeItem({ id: 'd', severity: 'info' }),
      makeItem({ id: 'e', severity: 'info' }),
      makeItem({ id: 'f', severity: 'info' }),
    ];
    // 100 - 15 - 5 - 5 - 1 - 1 - 1 = 72
    expect(composeQualityScore(items)).toBe(72);
  });

  it('floors at 0 and never returns negative', () => {
    const items: ActionItem[] = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `c${i}`, severity: 'critical' }),
    );
    // Naive: 100 - 15*20 = -200; clamped to 0.
    expect(composeQualityScore(items)).toBe(0);
  });
});

describe('sortActionItems', () => {
  it('orders critical → warning → info', () => {
    const items: ActionItem[] = [
      makeItem({ id: 'i1', severity: 'info' }),
      makeItem({ id: 'c1', severity: 'critical' }),
      makeItem({ id: 'w1', severity: 'warning' }),
    ];
    const out = sortActionItems(items);
    expect(out.map((i) => i.id)).toEqual(['c1', 'w1', 'i1']);
  });

  it('within the same severity, higher affected_sessions comes first', () => {
    const items: ActionItem[] = [
      makeItem({ id: 'low', severity: 'warning', affected_sessions: 2 }),
      makeItem({ id: 'high', severity: 'warning', affected_sessions: 100 }),
      makeItem({ id: 'mid', severity: 'warning', affected_sessions: 50 }),
    ];
    const out = sortActionItems(items);
    expect(out.map((i) => i.id)).toEqual(['high', 'mid', 'low']);
  });

  it('within the same severity + affected_sessions, more recent comes first', () => {
    const items: ActionItem[] = [
      makeItem({ id: 'old',  severity: 'warning', affected_sessions: 5, detected_at: '2026-05-01T00:00:00Z' }),
      makeItem({ id: 'new',  severity: 'warning', affected_sessions: 5, detected_at: '2026-05-10T00:00:00Z' }),
      makeItem({ id: 'mid',  severity: 'warning', affected_sessions: 5, detected_at: '2026-05-05T00:00:00Z' }),
    ];
    const out = sortActionItems(items);
    expect(out.map((i) => i.id)).toEqual(['new', 'mid', 'old']);
  });

  it('does not mutate the input array', () => {
    const items: ActionItem[] = [
      makeItem({ id: 'i', severity: 'info' }),
      makeItem({ id: 'c', severity: 'critical' }),
    ];
    const before = items.map((i) => i.id);
    sortActionItems(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });
});

describe('dedupeActionItems', () => {
  it('collapses items sharing the same id', () => {
    const items: ActionItem[] = [
      makeItem({ id: 'x', severity: 'warning', title: 'first' }),
      makeItem({ id: 'x', severity: 'warning', title: 'second' }),
      makeItem({ id: 'y', severity: 'info' }),
    ];
    const out = dedupeActionItems(items);
    expect(out).toHaveLength(2);
    // Later wins (Map.set semantics).
    expect(out.find((i) => i.id === 'x')?.title).toBe('second');
  });

  it('preserves all items when ids are unique', () => {
    const items: ActionItem[] = [
      makeItem({ id: 'a', severity: 'warning' }),
      makeItem({ id: 'b', severity: 'info' }),
      makeItem({ id: 'c', severity: 'critical' }),
    ];
    expect(dedupeActionItems(items)).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    expect(dedupeActionItems([])).toEqual([]);
  });
});

// VTID-02953 (PR-K): zombie-filter unit tests.
describe('isZombieEscalation', () => {
  it('marks route_not_registered against a retired endpoint as zombie', () => {
    // PR-I deleted /api/v1/self-healing/canary/failing-health — escalations
    // against it from before that deletion are zombies (endpoint cannot be
    // investigated; it no longer exists).
    expect(
      isZombieEscalation('/api/v1/self-healing/canary/failing-health', 'route_not_registered'),
    ).toBe(true);
  });

  it('does NOT mark route_not_registered against a currently-registered endpoint as zombie', () => {
    // The new canary IS in ENDPOINT_FILE_MAP — a real route_not_registered
    // here would be a genuine deploy regression and must surface.
    expect(
      isZombieEscalation('/api/v1/canary-target/health', 'route_not_registered'),
    ).toBe(false);
  });

  it('marks dev_autopilot_safety_gate_blocked against synthetic autopilot.* endpoints as zombie', () => {
    expect(isZombieEscalation('autopilot.approve_safety', 'dev_autopilot_safety_gate_blocked')).toBe(true);
  });

  it('does NOT mark dev_autopilot_safety_gate_blocked against a real route as zombie', () => {
    expect(
      isZombieEscalation('/api/v1/canary-target/health', 'dev_autopilot_safety_gate_blocked'),
    ).toBe(false);
  });

  it('does NOT mark handler_crash escalations as zombie even on retired endpoints', () => {
    // Other failure classes must keep showing — they may reference real
    // bugs even if the specific endpoint moved.
    expect(
      isZombieEscalation('/api/v1/self-healing/canary/failing-health', 'handler_crash'),
    ).toBe(false);
  });

  it('does NOT mark null failure_class as zombie (preserve everything we cannot categorize)', () => {
    expect(isZombieEscalation('/api/v1/self-healing/canary/failing-health', null)).toBe(false);
  });
});
