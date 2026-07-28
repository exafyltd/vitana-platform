/**
 * Tests for src/services/dev-autopilot/context-loader.ts
 *
 * Contract under test:
 *   - loadAutopilotContext() concatenates two embedded string constants
 *     (code conventions + imports surface) with a "---" separator, each
 *     `.trim()`-ed, and caches the result in a module-level variable so
 *     subsequent calls are pure cache hits (no recomputation).
 *   - _resetContextCacheForTests() clears that cache so a fresh
 *     concatenation happens again.
 *
 * There is no external I/O here (no Supabase, no filesystem, no network —
 * see the file's own header comment on why: content is embedded as TS
 * string constants precisely to avoid a build-time asset copy step), so
 * "empty/error handling" reduces to: the function never throws and never
 * returns an empty/undefined string, which is asserted below.
 */

import {
  loadAutopilotContext,
  _resetContextCacheForTests,
} from '../../../src/services/dev-autopilot/context-loader';

describe('loadAutopilotContext', () => {
  beforeEach(() => {
    _resetContextCacheForTests();
  });

  it('returns a non-empty string', () => {
    const ctx = loadAutopilotContext();
    expect(typeof ctx).toBe('string');
    expect(ctx.length).toBeGreaterThan(0);
  });

  it('includes the file-naming conventions section', () => {
    const ctx = loadAutopilotContext();
    expect(ctx).toContain('# Vitana platform — code conventions');
    expect(ctx).toContain('## File naming');
    expect(ctx).toContain('kebab-case');
    expect(ctx).toContain('Enforce Phase 2B Naming Standards');
  });

  it('includes the imports-surface section', () => {
    const ctx = loadAutopilotContext();
    expect(ctx).toContain('# Imports surface — public exports of frequently-imported gateway modules');
    expect(ctx).toContain('export const getSupabase: () => SupabaseClient | null;');
    expect(ctx).toContain('export const requireAuth: RequestHandler;');
  });

  it('joins the two sections with a "---" separator, in conventions-then-imports order', () => {
    const ctx = loadAutopilotContext();
    const conventionsIdx = ctx.indexOf('# Vitana platform — code conventions');
    const separatorIdx = ctx.indexOf('\n\n---\n\n');
    const importsIdx = ctx.indexOf('# Imports surface');

    expect(conventionsIdx).toBe(0); // trimmed, so starts immediately at index 0
    expect(separatorIdx).toBeGreaterThan(conventionsIdx);
    expect(importsIdx).toBeGreaterThan(separatorIdx);
  });

  it('has no leading or trailing whitespace (both sections are trimmed before joining)', () => {
    const ctx = loadAutopilotContext();
    expect(ctx).toBe(ctx.trim());
  });

  it('caches the result: repeated calls return identical content', () => {
    const first = loadAutopilotContext();
    const second = loadAutopilotContext();
    expect(second).toEqual(first);
  });

  it('_resetContextCacheForTests() forces recomputation: the cold-load log fires again', () => {
    loadAutopilotContext(); // cold load #1
    _resetContextCacheForTests();

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const second = loadAutopilotContext(); // must be a cold load again, not a cache hit

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(second.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  it('_resetContextCacheForTests() does not change the resulting content (deterministic rebuild)', () => {
    const first = loadAutopilotContext();
    _resetContextCacheForTests();
    const second = loadAutopilotContext();

    expect(second).toEqual(first);
  });

  it('logs how many characters were loaded on a cache-miss (cold load)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = loadAutopilotContext();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[dev-autopilot/context-loader]'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${ctx.length} chars`),
    );

    logSpy.mockRestore();
  });

  it('does not log again on a cache-hit (second call within the same cache lifetime)', () => {
    loadAutopilotContext(); // cold load, logs once
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    loadAutopilotContext(); // cache hit

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
