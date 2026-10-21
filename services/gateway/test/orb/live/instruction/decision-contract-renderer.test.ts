/**
 * VTID-02941 (B0b-min) — decision-contract-renderer tests.
 *
 * Acceptance:
 *   #3 — renderer ONLY accepts AssistantDecisionContext, never raw
 *        compiler output. Enforced by source-level scan + by behavior:
 *        any unrecognized field on the input is ignored (typescript
 *        rejects it at compile time; runtime ignores extras).
 *   #4 — generateSystemInstruction does NOT query memory directly. The
 *        renderer file MUST NOT import from supabase, services, or call
 *        fetch.
 *   #6 — if continuity is null, renderer emits no continuity section.
 *        When source_health is degraded, renderer emits a short hint.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  renderDecisionContract,
} from '../../../../src/orb/live/instruction/decision-contract-renderer';
import type {
  AssistantDecisionContext,
  DecisionContinuity,
} from '../../../../src/orb/context/types';

const RENDERER_PATH = join(
  __dirname,
  '../../../../src/orb/live/instruction/decision-contract-renderer.ts',
);

function emptyContinuity(): DecisionContinuity {
  return {
    open_threads: [],
    promises_owed: [],
    promises_kept_recently: [],
    counts: {
      open_threads_total: 0,
      promises_owed_total: 0,
      promises_overdue: 0,
      threads_mentioned_today: 0,
    },
    recommended_follow_up: 'none',
  };
}

function emptyContext(over: Partial<AssistantDecisionContext> = {}): AssistantDecisionContext {
  return {
    continuity: null,
    concept_mastery: null,
    journey_stage: null,
    pillar_momentum: null,
    interaction_style: null,
    source_health: {
      continuity: { ok: true },
      concept_mastery: { ok: true },
      journey_stage: { ok: true },
      pillar_momentum: { ok: true },
      interaction_style: { ok: true },
    },
    ...over,
  };
}

describe('B0b-min — decision-contract-renderer', () => {
  describe('purity — wall enforcement (acceptance #4)', () => {
    let src: string;
    beforeAll(() => {
      src = readFileSync(RENDERER_PATH, 'utf8');
    });

    it('does not import from services/', () => {
      expect(src).not.toMatch(/from\s+['"][^'"]*\.\.\/\.\.\/\.\.\/services\//);
      expect(src).not.toMatch(/from\s+['"][^'"]*services\/continuity/);
    });

    it('does not import supabase or any DB client', () => {
      // Walk only non-comment lines so the wall-comment doesn't trip
      // the source-level guard (the comment mentions "Supabase" by
      // name precisely BECAUSE it must not be imported).
      const nonComment = src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
        .join('\n');
      expect(nonComment).not.toMatch(/\bgetSupabase\b/);
      expect(nonComment).not.toMatch(/from\s+['"][^'"]*lib\/supabase/);
    });

    it('does not call fetch / axios / rpc', () => {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toMatch(/\baxios\b/);
      expect(src).not.toMatch(/\.rpc\(/);
    });

    it('only imports types from orb/context', () => {
      // Renderer must depend on the contract, never on the implementation.
      expect(src).toMatch(/from\s+['"]\.\.\/\.\.\/context\/types['"]/);
    });
  });

  describe('empty/degrades safely (acceptance #1 + #6)', () => {
    it('returns empty string when continuity is null and source is healthy', () => {
      const out = renderDecisionContract(emptyContext());
      expect(out).toBe('');
    });

    it('emits a degraded hint when continuity is null AND source_health is degraded', () => {
      const out = renderDecisionContract(
        emptyContext({
          source_health: {
            continuity: { ok: false, reason: 'supabase_unconfigured' },
            concept_mastery: { ok: true },
            journey_stage: { ok: true },
            pillar_momentum: { ok: true },
            interaction_style: { ok: true },
          },
        }),
      );
      expect(out).toContain('continuity: source degraded');
      expect(out).toContain('supabase_unconfigured');
    });

    it('emits empty string when continuity surfaces are all empty AND source is healthy', () => {
      const out = renderDecisionContract(
        emptyContext({ continuity: emptyContinuity() }),
      );
      expect(out).toBe('');
    });
  });

  describe('renders distilled surfaces', () => {
    it('renders open threads with age + summary', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              {
                thread_id: 't1',
                topic: 'magnesium dosage',
                summary: 'follow-up on the new bottle',
                days_since_last_mention: 3,
              },
            ],
          },
        }),
      );
      expect(out).toContain('Open threads:');
      expect(out).toContain('magnesium dosage');
      expect(out).toContain('3d since last mention');
      expect(out).toContain('follow-up on the new bottle');
    });

    it('renders promises_owed with overdue tag', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            promises_owed: [
              {
                promise_id: 'p1',
                promise_text: 'send the doc',
                overdue: true,
                decision_id: null,
              },
            ],
          },
        }),
      );
      expect(out).toContain('Promises owed:');
      expect(out).toContain('send the doc [overdue]');
    });

    it('renders recommended_follow_up when not "none"', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              { thread_id: 't', topic: 'x', summary: null, days_since_last_mention: 1 },
            ],
            recommended_follow_up: 'mention_open_thread',
          },
        }),
      );
      expect(out).toContain('Recommended follow-up: mention_open_thread');
    });

    it('omits recommended_follow_up when "none"', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              { thread_id: 't', topic: 'x', summary: null, days_since_last_mention: 1 },
            ],
            recommended_follow_up: 'none',
          },
        }),
      );
      expect(out).not.toContain('Recommended follow-up');
    });
  });

  describe('header behavior', () => {
    it('emits header by default', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              { thread_id: 't', topic: 'x', summary: null, days_since_last_mention: 0 },
            ],
          },
        }),
      );
      expect(out.startsWith('Assistant decision contract:\n')).toBe(true);
    });

    it('omits header when withHeader=false', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            ...emptyContinuity(),
            open_threads: [
              { thread_id: 't', topic: 'x', summary: null, days_since_last_mention: 0 },
            ],
          },
        }),
        { withHeader: false },
      );
      expect(out.startsWith('Assistant decision contract:\n')).toBe(false);
      expect(out).toContain('Continuity:');
    });
  });

  describe('raw-field ignorance (acceptance #3 + #7)', () => {
    it('extra unknown fields injected at runtime are NOT surfaced in output', () => {
      // TypeScript would reject this at compile time; we cast to test
      // runtime behavior. The renderer reads only declared fields.
      const sneakyContinuity = {
        ...emptyContinuity(),
        open_threads: [
          {
            thread_id: 't',
            topic: 'short topic',
            summary: null,
            days_since_last_mention: 0,
            // raw fields a future bug might forward:
            last_mentioned_at: '2026-05-10T12:00:00Z',
            session_id_first: 'sess-A',
            session_id_last: 'sess-B',
            raw_message: 'user said this exact sentence',
          },
        ],
      } as unknown as DecisionContinuity;

      const out = renderDecisionContract(emptyContext({ continuity: sneakyContinuity }));
      expect(out).not.toContain('2026-05-10T12:00:00Z');
      expect(out).not.toContain('sess-A');
      expect(out).not.toContain('user said this exact sentence');
    });
  });

  // F2: concept-mastery rendering + degraded handling + raw-field ignorance.
  describe('concept mastery (F2)', () => {
    function emptyConcept() {
      return {
        concepts_explained: [] as any[],
        concepts_mastered: [] as any[],
        dyk_cards_seen: [] as any[],
        counts: {
          concepts_explained_total: 0,
          concepts_mastered_total: 0,
          dyk_cards_seen_total: 0,
          concepts_explained_in_last_24h: 0,
        },
        recommended_cadence: 'none' as const,
      };
    }

    it('returns empty string when both fields null and both sources healthy', () => {
      expect(renderDecisionContract(emptyContext())).toBe('');
    });

    it('emits degraded hint when concept_mastery null AND source degraded', () => {
      const out = renderDecisionContract(
        emptyContext({
          source_health: {
            continuity: { ok: true },
            concept_mastery: { ok: false, reason: 'supabase_unconfigured' },
            journey_stage: { ok: true },
            pillar_momentum: { ok: true },
            interaction_style: { ok: true },
          },
        }),
      );
      expect(out).toContain('concept_mastery: source degraded');
      expect(out).toContain('supabase_unconfigured');
    });

    it('renders explained concepts with bucket + hint + recency', () => {
      const out = renderDecisionContract(
        emptyContext({
          concept_mastery: {
            ...emptyConcept(),
            concepts_explained: [{
              concept_key: 'vitana_index',
              frequency: 'twice',
              days_since_last_explained: 2,
              repetition_hint: 'one_liner',
            }],
          },
        }),
      );
      expect(out).toContain('Concept mastery:');
      expect(out).toContain('Concepts explained:');
      expect(out).toContain('vitana_index [twice, hint=one_liner] (2d ago)');
    });

    it('renders mastered concepts with bucketed confidence', () => {
      const out = renderDecisionContract(
        emptyContext({
          concept_mastery: {
            ...emptyConcept(),
            concepts_mastered: [{
              concept_key: 'life_compass',
              confidence: 'high',
            }],
          },
        }),
      );
      expect(out).toContain('Concepts mastered:');
      expect(out).toContain('life_compass [confidence=high]');
    });

    it('renders DYK cards with bucket + recency', () => {
      const out = renderDecisionContract(
        emptyContext({
          concept_mastery: {
            ...emptyConcept(),
            dyk_cards_seen: [{
              card_key: 'dyk_index_intro',
              frequency: 'once',
              days_since_last_seen: 5,
            }],
          },
        }),
      );
      expect(out).toContain('DYK cards seen:');
      expect(out).toContain('dyk_index_intro [once] (5d ago)');
    });

    it('renders recommended_cadence when non-none', () => {
      const out = renderDecisionContract(
        emptyContext({
          concept_mastery: {
            ...emptyConcept(),
            concepts_explained: [{
              concept_key: 'x',
              frequency: 'many',
              days_since_last_explained: 1,
              repetition_hint: 'skip',
            }],
            recommended_cadence: 'suppress_over_explained',
          },
        }),
      );
      expect(out).toContain('Recommended cadence: suppress_over_explained');
    });

    it('omits cadence line when "none"', () => {
      const out = renderDecisionContract(
        emptyContext({
          concept_mastery: {
            ...emptyConcept(),
            concepts_explained: [{
              concept_key: 'x',
              frequency: 'once',
              days_since_last_explained: null,
              repetition_hint: 'one_liner',
            }],
            recommended_cadence: 'none',
          },
        }),
      );
      expect(out).not.toContain('Recommended cadence');
    });

    it('raw-field ignorance: smuggled raw fields are NOT in output', () => {
      const sneakyConcept = {
        concepts_explained: [{
          concept_key: 'vitana_index',
          frequency: 'once',
          days_since_last_explained: 1,
          repetition_hint: 'one_liner',
          // smuggled raw fields:
          last_explained_at: '2026-05-12T12:00:00Z',
          count: 42,
          raw_score: 0.851234,
        }],
        concepts_mastered: [{
          concept_key: 'm',
          confidence: 'medium',
          // smuggled:
          last_observed_at: '2026-05-11T08:00:00Z',
          raw_confidence_float: 0.85,
        }],
        dyk_cards_seen: [{
          card_key: 'd',
          frequency: 'many',
          days_since_last_seen: 3,
          // smuggled:
          last_seen_at: '2026-05-09T20:00:00Z',
        }],
        counts: {
          concepts_explained_total: 1,
          concepts_mastered_total: 1,
          dyk_cards_seen_total: 1,
          concepts_explained_in_last_24h: 0,
        },
        recommended_cadence: 'use_one_liner' as const,
      };
      const out = renderDecisionContract(
        emptyContext({ concept_mastery: sneakyConcept as any }),
      );
      expect(out).not.toContain('2026-05-12T12:00:00Z');
      expect(out).not.toContain('2026-05-11T08:00:00Z');
      expect(out).not.toContain('2026-05-09T20:00:00Z');
      expect(out).not.toContain('0.851234');
      expect(out).not.toContain('0.85');
      expect(out).not.toContain('42'); // raw count
    });
  });

  describe('both sections coexist', () => {
    it('renders continuity then concept_mastery, in that order', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            open_threads: [
              { thread_id: 't1', topic: 'magnesium', summary: null, days_since_last_mention: 1 },
            ],
            promises_owed: [],
            promises_kept_recently: [],
            counts: {
              open_threads_total: 1,
              promises_owed_total: 0,
              promises_overdue: 0,
              threads_mentioned_today: 0,
            },
            recommended_follow_up: 'mention_open_thread',
          },
          concept_mastery: {
            concepts_explained: [{
              concept_key: 'vitana_index',
              frequency: 'once',
              days_since_last_explained: 2,
              repetition_hint: 'one_liner',
            }],
            concepts_mastered: [],
            dyk_cards_seen: [],
            counts: {
              concepts_explained_total: 1,
              concepts_mastered_total: 0,
              dyk_cards_seen_total: 0,
              concepts_explained_in_last_24h: 0,
            },
            recommended_cadence: 'use_one_liner',
          },
        }),
      );
      const continuityIdx = out.indexOf('Continuity:');
      const conceptIdx = out.indexOf('Concept mastery:');
      expect(continuityIdx).toBeGreaterThan(-1);
      expect(conceptIdx).toBeGreaterThan(-1);
      expect(continuityIdx).toBeLessThan(conceptIdx);
    });
  });

  // F3: journey-stage rendering + degraded handling + raw-field ignorance.
  describe('journey stage (F3)', () => {
    function makeStage(over: any = {}): any {
      return {
        stage: 'first_session',
        tenure_bucket: 'first_session',
        explanation_depth: 'deep',
        tone_hint: 'warm_welcoming',
        vitana_index_tier: 'unknown',
        tier_tenure: 'unknown',
        activity_recency: 'unknown',
        usage_volume: 'none',
        journey_confidence: 'low',
        warnings: [],
        ...over,
      };
    }

    it('returns empty string when all three fields null and all sources healthy', () => {
      expect(renderDecisionContract(emptyContext())).toBe('');
    });

    it('emits degraded hint when journey_stage null AND source degraded', () => {
      const out = renderDecisionContract(
        emptyContext({
          source_health: {
            continuity: { ok: true },
            concept_mastery: { ok: true },
            journey_stage: { ok: false, reason: 'supabase_unconfigured' },
            pillar_momentum: { ok: true },
            interaction_style: { ok: true },
          },
        }),
      );
      expect(out).toContain('journey_stage: source degraded');
      expect(out).toContain('supabase_unconfigured');
    });

    it('renders stage + tone + depth always (core fields)', () => {
      const out = renderDecisionContract(
        emptyContext({
          journey_stage: makeStage({
            stage: 'first_week',
            tenure_bucket: 'first_week',
            explanation_depth: 'standard',
            tone_hint: 'collaborative',
          }),
        }),
      );
      expect(out).toContain('Journey stage:');
      expect(out).toContain('stage: first_week');
      expect(out).toContain('tone: collaborative');
      expect(out).toContain('explanation depth: standard');
    });

    it('renders Vitana Index tier + tenure when not unknown', () => {
      const out = renderDecisionContract(
        emptyContext({
          journey_stage: makeStage({
            vitana_index_tier: 'momentum',
            tier_tenure: 'settled',
          }),
        }),
      );
      expect(out).toContain('Vitana Index tier: momentum [settled]');
    });

    it('omits Vitana Index line when tier is unknown', () => {
      const out = renderDecisionContract(
        emptyContext({
          journey_stage: makeStage({ vitana_index_tier: 'unknown' }),
        }),
      );
      expect(out).not.toContain('Vitana Index tier');
    });

    it('renders activity_recency when not unknown', () => {
      const out = renderDecisionContract(
        emptyContext({
          journey_stage: makeStage({ activity_recency: 'recent' }),
        }),
      );
      expect(out).toContain('activity recency: recent');
    });

    it('renders usage_volume when not none', () => {
      const out = renderDecisionContract(
        emptyContext({
          journey_stage: makeStage({ usage_volume: 'regular' }),
        }),
      );
      expect(out).toContain('usage volume: regular');
    });

    it('renders warnings list when non-empty', () => {
      const out = renderDecisionContract(
        emptyContext({
          journey_stage: makeStage({
            warnings: ['long_inactivity', 'unknown_tier'],
          }),
        }),
      );
      expect(out).toContain('warnings: long_inactivity, unknown_tier');
    });

    it('omits warnings line when empty', () => {
      const out = renderDecisionContract(
        emptyContext({ journey_stage: makeStage({ warnings: [] }) }),
      );
      expect(out).not.toContain('warnings:');
    });

    it('raw-field ignorance: smuggled raw fields are NOT in output', () => {
      const sneakyStage = {
        ...makeStage({ stage: 'established', tenure_bucket: 'established' }),
        // smuggled raw fields:
        tenure_days: 365,
        last_active_date: '2026-05-10',
        score_total: 712,
        tier_days_held: 90,
        usage_days_count: 250,
        raw_profile_bio: 'user lives in Berlin and likes hiking',
      };
      const out = renderDecisionContract(
        emptyContext({ journey_stage: sneakyStage as any }),
      );
      expect(out).not.toContain('365');
      expect(out).not.toContain('2026-05-10');
      expect(out).not.toContain('712');
      expect(out).not.toContain('250');
      expect(out).not.toContain('Berlin');
      expect(out).not.toContain('hiking');
      expect(out).not.toContain('raw_profile_bio');
    });
  });

  describe('all three sections coexist', () => {
    it('renders continuity → concept_mastery → journey_stage, in that order', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            open_threads: [
              { thread_id: 't1', topic: 'magnesium', summary: null, days_since_last_mention: 1 },
            ],
            promises_owed: [],
            promises_kept_recently: [],
            counts: {
              open_threads_total: 1,
              promises_owed_total: 0,
              promises_overdue: 0,
              threads_mentioned_today: 0,
            },
            recommended_follow_up: 'mention_open_thread',
          },
          concept_mastery: {
            concepts_explained: [{
              concept_key: 'vitana_index',
              frequency: 'once',
              days_since_last_explained: 2,
              repetition_hint: 'one_liner',
            }],
            concepts_mastered: [],
            dyk_cards_seen: [],
            counts: {
              concepts_explained_total: 1,
              concepts_mastered_total: 0,
              dyk_cards_seen_total: 0,
              concepts_explained_in_last_24h: 0,
            },
            recommended_cadence: 'use_one_liner',
          },
          journey_stage: {
            stage: 'first_month',
            tenure_bucket: 'first_month',
            explanation_depth: 'standard',
            tone_hint: 'collaborative',
            vitana_index_tier: 'momentum',
            tier_tenure: 'settled',
            activity_recency: 'today',
            usage_volume: 'regular',
            journey_confidence: 'high',
            warnings: [],
          },
        }),
      );
      const continuityIdx = out.indexOf('Continuity:');
      const conceptIdx = out.indexOf('Concept mastery:');
      const journeyIdx = out.indexOf('Journey stage:');
      expect(continuityIdx).toBeGreaterThan(-1);
      expect(conceptIdx).toBeGreaterThan(-1);
      expect(journeyIdx).toBeGreaterThan(-1);
      expect(continuityIdx).toBeLessThan(conceptIdx);
      expect(conceptIdx).toBeLessThan(journeyIdx);
    });
  });

  // B5: pillar-momentum rendering + degraded handling + raw-field ignorance.
  describe('pillar momentum (B5)', () => {
    function makePillar(over: any = {}): any {
      return {
        per_pillar: [
          { pillar: 'sleep',     momentum: 'unknown' },
          { pillar: 'nutrition', momentum: 'unknown' },
          { pillar: 'exercise',  momentum: 'unknown' },
          { pillar: 'hydration', momentum: 'unknown' },
          { pillar: 'mental',    momentum: 'unknown' },
        ],
        weakest_pillar: null,
        strongest_pillar: null,
        suggested_focus: null,
        confidence: 'low',
        warnings: [],
        ...over,
      };
    }

    it('returns empty string when all four fields null and all sources healthy', () => {
      expect(renderDecisionContract(emptyContext())).toBe('');
    });

    it('emits degraded hint when pillar_momentum null AND source degraded', () => {
      const out = renderDecisionContract(
        emptyContext({
          source_health: {
            continuity: { ok: true },
            concept_mastery: { ok: true },
            journey_stage: { ok: true },
            pillar_momentum: { ok: false, reason: 'supabase_unconfigured' },
            interaction_style: { ok: true },
          },
        }),
      );
      expect(out).toContain('pillar_momentum: source degraded');
      expect(out).toContain('supabase_unconfigured');
    });

    it('renders per_pillar (skipping unknowns) + weakest/strongest/suggested + confidence', () => {
      const out = renderDecisionContract(
        emptyContext({
          pillar_momentum: makePillar({
            per_pillar: [
              { pillar: 'sleep',     momentum: 'slipping' },
              { pillar: 'nutrition', momentum: 'steady' },
              { pillar: 'exercise',  momentum: 'unknown' },
              { pillar: 'hydration', momentum: 'improving' },
              { pillar: 'mental',    momentum: 'steady' },
            ],
            weakest_pillar: 'sleep',
            strongest_pillar: 'mental',
            suggested_focus: 'sleep',
            confidence: 'high',
          }),
        }),
      );
      expect(out).toContain('Pillar momentum:');
      expect(out).toContain('per_pillar: sleep: slipping, nutrition: steady, hydration: improving, mental: steady');
      // 'exercise: unknown' is intentionally omitted from the line.
      expect(out).not.toContain('exercise: unknown');
      expect(out).toContain('weakest: sleep');
      expect(out).toContain('strongest: mental');
      expect(out).toContain('suggested focus: sleep');
      expect(out).toContain('confidence: high');
    });

    it('omits per_pillar line entirely when every pillar is unknown', () => {
      const out = renderDecisionContract(
        emptyContext({
          pillar_momentum: makePillar({
            warnings: ['no_recent_pillar_data'],
          }),
        }),
      );
      expect(out).not.toContain('per_pillar:');
      expect(out).toContain('warnings: no_recent_pillar_data');
    });

    it('renders warnings list when non-empty', () => {
      const out = renderDecisionContract(
        emptyContext({
          pillar_momentum: makePillar({
            warnings: ['low_pillar_confidence', 'no_recent_pillar_data'],
          }),
        }),
      );
      expect(out).toContain('warnings: low_pillar_confidence, no_recent_pillar_data');
    });

    it('returns empty section when no content + no warnings', () => {
      // If every pillar is unknown AND there are no pillar picks AND no
      // warnings, the section is just noise — renderer should skip it.
      const out = renderDecisionContract(
        emptyContext({
          pillar_momentum: makePillar({
            warnings: [],
            // Intentionally also low confidence-ish flag; rendering decides.
          }),
        }),
      );
      // With empty per_pillar + no picks + no warnings, no section emitted.
      expect(out).not.toContain('Pillar momentum:');
    });

    it('raw-field ignorance: smuggled scores/timestamps are NOT in output', () => {
      const sneakyPillar = {
        ...makePillar({
          per_pillar: [
            { pillar: 'sleep',     momentum: 'slipping', latest_score: 42, recent_window_days: 7 },
            { pillar: 'nutrition', momentum: 'unknown' },
            { pillar: 'exercise',  momentum: 'unknown' },
            { pillar: 'hydration', momentum: 'unknown' },
            { pillar: 'mental',    momentum: 'unknown' },
          ],
          weakest_pillar: 'sleep',
          confidence: 'medium',
        }),
        // smuggled top-level raw fields:
        history_days_sampled: 14,
        last_score_date: '2026-05-13',
        raw_biomarker_glucose: 96,
      };
      const out = renderDecisionContract(
        emptyContext({ pillar_momentum: sneakyPillar as any }),
      );
      expect(out).not.toContain('42');
      expect(out).not.toContain('14');
      expect(out).not.toContain('2026-05-13');
      expect(out).not.toContain('96');
      expect(out).not.toContain('glucose');
      expect(out).not.toContain('recent_window_days');
      expect(out).not.toContain('history_days_sampled');
    });

    it('output does NOT contain medical/clinical language', () => {
      const out = renderDecisionContract(
        emptyContext({
          pillar_momentum: makePillar({
            per_pillar: [
              { pillar: 'sleep',     momentum: 'slipping' },
              { pillar: 'nutrition', momentum: 'steady' },
              { pillar: 'exercise',  momentum: 'steady' },
              { pillar: 'hydration', momentum: 'steady' },
              { pillar: 'mental',    momentum: 'steady' },
            ],
            weakest_pillar: 'sleep',
            strongest_pillar: 'mental',
            suggested_focus: 'sleep',
            confidence: 'high',
            warnings: [],
          }),
        }),
      );
      const banned = [
        'diagnos', 'symptom', 'disease', 'illness', 'treatment',
        'prescription', 'medication', 'clinical',
      ];
      for (const word of banned) {
        expect(out.toLowerCase()).not.toContain(word);
      }
    });
  });

  describe('all four sections coexist', () => {
    it('renders continuity → concept_mastery → journey_stage → pillar_momentum, in that order', () => {
      const out = renderDecisionContract(
        emptyContext({
          continuity: {
            open_threads: [
              { thread_id: 't1', topic: 'magnesium', summary: null, days_since_last_mention: 1 },
            ],
            promises_owed: [],
            promises_kept_recently: [],
            counts: {
              open_threads_total: 1,
              promises_owed_total: 0,
              promises_overdue: 0,
              threads_mentioned_today: 0,
            },
            recommended_follow_up: 'mention_open_thread',
          },
          concept_mastery: {
            concepts_explained: [{
              concept_key: 'vitana_index',
              frequency: 'once',
              days_since_last_explained: 2,
              repetition_hint: 'one_liner',
            }],
            concepts_mastered: [],
            dyk_cards_seen: [],
            counts: {
              concepts_explained_total: 1,
              concepts_mastered_total: 0,
              dyk_cards_seen_total: 0,
              concepts_explained_in_last_24h: 0,
            },
            recommended_cadence: 'use_one_liner',
          },
          journey_stage: {
            stage: 'first_month',
            tenure_bucket: 'first_month',
            explanation_depth: 'standard',
            tone_hint: 'collaborative',
            vitana_index_tier: 'momentum',
            tier_tenure: 'settled',
            activity_recency: 'today',
            usage_volume: 'regular',
            journey_confidence: 'high',
            warnings: [],
          },
          pillar_momentum: {
            per_pillar: [
              { pillar: 'sleep',     momentum: 'slipping' },
              { pillar: 'nutrition', momentum: 'steady' },
              { pillar: 'exercise',  momentum: 'improving' },
              { pillar: 'hydration', momentum: 'steady' },
              { pillar: 'mental',    momentum: 'steady' },
            ],
            weakest_pillar: 'sleep',
            strongest_pillar: 'exercise',
            suggested_focus: 'sleep',
            confidence: 'high',
            warnings: [],
          },
        }),
      );
      const continuityIdx = out.indexOf('Continuity:');
      const conceptIdx = out.indexOf('Concept mastery:');
      const journeyIdx = out.indexOf('Journey stage:');
      const pillarIdx = out.indexOf('Pillar momentum:');
      expect(continuityIdx).toBeGreaterThan(-1);
      expect(conceptIdx).toBeGreaterThan(-1);
      expect(journeyIdx).toBeGreaterThan(-1);
      expect(pillarIdx).toBeGreaterThan(-1);
      expect(continuityIdx).toBeLessThan(conceptIdx);
      expect(conceptIdx).toBeLessThan(journeyIdx);
      expect(journeyIdx).toBeLessThan(pillarIdx);
    });
  });
});
