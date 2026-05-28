/**
 * VTID-03164 — New-day-return continuation provider (Slice 1).
 *
 * Fires the FIRST orb session of a new calendar day in the user's local
 * timezone. Wins priority 90 — above Teacher (85) and voice-wake-brief
 * (80). When this provider returns a candidate, Teacher and wake-brief
 * lose the ranker and Vitana opens with a warm "good {morning/afternoon/
 * evening}" greeting rather than a Teacher capability-introduction jump.
 *
 * Trigger contract:
 *   user_journey.last_session_date < today_in_user_tz
 *   OR user_journey.last_session_date IS NULL (and is_first_session=false)
 *
 * NOT triggered:
 *   - Same-day repeat sessions (last_session_date === today)
 *   - User's very first session ever (is_first_session=true → that's the
 *     one-time-welcome territory, deferred to a future slice)
 *   - Anonymous sessions (no user_id)
 *   - Sessions with no timezone information
 *
 * Slice 1 content: salutation per local hour + name (when known) + ONE
 * open question. No overnight overview yet — that's Slice 2 (calendar
 * events / reminders / Index delta / today's plan).
 *
 * Architecture note: this provider returns a server-composed
 * `userFacingLine` for the wake-brief Say-exactly pattern. Same path
 * the Teacher / voice-wake-brief use. No new block, no system-instruction
 * concat tricks, no post-hoc clearing of other blocks. The ranker picks
 * this at 90 > 85 (Teacher) and Vitana speaks the line. Clean.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ContinuationDecisionContext,
  ContinuationProvider,
  ProviderResult,
  AssistantContinuation,
} from '../types';
import {
  aggregateNewDayOverview,
  formatHhmmInTz,
  EMPTY_OVERVIEW,
  type NewDayOverviewPayload,
} from './new-day-overview-aggregator';

export const NEW_DAY_RETURN_PROVIDER_KEY = 'new_day_return';
export const NEW_DAY_RETURN_EXTRA_KEY = 'newDayReturn' as const;

/** Priority above Teacher (85) and voice-wake-brief (80). Below the
 *  urgent next-action bands (95+ reminder) so a time-sensitive reminder
 *  still pre-empts the new-day greeting. */
const DEFAULT_PRIORITY = 90;

export interface NewDayReturnInputs {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string;
  lang: string;
  firstName: string | null;
  /** IANA timezone from clientContext.timezone. Provider suppresses when missing. */
  timezone: string | null;
}

export interface NewDayReturnProviderOptions {
  newId?: () => string;
  now?: () => number;
  priority?: number;
  rng?: () => number;
}

interface UserJourneyRow {
  last_session_date: string | null; // YYYY-MM-DD in user TZ
  is_first_session: boolean;
}

/** Compute YYYY-MM-DD in a given IANA TZ. Falls back to UTC on invalid TZ. */
export function todayInTimezone(now: Date, timezone: string | null): string {
  if (timezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return fmt.format(now);
    } catch {
      // fall through
    }
  }
  return now.toISOString().slice(0, 10);
}

/** Local hour [0-23] in a given IANA TZ. Falls back to UTC on invalid TZ. */
export function localHourInTimezone(now: Date, timezone: string | null): number {
  if (timezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        hourCycle: 'h23',
      });
      const parts = fmt.formatToParts(now);
      const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
      const hour = parseInt(hourStr, 10);
      if (Number.isFinite(hour) && hour >= 0 && hour <= 23) return hour;
    } catch {
      // fall through
    }
  }
  return now.getUTCHours();
}

export type SalutationKind = 'morning' | 'afternoon' | 'evening';

/** Map a local hour to one of three salutation buckets. Pure. */
export function pickSalutationKind(localHour: number): SalutationKind {
  if (localHour < 5) return 'evening'; // very early hours read as "evening of yesterday"
  if (localHour < 12) return 'morning';
  if (localHour < 18) return 'afternoon';
  return 'evening';
}

// Pools intentionally vary phrasing per call so the daily greeting does
// not repeat the same opening word-for-word every day. Each entry is a
// complete sentence; the provider picks one at random via the injected rng.
// Naming a single pool per (lang × salutation × name-present) keeps the
// branching explicit and avoids surprise interpolation bugs.

