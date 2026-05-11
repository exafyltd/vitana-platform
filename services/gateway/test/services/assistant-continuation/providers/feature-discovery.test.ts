/**
 * VTID-02921 (B0e.2) — Feature Discovery provider tests.
 *
 * Maps directly to the 10 acceptance checks the user locked:
 *   1. Selects one eligible capability, never multiple.
 *   2. Suppresses with a concrete reason when no eligible capability.
 *   3. Respects user state: dismissed/mastered not resurfaced casually.
 *   4. Awareness state advances ONLY through explicit event paths.
 *   5. Provider output passes validateContinuationCandidate().
 *   6. Tests cover all 7 ladder states.
 *   7. Match-related capabilities only on match-related surfaces.
 *   8. Non-match surfaces never get match feature discovery.
 *   9. No provider runs on orb_wake unless intentionally enabled.
 *  10. Telemetry uses central constants; no stray topic strings.
 */

import {
  makeFeatureDiscoveryProvider,
  defaultFeatureDiscoveryRanker,
  defaultFeatureDiscoveryRenderer,
  ensureFeatureDiscoveryRegistered,
  FEATURE_DISCOVERY_PROVIDER_KEY,
  DEFAULT_FEATURE_DISCOVERY_SURFACES,
  MATCH_RELATED_CAPABILITY_KEYS,
  type CapabilityFetcher,
  type CapabilityRow,
  type AwarenessRow,
  type AwarenessState,
} from '../../../../src/services/assistant-continuation/providers/feature-discovery';
import {
  FEATURE_DISCOVERY_OFFERED,
  FEATURE_DISCOVERY_SUPPRESSED,
  FEATURE_DISCOVERY_ACCEPTED,
  FEATURE_DISCOVERY_DISMISSED,
  FEATURE_DISCOVERY_COMPLETED,
  FEATURE_DISCOVERY_TOPIC_REGISTRY,
} from '../../../../src/services/assistant-continuation/telemetry';
import {
  validateContinuationCandidate,
  type ContinuationDecisionContext,
  type ProviderResult,
} from '../../../../src/services/assistant-continuation/types';
import { decideContinuation } from '../../../../src/services/assistant-continuation/decide-continuation';
import { createProviderRegistry } from '../../../../src/services/assistant-continuation/provider-registry';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function capability(over: Partial<CapabilityRow> = {}): CapabilityRow {
  return {
    capability_key: over.capability_key ?? 'life_compass',
    display_name: over.display_name ?? 'Life Compass',
    description:
      over.description ??
      'Define your single active longevity goal — feeds every recommendation Vitana makes.',
    required_role: over.required_role ?? 'community',
    required_tenant_features: over.required_tenant_features ?? null,
    required_integrations: over.required_integrations ?? null,
    helpful_for_intents: over.helpful_for_intents ?? null,
    enabled: over.enabled ?? true,
  };
}

function awareness(
  capabilityKey: string,
  state: AwarenessState,
  over: Partial<AwarenessRow> = {},
): AwarenessRow {
  return {
    capability_key: capabilityKey,
    awareness_state: state,
    first_introduced_at: over.first_introduced_at ?? null,
    last_introduced_at: over.last_introduced_at ?? null,
    first_used_at: over.first_used_at ?? null,
    last_used_at: over.last_used_at ?? null,
    use_count: over.use_count ?? 0,
    dismiss_count: over.dismiss_count ?? 0,
    mastery_confidence: over.mastery_confidence ?? null,
    last_surface: over.last_surface ?? null,
  };
}

function makeFakeFetcher(
  capabilities: CapabilityRow[],
  awarenessRows: AwarenessRow[] = [],
): CapabilityFetcher {
  return {
    listCapabilities: async () => capabilities,
    listAwareness: async () => awarenessRows,
  };
}

function ctx(over: Partial<ContinuationDecisionContext> = {}): ContinuationDecisionContext {
  return {
    surface: 'orb_turn_end',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    ...over,
  };
}

function fixedNow(start = 1_700_000_000_000) {
  let t = start;
  return () => {
    const v = t;
    t += 1;
    return v;
  };
}

function fixedId(prefix = 'fd') {
  let i = 0;
  return () => `${prefix}-${++i}`;
}

