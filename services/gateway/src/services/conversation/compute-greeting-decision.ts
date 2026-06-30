/**
 * Conversation Flow — `computeGreetingDecision` (characterization seam, Step 1a).
 *
 * The Vertex greeting ladder lives, today, inside `sendGreetingPromptToLiveAPI`
 * (services/gateway/src/routes/orb-live.ts, ~L7562–8505): a ~940-line function
 * that interleaves the OPENING DECISION (which `wake_opener` fires + the composed
 * first-turn directive) with side effects (WebSocket sends, `emitDiag`, durable
 * DB writes, watchdog arming) and bounded async I/O. That entanglement is exactly
 * what the v3 roadmap (docs/CONVERSATION_FLOW_ROADMAP_V3.md, Step 1a) targets.
 *
 * This module extracts the DECISION as a PURE, side-effect-free function so it
 * can be golden-characterized across the full matrix before any extraction
 * refactor touches the live path. It SPEAKS nothing and EMITS nothing — it
 * returns a `GreetingDecision` describing:
 *   - which of the 9 named `wake_opener` rungs (or the legacy default) fires,
 *   - the composed first-turn directive text (or null for a silent opening),
 *   - the exact `emitDiag` metadata the live path would emit,
 *   - the register / NBA it chose (when applicable),
 *   - the side effects the live adapter must still perform to stay byte-equal.
 *
 * IMPURITY IS INJECTED, NOT PERFORMED. Every value the live path derives from
 * the clock, the environment, `Math.random`, or async I/O is passed in already
 * resolved (recency `bucket`/`timeAgo`/`wasFailure`, the safe-fast feature flag,
 * `localHour`/`todayTz`, the gathered overview payloads, the shuffled greeting
 * `menuPhrases`, the precomputed `openDecision`). The directive-composing
 * builders this calls (`buildNewDayOverviewBlock`, `buildFirstTimeWelcomeLine`,
 * `buildResumeDirective`, `decideOpeningRegister`) are themselves pure, so the
 * whole function is deterministic in its input — the prerequisite for golden
 * snapshots.
 *
 * SCOPE (Step 1a): this is ADDITIVE. The live `sendGreetingPromptToLiveAPI`
 * ladder is NOT yet routed through here — that delegation (the "strangler-fig"
 * pass that deletes the inline branches one at a time) is Step 1c. Until then
 * the 9 branches still exist in `routes/orb-live.ts` (and the transport-parity
 * scanner flags them, by design). This module + its golden suite lock today's
 * behaviour so that later strangling is provably byte-equal.
 *
 * The rung ladder below mirrors orb-live.ts EXACTLY (order, guards, string
 * shapes, diag fields). `move ≠ improve`: reproduce today, bugs and all. Any
 * behaviour fix is a SEPARATE, diffed commit — never folded into this transcription.
 */

import type { OverviewPayload } from '../assistant-continuation/providers/new-day-overview-payload';
import { buildNewDayOverviewBlock } from '../assistant-continuation/providers/new-day-overview-prompt';
import { buildFirstTimeWelcomeLine } from '../../orb/instruction/greeting-pools';
import type { TemporalBucket } from '../guide/temporal-bucket';
import { decideOpeningRegister, buildResumeDirective, type OpeningRegister } from './decide-opening';
import type { NextBestAction } from './next-best-action';

// ---------------------------------------------------------------------------
// Decision shape
// ---------------------------------------------------------------------------

/** The 9 named `wake_opener` rungs emitted by the live path, plus the legacy
 *  default tail (which emits NO `wake_opener` field — `legacy_default` is a
 *  synthetic classifier here, never written into `diag`). */
export type WakeOpener =
  | 'safe_fast_newday_overview'
  | 'safe_fast_first_time_welcome'
  | 'conv_resume'
  | 'safe_fast_proactive'
  | 'safe_fast_newday'
  | 'safe_fast_pending_context'
  | 'silent_reconnect'
  | 'override_v2'
  | 'silenced_on_cadence'
  | 'legacy_default';

/** Side effects the live adapter must still perform after rendering, kept as
 *  DATA so the pure core never performs them (it only describes them). Mirrors
 *  exactly what the corresponding live rung does today. */
export interface GreetingEffects {
  /** session.greetingSent = true (+ greetingTurnIndex, markOpeningDelivered). */
  markGreetingSent: boolean;
  /** startResponseWatchdog(...) — false only for the two deliberately-silent rungs. */
  armWatchdog: boolean;
  /** Stamp user_journey.last_full_briefing_date = this YYYY-MM-DD (newday overview). */
  stampBriefingDate?: string;
  /** Append this NBA key to user_journey.recent_nbas (keep last 8) — conv_resume. */
  recordNbaKey?: string;
}

