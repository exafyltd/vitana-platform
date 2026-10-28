/**
 * BOOTSTRAP-ORB-DAY-CLOSE (VTID-03743) — the day-close ("goodnight") rung's
 * two dependencies restored/changed together:
 *
 * 1. `last_day_close_date` is back in the greeting-facts SELECT in
 *    live-session-controller.ts, in the SAME query as
 *    `last_full_briefing_date`. It was dropped there under
 *    BOOTSTRAP-ORB-NEWDAY-STAMP-DIAGNOSTIC because the column did not exist
 *    on the live `user_journey` table — selecting a nonexistent column
 *    failed that ENTIRE query (Postgres 42703), which is what actually
 *    root-caused the new-day-briefing repeat-every-session bug (it silently
 *    zeroed out `last_full_briefing_date`, read in the same query). The
 *    column now exists (migration add_user_journey_last_day_close_date), so
 *    this pins that it is selected again — and that a future edit cannot
 *    silently drop it (or `last_full_briefing_date`) from the same query
 *    without a test failing.
 *
 * 2. The day-close opener is now permanently the SHORT, reduced builder
 *    (`buildDayCloseOpenerLine`) rather than the full quoted-dialogue
 *    exemplar block (`buildDayCloseBlock`) — the reduced opener used to be
 *    a one-shot fallback used only after a Nova-validation content-filter
 *    block on the full block. `dayCloseReduced: true` is now hardcoded on
 *    both greeting-ladder context builders (safe-fast and normal/sync) in
 *    orb-live.ts.
 *
 * This file is a source characterization test, matching this codebase's
 * established pattern for orb-live.ts / live-session-controller.ts (too
 * large/stateful to unit-test the WebSocket harness directly — see
 * zero-turn-greeting-recovery-not-silenced.characterization.test.ts for the
 * same shape).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLive = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
const liveSessionController = readFileSync(
  join(__dirname, '../../../../src/orb/live/session/live-session-controller.ts'),
  'utf8',
);

describe('BOOTSTRAP-ORB-DAY-CLOSE — greeting-facts prefetch selects last_day_close_date again', () => {
  it('the user_journey SELECT includes both last_full_briefing_date AND last_day_close_date', () => {
    const fromIdx = liveSessionController.indexOf(".from('user_journey')");
    expect(fromIdx).toBeGreaterThan(-1);

    const selectCallStart = liveSessionController.indexOf('.select(', fromIdx);
    expect(selectCallStart).toBeGreaterThan(-1);

    // Regression guard for the actual root cause: both columns must be read
    // in the SAME .select(...) call, not two separate queries — the whole
    // point is that one nonexistent column previously failed the query that
    // also carried the other, real column. Bound the slice at the next
    // `.eq('user_id'` call, which immediately follows this .select(...) in
    // source, rather than guessing a fixed character window.
    const eqCallStart = liveSessionController.indexOf(".eq('user_id'", selectCallStart);
    expect(eqCallStart).toBeGreaterThan(selectCallStart);
    const selectCallArgs = liveSessionController.slice(selectCallStart, eqCallStart);

    expect(selectCallArgs).toMatch(/last_full_briefing_date/);
    expect(selectCallArgs).toMatch(/last_day_close_date/);
  });

  it('greetingLastDayCloseDate is read from the fetched row and applied onto the session', () => {
    expect(liveSessionController).toMatch(
      /greetingLastDayCloseDate = _fsRow\?\.last_day_close_date \?\? null;/,
    );
    expect(liveSessionController).toMatch(
      /\(session as any\)\.lastDayCloseDate = greetingLastDayCloseDate;/,
    );
  });
});

describe('BOOTSTRAP-ORB-DAY-CLOSE — the reduced opener is the permanent default, not a retry-only fallback', () => {
  it('the safe-fast greeting context hardcodes dayCloseReduced: true', () => {
    const baseCtxStart = orbLive.indexOf('const _baseCtxSF: GreetingDecisionContext = {');
    expect(baseCtxStart).toBeGreaterThan(-1);
    const baseCtxEnd = orbLive.indexOf('\n            };', baseCtxStart);
    const baseCtxBlock = orbLive.slice(baseCtxStart, baseCtxEnd);
    expect(baseCtxBlock).toMatch(/dayCloseReduced:\s*true,/);
  });

  it('the normal/sync greeting context hardcodes dayCloseReduced: true', () => {
    const baseCtxStart = orbLive.indexOf('const _baseCtxSync: GreetingDecisionContext = {');
    expect(baseCtxStart).toBeGreaterThan(-1);
    const baseCtxEnd = orbLive.indexOf('\n    };', baseCtxStart);
    const baseCtxBlock = orbLive.slice(baseCtxStart, baseCtxEnd);
    expect(baseCtxBlock).toMatch(/dayCloseReduced:\s*true,/);

    // The old retry-conditional derivation must be gone from this context —
    // a stray reintroduction of `_dayCloseReduced` here would silently make
    // the full block the default again on every FIRST day-close open.
    expect(baseCtxBlock).not.toMatch(/dayCloseReduced:\s*_dayCloseReduced,/);
  });

  it('the retry flag is still consumed and cleared (no stale leak into a later close)', () => {
    expect(orbLive).toMatch(/\(session as any\)\._dayCloseReducedRetry = false;/);
  });
});
