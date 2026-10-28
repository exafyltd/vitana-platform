/**
 * VTID-05205 — team welcome DMs (Mariia, Jovana, Alex Blue): every setting in
 * one place. Plan: .kiro/specs/new-member-welcome/plan-sparring.md, Part A.
 *
 * Modes (same shape as onboarding-coach/config.ts and companion/config.ts):
 *   disabled-on-staging  the staging gateway never runs the tick: staging and
 *                        production share one database, so a staging run would
 *                        DM real members.
 *   off                  FEATURE_WELCOME_TEAM_ENV is not live here, WELCOME_TEAM_MODE
 *                        is unset/'off', or the rollout timestamp is missing.
 *   shadow               decide who would get which welcome; write nothing.
 *   live                 send. Needs, on top of WELCOME_TEAM_MODE=live:
 *                          WELCOME_TEAM_SEND_ENABLED=true        (explicit send switch)
 *                          WELCOME_SENDER_NAMES_CONFIRMED=true   (S6 pre-flight: the three
 *                                                                 senders' display names
 *                                                                 are what newcomers should see)
 *                        Missing either one ⇒ shadow, with the reason saying which.
 *
 * Audience: closed pilot by default. Until WELCOME_TEAM_AUDIENCE=all, a welcome
 * goes only to members in WELCOME_TEAM_PILOT_USER_IDS; an empty or missing
 * allowlist in pilot mode sends to nobody (fails closed).
 *
 * Cohort (S5): members whose primary membership was created at or after
 * WELCOME_ROLLOUT_AT. Set it to the moment the mode is flipped to live, so
 * nobody who registered earlier — including during the S6 delay — is messaged.
 */
import { isStaging as runningOnStaging } from '../../env';
import { isFeatureLive } from '../feature-flags';

export type WelcomeTeamMode = 'disabled-on-staging' | 'off' | 'shadow' | 'live';
export type WelcomeSenderSlug = 'mariia' | 'jovana' | 'alex';

export interface WelcomeSender {
  slug: WelcomeSenderSlug;
  userId: string;
  /** Days after the member's registration before this welcome is due. */
  staggerDays: number;
}

export interface WelcomeTeamConfig {
  mode: WelcomeTeamMode;
  reason: string;
  rolloutAt: Date | null;
  senders: WelcomeSender[];
  /** Only members whose primary tenant is this one get the welcomes (the senders' community). */
  tenantId: string;
  audience: 'pilot' | 'all';
  pilotUserIds: Set<string>;
  /** Minimum hours between two welcomes to the same member (never two on one day). */
  minGapHours: number;
  /** At most this many DMs per tick invocation. */
  maxSendsPerTick: number;
  /** Locales whose welcome texts passed the locale review; any other locale gets 'en'. */
  readyLocales: Set<string>;
}

export const WELCOME_TEAM_FEATURE = 'WELCOME_TEAM';

/** Verified read-only 2026-10-15 (plan, Part A). Overridable per env var. */
export const DEFAULT_SENDER_IDS: Record<WelcomeSenderSlug, string> = {
  mariia: '67c971fc-48f3-49ce-aaa8-cddb6fa9e63a', // @mariia04
  jovana: 'c7d3260d-8311-4a0b-ab1c-53928a37caec', // @jovana4
  alex: '0adc6ff6-acb0-4dca-99d0-295211a40e3e', // @dragan1 — Alex Blue, a real person
};
export const DEFAULT_STAGGER_DAYS: Record<WelcomeSenderSlug, number> = { mariia: 0, jovana: 1, alex: 2 };
/** MAXINA — the three senders' primary tenant (read-only check 2026-10-15). */
export const DEFAULT_WELCOME_TENANT_ID = '2e7528b8-472a-4356-88da-0280d4639cce';
export const DEFAULT_MIN_GAP_HOURS = 20;
export const DEFAULT_MAX_SENDS_PER_TICK = 25;
export const DEFAULT_READY_LOCALES = ['de', 'en'];

