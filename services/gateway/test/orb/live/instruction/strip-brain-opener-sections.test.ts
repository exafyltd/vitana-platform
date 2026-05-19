/**
 * VTID-03097 — stripBrainOpenerSections() pure helper tests.
 */

import { stripBrainOpenerSections } from '../../../../src/orb/live/instruction/live-system-instruction';

describe('VTID-03097 — stripBrainOpenerSections', () => {
  test('empty / null in returns unchanged', () => {
    expect(stripBrainOpenerSections('')).toBe('');
  });

  test('bootstrap without any opener sections is unchanged', () => {
    const text = '## USER CONTEXT PROFILE\n\nDragan is a 56-year-old founder.';
    expect(stripBrainOpenerSections(text)).toBe(text.trim());
  });

  test('strips OPENING SHAPE MATRIX section', () => {
    const input = `
## USER CONTEXT PROFILE
foo bar

=== OPENING SHAPE MATRIX (TENURE × LAST_INTERACTION) ===

day0 → 5-8 sentences. FULL INTRODUCTION.
day1 → ...

=== NEXT SECTION ===
keep this
`.trim();
    const out = stripBrainOpenerSections(input);
    expect(out).not.toContain('OPENING SHAPE MATRIX');
    expect(out).toContain('## USER CONTEXT PROFILE');
    expect(out).toContain('keep this');
  });

  test('strips PROACTIVE OPENER CANDIDATE section', () => {
    const input = `
HEADER

=== PROACTIVE OPENER CANDIDATE — YOUR FIRST UTTERANCE MUST BUILD AROUND THIS ===
Kind: pillar_focus
Title: Your nutrition pillar
...
`.trim();
    const out = stripBrainOpenerSections(input);
    expect(out).not.toContain('PROACTIVE OPENER CANDIDATE');
    expect(out).not.toContain('pillar_focus');
    expect(out).toContain('HEADER');
  });

  test('strips PROACTIVE INITIATIVE OFFER section', () => {
    const input = `
context

=== PROACTIVE INITIATIVE OFFER (V2 — HIGHEST-PRIORITY OPENER FOR THIS SESSION) ===

Initiative key: log_meal
...
`.trim();
    const out = stripBrainOpenerSections(input);
    expect(out).not.toContain('PROACTIVE INITIATIVE OFFER');
    expect(out).toContain('context');
  });

  test('strips all three opener sections together', () => {
    const input = `
## USER CONTEXT PROFILE
Dragan, day30plus.

=== OPENING SHAPE MATRIX (TENURE × LAST_INTERACTION) ===
day30plus → 1-2 sentences.

=== PROACTIVE OPENER CANDIDATE — YOUR FIRST UTTERANCE MUST BUILD AROUND THIS ===
Kind: pillar_focus.

=== PROACTIVE INITIATIVE OFFER (V2 — HIGHEST-PRIORITY OPENER FOR THIS SESSION) ===
Initiative key: log_meal.

=== ACTIVITY 14D ===
keep me

=== RECENT TURNS ===
keep me too
`.trim();
    const out = stripBrainOpenerSections(input);
    expect(out).not.toContain('OPENING SHAPE MATRIX');
    expect(out).not.toContain('PROACTIVE OPENER CANDIDATE');
    expect(out).not.toContain('PROACTIVE INITIATIVE OFFER');
    expect(out).not.toContain('day30plus → 1-2 sentences');
    expect(out).not.toContain('Initiative key: log_meal');
    expect(out).toContain('USER CONTEXT PROFILE');
    expect(out).toContain('ACTIVITY 14D');
    expect(out).toContain('RECENT TURNS');
    expect(out).toContain('keep me');
    expect(out).toContain('keep me too');
  });

  test('collapses excess blank lines after removal', () => {
    const input = `
A

=== OPENING SHAPE MATRIX (TENURE × LAST_INTERACTION) ===
delete me

=== NEXT ===
B
`.trim();
    const out = stripBrainOpenerSections(input);
    // No more than two consecutive newlines anywhere.
    expect(out).not.toMatch(/\n{3,}/);
  });

  test('strip is idempotent', () => {
    const input = `
=== OPENING SHAPE MATRIX (TENURE × LAST_INTERACTION) ===
remove
=== ANOTHER ===
keep
`.trim();
    const first = stripBrainOpenerSections(input);
    const second = stripBrainOpenerSections(first);
    expect(second).toBe(first);
  });
});
