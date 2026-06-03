/**
 * R6 (BOOTSTRAP-ORB-R6R7-PROVIDERS) — First-time-welcome continuation provider.
 *
 * Fires EXACTLY ONCE per user — on the very first orb session ever, when
 * `user_journey.is_first_session === true`. Wins priority 95, above every
 * other turn-1 producer (goal-completion-inquiry 92, new-day-return 90,
 * Teacher 85, voice-wake-brief 80). This is the one-time onboarding moment:
 * Vitana introduces herself, names the 90-day default starter plan, and
 * invites the user to set their first goal.
 *
 * Trigger contract (plan §2.2 — "First-ever session"):
 *   user_journey.is_first_session === true
 *
 * NOT triggered:
 *   - Returning users (is_first_session=false → new-day-return / Teacher /
 *     wake-brief own those states).
 *   - Anonymous sessions (no user_id → no identity → wake-brief at 80).
 *   - Sessions with no supabase client (can't read/flip the flag).
 *
 * Side-effect on selection (plan R6): after firing, flips
 * `is_first_session = false` so the welcome NEVER fires twice. We stamp it
 * fire-and-forget from inside produce() — same pattern new-day-return uses
 * for last_session_date. Even if another provider somehow out-ranks this
 * one in the ranker (none does at 95), stamping is correct: the user HAS
 * now opened the orb for the first time. The flag is also independently
 * cleared at session-end by user-journey-service.updateSessionEndState
 * (clear_first_session) — this is defense-in-depth, not the sole writer.
 *
 * Architecture note: returns a server-composed `userFacingLine` for the
 * wake-brief Say-exactly pattern, identical to voice-wake-brief /
 * new-day-return. No new prompt block, no system-instruction concat. The
 * ranker picks this at 95 and the controller speaks the line. Transport-
 * agnostic: the ranker is shared by Vertex (live-session-controller) and
 * LiveKit (orb-livekit), so both transports get the welcome for free.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ContinuationDecisionContext,
  ContinuationProvider,
  ProviderResult,
  AssistantContinuation,
} from '../../types';
import { renderFirstTimeWelcomeLine } from './content';

export const FIRST_TIME_WELCOME_PROVIDER_KEY = 'first_time_welcome' as const;
export const FIRST_TIME_WELCOME_EXTRA_KEY = 'firstTimeWelcome' as const;

/** Highest turn-1 priority. Above goal-completion-inquiry (92),
 *  new-day-return (90), Teacher (85), voice-wake-brief (80). The
 *  first-ever session is the one moment that out-ranks everything. */
export const FIRST_TIME_WELCOME_PRIORITY = 95;

export interface FirstTimeWelcomeInputs {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string;
  lang: string;
  firstName: string | null;
}

export interface FirstTimeWelcomeProviderOptions {
  newId?: () => string;
  now?: () => number;
  priority?: number;
}

interface UserJourneyRow {
  is_first_session: boolean;
}

function readInputs(ctx: ContinuationDecisionContext): FirstTimeWelcomeInputs | null {
  const extra = ctx.extra;
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[FIRST_TIME_WELCOME_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.userId !== 'string' || o.userId.length === 0) return null;
  if (typeof o.tenantId !== 'string' || o.tenantId.length === 0) return null;
  if (!o.supabase) return null;
  return {
    supabase: o.supabase as SupabaseClient,
    userId: o.userId,
    tenantId: o.tenantId,
    lang: typeof o.lang === 'string' && o.lang.length > 0 ? o.lang : 'en',
    firstName:
      typeof o.firstName === 'string' && o.firstName.length > 0 ? o.firstName : null,
  };
}

/**
 * Fire-and-forget DB write: flip user_journey.is_first_session to false
 * so the welcome never fires a second time. Never throws. Logs on failure.
 */
async function clearFirstSession(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('user_journey')
      .update({ is_first_session: false })
      .eq('user_id', userId);
    if (error) {
      console.warn(
        `[R6 first-time-welcome] clearFirstSession failed for ${userId.slice(0, 8)}: ${error.message}`,
      );
    }
  } catch (err) {
    console.warn(
      `[R6 first-time-welcome] clearFirstSession threw for ${userId.slice(0, 8)}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function makeFirstTimeWelcomeProvider(
  opts: FirstTimeWelcomeProviderOptions = {},
): ContinuationProvider {
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? FIRST_TIME_WELCOME_PRIORITY;

  return {
    key: FIRST_TIME_WELCOME_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return {
          providerKey: FIRST_TIME_WELCOME_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_first_time_welcome_inputs',
        };
      }

      // ---- DB fetch: user_journey row ----
      let row: UserJourneyRow | null = null;
      try {
        const { data, error } = await inputs.supabase
          .from('user_journey')
          .select('is_first_session')
          .eq('user_id', inputs.userId)
          .maybeSingle();
        if (error) {
          return {
            providerKey: FIRST_TIME_WELCOME_PROVIDER_KEY,
            status: 'errored',
            latencyMs: Math.max(0, now() - t0),
            reason: `user_journey_fetch_failed: ${error.message}`,
          };
        }
        row = (data ?? null) as UserJourneyRow | null;
      } catch (err) {
        return {
          providerKey: FIRST_TIME_WELCOME_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      // Only fire on the first-ever session. Every other state belongs to
      // new-day-return / goal-completion-inquiry / Teacher / wake-brief.
      // No row at all → treat as NOT first-session (a returning user whose
      // journey row was never written shouldn't get a welcome here).
      if (!row || row.is_first_session !== true) {
        return {
          providerKey: FIRST_TIME_WELCOME_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: row ? 'is_first_session_false' : 'no_user_journey_row',
        };
      }

      const line = renderFirstTimeWelcomeLine({
        lang: inputs.lang,
        firstName: inputs.firstName,
      });
      if (!line || line.trim().length === 0) {
        return {
          providerKey: FIRST_TIME_WELCOME_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: 'renderer_produced_empty_line',
        };
      }

      // Fire-and-forget flip so the welcome never repeats. Safe to do
      // before the candidate is selected — at priority 95 it always wins,
      // and even if it didn't, the user HAS opened the orb for the first
      // time, so clearing the flag is correct.
      void clearFirstSession(inputs.supabase, inputs.userId);

      const candidate: AssistantContinuation = {
        id: `first-time-welcome-${newId()}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority,
        userFacingLine: line,
        // Invites the user to set their first goal — confirming routes
        // into the Life Compass setup flow. Same flow goal-completion-
        // inquiry uses on confirmation. The model interprets a "yes" /
        // a stated goal and proceeds conversationally; the navigate CTA
        // is the deterministic fallback target.
        cta: {
          type: 'navigate',
          route: '/life-compass',
          payload: { intent: 'first_goal' },
        },
        evidence: [
          { kind: 'first_time_welcome', detail: 'is_first_session_true' },
          { kind: 'default_plan', detail: '90_day_starter' },
        ],
        // Dedupe: one welcome per user, ever. The is_first_session flip is
        // the real one-time guard; this key keeps the same logical
        // continuation stable across re-renders of the same session.
        dedupeKey: `first-time-welcome:${inputs.userId}`,
        privacyMode: 'safe_to_speak',
      };

      return {
        providerKey: FIRST_TIME_WELCOME_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}