const GREETING_POOLS: Record<
  string,
  Record<SalutationKind, { withName: string[]; withoutName: string[] }>
> = {
  de: {
    morning: {
      withName: [
        'Guten Morgen, {name}! Schön, dass du wieder da bist. Womit darf ich dir heute helfen?',
        'Guten Morgen, {name} — schön, dich zu hören. Was steht heute bei dir an?',
        'Hallo {name}, einen schönen guten Morgen. Womit kann ich dich heute begleiten?',
      ],
      withoutName: [
        'Guten Morgen! Schön, dass du wieder da bist. Womit darf ich dir heute helfen?',
        'Guten Morgen — schön, dich zu hören. Was steht heute bei dir an?',
      ],
    },
    afternoon: {
      withName: [
        'Guten Tag, {name}! Schön, dass du wieder vorbeischaust. Womit darf ich dir helfen?',
        'Hallo {name} — schön, dich zu hören. Was steht heute noch bei dir an?',
        'Schönen Nachmittag, {name}. Womit kann ich dich heute unterstützen?',
      ],
      withoutName: [
        'Guten Tag! Schön, dass du wieder vorbeischaust. Womit darf ich dir helfen?',
        'Schönen Nachmittag — was steht bei dir an?',
      ],
    },
    evening: {
      withName: [
        'Guten Abend, {name}! Schön, dich am Abend zu hören. Womit darf ich dir helfen?',
        'Hallo {name}, einen schönen Abend. Was beschäftigt dich heute noch?',
        'Schönen Abend, {name}. Womit kann ich dich heute unterstützen?',
      ],
      withoutName: [
        'Guten Abend! Schön, dich zu hören. Womit darf ich dir helfen?',
        'Schönen Abend — was beschäftigt dich heute noch?',
      ],
    },
  },
  en: {
    morning: {
      withName: [
        'Good morning, {name}! Lovely to hear from you. How can I help you today?',
        'Morning, {name} — good to have you back. What is on your plate today?',
        'Good morning, {name}. Where would you like to start today?',
      ],
      withoutName: [
        'Good morning! Lovely to hear from you. How can I help you today?',
        'Morning — good to have you back. What is on your plate today?',
      ],
    },
    afternoon: {
      withName: [
        'Good afternoon, {name}! Glad you stopped by. How can I help you?',
        'Hello {name} — good to hear from you. What is on your mind this afternoon?',
        'Afternoon, {name}. Where would you like to pick up?',
      ],
      withoutName: [
        'Good afternoon! Glad you stopped by. How can I help you?',
        'Afternoon — what is on your mind?',
      ],
    },
    evening: {
      withName: [
        'Good evening, {name}! Nice to hear from you this evening. How can I help?',
        'Hello {name}, hope your day was kind. What is still on your mind?',
        'Evening, {name}. Where would you like to land today?',
      ],
      withoutName: [
        'Good evening! Nice to hear from you this evening. How can I help?',
        'Evening — what is still on your mind?',
      ],
    },
  },
};

function pickFromPool(pool: string[], rng: () => number): string {
  if (pool.length === 0) return '';
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[idx];
}

/**
 * Pure renderer for the spoken line. Exported for tests.
 * Lang fallback chain: requested lang → 'en' → empty string.
 */
export function renderNewDayReturnLine(
  args: { lang: string; salutation: SalutationKind; firstName: string | null },
  rng: () => number = Math.random,
): string {
  const langPool = GREETING_POOLS[args.lang] ?? GREETING_POOLS.en;
  const slot = args.firstName ? langPool[args.salutation].withName : langPool[args.salutation].withoutName;
  const template = pickFromPool(slot, rng);
  if (!template) return '';
  return args.firstName ? template.replace('{name}', args.firstName) : template;
}

// ---------------------------------------------------------------------------
// VTID-03166 — Slice 2 overview-aware renderer.
//
// Composes a 3-5 sentence line that includes the structured overview
// payload (calendar deltas + Vitana Index + Life Compass). When the
// payload is empty (no data could be fetched), falls back to the Slice
// 1 minimal greeting so the user always gets a coherent line. Each
// clause is short, natural, and only emitted when the underlying data
// is actually present — no padding, no hallucinated content.
// ---------------------------------------------------------------------------

