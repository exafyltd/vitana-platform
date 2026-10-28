/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: Nova-safe identity-lock sanitizer.
 */
import { sanitizeInstructionForNova } from '../../../../src/orb/live/upstream/nova-instruction-sanitizer';

const VERTEX_LOCK = `=== IDENTITY LOCK ===
YOU ARE Vitana.
Your role is the user's life companion and instruction manual.

You speak EXCLUSIVELY as Vitana. You NEVER:
  - introduce yourself as another persona ("Hi, this is Devon" — only Devon ever says that)
  - continue another persona's sentence as if it were your own
  - mimic another persona's tone, signature phrases, or voice
  - acknowledge another persona's words as if YOU said them
  - name yourself as anyone other than Vitana

If you ever notice yourself drifting toward another persona's identity,
stop and re-anchor: "I'm Vitana." Then continue.
=== END IDENTITY LOCK ===`;

describe('sanitizeInstructionForNova', () => {
  it('replaces the identity-lock block and drops the filter-tripping denial list', () => {
    const instruction = `PREAMBLE\n${VERTEX_LOCK}\nPOSTAMBLE`;
    const { text, replaced } = sanitizeInstructionForNova(instruction);
    expect(replaced).toBe(true);
    // The measured Nova RAI trigger must be gone.
    expect(text).not.toContain('mimic another persona');
    expect(text).not.toContain('You NEVER:');
    // Markers and identity intent stay so downstream section decomposition
    // and the persona anchor keep working.
    expect(text).toContain('=== IDENTITY LOCK ===');
    expect(text).toContain('=== END IDENTITY LOCK ===');
    expect(text).toContain('YOU ARE Vitana.');
    expect(text).toContain('re-anchor: "I\'m Vitana."');
    // Surrounding content untouched.
    expect(text.startsWith('PREAMBLE\n')).toBe(true);
    expect(text.endsWith('\nPOSTAMBLE')).toBe(true);
  });

  it('preserves the per-surface role line (Command Hub dev co-pilot variant)', () => {
    const devLock = VERTEX_LOCK.replace(
      "the user's life companion and instruction manual",
      'the engineering co-pilot for the Vitana platform',
    );
    const { text, replaced } = sanitizeInstructionForNova(devLock);
    expect(replaced).toBe(true);
    expect(text).toContain('Your role is the engineering co-pilot for the Vitana platform.');
  });

  it('no-ops when no identity-lock block is present', () => {
    const { text, replaced } = sanitizeInstructionForNova('You are a bench probe.');
    expect(replaced).toBe(false);
    expect(text).toBe('You are a bench probe.');
  });

  it('no-ops on an unterminated block rather than corrupting the prompt', () => {
    const broken = 'X\n=== IDENTITY LOCK ===\nYOU ARE Vitana.';
    const { text, replaced } = sanitizeInstructionForNova(broken);
    expect(replaced).toBe(false);
    expect(text).toBe(broken);
  });
});
