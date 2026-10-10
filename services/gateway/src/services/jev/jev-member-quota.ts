/**
 * VTID-04872: per-member daily quota for community Class B decisions
 * (owner approval 2026-10-03: "Class B shadow first, 300 per member per day,
 * safety decisions exempt; Class C at 0").
 *
 *   JEV_MEMBER_QUOTA_MODE   off | shadow | enforce   (unset or unknown → shadow)
 *   JEV_MEMBER_DAILY_QUOTA  calls per member per UTC day (default 300)
 *
 * Applies to a call counted as member spend (jevSpendPlane() === 'member')
 * whose decision is Class B (or unclassified) and not a safety decision.
 * The member is `opts.member_id` (a system caller ranking for a member names
 * them) or, on the member plane, the caller. Each such call bumps
 * jev_member_daily_counters before the Jev call:
 *
 *   shadow  — never refuses; the first call over the limit per member per day
 *             emits jev.member_quota.would_refuse so the limit can be judged
 *             on real traffic before it is enforced.
 *   enforce — over the limit → fallback 'member_daily_quota_exhausted' (429),
 *             the caller keeps its rules. A counter that cannot be read fails
 *             closed ('member_quota_check_failed').
 *
 * Shadow is the default on purpose: an unset or mistyped mode keeps counting
 * and refuses nothing. Off stops counting.
 */

import { getSupabase } from '../../lib/supabase';
import { emitOasisEvent } from '../oasis-event-service';
import type { JevDecisionDef } from './jev-decisions';
import type { JevPlane } from './jev-access';
import * as repo from './jev-repository';

export const JEV_MEMBER_QUOTA_VTID = 'VTID-04872';
export const JEV_MEMBER_DAILY_QUOTA_DEFAULT = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type JevMemberQuotaMode = 'off' | 'shadow' | 'enforce';

export function memberQuotaMode(env: NodeJS.ProcessEnv = process.env): JevMemberQuotaMode {
  const v = env.JEV_MEMBER_QUOTA_MODE;
  return v === 'off' || v === 'enforce' ? v : 'shadow';
}

export function memberDailyQuota(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.JEV_MEMBER_DAILY_QUOTA);
  return Number.isInteger(n) && n > 0 ? n : JEV_MEMBER_DAILY_QUOTA_DEFAULT;
}

/** Whether a call is quota-limited. Pure. */
export function isQuotaLimited(def: Pick<JevDecisionDef, 'community_class' | 'safety'>, spendPlane: JevPlane): boolean {
  if (spendPlane !== 'member' || def.safety) return false;
  return (def.community_class ?? 'B') === 'B';
}

export interface MemberQuotaStore {
  /** Count this call for the member today; returns today's count after it, or null if unreadable. */
  bump(tenantId: string, memberId: string): Promise<number | null>;
}

export function createSupabaseMemberQuotaStore(): MemberQuotaStore {
  return {
    async bump(tenantId, memberId) {
      const sb = getSupabase();
      if (!sb) return null;
      try {
        const { data, error } = await repo.bumpMemberQuotaRpc(sb, tenantId, memberId);
        if (error) {
          console.warn(`[jev] member quota bump failed tenant=${tenantId}: ${error.message}`);
          return null;
        }
        return data === null || data === undefined ? null : Number(data);
      } catch (err: any) {
        console.warn(`[jev] member quota bump threw tenant=${tenantId}: ${err?.message || err}`);
        return null;
      }
    },
  };
}

export function createMemoryMemberQuotaStore(initial: Record<string, number> = {}) {
  const counts: Record<string, number> = { ...initial };
  const store: MemberQuotaStore = {
    async bump(tenantId, memberId) {
      const k = `${tenantId}:${memberId}`;
      counts[k] = (counts[k] ?? 0) + 1;
      return counts[k];
    },
  };
  return { store, counts };
}

let defaultStore: MemberQuotaStore | null = null;
export function getDefaultMemberQuotaStore(): MemberQuotaStore {
  return (defaultStore ||= createSupabaseMemberQuotaStore());
}
export function setDefaultMemberQuotaStoreForTest(s: MemberQuotaStore | null): void {
  defaultStore = s;
}

export type MemberQuotaResult =
  | { allowed: true; counted: number | null; would_refuse?: true }
  | { allowed: false; reason: 'member_daily_quota_exhausted' | 'member_quota_check_failed'; counted: number | null };

export interface MemberQuotaInput {
  decision: string;
  tenantId: string;
  memberId: string;
  store: MemberQuotaStore;
  env?: NodeJS.ProcessEnv;
  emit?: typeof emitOasisEvent;
}

/** Counts one quota-limited call and says whether it may go to Jev. Never throws. */
export async function checkMemberQuota(i: MemberQuotaInput): Promise<MemberQuotaResult> {
  const env = i.env ?? process.env;
  const mode = memberQuotaMode(env);
  if (mode === 'off') return { allowed: true, counted: null };
  const limit = memberDailyQuota(env);
  // Member ids are auth user uuids; anything else cannot be counted (or erased with the account).
  if (!UUID_RE.test(i.memberId)) {
    return mode === 'enforce' ? { allowed: false, reason: 'member_quota_check_failed', counted: null } : { allowed: true, counted: null };
  }
  const count = await i.store.bump(i.tenantId, i.memberId);
  if (count === null) {
    return mode === 'enforce' ? { allowed: false, reason: 'member_quota_check_failed', counted: null } : { allowed: true, counted: null };
  }
  if (count <= limit) return { allowed: true, counted: count };
  if (mode === 'enforce') return { allowed: false, reason: 'member_daily_quota_exhausted', counted: count };
  if (count === limit + 1) {
    void (i.emit ?? emitOasisEvent)({
      vtid: JEV_MEMBER_QUOTA_VTID,
      type: 'jev.member_quota.would_refuse',
      source: 'jev:member_quota',
      status: 'warning',
      message: `jev member quota would refuse (shadow) decision=${i.decision} tenant=${i.tenantId} limit=${limit}/day`,
      // no member id: oasis_events outlives account erasure (VTID-04765); the counter row holds it
      payload: { tenant_id: i.tenantId, decision: i.decision, limit, mode },
      actor_id: 'jev-member-quota',
      actor_role: 'system',
      surface: 'api',
    } as any).catch((err) => console.warn('[jev] member quota event failed:', err?.message || err));
  }
  return { allowed: true, counted: count, would_refuse: true };
}