interface OverviewRenderArgs {
  lang: string;
  salutation: SalutationKind;
  firstName: string | null;
  timezone: string;
  payload: NewDayOverviewPayload;
}

/** Compose a "since we last spoke" clause from passed calendar events. */
function buildPassedClause(payload: NewDayOverviewPayload, lang: string, timezone: string): string {
  if (!payload.calendar_passed_notable || payload.calendar_passed_count === 0) return '';
  const title = payload.calendar_passed_notable.title;
  const hhmm = formatHhmmInTz(payload.calendar_passed_notable.start_iso, timezone);
  if (lang === 'de') {
    return payload.calendar_passed_count > 1
      ? `Seit unserem letzten Gespräch hattest du ${payload.calendar_passed_count} Termine, zuletzt "${title}" um ${hhmm}.`
      : `Seit unserem letzten Gespräch hattest du "${title}" um ${hhmm}.`;
  }
  return payload.calendar_passed_count > 1
    ? `Since we last spoke you had ${payload.calendar_passed_count} events; the most recent was "${title}" at ${hhmm}.`
    : `Since we last spoke you had "${title}" at ${hhmm}.`;
}

/** Compose a "today" clause from upcoming calendar events. */
function buildTodayClause(payload: NewDayOverviewPayload, lang: string, timezone: string): string {
  if (!payload.calendar_today_next || payload.calendar_today_count === 0) return '';
  const title = payload.calendar_today_next.title;
  const hhmm = formatHhmmInTz(payload.calendar_today_next.start_iso, timezone);
  if (lang === 'de') {
    return payload.calendar_today_count > 1
      ? `Heute stehen ${payload.calendar_today_count} Termine bei dir an, als Nächstes "${title}" um ${hhmm}.`
      : `Heute steht "${title}" um ${hhmm} bei dir an.`;
  }
  return payload.calendar_today_count > 1
    ? `Today you have ${payload.calendar_today_count} events lined up, next is "${title}" at ${hhmm}.`
    : `Today you have "${title}" at ${hhmm}.`;
}

/** Compose a Vitana Index clause when the trend is material. */
function buildIndexClause(payload: NewDayOverviewPayload, lang: string): string {
  if (payload.vitana_index_today === null) return '';
  // Only mention the index when the 7-day delta is material (>= 10 points either way).
  // Otherwise the clause is noise.
  const trend = payload.vitana_index_trend_7d ?? 0;
  if (Math.abs(trend) < 10) return '';
  if (lang === 'de') {
    return trend > 0
      ? `Dein Vitana Index liegt bei ${payload.vitana_index_today}, ${trend} Punkte mehr als vor einer Woche.`
      : `Dein Vitana Index liegt bei ${payload.vitana_index_today}, ${Math.abs(trend)} Punkte unter der Vorwoche.`;
  }
  return trend > 0
    ? `Your Vitana Index is at ${payload.vitana_index_today}, up ${trend} points from a week ago.`
    : `Your Vitana Index is at ${payload.vitana_index_today}, down ${Math.abs(trend)} points from a week ago.`;
}

/** Compose a Life Compass through-line — only when no other content clauses fired. */
function buildLifeCompassClause(payload: NewDayOverviewPayload, lang: string): string {
  if (!payload.life_compass_goal) return '';
  const goal = payload.life_compass_goal.trim();
  if (!goal) return '';
  if (lang === 'de') return `Dein Fokus bleibt: ${goal}.`;
  return `Your focus stays on: ${goal}.`;
}

/** One open invitation. */
function buildInvitation(lang: string, rng: () => number): string {
  const pool = lang === 'de'
    ? ['Womit fangen wir an?', 'Wo möchtest du heute anknüpfen?', 'Womit darf ich dir helfen?']
    : ['Where would you like to start?', 'Where do you want to pick up?', 'How can I help you today?'];
  return pickFromPool(pool, rng);
}

/**
 * Pure renderer that pulls overview content into the spoken line.
 * Picks clauses by priority and caps total at 3-4 sentences so the
 * greeting stays natural. Exported for tests.
 *
 * Ordering rules:
 *   1. Salutation + name (always)
 *   2. Passed-event clause if present
 *   3. Today's-next clause if present
 *   4. Vitana Index clause if delta is material
 *   5. Life Compass through-line only if NO content clauses fired
 *   6. One open invitation (always)
 *
 * Hard cap: at most 2 content clauses between the salutation and the
 * invitation. Calendar wins over Index when both fire.
 */