const SLUGS: WelcomeSenderSlug[] = ['mariia', 'jovana', 'alex'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function envKey(prefix: string, slug: WelcomeSenderSlug): string {
  return `${prefix}_${slug.toUpperCase()}`;
}

function parseUuid(raw: string | undefined, fallback: string): string {
  const t = (raw ?? '').trim().toLowerCase();
  return UUID.test(t) ? t : fallback;
}

function parseNonNegInt(raw: string | undefined, fallback: number): number {
  const t = (raw ?? '').trim();
  if (t === '') return fallback;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function parseIdList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => UUID.test(s)),
  );
}

function parseRolloutAt(raw: string | undefined): Date | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function resolveWelcomeTeamConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { isStaging?: boolean; featureLive?: boolean } = {},
): WelcomeTeamConfig {
  const senders: WelcomeSender[] = SLUGS.map((slug) => ({
    slug,
    userId: parseUuid(env[envKey('WELCOME_SENDER', slug) + '_ID'], DEFAULT_SENDER_IDS[slug]),
    staggerDays: parseNonNegInt(env[envKey('WELCOME_STAGGER_DAYS', slug)], DEFAULT_STAGGER_DAYS[slug]),
  }));
  const ready = parseLocaleList(env.WELCOME_TEAM_READY_LOCALES);
  const common = {
    senders,
    tenantId: parseUuid(env.WELCOME_TEAM_TENANT_ID, DEFAULT_WELCOME_TENANT_ID),
    audience: (env.WELCOME_TEAM_AUDIENCE ?? '').trim().toLowerCase() === 'all' ? ('all' as const) : ('pilot' as const),
    pilotUserIds: parseIdList(env.WELCOME_TEAM_PILOT_USER_IDS),
    minGapHours: parseNonNegInt(env.WELCOME_TEAM_MIN_GAP_HOURS, DEFAULT_MIN_GAP_HOURS),
    maxSendsPerTick: parseNonNegInt(env.WELCOME_TEAM_MAX_SENDS_PER_TICK, DEFAULT_MAX_SENDS_PER_TICK),
    readyLocales: ready.size > 0 ? ready : new Set(DEFAULT_READY_LOCALES),
  };

  const staging = opts.isStaging ?? runningOnStaging;
  if (staging) return { mode: 'disabled-on-staging', reason: 'staging_shares_production_database', rolloutAt: null, ...common };

  const live = opts.featureLive ?? isFeatureLive(WELCOME_TEAM_FEATURE);
  if (!live) return { mode: 'off', reason: 'feature_off', rolloutAt: null, ...common };

  const rolloutAt = parseRolloutAt(env.WELCOME_ROLLOUT_AT);
  if (!rolloutAt) return { mode: 'off', reason: 'rollout_at_missing', rolloutAt: null, ...common };

  const requested = (env.WELCOME_TEAM_MODE ?? 'off').trim().toLowerCase();
  if (requested === 'shadow') return { mode: 'shadow', reason: 'shadow', rolloutAt, ...common };
  if (requested === 'live') {
    if ((env.WELCOME_TEAM_SEND_ENABLED ?? '').trim() !== 'true') {
      return { mode: 'shadow', reason: 'send_not_available', rolloutAt, ...common };
    }
    if ((env.WELCOME_SENDER_NAMES_CONFIRMED ?? '').trim() !== 'true') {
      return { mode: 'shadow', reason: 'sender_names_not_confirmed', rolloutAt, ...common };
    }
    return { mode: 'live', reason: 'live', rolloutAt, ...common };
  }
  return { mode: 'off', reason: 'mode_off', rolloutAt, ...common };
}

function parseLocaleList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[a-z]{2}$/.test(s)),
  );
}

/** What the status endpoint may show: the mode and the switches, never a member id. */
export function publicStatus(config: WelcomeTeamConfig) {
  return {
    mode: config.mode,
    reason: config.reason,
    audience: config.audience,
    rollout_at: config.rolloutAt ? config.rolloutAt.toISOString() : null,
    stagger_days: Object.fromEntries(config.senders.map((s) => [s.slug, s.staggerDays])),
    ready_locales: [...config.readyLocales].sort(),
  };
}
