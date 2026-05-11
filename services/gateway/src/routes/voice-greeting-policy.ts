/**
 * VTID-02930 (B1): Greeting Decay preview API.
 *
 *   GET /api/v1/voice/greeting-policy/preview
 *
 * Query params (all optional — pure simulator; the policy itself is a
 * pure function and degrades safely when signals are absent):
 *   bucket=…                             (default 'first')
 *   isReconnect=true|false
 *   wasFailure=true|false
 *   seconds_since_last_turn_anywhere=N
 *   sessions_today_count=N
 *   is_transparent_reconnect=true|false
 *   time_since_last_greeting_today_ms=N
 *   greeting_style_last_used=skip|brief_resume|warm_return|fresh_intro
 *   wake_origin=orb_tap|wake_word|push_tap|proactive_opener|deep_link|unknown
 *   device_handoff_signal=true|false
 *
 * Auth: requireExafyAdmin. Same gating as the other B0c/B0d/B0e/R0
 * inspection endpoints.
 *
 * Wall (B1): read-only. NO state mutation. NO transport/audio/Live-API
 * tuning. Just the policy decision + evidence + signal source-health.
 */

import { Router, Response } from 'express';
import {
  requireAuthWithTenant,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import {
  decideGreetingPolicyWithEvidence,
  type GreetingPolicy,
  type GreetingPolicyInput,
} from '../orb/live/instruction/greeting-policy';

const router = Router();
const VTID = 'VTID-02930';

const KNOWN_BUCKETS: ReadonlySet<string> = new Set([
  'reconnect', 'recent', 'same_day', 'today', 'yesterday', 'week', 'long', 'first',
]);
const KNOWN_STYLES: ReadonlySet<GreetingPolicy> = new Set([
  'skip', 'brief_resume', 'warm_return', 'fresh_intro',
]);
const KNOWN_WAKE_ORIGINS: ReadonlySet<NonNullable<GreetingPolicyInput['wake_origin']>> = new Set([
  'orb_tap', 'wake_word', 'push_tap', 'proactive_opener', 'deep_link', 'unknown',
]);

function parseBool(v: unknown): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function parseNum(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

router.get(
  '/voice/greeting-policy/preview',
  requireAuthWithTenant,
  requireExafyAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const q = req.query;

      const bucketRaw = typeof q.bucket === 'string' && KNOWN_BUCKETS.has(q.bucket) ? q.bucket : 'first';
      const greetingStyleRaw =
        typeof q.greeting_style_last_used === 'string' &&
        KNOWN_STYLES.has(q.greeting_style_last_used as GreetingPolicy)
          ? (q.greeting_style_last_used as GreetingPolicy)
          : undefined;
      const wakeOriginRaw =
        typeof q.wake_origin === 'string' &&
        KNOWN_WAKE_ORIGINS.has(q.wake_origin as NonNullable<GreetingPolicyInput['wake_origin']>)
          ? (q.wake_origin as NonNullable<GreetingPolicyInput['wake_origin']>)
          : undefined;

      const input: GreetingPolicyInput = {
        bucket: bucketRaw,
        ...(parseBool(q.isReconnect) !== undefined ? { isReconnect: parseBool(q.isReconnect) } : {}),
        ...(parseBool(q.wasFailure) !== undefined ? { wasFailure: parseBool(q.wasFailure) } : {}),
        ...(parseNum(q.seconds_since_last_turn_anywhere) !== undefined
          ? { seconds_since_last_turn_anywhere: parseNum(q.seconds_since_last_turn_anywhere) }
          : {}),
        ...(parseNum(q.sessions_today_count) !== undefined
          ? { sessions_today_count: parseNum(q.sessions_today_count) }
          : {}),
        ...(parseBool(q.is_transparent_reconnect) !== undefined
          ? { is_transparent_reconnect: parseBool(q.is_transparent_reconnect) }
          : {}),
        ...(parseNum(q.time_since_last_greeting_today_ms) !== undefined
          ? { time_since_last_greeting_today_ms: parseNum(q.time_since_last_greeting_today_ms) }
          : {}),
        ...(greetingStyleRaw ? { greeting_style_last_used: greetingStyleRaw } : {}),
        ...(wakeOriginRaw ? { wake_origin: wakeOriginRaw } : {}),
        ...(parseBool(q.device_handoff_signal) !== undefined
          ? { device_handoff_signal: parseBool(q.device_handoff_signal) }
          : {}),
      };

      const decision = decideGreetingPolicyWithEvidence(input);
      return res.json({
        ok: true,
        vtid: VTID,
        input,
        decision,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: (e as Error).message,
        vtid: VTID,
      });
    }
  },
);

export default router;
