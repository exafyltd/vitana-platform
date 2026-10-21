/**
 * B0b (orb-live-refactor): conflict resolution for context sources.
 *
 * When two sources disagree about the same fact (e.g. envelope says
 * timezone=Europe/Berlin, `app_users.timezone` says America/Los_Angeles),
 * the truth-policy decides which one wins and why.
 *
 * For B0b the policy is **deliberately small** — it covers timezone,
 * privacyMode, and language. Each rule documents *why* the chosen
 * source wins. The match-journey provider isn't a source of these
 * fields, so no match-specific truth policy rule exists yet.
 *
 * The function is **pure** — no DB reads, no IO. The compiler calls it
 * with raw candidate values; the policy returns the winner + a warning
 * to surface on the Command Hub.
 */

import type { ClientContextEnvelope } from './client-context-envelope';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface TruthPolicyInput {
  /** Most recent value from the live envelope (per-session truth). */
  envelope: ClientContextEnvelope | null;

  /** Value loaded from `app_users` or `memory_facts` (long-term truth). */
  stored?: {
    timezone?: string;
    privacyMode?: 'private' | 'shared_device' | 'unknown';
    lang?: string;
  };
}

export interface TruthPolicyResolution {
  timezone: string | null;
  privacyMode: 'private' | 'shared_device' | 'unknown';
  lang: string | null;
  /** Conflicts that the policy resolved — surfaced on the source-health panel. */
  conflicts: ReadonlyArray<{
    field: 'timezone' | 'privacyMode' | 'lang';
    envelopeValue: string | null;
    storedValue: string | null;
    winner: 'envelope' | 'stored';
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Resolve which source wins on each per-session vs per-user field.
 *
 * **Default rule:** the **envelope wins** for in-session signals
 * (timezone, privacyMode, lang). The user is *here* now, on this device.
 * Stored values are fallbacks for cold-start (envelope absent) and
 * cross-session continuity (envelope present but missing the field).
 *
 * The one exception (added when the concierge ships): if `privacyMode`
 * is `shared_device` from EITHER source, it sticks. Privacy escalations
 * are sticky on purpose.
 */
type Conflict = TruthPolicyResolution['conflicts'][number];

export function resolveTruth(input: TruthPolicyInput): TruthPolicyResolution {
  const conflicts: Conflict[] = [];

  // ---- timezone ----
  let timezone: string | null = null;
  const envTz = input.envelope?.timezone ?? null;
  const stTz = input.stored?.timezone ?? null;
  if (envTz && stTz && envTz !== stTz) {
    conflicts.push({
      field: 'timezone',
      envelopeValue: envTz,
      storedValue: stTz,
      winner: 'envelope',
      reason: 'in-session signal wins for transient state',
    });
    timezone = envTz;
  } else {
    timezone = envTz ?? stTz ?? null;
  }

  // ---- privacyMode ----
  const envPriv = input.envelope?.privacyMode;
  const stPriv = input.stored?.privacyMode;
  let privacyMode: 'private' | 'shared_device' | 'unknown' = 'unknown';
  // Privacy escalation rule: shared_device sticks regardless of source.
  if (envPriv === 'shared_device' || stPriv === 'shared_device') {
    privacyMode = 'shared_device';
    if (envPriv && stPriv && envPriv !== stPriv) {
      conflicts.push({
        field: 'privacyMode',
        envelopeValue: envPriv,
        storedValue: stPriv,
        winner: envPriv === 'shared_device' ? 'envelope' : 'stored',
        reason: 'privacy escalation sticks',
      });
    }
  } else if (envPriv) {
    privacyMode = envPriv;
  } else if (stPriv) {
    privacyMode = stPriv;
  }

  // ---- lang ----
  let lang: string | null = null;
  const envLang = (input.envelope as any)?.lang ?? null; // envelope doesn't carry lang today; placeholder
  const stLang = input.stored?.lang ?? null;
  if (envLang && stLang && envLang !== stLang) {
    conflicts.push({
      field: 'lang',
      envelopeValue: envLang,
      storedValue: stLang,
      winner: 'envelope',
      reason: 'user selected this language THIS session',
    });
    lang = envLang;
  } else {
    lang = envLang ?? stLang ?? null;
  }

  return {
    timezone,
    privacyMode,
    lang,
    conflicts: Object.freeze(conflicts),
  };
}
