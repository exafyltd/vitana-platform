/**
 * VTID-03771 — the FEATURE_ORB_SAFE_FAST_GREETING branch of
 * sendGreetingPromptToLiveAPI (fired when `contextReadyResolved === false`)
 * hijacked a pending, never-yet-spoken guided topic with a new-day-overview
 * greeting, because that branch builds its OWN GreetingDecisionContext and
 * returns synchronously — it never reaches the "normal ladder" further down
 * in the same function, which is the ONLY place `_hasPendingGuidedTopicAtOpen`
 * (VTID-03727) previously protected.
 *
 * Live-reproduced on staging (topic T005, real account, real tap): the
 * session correctly won the guided-topic candidate (`orb.livekit.next_
 * action.candidate`, `winner:true`, `dedupe_key:"guided_topic:T005"`), got
 * `nova_validation`-blocked on its first attempt (still turn_count 0), and
 * the SAME session's internal retry (resendGreetingIfStuckAtZeroTurns ->
 * sendGreetingPromptToLiveAPI) re-entered this function with
 * `contextReadyResolved` still false. That took the safe-fast branch, which
 * has zero awareness of `guidedTopicNarrationContent` — it gathered/decided a
 * `newday_overview` greeting, emitted `stage=newday_briefing_eval` and
 * `stage=stamp_briefing_date_write`, and spoke it (394 audio chunks). The
 * real guided-topic lesson never happened, so no completion signal ever
 * fired either (no "Well Done" drawer / auto-mark-done). Reported live,
 * verbatim, twice in a row (once right after VTID-03770 shipped, which fixed
 * a *different* code path — the client-side reconnect functions — and did
 * not touch this one): "after it correctly finished teaching about that
 * step/session, Vitana just switched to New Day greeting... no Well Done
 * drawer after guided topic content."
 *
 * Fix: hoist `_hasPendingGuidedTopicAtOpen` (previously computed only later,
 * for the normal ladder's `decideOpening()` call) above the safe-fast
 * branch's own `if`, and gate that `if` on `!_hasPendingGuidedTopicAtOpen`
 * too — so a pending guided topic always falls through past the safe-fast
 * shortcut into the normal ladder, which already renders it correctly via
 * `tryGuidedTopicRung` (VTID-03724/03727). The later declaration site is
 * removed (would otherwise be a duplicate `const` in the same function
 * scope) and that call site now reuses the hoisted flag unchanged.
 *
 * Source characterization test, matching this codebase's established
 * pattern for orb-live.ts (too large/stateful to unit-test the WebSocket
 * harness directly) — see the sibling
 * guided-topic-cadence-skip-not-silenced.characterization.test.ts (VTID-03727),
 * which this fix sits directly beside in the source and shares one flag with.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLive = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

describe('VTID-03771 — the safe-fast greeting branch never hijacks a pending guided topic', () => {
  it('_hasPendingGuidedTopicAtOpen is declared exactly once in the whole file (hoisted, not duplicated)', () => {
    const matches = orbLive.match(/const _hasPendingGuidedTopicAtOpen =/g) || [];
    expect(matches.length).toBe(1);
  });

  it('the safe-fast branch\'s own `if` is gated on !_hasPendingGuidedTopicAtOpen', () => {
    const idx = orbLive.indexOf(
      "if ((session as any).contextReadyResolved === false && !session.isAnonymous",
    );
    expect(idx).toBeGreaterThan(-1);
    const line = orbLive.slice(idx, orbLive.indexOf('\n', idx));
    expect(line).toMatch(/!_hasPendingGuidedTopicAtOpen/);
  });

  it('_hasPendingGuidedTopicAtOpen is declared BEFORE the safe-fast branch\'s `if`, not after', () => {
    const declIdx = orbLive.indexOf('const _hasPendingGuidedTopicAtOpen =');
    const ifIdx = orbLive.indexOf(
      "if ((session as any).contextReadyResolved === false && !session.isAnonymous",
    );
    expect(declIdx).toBeGreaterThan(-1);
    expect(ifIdx).toBeGreaterThan(-1);
    expect(declIdx).toBeLessThan(ifIdx);
  });

  it('the flag still requires BOTH a pending topic AND this session having spoken nothing yet (unchanged condition, just relocated)', () => {
    const idx = orbLive.indexOf('const _hasPendingGuidedTopicAtOpen =');
    const block = orbLive.slice(idx, idx + 200);
    expect(block).toMatch(/!!\(session as any\)\.guidedTopicNarrationContent/);
    expect(block).toMatch(/\(session\.turn_count \|\| 0\) === 0/);
  });

  it('the normal ladder\'s decideOpening() call still reuses the flag correctly (no regression to the VTID-03727 fix)', () => {
    const openDecisionStart = orbLive.indexOf('const _openDecision = decideOpening({');
    expect(openDecisionStart).toBeGreaterThan(-1);
    const block = orbLive.slice(openDecisionStart, openDecisionStart + 600);
    expect(block).toMatch(/isReconnect:[\s\S]*!_hasPendingGuidedTopicAtOpen/);
    expect(block).toMatch(
      /wakeCadenceSkip:\s*!_hasPendingGuidedTopicAtOpen\s*&&\s*_cadenceBucketPre === 'reconnect'/,
    );
  });

  it('a session with NO pending guided topic still takes the safe-fast branch when context is unresolved (no regression to the original DEV-COMHU-0513 B2 fast path)', () => {
    const idx = orbLive.indexOf(
      "if ((session as any).contextReadyResolved === false && !session.isAnonymous",
    );
    const line = orbLive.slice(idx, orbLive.indexOf('\n', idx));
    // The original two conditions must still both be present, unmodified —
    // this fix only ADDS a third guard, it does not replace the existing ones.
    expect(line).toMatch(/\(session as any\)\.contextReadyResolved === false/);
    expect(line).toMatch(/!session\.isAnonymous/);
  });
});
