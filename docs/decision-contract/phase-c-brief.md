# Decision-Contract Phase C Brief — Pluggable Fusion + Provenance

**Status:** ready to start
**Predecessor:** Phase B (VTIDs 03113/14/16/18, latest merge `846f53ee`, 2026-05-21) — `PolicyResolver` + `decision_policy` + `policy_render_block` live on `origin/main`
**This brief lives at:** `docs/decision-contract/phase-c-brief.md` (VTID-03121)
**Target session:** the session that shipped Phase B (resolver-fluency advantage)

---

## How to use this document

If you are picking up Phase C:
1. Read this file end-to-end.
2. Re-read `docs/decision-contract/phase-b-brief.md` for the resolver patterns + "what to say NO to" list — every C rule inherits those.
3. Read `services/gateway/src/services/decision-contract/policy-resolver.ts` and `services/gateway/src/services/decision-contract/policy-keys.ts` to refresh on the exact API + key naming convention you'll extend.
4. Allocate a new VTID via `POST https://gateway.vitanaland.com/api/v1/vtid/allocate` per PR.
5. Follow the **Scope**, **Vertical proof**, and **Acceptance** sections below.

This file is the **single source of truth for Phase C intent**. If chat scrollback or conversational memory disagrees, this file wins.

---

## Why Phase C

Phase A locked the typed boundary. Phase B externalized prompt constants. **Phase C is where actual intelligence appears** — the algebraic ranker code (`rank_score = base × (1 + α × …)`) becomes a pluggable fusion strategy whose weights live in `decision_policy` and whose decisions emit a provenance trail.

Two outcomes:
1. **Tuneable without redeploy** — `alpha_pillar`, `compass_boost`, `streak_reinforcement`, etc. are versioned DB rows. A weight tweak is a single `decision_policy` insert.
2. **Auditable decisions** — every recommendation carries a JSONB `rank_provenance` field naming which signals contributed, which weight rows fed in, and the contribution of each. Humans can answer "why was X ranked above Y?" by reading one row.

Without this, "no hard-coding" is half-done — the prompt is tunable but the *rank order in front of the user's eyes* is still baked into compiled TypeScript.

---

## Scope

### In scope for Phase C
- **`provenance` column** added to `autopilot_recommendations` (JSONB, nullable). No new table — keeps queries fast.
- **`RecommendationStrategy` interface** in `services/gateway/src/services/decision-contract/` matching:
  ```ts
  interface RecommendationStrategy {
    readonly id: string;             // e.g. 'pillar_weighter_v1'
    readonly version: number;
    score(
      candidate: RecommendationCandidate,
      ctx: AssistantDecisionContext,
      resolver: PolicyResolver,
    ): { score: number; provenance: RankProvenance };
  }
  ```
- **`PillarWeighterStrategy`** as the vertical-proof implementation. Reads every current literal in `index-pillar-weighter.ts` via `resolver.getValue<T>` with the existing values as `defaultValue` so behavior is byte-identical at rollout.
- **Seed migration** for the ranker policy keys (see seed table below).
- **Provenance emission** wired into the existing `rankBatch()` call paths so every persisted recommendation carries its rank trail.
- Tests: byte-identical parity vs. the pre-C ranker for ≥3 representative candidate fixtures per pillar; provenance shape contract tests; resolver-miss resilience.

### Out of scope for Phase C (later phases / follow-ups)
- Pluggable algorithm-swap (runtime formula interpretation, per-tenant strategy selection). Phase C ships ONE strategy that reads externalized weights. **Algorithm-swap is a Phase C follow-up**, not the keystone.
- `feed-ranker.ts` / `recommendation-generator.ts` / `marketplace-analyzer.ts` migrations. Each is its own VTID + PR after the vertical proof stabilizes. Mirrors the B.5+ pattern.
- D42 fusion engine and Context-Pack-Builder Supabase-client violations (audit carryover). Separate VTID; not blocking C.
- Provenance analytics UI / cockpit. Phase C produces the data; rendering it is a later concern.
- New fields on `AssistantDecisionContext`. Phase A owns the shape; Phase C consumes it.