export function renderNewDayReturnLineWithOverview(
  args: OverviewRenderArgs,
  rng: () => number = Math.random,
): string {
  // 1. Salutation. Pick a short opening that does NOT include the open
  // question so we can chain the content clauses naturally.
  const greeting = args.firstName
    ? (args.lang === 'de'
        ? `${shortGreetingDe(args.salutation)}, ${args.firstName}.`
        : `${shortGreetingEn(args.salutation)}, ${args.firstName}.`)
    : (args.lang === 'de'
        ? `${shortGreetingDe(args.salutation)}.`
        : `${shortGreetingEn(args.salutation)}.`);

  // 2-4. Pick at most 2 content clauses.
  const passedClause = buildPassedClause(args.payload, args.lang, args.timezone);
  const todayClause = buildTodayClause(args.payload, args.lang, args.timezone);
  const indexClause = buildIndexClause(args.payload, args.lang);
  const contentClauses: string[] = [];
  if (passedClause) contentClauses.push(passedClause);
  if (todayClause) contentClauses.push(todayClause);
  if (contentClauses.length < 2 && indexClause) contentClauses.push(indexClause);

  // 5. Life Compass through-line ONLY when no calendar/index content fired.
  if (contentClauses.length === 0) {
    const lc = buildLifeCompassClause(args.payload, args.lang);
    if (lc) contentClauses.push(lc);
  }

  // 6. Invitation.
  const invitation = buildInvitation(args.lang, rng);

  return [greeting, ...contentClauses, invitation].filter((s) => s.length > 0).join(' ');
}

/** Short greeting (no open question — that comes from buildInvitation). */
function shortGreetingDe(s: SalutationKind): string {
  if (s === 'morning') return 'Guten Morgen';
  if (s === 'afternoon') return 'Guten Tag';
  return 'Guten Abend';
}
function shortGreetingEn(s: SalutationKind): string {
  if (s === 'morning') return 'Good morning';
  if (s === 'afternoon') return 'Good afternoon';
  return 'Good evening';
}

function readInputs(ctx: ContinuationDecisionContext): NewDayReturnInputs | null {
  const extra = ctx.extra;
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[NEW_DAY_RETURN_EXTRA_KEY];
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
    firstName: typeof o.firstName === 'string' && o.firstName.length > 0 ? o.firstName : null,
    timezone: typeof o.timezone === 'string' && o.timezone.length > 0 ? o.timezone : null,
  };
}

/**
 * Fire-and-forget DB write: stamp the user_journey row's last_session_date
 * so same-day repeat sessions don't re-fire the new-day greeting. Never
 * throws. Logs on failure.
 */
