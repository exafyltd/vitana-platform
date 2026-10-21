/**
 * KPI metrics (OBS-KPI-0001, runbook Sec. 6 / Sec. 7).
 *
 * Dashboards read OASIS projections — KPIs are computed from the emitted OASIS
 * event stream (plus a couple of live counts like the exception-queue depth).
 * Pure functions, no side effects.
 */
import { OasisEvent } from '../api/oasis-sink';

export interface KpiSnapshot {
  onboarding: {
    opened: number;
    approved: number;
    reused: number;
    approvalRate: number; // approved / opened
  };
  commissions: {
    pending: number;
    confirmed: number;
    reversed: number;
    /** confirmed / (confirmed + reversed) — higher is better. */
    confirmedShare: number;
  };
  commerce: {
    cartsRouted: number;
  };
  loyalty: {
    linked: number;
  };
  exceptions: {
    /** Open human tasks awaiting action (queue depth). */
    queueDepth: number;
  };
  totalEvents: number;
}

function countType(events: Pick<OasisEvent, 'type'>[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : +(num / den).toFixed(4);
}

export interface KpiInputs {
  events: Pick<OasisEvent, 'type'>[];
  /** Current count of open human tasks (exception queue). */
  openHumanTasks?: number;
}

export function computeKpis({ events, openHumanTasks = 0 }: KpiInputs): KpiSnapshot {
  const opened = countType(events, 'vcaop.onboarding.kyb_opened');
  const approved = countType(events, 'vcaop.onboarding.kyb_approved');
  const reused = countType(events, 'vcaop.onboarding.kyb_reused');

  const pending = countType(events, 'vcaop.reward.pending');
  const confirmed = countType(events, 'vcaop.reward.confirmed');
  const reversed = countType(events, 'vcaop.reward.reversed');

  return {
    onboarding: { opened, approved, reused, approvalRate: ratio(approved, opened) },
    commissions: { pending, confirmed, reversed, confirmedShare: ratio(confirmed, confirmed + reversed) },
    commerce: { cartsRouted: countType(events, 'vcaop.cart.routed') },
    loyalty: { linked: countType(events, 'vcaop.loyalty.linked') },
    exceptions: { queueDepth: openHumanTasks },
    totalEvents: events.length,
  };
}
