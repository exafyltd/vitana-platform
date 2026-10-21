/**
 * Monetization agent (AGNT-MONET-0004, runbook Sec. 6 / Sec. 4.6).
 *
 * At cart time, resolves the best affiliate route for a merchant (aggregator vs
 * direct), mints a per-user SubID, and records a projected reward. NEVER selects a
 * program with `affiliateCashbackAllowed=false` when cashback is requested.
 */
import { createHash } from 'crypto';

export interface AffiliateProgramOption {
  id: string;
  network: string;
  merchant: string;
  source: 'aggregator' | 'direct';
  affiliateCashbackAllowed: boolean | null;
  /** Fractional commission rate, e.g. 0.05 for 5%. */
  commissionRate: number;
}

export interface RouteSelection {
  program: AffiliateProgramOption;
  subId: string;
  projectedReward: number;
}

export interface SelectRouteOptions {
  /** Cart subtotal for the merchant (for projected reward). */
  amount: number;
  /** Whether this route must support user cashback. */
  cashback: boolean;
  /** Fraction of commission shared back to the user (default 0.5). */
  userShare?: number;
}

/** Deterministic per-user SubID for a program (stable attribution). */
export function mintSubId(userId: string, programId: string): string {
  const h = createHash('sha256').update(`${userId}:${programId}`).digest('hex').slice(0, 16);
  return `sub_${h}`;
}

export class Monetization {
  /**
   * Pick the best route for a merchant. When cashback is required, only programs
   * with affiliateCashbackAllowed===true are eligible. Among eligible programs,
   * prefer the higher effective commission; ties break toward `direct` (better terms).
   */
  selectRoute(userId: string, candidates: AffiliateProgramOption[], opts: SelectRouteOptions): RouteSelection | null {
    const eligible = candidates.filter((p) => (opts.cashback ? p.affiliateCashbackAllowed === true : true));
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      if (b.commissionRate !== a.commissionRate) return b.commissionRate - a.commissionRate;
      // tie-break: direct beats aggregator
      if (a.source !== b.source) return a.source === 'direct' ? -1 : 1;
      return 0;
    });

    const program = eligible[0];
    const userShare = opts.userShare ?? 0.5;
    const projectedReward = +(opts.amount * program.commissionRate * userShare).toFixed(4);
    return { program, subId: mintSubId(userId, program.id), projectedReward };
  }
}
