/**
 * VTID-03366 / Step-1c: the async safe-fast greeting ladder (rungs 1–6:
 * safe_fast_newday_overview / safe_fast_first_time_welcome / conv_resume /
 * safe_fast_proactive / safe_fast_newday / safe_fast_pending_context) now lives
 * in the SINGLE BRAIN (services/conversation/compute-greeting-decision.ts,
 * `computeSafeFastLadder`) and is golden-characterized in
 * compute-greeting-decision.golden.test.ts. The Vertex transport
 * (routes/orb-live.ts) is a THIN adapter: it GATHERS the bounded async context
 * (overview payloads + spoken-facts ledger), lazily gated by the brain's own
 * shouldAttemptNewdayOverview / shouldAttemptResumeOverview / newdayHasContent
 * guards, then DELEGATES to computeGreetingDecision and RENDERS the returned
 * directive + effects.
 *
 * This test pins that split so (a) the safe-fast behaviour cannot silently
 * regress and (b) the inline 6-branch async ladder cannot drift back into the
 * transport. It replaces nothing (there was no source-pattern test for the
 * safe-fast block) — it is the delegation lock the sync-block tests already have.
 */
import * as fs from 'fs';
import * as path from 'path';

const GATEWAY_SRC = path.resolve(__dirname, '../../../../src');
const brain = fs.readFileSync(
  path.join(GATEWAY_SRC, 'services/conversation/compute-greeting-decision.ts'),
  'utf8',
);
const orbLive = fs.readFileSync(path.join(GATEWAY_SRC, 'routes/orb-live.ts'), 'utf8');

describe('VTID-03366 / 1c: safe-fast ladder lives in the brain; transport gathers + delegates', () => {
  it('all 6 safe-fast rungs are emitted by the brain', () => {
    for (const rung of [
      "wakeOpener: 'safe_fast_newday_overview'",
      "wakeOpener: 'safe_fast_first_time_welcome'",
      "wakeOpener: 'conv_resume'",
      "wakeOpener: 'safe_fast_proactive'",
      "wakeOpener: 'safe_fast_newday'",
      "wakeOpener: 'safe_fast_pending_context'",
    ]) {
      expect(brain).toContain(rung);
    }
  });

  it('the lazy-gather guards are single-sourced from the brain (no divergent inline guard)', () => {
    // The brain exports the three guards; the transport imports + calls them so
    // the I/O short-circuit cannot diverge from the pure rung fire condition.
    expect(brain).toMatch(/export function shouldAttemptNewdayOverview/);
    expect(brain).toMatch(/export function shouldAttemptResumeOverview/);
    expect(brain).toMatch(/export function newdayHasContent/);
    expect(orbLive).toMatch(/shouldAttemptNewdayOverview\(_baseCtxSF\)/);
    expect(orbLive).toMatch(/shouldAttemptResumeOverview\(_baseCtxSF\)/);
    expect(orbLive).toMatch(/newdayHasContent\(_newdayOverviewSF\)/);
  });

  it('orb-live.ts delegates the safe-fast opening to computeGreetingDecision and renders effects', () => {
    // Gather → decide → render. The adapter builds the ctx, calls the brain, and
    // renders directive + the durable stamp / NBA / ledger effects.
    expect(orbLive).toMatch(/const _sfDecision = computeGreetingDecision\(\{/);
    expect(orbLive).toMatch(/_sfDecision\.directive !== null/);
    expect(orbLive).toMatch(/_sfDecision\.effects\.stampBriefingDate/);
    expect(orbLive).toMatch(/_sfDecision\.effects\.recordNbaKey/);
    expect(orbLive).toMatch(/_sfDecision\.effects\.armWatchdog/);
    expect(orbLive).toMatch(/emitDiag\(session, 'greeting_sent', _sfDecision\.diag\)/);
  });

  it('orb-live.ts no longer carries any inline safe-fast / conv_resume decision branch', () => {
    expect(orbLive).not.toMatch(/wake_opener:\s*'safe_fast_newday_overview'/);
    expect(orbLive).not.toMatch(/wake_opener:\s*'safe_fast_first_time_welcome'/);
    expect(orbLive).not.toMatch(/wake_opener:\s*'conv_resume'/);
    expect(orbLive).not.toMatch(/wake_opener:\s*'safe_fast_proactive'/);
    expect(orbLive).not.toMatch(/wake_opener:\s*'safe_fast_newday'/);
    expect(orbLive).not.toMatch(/wake_opener:\s*'safe_fast_pending_context'/);
  });

  it('orb-live.ts carries ZERO inline wake_opener emits (full transport delegation)', () => {
    // The end-state the transport-flow-parity scanner counts down to: one brain,
    // every surface. Both the sync block and the safe-fast block now delegate.
    const inlineEmits = orbLive.match(/wake_opener:\s*['"][a-z0-9_]+['"]/gi) || [];
    expect(inlineEmits).toHaveLength(0);
  });
});
