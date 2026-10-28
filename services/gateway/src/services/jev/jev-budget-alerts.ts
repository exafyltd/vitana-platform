/**
 * VTID-04857: owner alerts on a tenant's community Jev budget.
 *
 * Approved 2026-10-03: page the owner when a tenant's budgeted spend (member,
 * patient, partner_org — JEV_BUDGETED_PLANES) crosses 80% of its monthly
 * budget, and again at 100%, when decide() starts returning the
 * 'tenant_budget_exhausted' fallback and every caller keeps its own rules.
 *
 * One OASIS event (jev.budget.threshold_crossed) and one Command Hub chat
 * ping per tenant × month × level. Several gateway tasks can see the same
 * crossing, so the event is looked up before paging; the in-process set only
 * saves the lookup. Fire-and-forget: an alert never fails or slows a decision.
 */

import { getSupabase } from '../../lib/supabase';
import { emitOasisEvent } from '../oasis-event-service';
import { notifyGChat } from '../self-healing-snapshot-service';
import * as repo from './jev-repository';
import { crossedBudgetLevels } from './jev-policy';
import { currentMonthUtc } from './jev-tenant-control';

export const JEV_BUDGET_ALERT_VTID = 'VTID-04857';

const raised = new Set<string>();

export interface BudgetAlertInput {
  tenantId: string;
  budgetUsd: number | null;
  spentBeforeUsd: number;
  costUsd: number;
  now?: Date;
}

export interface BudgetAlertDeps {
  emit?: typeof emitOasisEvent;
  page?: (message: string) => Promise<unknown>;
  /** Returns true when the alert was already raised by any task. */
  alreadyRaised?: (alertKey: string) => Promise<boolean>;
}

async function alreadyRaisedInOasis(alertKey: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { data, error } = await repo.fetchBudgetAlertEvent(sb, alertKey);
  return !error && Boolean(data);
}

/** Raises the alerts a spend step crossed. Returns the levels raised. Never throws. */
export async function maybeRaiseBudgetAlerts(i: BudgetAlertInput, d: BudgetAlertDeps = {}): Promise<number[]> {
  const levels = crossedBudgetLevels(i.spentBeforeUsd, i.spentBeforeUsd + i.costUsd, i.budgetUsd);
  if (!levels.length || i.budgetUsd === null) return [];
  const month = currentMonthUtc(i.now ?? new Date());
  const out: number[] = [];
  for (const level of levels) {
    const pct = Math.round(level * 100);
    const alertKey = `${i.tenantId}:${month}:${pct}`;
    if (raised.has(alertKey)) continue;
    raised.add(alertKey);
    try {
      if (await (d.alreadyRaised ?? alreadyRaisedInOasis)(alertKey)) continue;
      const spent = Math.round((i.spentBeforeUsd + i.costUsd) * 100) / 100;
      const exhausted = level >= 1;
      const message = exhausted
        ? `jev community budget exhausted tenant=${i.tenantId} spent=$${spent} of $${i.budgetUsd} (${month}) — member decisions fall back to rules until next month or a higher budget`
        : `jev community budget at ${pct}% tenant=${i.tenantId} spent=$${spent} of $${i.budgetUsd} (${month})`;
      await (d.emit ?? emitOasisEvent)({
        vtid: JEV_BUDGET_ALERT_VTID,
        type: 'jev.budget.threshold_crossed',
        source: 'jev:budget',
        status: exhausted ? 'error' : 'warning',
        message,
        payload: { alert_key: alertKey, tenant_id: i.tenantId, month, level_pct: pct, budget_usd: i.budgetUsd, spent_usd: spent },
        actor_id: 'jev-budget',
        actor_role: 'system',
        surface: 'api',
      } as any);
      await (d.page ?? notifyGChat)(`${exhausted ? '🛑' : '⚠️'} *Jev community budget* — ${message}`);
      out.push(level);
    } catch (err: any) {
      console.warn(`[jev] budget alert ${alertKey} failed: ${err?.message || err}`);
    }
  }
  return out;
}

export function resetBudgetAlertsForTest(): void {
  raised.clear();
}
