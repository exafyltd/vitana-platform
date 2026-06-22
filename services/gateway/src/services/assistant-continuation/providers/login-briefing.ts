/**
 * Greeting v2 — Login Briefing continuation provider.
 *
 * The single, always-on, "My Longevity Journey"-centric greeting the user
 * hears after login. Replaces the fragmented behaviour where a returning
 * user got a generic Feature-Discovery pitch ("Lass mich dir eine Entdeckung
 * zeigen") instead of a warm, motivational status check-in on their journey.
 *
 * Design (approved with the product owner):
 *   - Source of truth for "sessions completed / next session" is the
 *     90-session GUIDED JOURNEY curriculum (user_guided_journey_state +
 *     the published journey_checklist), NOT the waves/Foundation models.
 *   - The compliment is EARNED-ONLY: every praise line is tied to a real
 *     number (sessions completed, Vitana Index delta). When there is no
 *     measurable progress yet, the greeting ORIENTS and INVITES — it never
 *     flatters with empty encouragement.
 *   - Time-of-day + name awareness is GUARANTEED here (slot 1). It reuses
 *     the proven timezone-aware salutation logic from new-day-return so the
 *     greeting always opens with "Guten Morgen/Tag/Abend, {name}" regardless
 *     of which journey state fires. (Previously this only existed in
 *     new-day-return, which fires once per calendar day, so it "disappeared"
 *     whenever the Teacher won the ranker.)
 *   - "Speak fast, enrich after": the salutation is always producible from
 *     timezone alone; the journey reads run in parallel and degrade
 *     gracefully (a slow/failed checklist read just drops the next-session
 *     title, never the greeting).
 *
 * State machine (one warm paragraph, slots filled per state):
 *   A — no journey progress + no goal      → orient + invite, NO compliment
 *   B — 1+ sessions, steady                 → "{n} sessions done" + earned praise + next session
 *   C — 1+ sessions, Index up               → adds the real Index delta as the compliment
 *   D — returning after a multi-day gap      → welcoming, "your {n} sessions aren't lost", next session
 *   E — onboarding qualified/completed       → praise mastery, shift to depth
 *   (F same-day reconnect is handled upstream by greetingPolicy='skip' → suppress.)
 *
 * Priority 92: leads journey-guide (91), new-day-return (90), next-action
 * (90), Teacher (85) and wake-brief (80) — so the unified briefing leads the
 * normal login. Ties goal-completion-inquiry (92) and YIELDS to it (it is
 * registered first, so it wins the tie) — a passed goal deadline still leads.
 * Below first-time-welcome (95, first-ever session) and guided-topic-narration
 * (96, explicit tap), which also lead.
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
  localHourInTimezone,
  pickSalutationKind,
  todayInTimezone,
  type SalutationKind,
} from './new-day-return';
import { getJourneyState } from '../../guided-journey/guided-journey-state';
import { getPublishedChecklist } from '../../guided-journey/checklist-service';
import { fetchLifeCompass, fetchVitanaIndexForProfiler } from '../../user-context-profiler';
import { PILLAR_KEYS, type PillarKey } from '../../../lib/vitana-pillars';

export const LOGIN_BRIEFING_PROVIDER_KEY = 'login_briefing';
export const LOGIN_BRIEFING_EXTRA_KEY = 'loginBriefing' as const;

/** Leads journey-guide (91) / new-day-return (90); ties-yields to goal-completion (92). */
const DEFAULT_PRIORITY = 92;

/** A gap of this many calendar days since the last session triggers State D. */
const RETURN_GAP_DAYS = 3;
/** An Index 7-day delta of at least this magnitude is "material" enough to praise. */
const MATERIAL_INDEX_DELTA = 5;
/**
 * A single pillar must drop at least this many points over the week before we
 * surface it as an "understood weakness". Below this it is noise, and flagging
 * it would feel like nagging rather than understanding (VTID-03307 / advice #1).
 */
const MATERIAL_PILLAR_DROP = 3;
/**
 * BOOTSTRAP-ORB-GREETING-RETURNING-USER (fix #2): if the user's previous ORB
 * session was within this window, the fast proactive opener stays silent and
 * lets the wake-brief path handle turn 1 (brief-resume/skip). Mirrors the
 * 15-minute greet-once cap in greeting-policy.ts (RECENT_GREETING_WINDOW_MS).
 */
const FAST_OPENER_GREET_ONCE_WINDOW_MS = 15 * 60 * 1000;

export interface LoginBriefingInputs {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string;
  lang: string;
  firstName: string | null;
  /** IANA timezone from clientContext.timezone. Drives the salutation. */
  timezone: string | null;
  /** From the greeting-policy decision. `skip` → suppress (silent reconnect). */
  greetingPolicy: string;
}

export interface LoginBriefingProviderOptions {
  newId?: () => string;
  now?: () => number;
  priority?: number;
  rng?: () => number;
}

// ---------------------------------------------------------------------------
// State model
// ---------------------------------------------------------------------------

export type BriefingState = 'orient' | 'building' | 'momentum' | 'returning' | 'graduated';

