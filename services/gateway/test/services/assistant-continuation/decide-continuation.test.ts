/**
 * VTID-02913 (B0d.1) — decide-continuation orchestrator tests.
 *
 * These tests double as the executable form of the B0d.1 review
 * checklist (5 items, locked):
 *
 *   1. AssistantContinuationDecision carries timing + provider evidence.
 *   2. `none_with_reason` is first-class, not a fallback hack.
 *   3. Provider results observable even when no continuation is selected.
 *   4. Tests cover BOTH "selected continuation" AND "suppressed continuation".
 *   5. Contract generic enough for wake brief, feature discovery,
 *      match journey, reminders, and future opportunities.
 *
 * The test descriptions name the checklist item so a reviewer can map
 * green dots to the checklist.
 */

import {
  decideContinuation,
  materializedNone,
  rollUpSuppressionReason,
} from '../../../src/services/assistant-continuation/decide-continuation';
import { createProviderRegistry } from '../../../src/services/assistant-continuation/provider-registry';
import {
  isNoneWithReason,
  makeNoneWithReason,
  type AssistantContinuation,
  type ContinuationProvider,
  type ProviderResult,
} from '../../../src/services/assistant-continuation/types';

// ---------------------------------------------------------------------------
// Test helpers — frozen-time, deterministic ids
// ---------------------------------------------------------------------------

function frozenNow(seqStart = 1_700_000_000_000) {
  let n = seqStart;
  return () => new Date(n++); // advance 1ms per call — exercises timing capture
}

function newIdFactory(prefix = 'd') {
  let i = 0;
  return () => `${prefix}-${++i}`;
}

function returningProvider(
  key: string,
  candidate: AssistantContinuation,
  latencyMs = 5,
): ContinuationProvider {
  return {
    key,
    surfaces: [candidate.surface],
    produce: (): ProviderResult => ({
      providerKey: key,
      status: 'returned',
      latencyMs,
      candidate,
    }),
  };
}

function suppressingProvider(
  key: string,
  surface: AssistantContinuation['surface'],
  reason: string,
): ContinuationProvider {
  return {
    key,
    surfaces: [surface],
    produce: (): ProviderResult => ({
      providerKey: key,
      status: 'suppressed',
      latencyMs: 3,
      reason,
    }),
  };
}

function erroringProvider(
  key: string,
  surface: AssistantContinuation['surface'],
  errMessage: string,
): ContinuationProvider {
  return {
    key,
    surfaces: [surface],
    produce: () => {
      throw new Error(errMessage);
    },
  };
}

function wakeBriefCandidate(opts: {
  id: string;
  priority: number;
  line: string;
  dedupeKey?: string;
}): AssistantContinuation {
  return {
    id: opts.id,
    surface: 'orb_wake',
    kind: 'wake_brief',
    priority: opts.priority,
    userFacingLine: opts.line,
    cta: { type: 'explain' },
    evidence: [{ kind: 'demo', detail: 'unit test', weight: 1 }],
    dedupeKey: opts.dedupeKey ?? opts.id,
    privacyMode: 'safe_to_speak',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('B0d.1 decideContinuation — checklist #4: SELECTED continuation path', () => {
  it('returns the candidate when exactly one provider fires', async () => {
    const registry = createProviderRegistry();
    const candidate = wakeBriefCandidate({
      id: 'wb-1',
      priority: 50,
      line: 'Welcome back.',
    });
    registry.register(returningProvider('wake-brief', candidate));

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: { sessionId: 's1', userId: 'u1', tenantId: 't1' },
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });

    expect(decision.selectedContinuation).toBe(candidate);
    expect(decision.suppressionReason).toBeUndefined();
  });

  it('ranks by descending priority and breaks ties by registration order', async () => {
    const registry = createProviderRegistry();
    const low = wakeBriefCandidate({ id: 'low', priority: 10, line: 'low' });
    const high = wakeBriefCandidate({ id: 'high', priority: 90, line: 'high' });
    const sameAsLow = wakeBriefCandidate({
      id: 'tie',
      priority: 10,
      line: 'tie',
    });
    // Registration order: low, high, sameAsLow.
    registry.register(returningProvider('low', low));
    registry.register(returningProvider('high', high));
    registry.register(returningProvider('tie', sameAsLow));

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(decision.selectedContinuation?.id).toBe('high');

    // Now drop `high` to test tie-break order: low should win over sameAsLow
    // because it registered first.
    registry.unregister('high');
    const tieDecision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(tieDecision.selectedContinuation?.id).toBe('low');
  });

  it('only considers providers servicing the requested surface', async () => {
    const registry = createProviderRegistry();
    const wakeCandidate = wakeBriefCandidate({
      id: 'wb',
      priority: 50,
      line: 'wake',
    });
    const turnEndCandidate: AssistantContinuation = {
      ...wakeBriefCandidate({ id: 'te', priority: 100, line: 'turn' }),
      surface: 'orb_turn_end',
      kind: 'next_step',
    };
    registry.register(returningProvider('wb', wakeCandidate));
    registry.register(returningProvider('te', turnEndCandidate));

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    // Turn-end provider had higher priority but is on a different surface.
    expect(decision.selectedContinuation?.id).toBe('wb');
    expect(decision.sourceProviderResults).toHaveLength(1);
  });
});

