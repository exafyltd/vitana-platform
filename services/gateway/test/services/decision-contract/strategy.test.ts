// VTID-03130 — Phase C.1 of the decision-contract refactor.
//
// Smoke tests for the `RecommendationStrategy` / `RankProvenance`
// type surface. Pure-types contracts; the runtime assertions are mostly
// "the barrel exports these names" + "a minimal strategy implementation
// compiles and behaves as expected at runtime."

import {
  EMPTY_DECISION_CONTEXT,
  type AssistantDecisionContext,
  type PolicyResolver,
  type RankProvenance,
  type RankProvenanceComponent,
  type RecommendationCandidate,
  type RecommendationStrategy,
} from '../../../src/services/decision-contract';

const NOW = new Date('2026-05-21T12:00:00.000Z').toISOString();

function fakeResolver(): PolicyResolver {
  return {
    getValue<T>(_key: string, opts?: { defaultValue?: T }): T {
      return (opts?.defaultValue ?? (0 as unknown as T)) as T;
    },
    getRenderBlock(_key: string, _lang: string, opts?: { defaultValue?: string }): string {
      return opts?.defaultValue ?? '';
    },
    refresh: async () => {},
  };
}

class MinimalStrategy implements RecommendationStrategy<RecommendationCandidate> {
  readonly id = 'minimal_v1';
  readonly version = 1;

  score(
    candidate: RecommendationCandidate,
    _ctx: AssistantDecisionContext,
    resolver: PolicyResolver,
  ): { score: number; provenance: RankProvenance } {
    const base = 5;
    const alpha = resolver.getValue<number>('test.alpha', { defaultValue: 0.5 });
    const signal = candidate.pillar === 'mental' ? 1.0 : 0.0;
    const contribution = alpha * signal;
    const score = base + contribution;
    const components: RankProvenanceComponent[] = [
      { kind: 'base', value: base },
      {
        kind: 'additive',
        name: 'mental_signal',
        weight_key: 'test.alpha',
        weight_value: alpha,
        signal,
        contribution,
      },
    ];
    return {
      score,
      provenance: {
        strategy_id: this.id,
        strategy_version: this.version,
        computed_at: NOW,
        tenant_id: null,
        components,
        final_score: score,
      },
    };
  }
}

describe('VTID-03130 Phase C.1 RecommendationStrategy + RankProvenance', () => {
  it('barrel exposes the strategy types under a single import surface', () => {
    // If any of these named imports were missing the file would fail to
    // compile, so reaching this assertion is itself the contract: a
    // single `services/decision-contract` import resolves both Phase B
    // (PolicyResolver) and Phase C (Strategy) surfaces.
    const strategy: RecommendationStrategy = new MinimalStrategy();
    expect(strategy.id).toBe('minimal_v1');
    expect(strategy.version).toBe(1);
  });

  it('strategy returns a score + provenance with byte-identical final_score', () => {
    const strategy = new MinimalStrategy();
    const out = strategy.score(
      { id: 'cand-1', pillar: 'mental' },
      EMPTY_DECISION_CONTEXT,
      fakeResolver(),
    );
    expect(out.score).toBe(5.5);
    expect(out.provenance.final_score).toBe(5.5);
  });

  it('provenance carries strategy_id + version that match the strategy', () => {
    const strategy = new MinimalStrategy();
    const out = strategy.score(
      { id: 'cand-2', pillar: 'physical' },
      EMPTY_DECISION_CONTEXT,
      fakeResolver(),
    );
    expect(out.provenance.strategy_id).toBe(strategy.id);
    expect(out.provenance.strategy_version).toBe(strategy.version);
  });

  it('component kinds compile as a discriminated union', () => {
    // Type-level check expressed at runtime via the discriminator.
    const components: ReadonlyArray<RankProvenanceComponent> = [
      { kind: 'base', value: 1 },
      {
        kind: 'additive',
        name: 'a',
        weight_key: 'k',
        weight_value: 0.5,
        signal: 1,
        contribution: 0.5,
      },
      {
        kind: 'multiplier',
        name: 'b',
        weight_key: 'k2',
        weight_value: 1.3,
        applied: true,
        contribution_multiplier: 1.3,
      },
      {
        kind: 'clamp',
        name: 'c',
        before: 9,
        after: 5,
        reason: 'pillar_quota',
      },
    ];
    const kinds = components.map((c) => c.kind);
    expect(kinds).toEqual(['base', 'additive', 'multiplier', 'clamp']);
  });

  it('signature accepts the canonical resolver shape from Phase B', () => {
    // Catches a regression where the strategy.ts type drifts from the
    // PolicyResolver interface (e.g. someone adds a required field).
    const strategy = new MinimalStrategy();
    const resolver: PolicyResolver = fakeResolver();
    const ctx: AssistantDecisionContext = EMPTY_DECISION_CONTEXT;
    expect(() =>
      strategy.score({ id: 'x', pillar: null }, ctx, resolver),
    ).not.toThrow();
  });
});
