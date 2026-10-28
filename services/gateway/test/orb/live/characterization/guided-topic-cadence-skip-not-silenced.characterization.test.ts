/**
 * VTID-03727 — a pending, never-yet-spoken guided topic must not be silenced
 * by the cadence/reconnect heuristics that exist for a totally different
 * concern (avoiding a repeated PASSIVE nudge / re-greeting mid-conversation).
 *
 * Live report (staging, right after VTID-03724 shipped): "the session now
 * starts speaking, but before it starts talking, the orb screen shows a
 * disconnection screen... In the middle of the ongoing session dictation,
 * the orb starts a new day greeting."
 *
 * Traced via oasis_events for the exact reported window: a guided-topic
 * candidate won the wake-brief ranker (`orb.livekit.next_action.candidate`,
 * `winner:true`) and `guided_topic_audio_bridge_sent` fired for session A —
 * then session A hit `nova_validation` (Nova's content filter) twice in a
 * row, still at turn_count 0 (nothing ever spoken), and was superseded by a
 * brand-new session B (orb-widget.js's `_attemptReconnect()` giving up and
 * calling `_sessionStart()` fresh — a NEW session object, not a same-session
 * Nova-level retry). Session B's own FIRST attempt never emitted
 * `guided_topic_audio_bridge_sent` at all and instead spoke `newday_overview`
 * — the exact defect VTID-03724 already fixed for the ladder's static
 * ordering (`tryGuidedTopicRung` outranking day_close/newday_overview), but
 * reproduced here through a completely different mechanism upstream of the
 * ladder: `decideOpening()`'s own reconnect/cadence silencing.
 *
 * Root cause: `tryGuidedTopicRung` (compute-greeting-decision.ts) composes
 * its ENTIRE spoken line from `ctx.openDecision.line`, and only fires when
 * `ctx.openDecision.mode === 'speak'`. `decideOpening()` (opening-
 * contract.ts) returns `mode: 'silent'` whenever `isReconnect` is true
 * (transport-reconnect-implies-silence) OR whenever `wakeCadenceSkip` is
 * true (< ~120s since the user's last session — BOOTSTRAP-NOVA-GREETING-
 * CADENCE, meant to stop a re-opened orb repeating the same passive nudge).
 * Session B is a BRAND NEW session object, so its own `_reconnectCount`
 * starts at 0 (isReconnect reads false there regardless of
 * `_freshOpenAfterZeroTurnRecovery`, which is a SAME-session-only flag) —
 * but `wakeCadenceSkip` still fires, because `lastSessionInfo` reflects
 * session A, which ended only seconds earlier. The cadence heuristic cannot
 * tell "the user just heard a full passive nudge and reopened" apart from
 * "the user's tapped lesson died silently before speaking a single word and
 * the widget is quietly retrying" — and treats both the same.
 *
 * Fix: `_hasPendingGuidedTopicAtOpen` (`!!session.guidedTopicNarrationContent
 * && session.turn_count === 0`) suppresses BOTH `isReconnect` and
 * `wakeCadenceSkip` for the `decideOpening()` call. Gating on THIS session's
 * own `turn_count === 0` (not the prior session's) is what keeps this
 * strictly scoped to "nothing has been spoken on this attempt yet" — once a
 * guided-topic session has actually delivered its opener (turn_count > 0)
 * and later has a genuine mid-lesson transport hiccup, this flag is false
 * again and `silent_reconnect` (compute-greeting-decision.ts rung 7, which
 * reads `openDecision.source`) fires exactly as before — VTID-03724's AC-5
 * ("a genuine silent reconnect still wins over a guided tap") is unaffected.
 *
 * Source characterization test, matching this codebase's established
 * pattern for orb-live.ts (too large/stateful to unit-test the WebSocket
 * harness directly) — see the sibling
 * zero-turn-greeting-recovery-not-silenced.characterization.test.ts, which
 * this fix sits directly beside in the source.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLive = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

describe('VTID-03727 — a pending, unspoken guided topic is never cadence-silenced', () => {
  it('_hasPendingGuidedTopicAtOpen requires BOTH a pending topic AND this session having spoken nothing yet', () => {
    const idx = orbLive.indexOf('const _hasPendingGuidedTopicAtOpen =');
    expect(idx).toBeGreaterThan(-1);
    const block = orbLive.slice(idx, idx + 200);
    expect(block).toMatch(/!!\(session as any\)\.guidedTopicNarrationContent/);
    expect(block).toMatch(/\(session\.turn_count \|\| 0\) === 0/);
  });

  it('isReconnect is suppressed by the pending-guided-topic flag', () => {
    const openDecisionStart = orbLive.indexOf('const _openDecision = decideOpening({');
    expect(openDecisionStart).toBeGreaterThan(-1);
    const block = orbLive.slice(openDecisionStart, openDecisionStart + 600);
    expect(block).toMatch(/isReconnect:[\s\S]*!_hasPendingGuidedTopicAtOpen/);
  });

  it('wakeCadenceSkip is suppressed by the SAME flag, not a separate/independent one', () => {
    const openDecisionStart = orbLive.indexOf('const _openDecision = decideOpening({');
    expect(openDecisionStart).toBeGreaterThan(-1);
    const block = orbLive.slice(openDecisionStart, openDecisionStart + 600);
    expect(block).toMatch(
      /wakeCadenceSkip:\s*!_hasPendingGuidedTopicAtOpen\s*&&\s*_cadenceBucketPre === 'reconnect'/,
    );
  });

  it('the flag is computed from THIS session\'s own turn_count, not carried over from a prior session object', () => {
    // A genuine mid-lesson reconnect (turn_count > 0 on THIS session) must
    // NOT trip this flag — silent_reconnect must still be reachable then.
    const idx = orbLive.indexOf('const _hasPendingGuidedTopicAtOpen =');
    const block = orbLive.slice(idx, idx + 200);
    // Must read session.turn_count directly (this session), never a
    // lastSessionInfo/prior-session field.
    expect(block).not.toMatch(/lastSessionInfo/);
    expect(block).toMatch(/session\.turn_count/);
  });

  it('does not touch silenceOnSkipEnabled (rung 9) — that stays gated on the pre-existing zero-turn-recovery flag only', () => {
    // Two independent silencing mechanisms exist (VTID-03634/03635). This fix
    // only needed to cover decideOpening's own isReconnect/wakeCadenceSkip
    // inputs — tryGuidedTopicRung already outranks rung 9 on the ladder
    // (VTID-03724), so rung 9 never gets a chance to fire once
    // tryGuidedTopicRung wins. Confirms the fix did not accidentally widen
    // scope into an unrelated mechanism.
    expect(orbLive).toMatch(
      /silenceOnSkipEnabled:\s*\n?\s*!_freshOpenAfterZeroTurnRecovery && process\.env\.ORB_GREETING_SILENCE_ON_SKIP_ENABLED !== 'false',/,
    );
  });
});
