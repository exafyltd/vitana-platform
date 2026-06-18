/**
 * Real-Life Invite — ORB wake-brief provider (advice #4, SAFE pattern).
 *
 * Fires occasionally (low priority) to turn a moment of momentum into a
 * proposal to invite someone to a real-world activity. SPEAK ONLY — it never
 * navigates, writes a row, or contacts a third party (see real-life-invite.ts
 * for the scope rationale). Flag-gated by `vitana_real_life_invite_enabled`
 * (default OFF / kill switch): OFF → self-suppress, ladder unchanged.
 *
 * Priority 70 — below every personal-progress author (login-briefing 93,
 * journey-guide 91, next-action 90, conversation-flow-v3 88, Teacher 85, bare
 * wake-brief 80). It only wins when nothing more pressing about the user's OWN
 * journey is on the table, which is exactly when "do something with someone"
 * is the right nudge. Self-suppresses when the flag is off, so registering
 * always is safe.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AssistantContinuation,
  ContinuationProvider,
  ContinuationDecisionContext,
  ProviderResult,
} from '../types';
import { getSystemControl } from '../../system-controls-service';
import { fetchVitanaIndexForProfiler } from '../../user-context-profiler';
import { PILLAR_KEYS, type PillarKey } from '../../../lib/vitana-pillars';
import { pickInviteActivity, buildInviteProposal } from '../../guide/real-life-invite';

export const REAL_LIFE_INVITE_EXTRA_KEY = 'real_life_invite' as const;
export const REAL_LIFE_INVITE_PROVIDER_KEY = 'real_life_invite' as const;
export const REAL_LIFE_INVITE_FLAG = 'vitana_real_life_invite_enabled' as const;

const DEFAULT_PRIORITY = 70;

export interface RealLifeInviteInputs {
  supabase: SupabaseClient;
  tenantId: string;
  userId: string;
  lang: string;
  firstName?: string | null;
}

export interface RealLifeInviteProviderOptions {
  priority?: number;
  newId?: () => string;
  now?: () => number;
}

export function makeRealLifeInviteProvider(opts: RealLifeInviteProviderOptions = {}): ContinuationProvider {
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? DEFAULT_PRIORITY;

  return {
    key: REAL_LIFE_INVITE_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return { providerKey: REAL_LIFE_INVITE_PROVIDER_KEY, status: 'skipped', latencyMs: 0, reason: 'no_inputs' };
      }

      const flag = await getSystemControl(REAL_LIFE_INVITE_FLAG).catch(() => null);
      if (!flag || !flag.enabled) {
        return {
          providerKey: REAL_LIFE_INVITE_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'flag_disabled',
        };
      }

      const strongestPillar = await fetchStrongestPillar(inputs.supabase, inputs.userId);
      const dateKey = new Date(now()).toISOString().slice(0, 10);
      const focus = pickInviteActivity({ strongestPillar, dateKey });
      const userFacingLine = buildInviteProposal(inputs.lang, focus);

      const candidate: AssistantContinuation = {
        id: `real-life-invite-${newId()}`,
        surface: 'orb_wake',
        kind: 'check_in',
        priority,
        userFacingLine,
        // BENIGN cta — speaks only. Carries the activity as DATA so a future
        // invite/referral slice can pick it up; performs no action now.
        cta: {
          type: 'offer_demo',
          payload: { invite_activity: focus.activity.key, strongest_pillar: strongestPillar ?? undefined },
        },
        evidence: [{ kind: 'real_life_invite', detail: `${focus.activity.key}:${strongestPillar ?? 'default'}` }],
        dedupeKey: focus.nudgeKey,
        privacyMode: 'safe_to_speak',
      };

      console.log(
        `[REAL-LIFE-INVITE] user=${inputs.userId.slice(0, 8)} lang=${inputs.lang} activity=${focus.activity.key} pillar=${strongestPillar ?? 'default'}`,
      );

      return {
        providerKey: REAL_LIFE_INVITE_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs + fetcher (fail-open)
// ---------------------------------------------------------------------------

function readInputs(ctx: ContinuationDecisionContext): RealLifeInviteInputs | null {
  const raw = (ctx.extra as Record<string, unknown> | undefined)?.[REAL_LIFE_INVITE_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const supabase = o.supabase;
  if (!supabase || typeof supabase !== 'object' || typeof (supabase as { from?: unknown }).from !== 'function') {
    return null;
  }
  if (typeof o.tenantId !== 'string' || !o.tenantId) return null;
  if (typeof o.userId !== 'string' || !o.userId) return null;
  return {
    supabase: supabase as SupabaseClient,
    tenantId: o.tenantId,
    userId: o.userId,
    lang: typeof o.lang === 'string' && o.lang ? o.lang : 'en',
    firstName: typeof o.firstName === 'string' && o.firstName.trim() ? o.firstName : null,
  };
}

/** Best-effort read of the user's strongest pillar from the Index snapshot. */
async function fetchStrongestPillar(supabase: SupabaseClient, userId: string): Promise<PillarKey | null> {
  try {
    const snap = await fetchVitanaIndexForProfiler(supabase, userId);
    const name = (snap as { strongest_pillar?: { name?: unknown } } | null)?.strongest_pillar?.name;
    if (typeof name === 'string' && PILLAR_KEYS.includes(name as PillarKey)) return name as PillarKey;
    return null;
  } catch {
    return null;
  }
}
