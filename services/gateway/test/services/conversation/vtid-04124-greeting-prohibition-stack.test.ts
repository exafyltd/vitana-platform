/**
 * VTID-04124 — the greeting directives this module hands Nova Sonic must not
 * pile up negative imperatives.
 *
 * WHY THIS TEST EXISTS. Measured live over 30 days on production-origin,
 * authenticated sessions, joining `vtid.live.session.start` to the real
 * Bedrock content-filter close (`stage='upstream_error'` AND `diagnostic
 * ILIKE '%content filters%'`):
 *
 *   legacy_default, prompt_len 550-700   14 sessions   11 blocked   78.6%
 *   legacy_default, every other length   21 sessions    0 blocked    0.0%
 *   newday_overview (~20 KB directive)  137 sessions   13 blocked    9.5%
 *
 * The blocked band's only distinguishing feature was a prohibition stack
 * ("Do NOT greet. Do NOT say "Hello" or the user's name … EXACTLY ONE …
 * NEVER use two-part sentences"), the same template KIND VTID-03797 already
 * proved causal for guided-topic sessions (blocked 93/93 until its stack was
 * removed). Size is demonstrably NOT the driver: the longest directive in the
 * system has the lowest block rate.
 *
 * WHY A TEST AND NOT JUST THE FIX. VTID-03674 removed one such wrapper and
 * replaced it with a milder one, so the class survived its own fix and the
 * block rate never moved. This test is the guard against that: it fails if a
 * future edit reintroduces a stack into any short-gap/legacy rung, whatever
 * wording it uses.
 *
 * SCOPE: the rungs this VTID rewrote. `newday_overview` is deliberately NOT
 * covered — it is a ~20 KB teaching block with its own rule list, it measured
 * 9.5%, and holding it to this budget would be a different (unmeasured)
 * change.
 */

import {
  computeGreetingDecision,
  type GreetingDecisionContext,
} from '../../../src/services/conversation/compute-greeting-decision';
import { EMPTY_GREETING_LEDGER } from '../../../src/services/conversation/greeting-facts-ledger';
import {
  buildReconnectRecoveryPrompt,
  RECONNECT_RECOVERY_STAGE_INTENTS,
} from '../../../src/orb/live/instruction/reconnect-recovery-prompt';

function baseCtx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return {
    contextReadyResolved: true,
    isAnonymous: false,
    safeFastGreetingLive: false,
    reconnectCount: 0,
    lang: 'de',
    greetLang: 'de',
    bucket: 'today',
    timeAgo: 'earlier today',
    wasFailure: false,
    firstName: 'Dragan',
    hasUserId: true,
    hasSupabase: true,
    hasPriorSession: true,
    greetingNeedsOnboarding: false,
    greetingIsFirstTime: false,
    lastFullBriefingDate: '2026-06-30',
    todayTz: '2026-06-30',
    localHour: 9,
    timezone: 'Europe/Berlin',
    timeOfDay: 'morning',
    proactiveLine: null,
    newdayOverview: null,
    resumeOverview: null,
    rotationSeed: 42,
    recentNbaKeys: [],
    currentRoute: null,
    currentScreenTitle: null,
    menuPhrases: [],
    openDecision: { mode: 'speak', source: 'baseline_lead', line: null },
    guidedTopicNarrationContent: null,
    wakeBriefDecisionId: null,
    silenceOnSkipEnabled: true,
    wakeBriefHasSelectedContinuation: false,
    voiceWakeBriefReason: null,
    greetingLedger: EMPTY_GREETING_LEDGER,
    ...over,
  } as GreetingDecisionContext;
}

/** Negative imperatives, the shape Bedrock's guardrail scores as
 *  injection-like when they pile up. Matches the English forms this module
 *  actually emits, plus the localized "say exactly" openers VTID-03797
 *  identified. */