export interface BriefingFacts {
  /** Sessions the user has finished (the ones before the current pointer). */
  sessionsCompleted: number;
  /** The session the user is on / about to do. */
  nextSessionNumber: number;
  /** Title of the next session, when the published checklist resolved it. */
  nextSessionTitle: string | null;
  /**
   * Title of the LAST session the user actually did — the concrete "where we
   * left off" the greeting RECALLS ("last time we were on X"). Null for a user
   * with no completed session yet (then we never claim a recall). Grounds the
   * continuity promise so it is real, not a bluff the user calls.
   */
  lastSessionTitle?: string | null;
  /**
   * Journey-continuation grounding (proactive "where we left off"). The REAL
   * label of the last topic the user opened (`last_opened_topic_id`), and the
   * genuinely-distinct NEXT step — the first curriculum topic they have NOT
   * completed. These let the opener say BOTH "last time we worked on X" AND
   * "the next step is Y" truthfully (X ≠ Y), instead of a vague "continue
   * there". Optional → degrade cleanly to the session-title recall when unknown.
   */
  lastOpenedTitle?: string | null;
  nextStepTitle?: string | null;
  /** Onboarding lifecycle from the guided-journey state. */
  graduated: boolean;
  /** True when the user has set a Life Compass primary goal. */
  hasGoal: boolean;
  /** Material positive Vitana Index 7-day delta, else null. */
  indexDeltaUp: number | null;
  /** Days since the last session (in user TZ), when known. */
  daysSinceLastSession: number | null;
  /**
   * Advice #1 — "understood weakness". A single pillar that dropped this week
   * (name + magnitude of the drop), or null when nothing material slipped.
   * Drives the goal-anchored reversing-step rider. Optional so existing
   * callers/fixtures that predate the signal degrade cleanly to "no weakness".
   */
  weakestPillarDrop?: { pillar: PillarKey; deltaDown: number } | null;
  /**
   * The user's Life Compass primary-goal label. Anchors the weakness to WHY it
   * matters ("because 'more energy' matters to you …"). Null when unset.
   */
  primaryGoalLabel?: string | null;
  /**
   * Advice #2 — visible momentum. How many curriculum topics the user has
   * green-checked and the total in the published journey. Drives the
   * "X of N topics in green — that's P% of your journey" progress beat.
   * Optional → degrades to "no beat" when unknown.
   */
  topicsLearned?: number | null;
  topicsTotal?: number | null;
  /**
   * BOOTSTRAP-ORB-GREETING-RETURNING-USER — true when the user has ANY prior
   * ORB conversation on record (`user_journey.is_first_session === false` OR a
   * non-null `last_session_date`). This is the real "have we met before?"
   * signal. Previously the briefing inferred first-timer status SOLELY from the
   * guided-curriculum pointer (`current_session`), which only advances when the
   * user walks the formal teaching topics — so a member who talks to Vitana
   * conversationally was permanently classified as a first-timer and greeted
   * with the one-time onboarding opener on EVERY session. Optional so existing
   * fixtures/callers degrade cleanly to the old behavior. */
  hasPriorSession?: boolean;
}

/** Pick the state purely from the gathered facts. Exported for tests. */
export function pickBriefingState(f: BriefingFacts): BriefingState {
  if (f.graduated) return 'graduated';
  // BOOTSTRAP-ORB-GREETING-RETURNING-USER: a genuine first-timer is someone we
  // have NO record of — not merely someone whose guided-curriculum pointer is
  // still 1. Any prior ORB conversation (hasPriorSession) proves an established
  // user who must NEVER hear the one-time "let's take your first step together"
  // onboarding opener. Only fall to 'orient' when the curriculum shows no
  // progress AND we have no record of a prior session. (hasGoal/indexDeltaUp are
  // intentionally NOT part of this gate — 'orient' historically keys on session
  // progress, and a goal alone does not make someone a returning user.)
  if (f.sessionsCompleted <= 0 && f.hasPriorSession !== true) return 'orient';
  if (f.daysSinceLastSession !== null && f.daysSinceLastSession >= RETURN_GAP_DAYS) {
    return 'returning';
  }
  if (f.indexDeltaUp !== null) return 'momentum';
  return 'building';
}

// ---------------------------------------------------------------------------
// Copy — DE is the source of truth (du-form). EN mirrors it. Each state has a
// small pool so the opening does not repeat word-for-word every login.
// ---------------------------------------------------------------------------

function salutationPrefix(lang: string, s: SalutationKind, firstName: string | null): string {
  const word =
    lang === 'de'
      ? s === 'morning'
        ? 'Guten Morgen'
        : s === 'afternoon'
          ? 'Guten Tag'
          : 'Guten Abend'
      : s === 'morning'
        ? 'Good morning'
        : s === 'afternoon'
          ? 'Good afternoon'
          : 'Good evening';
  return firstName ? `${word}, ${firstName}.` : `${word}.`;
}

function pickFromPool(pool: string[], rng: () => number): string {
  if (pool.length === 0) return '';
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[idx];
}

/** The "what's missing" nudge — at most one, framed as an upgrade, never nagging. */
function buildNudge(lang: string, f: BriefingFacts): string {
  // Only nudge users who are actually on the journey; State A already invites.
  if (f.sessionsCompleted <= 0) return '';
  if (!f.hasGoal) {
    return lang === 'de'
      ? 'Wenn du magst, richten wir noch dein persönliches Ziel ein — dann schneide ich deine Journey genau darauf zu.'
      : 'If you like, we can set your personal goal too — then I can tailor your journey precisely to it.';
  }
  return '';
}