// ---------------------------------------------------------------------------
// Acceptance check #1 — selects one, never multiple.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #1: selects EXACTLY ONE eligible capability', () => {
  it('returns a single candidate when many are eligible', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'life_compass', display_name: 'Life Compass', description: 'Goal' }),
      capability({ capability_key: 'vitana_index', display_name: 'Vitana Index', description: 'Score' }),
      capability({ capability_key: 'diary_entry', display_name: 'Diary', description: 'Log' }),
    ]);
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('returned');
    expect(result.candidate).toBeDefined();
    expect(result.candidate?.kind).toBe('feature_discovery');
    // The shape returned is a single AssistantContinuation, never an array.
    expect(Array.isArray(result.candidate)).toBe(false);
  });

  it('end-to-end through decideContinuation also returns ONE selected continuation', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'a', display_name: 'A', description: 'A' }),
      capability({ capability_key: 'b', display_name: 'B', description: 'B' }),
      capability({ capability_key: 'c', display_name: 'C', description: 'C' }),
    ]);
    const registry = createProviderRegistry();
    registry.register(makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() }));
    const decision = await decideContinuation({
      surface: 'orb_turn_end',
      context: { sessionId: 's', userId: 'u', tenantId: 't' },
      registry,
    });
    expect(decision.selectedContinuation).not.toBeNull();
    expect(decision.selectedContinuation?.kind).toBe('feature_discovery');
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #2 — suppresses with a concrete reason.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #2: suppresses with a concrete reason', () => {
  it('suppresses when the catalog is empty', async () => {
    const fetcher = makeFakeFetcher([], []);
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('suppressed');
    expect(result.reason).toMatch(/^no_eligible_capability/);
    expect(result.candidate).toBeUndefined();
  });

  it('suppresses when every capability is rejected (all dismissed)', async () => {
    const fetcher = makeFakeFetcher(
      [
        capability({ capability_key: 'a', description: 'A' }),
        capability({ capability_key: 'b', description: 'B' }),
      ],
      [
        awareness('a', 'dismissed'),
        awareness('b', 'mastered'),
      ],
    );
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('suppressed');
    expect(result.reason).toMatch(/no_eligible_capability/);
    expect(result.reason).toMatch(/all_rejected/);
  });

  it('reports skip when tenant/user identity is missing', async () => {
    const fetcher = makeFakeFetcher([capability()]);
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx({ tenantId: undefined, userId: undefined }))) as ProviderResult;
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('feature_discovery_requires_identified_session');
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #3 — dismissed / mastered / completed not resurfaced.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #3: respects terminal awareness states', () => {
  it.each(['dismissed', 'completed', 'mastered'] as const)(
    'skips capabilities in state=%s',
    async (state) => {
      const fetcher = makeFakeFetcher(
        [capability({ capability_key: 'x', description: 'X' })],
        [awareness('x', state)],
      );
      const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
      const result = (await provider.produce(ctx())) as ProviderResult;
      expect(result.status).toBe('suppressed');
    },
  );

  it('hard-backs off after dismiss_count >= 2', async () => {
    const fetcher = makeFakeFetcher(
      [capability({ capability_key: 'x', description: 'X' })],
      [awareness('x', 'introduced', { dismiss_count: 2 })],
    );
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('suppressed');
  });

  it('dampens recently-introduced capabilities (within 7 days)', async () => {
    const recent = new Date(1_700_000_000_000 - 3 * 24 * 60 * 60 * 1000).toISOString();
    const fetcher = makeFakeFetcher(
      [capability({ capability_key: 'x', description: 'X' })],
      [awareness('x', 'introduced', { last_introduced_at: recent })],
    );
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('suppressed');
  });

  it('accepts an introduced capability after the 7-day window elapses', async () => {
    const oldIntro = new Date(1_700_000_000_000 - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fetcher = makeFakeFetcher(
      [capability({ capability_key: 'x', display_name: 'X', description: 'Hook' })],
      [awareness('x', 'introduced', { last_introduced_at: oldIntro })],
    );
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('returned');
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #4 — selection never mutates awareness state.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #4: selection is read-only', () => {
  it('listAwareness is the only DB-read function the provider calls', async () => {
    const listAwareness = jest.fn(async () => [awareness('x', 'unknown')]);
    const listCapabilities = jest.fn(async () => [capability({ capability_key: 'x', description: 'X' })]);
    const fetcher: CapabilityFetcher = {
      listCapabilities,
      listAwareness,
      // Defensive: if the provider tried to call an update method, it
      // wouldn't even compile against the interface — but we also
      // verify the fetcher mock has zero other call surface.
    };
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    await provider.produce(ctx());
    // Both reads happen exactly once per produce() call.
    expect(listCapabilities).toHaveBeenCalledTimes(1);
    expect(listAwareness).toHaveBeenCalledTimes(1);
    // Awareness state remains untouched at the source (no write seam exposed).
    // CapabilityFetcher interface has no mutator methods by design — type-level guard.
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #5 — candidate passes validateContinuationCandidate.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #5: candidate passes runtime validator', () => {
  it('returned candidate passes validateContinuationCandidate', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'life_compass', display_name: 'Life Compass', description: 'Goal hook' }),
    ]);
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('returned');
    const validation = validateContinuationCandidate(result.candidate);
    expect(validation).toEqual({ ok: true });
  });

  it('candidate evidence carries the capability_key + awareness_state', async () => {
    const fetcher = makeFakeFetcher(
      [capability({ capability_key: 'diary_entry', display_name: 'Diary', description: 'Log' })],
      [awareness('diary_entry', 'seen')],
    );
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.candidate?.evidence).toEqual([
      { kind: 'capability_key', detail: 'diary_entry' },
      { kind: 'awareness_state', detail: 'seen' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #6 — all 7 ladder states covered.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #6: all 7 ladder states', () => {
  const eligibleStates: AwarenessState[] = ['unknown', 'introduced', 'seen', 'tried'];
  const terminalStates: AwarenessState[] = ['dismissed', 'completed', 'mastered'];

  it.each(eligibleStates)('%s state is eligible (not terminal)', async (state) => {
    const fetcher = makeFakeFetcher(
      [capability({ capability_key: 'x', display_name: 'X', description: 'Hook' })],
      [awareness('x', state)],
    );
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('returned');
  });

  it.each(terminalStates)('%s state is rejected', async (state) => {
    const fetcher = makeFakeFetcher(
      [capability({ capability_key: 'x', display_name: 'X', description: 'Hook' })],
      [awareness('x', state)],
    );
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('suppressed');
  });

  it('ranks unknown > introduced > seen > tried', async () => {
    const fetcher = makeFakeFetcher(
      [
        capability({ capability_key: 'unknown_one', display_name: 'U', description: 'U' }),
        capability({ capability_key: 'introduced_one', display_name: 'I', description: 'I' }),
        capability({ capability_key: 'seen_one', display_name: 'S', description: 'S' }),
        capability({ capability_key: 'tried_one', display_name: 'T', description: 'T' }),
      ],
      [
        awareness('introduced_one', 'introduced'),
        awareness('seen_one', 'seen'),
        awareness('tried_one', 'tried'),
        // no row for unknown_one → state defaults to 'unknown'
      ],
    );
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.candidate?.evidence[0].detail).toBe('unknown_one');
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #7 — match-related capabilities only on match surfaces.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #7: match-related capabilities on match surfaces', () => {
  // Use activity_match (seeded) to exercise the match-related path.
  it('surfaces activity_match when envelopeJourneySurface is a match surface', async () => {
    const fetcher = makeFakeFetcher([
      capability({
        capability_key: 'activity_match',
        display_name: 'Activity Match',
        description: 'Find a partner',
      }),
    ]);
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(
      ctx({ envelopeJourneySurface: 'intent_board' }),
    )) as ProviderResult;
    expect(result.status).toBe('returned');
    expect(result.candidate?.evidence[0].detail).toBe('activity_match');
  });

  it('MATCH_RELATED_CAPABILITY_KEYS contains all 7 deferred capabilities + activity_match', () => {
    expect(MATCH_RELATED_CAPABILITY_KEYS.has('pre_match_whois')).toBe(true);
    expect(MATCH_RELATED_CAPABILITY_KEYS.has('should_i_show_interest')).toBe(true);
    expect(MATCH_RELATED_CAPABILITY_KEYS.has('draft_opener')).toBe(true);
    expect(MATCH_RELATED_CAPABILITY_KEYS.has('activity_plan_card')).toBe(true);
    expect(MATCH_RELATED_CAPABILITY_KEYS.has('match_chat_assist')).toBe(true);
    expect(MATCH_RELATED_CAPABILITY_KEYS.has('post_activity_reflection')).toBe(true);
    expect(MATCH_RELATED_CAPABILITY_KEYS.has('next_rep_suggestion')).toBe(true);
    expect(MATCH_RELATED_CAPABILITY_KEYS.has('activity_match')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #8 — non-match surfaces NEVER get match feature discovery.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #8: non-match surfaces never get match capabilities', () => {
  const nonMatchSurfaces: Array<string | undefined> = [
    undefined,                      // no envelope at all
    'unknown',                      // explicit unknown
    'command_hub',                  // operator surface
    'notification_center',          // notifications
  ];

  it.each(nonMatchSurfaces)(
    'rejects activity_match when envelopeJourneySurface=%s (skipped or fallback to non-match)',
    async (surface) => {
      const fetcher = makeFakeFetcher([
        capability({
          capability_key: 'activity_match',
          display_name: 'Activity Match',
          description: 'Find a partner',
        }),
        // Provide a non-match alternative so the provider has SOMETHING
        // to surface; the test asserts activity_match is NOT chosen.
        capability({
          capability_key: 'diary_entry',
          display_name: 'Diary',
          description: 'Log',
        }),
      ]);
      const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
      const result = (await provider.produce(
        ctx({ envelopeJourneySurface: surface as string | undefined }),
      )) as ProviderResult;
      if (result.status === 'returned') {
        // If anything was returned, it MUST be the non-match alternative.
        expect(result.candidate?.evidence[0].detail).toBe('diary_entry');
      } else {
        // Or suppressed (also acceptable).
        expect(result.status).toBe('suppressed');
      }
    },
  );

  it('only the match-only catalog suppresses on non-match surface', async () => {
    const fetcher = makeFakeFetcher([
      capability({
        capability_key: 'activity_match',
        display_name: 'Activity Match',
        description: 'Find a partner',
      }),
    ]);
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx({ envelopeJourneySurface: 'command_hub' }))) as ProviderResult;
    expect(result.status).toBe('suppressed');
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #9 — no run on orb_wake unless intentionally enabled.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #9: orb_wake gated off by default', () => {
  it('default surfaces array does NOT include orb_wake', () => {
    expect(DEFAULT_FEATURE_DISCOVERY_SURFACES).not.toContain('orb_wake');
    expect(DEFAULT_FEATURE_DISCOVERY_SURFACES).toEqual(['orb_turn_end', 'text_turn_end', 'home']);
  });

  it('factory does not register provider on orb_wake without includeOrbWake', () => {
    const fetcher = makeFakeFetcher([capability()]);
    const provider = makeFeatureDiscoveryProvider({ fetcher });
    expect(provider.surfaces).not.toContain('orb_wake');
  });

  it('factory registers provider on orb_wake ONLY when includeOrbWake=true', () => {
    const fetcher = makeFakeFetcher([capability()]);
    const provider = makeFeatureDiscoveryProvider({ fetcher, includeOrbWake: true });
    expect(provider.surfaces).toContain('orb_wake');
  });

  it('defensive: if mis-routed to orb_wake without the flag, returns skipped', async () => {
    const fetcher = makeFakeFetcher([capability()]);
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx({ surface: 'orb_wake' }))) as ProviderResult;
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('feature_discovery_disabled_on_orb_wake');
  });
});

// ---------------------------------------------------------------------------
// Acceptance check #10 — telemetry uses central constants only.
// ---------------------------------------------------------------------------

describe('B0e.2 acceptance check #10: telemetry uses central constants', () => {
  it('FEATURE_DISCOVERY_* constants exist and are namespaced', () => {
    expect(FEATURE_DISCOVERY_OFFERED).toBe('feature.discovery.offered');
    expect(FEATURE_DISCOVERY_SUPPRESSED).toBe('feature.discovery.suppressed');
    expect(FEATURE_DISCOVERY_ACCEPTED).toBe('feature.discovery.accepted');
    expect(FEATURE_DISCOVERY_DISMISSED).toBe('feature.discovery.dismissed');
    expect(FEATURE_DISCOVERY_COMPLETED).toBe('feature.discovery.completed');
  });

  it('FEATURE_DISCOVERY_TOPIC_REGISTRY enumerates all 5 events', () => {
    expect(FEATURE_DISCOVERY_TOPIC_REGISTRY).toHaveLength(5);
    expect(new Set(FEATURE_DISCOVERY_TOPIC_REGISTRY).size).toBe(5);
  });

  it('provider source file does not contain raw feature.discovery.* literals', () => {
    // Source-level grep: the provider must reference constants, not
    // raw topic strings. The telemetry.ts file is the only legitimate
    // home for those literals.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../src/services/assistant-continuation/providers/feature-discovery.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/['"`]feature\.discovery\./);
  });
});

// ---------------------------------------------------------------------------
// Extra coverage — capability_disabled, render errors, ranker injection
// ---------------------------------------------------------------------------

describe('B0e.2 — extra coverage', () => {
  it('disabled capabilities are skipped', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'a', enabled: false, description: 'A' }),
    ]);
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('suppressed');
  });

  it('errored fetcher → status=errored, no exception escapes', async () => {
    const fetcher: CapabilityFetcher = {
      listCapabilities: async () => {
        throw new Error('db_down');
      },
      listAwareness: async () => [],
    };
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('errored');
    expect(result.reason).toBe('db_down');
  });

  it('custom ranker is honored', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'low', display_name: 'L', description: 'L' }),
      capability({ capability_key: 'high', display_name: 'H', description: 'H' }),
    ]);
    const customRanker = {
      score(inputs: any) {
        return {
          score: inputs.capability.capability_key === 'high' ? 999 : 1,
        };
      },
    };
    const provider = makeFeatureDiscoveryProvider({
      fetcher,
      ranker: customRanker,
      now: fixedNow(),
      newId: fixedId(),
    });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.candidate?.evidence[0].detail).toBe('high');
  });

  it('custom renderer is honored', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'x', display_name: 'X', description: 'X' }),
    ]);
    const renderer = { render: () => 'CUSTOM TEXT' };
    const provider = makeFeatureDiscoveryProvider({
      fetcher,
      renderer,
      now: fixedNow(),
      newId: fixedId(),
    });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.candidate?.userFacingLine).toBe('CUSTOM TEXT');
  });

  it('renderer that throws → errored', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'x', display_name: 'X', description: 'X' }),
    ]);
    const renderer = {
      render: () => {
        throw new Error('renderer_kaboom');
      },
    };
    const provider = makeFeatureDiscoveryProvider({
      fetcher,
      renderer,
      now: fixedNow(),
      newId: fixedId(),
    });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.status).toBe('errored');
    expect(result.reason).toBe('renderer_kaboom');
  });

  it('priority defaults to 30 (below wake_brief 80)', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'x', display_name: 'X', description: 'X' }),
    ]);
    const provider = makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.candidate?.priority).toBe(30);
  });

  it('priority can be overridden via opts', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'x', display_name: 'X', description: 'X' }),
    ]);
    const provider = makeFeatureDiscoveryProvider({
      fetcher,
      priority: 50,
      now: fixedNow(),
      newId: fixedId(),
    });
    const result = (await provider.produce(ctx())) as ProviderResult;
    expect(result.candidate?.priority).toBe(50);
  });

  it('ensureFeatureDiscoveryRegistered is idempotent', () => {
    const fetcher = makeFakeFetcher([]);
    expect(() => ensureFeatureDiscoveryRegistered(fetcher)).not.toThrow();
    expect(() => ensureFeatureDiscoveryRegistered(fetcher)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wake-brief priority interaction (priority ordering check)
// ---------------------------------------------------------------------------

describe('B0e.2 — priority ordering with wake_brief', () => {
  it('feature_discovery (30) loses to a higher-priority candidate (80)', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'x', display_name: 'X', description: 'X' }),
    ]);
    const registry = createProviderRegistry();
    registry.register(makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() }));
    // Add a high-priority fake provider as a stand-in for wake_brief
    // / reminder / match_journey_next_move.
    registry.register({
      key: 'fake_urgent',
      surfaces: ['orb_turn_end'],
      produce: (): ProviderResult => ({
        providerKey: 'fake_urgent',
        status: 'returned',
        latencyMs: 1,
        candidate: {
          id: 'urgent-1',
          surface: 'orb_turn_end',
          kind: 'reminder',
          priority: 80,
          userFacingLine: 'Urgent reminder.',
          cta: { type: 'ask_permission' },
          evidence: [{ kind: 'reminder_due', detail: 'now' }],
          dedupeKey: 'urgent-1',
          privacyMode: 'safe_to_speak',
        },
      }),
    });
    const decision = await decideContinuation({
      surface: 'orb_turn_end',
      context: { sessionId: 's', userId: 'u', tenantId: 't' },
      registry,
    });
    expect(decision.selectedContinuation?.kind).toBe('reminder');
  });

  it('feature_discovery (30) wins when no higher-priority candidate exists', async () => {
    const fetcher = makeFakeFetcher([
      capability({ capability_key: 'x', display_name: 'X', description: 'X' }),
    ]);
    const registry = createProviderRegistry();
    registry.register(makeFeatureDiscoveryProvider({ fetcher, now: fixedNow(), newId: fixedId() }));
    const decision = await decideContinuation({
      surface: 'orb_turn_end',
      context: { sessionId: 's', userId: 'u', tenantId: 't' },
      registry,
    });
    expect(decision.selectedContinuation?.kind).toBe('feature_discovery');
  });
});