export interface GreetingDecision {
  wakeOpener: WakeOpener;
  /** Composed first-turn directive handed to the LLM, or null for a silent
   *  opening (silent_reconnect / silenced_on_cadence). */
  directive: string | null;
  /** The metadata payload the live path passes to emitDiag(session,
   *  'greeting_sent', …) — byte-faithful (the legacy default omits wake_opener). */
  diag: Record<string, unknown>;
  /** Register chosen for the same-day resume rung (conv_resume only). */
  register?: OpeningRegister;
  /** Next-best-action chosen for conv_resume (null when none / not applicable). */
  nba?: NextBestAction | null;
  effects: GreetingEffects;
}

// ---------------------------------------------------------------------------
// Context — every input the ladder reads, pre-resolved by the caller so this
// function is pure. Field comments cite the orb-live.ts read site.
// ---------------------------------------------------------------------------

export interface GreetingDecisionContext {
  // --- transport / path routing --------------------------------------------
  /** session.contextReadyResolved. The safe-fast ladder is taken iff this is
   *  STRICTLY false AND !isAnonymous AND safeFastGreetingLive (orb-live L7603). */
  contextReadyResolved: boolean | undefined;
  isAnonymous: boolean;
  /** isFeatureLive('ORB_SAFE_FAST_GREETING'), resolved by the caller (L7604). */
  safeFastGreetingLive: boolean;
  /** (session._reconnectCount || 0) > 0. */
  reconnectCount: number;

  // --- language ------------------------------------------------------------
  /** session.lang captured at function entry (used for several langKey checks
   *  and the `lang` diag field). */
  lang: string;
  /** resolveGreetingLang(session.lang, lang) after the bounded facts wait
   *  (L7669) — the language the safe-fast rungs actually compose in. */
  greetLang: string;

  // --- recency (describeTimeSince, resolved by caller) ---------------------
  bucket: TemporalBucket;
  /** Human "time ago" phrase (LastInteraction.timeAgo). */
  timeAgo: string;
  /** LastInteraction.wasFailure — used by the legacy tail's apology branch. */
  wasFailure: boolean;

  // --- identity / names ----------------------------------------------------
  /** session.greetingFirstName. */
  firstName: string | null;
  /** !!session.identity?.user_id. */
  hasUserId: boolean;
  /** getSupabase() is truthy (true in any real runtime; injected for testability). */
  hasSupabase: boolean;

  // --- first-time signals --------------------------------------------------
  /** session.greetingHasPriorSession === true. */
  hasPriorSession: boolean;
  /** session.greetingNeedsOnboarding === true. */
  greetingNeedsOnboarding: boolean;
  /** session.greetingIsFirstTime === true. */
  greetingIsFirstTime: boolean;

  // --- daily-briefing gate -------------------------------------------------
  /** session.lastFullBriefingDate (durable once-per-real-day flag), YYYY-MM-DD. */
  lastFullBriefingDate: string | null | undefined;
  /** Today's date in the user tz, YYYY-MM-DD (resolved by caller). */
  todayTz: string;
  /** Local hour in the user tz (for buildNewDayOverviewBlock time-of-day). */
  localHour: number;
  /** session.clientContext?.timezone || 'UTC'. */
  timezone: string;

  // --- time-of-day ---------------------------------------------------------
  /** session.clientContext?.timeOfDay (e.g. 'morning' | 'night' | …) or null. */
  timeOfDay: string | null;

  // --- proactive opener ----------------------------------------------------
  /** session.greetingProactiveLine. */
  proactiveLine: string | null;

  // --- overview payloads (gathered by caller; null on timeout/empty, and the
  //     caller only gathers each when its rung guard passes — see
  //     shouldAttemptNewdayOverview / shouldAttemptResumeOverview) -----------
  newdayOverview: OverviewPayload | null;
  resumeOverview: OverviewPayload | null;

  // --- rotation / screen ---------------------------------------------------
  /** Day-of-year rotation seed (resolved by caller). */
  rotationSeed: number;
  /** Durable per-user history of recently-suggested NBA keys (most-recent last). */
  recentNbaKeys: string[];
  /** session.current_route (the client route the user is on). */
  currentRoute: string | null;
  /** describeRoute(current_route, lang)?.title — for the legacy tail screenHint. */
  currentScreenTitle: string | null;

  // --- shuffled greeting menu (pickShortGapGreetings result, injected so this
  //     stays deterministic). The live path shuffles per call; characterization
  //     pins a fixed menu. Used by safe_fast_pending_context (greetLang) and the
  //     legacy tail (lang) — in practice the same language. ------------------
  menuPhrases: string[];

  // --- normal-path opening decision (decideOpening result, precomputed) -----
  openDecision: { mode: 'speak' | 'silent'; source: string; line: string | null };