/** Localized pillar name for the weakness rider. DE is du-form brand voice. */
function pillarLabelLocalized(lang: string, p: PillarKey): string {
  const de: Record<PillarKey, string> = {
    nutrition: 'Ernährung',
    hydration: 'Flüssigkeit',
    exercise: 'Bewegung',
    sleep: 'Schlaf',
    mental: 'mentale Stärke',
  };
  const en: Record<PillarKey, string> = {
    nutrition: 'nutrition',
    hydration: 'hydration',
    exercise: 'movement',
    sleep: 'sleep',
    mental: 'mental',
  };
  return (lang === 'de' ? de : en)[p];
}

/**
 * Advice #1 — the "understood weakness" rider. Names the slipping pillar,
 * anchors it to the user's goal (the WHY), and proposes ONE small reversing
 * step. It is always a PROPOSAL ("lass uns … ich zeige dir"), never a passive
 * question — so it stays RULE 0 compliant. Empty string when nothing slipped.
 */
export function buildWeaknessRider(lang: string, f: BriefingFacts): string {
  const drop = f.weakestPillarDrop;
  if (!drop || drop.deltaDown < MATERIAL_PILLAR_DROP) return '';
  const de = lang === 'de';
  const pillar = pillarLabelLocalized(lang, drop.pillar);
  const d = drop.deltaDown;
  const why = f.primaryGoalLabel
    ? de
      ? ` Weil dir „${f.primaryGoalLabel}" wichtig ist, lohnt sich genau hier ein kleiner Schritt.`
      : ` Because "${f.primaryGoalLabel}" matters to you, one small step right here is worth it.`
    : '';
  return de
    ? `Mir ist aufgefallen: dein Bereich ${pillar} ist diese Woche um ${d} Punkte gesunken.${why} Lass uns das gemeinsam umkehren — ich zeige dir den ersten Schritt.`
    : `I noticed your ${pillar} dropped ${d} points this week.${why} Let's turn it around together — I'll show you the first step.`;
}

/**
 * Advice #2 — the "visible momentum" progress beat. Turns the flat topic
 * checklist into a felt sense of progress: "X of N topics in green — that's P%
 * of your journey", with a special celebration at 100%. Earned-only (empty when
 * nothing is learned yet) and RULE 0 safe (a statement, never a question).
 */
export function buildProgressBeat(lang: string, f: BriefingFacts): string {
  const learned = f.topicsLearned ?? 0;
  const total = f.topicsTotal ?? 0;
  if (learned <= 0 || total <= 0) return '';
  const de = lang === 'de';
  if (learned >= total) {
    return de
      ? `Und das Größte: du hast alle ${total} Themen gemeistert — das schaffen die wenigsten.`
      : `And the big one: you've mastered all ${total} topics — almost no one gets there.`;
  }
  const pct = Math.max(1, Math.round((learned / total) * 100));
  return de
    ? `Auf deiner Lernkarte stehen schon ${learned} von ${total} Themen auf grün — das sind ${pct}% deiner Reise.`
    : `Your learning map already shows ${learned} of ${total} topics in green — that's ${pct}% of your journey.`;
}

interface RenderArgs {
  lang: string;
  salutation: SalutationKind;
  firstName: string | null;
  facts: BriefingFacts;
}

