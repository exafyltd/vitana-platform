/**
 * VTID-03104 / Step-1c (VTID-03366): the Vertex "teacher opener v2" (override_v2)
 * decision + its verbatim `Say exactly` / `Sage genau Folgendes` trigger shapes
 * now live in the SINGLE BRAIN
 * (services/conversation/compute-greeting-decision.ts) and are golden-
 * characterized in compute-greeting-decision.golden.test.ts. The Vertex transport
 * (routes/orb-live.ts) DELEGATES its sync opening rungs to the brain and renders
 * the returned directive.
 *
 * This test pins that split so (a) the override behaviour cannot silently
 * regress, and (b) the inline 9-branch ladder cannot drift back into the
 * transport. It replaces the old source-pattern test that asserted the inline
 * implementation, which the Step-1c strangle removed.
 */
import * as fs from 'fs';
import * as path from 'path';

const GATEWAY_SRC = path.resolve(__dirname, '../../../../src');
const brain = fs.readFileSync(
  path.join(GATEWAY_SRC, 'services/conversation/compute-greeting-decision.ts'),
  'utf8',
);
const orbLive = fs.readFileSync(path.join(GATEWAY_SRC, 'routes/orb-live.ts'), 'utf8');

describe('VTID-03104 / 1c: override_v2 opener lives in the brain; transport delegates', () => {
  it('the override_v2 rung + verbatim trigger shapes are in the brain', () => {
    expect(brain).toMatch(/wakeOpener: 'override_v2'/);
    expect(brain).toMatch(/Say exactly: "\$\{safe\}"/);
    expect(brain).toMatch(/Sage genau Folgendes: "\$\{safe\}"/);
    // The double-quote escape that keeps the line from terminating the wrapper.
    expect(brain).toMatch(/wakeOverrideLine\.replace\(\/"\/g, '\\\\"'\)/);
  });

  it('the brain does NOT re-introduce the VTID-03102 phrasing that broke audio', () => {
    expect(brain).not.toMatch(/Use that line verbatim/);
    expect(brain).not.toMatch(/copy it letter-for-letter/);
    expect(brain).not.toMatch(/Begin your first turn now/);
  });

  it('the legacy menu fallback likewise lives in the brain', () => {
    expect(brain).toMatch(/pick ONE of: "Let me show you where we are\./);
  });

  it('orb-live.ts delegates the sync opening rungs to computeGreetingDecision', () => {
    // VTID-03607: this used to pin the literal spellings `computeGreetingDecision({`
    // and `_syncDecision.directive`. Those are the shape the code happened to
    // have, not the invariant this test protects — which is "the transport
    // ASKS the brain and RENDERS the answer, it does not decide inline". The
    // sync path now builds its context as a named `_baseCtxSync` (so the
    // new-day branch can extend it) and renders through a shared `_renderSync`
    // closure, both of which honour the invariant exactly. Assert the
    // invariant; the rung-by-rung behaviour is pinned by the brain's own
    // golden snapshots, not by grepping this file.
    expect(orbLive).toMatch(/computeGreetingDecision\(/);
    expect(orbLive).toMatch(/const _baseCtxSync: GreetingDecisionContext = \{/);
    expect(orbLive).toMatch(/decision\.directive !== null/);
    expect(orbLive).toMatch(/decision\.effects\.armWatchdog/);
  });

  it('orb-live.ts no longer carries the inline override / silent / cadence branches', () => {
    expect(orbLive).not.toMatch(/wake_opener: 'override_v2'/);
    expect(orbLive).not.toMatch(/wake_opener: 'silent_reconnect'/);
    expect(orbLive).not.toMatch(/wake_opener: 'silenced_on_cadence'/);
  });
});

// ---------------------------------------------------------------------------
// VTID-03609 — the sync new-day branch must not read the greeting facts before
// they exist.
//
// `greetingFirstName`, `greetingIsFirstTime`, `greetingNeedsOnboarding` and
// `lastFullBriefingDate` come from the greeting-facts pre-fetch, which seeds
// the session with still-null locals and only copies the real values when
// `session.greetingFactsReady` resolves. VTID-03607's branch read them
// synchronously, so on a session whose facts had not landed the pre-guard saw
// firstName=null and the briefing could not fire — five due production
// sessions on 2026-08-12 reported `override_v2` and nothing else.
//
// These are source assertions because the branch lives inside
// `sendGreetingPromptToLiveAPI`, which is not reachable in isolation. They pin
// the ORDERING, which is the whole defect; the decision itself is covered by
// the brain's golden snapshots.
// ---------------------------------------------------------------------------

describe('VTID-03609: the sync new-day branch awaits greetingFactsReady', () => {
  const orbLiveSrc = fs.readFileSync(path.join(GATEWAY_SRC, 'routes/orb-live.ts'), 'utf8');

  it('the pre-guard does NOT gate on any pre-fetch-owned fact', () => {
    const gateBlock = orbLiveSrc.slice(
      orbLiveSrc.indexOf('const _ndGates = {'),
      orbLiveSrc.indexOf('const _newdaySyncPossible'),
    );
    expect(gateBlock.length).toBeGreaterThan(0);
    for (const fact of [
      'greetingFirstName',
      'greetingIsFirstTime',
      'greetingNeedsOnboarding',
      'lastFullBriefingDate',
    ]) {
      expect(gateBlock).not.toContain(fact);
    }
  });

  it('the branch awaits greetingFactsReady BEFORE building the new-day context', () => {
    const waitAt = orbLiveSrc.indexOf('const _factsReadyNS');
    const ctxAt = orbLiveSrc.indexOf('const _ctxNS: GreetingDecisionContext');
    expect(waitAt).toBeGreaterThan(-1);
    expect(ctxAt).toBeGreaterThan(-1);
    expect(waitAt).toBeLessThan(ctxAt);
  });

  it('the new-day context RE-READS the facts rather than inheriting the sync snapshot', () => {
    const ctxBlock = orbLiveSrc.slice(
      orbLiveSrc.indexOf('const _ctxNS: GreetingDecisionContext'),
      orbLiveSrc.indexOf('// Real guard, single-sourced with the pure rung.'),
    );
    expect(ctxBlock).toContain('..._baseCtxSync');
    // Each stale field must be explicitly overridden after the spread.
    for (const field of [
      'firstName:',
      'greetingIsFirstTime:',
      'greetingNeedsOnboarding:',
      'lastFullBriefingDate:',
      'bucket:',
    ]) {
      expect(ctxBlock).toContain(field);
    }
  });

  it('both bounded waits use the same env budgets the safe-fast path uses', () => {
    expect(orbLiveSrc).toContain('ORB_GREETING_FACTS_WAIT_MS');
    expect(orbLiveSrc).toContain('ORB_NEWDAY_FACTS_WAIT_MS');
  });

  it('every non-firing outcome emits a distinguishable newday_briefing_eval', () => {
    for (const outcome of [
      "'pre_guard_rejected'",
      "'guard_rejected'",
      "'gather_empty'",
      "'payload_had_no_content'",
      "'threw'",
      "'fired'",
    ]) {
      expect(orbLiveSrc).toContain(outcome);
    }
  });
});
