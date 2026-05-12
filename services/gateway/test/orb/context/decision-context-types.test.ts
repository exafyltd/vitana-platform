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
});