  // --- wake-brief / cadence ------------------------------------------------
  /** !!session.guidedTopicNarrationContent — switches override_v2 to teach mode. */
  guidedTopicNarrationContent: string | null;
  /** wakeBriefDecision.decisionId, or null. */
  wakeBriefDecisionId: string | null;
  /** Whether silence-on-cadence-skip is enabled. The caller resolves this from
   *  the ORB_GREETING_SILENCE_ON_SKIP_ENABLED env flag (default enabled) — that
   *  flag is read + defaulted in orb-live.ts, not here, so this module stays pure. */
  silenceOnSkipEnabled: boolean;
  /** wakeBriefDecision.selectedContinuation != null (the cadence-skip check). */
  wakeBriefHasSelectedContinuation: boolean;
  /** The voice_wake_brief provider `reason`, or null (cadence-skip detection). */
  voiceWakeBriefReason: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers (pure)
// ---------------------------------------------------------------------------

const langKey2 = (l: string | null | undefined): string => (l || 'en').slice(0, 2).toLowerCase();
const isDeOrEn = (l: string | null | undefined): boolean => {
  const k = langKey2(l);
  return k === 'de' || k === 'en';
};

/** Mirror of orb-live.ts greeting-gate use: a user with a prior session never
 *  re-fires the one-time first-time welcome; otherwise needs-onboarding or
 *  is-first-session triggers it. (Inlined to avoid importing the live gate so
 *  this module stays in the conversation/ brain; identical to
 *  shouldFireFirstTimeWelcome.) */
function firstTimeWelcomeFires(ctx: GreetingDecisionContext): boolean {
  if (ctx.hasPriorSession) return false;
  return ctx.greetingNeedsOnboarding === true || ctx.greetingIsFirstTime === true;
}

/** The once-per-real-day briefing is due unless we already stamped today (or a
 *  future date). Mirrors `_briefingDueNd` (orb-live L7711). */
function briefingDue(ctx: GreetingDecisionContext): boolean {
  const d = ctx.lastFullBriefingDate;
  return !(typeof d === 'string' && d >= ctx.todayTz);
}

/** The substantive-content gate for the rich new-day overview (orb-live L7771). */
function newdayHasContent(o: OverviewPayload): boolean {
  return (
    !!o.journey ||
    o.vitana_index.state === 'ok' ||
    o.life_compass.state === 'set' ||
    o.calendar_today.count > 0 ||
    o.calendar_passed.count > 0 ||
    (o.autopilot.state === 'has_actions' && !!o.autopilot.today_checkpoint) ||
    o.matches_unread > 0 ||
    o.messages_unread > 0 ||
    o.reminders_today.count > 0
  );
}

/** Whether the safe-fast path applies at all (orb-live L7603 + L7609). */
export function safeFastApplies(ctx: GreetingDecisionContext): boolean {
  return ctx.contextReadyResolved === false && !ctx.isAnonymous && ctx.safeFastGreetingLive;
}

/** Guard the caller uses to decide whether to gather the rich new-day overview
 *  payload (rung 1). Single-sourced so the live I/O short-circuit and the pure
 *  rung cannot diverge. Mirrors orb-live L7723. */
export function shouldAttemptNewdayOverview(ctx: GreetingDecisionContext): boolean {
  return (
    isDeOrEn(ctx.lang) &&
    briefingDue(ctx) &&
    !(ctx.greetingNeedsOnboarding === true || ctx.greetingIsFirstTime === true) &&
    typeof ctx.firstName === 'string' &&
    ctx.firstName.trim().length > 0 &&
    ctx.hasUserId &&
    ctx.hasSupabase
  );
}

/** Guard the caller uses to decide whether to gather the resume overview payload
 *  (rung 3) + the register it would use. Mirrors orb-live L7918/L7927. */
export function shouldAttemptResumeOverview(ctx: GreetingDecisionContext): {
  attempt: boolean;
  register: OpeningRegister | null;
} {
  const guard = isDeOrEn(ctx.greetLang) && !firstTimeWelcomeFires(ctx) && ctx.hasUserId && ctx.hasSupabase;
  if (!guard) return { attempt: false, register: null };
  const register = decideOpeningRegister({ bucket: ctx.bucket, isFirstTime: false, briefingDue: false });
  const attempt = register === 'continue' || register === 'quick_resume' || register === 'same_day';
  return { attempt, register };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Compute the single greeting decision for a Vertex session. Pure: speaks
 * nothing, emits nothing, performs no I/O. Returns the rung that fires, the
 * composed directive, the faithful diag payload, and the side effects the live
 * adapter must perform. The ladder order + guards mirror orb-live.ts exactly.
 */
export function computeGreetingDecision(ctx: GreetingDecisionContext): GreetingDecision {
  return safeFastApplies(ctx) ? computeSafeFastLadder(ctx) : computeNormalLadder(ctx);
}

// --- SAFE-FAST ladder (rungs 1–6) ------------------------------------------
function computeSafeFastLadder(ctx: GreetingDecisionContext): GreetingDecision {
  // Rung 1 — safe_fast_newday_overview (rich morning briefing owns turn 1).
  if (shouldAttemptNewdayOverview(ctx) && ctx.newdayOverview && newdayHasContent(ctx.newdayOverview)) {
    const block = buildNewDayOverviewBlock({
      payload: ctx.newdayOverview,
      lang: ctx.greetLang,
      firstName: (ctx.firstName as string).trim(),
      localHour: ctx.localHour,
      timezone: ctx.timezone,
    });
    if (block && block.trim().length > 0) {
      const o = ctx.newdayOverview;
      return {
        wakeOpener: 'safe_fast_newday_overview',
        directive: block,
        register: 'daily_briefing',
        diag: {
          lang: ctx.lang,
          prompt_len: block.length,
          wake_opener: 'safe_fast_newday_overview',
          bucket: ctx.bucket,
          briefing_date: ctx.todayTz,
          overview_signals: {
            journey: !!o.journey,
            index: o.vitana_index.state,
            life_compass: o.life_compass.state,
            calendar_today: o.calendar_today.count,
            autopilot: o.autopilot.state,
            matches_unread: o.matches_unread,
            messages_unread: o.messages_unread,
            reminders_today: o.reminders_today.count,
            diary_last_7d: o.diary_last_7d,
          },
        },
        effects: { markGreetingSent: true, armWatchdog: true, stampBriefingDate: ctx.todayTz },
      };
    }
  }

  // Rung 2 — safe_fast_first_time_welcome (a brand-new user gets onboarding).
  if (firstTimeWelcomeFires(ctx)) {
    const welcome = buildFirstTimeWelcomeLine(ctx.greetLang, ctx.firstName ?? null);
    const safeWel = welcome.replace(/"/g, '\\"');
    const welPrompt = `Say exactly: "${safeWel}" — speak it verbatim as audio, as ONE warm greeting. Do NOT add, paraphrase, or split it.`;
    return {
      wakeOpener: 'safe_fast_first_time_welcome',
      directive: welPrompt,
      register: 'first_time',
      diag: {
        lang: ctx.greetLang,
        prompt_len: welPrompt.length,
        wake_opener: 'safe_fast_first_time_welcome',
        is_first_session: ctx.greetingIsFirstTime === true,
      },
      effects: { markGreetingSent: true, armWatchdog: true },
    };
  }

  // Rung 3 — conv_resume (same-day reopen → recency-appropriate register + NBA).
  const resume = shouldAttemptResumeOverview(ctx);
  if (resume.attempt && resume.register) {
    const { text: dirR, nba: nbaR } = buildResumeDirective({
      register: resume.register as Exclude<OpeningRegister, 'first_time' | 'daily_briefing'>,
      payload: ctx.resumeOverview,
      firstName: ctx.firstName ?? null,
      lang: ctx.greetLang,
      timeAgo: ctx.timeAgo,
      rotationSeed: ctx.rotationSeed,
      recentNbaKeys: ctx.recentNbaKeys as NextBestAction['key'][],
      currentScreen: ctx.currentRoute ?? null,
    });
    const worthSpeaking = resume.register !== 'same_day' || !!ctx.resumeOverview || !!nbaR;
    if (dirR && dirR.trim().length > 0 && worthSpeaking) {
      return {
        wakeOpener: 'conv_resume',
        directive: dirR,
        register: resume.register,
        nba: nbaR,
        diag: {
          lang: ctx.lang,
          wake_opener: 'conv_resume',
          register: resume.register,
          bucket: ctx.bucket,
          nba: nbaR?.key ?? null,
          nba_domain: nbaR?.domain ?? null,
          current_route: ctx.currentRoute ?? null,
        },
        effects: {
          markGreetingSent: true,
          armWatchdog: true,
          ...(nbaR?.key ? { recordNbaKey: nbaR.key } : {}),
        },
      };
    }
  }

  // Rung 4 — safe_fast_proactive (short pre-fetched proactive opener).
  if (typeof ctx.proactiveLine === 'string' && ctx.proactiveLine.trim().length > 0) {
    const safeProactive = ctx.proactiveLine.trim().replace(/"/g, '\\"');
    const proactivePrompt = `Say exactly: "${safeProactive}" — speak it verbatim as audio, as ONE greeting. Do NOT add, paraphrase, or split it.`;
    return {
      wakeOpener: 'safe_fast_proactive',
      directive: proactivePrompt,
      diag: { lang: ctx.lang, prompt_len: proactivePrompt.length, wake_opener: 'safe_fast_proactive' },
      effects: { markGreetingSent: true, armWatchdog: true },
    };
  }

  // Rung 5 — safe_fast_newday (bare localized "Good <tod>, <Name>." on a new day).
  const isNewDay =
    ctx.bucket === 'today' || ctx.bucket === 'yesterday' || ctx.bucket === 'week' || ctx.bucket === 'long';
  if (isNewDay && typeof ctx.firstName === 'string' && ctx.firstName.trim().length > 0) {
    const name = ctx.firstName.trim();
    const tod = ctx.timeOfDay === 'night' ? 'evening' : ctx.timeOfDay || 'day';
    const greetingByLang: Record<string, string> = {
      en:
        tod === 'morning'
          ? `Good morning, ${name}.`
          : tod === 'afternoon'
            ? `Good afternoon, ${name}.`
            : tod === 'evening'
              ? `Good evening, ${name}.`
              : `Hello, ${name}.`,
      de:
        tod === 'morning'
          ? `Guten Morgen, ${name}.`
          : tod === 'evening'
            ? `Guten Abend, ${name}.`
            : `Guten Tag, ${name}.`,
      es:
        tod === 'morning'
          ? `Buenos días, ${name}.`
          : tod === 'evening'
            ? `Buenas noches, ${name}.`
            : `Buenas tardes, ${name}.`,
      fr: tod === 'evening' ? `Bonsoir, ${name}.` : `Bonjour, ${name}.`,
      sr:
        tod === 'morning'
          ? `Добро јутро, ${name}.`
          : tod === 'evening'
            ? `Добро вече, ${name}.`
            : `Добар дан, ${name}.`,
    };
    const lk = langKey2(ctx.greetLang);
    const spoken = greetingByLang[lk] || greetingByLang.en;
    const safe = spoken.replace(/"/g, '\\"');
    const newDayPrompt = `Say exactly: "${safe}" — ONE short utterance only. Do NOT add anything before or after. Do NOT paraphrase. Speak it as audio.`;
    return {
      wakeOpener: 'safe_fast_newday',
      directive: newDayPrompt,
      diag: { lang: ctx.lang, prompt_len: newDayPrompt.length, wake_opener: 'safe_fast_newday', bucket: ctx.bucket },
      effects: { markGreetingSent: true, armWatchdog: true },
    };
  }

  // Rung 6 — safe_fast_pending_context (generic short menu opener; always fires).
  const menu = ctx.menuPhrases.map((p) => `"${p}"`).join(', ');
  const safePrompt =
    `Open with EXACTLY ONE short phrase, picked from this menu and used VERBATIM ` +
    `(already in the user's language): ${menu}. Do NOT say "Hello" or the user's name. ` +
    `Do NOT introduce yourself. NEVER use two-part sentences. Speak it as audio.`;
  return {
    wakeOpener: 'safe_fast_pending_context',
    directive: safePrompt,
    diag: { lang: ctx.lang, prompt_len: safePrompt.length, wake_opener: 'safe_fast_pending_context' },
    effects: { markGreetingSent: true, armWatchdog: true },
  };
}

// --- NORMAL sync ladder (rungs 7–9 + legacy default) -----------------------
function computeNormalLadder(ctx: GreetingDecisionContext): GreetingDecision {
  const od = ctx.openDecision;

  // Rung 7 — silent_reconnect (honour a reconnect-silence opening decision).
  if (
    od.mode === 'silent' &&
    !ctx.isAnonymous &&
    (od.source === 'native_resume' || od.source === 'reconnect_no_handle')
  ) {
    return {
      wakeOpener: 'silent_reconnect',
      directive: null,
      diag: { lang: ctx.lang, prompt_len: 0, wake_opener: 'silent_reconnect', opening_source: od.source },
      effects: { markGreetingSent: true, armWatchdog: false },
    };
  }

  // Rung 8 — override_v2 (speak the wake-brief / contract-selected line verbatim).
  const wakeOverrideLine = od.mode === 'speak' ? (od.line ?? '').trim() : '';
  if (wakeOverrideLine.length > 0 && !ctx.isAnonymous) {
    const safe = wakeOverrideLine.replace(/"/g, '\\"');
    const wakeTriggerByLang: Record<string, string> = {
      en: `Say exactly: "${safe}" — ONE short utterance only. Do NOT add a greeting before. Do NOT add a question after. Do NOT paraphrase.`,
      de: `Sage genau Folgendes: "${safe}" — NUR EINE kurze Aussage. KEINE Begrüßung davor. KEINE Frage danach. NICHT umformulieren.`,
      fr: `Dis exactement : "${safe}" — UNE seule courte phrase. PAS de salutation avant. PAS de question après. NE PAS reformuler.`,
      es: `Di exactamente: "${safe}" — UNA sola frase corta. NO añadas saludo antes. NO añadas pregunta después. NO parafrasees.`,
      ar: `قل بالضبط: "${safe}" — جملة قصيرة واحدة فقط. لا تحية قبلها. لا سؤال بعدها. لا تعيد صياغتها.`,
      zh: `请准确地说："${safe}" —— 只说一句话。前面不要加问候。后面不要加问题。不要改述。`,
      ru: `Скажи ровно: "${safe}" — ОДНА короткая фраза. БЕЗ приветствия перед. БЕЗ вопроса после. НЕ перефразируй.`,
      sr: `Реци тачно: "${safe}" — ЈЕДНА кратка реченица. БЕЗ поздрава пре. БЕЗ питања после. НЕ преформулиши.`,
    };
    const isGuidedTeach = !!ctx.guidedTopicNarrationContent;
    const guidedIsDe = (ctx.lang || 'en').toLowerCase().startsWith('de');
    const GUIDED_LANG_NAMES: Record<string, string> = {
      en: 'English',
      de: 'German',
      es: 'Spanish',
      fr: 'French',
      sr: 'Serbian',
      ar: 'Arabic',
      zh: 'Chinese',
      ru: 'Russian',
      it: 'Italian',
      pt: 'Portuguese',
    };
    const guidedLangName = GUIDED_LANG_NAMES[langKey2(ctx.lang)] || 'English';
    const guidedTeachTrigger = guidedIsDe
      ? `Sage Folgendes WÖRTLICH und VOLLSTÄNDIG — Wort für Wort, dann höre auf und höre zu. NICHT zusammenfassen, kürzen, umformulieren oder eine Begrüßung/Frage hinzufügen: "${safe}"`
      : `Say the following lesson to the user in fluent ${guidedLangName}. The text may be in another language — translate it faithfully and completely into ${guidedLangName} and speak ONLY that translation, then stop and listen. Do NOT summarize, shorten, add a greeting, or ask a question: "${safe}"`;
    const wakePrompt = isGuidedTeach ? guidedTeachTrigger : wakeTriggerByLang[ctx.lang] || wakeTriggerByLang.en;
    return {
      wakeOpener: 'override_v2',
      directive: wakePrompt,
      diag: {
        lang: ctx.lang,
        prompt_len: wakePrompt.length,
        wake_opener: 'override_v2',
        decision_id: ctx.wakeBriefDecisionId || null,
      },
      effects: { markGreetingSent: true, armWatchdog: true },
    };
  }

  // Rung 9 — silenced_on_cadence (honour a cadence-class wake-brief skip).
  if (ctx.silenceOnSkipEnabled && !ctx.isAnonymous) {
    const cadenceSkipReasons = new Set([
      'isReconnect_forces_skip',
      'transparent_reconnect_forces_skip',
      'bucket_reconnect_forces_skip',
      'recent_turn_continues_thread',
      'greeted_recently_within_window',
    ]);
    const isCadenceSkip =
      !ctx.wakeBriefHasSelectedContinuation &&
      typeof ctx.voiceWakeBriefReason === 'string' &&
      (cadenceSkipReasons.has(ctx.voiceWakeBriefReason) || ctx.voiceWakeBriefReason === 'greeting_policy_skip');
    if (isCadenceSkip) {
      return {
        wakeOpener: 'silenced_on_cadence',
        directive: null,
        diag: {
          lang: ctx.lang,
          prompt_len: 0,
          wake_opener: 'silenced_on_cadence',
          decision_id: ctx.wakeBriefDecisionId || null,
          suppression_reason: ctx.voiceWakeBriefReason,
        },
        effects: { markGreetingSent: true, armWatchdog: false },
      };
    }
  }

  // Legacy default — the time-and-journey-aware menu prompt (emits NO wake_opener).
  const directive = buildLegacyGreetingPrompt(ctx);
  return {
    wakeOpener: 'legacy_default',
    directive,
    diag: { lang: ctx.lang, prompt_len: directive.length },
    effects: { markGreetingSent: true, armWatchdog: true },
  };
}

/** The legacy default greeting prompt (orb-live L8382–8491): anonymous intro,
 *  or the recency-bucket-aware authenticated menu. Verbatim transcription. */
function buildLegacyGreetingPrompt(ctx: GreetingDecisionContext): string {
  const greetingPrompts: Record<string, string> = {
    en: 'Open with ONE single short phrase that LEADS — propose the next move, never ask the user\'s preference. NEVER use two-part sentences with dashes. Do NOT say "Hello", "Hi", or the user\'s name. Do NOT introduce yourself. If your system instruction\'s OPENING SHAPE MATRIX provides a Proactive Opener Candidate, USE IT. Otherwise pick ONE of: "Let me show you where we are." / "Let me show you your next step." / "I am listening." / "Let\'s keep going.". NEVER "How can I help?" / "What would you like?". Vary across sessions.',
    de: 'Beginne mit EINER einzelnen kurzen Aussage, die FÜHRT — schlage den nächsten Schritt vor, frage nie nach der Vorliebe des Benutzers. NIEMALS zweiteilige Sätze mit Gedankenstrichen. Sage KEIN "Hallo", kein "Hi" und nicht den Namen des Benutzers. Stelle dich NICHT vor. Wenn die OPENING SHAPE MATRIX in deinem System-Prompt einen Proactive Opener Candidate enthält, NUTZE IHN. Ansonsten wähle EINE: "Lass mich dir zeigen, wo wir stehen." / "Lass mich dir den nächsten Schritt zeigen." / "Ich höre dir zu." / "Lass uns weitermachen.". NIEMALS "Womit kann ich helfen?" / "Was möchtest du?". Variiere zwischen Sitzungen.',
    fr: 'Commence par UNE seule courte phrase qui MÈNE — propose la prochaine étape, ne demande jamais la préférence de l\'utilisateur. JAMAIS de phrases en deux parties avec des tirets. Ne dis PAS "Bonjour" ni le prénom. Ne te présente PAS. Si l\'OPENING SHAPE MATRIX de ton instruction système fournit un Proactive Opener Candidate, UTILISE-LE. Sinon choisis UNE : "Laisse-moi te montrer où nous en sommes." / "Laisse-moi te montrer ta prochaine étape." / "Je t\'écoute." / "On continue.". JAMAIS "En quoi puis-je aider ?" / "Que puis-je faire pour vous ?". Varie entre les sessions.',
    es: 'Comienza con UNA sola frase corta que LIDERA — propone el siguiente paso, nunca preguntes la preferencia del usuario. NUNCA frases de dos partes con guiones. NO digas "Hola" ni el nombre del usuario. NO te presentes. Si la OPENING SHAPE MATRIX de tu instrucción de sistema ofrece un Proactive Opener Candidate, ÚSALO. Si no, elige UNA: "Déjame mostrarte dónde estamos." / "Déjame mostrarte tu siguiente paso." / "Te escucho." / "Sigamos.". NUNCA "¿En qué puedo ayudar?" / "¿Qué necesitas?". Varía entre sesiones.',
    ar: 'ابدأ بعبارة واحدة قصيرة تقود — اقترح الخطوة التالية، ولا تسأل المستخدم أبداً عن تفضيله. لا تستخدم جملاً من جزأين. لا تقل "مرحبا" أو اسم المستخدم. لا تقدم نفسك. إذا وفرت OPENING SHAPE MATRIX مرشحاً استباقياً فاستخدمه. وإلا اختر واحدة: "دعني أريك أين وصلنا." / "دعني أريك خطوتك التالية." / "أنا أستمع." / "لنواصل.". أبداً "كيف يمكنني المساعدة؟"',
    zh: '用一句简短、引导性的话开场——提出下一步，绝不询问用户的偏好。不要使用两部分的句子。不要说"你好"或用户名字。不要自我介绍。如果系统指令的 OPENING SHAPE MATRIX 提供了主动开场候选，请使用它。否则选一个："让我带你看看我们的进展。" / "让我带你看看你的下一步。" / "我在听。" / "我们继续。"。绝不说"有什么我可以帮忙的？"',
    ru: 'Начни с ОДНОЙ короткой фразы, которая ВЕДЁТ — предложи следующий шаг, никогда не спрашивай предпочтение пользователя. НИКОГДА не используй двухчастные предложения с тире. НЕ говори "Здравствуйте" или имя пользователя. НЕ представляйся. Если OPENING SHAPE MATRIX в системной инструкции даёт Proactive Opener Candidate — ИСПОЛЬЗУЙ ЕГО. Иначе выбери одну: "Давай покажу, где мы остановились." / "Давай покажу твой следующий шаг." / "Я слушаю." / "Продолжаем.". НИКОГДА "Чем могу помочь?" / "Что вас интересует?"',
    sr: 'Почни са ЈЕДНОМ кратком реченицом која ВОДИ — предложи следећи корак, никад не питај корисника шта жели. НИКАД не користи дводелне реченице са цртама. НЕ говори "Здраво" или име корисника. НЕ представљај се. Ако OPENING SHAPE MATRIX у системској инструкцији нуди Proactive Opener Candidate — КОРИСТИ ГА. Иначе изабери једну: "Да ти покажем докле смо стигли." / "Да ти покажем твој следећи корак." / "Слушам те." / "Настављамо.". НИКАД "Како могу да помогнем?" / "Шта те занима?"',
  };

  let prompt = greetingPrompts[ctx.lang] || greetingPrompts.en;

  // Anonymous landing-page intro (unless this is a reconnect).
  if (ctx.isAnonymous && !(ctx.reconnectCount > 0)) {
    const anonPrompts: Record<string, string> = {
      en: 'Please deliver the complete introductory speech as described in your instructions.',
      de: 'Bitte halte die vollständige Begrüßungsrede wie in deinen Anweisungen beschrieben.',
      fr: "Veuillez prononcer le discours d'introduction complet tel que décrit dans vos instructions.",
      es: 'Por favor, pronuncia el discurso introductorio completo tal como se describe en tus instrucciones.',
      ar: 'يرجى إلقاء خطاب التعريف الكامل كما هو موضح في تعليماتك.',
      zh: '请按照您的指示发表完整的介绍性演讲。',
      ru: 'Пожалуйста, произнесите полную вступительную речь, как описано в ваших инструкциях.',
      sr: 'Молимо вас, одржите комплетан уводни говор како је описано у вашим упутствима.',
    };
    prompt = anonPrompts[ctx.lang] || anonPrompts.en;
  }

  // Authenticated, recency-bucket-aware menu prompt.
  if (!ctx.isAnonymous) {
    const screenHint = ctx.currentScreenTitle
      ? ` The user is currently on the "${ctx.currentScreenTitle}" screen.`
      : '';
    const tod = ctx.timeOfDay === 'night' ? 'evening' : ctx.timeOfDay || 'day';
    const menuList = ctx.menuPhrases.map((p) => `"${p}"`).join(', ');

    if (ctx.wasFailure && (ctx.bucket === 'reconnect' || ctx.bucket === 'recent')) {
      prompt = `Say exactly: "Sorry about that. How can I help?" ONE short phrase only. Do NOT say "Hello" or the user's name.${screenHint}`;
    } else {
      switch (ctx.bucket) {
        case 'reconnect':
          prompt = `You were JUST talking to the user ${ctx.timeAgo}. Do NOT greet. Do NOT say "Hello" or the user's name. Open with EXACTLY ONE short phrase, picked from this menu and used VERBATIM (these are already in the user's language): ${menuList}. Pick a different one than last time. NEVER use two-part sentences.${screenHint}`;
          break;
        case 'recent':
          prompt = `You were just talking to the user ${ctx.timeAgo}. Do NOT use a formal greeting. Do NOT say the user's name. Open with EXACTLY ONE short phrase, picked from this menu and used VERBATIM (already in the user's language): ${menuList}. Vary across sessions. NEVER use two-part sentences.${screenHint}`;
          break;
        case 'same_day':
          prompt = `The user was here ${ctx.timeAgo}. Do NOT say the user's name. Open with EXACTLY ONE short phrase, picked from this menu and used VERBATIM (already in the user's language): ${menuList}. Vary across sessions. NEVER use two-part sentences.${screenHint}`;
          break;
        case 'today':
          prompt = `The user was here ${ctx.timeAgo} — this is a NEW-DAY greeting. Open with "Good ${tod}, [Name]." using the user's name from your memory context. Then follow per the OPENING SHAPE MATRIX in your system instruction (use the Proactive Opener Candidate if one is provided). Max TWO short sentences if no candidate; longer if the matrix says so.${screenHint}`;
          break;
        case 'yesterday':
          prompt = `The user was last here yesterday — this is a NEW-DAY greeting. Open with "Good ${tod}, [Name]." using the user's name from your memory context. Then follow per the OPENING SHAPE MATRIX in your system instruction (use the Proactive Opener Candidate if one is provided).${screenHint}`;
          break;
        case 'week':
          prompt = `The user was last here ${ctx.timeAgo} — this is a NEW-DAY greeting. Open with "Good ${tod}, [Name]." using the user's name from your memory context. Then follow per the OPENING SHAPE MATRIX in your system instruction (use the Proactive Opener Candidate if one is provided — for early-tenure users a 2-3 day absence warrants warmth like "glad you came back").${screenHint}`;
          break;
        case 'long':
          prompt = `The user hasn't been here in ${ctx.timeAgo} — this is a NEW-DAY greeting. Use the OPENING SHAPE MATRIX in your system instruction. For motivation_signal=cooling (8-14 days) or absent (>14 days), explicitly acknowledge the absence — e.g. "Hi {Name}, it's been ${ctx.timeAgo} since we last talked. Welcome back." Pause for the user to respond before any productivity nudge.${screenHint}`;
          break;
        case 'first':
        default:
          prompt = `Open per the OPENING SHAPE MATRIX in your system instruction. If tenure.stage='day0' (genuinely new user), deliver the FULL INTRODUCTION (mission, capabilities, agency offer). Otherwise treat as a returning user: "Good ${tod}, [Name]." + the Proactive Opener Candidate from your system instruction.${screenHint}`;
          break;
      }
    }
  }

  return prompt;
}
