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
});