### Hard rules carried over from Phase B
- Every weight read goes through `PolicyResolver.getValue<T>` with a `defaultValue` matching today's constant. **Never throws** on miss.
- New keys belong in the `POLICY_KEYS` const (or whatever `policy-keys.ts` exposes — read the file before extending).
- Cache TTL stays 15s; no synchronous DB reads at request time.
- Boundary held: no Supabase client past `services/decision-contract/`.
- Byte-identical at rollout. Parity tests pin this for the vertical proof.
- One VTID per slice; suggested breakdown below.

---

## Architecture

### `RecommendationStrategy` interface

```ts
// services/gateway/src/services/decision-contract/strategy.ts

export interface RankProvenance {
  readonly strategy_id: string;       // 'pillar_weighter_v1'
  readonly strategy_version: number;  // monotonic; bumped on signature change
  readonly computed_at: string;       // ISO-8601 (UTC)
  readonly tenant_id: string | null;  // matches the resolver lookup
  readonly components: ReadonlyArray<RankProvenanceComponent>;
  readonly final_score: number;
}

export type RankProvenanceComponent =
  | { kind: 'base'; value: number }
  | { kind: 'additive'; name: string; weight_key: string; weight_value: number; signal: number; contribution: number }
  | { kind: 'multiplier'; name: string; weight_key: string; weight_value: number; applied: boolean; contribution_multiplier: number }
  | { kind: 'clamp'; name: string; before: number; after: number; reason: string };

export interface RecommendationCandidate {
  readonly id: string;
  readonly source_ref: string | null;
  readonly pillar: 'mental' | 'physical' | 'social' | 'spiritual' | 'financial' | null;
  // ...whatever else the existing candidate shape carries
}

export interface RecommendationStrategy {
  readonly id: string;
  readonly version: number;
  score(
    candidate: RecommendationCandidate,
    ctx: AssistantDecisionContext,
    resolver: PolicyResolver,
  ): { score: number; provenance: RankProvenance };
}
```

Discipline:
- `provenance.components` is append-only within a `score()` call. Never mutate a component after pushing.
- `RankProvenance` is the persisted shape. Adding a new component `kind` requires bumping `strategy_version` so historical traces remain interpretable.
- `weight_key` is the literal `POLICY_KEYS` string — full-roundtripable lookup.

### `provenance` column on `autopilot_recommendations`

```sql
ALTER TABLE autopilot_recommendations
  ADD COLUMN provenance JSONB;

-- Optional index for analytics later (don't add now if rec table is large):
-- CREATE INDEX ON autopilot_recommendations USING GIN (provenance);
```

Nullable so existing rows survive. New rows from the migrated ranker always populate it.

### Policy key naming

Mirror the B convention. All ranker weights live under `ranker.<consumer>.<name>`:

```
ranker.pillar_weighter.alpha_pillar              → number, default 0.5
ranker.pillar_weighter.alpha_wave                → number, default 0.3
ranker.pillar_weighter.compass_boost             → number, default 1.3
ranker.pillar_weighter.pillar_quota_max          → number, default 0.40
ranker.pillar_weighter.weakest_quota_max         → number, default 0.60
ranker.pillar_weighter.completion_dampener       → number, default 0.30
ranker.pillar_weighter.plan_dampener             → number, default 0.30
ranker.pillar_weighter.rejection_dampener_alpha  → number, default 0.50
ranker.pillar_weighter.streak_reinforcement      → number, default 1.30
ranker.pillar_weighter.community_momentum_boost  → number, default 1.20
ranker.pillar_weighter.balance_unbalanced_at     → number, default 0.70
ranker.pillar_weighter.balance_amplify_at        → number, default 0.90
ranker.pillar_weighter.balance_amplify_factor    → number, default 1.20
ranker.pillar_weighter.journey_mode_day_break_1  → number, default 7
ranker.pillar_weighter.journey_mode_day_break_2  → number, default 30
ranker.pillar_weighter.journey_mode_day_break_3  → number, default 90
ranker.pillar_weighter.journey_mode_decay_1to2   → number, default 0.5
ranker.pillar_weighter.journey_mode_decay_2to3   → number, default 0.3
ranker.pillar_weighter.journey_mode_terminal     → number, default 0.2
ranker.pillar_weighter.compass_decay_subtract    → number, default 0.1
ranker.pillar_weighter.pillar_score_cap          → number, default 200
```

