/**
 * VTID-01184 Phase 2: Memory Source Configuration
 *
 * Coverage:
 * - getMemorySource(): env-driven, case-insensitive, unknown values fall
 *   back to 'supabase' (only 'mem0'/'both' are ever passed through).
 * - isSupabasePrimary() / isMem0Enabled() / isDualSourceEnabled()
 * - isSemanticSearchAvailable() / isEmbeddingPipelineAvailable(): gated on
 *   OPENAI_API_KEY or GOOGLE_GEMINI_API_KEY.
 * - getMemorySourceStatus(): aggregate diagnostic shape.
 * - Deprecation warning OASIS event: emitted once per process, only for
 *   'mem0'/'both'.
 *
 * `_deprecationWarningEmitted` is module-scoped state, so tests that assert
 * on its emission reload the module fresh via jest.resetModules().
 */

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: mockEmitOasisEvent,
}));

type ConfigModule = typeof import('../../src/services/memory-source-config');

function loadModule(): ConfigModule {
  jest.resetModules();
  return require('../../src/services/memory-source-config');
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MEMORY_SOURCE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_GEMINI_API_KEY;
});

// =============================================================================
// getMemorySource()
// =============================================================================

describe('getMemorySource()', () => {
  it('defaults to supabase when MEMORY_SOURCE is unset', () => {
    const mod = loadModule();
    expect(mod.getMemorySource()).toBe('supabase');
  });

  it('is case-insensitive', () => {
    process.env.MEMORY_SOURCE = 'SUPABASE';
    const mod = loadModule();
    expect(mod.getMemorySource()).toBe('supabase');
  });

  it('passes through mem0', () => {
    process.env.MEMORY_SOURCE = 'mem0';
    const mod = loadModule();
    expect(mod.getMemorySource()).toBe('mem0');
  });

  it('passes through both', () => {
    process.env.MEMORY_SOURCE = 'both';
    const mod = loadModule();
    expect(mod.getMemorySource()).toBe('both');
  });

  it('falls back to supabase for an unrecognized value', () => {
    process.env.MEMORY_SOURCE = 'qdrant-legacy';
    const mod = loadModule();
    expect(mod.getMemorySource()).toBe('supabase');
  });

  it('does not emit a deprecation warning for an unrecognized value', () => {
    process.env.MEMORY_SOURCE = 'qdrant-legacy';
    const mod = loadModule();
    mod.getMemorySource();
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// =============================================================================
// isSupabasePrimary()
// =============================================================================

describe('isSupabasePrimary()', () => {
  it('true for supabase (default)', () => {
    const mod = loadModule();
    expect(mod.isSupabasePrimary()).toBe(true);
  });

  it('true for both', () => {
    process.env.MEMORY_SOURCE = 'both';
    const mod = loadModule();
    expect(mod.isSupabasePrimary()).toBe(true);
  });

  it('false for mem0', () => {
    process.env.MEMORY_SOURCE = 'mem0';
    const mod = loadModule();
    expect(mod.isSupabasePrimary()).toBe(false);
  });
});

// =============================================================================
// isMem0Enabled()
// =============================================================================

describe('isMem0Enabled()', () => {
  it('false when source is supabase', () => {
    const mod = loadModule();
    expect(mod.isMem0Enabled()).toBe(false);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('true when source is mem0, and emits the deprecation warning', () => {
    process.env.MEMORY_SOURCE = 'mem0';
    const mod = loadModule();
    expect(mod.isMem0Enabled()).toBe(true);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'memory.deprecation_warning',
        status: 'warning',
        payload: expect.objectContaining({ memory_source: 'mem0' }),
      })
    );
  });

  it('true when source is both', () => {
    process.env.MEMORY_SOURCE = 'both';
    const mod = loadModule();
    expect(mod.isMem0Enabled()).toBe(true);
  });

  it('emits the deprecation warning only once across repeated calls', () => {
    process.env.MEMORY_SOURCE = 'mem0';
    const mod = loadModule();
    mod.isMem0Enabled();
    mod.isMem0Enabled();
    mod.getMemorySource();
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// isDualSourceEnabled()
// =============================================================================

describe('isDualSourceEnabled()', () => {
  it('false for supabase', () => {
    const mod = loadModule();
    expect(mod.isDualSourceEnabled()).toBe(false);
  });

  it('false for mem0 (mem0-only is not dual-source)', () => {
    process.env.MEMORY_SOURCE = 'mem0';
    const mod = loadModule();
    expect(mod.isDualSourceEnabled()).toBe(false);
  });

  it('true only for both', () => {
    process.env.MEMORY_SOURCE = 'both';
    const mod = loadModule();
    expect(mod.isDualSourceEnabled()).toBe(true);
  });
});

// =============================================================================
// isSemanticSearchAvailable() / isEmbeddingPipelineAvailable()
// =============================================================================

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

// =============================================================================
// getMemorySourceStatus()
// =============================================================================

describe('getMemorySourceStatus()', () => {
  it('reports a non-deprecated, fully-supabase status by default', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const mod = loadModule();
    const status = mod.getMemorySourceStatus();

    expect(status).toEqual({
      source: 'supabase',
      supabase_enabled: true,
      mem0_enabled: false,
      semantic_search_available: true,
      embedding_pipeline_available: true,
      is_deprecated: false,
      deprecation_message: undefined,
    });
  });

  it('reports deprecated status with a deprecation_message for mem0', () => {
    process.env.MEMORY_SOURCE = 'mem0';
    const mod = loadModule();
    const status = mod.getMemorySourceStatus();

    expect(status.is_deprecated).toBe(true);
    expect(status.mem0_enabled).toBe(true);
    expect(status.supabase_enabled).toBe(false);
    expect(status.deprecation_message).toMatch(/mem0.*deprecated/i);
  });

  it('reports deprecated status for both (supabase still enabled alongside mem0)', () => {
    process.env.MEMORY_SOURCE = 'both';
    const mod = loadModule();
    const status = mod.getMemorySourceStatus();

    expect(status.is_deprecated).toBe(true);
    expect(status.mem0_enabled).toBe(true);
    expect(status.supabase_enabled).toBe(true);
  });
});