/** Compose the spoken briefing line for the picked state. Pure. Exported for tests. */
export function renderBriefingLine(args: RenderArgs, rng: () => number = Math.random): string {
  const de = args.lang === 'de';
  const prefix = salutationPrefix(args.lang, args.salutation, args.firstName);
  const f = args.facts;
  const state = pickBriefingState(f);

  // The next-session clause is only spoken when the title resolved.
  const nextClause = (() => {
    if (!f.nextSessionTitle) {
      return de
        ? 'Deine nächste Session wartet schon auf dich.'
        : 'Your next session is ready for you.';
    }
    return de
      ? `Als Nächstes käme Session ${f.nextSessionNumber}: „${f.nextSessionTitle}".`
      : `Next up is Session ${f.nextSessionNumber}: "${f.nextSessionTitle}".`;
  })();

  // RULE 0 (VTID-03307): Vitana LEADS — it never asks the user to choose the
  // direction ("Womit möchtest du weitermachen?" / "What would you like to
  // do?"). That passive close was the source of the staging "was möchtest du
  // als nächstes tun?" violation. Replace it with a PROPOSAL: name the next
  // move and offer to take it. (The deterministic confirm→execute flow — "yes"
  // opens the next session — is a separate, properly-wired follow-up.)
  const lead = pickFromPool(
    de
      ? ['Lass uns genau da weitermachen — ich führe dich.', 'Lass uns gleich loslegen, ich begleite dich Schritt für Schritt.', 'Ich nehme dich mit zum nächsten Schritt.']
      : ["Let's pick up right there — I'll guide you.", "Let's get going — I'll walk you through it step by step.", "I'll take you to the next step."],
    rng,
  );

  switch (state) {
    case 'orient': {
      // No measurable progress → orient + LEAD (propose setting the goal
      // together). No compliment (earned-only). No preference question.
      const body = de
        ? 'Deine Longevity-Journey wartet noch auf ihren ersten Schritt. Lass uns kurz dein Ziel setzen — das gibt allem eine Richtung. Ich starte das gleich mit dir.'
        : 'Your longevity journey is still waiting for its first step. Let us set your goal — it gives everything direction. I will start that with you now.';
      return [prefix, body].filter(Boolean).join(' ');
    }

    case 'building': {
      const praise = de
        ? `Stark — du hast schon ${f.sessionsCompleted} ${f.sessionsCompleted === 1 ? 'Session' : 'Sessions'} geschafft.`
        : `Strong work — you have already completed ${f.sessionsCompleted} ${f.sessionsCompleted === 1 ? 'session' : 'sessions'}.`;
      // Advice #1: when a pillar slipped, the goal-anchored reversing step IS
      // the single next move — keep the briefing to ONE clear lead.
      const rider = buildWeaknessRider(args.lang, f);
      if (rider) return [prefix, praise, rider].filter(Boolean).join(' ');
      // Advice #2: visible momentum — show how far through the curriculum the
      // user is as an earned compliment, before the next-session lead.
      const beat = buildProgressBeat(args.lang, f);
      const nudge = buildNudge(args.lang, f);
      return [prefix, praise, beat, nextClause, nudge, lead].filter(Boolean).join(' ');
    }

    case 'momentum': {
      const delta = f.indexDeltaUp ?? 0;
      const praise = de
        ? `Schön, dich zu hören. Du bist bei Session ${f.nextSessionNumber} — und dein Vitana Index ist diese Woche um ${delta} Punkte gestiegen. Das ist echte Konstanz.`
        : `Good to hear you. You are on Session ${f.nextSessionNumber} — and your Vitana Index is up ${delta} points this week. That is real consistency.`;
      const beat = buildProgressBeat(args.lang, f); // Advice #2
      const nudge = buildNudge(args.lang, f);
      return [prefix, praise, beat, nextClause, nudge, lead].filter(Boolean).join(' ');
    }

    case 'returning': {
      const body = de
        ? `Schön, dass du wieder da bist. Es ist ein paar Tage her — aber deine ${f.sessionsCompleted} ${f.sessionsCompleted === 1 ? 'Session' : 'Sessions'} sind nicht verloren, du knüpfst genau dort wieder an.`
        : `Good to have you back. It has been a few days — but your ${f.sessionsCompleted} ${f.sessionsCompleted === 1 ? 'session' : 'sessions'} are not lost; you pick up right where you left off.`;
      // Advice #1: a returning user who also slipped a pillar hears the
      // goal-anchored reversing step as the lead instead of the generic resume.
      const rider = buildWeaknessRider(args.lang, f);
      if (rider) return [prefix, body, rider].filter(Boolean).join(' ');
      const lead2 = de ? 'Lass uns genau dort wieder anknüpfen — ich führe dich.' : "Let's pick up right where you left off — I'll guide you.";
      return [prefix, body, nextClause, lead2].filter(Boolean).join(' ');
    }

    case 'graduated': {
      const body =
        f.sessionsCompleted > 0
          ? de
            ? `Du hast deine Onboarding-Journey komplett gemeistert — ${f.sessionsCompleted} Sessions, alle dein. Jetzt geht es um Tiefe.`
            : `You have fully mastered your onboarding journey — ${f.sessionsCompleted} sessions, all yours. Now it is about depth.`
          : de
            ? 'Du hast deine Onboarding-Journey gemeistert. Jetzt geht es um Tiefe.'
            : 'You have mastered your onboarding journey. Now it is about depth.';
      const beat = buildProgressBeat(args.lang, f); // Advice #2
      const lead2 = de
        ? 'Lass uns gleich eine Stufe tiefer gehen — ich zeige dir den ersten Schritt.'
        : "Let's go one level deeper — I'll show you the first step.";
      return [prefix, body, beat, lead2].filter(Boolean).join(' ');
    }
  }
}

// ---------------------------------------------------------------------------
// Input reading + DB gathering
// ---------------------------------------------------------------------------

function readInputs(ctx: ContinuationDecisionContext): LoginBriefingInputs | null {
  const extra = ctx.extra;
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[LOGIN_BRIEFING_EXTRA_KEY];
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
    greetingPolicy: typeof o.greetingPolicy === 'string' ? o.greetingPolicy : 'fresh_intro',
  };
}

interface UserJourneyRow {
  last_session_date: string | null; // YYYY-MM-DD in user TZ
  is_first_session: boolean;
}

