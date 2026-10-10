/**
 * VTID-04874: community share of the Jev rate limit (owner approval
 * 2026-10-03: "a separate TypeSafe key, or a gateway token bucket capping the
 * community plane at about 30% of the 1,200 requests/min limit").
 *
 * TypeSafe's limit is per account (docs/JEV-INTEGRATION-PLAN.md §8.5), so a
 * second key on the same account would not protect internal traffic; the
 * gateway token bucket is the option built here.
 *
 *   JEV_COMMUNITY_RATE_MODE        off | shadow | enforce   (unset or unknown → shadow)
 *   JEV_COMMUNITY_RPM_PER_TASK     member-spend Jev calls per minute per gateway task
 *                                  (default 180 = 360/min, 30% of 1,200, over 2 tasks)
 *
 * Applies only to calls counted as member spend (jevSpendPlane() === 'member'),
 * safety decisions included — a safety decision is exempt from the per-member
 * quota, not from the account-wide rate share, because it still competes with
 * internal traffic for the same 1,200/min. Internal and Dev Autopilot calls
 * never take a token.
 *
 * The bucket is in-process (one per gateway task): a shared counter would cost
 * a database round trip on every call. The per-task rate is therefore the
 * community share divided by the task count; set it when the count changes.
 *
 *   shadow  — never refuses; a call that finds the bucket empty is counted, and
 *             at most one jev.community_rate.would_limit event per task per
 *             10 minutes reports how many.
 *   enforce — an empty bucket → fallback 'community_rate_limited' (429); the
 *             caller keeps its rules. Nothing is queued.
 */

import { emitOasisEvent } from '../oasis-event-service';

export const JEV_COMMUNITY_RATE_VTID = 'VTID-04874';
export const JEV_COMMUNITY_RPM_PER_TASK_DEFAULT = 180;
const REPORT_EVERY_MS = 10 * 60 * 1000;

export type JevCommunityRateMode = 'off' | 'shadow' | 'enforce';

export function communityRateMode(env: NodeJS.ProcessEnv = process.env): JevCommunityRateMode {
  const v = env.JEV_COMMUNITY_RATE_MODE;
  return v === 'off' || v === 'enforce' ? v : 'shadow';
}

export function communityRpmPerTask(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.JEV_COMMUNITY_RPM_PER_TASK);
  return Number.isInteger(n) && n > 0 ? n : JEV_COMMUNITY_RPM_PER_TASK_DEFAULT;
}

/** A token bucket refilled continuously at `rpm` per minute, holding at most `rpm`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private rpm: number, private now: () => number = Date.now) {
    this.tokens = rpm;
    this.last = now();
  }
  take(rpm: number = this.rpm): boolean {
    if (rpm !== this.rpm) {
      this.rpm = rpm;
      this.tokens = Math.min(this.tokens, rpm);
    }
    const t = this.now();
    this.tokens = Math.min(this.rpm, this.tokens + ((t - this.last) / 60_000) * this.rpm);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export interface CommunityRateLimiter {
  /** true = the call may go to Jev. */
  admit(decision: string): boolean;
}

export function createCommunityRateLimiter(
  env: NodeJS.ProcessEnv = process.env,
  deps: { now?: () => number; emit?: typeof emitOasisEvent } = {},
): CommunityRateLimiter {
  const now = deps.now ?? Date.now;
  const bucket = new TokenBucket(communityRpmPerTask(env), now);
  let limited = 0;
  let lastReport = -Infinity;
  return {
    admit(decision) {
      const mode = communityRateMode(env);
      if (mode === 'off') return true;
      const rpm = communityRpmPerTask(env);
      if (bucket.take(rpm)) return true;
      if (mode === 'enforce') return false;
      limited++;
      const t = now();
      if (t - lastReport >= REPORT_EVERY_MS) {
        const count = limited;
        limited = 0;
        lastReport = t;
        void (deps.emit ?? emitOasisEvent)({
          vtid: JEV_COMMUNITY_RATE_VTID,
          type: 'jev.community_rate.would_limit',
          source: 'jev:community_rate',
          status: 'warning',
          message: `jev community rate share would limit (shadow): ${count} member-spend call(s) over ${rpm}/min on this task; last decision=${decision}`,
          payload: { would_limit: count, rpm_per_task: rpm, decision, mode },
          actor_id: 'jev-community-rate',
          actor_role: 'system',
          surface: 'api',
        } as any).catch((err) => console.warn('[jev] community rate event failed:', err?.message || err));
      }
      return true;
    },
  };
}

let defaultLimiter: CommunityRateLimiter | null = null;
export function getDefaultCommunityRateLimiter(): CommunityRateLimiter {
  return (defaultLimiter ||= createCommunityRateLimiter());
}
export function setDefaultCommunityRateLimiterForTest(l: CommunityRateLimiter | null): void {
  defaultLimiter = l;
}
