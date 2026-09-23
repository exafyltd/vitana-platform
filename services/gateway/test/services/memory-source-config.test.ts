/**
 * VTID-01184 Phase 2: Memory Source Configuration
 *
 * VTID-04344: the deprecated Mem0/Qdrant source was removed; Supabase is the
 * only memory source, whatever MEMORY_SOURCE says.
 *
 * Coverage:
 * - getMemorySource() / isSupabasePrimary(): always supabase.
 * - isSemanticSearchAvailable() / isEmbeddingPipelineAvailable(): gated on
 *   OPENAI_API_KEY or GOOGLE_GEMINI_API_KEY.
 * - getMemorySourceStatus(): aggregate diagnostic shape.
 */

type ConfigModule = typeof import('../../src/services/memory-source-config');

function loadModule(): ConfigModule {
  jest.resetModules();
  return require('../../src/services/memory-source-config');
}

beforeEach(() => {
  delete process.env.MEMORY_SOURCE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_GEMINI_API_KEY;
});

describe('getMemorySource() / isSupabasePrimary()', () => {
  it('defaults to supabase when MEMORY_SOURCE is unset', () => {
    const mod = loadModule();
    expect(mod.getMemorySource()).toBe('supabase');
    expect(mod.isSupabasePrimary()).toBe(true);
  });

  it.each(['SUPABASE', 'mem0', 'both', 'qdrant-legacy'])(
    'resolves to supabase for MEMORY_SOURCE=%s (Mem0 removed, VTID-04344)',
    (value) => {
      process.env.MEMORY_SOURCE = value;
      const mod = loadModule();
      expect(mod.getMemorySource()).toBe('supabase');
      expect(mod.isSupabasePrimary()).toBe(true);
    },
  );

  it('no longer exports the Mem0 helpers', () => {
    const mod = loadModule() as Record<string, unknown>;
    expect(mod.isMem0Enabled).toBeUndefined();
    expect(mod.isDualSourceEnabled).toBeUndefined();
  });
});

describe('isSemanticSearchAvailable() / isEmbeddingPipelineAvailable()', () => {
  it('false when neither embedding key is set', () => {
    const mod = loadModule();
    expect(mod.isSemanticSearchAvailable()).toBe(false);
    expect(mod.isEmbeddingPipelineAvailable()).toBe(false);
  });

  it('true when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const mod = loadModule();
    expect(mod.isSemanticSearchAvailable()).toBe(true);
    expect(mod.isEmbeddingPipelineAvailable()).toBe(true);
  });

  it('true when GOOGLE_GEMINI_API_KEY is set (without OpenAI)', () => {
    process.env.GOOGLE_GEMINI_API_KEY = 'gm-test';
    const mod = loadModule();
    expect(mod.isSemanticSearchAvailable()).toBe(true);
  });
});

describe('getMemorySourceStatus()', () => {
  it('reports a fully-supabase status', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const mod = loadModule();
    expect(mod.getMemorySourceStatus()).toEqual({
      source: 'supabase',
      supabase_enabled: true,
      semantic_search_available: true,
      embedding_pipeline_available: true,
    });
  });
});