All from the audit. **Match values byte-for-byte** when seeding.

---

## Vertical proof: `index-pillar-weighter.ts`

**Pick:** `services/gateway/src/services/recommendation-engine/ranking/index-pillar-weighter.ts`.

Why this consumer first:
- Highest hard-coded-constant count in the audit (21 thresholds + weights + breakpoints).
- Keystone of the Ultimate Goal alignment ranking — provenance has the most direct visibility value.
- Already well-tested (existing characterization tests will lock byte-identical behavior).
- Touches only one file in code; one PR scope stays manageable.

Out of scope for the vertical proof (do as separate VTIDs after C.2 stabilizes):
- `feed-ranker.ts` (12 weight literals)
- `recommendation-generator.ts` (signal→impact maps, LLM confidence ladder)
- `marketplace-analyzer.ts` (ingredient rank curve, evidence multipliers)
- `community-user-analyzer.ts` (weakness threshold 80, decline gate ≥10)

---

## Seed values for the vertical proof

From the audit, file:line citations included so the parallel session can verify before seeding. **Seed exactly these values** — behavior is byte-identical at rollout if you do.

`services/gateway/src/services/recommendation-engine/ranking/index-pillar-weighter.ts`:

| Line | Constant | Value | `policy_key` |
|---|---|---|---|
| 88 | `alpha_pillar` | 0.5 | `ranker.pillar_weighter.alpha_pillar` |
| 89 | `alpha_wave` | 0.3 | `ranker.pillar_weighter.alpha_wave` |
| 90 | `compass_boost` | 1.3 | `ranker.pillar_weighter.compass_boost` |
| 91 | `pillar_quota_max` | 0.40 | `ranker.pillar_weighter.pillar_quota_max` |
| 92 | `weakest_quota_max` | 0.60 | `ranker.pillar_weighter.weakest_quota_max` |
| 93 | `completion_dampener` | 0.30 | `ranker.pillar_weighter.completion_dampener` |
| 94 | `plan_dampener` | 0.30 | `ranker.pillar_weighter.plan_dampener` |
| 95 | `rejection_dampener_alpha` | 0.50 | `ranker.pillar_weighter.rejection_dampener_alpha` |
| 96 | `streak_reinforcement` | 1.30 | `ranker.pillar_weighter.streak_reinforcement` |
| 97 | `community_momentum_boost` | 1.20 | `ranker.pillar_weighter.community_momentum_boost` |
| 241–257 | journey-mode curve | breakpoints 7/30/90; decays 1.0/0.5/0.2 | `journey_mode_day_break_1/2/3` + `journey_mode_decay_1to2/2to3` + `journey_mode_terminal` |
| 255 | compass override decrement | 0.1 | `ranker.pillar_weighter.compass_decay_subtract` |
| 270–286 | pillar score cap | 200 | `ranker.pillar_weighter.pillar_score_cap` |
| 280 | balance amplification factor | 1.2 | `ranker.pillar_weighter.balance_amplify_factor` |
| 279, 388 | balance thresholds | 0.7 / 0.9 | `ranker.pillar_weighter.balance_unbalanced_at` + `balance_amplify_at` |

Total: 21 `decision_policy` rows (global default, `tenant_id IS NULL`, `version = 1`).

---

## Acceptance criteria