describe('B0d.1 decideContinuation — checklist #4: SUPPRESSED (all-suppressed) path', () => {
  it('returns selectedContinuation=null when every provider suppresses', async () => {
    const registry = createProviderRegistry();
    registry.register(suppressingProvider('a', 'orb_wake', 'sensitive_context'));
    registry.register(suppressingProvider('b', 'orb_wake', 'daily_cap'));

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: { sessionId: 's1' },
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });

    expect(decision.selectedContinuation).toBeNull();
    // ── checklist #1: timing fields present
    expect(decision.decisionStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(decision.decisionFinishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // ── checklist #2: rolled-up reason is set (none_with_reason
    //                  semantics carried on the decision itself).
    expect(decision.suppressionReason).toBe('all_providers_suppressed');
  });

  it('surfaces "no_providers_registered" when nothing is wired for the surface', async () => {
    const registry = createProviderRegistry();
    const decision = await decideContinuation({
      surface: 'home',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(decision.selectedContinuation).toBeNull();
    expect(decision.suppressionReason).toBe('no_providers_registered');
    expect(decision.sourceProviderResults).toEqual([]);
  });

  it('surfaces "all_providers_errored" when every provider throws', async () => {
    const registry = createProviderRegistry();
    registry.register(erroringProvider('a', 'orb_wake', 'kaboom'));
    registry.register(erroringProvider('b', 'orb_wake', 'splat'));

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(decision.selectedContinuation).toBeNull();
    expect(decision.suppressionReason).toBe('all_providers_errored');
  });

  it('reports "no_provider_returned_a_candidate" on mixed suppressed/errored outcomes', async () => {
    const registry = createProviderRegistry();
    registry.register(suppressingProvider('a', 'orb_wake', 'sensitive'));
    registry.register(erroringProvider('b', 'orb_wake', 'kaboom'));

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(decision.selectedContinuation).toBeNull();
    expect(decision.suppressionReason).toBe('no_provider_returned_a_candidate');
  });
});

describe('B0d.1 decideContinuation — checklist #3: provider results observable on no-fire paths', () => {
  it('sourceProviderResults has one row per provider when every provider suppressed', async () => {
    const registry = createProviderRegistry();
    registry.register(suppressingProvider('a', 'orb_wake', 'reason-a'));
    registry.register(suppressingProvider('b', 'orb_wake', 'reason-b'));
    registry.register(suppressingProvider('c', 'orb_wake', 'reason-c'));

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(decision.selectedContinuation).toBeNull();
    // ── checklist #3: full per-provider evidence even on a no-fire path.
    expect(decision.sourceProviderResults).toHaveLength(3);
    expect(decision.sourceProviderResults.map((r) => r.providerKey)).toEqual([
      'a',
      'b',
      'c',
    ]);
    for (const row of decision.sourceProviderResults) {
      expect(row.status).toBe('suppressed');
      expect(row.reason).toMatch(/^reason-[abc]$/);
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('records latencyMs + provider key + reason for an erroring provider (no exception bubbles)', async () => {
    const registry = createProviderRegistry();
    registry.register(erroringProvider('crashing', 'orb_wake', 'boom'));

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(decision.sourceProviderResults).toHaveLength(1);
    const row = decision.sourceProviderResults[0];
    expect(row.providerKey).toBe('crashing');
    expect(row.status).toBe('errored');
    expect(row.reason).toBe('boom');
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('B0d.1 decideContinuation — checklist #1: contract carrier has timing + evidence', () => {
  it('every decision contains all 7 fields of AssistantContinuationDecision', async () => {
    const registry = createProviderRegistry();
    const candidate = wakeBriefCandidate({ id: 'wb', priority: 30, line: 'hi' });
    registry.register(returningProvider('wb', candidate));

    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: { sessionId: 's1', userId: 'u1', tenantId: 't1', envelopeJourneySurface: 'intent_board' },
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    // 1. decisionId
    expect(typeof decision.decisionId).toBe('string');
    expect(decision.decisionId.length).toBeGreaterThan(0);
    // 2. selectedContinuation
    expect(decision.selectedContinuation).toBe(candidate);
    // 3. suppressionReason — optional, absent when something was selected
    expect(decision.suppressionReason).toBeUndefined();
    // 4. decisionStartedAt (ISO 8601)
    expect(decision.decisionStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 5. decisionFinishedAt (ISO 8601)
    expect(decision.decisionFinishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 6. sourceProviderResults
    expect(Array.isArray(decision.sourceProviderResults)).toBe(true);
    expect(decision.sourceProviderResults).toHaveLength(1);
    // 7. telemetryContext
    expect(decision.telemetryContext).toEqual({
      sessionId: 's1',
      userId: 'u1',
      tenantId: 't1',
      surface: 'orb_wake',
      envelopeJourneySurface: 'intent_board',
    });
  });

  it('decisionFinishedAt >= decisionStartedAt', async () => {
    const registry = createProviderRegistry();
    registry.register(suppressingProvider('a', 'orb_wake', 'nope'));
    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    const t0 = Date.parse(decision.decisionStartedAt);
    const t1 = Date.parse(decision.decisionFinishedAt);
    expect(t1).toBeGreaterThanOrEqual(t0);
  });

  it('uses the injected id factory (decisionId is not random in tests)', async () => {
    const registry = createProviderRegistry();
    registry.register(suppressingProvider('a', 'home', 'nope'));
    const decision = await decideContinuation({
      surface: 'home',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory('test-decision'),
    });
    expect(decision.decisionId).toBe('test-decision-1');
  });
});

describe('B0d.1 decideContinuation — checklist #2: none_with_reason is first-class', () => {
  it('materializedNone() converts a null-selection decision into a continuation', async () => {
    const registry = createProviderRegistry();
    registry.register(suppressingProvider('a', 'orb_wake', 'sensitive'));
    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(decision.selectedContinuation).toBeNull();
    const c = materializedNone(decision);
    expect(c.kind).toBe('none_with_reason');
    expect(isNoneWithReason(c)).toBe(true);
    expect(c.suppressReason).toBe('all_providers_suppressed');
    expect(c.surface).toBe('orb_wake');
  });

  it('materializedNone() refuses to run on a selected decision', async () => {
    const registry = createProviderRegistry();
    const candidate = wakeBriefCandidate({ id: 'wb', priority: 10, line: 'hi' });
    registry.register(returningProvider('wb', candidate));
    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(() => materializedNone(decision)).toThrow(
      /already has a selected continuation/,
    );
  });

  it('a provider may also return a `none_with_reason` candidate directly', async () => {
    // A provider that *chooses* to encode its suppression as a real
    // candidate (rather than status='suppressed') is supported — the
    // returned-candidate path treats it like any other continuation, and
    // because priority is 0 it can still lose to a real positive candidate.
    const registry = createProviderRegistry();
    const noneCandidate = makeNoneWithReason({
      surface: 'orb_wake',
      reason: 'provider_decided_not_to_speak',
      dedupeKey: 'nwr-provider',
    });
    registry.register({
      key: 'self_silencing',
      surfaces: ['orb_wake'],
      produce: () => ({
        providerKey: 'self_silencing',
        status: 'returned',
        latencyMs: 1,
        candidate: noneCandidate,
      }),
    });
    const decision = await decideContinuation({
      surface: 'orb_wake',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    // The decision flow treats it like any other returned candidate.
    expect(decision.selectedContinuation).toBe(noneCandidate);
    expect(decision.suppressionReason).toBeUndefined(); // selected != null
    expect(isNoneWithReason(decision.selectedContinuation!)).toBe(true);
  });
});

describe('B0d.1 decideContinuation — checklist #5: contract generic across kinds', () => {
  // The contract must accommodate every reserved kind from the plan
  // without per-kind branching inside decide-continuation. We verify
  // this by registering one provider for each kind and confirming the
  // ranker picks correctly purely on priority.
  const KINDS = [
    'wake_brief',
    'next_step',
    'did_you_know',
    'feature_discovery',
    'opportunity',
    'reminder',
    'check_in',
    'offer_to_continue',
    'journey_guidance',
    'match_journey_next_move',
  ] as const;

  it.each(KINDS)(
    'accepts a returned candidate with kind="%s" with no special handling',
    async (kind) => {
      const registry = createProviderRegistry();
      const candidate: AssistantContinuation = {
        id: `${kind}-1`,
        surface: 'orb_turn_end',
        kind,
        priority: 50,
        userFacingLine: `${kind} line`,
        cta: { type: 'ask_permission' },
        evidence: [{ kind: 'demo', detail: kind }],
        dedupeKey: kind,
        privacyMode: 'safe_to_speak',
      };
      registry.register(returningProvider(kind, candidate));
      const decision = await decideContinuation({
        surface: 'orb_turn_end',
        context: {},
        registry,
        now: frozenNow(),
        newId: newIdFactory(),
      });
      expect(decision.selectedContinuation?.kind).toBe(kind);
    },
  );

  it('ranks across heterogeneous kinds purely by priority', async () => {
    const registry = createProviderRegistry();
    registry.register(
      returningProvider('reminder', {
        id: 'reminder-1',
        surface: 'orb_turn_end',
        kind: 'reminder',
        priority: 80,
        userFacingLine: 'Reminder.',
        cta: { type: 'ask_permission' },
        evidence: [],
        dedupeKey: 'rem-1',
        privacyMode: 'safe_to_speak',
      }),
    );
    registry.register(
      returningProvider('feature', {
        id: 'feature-1',
        surface: 'orb_turn_end',
        kind: 'feature_discovery',
        priority: 60,
        userFacingLine: 'Try this.',
        cta: { type: 'offer_demo' },
        evidence: [],
        dedupeKey: 'feat-1',
        privacyMode: 'safe_to_speak',
      }),
    );
    registry.register(
      returningProvider('match', {
        id: 'match-1',
        surface: 'orb_turn_end',
        kind: 'match_journey_next_move',
        priority: 95,
        userFacingLine: 'Match update.',
        cta: { type: 'navigate', route: '/matches/123' },
        evidence: [],
        dedupeKey: 'mj-1',
        privacyMode: 'safe_to_speak',
      }),
    );
    const decision = await decideContinuation({
      surface: 'orb_turn_end',
      context: {},
      registry,
      now: frozenNow(),
      newId: newIdFactory(),
    });
    expect(decision.selectedContinuation?.kind).toBe('match_journey_next_move');
  });
});

describe('B0d.1 decideContinuation — rollUpSuppressionReason helper', () => {
  it('returns no_providers_registered when zero providers ran', () => {
    expect(rollUpSuppressionReason([], 0)).toBe('no_providers_registered');
  });

  it('returns all_providers_errored when every result is errored', () => {
    expect(
      rollUpSuppressionReason(
        [
          { providerKey: 'a', status: 'errored', latencyMs: 1, reason: 'x' },
          { providerKey: 'b', status: 'errored', latencyMs: 1, reason: 'y' },
        ],
        2,
      ),
    ).toBe('all_providers_errored');
  });

  it('returns all_providers_suppressed when every result is suppressed', () => {
    expect(
      rollUpSuppressionReason(
        [
          { providerKey: 'a', status: 'suppressed', latencyMs: 1, reason: 'x' },
        ],
        1,
      ),
    ).toBe('all_providers_suppressed');
  });

  it('returns all_providers_skipped when every result is skipped', () => {
    expect(
      rollUpSuppressionReason(
        [{ providerKey: 'a', status: 'skipped', latencyMs: 0, reason: 'x' }],
        1,
      ),
    ).toBe('all_providers_skipped');
  });

  it('returns no_provider_returned_a_candidate on mixed no-fire outcomes', () => {
    expect(
      rollUpSuppressionReason(
        [
          { providerKey: 'a', status: 'suppressed', latencyMs: 1, reason: 'x' },
          { providerKey: 'b', status: 'errored', latencyMs: 1, reason: 'y' },
        ],
        2,
      ),
    ).toBe('no_provider_returned_a_candidate');
  });
});
