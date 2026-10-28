import {
  BOOTSTRAP_CONTEXT_MAX_CHARS,
  TRIM_SENTINEL,
  capBootstrapContext,
} from '../../../../src/orb/live/instruction/bootstrap-cap';

const WAKE_SENTINEL = '<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>';

describe('bootstrap context cap (Phase A — BOOTSTRAP-orb-bootstrap-cap)', () => {
  it('passes an under-cap bootstrap through unchanged', () => {
    const input = 'x'.repeat(8_000);
    const { text, trimmedChars } = capBootstrapContext(input);
    expect(text).toBe(input);
    expect(trimmedChars).toBe(0);
  });

  it('passes a bootstrap exactly at the cap through unchanged', () => {
    const input = 'y'.repeat(BOOTSTRAP_CONTEXT_MAX_CHARS);
    const { text, trimmedChars } = capBootstrapContext(input);
    expect(text).toBe(input);
    expect(trimmedChars).toBe(0);
  });

  it('handles empty / falsy input without throwing', () => {
    expect(capBootstrapContext('')).toEqual({ text: '', trimmedChars: 0 });
    // Runtime guard for a nullish value arriving despite the string type.
    expect(capBootstrapContext(undefined as unknown as string)).toEqual({
      text: '',
      trimmedChars: 0,
    });
  });

  it('trims a 50 KB bootstrap to the cap and appends the sentinel', () => {
    const input = 'z'.repeat(50_000);
    const { text, trimmedChars } = capBootstrapContext(input);
    const expectedTrimmed = 50_000 - BOOTSTRAP_CONTEXT_MAX_CHARS;
    expect(trimmedChars).toBe(expectedTrimmed);
    // Kept exactly the head up to the cap...
    expect(text.startsWith('z'.repeat(BOOTSTRAP_CONTEXT_MAX_CHARS))).toBe(true);
    // ...plus the sentinel describing what was dropped.
    expect(text.endsWith(TRIM_SENTINEL(expectedTrimmed))).toBe(true);
    expect(text.length).toBe(BOOTSTRAP_CONTEXT_MAX_CHARS + TRIM_SENTINEL(expectedTrimmed).length);
  });

  it('preserves the wake-brief override sentinel (it lives at the top) after trim', () => {
    const head = `${WAKE_SENTINEL}\nidentity + role + recent activity\n`;
    const input = head + 'tail-'.repeat(20_000); // far over cap
    const { text, trimmedChars } = capBootstrapContext(input);
    expect(trimmedChars).toBeGreaterThan(0);
    expect(text.includes(WAKE_SENTINEL)).toBe(true);
  });

  it('respects a custom max argument', () => {
    const input = 'a'.repeat(100);
    const { text, trimmedChars } = capBootstrapContext(input, 40);
    expect(trimmedChars).toBe(60);
    expect(text.startsWith('a'.repeat(40))).toBe(true);
    expect(text.endsWith(TRIM_SENTINEL(60))).toBe(true);
  });
});