Before opening the Phase C vertical-proof PR:
- [ ] `provenance` column migration applies cleanly.
- [ ] Seed migration inserts all 21 `decision_policy` rows.
- [ ] `PillarWeighterStrategy` implements `RecommendationStrategy` with every formula constant read through `resolver.getValue<T>` — `grep '0\.[0-9]\|1\.[0-9]\|200' services/gateway/src/services/recommendation-engine/ranking/index-pillar-weighter.ts` shows zero remaining numeric literals matching policy values (defaults in `getValue` calls don't count if they're alongside the lookup).
- [ ] Existing characterization tests for `index-pillar-weighter.ts` still pass byte-identically.
- [ ] New parity tests: ≥3 candidate fixtures per pillar × 5 pillars = 15+ tests showing score = pre-C reference.
- [ ] New provenance shape tests: each component kind appears at least once across the fixtures; `final_score` matches the summed components.
- [ ] Resolver-miss tests: when `configurePolicyResolverForTests` returns no rows, scoring still works (defaultValue path) and provenance reflects "default" sourcing.
- [ ] `npm run build` clean.
- [ ] `npx jest test/services/decision-contract test/services/recommendation-engine` green.

Before merging:
- [ ] Re-grep `origin/main` for the Phase C VTID(s) to confirm no collision.
- [ ] `DATABASE_SCHEMA.md` updated with the new `autopilot_recommendations.provenance` column.

Post-merge:
- [ ] EXEC-DEPLOY succeeds.
- [ ] RUN-MIGRATION runs + reports row count matching the seed migration.
- [ ] `/alive` returns 200 JSON.
- [ ] One smoke run of an autopilot generation flow produces recommendations whose `provenance` column is non-null + parses as `RankProvenance`.

---

## Suggested PR breakdown (each its own VTID)

1. **C.1** — `provenance` column migration on `autopilot_recommendations` + `RankProvenance` / `RecommendationStrategy` types in `services/decision-contract/`. Pure types + schema; no behavior change.
2. **C.2** — Seed migration for the 21 ranker policy keys. Tables now have data nothing reads.
3. **C.3** — `PillarWeighterStrategy` implementation + boot wiring + parity tests. **Behavior is byte-identical** vs. pre-C ranker.
4. **C.4** — Wire `rankBatch()` (or wherever the ranker is invoked) to call the new strategy and persist `provenance` to the DB column. Production smoke covers this.

After C.4 lands and is stable (≥1 production session of clean autopilot generation):
- C.5 — migrate `feed-ranker.ts` (12 literals).
- C.6 — migrate `recommendation-generator.ts` signal→impact maps.
- C.7 — migrate `marketplace-analyzer.ts` (ingredient rank curve + evidence multipliers + price-budget alignment).
- C.8 — migrate `community-user-analyzer.ts` (weakness threshold + decline gate + onboarding stage templates).

---

## What to keep saying NO to

- **NO** inventing a runtime formula interpreter to fulfill "swappable strategies." Phase C ships ONE strategy reading externalized weights. Algorithm-swap is a follow-up.
- **NO** changing the existing `rankBatch()` return shape. The new `provenance` is a *side-channel* persisted to DB; callers see the same score.
- **NO** synchronous DB reads on the hot path. Provenance assembly uses already-warmed resolver values; the persistence write is async/batched same as the rest of `rankBatch()`.
- **NO** stringly-typed weight keys outside `POLICY_KEYS` (or whatever B.3 named the const). Extend that const, don't sprinkle string literals.
- **NO** adding new slices to `AssistantDecisionContext`. The contract shape is Phase A's job; Phase C consumes existing slices.
- **NO** breaking existing characterization tests "to be modernized." If a test was green pre-C and fails post-C, the migration regressed — fix the migration, don't update the snapshot.
- **NO** writing one mega-PR for C.3 + C.4. Split per the breakdown above so review is bounded.

---

## References

- Phase A barrel: `services/gateway/src/services/decision-contract/index.ts`
- Phase B resolver: `services/gateway/src/services/decision-contract/policy-resolver.ts`
- Phase B keys: `services/gateway/src/services/decision-contract/policy-keys.ts`
- Phase B brief (resolver patterns): `docs/decision-contract/phase-b-brief.md`
- Phase B shipped detail: memory `project_phase_b_decision_contract_shipped.md`
- Audit source: memory `project_decision_contract_full_plan.md` + originating thread
- Vertical proof target: `services/gateway/src/services/recommendation-engine/ranking/index-pillar-weighter.ts`