async function stampLastSessionDate(
  supabase: SupabaseClient,
  userId: string,
  todayIso: string,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('user_journey')
      .update({ last_session_date: todayIso })
      .eq('user_id', userId);
    if (error) {
      console.warn(
        `[VTID-03164] stampLastSessionDate failed for ${userId.slice(0, 8)}: ${error.message}`,
      );
    }
  } catch (err) {
    console.warn(
      `[VTID-03164] stampLastSessionDate threw for ${userId.slice(0, 8)}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function makeNewDayReturnProvider(
  opts: NewDayReturnProviderOptions = {},
): ContinuationProvider {
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? DEFAULT_PRIORITY;
  const rng = opts.rng ?? Math.random;

  return {
    key: NEW_DAY_RETURN_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return {
          providerKey: NEW_DAY_RETURN_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_new_day_return_inputs',
        };
      }

      // Timezone is required — without it we'd risk firing the wrong day
      // for users near midnight. Better to suppress and let wake-brief
      // win than emit "Good morning" at 9pm local.
      if (!inputs.timezone) {
        return {
          providerKey: NEW_DAY_RETURN_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_timezone',
        };
      }

      // ---- DB fetch: user_journey row ----
      let row: UserJourneyRow | null = null;
      try {
        const { data, error } = await inputs.supabase
          .from('user_journey')
          .select('last_session_date, is_first_session')
          .eq('user_id', inputs.userId)
          .maybeSingle();
        if (error) {
          return {
            providerKey: NEW_DAY_RETURN_PROVIDER_KEY,
            status: 'errored',
            latencyMs: Math.max(0, now() - t0),
            reason: `user_journey_fetch_failed: ${error.message}`,
          };
        }
        row = (data ?? null) as UserJourneyRow | null;
      } catch (err) {
        return {
          providerKey: NEW_DAY_RETURN_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      // Suppress when this user is brand-new (first session ever). A
      // future slice owns the one-time welcome; we should not jump in
      // with a returning-day greeting on day 0.
      if (row && row.is_first_session === true) {
        return {
          providerKey: NEW_DAY_RETURN_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'is_first_session_true',
        };
      }

      const nowDate = new Date(now());
      const todayIso = todayInTimezone(nowDate, inputs.timezone);

      // Same-day repeat: suppress. Lets voice-wake-brief / Teacher take
      // over with their normal cadence-aware logic for a returning user
      // who already spoke today.
      if (row && row.last_session_date && row.last_session_date >= todayIso) {
        return {
          providerKey: NEW_DAY_RETURN_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: `same_day_${row.last_session_date}`,
        };
      }

      // ---- Compose the spoken line ----
      const localHour = localHourInTimezone(nowDate, inputs.timezone);
      const salutation = pickSalutationKind(localHour);

      // VTID-03166: pull overnight overview content (calendar passed +
      // today's events + Vitana Index trend + Life Compass goal). All
      // best-effort — aggregator returns EMPTY_OVERVIEW on full failure
      // and the overview renderer falls back to a clean greeting.
      let overview: NewDayOverviewPayload = EMPTY_OVERVIEW;
      try {
        // Use start of last_session_date in user TZ as the lookback floor.
        // When null, the aggregator defaults to 24h before now.
        const lastSessionAtIso = row?.last_session_date
          ? new Date(`${row.last_session_date}T00:00:00Z`).toISOString()
          : null;
        overview = await aggregateNewDayOverview({
          supabase: inputs.supabase,
          userId: inputs.userId,
          lastSessionAtIso,
          todayDateIso: todayIso,
          timezone: inputs.timezone,
          now: nowDate,
        });
      } catch (err) {
        console.warn(
          `[VTID-03166] overview aggregation failed for ${inputs.userId.slice(0, 8)} (falling back to bare greeting):`,
          err instanceof Error ? err.message : String(err),
        );
      }

      // If the overview has ANY material content, render the enriched
      // line; otherwise fall back to the bare Slice 1 greeting.
      const hasContent =
        overview.calendar_passed_count > 0
        || overview.calendar_today_count > 0
        || overview.vitana_index_today !== null
        || overview.life_compass_goal !== null;

      const line = hasContent
        ? renderNewDayReturnLineWithOverview(
            { lang: inputs.lang, salutation, firstName: inputs.firstName, timezone: inputs.timezone, payload: overview },
            rng,
          )
        : renderNewDayReturnLine(
            { lang: inputs.lang, salutation, firstName: inputs.firstName },
            rng,
          );
      if (line.length === 0) {
        return {
          providerKey: NEW_DAY_RETURN_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: 'renderer_produced_empty_line',
        };
      }

      // Fire-and-forget stamp so same-day repeats don't re-fire. Safe to
      // do before the candidate is selected — if another provider wins
      // the ranker, we've still correctly recorded that the user opened
      // the orb today.
      void stampLastSessionDate(inputs.supabase, inputs.userId, todayIso);

      const candidate: AssistantContinuation = {
        id: `new-day-return-${newId()}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority,
        userFacingLine: line,
        cta: { type: 'explain' },
        evidence: [
          { kind: 'new_day_return', detail: `${todayIso}_${salutation}` },
          { kind: 'last_session_date', detail: row?.last_session_date ?? 'null' },
        ],
        // Dedupe key: one new-day greeting per (user × calendar day).
        // Wake-brief's 60-min wake-brief-emitted cache prevents same-style
        // emission within an hour; this stamps the row directly so even
        // a cold cache won't re-fire.
        dedupeKey: `new-day-return:${todayIso}`,
        privacyMode: 'safe_to_speak',
      };

      return {
        providerKey: NEW_DAY_RETURN_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}
