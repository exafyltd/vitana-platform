import { buildRetryPrompt } from '../src/retry';

describe('buildRetryPrompt', () => {
  it('includes the original prompt, previous output, and errors', () => {
    const p = buildRetryPrompt(
      'ORIGINAL TASK PROMPT',
      'PRIOR LLM OUTPUT with code',
      ['foo.ts(10,5): error TS2304: Cannot find name bar.'],
      0,
    );
    expect(p).toContain('ORIGINAL TASK PROMPT');
    expect(p).toContain('PRIOR LLM OUTPUT with code');
    expect(p).toContain('error TS2304');
    expect(p).toContain('Retry (attempt 1)');
  });

  it('truncates very large prior outputs so we stay inside the context window', () => {
    const huge = 'x'.repeat(100_000);
    const p = buildRetryPrompt('orig', huge, ['e'], 0);
    expect(p).toContain('... [truncated');
    expect(p.length).toBeLessThan(60_000);
  });

  it('substitutes a helpful stub when there are no error strings', () => {
    const p = buildRetryPrompt('orig', 'prev', [], 0);
    expect(p).toContain('(no text captured');
  });

  it('labels retry attempts correctly (attempt 0 → Retry 1, attempt 1 → Retry 2, etc)', () => {
    expect(buildRetryPrompt('o', 'p', ['e'], 0)).toContain('Retry (attempt 1)');
    expect(buildRetryPrompt('o', 'p', ['e'], 1)).toContain('Retry (attempt 2)');
    expect(buildRetryPrompt('o', 'p', ['e'], 2)).toContain('Retry (attempt 3)');
  });
});
