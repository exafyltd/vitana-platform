/**
 * VTID-03743 review fixes (Codex automated review on PR #3198) —
 * two real defects the day-close staging-enablement PR would otherwise
 * have shipped:
 *
 * P1 (correctness) — every day-close stamp call site persisted
 * `last_day_close_date` synchronously, right after `ws.send()`'ing the
 * greeting directive, before Nova had any chance to actually speak it. A
 * Nova content-filter block or any connection death before audio would
 * still have marked that night "delivered" — reproducing, for day-close,
 * the exact "a delivered marker set before delivery is confirmed" failure
 * class this whole VTID chain exists to end. Fix:
 * `schedulePersistDayCloseStamp()` defers the write behind
 * `getGreetingResponseTimeoutMs()` and only persists when
 * `session.transportHasShownLife === true`.
 *
 * Also found while fixing P1 (not flagged by Codex, but the identical
 * defect shape): TWO call sites — the plain/legacy sync ladder
 * (`_syncDecision`) and the newday-briefing-gather try/catch's recovery
 * path (`_recoverNS`) — had NO stamp write at all, meaning day-close could
 * win on those paths and never be marked delivered, firing on every
 * session that reached them.
 *
 * P2 (latency) — `shouldAttemptNewdayOverview()`'s guard does not check
 * the day-close window, so a session that opens during 21:00-04:59 with a
 * morning briefing "due" paid for the full `gatherOverviewPayload` +
 * ledger read (up to ~3.8s) on BOTH ladders before `computeGreetingDecision`
 * discarded it in favor of day-close, which outranks it. Fix: a cheap
 * `tryDayCloseRung(ctx)` pre-check (now exported — it is pure, no I/O)
 * before the expensive gather.
 *
 * This file is a source characterization test, matching this codebase's
 * established pattern for orb-live.ts (too large/stateful to unit-test the
 * WebSocket harness directly — see
 * zero-turn-greeting-recovery-not-silenced.characterization.test.ts for the
 * same shape).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLive = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
const computeGreetingDecision = readFileSync(
  join(__dirname, '../../../../src/services/conversation/compute-greeting-decision.ts'),
  'utf8',
);

describe('VTID-03743 P1 — day-close stamp is deferred until delivery is confirmed', () => {
  it('schedulePersistDayCloseStamp only persists when transportHasShownLife is true', () => {
    const fnStart = orbLive.indexOf('function schedulePersistDayCloseStamp(');
    expect(fnStart).toBeGreaterThan(-1);
    // Bounded by the next top-level comment marker rather than the first
    // `\n}` — the function's own multi-line args type literal closes with
    // `}): void {` at column 0, which a naive `\n}` search matches before
    // ever reaching the real function body.
    const fnEnd = orbLive.indexOf('\n// VTID-03495: Polly seam', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = orbLive.slice(fnStart, fnEnd);

    expect(fnBody).toMatch(/session\.transportHasShownLife !== true/);
    expect(fnBody).toMatch(/setTimeout\(/);
    expect(fnBody).toMatch(/getGreetingResponseTimeoutMs\(\)/);

    // The skip branch must return before touching session.lastDayCloseDate
    // or issuing the write — a partial persist would defeat the whole fix.
    const skipIdx = fnBody.indexOf('session.transportHasShownLife !== true');
    const returnIdx = fnBody.indexOf('return;', skipIdx);
    const lastDayCloseAssignIdx = fnBody.indexOf('(session as any).lastDayCloseDate = stampValue;');
    expect(returnIdx).toBeGreaterThan(skipIdx);
    expect(lastDayCloseAssignIdx).toBeGreaterThan(returnIdx);
  });

  it('every stampDayCloseDate call site routes through schedulePersistDayCloseStamp, not an immediate write', () => {
    const callSites = orbLive.split('effects.stampDayCloseDate').length - 1;
    // Five sites read `effects.stampDayCloseDate`: safe_fast, normal,
    // fallback, recover, plain_sync — each reads it TWICE (once in the
    // `if (...)` guard, once as the `stampValue:` passed to
    // schedulePersistDayCloseStamp).
    expect(callSites).toBe(10);

    const scheduleCalls = orbLive.split('schedulePersistDayCloseStamp({').length - 1;
    expect(scheduleCalls).toBe(5);

    // No call site may still assign `lastDayCloseDate` immediately from an
    // `effects.stampDayCloseDate` read (the old, pre-fix pattern) — every
    // assignment of that field must happen inside
    // schedulePersistDayCloseStamp itself, gated on transportHasShownLife.
    const immediateAssignPattern = /\(session as any\)\.lastDayCloseDate = _\w+\.effects\.stampDayCloseDate;/;
    expect(orbLive).not.toMatch(immediateAssignPattern);
  });

  it('the plain/legacy sync ladder (_syncDecision) and the recovery path (_recoverNS) now stamp day-close too', () => {
    // These two call sites did not exist before this fix — confirms the
    // additional gap found alongside Codex's P1 finding is also closed.
    expect(orbLive).toMatch(/_syncDecision\.effects\.stampDayCloseDate[\s\S]{0,80}branch:\s*'plain_sync'/);
    expect(orbLive).toMatch(/_recoverNS\.effects\.stampDayCloseDate[\s\S]{0,120}branch:\s*'recover'/);
  });
});

describe('VTID-03743 P2 — the expensive new-day-overview gather is skipped when day-close would win anyway', () => {
  it('compute-greeting-decision.ts exports tryDayCloseRung (pure, no I/O, safe to call as a pre-check)', () => {
    expect(computeGreetingDecision).toMatch(/export function tryDayCloseRung\(/);
  });

  it('both shouldAttemptNewdayOverview gather guards are gated on !tryDayCloseRung(...)', () => {
    const guardCount = orbLive
      .split('\n')
      .filter((line) => line.includes('shouldAttemptNewdayOverview(') && line.includes('!tryDayCloseRung(')).length;
    expect(guardCount).toBe(2);
  });

  it('tryDayCloseRung genuinely outranks tryNewDayOverviewRung inside computeGreetingDecision (the fact that justifies the pre-check)', () => {
    const fastLadderStart = computeGreetingDecision.indexOf('function computeSafeFastLadder(');
    expect(fastLadderStart).toBeGreaterThan(-1);
    const dayCloseIdx = computeGreetingDecision.indexOf('tryDayCloseRung(ctx)', fastLadderStart);
    const newdayIdx = computeGreetingDecision.indexOf('tryNewDayOverviewRung(ctx', fastLadderStart);
    expect(dayCloseIdx).toBeGreaterThan(-1);
    expect(newdayIdx).toBeGreaterThan(-1);
    expect(dayCloseIdx).toBeLessThan(newdayIdx);
  });
});
