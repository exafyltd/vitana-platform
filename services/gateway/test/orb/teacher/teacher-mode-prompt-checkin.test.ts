/**
 * VTID-03157 — Teacher Mode comprehension check-in contract.
 *
 * Founder feedback after VTID-03154 runtime test: the Teacher Mode
 * pattern was rushed — 2-4 sentences explaining a feature then
 * immediately "want me to introduce another?". A first-30-days user
 * can't internalize a feature in 2-4 sentences; some need more depth,
 * others didn't connect and want a different topic, others are ready
 * to move on. The contract NOW requires a mandatory check-in sentence
 * after every intro with a clear three-way choice.
 *
 * This test locks the contract structurally so a future refactor can't
 * silently remove the check-in.
 */

import { buildTeacherModeBlock } from '../../../src/orb/teacher/teacher-mode-prompt';
import type { TeacherModeContent } from '../../../src/orb/teacher/teacher-content-resolver';

function makeContent(overrides: Partial<TeacherModeContent> = {}): TeacherModeContent {
  return {
    active_capability_key: 'life_compass',
    active_display_name: 'Life Compass',
    active_description: 'Your active longevity goal',
    active_manual_path: 'kb/life-compass.md',
    active_manual_content: 'Life Compass is your single active longevity goal.',
    active_teacher_intro_script: null,
    remaining_capabilities: [
      { capability_key: 'vitana_index', display_name: 'Vitana Index', description: 'Your daily progress measure' },
      { capability_key: 'autopilot', display_name: 'Autopilot', description: 'Agentic execution' },
    ],
    ...overrides,
  };
}

describe('VTID-03157 Teacher Mode comprehension check-in', () => {
  it('emits a non-empty block when content is present', () => {
    const block = buildTeacherModeBlock({ content: makeContent(), lang: 'en', firstName: 'Dragan' });
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/TEACHER MODE/);
  });

  it('contract REQUIRES a comprehension check-in after every intro', () => {
    const block = buildTeacherModeBlock({ content: makeContent(), lang: 'en', firstName: 'Dragan' });
    expect(block).toMatch(/COMPREHENSION CHECK-IN/);
    expect(block).toMatch(/NON-NEGOTIABLE/);
  });

  it('contract spells out the THREE-way choice (deepen / move on / different topic)', () => {
    const block = buildTeacherModeBlock({ content: makeContent(), lang: 'en', firstName: 'Dragan' });
    expect(block).toMatch(/deepen this one/);
    expect(block).toMatch(/move on to the named next capability/);
    expect(block).toMatch(/not interested in this/);
  });

  it('contract forbids the rushed pattern that triggered the founder complaint', () => {
    const block = buildTeacherModeBlock({ content: makeContent(), lang: 'en', firstName: 'Dragan' });
    expect(block).toMatch(/NEVER jump straight from intro to\s+"want the next thing\?"/);
    expect(block).toMatch(/rushed pattern the\s+user complained about/);
  });

  it('check-in NAMES the next capability explicitly (no bare "next")', () => {
    const block = buildTeacherModeBlock({ content: makeContent(), lang: 'en', firstName: 'Dragan' });
    // Both example phrasings (DE + EN) interpolate the next display name.
    expect(block).toMatch(/Vitana Index/);
    // The "bare next is forbidden" rule survives.
    expect(block).toMatch(/bare word "next" \/ "das N.chste" is\s+STILL forbidden/);
  });

  it('lack-of-interest branch routes to dismissed event with the current capability key', () => {
    const block = buildTeacherModeBlock({ content: makeContent(), lang: 'en', firstName: 'Dragan' });
    expect(block).toMatch(/eventName='dismissed'/);
    expect(block).toMatch(/capability_key='life_compass'/);
  });

  it('user-wants-more-depth branch loops with a shorter follow-up check-in', () => {
    const block = buildTeacherModeBlock({ content: makeContent(), lang: 'en', firstName: 'Dragan' });
    expect(block).toMatch(/SHORTER check-in/);
    expect(block).toMatch(/Loop until the user signals they've had enough/);
  });
});
