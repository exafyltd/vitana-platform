/**
 * VTID-03105 — tests for the *Meta picker variants used by the
 * feature-discovery-teacher provider for production diagnostic
 * logging.
 *
 * The classic `pickTeacherGreeting` / `pickTeacherInvitation` stay as
 * thin `.text` wrappers; this file locks the meta-variant contract so
 * a future refactor can't drop the `idx` / `poolSize` fields the
 * diagnostic log depends on.
 */

import {
  pickTeacherGreetingMeta,
  pickTeacherGreeting,
} from '../../../../../src/services/assistant-continuation/providers/teacher/teacher-greeting-pool';
import {
  pickTeacherInvitationMeta,
  pickTeacherInvitation,
} from '../../../../../src/services/assistant-continuation/providers/teacher/teacher-invitation-pool';

describe('VTID-03105 — pickTeacherGreetingMeta', () => {
  test('returns text + rawTemplate + idx + poolSize', () => {
    const out = pickTeacherGreetingMeta({
      lang: 'de',
      firstName: 'Dragan',
      rng: () => 0,
    });
    expect(typeof out.text).toBe('string');
    expect(typeof out.rawTemplate).toBe('string');
    expect(typeof out.idx).toBe('number');
    expect(typeof out.poolSize).toBe('number');
    expect(out.idx).toBeGreaterThanOrEqual(0);
    expect(out.idx).toBeLessThan(out.poolSize);
    expect(out.poolSize).toBeGreaterThan(0);
  });

  test('text matches rawTemplate after firstName substitution', () => {
    const out = pickTeacherGreetingMeta({
      lang: 'de',
      firstName: 'Dragan',
      rng: () => 0,
    });
    if (out.rawTemplate.includes('{firstName}')) {
      expect(out.text).toBe(out.rawTemplate.replace('{firstName}', 'Dragan'));
    } else {
      expect(out.text).toBe(out.rawTemplate);
    }
  });

  test('idx + poolSize change consistently with the no-name pool filter', () => {
    const withName = pickTeacherGreetingMeta({
      lang: 'de',
      firstName: 'Dragan',
      rng: () => 0,
    });
    const withoutName = pickTeacherGreetingMeta({
      lang: 'de',
      firstName: null,
      rng: () => 0,
    });
    // The no-name pool is a strict subset of the full pool (filtered out
    // entries containing {firstName}), so poolSize <= full pool size.
    expect(withoutName.poolSize).toBeLessThanOrEqual(withName.poolSize);
    expect(withoutName.rawTemplate).not.toContain('{firstName}');
  });

  test('classic pickTeacherGreeting wrapper returns same text', () => {
    const meta = pickTeacherGreetingMeta({
      lang: 'en',
      firstName: 'Alex',
      rng: () => 0.5,
    });
    const plain = pickTeacherGreeting({
      lang: 'en',
      firstName: 'Alex',
      rng: () => 0.5,
    });
    expect(plain).toBe(meta.text);
  });
});

describe('VTID-03105 — pickTeacherInvitationMeta', () => {
  test('returns text + rawTemplate + idx + poolSize', () => {
    const out = pickTeacherInvitationMeta({
      lang: 'en',
      featureLabel: null,
      rng: () => 0,
    });
    expect(typeof out.text).toBe('string');
    expect(typeof out.rawTemplate).toBe('string');
    expect(out.idx).toBeGreaterThanOrEqual(0);
    expect(out.idx).toBeLessThan(out.poolSize);
  });

  test('no-label pool excludes any {featureLabel} templates', () => {
    // Sweep through several rng values; every rawTemplate must be label-free.
    for (let i = 0; i < 30; i++) {
      const out = pickTeacherInvitationMeta({
        lang: 'en',
        featureLabel: null,
        rng: () => (i / 30) % 1,
      });
      expect(out.rawTemplate).not.toContain('{featureLabel}');
      expect(out.text).not.toContain('{featureLabel}');
    }
  });

  test('idx is within the post-filter pool, not the full pool', () => {
    // The no-label pool is smaller than the full pool. If the picker
    // were buggy and computed idx against the FULL pool, idx could
    // exceed the no-label poolSize. Lock this against regression.
    const out = pickTeacherInvitationMeta({
      lang: 'en',
      featureLabel: null,
      rng: () => 0.999,
    });
    expect(out.idx).toBeLessThan(out.poolSize);
  });

  test('classic pickTeacherInvitation wrapper returns same text', () => {
    const meta = pickTeacherInvitationMeta({
      lang: 'de',
      featureLabel: 'Life Compass',
      rng: () => 0.25,
    });
    const plain = pickTeacherInvitation({
      lang: 'de',
      featureLabel: 'Life Compass',
      rng: () => 0.25,
    });
    expect(plain).toBe(meta.text);
  });
});

describe('VTID-03105 — provider emits diagnostic [VTID-03105 TEACHER-PICK] log', () => {
  // Structural check: the production diagnostic line MUST be present in
  // feature-discovery-teacher.ts so production grep on the prefix works.
  // Falsely-passing tests (e.g. picker rotates but log line is gone)
  // would silence the diagnostic — this assert prevents that.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../../../../src/services/assistant-continuation/providers/teacher/feature-discovery-teacher.ts',
    ),
    'utf8',
  );

  test('source file contains the diagnostic log prefix', () => {
    expect(src).toContain('[VTID-03105 TEACHER-PICK]');
  });

  test('diagnostic log references greeting_idx + invitation_idx + capability', () => {
    expect(src).toMatch(/greeting_idx=\$\{greetingPick\.idx\}/);
    expect(src).toMatch(/invitation_idx=\$\{invitationPick\.idx\}/);
    expect(src).toMatch(/capability=\$\{picked\.row\.capability_key\}/);
  });

  test('diagnostic log includes raw template strings (not just rendered)', () => {
    // We need rawTemplate so a user with no firstName doesn't make all
    // log lines look the same. Lock that we log the unsubstituted form.
    expect(src).toMatch(/greeting_raw="/);
    expect(src).toMatch(/invitation_raw="/);
  });
});