const PROHIBITION = /\b(do not|don't|never|no approved phrasing|nothing to recite|nothing to pick)\b|say exactly|sag genau|dis exactement/gi;

function countProhibitions(directive: string | null): number {
  if (!directive) return 0;
  return (directive.match(PROHIBITION) || []).length;
}

/** The rungs VTID-04124 rewrote, with the context that reaches each. */
/**
 * DELIBERATELY OUT OF SCOPE, with their measured 30-day production rates:
 *   conv_resume        3/12 blocked (25.0%)
 *   newday_overview   13/137 blocked (9.5%)
 * Both are large structured blocks with their own rule lists, not short-gap
 * openers. Holding them to this budget would be a bigger, unmeasured change;
 * conv_resume's rate is the strongest remaining lead for a follow-up VTID.
 */
const REWRITTEN_RUNGS: Array<[string, GreetingDecisionContext, string]> = [
  ['legacy bucket=reconnect', baseCtx({ bucket: 'reconnect', timeAgo: 'a moment ago' }), 'legacy_default'],
  ['legacy bucket=recent', baseCtx({ bucket: 'recent', timeAgo: '15 minutes ago' }), 'legacy_default'],
  ['legacy bucket=same_day', baseCtx({ bucket: 'same_day', timeAgo: '3 hours ago' }), 'legacy_default'],
  ['legacy apology (wasFailure)', baseCtx({ bucket: 'reconnect', wasFailure: true }), 'legacy_default'],
  ['anonymous reconnect tail', baseCtx({ isAnonymous: true, reconnectCount: 1, hasUserId: false }), 'legacy_default'],
  [
    'safe_fast_pending_context (rung 6)',
    baseCtx({ contextReadyResolved: false, safeFastGreetingLive: true, bucket: 'first' }),
    'safe_fast_pending_context',
  ],
];

describe('VTID-04124 — greeting directives carry no prohibition stack', () => {
  // The pre-fix short-gap directive carried 8. One residual negative is
  // tolerated (a single "do not" is a normal instruction); a STACK is not.
  const MAX_PROHIBITIONS = 1;

  for (const [name, ctx, expectedRung] of REWRITTEN_RUNGS) {
    it(`${name} stays at or below ${MAX_PROHIBITIONS} negative imperative`, () => {
      const d = computeGreetingDecision(ctx);
      const d2 = computeGreetingDecision(ctx);
      expect(d2.wakeOpener).toBe(expectedRung);
      expect(countProhibitions(d.directive)).toBeLessThanOrEqual(MAX_PROHIBITIONS);
    });
  }

  it('no rewritten rung orders VERBATIM reproduction of a supplied sentence', () => {
    // VTID-03797's identified trigger: `Say exactly: "<sentence>"`. The
    // per-language apology map that carried it is gone entirely.
    for (const [name, ctx] of REWRITTEN_RUNGS) {
      const d = computeGreetingDecision(ctx);
      expect(`${name}: ${d.directive || ''}`).not.toMatch(/say exactly|sag genau|dis exactement/i);
    }
  });

  it('the behavioural meaning survived the rewrite — the model still composes, and still leads', () => {
    // The rewrite must not have quietly dropped the rules the prohibitions
    // encoded. "propose the move yourself" carries the old "never ask what
    // they want"; "choosing fresh wording every time" carries the anti-repeat
    // rule that VTID-03622/03630 exist for.
    const d = computeGreetingDecision(baseCtx({ bucket: 'recent', timeAgo: '15 minutes ago' }));
    expect(d.directive).toContain('propose the move yourself');
    expect(d.directive).toContain('Compose this sentence yourself');
    expect(d.directive).toContain('choosing fresh wording every time');
  });
});

/**
 * VTID-04551 — the generic reconnect-recovery prompt joins the budget.
 *
 * Measured read-only on `oasis_events`, 7 days to 2026-09-25: every Nova
 * content-filter close was at turn 0, and 29 of the 30 sessions whose FIRST
 * open was this prompt (`sendReconnectRecoveryPromptToLiveAPI`, reached when
 * the widget restarts a session with transcript history) were closed —
 * production 23/24, staging 6/6 — against 0 of 107 sessions whose first open
 * went through the greeting brain. Nova's usage counter shows the same ~460-
 * token first user turn (this prompt's size) in 28 of the 31 blocked
 * sessions. The prompt carried 11 negative imperatives (12 for `thinking`)
 * by the counter above; it now carries none.
 */
describe('VTID-04551 — the reconnect-recovery prompt carries no prohibition stack', () => {
  const STAGES = [...Object.keys(RECONNECT_RECOVERY_STAGE_INTENTS), 'unknown_stage'];

  for (const stage of STAGES) {
    it(`stage "${stage}" carries zero negative imperatives`, () => {
      expect(countProhibitions(buildReconnectRecoveryPrompt(stage))).toBe(0);
    });
  }

  it('orders no VERBATIM reproduction and hands over no finished sentence', () => {
    for (const stage of STAGES) {
      const p = buildReconnectRecoveryPrompt(stage);
      expect(p).not.toMatch(/say exactly|sag genau|dis exactement|verbatim/i);
    }
  });

  it('kept every behavioural clause of the pre-fix prompt, restated positively', () => {
    const p = buildReconnectRecoveryPrompt('listening_user_speaking');
    // composes, fresh, varied (VTID-03622)
    expect(p).toContain('Compose that sentence yourself, in your own words, fresh for this reconnect.');
    expect(p).toContain('The wording is entirely yours to choose');
    expect(p).toContain('Choose fresh wording every time');
    expect(p).toContain('Compose every recovery line newly for this moment, different from any earlier one.');
    expect(p).toContain('Keep it to one short sentence.');
    // one acknowledgment, then the stage's follow-up
    expect(p).toContain('speak one acknowledgment sentence first, then take the matching follow-up action');
    // listening: name the topic, keep the floor open, leave the unasked question to them
    expect(p).toContain('name the topic yourself and let them carry on from there');
    expect(p).toContain('leave what they were about to ask for them to say');
    // speaking: carry forward rather than restart
    expect(p).toContain('carrying the answer forward from there');
    // thinking: answer at once
    expect(p).toContain("answer the user's last question right away");
    // idle: yield the floor
    expect(p).toContain('pause and listen for the user');
    // no self-introduction, no greeting / name, recovery not a fresh start
    expect(p).toContain('The user already knows you, so go straight to the acknowledgment.');
    expect(p).toContain("keeping greetings and the user's name for a fresh conversation");
    expect(p).toContain('it is a recovery, not a fresh start');
    // VTID-02715: the drop is ours — connection / cut off vocabulary
    expect(p).toContain('Call the interruption the connection, or being cut off — the drop was on our side.');
    // one apology at most; language; speak at once
    expect(p).toContain('If you apologise, apologise once.');
    expect(p).toContain("Speak in the user's language");
    expect(p).toContain('Speak as soon as this prompt arrives.');
  });

  it('the stage-specific intent is threaded in, and unknown stages fall back to idle', () => {
    expect(buildReconnectRecoveryPrompt('thinking')).toContain(
      `YOUR ACKNOWLEDGMENT for this stage must: ${RECONNECT_RECOVERY_STAGE_INTENTS.thinking}.`,
    );
    expect(buildReconnectRecoveryPrompt('something_else')).toContain(
      `YOUR ACKNOWLEDGMENT for this stage must: ${RECONNECT_RECOVERY_STAGE_INTENTS.idle}.`,
    );
  });
});
