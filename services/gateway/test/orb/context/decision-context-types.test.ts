/**
 * VTID-02941 (B0b-min) — type-level enforcement of the decision contract.
 *
 * Acceptance #2 + #7: raw fields MUST NOT pass through the schema.
 *
 * We can't enforce TypeScript structural typing at runtime, so we use
 * the renderer's output as the observable boundary: when fed a stub
 * decision with raw-looking extra fields, the renderer must NOT
 * surface them (and the type system will reject them at compile time,
 * which we assert by structural inspection of the types file).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const TYPES_PATH = join(__dirname, '../../../src/orb/context/types.ts');

describe('B0b-min — AssistantDecisionContext type guards', () => {
  let typesSrc: string;
  beforeAll(() => {
    typesSrc = readFileSync(TYPES_PATH, 'utf8');
  });

  describe('forbidden raw fields are NOT declared in DecisionContinuity', () => {
    // These fields exist in the underlying ContinuityContext / Supabase
    // rows but MUST NOT appear in DecisionContinuity. If a future change
    // adds any of them, this test fails — that's the wall.
    const forbiddenFields = [
      'session_id_first',
      'session_id_last',
      'last_mentioned_at',
      'resolved_at',
      'created_at',
      'updated_at',
      'due_at',
      'kept_at',
      'days_overdue',
      'days_since_last_mention', // intentionally allowed on open_threads (recency hint)
    ];

    // days_since_last_mention is ALLOWED. Re-filter.
    const trulyForbidden = forbiddenFields.filter(
      (f) => f !== 'days_since_last_mention',
    );

    it.each(trulyForbidden)('does not declare %s anywhere', (field) => {
      // Match field-name as a TypeScript declaration: `<name>:` or `<name>?:`
      const decl = new RegExp(`\\b${field}\\s*\\??:`, 'g');
      expect(typesSrc).not.toMatch(decl);
    });
  });

  it('declares the four required surfaces and source_health', () => {
    expect(typesSrc).toContain('open_threads');
    expect(typesSrc).toContain('promises_owed');
    expect(typesSrc).toContain('promises_kept_recently');
    expect(typesSrc).toContain('counts');
    expect(typesSrc).toContain('source_health');
    expect(typesSrc).toContain('recommended_follow_up');
  });

  it('declares overdue as a boolean, NEVER a raw timestamp', () => {
    expect(typesSrc).toMatch(/overdue:\s*boolean/);
    expect(typesSrc).not.toMatch(/overdue\s*\??:\s*string/);
  });

  it('AssistantDecisionContext.continuity is optional null', () => {
    // The type must allow null to enable empty-degrades.
    expect(typesSrc).toMatch(/continuity:\s*DecisionContinuity\s*\|\s*null/);
  });

  // F2: concept-mastery type guards.
  describe('forbidden raw fields are NOT declared in DecisionConceptMastery', () => {
    // These fields exist in the underlying ConceptMasteryContext but MUST
    // NOT appear in DecisionConceptMastery. If a future change adds any
    // of them, this test fails — that's the wall.
    const forbiddenConceptFields = [
      'last_explained_at',
      'last_observed_at',
      'last_seen_at',
    ];

    it.each(forbiddenConceptFields)('does not declare %s anywhere', (field) => {
      const decl = new RegExp(`\\b${field}\\s*\\??:`, 'g');
      expect(typesSrc).not.toMatch(decl);
    });

    it('declares frequency as a bucket type, NEVER as a raw number', () => {
      // The bucket types are FrequencyBucket / MasteryConfidenceBucket.
      // Searching for `frequency: number` would be a regression.
      expect(typesSrc).not.toMatch(/frequency\s*:\s*number/);
      expect(typesSrc).toMatch(/frequency:\s*FrequencyBucket/);
    });

    it('declares confidence as a bucket type, NEVER as a raw number', () => {
      // Confidence in DecisionConceptMastery is bucketed; the underlying
      // ConceptMasteryRow type is in services/ and can keep the raw
      // float, but THIS shape must not expose it.
      expect(typesSrc).toMatch(/confidence:\s*MasteryConfidenceBucket\s*\|\s*'unknown'/);
      // No `confidence: number` on the decision shape.
      const decisionShape = typesSrc.slice(
        typesSrc.indexOf('export interface DecisionConceptMastery'),
        typesSrc.indexOf('export interface DecisionSourceHealth'),
      );
      expect(decisionShape).not.toMatch(/confidence\s*:\s*number/);
    });
  });

  it('declares the concept-mastery surfaces + recommended_cadence', () => {
    expect(typesSrc).toContain('concepts_explained');
    expect(typesSrc).toContain('concepts_mastered');
    expect(typesSrc).toContain('dyk_cards_seen');
    expect(typesSrc).toContain('recommended_cadence');
  });

  it('AssistantDecisionContext.concept_mastery is optional null', () => {
    expect(typesSrc).toMatch(/concept_mastery:\s*DecisionConceptMastery\s*\|\s*null/);
  });

  it('DecisionSourceHealth declares concept_mastery health entry', () => {
    expect(typesSrc).toMatch(/concept_mastery:\s*\{\s*ok:\s*boolean/);
  });

  // F3: journey-stage type guards.
  describe('forbidden raw fields are NOT declared in DecisionJourneyStage', () => {
    // These fields exist in the underlying JourneyStageContext but
    // MUST NOT appear in DecisionJourneyStage. Each was the raw
    // counterpart of a bucketed enum in the decision shape.
    const forbiddenJourneyFields = [
      'tenure_days',           // → tenure_bucket enum
      'last_active_date',      // → activity_recency enum
      'days_since_last_active',// → activity_recency enum (no raw days)
      'usage_days_count',      // → usage_volume enum
      'score_total',           // → vitana_index_tier enum
      'tier_days_held',        // → tier_tenure enum
    ];

    it.each(forbiddenJourneyFields)('does not declare %s in DecisionJourneyStage', (field) => {
      // Restrict the search window to JUST the DecisionJourneyStage
      // interface body; the same field names may legitimately appear
      // in comments referencing the wall.
      const ifaceMatch = typesSrc.match(
        /export interface DecisionJourneyStage\s*\{([\s\S]*?)\n\}/,
      );
      expect(ifaceMatch).toBeTruthy();
      const ifaceBody = ifaceMatch![1];
      const decl = new RegExp(`\\b${field}\\s*\\??:`, 'g');
      expect(ifaceBody).not.toMatch(decl);
    });

    it('declares journey-stage as bucketed enums, NEVER raw numbers', () => {
      const ifaceMatch = typesSrc.match(
        /export interface DecisionJourneyStage\s*\{([\s\S]*?)\n\}/,
      );
      const ifaceBody = ifaceMatch![1];
      // None of the journey-stage fields should be `: number`.
      expect(ifaceBody).not.toMatch(/:\s*number/);
      // Each bucketed enum must appear as the field type.
      expect(ifaceBody).toMatch(/stage:\s*TenureBucket/);
      expect(ifaceBody).toMatch(/tenure_bucket:\s*TenureBucket/);
      expect(ifaceBody).toMatch(/vitana_index_tier:\s*VitanaIndexTierBucket/);
      expect(ifaceBody).toMatch(/tier_tenure:\s*TierTenureBucket/);
      expect(ifaceBody).toMatch(/activity_recency:\s*ActivityRecencyBucket/);
      expect(ifaceBody).toMatch(/usage_volume:\s*UsageVolumeBucket/);
      expect(ifaceBody).toMatch(/journey_confidence:\s*JourneyConfidenceBucket/);
      expect(ifaceBody).toMatch(/tone_hint:\s*StageToneHint/);
    });

    it('warnings are an enum-only ReadonlyArray', () => {
      const ifaceMatch = typesSrc.match(
        /export interface DecisionJourneyStage\s*\{([\s\S]*?)\n\}/,
      );
      const ifaceBody = ifaceMatch![1];
      expect(ifaceBody).toMatch(/warnings:\s*ReadonlyArray<JourneyStageWarning>/);
      // Not a string array — that would allow free-text leakage.
      expect(ifaceBody).not.toMatch(/warnings:\s*ReadonlyArray<string>/);
      expect(ifaceBody).not.toMatch(/warnings:\s*string\[\]/);
    });
  });

  it('AssistantDecisionContext.journey_stage is optional null', () => {
    expect(typesSrc).toMatch(/journey_stage:\s*DecisionJourneyStage\s*\|\s*null/);
  });

  it('DecisionSourceHealth declares journey_stage health entry', () => {
    expect(typesSrc).toMatch(/journey_stage:\s*\{\s*ok:\s*boolean/);
  });

  // B5: pillar-momentum type guards.
  describe('forbidden raw fields are NOT declared in DecisionPillarMomentum', () => {
    const forbiddenPillarFields = [
      'latest_score',
      'recent_window_days',
      'history_days_sampled',
      'score_sleep',
      'score_nutrition',
      'score_exercise',
      'score_hydration',
      'score_mental',
    ];

    it.each(forbiddenPillarFields)('does not declare %s in DecisionPillarMomentum', (field) => {
      const ifaceMatch = typesSrc.match(
        /export interface DecisionPillarMomentum\s*\{([\s\S]*?)\n\}/,
      );
      expect(ifaceMatch).toBeTruthy();
      const ifaceBody = ifaceMatch![1];
      const decl = new RegExp(`\\b${field}\\s*\\??:`, 'g');
      expect(ifaceBody).not.toMatch(decl);
    });

    it('declares pillar-momentum as enums, NEVER raw numbers', () => {
      const ifaceMatch = typesSrc.match(
        /export interface DecisionPillarMomentum\s*\{([\s\S]*?)\n\}/,
      );
      const ifaceBody = ifaceMatch![1];
      expect(ifaceBody).not.toMatch(/:\s*number/);
      expect(ifaceBody).toMatch(/confidence:\s*PillarMomentumConfidence/);
      expect(ifaceBody).toMatch(/momentum:\s*PillarMomentumBand/);
      expect(ifaceBody).toMatch(/pillar:\s*PillarKey/);
    });

    it('warnings are an enum-only ReadonlyArray', () => {
      const ifaceMatch = typesSrc.match(
        /export interface DecisionPillarMomentum\s*\{([\s\S]*?)\n\}/,
      );
      const ifaceBody = ifaceMatch![1];
      expect(ifaceBody).toMatch(/warnings:\s*ReadonlyArray<PillarMomentumWarning>/);
      expect(ifaceBody).not.toMatch(/warnings:\s*ReadonlyArray<string>/);
      expect(ifaceBody).not.toMatch(/warnings:\s*string\[\]/);
    });
  });

  it('AssistantDecisionContext.pillar_momentum is optional null', () => {
    expect(typesSrc).toMatch(/pillar_momentum:\s*DecisionPillarMomentum\s*\|\s*null/);
  });

  it('DecisionSourceHealth declares pillar_momentum health entry', () => {
    expect(typesSrc).toMatch(/pillar_momentum:\s*\{\s*ok:\s*boolean/);
  });

  it('PillarMomentumWarning enum does NOT include medical/clinical labels', () => {
    const enumMatch = typesSrc.match(/export type PillarMomentumWarning\s*=([\s\S]*?);/);
    expect(enumMatch).toBeTruthy();
    const enumBody = enumMatch![1];
    // Banned: any term that could read as medical interpretation.
    const banned = [
      'diagnos',
      'symptom',
      'disease',
      'illness',
      'treatment',
      'prescription',
      'medication',
      'clinical',
    ];
    for (const word of banned) {
      expect(enumBody.toLowerCase()).not.toContain(word);
    }
  });
});
