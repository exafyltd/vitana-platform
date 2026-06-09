import { computeKpis } from '../../src/observability/kpi';

const ev = (type: string) => ({ type });

describe('OBS-KPI-0001 — KPIs from OASIS projections', () => {
  test('aggregates onboarding, commission, commerce, loyalty metrics', () => {
    const events = [
      ev('vcaop.onboarding.kyb_opened'),
      ev('vcaop.onboarding.kyb_opened'),
      ev('vcaop.onboarding.kyb_approved'),
      ev('vcaop.onboarding.kyb_reused'),
      ev('vcaop.reward.pending'),
      ev('vcaop.reward.confirmed'),
      ev('vcaop.reward.reversed'),
      ev('vcaop.cart.routed'),
      ev('vcaop.loyalty.linked'),
    ];
    const k = computeKpis({ events, openHumanTasks: 3 });
    expect(k.onboarding.opened).toBe(2);
    expect(k.onboarding.approved).toBe(1);
    expect(k.onboarding.reused).toBe(1);
    expect(k.onboarding.approvalRate).toBeCloseTo(0.5, 4);
    expect(k.commissions.confirmed).toBe(1);
    expect(k.commissions.reversed).toBe(1);
    expect(k.commissions.confirmedShare).toBeCloseTo(0.5, 4);
    expect(k.commerce.cartsRouted).toBe(1);
    expect(k.loyalty.linked).toBe(1);
    expect(k.exceptions.queueDepth).toBe(3);
    expect(k.totalEvents).toBe(9);
  });

  test('handles an empty event stream without dividing by zero', () => {
    const k = computeKpis({ events: [] });
    expect(k.onboarding.approvalRate).toBe(0);
    expect(k.commissions.confirmedShare).toBe(0);
    expect(k.totalEvents).toBe(0);
  });
});
