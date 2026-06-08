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

describe('VTID-03259 (Fix-3) — V2 sentinel region (nested STEP 1) is fully stripped', () => {
  // The realistic V2 block: nested === subsections (STEP 1 / ON NO / ON HARDER
  // REFUSAL) inside one sentinel-wrapped region. Pre-fix, the heading regex
  // stopped at STEP 1, so its competing "speak this verbatim" first utterance
  // SURVIVED and fought the wake-brief/journey-guide override. The sentinel
  // strip must remove the whole region — STEP 1 included.
  const v2Block = `
<<BRAIN_OPENER_V2_START>>
=== PROACTIVE INITIATIVE OFFER (V2 — HIGHEST-PRIORITY OPENER FOR THIS SESSION) ===

Initiative key: log_meal

=== STEP 1 — YOUR VERY FIRST UTTERANCE (sanctioned, do NOT paraphrase) ===

  "Let's log your breakfast — ready?"

=== ON NO (any decline) ===
  Call pause_proactive_guidance.

=== ON HARDER REFUSAL ("not today") ===
  Call pause_proactive_guidance scope=all.
<<BRAIN_OPENER_V2_END>>`;

  test('removes the entire V2 region including the nested STEP 1 verbatim line', () => {
    const input = `
## USER CONTEXT PROFILE
Dragan, day0.
${v2Block}

=== ACTIVITY 14D ===
keep me
`.trim();
    const out = stripBrainOpenerSections(input);
    // The competing first-utterance MUST be gone.
    expect(out).not.toContain('STEP 1 — YOUR VERY FIRST UTTERANCE');
    expect(out).not.toContain("Let's log your breakfast");
    expect(out).not.toContain('PROACTIVE INITIATIVE OFFER');
    expect(out).not.toContain('ON HARDER REFUSAL');
    expect(out).not.toContain('BRAIN_OPENER_V2');
    // Non-opener grounding survives.
    expect(out).toContain('USER CONTEXT PROFILE');
    expect(out).toContain('ACTIVITY 14D');
    expect(out).toContain('keep me');
  });

  test('belt-and-suspenders: STEP 1 heading is stripped even without sentinels (older brain build)', () => {
    const input = `
HEADER
=== PROACTIVE INITIATIVE OFFER (V2 — HIGHEST-PRIORITY OPENER FOR THIS SESSION) ===
Initiative key: log_meal
=== STEP 1 — YOUR VERY FIRST UTTERANCE (sanctioned, do NOT paraphrase) ===
  "Verbatim opener here"
=== ACTIVITY 14D ===
keep me
`.trim();
    const out = stripBrainOpenerSections(input);
    expect(out).not.toContain('STEP 1 — YOUR VERY FIRST UTTERANCE');
    expect(out).not.toContain('Verbatim opener here');
    expect(out).not.toContain('PROACTIVE INITIATIVE OFFER');
    expect(out).toContain('ACTIVITY 14D');
    expect(out).toContain('keep me');
  });

  test('no override (sentinels present, no nested leak): idempotent + clean', () => {
    const out1 = stripBrainOpenerSections(`x\n${v2Block}\n=== KEEP ===\ny`);
    const out2 = stripBrainOpenerSections(out1);
    expect(out2).toBe(out1);
    expect(out1).not.toMatch(/\n{3,}/);
    expect(out1).toContain('KEEP');
  });
});
