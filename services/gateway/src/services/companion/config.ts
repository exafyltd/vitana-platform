/**
 * VTID-05099 — Vitana Companion Messages: which mode the engine runs in,
 * decided in one place (same shape as the onboarding coach, VTID-04892).
 *
 *   disabled-on-staging  the staging gateway never runs the engine: staging
 *                        and production share one database, so a staging run
 *                        would write ledger rows (and later DMs) for real members.
 *   off                  FEATURE_COMPANION_MESSAGES_ENV is not live here, or
 *                        COMPANION_MODE is unset / 'off'.
 *   shadow               decide and record what Vitana would write; send nothing.
 *   staff                (VTID-05100) send the DM + push to exafy staff/admin
 *                        members only; everyone else keeps the shadow behaviour.
 *   live                 (VTID-05100) send to every eligible member.
 *
 * Sending is OFF unless a second, explicit switch says otherwise:
 * COMPANION_MODE=staff|live without COMPANION_SEND_ENABLED=true is reported as
 * `send_not_available` and the engine still runs in shadow (Phase 1 behaviour).
 */
import { isStaging as runningOnStaging } from '../../env';
import { isFeatureLive } from '../feature-flags';

export type CompanionMode = 'disabled-on-staging' | 'off' | 'shadow' | 'staff' | 'live';

/** Modes that deliver a real DM + push. */
export function isSendMode(mode: CompanionMode): mode is 'staff' | 'live' {
  return mode === 'staff' || mode === 'live';
}

export interface CompanionConfig {
  mode: CompanionMode;
  reason: string;
  /** Local delivery window, minutes after local midnight: [start, end). */
  windowStartMin: number;
  windowEndMin: number;
  /** Max full LLM compositions per local day while in shadow (sparring F5). */
  shadowComposeLimit: number;
  /** Bedrock models: primary and fallback. Never a non-Bedrock provider. */
  model: string;
  fallbackModel: string;
}

export const COMPANION_FEATURE = 'COMPANION_MESSAGES';

// Both measured invokable on this account (backend.md §2b, 2026-08-10).
export const DEFAULT_COMPANION_MODEL = 'eu.anthropic.claude-sonnet-4-6';
export const DEFAULT_COMPANION_FALLBACK_MODEL = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';

const DEFAULT_WINDOW_START = 7 * 60 + 30; // 07:30
const DEFAULT_WINDOW_END = 9 * 60 + 30; // 09:30
const DEFAULT_SHADOW_COMPOSE_LIMIT = 20;

function parseHhMm(raw: string | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw ?? '').trim());
  if (!m) return fallback;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 24 * 60 ? v : fallback;
}

function parseLimit(raw: string | undefined): number {
  const t = (raw ?? '').trim();
  if (t === '') return DEFAULT_SHADOW_COMPOSE_LIMIT;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SHADOW_COMPOSE_LIMIT;
}

export function resolveCompanionConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { isStaging?: boolean; featureLive?: boolean } = {},
): CompanionConfig {
  let windowStartMin = parseHhMm(env.COMPANION_WINDOW_START, DEFAULT_WINDOW_START);
  let windowEndMin = parseHhMm(env.COMPANION_WINDOW_END, DEFAULT_WINDOW_END);
  if (windowEndMin <= windowStartMin) {
    windowStartMin = DEFAULT_WINDOW_START;
    windowEndMin = DEFAULT_WINDOW_END;
  }
  const common = {
    windowStartMin,
    windowEndMin,
    shadowComposeLimit: parseLimit(env.COMPANION_SHADOW_COMPOSE_LIMIT),
    model: (env.COMPANION_MODEL ?? '').trim() || DEFAULT_COMPANION_MODEL,
    fallbackModel: (env.COMPANION_FALLBACK_MODEL ?? '').trim() || DEFAULT_COMPANION_FALLBACK_MODEL,
  };

  const staging = opts.isStaging ?? runningOnStaging;
  if (staging) return { mode: 'disabled-on-staging', reason: 'staging_shares_production_database', ...common };

  const live = opts.featureLive ?? isFeatureLive(COMPANION_FEATURE);
  if (!live) return { mode: 'off', reason: 'feature_off', ...common };

  const requested = (env.COMPANION_MODE ?? 'off').trim().toLowerCase();
  if (requested === 'shadow') return { mode: 'shadow', reason: 'shadow', ...common };
  if (requested === 'staff' || requested === 'live') {
    // VTID-05100: a sending mode needs its own explicit switch, on top of the mode.
    if ((env.COMPANION_SEND_ENABLED ?? '').trim() !== 'true') {
      return { mode: 'shadow', reason: 'send_not_available', ...common };
    }
    return { mode: requested, reason: requested, ...common };
  }
  return { mode: 'off', reason: 'mode_off', ...common };
}