/** Whole-day difference between two YYYY-MM-DD strings, or null when unknown. */
function dayDiff(todayIso: string, lastIso: string | null): number | null {
  if (!lastIso) return null;
  const a = Date.parse(`${todayIso}T00:00:00Z`);
  const b = Date.parse(`${lastIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((a - b) / 86_400_000));
}

/** Narrow the session lang to a checklist locale the service understands. */
function checklistLocale(lang: string): 'de' | 'en' {
  return lang === 'de' ? 'de' : 'en';
}

/**
 * Resolve, from a single published-checklist read: the title of the session the
 * user is about to do (lowest-position topic whose `session` equals
 * `nextSessionNumber`) AND the total topic count in the curriculum (advice #2,
 * the "N" in "X of N topics"). Best-effort: any failure degrades to nulls so the
 * briefing still renders ("your next session is ready", no progress beat).
 */
async function resolveCurriculumFacts(
  supabase: SupabaseClient,
  lang: string,
  nextSessionNumber: number,
  // Journey-continuation grounding: when the user's completed-topic set and
  // last-opened topic are passed, we also resolve the REAL "where we left off"
  // (last-opened topic label) and the genuinely-distinct "next step" (the first
  // topic in curriculum order the user has NOT completed). Both best-effort.
  steps?: { completedTopicIds: string[]; lastOpenedTopicId: string | null } | null,
): Promise<{
  title: string | null;
  totalTopics: number | null;
  lastOpenedTitle: string | null;
  nextStepTitle: string | null;
}> {
  try {
    const checklist = await getPublishedChecklist(supabase, 'v2', checklistLocale(lang));
    const inSession = checklist.topics
      .filter((t) => t.session === nextSessionNumber)
      .sort((a, b) => a.position - b.position);
    const rawTitle = inSession[0]?.displayLabel;
    const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle.trim() : null;
    const totalTopics = Array.isArray(checklist.topics) && checklist.topics.length > 0 ? checklist.topics.length : null;

    let lastOpenedTitle: string | null = null;
    let nextStepTitle: string | null = null;
    if (steps) {
      // Curriculum order = session asc, then position asc.
      const ordered = checklist.topics
        .slice()
        .sort((a, b) => a.session - b.session || a.position - b.position);
      const cleanLabel = (l: unknown): string | null =>
        typeof l === 'string' && l.trim().length > 0 ? l.trim() : null;
      if (steps.lastOpenedTopicId) {
        const lo = ordered.find((t) => t.topicId === steps.lastOpenedTopicId);
        lastOpenedTitle = cleanLabel(lo?.displayLabel);
      }
      const done = new Set(steps.completedTopicIds ?? []);
      const next = ordered.find((t) => !done.has(t.topicId));
      nextStepTitle = cleanLabel(next?.displayLabel);
    }
    return { title, totalTopics, lastOpenedTitle, nextStepTitle };
  } catch {
    return { title: null, totalTopics: null, lastOpenedTitle: null, nextStepTitle: null };
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function makeLoginBriefingProvider(
  opts: LoginBriefingProviderOptions = {},
): ContinuationProvider {
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? DEFAULT_PRIORITY;
  const rng = opts.rng ?? Math.random;

  return {
    key: LOGIN_BRIEFING_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return {
          providerKey: LOGIN_BRIEFING_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_login_briefing_inputs',
        };
      }

      // Silent reconnect / greeted-too-recently: stay quiet and let the
      // upstream skip policy hold. (State F — same-day quick reconnect.)
      if (inputs.greetingPolicy === 'skip') {
        return {
          providerKey: LOGIN_BRIEFING_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'greeting_policy_skip',
        };
      }

      // Gather journey facts in parallel; each source degrades to a safe
      // default so a single slow/failed read never blocks the greeting.
      const nowDate = new Date(now());
      const [journeyState, userJourney, lifeCompass, indexSnap] = await Promise.all([
        getJourneyState(inputs.supabase, inputs.userId).catch(() => null),
        fetchUserJourneyRow(inputs.supabase, inputs.userId).catch(() => null),
        fetchLifeCompass(inputs.supabase, inputs.userId).catch(() => null),
        fetchVitanaIndexForProfiler(inputs.supabase, inputs.userId).catch(() => null),
      ]);

      // Brand-new users belong to first-time-welcome (priority 95) — yield so
      // we never double-brief someone on their very first session.
      if (userJourney?.is_first_session === true) {
        return {
          providerKey: LOGIN_BRIEFING_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'is_first_session_true',
        };
      }

      const currentSession =
        journeyState && Number.isFinite(journeyState.currentSession)
          ? Math.max(1, journeyState.currentSession)
          : 1;
      const sessionsCompleted = Math.max(0, currentSession - 1);
      const graduated =
        journeyState?.onboardingStatus === 'qualified' ||
        journeyState?.onboardingStatus === 'completed';

      const { title: nextSessionTitle, totalTopics, lastOpenedTitle, nextStepTitle } =
        await resolveCurriculumFacts(
          inputs.supabase,
          inputs.lang,
          currentSession,
          journeyState
            ? {
                completedTopicIds: journeyState.completedTopicIds ?? [],
                lastOpenedTopicId: journeyState.lastOpenedTopicId ?? null,
              }
            : null,
        );

      // Advice #2 — visible momentum: count of green-checked curriculum topics.
      const topicsLearned = Array.isArray(journeyState?.completedTopicIds)
        ? journeyState.completedTopicIds.length
        : 0;

      const trend = readIndexTrend(indexSnap);
      const indexDeltaUp = trend !== null && trend >= MATERIAL_INDEX_DELTA ? trend : null;

      const todayIso = todayInTimezone(nowDate, inputs.timezone);
      const daysSinceLastSession = dayDiff(todayIso, userJourney?.last_session_date ?? null);

      const primaryGoalRaw = (lifeCompass as { primary_goal?: unknown } | null)?.primary_goal;
      const primaryGoalLabel =
        typeof primaryGoalRaw === 'string' && primaryGoalRaw.trim().length > 0
          ? primaryGoalRaw.trim()
          : null;

      // BOOTSTRAP-ORB-GREETING-RETURNING-USER: established-user signal from the
      // user_journey row (see gatherBriefingFactsForFastOpener for rationale).
      const hasPriorSession =
        !!userJourney && (userJourney.is_first_session === false || userJourney.last_session_date != null);

      const facts: BriefingFacts = {
        sessionsCompleted,
        nextSessionNumber: currentSession,
        nextSessionTitle,
        // Recall the session the user most recently heard = current_session
        // (narrate persists it as the just-played session), only when they have
        // actually completed a topic. See the fast-gather note.
        lastSessionTitle: topicsLearned > 0 ? nextSessionTitle : null,
        lastOpenedTitle,
        nextStepTitle,
        graduated,
        hasGoal: !!primaryGoalLabel,
        indexDeltaUp,
        daysSinceLastSession,
        hasPriorSession,
        // Advice #1 — understood weakness: the pillar that slipped this week
        // (from the Index snapshot's per-pillar last_movement) + the goal it
        // ties to. Both degrade to null so the briefing is unaffected when the
        // signal is absent.
        weakestPillarDrop: readWeakestPillarDrop(indexSnap),
        primaryGoalLabel,
        // Advice #2 — visible momentum: progress through the curriculum.
        topicsLearned,
        topicsTotal: totalTopics,
      };

      const localHour = localHourInTimezone(nowDate, inputs.timezone);
      const salutation = pickSalutationKind(localHour);
      const line = renderBriefingLine(
        { lang: inputs.lang, salutation, firstName: inputs.firstName, facts },
        rng,
      );
      if (!line) {
        return {
          providerKey: LOGIN_BRIEFING_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: 'renderer_produced_empty_line',
        };
      }

      const state = pickBriefingState(facts);
      const candidate: AssistantContinuation = {
        id: `login-briefing-${newId()}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority,
        userFacingLine: line,
        cta: { type: 'explain' },
        evidence: [
          { kind: 'login_briefing_state', detail: state },
          { kind: 'sessions_completed', detail: String(sessionsCompleted) },
          { kind: 'next_session', detail: nextSessionTitle ? `${currentSession}:${nextSessionTitle}` : String(currentSession) },
          ...(facts.weakestPillarDrop
            ? [{ kind: 'weakest_pillar_drop', detail: `${facts.weakestPillarDrop.pillar}:-${facts.weakestPillarDrop.deltaDown}` }]
            : []),
        ],
        // One briefing per (user × calendar day × state) so the rotation
        // window does not replay the exact same opener back-to-back.
        dedupeKey: `login-briefing:${todayIso}:${state}`,
        privacyMode: 'safe_to_speak',
      };

      return {
        providerKey: LOGIN_BRIEFING_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}

/** Read the small user_journey row used for first-session + gap detection. */
async function fetchUserJourneyRow(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserJourneyRow | null> {
  const { data, error } = await supabase
    .from('user_journey')
    .select('last_session_date, is_first_session')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as UserJourneyRow | null;
}

/** Pull the 7-day Index trend from the profiler snapshot, defensively. */
function readIndexTrend(snap: unknown): number | null {
  if (!snap || typeof snap !== 'object') return null;
  const t = (snap as { trend_7d?: unknown }).trend_7d;
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}

/**
 * Advice #1 — read the slipping pillar from the Index snapshot. The snapshot's
 * `last_movement` carries the most recent per-pillar delta; a negative delta is
 * the "this pillar fell" signal. Defensive: any unexpected shape → null, so the
 * briefing never breaks on a missing field.
 */
function readWeakestPillarDrop(snap: unknown): { pillar: PillarKey; deltaDown: number } | null {
  if (!snap || typeof snap !== 'object') return null;
  const lm = (snap as { last_movement?: { pillar?: unknown; delta?: unknown } }).last_movement;
  if (!lm || typeof lm !== 'object') return null;
  const delta = typeof lm.delta === 'number' && Number.isFinite(lm.delta) ? lm.delta : null;
  const pillar = typeof lm.pillar === 'string' ? lm.pillar : null;
  if (delta === null || delta >= 0 || pillar === null) return null;
  if (!PILLAR_KEYS.includes(pillar as PillarKey)) return null;
  return { pillar: pillar as PillarKey, deltaDown: Math.abs(Math.round(delta)) };
}

// ---------------------------------------------------------------------------
// FAST-PATH PROACTIVE OPENER (DEV-COMHU-0513 — proactive greeting on the fast
// path). The SAFE-FAST greeting fires BEFORE the heavy wake-brief context (and
// thus the full renderBriefingLine opener) is ready, so it used to speak a
// generic SHORT_GAP phrase ("Lass uns weitermachen"). These helpers compute a
// SHORT but genuinely PROACTIVE opener from a fast parallel pre-fetch, so the
// fast path can speak it instead. Deliberately ~2 short sentences: long
// greetings make Gemini Live stall → NO audio (see orb-live.ts:7400), so the
// full weakness/progress richness flows in the NEXT turn, not the opener.
// ---------------------------------------------------------------------------

/**
 * Build a short, proactive fast-path opener: salutation + name + exactly ONE
 * concrete next-step / weakness lead. Always a PROPOSAL + lead (RULE 0), never a
 * passive question. Pure; exported for tests.
 */
/**
 * Build a short, proactive fast-path opener: salutation + name + exactly ONE
 * concrete next-step / weakness lead. Always a PROPOSAL + lead (RULE 0), never a
 * passive question. FLEXIBLE WORDING — each state draws from a small pool via
 * `rng`, so the greeting is NEVER the identical sentence twice (no hard-coded
 * line). Pure; exported for tests.
 */
export function buildFastProactiveOpener(args: RenderArgs, rng: () => number = Math.random): string {
  const de = args.lang === 'de';
  const prefix = salutationPrefix(args.lang, args.salutation, args.firstName);
  const f = args.facts;
  const state = pickBriefingState(f);

  // Priority of the single proactive beat: weakness > graduated > orient > continue.
  const drop = f.weakestPillarDrop;
  if (drop && drop.deltaDown >= MATERIAL_PILLAR_DROP) {
    const pillar = pillarLabelLocalized(args.lang, drop.pillar);
    const pool = de
      ? [
          `Dein Bereich ${pillar} ist diese Woche gesunken — lass uns das gemeinsam umkehren, ich zeige dir den ersten Schritt.`,
          `Mir ist aufgefallen, dass ${pillar} diese Woche nachgelassen hat — lass uns da gemeinsam ansetzen, ich begleite dich.`,
          `Bei ${pillar} ist diese Woche etwas Luft nach oben — packen wir das zusammen an, ich gehe mit dir den ersten Schritt.`,
        ]
      : [
          `Your ${pillar} slipped this week — let's turn it around together, I'll show you the first step.`,
          `I noticed ${pillar} dipped this week — let's pick it back up together, I'll walk with you.`,
          `There's room to lift your ${pillar} this week — let's tackle it together, I'll take the first step with you.`,
        ];
    return [prefix, pickFromPool(pool, rng)].join(' ');
  }
  if (state === 'graduated') {
    const pool = de
      ? [
          'Du hast schon viel erreicht — lass uns eine Stufe tiefer gehen, ich zeige dir den nächsten Schritt.',
          'Stark, wie weit du gekommen bist — lass uns gemeinsam tiefer einsteigen, ich begleite dich.',
          'Die Grundlagen sitzen — jetzt gehen wir gemeinsam in die Tiefe, ich nehme dich mit.',
        ]
      : [
          "You've come a long way — let's go one level deeper, I'll show you the next step.",
          "Great how far you've come — let's dig deeper together, I'll be right with you.",
          "The foundations are solid — now let's go deeper together, I'll take you there.",
        ];
    return [prefix, pickFromPool(pool, rng)].join(' ');
  }
  if (state === 'orient') {
    // First-time / no progress. Propose a CONCRETE, deliverable next step (goal,
    // Index, first move) — VARIED, warm, proactive. We do NOT pitch a fixed
    // "guided journey session" here (it would repeat verbatim and, when the
    // curriculum is empty, dead-end).
    const pool = de
      ? [
          'Schön, dass du da bist! Lass uns gemeinsam dein persönliches Ziel setzen — das gibt deinem Weg eine klare Richtung.',
          'Willkommen! Lass uns mit deinem Vitana Index beginnen — ich zeige dir, wo du gerade stehst.',
          'Schön, dich zu hören! Lass uns deinen ersten Schritt gemeinsam machen — ich begleite dich dabei.',
        ]
      : [
          "Good to have you here! Let's set your personal goal together — it gives your path a clear direction.",
          "Welcome! Let's start with your Vitana Index — I'll show you where you stand right now.",
          "Lovely to hear you! Let's take your first step together — I'll be right there with you.",
        ];
    return [prefix, pickFromPool(pool, rng)].join(' ');
  }
  // building / momentum / returning → JOURNEY-CONTINUATION LEAD. The journey is
  // ONE ongoing thing: Vitana always grounds the opener in WHERE WE LEFT OFF
  // (the real last-opened topic the user can verify — never a bluff) and then
  // PROACTIVELY proposes ONE concrete next action AND offers to do it FOR the
  // user ("just say the word, I'll do it"). She never asks "what do you want?".
  //
  // The proposal ROTATES across three action types so each login inspires a
  // fresh next action (one per session, never a menu):
  //   1) continue the guided journey — the next un-learned session/topic;
  //   2) post a community update — the user dictates, Vitana posts it;
  //   3) find an activity match — and if none yet, post the request for them.
  // Type 1 names the genuinely-distinct next step (nextStepTitle ≠ recall).
  const recallTitle = f.lastOpenedTitle ?? f.lastSessionTitle ?? null;
  const nextTitle = f.nextStepTitle ?? f.nextSessionTitle ?? null;
  const nextDistinct = nextTitle && nextTitle !== recallTitle ? nextTitle : null;

  const recall = recallTitle
    ? de
      ? `Letztes Mal ging es um „${recallTitle}". `
      : `Last time we worked on "${recallTitle}". `
    : '';

  // 1) Continue the guided journey — name the concrete next step when we have a
  //    distinct one; otherwise lead to "the next session" without bluffing a title.
  const journeyProposal = nextDistinct
    ? de
      ? `${recall}Als Nächstes nehmen wir „${nextDistinct}" — sag Bescheid, ich führe dich.`
      : `${recall}Next up is "${nextDistinct}" — say the word and I'll guide you.`
    : de
      ? `${recall}Machen wir mit deiner nächsten Session weiter — sag Bescheid, ich übernehme das.`
      : `${recall}Let's continue with your next session — say the word and I'll take it from here.`;

  // 2) Community post — Vitana does the posting; the user only dictates. (The
  //    actual publish runs via the create_community_post tool when they agree.)
  const communityProposal = de
    ? `${recall}Sollen wir der Community ein kurzes Update posten? Du diktierst, ich poste es.`
    : `${recall}Shall we post a quick update to the community? You dictate it, I'll post it.`;

  // 3) Find an activity match — post_intent's always-post contract handles the
  //    "no match yet → keep the request live" case once they accept.
  const matchProposal = de
    ? `${recall}Soll ich dir einen Aktivitätspartner suchen? Ich kümmere mich darum.`
    : `${recall}Want me to find you an activity partner? I'll take care of it.`;

  const proposals = [journeyProposal, communityProposal, matchProposal];
  return [prefix, pickFromPool(proposals, rng)].join(' ');
}

/**
 * Fast, parallel gather of the BriefingFacts the fast proactive opener needs.
 * Mirrors the provider's reads but standalone so the SAFE-FAST greeting path can
 * compute a proactive line within its bounded window. Fail-open: any read
 * failure degrades that fact to a safe default; the opener still renders.
 */
export async function gatherBriefingFactsForFastOpener(
  supabase: SupabaseClient,
  userId: string,
  lang: string,
  nowMs: number,
  timezone: string | null,
): Promise<BriefingFacts> {
  const [journeyState, userJourney, lifeCompass, indexSnap] = await Promise.all([
    getJourneyState(supabase, userId).catch(() => null),
    fetchUserJourneyRow(supabase, userId).catch(() => null),
    fetchLifeCompass(supabase, userId).catch(() => null),
    fetchVitanaIndexForProfiler(supabase, userId).catch(() => null),
  ]);
  const currentSession =
    journeyState && Number.isFinite(journeyState.currentSession) ? Math.max(1, journeyState.currentSession) : 1;
  const sessionsCompleted = Math.max(0, currentSession - 1);
  const graduated =
    journeyState?.onboardingStatus === 'qualified' || journeyState?.onboardingStatus === 'completed';
  const { title: nextSessionTitle, totalTopics, lastOpenedTitle, nextStepTitle } = await resolveCurriculumFacts(
    supabase,
    lang,
    currentSession,
    journeyState
      ? {
          completedTopicIds: journeyState.completedTopicIds ?? [],
          lastOpenedTopicId: journeyState.lastOpenedTopicId ?? null,
        }
      : null,
  );
  const trend = readIndexTrend(indexSnap);
  const indexDeltaUp = trend !== null && trend >= MATERIAL_INDEX_DELTA ? trend : null;
  const todayIso = todayInTimezone(new Date(nowMs), timezone);
  const daysSinceLastSession = dayDiff(todayIso, userJourney?.last_session_date ?? null);
  const primaryGoalRaw = (lifeCompass as { primary_goal?: unknown } | null)?.primary_goal;
  const primaryGoalLabel =
    typeof primaryGoalRaw === 'string' && primaryGoalRaw.trim().length > 0 ? primaryGoalRaw.trim() : null;
  const topicsLearned = Array.isArray(journeyState?.completedTopicIds) ? journeyState.completedTopicIds.length : 0;
  // BOOTSTRAP-ORB-GREETING-RETURNING-USER: "have we met before?" comes from the
  // user_journey row, NOT the curriculum pointer. is_first_session is cleared at
  // session end, and last_session_date is stamped on every session — so either
  // being set means the user has talked to Vitana before.
  const hasPriorSession =
    !!userJourney && (userJourney.is_first_session === false || userJourney.last_session_date != null);
  return {
    sessionsCompleted,
    nextSessionNumber: currentSession,
    nextSessionTitle,
    // narrate persists current_session = the session of the topic it just
    // played, so the session the user MOST RECENTLY HEARD is current_session
    // itself (title = nextSessionTitle), NOT current_session - 1. Recall it only
    // when the user has actually completed a topic; otherwise there is nothing to
    // recall and we must not bluff.
    lastSessionTitle: topicsLearned > 0 ? nextSessionTitle : null,
    lastOpenedTitle,
    nextStepTitle,
    graduated,
    hasGoal: !!primaryGoalLabel,
    indexDeltaUp,
    daysSinceLastSession,
    weakestPillarDrop: readWeakestPillarDrop(indexSnap),
    primaryGoalLabel,
    topicsLearned,
    topicsTotal: totalTopics,
    hasPriorSession,
  };
}

/**
 * One-call entry point for the SAFE-FAST greeting path: gather facts fast +
 * render the short proactive opener. Returns null on any failure so the caller
 * cleanly falls back to the name / generic opener. Salutation is derived from
 * the timezone (consistent with the provider).
 */
export async function computeFastProactiveOpener(args: {
  supabase: SupabaseClient;
  userId: string;
  lang: string;
  firstName: string | null;
  timezone: string | null;
  nowMs: number;
  /**
   * BOOTSTRAP-ORB-GREETING-RETURNING-USER (fix #2 — cadence gate): the previous
   * session's timestamp, as resolved by `fetchLastSessionInfo`. When the last
   * session was within the greet-once window we return null so the fast opener
   * does NOT emit a fresh full greeting — the richer wake-brief path (which has
   * its own brief-resume/skip cadence handling) owns turn 1 instead. This is
   * what stops a second session a minute later from re-greeting from scratch.
   * Optional → omitting it preserves the prior always-greet behavior.
   */
  lastSessionInfo?: { time: string } | null;
}): Promise<string | null> {
  try {
    // Cadence gate: suppress the fast proactive opener when we greeted/served
    // this user very recently (default 15-min greet-once window, mirroring
    // RECENT_GREETING_WINDOW_MS in greeting-policy.ts). Day-granularity
    // daysSinceLastSession can't see this; the raw timestamp can.
    const lastTime = args.lastSessionInfo?.time;
    if (typeof lastTime === 'string' && lastTime.length > 0) {
      const lastMs = Date.parse(lastTime);
      if (Number.isFinite(lastMs)) {
        const sinceMs = args.nowMs - lastMs;
        if (sinceMs >= 0 && sinceMs < FAST_OPENER_GREET_ONCE_WINDOW_MS) {
          return null;
        }
      }
    }
    const facts = await gatherBriefingFactsForFastOpener(
      args.supabase,
      args.userId,
      args.lang,
      args.nowMs,
      args.timezone,
    );
    const salutation = pickSalutationKind(localHourInTimezone(new Date(args.nowMs), args.timezone));
    const line = buildFastProactiveOpener({ lang: args.lang, salutation, firstName: args.firstName, facts });
    return line && line.trim().length > 0 ? line : null;
  } catch {
    return null;
  }
}
