/**
 * VTID-01153 / VTID-01184: Memory Indexer Client (DEPRECATED Mem0/Qdrant HTTP client)
 *
 * Coverage:
 * - isMemoryIndexerEnabled(): defers to memory-source-config.isMem0Enabled();
 *   emits `memory.indexer.disabled` OASIS event only when Mem0 is enabled
 *   AND the URL is missing.
 * - getMemoryIndexerUrl()
 * - writeToMemoryIndexer() / searchMemoryIndexer() / getMemoryContext():
 *   no-URL short-circuit, success path (OASIS event + correct fetch args),
 *   network-failure path (caught, never throws).
 * - buildMemoryIndexerEnhancedInstruction(): passthrough vs. enhanced prompt.
 *
 * MEMORY_INDEXER_URL is read once at module load time, so tests that need a
 * different URL configuration reload the module fresh via jest.resetModules()
 * (same pattern as test/canary-target.test.ts).
 */

process.env.NODE_ENV = 'test';

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: mockEmitOasisEvent,
}));

const mockIsMem0Enabled = jest.fn();
const mockGetMemorySourceStatus = jest.fn();
jest.mock('../../src/services/memory-source-config', () => ({
  isMem0Enabled: mockIsMem0Enabled,
  getMemorySourceStatus: mockGetMemorySourceStatus,
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

type ClientModule = typeof import('../../src/services/memory-indexer-client');

function loadClient(url: string | undefined): ClientModule {
  jest.resetModules();
  if (url === undefined) {
    delete process.env.MEMORY_INDEXER_URL;
  } else {
    process.env.MEMORY_INDEXER_URL = url;
  }
  return require('../../src/services/memory-indexer-client');
}

function fetchOk(body: any) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMem0Enabled.mockReturnValue(false);
  mockGetMemorySourceStatus.mockReturnValue({ source: 'supabase' });
});

// =============================================================================
// isMemoryIndexerEnabled()
// =============================================================================

describe('isMemoryIndexerEnabled()', () => {
  it('returns false and never emits an OASIS event when Mem0 is disabled (Supabase primary)', () => {
    mockIsMem0Enabled.mockReturnValue(false);
    const mod = loadClient('http://memory-indexer:8080');

    expect(mod.isMemoryIndexerEnabled()).toBe(false);
    expect(mockGetMemorySourceStatus).toHaveBeenCalled();
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('returns false and emits memory.indexer.disabled when Mem0 is enabled but URL is missing', () => {
    mockIsMem0Enabled.mockReturnValue(true);
    const mod = loadClient(undefined);

    expect(mod.isMemoryIndexerEnabled()).toBe(false);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'memory.indexer.disabled',
        status: 'error',
        payload: expect.objectContaining({ memory_indexer_url: 'NOT_SET' }),
      })
    );
  });

  it('emits memory.indexer.disabled only once across repeated calls', () => {
    mockIsMem0Enabled.mockReturnValue(true);
    const mod = loadClient(undefined);

    mod.isMemoryIndexerEnabled();
    mod.isMemoryIndexerEnabled();
    mod.isMemoryIndexerEnabled();

    const disabledCalls = mockEmitOasisEvent.mock.calls.filter(
      (c) => c[0].type === 'memory.indexer.disabled'
    );
    expect(disabledCalls).toHaveLength(1);
  });

  it('returns true and emits no event when Mem0 is enabled and URL is configured', () => {
    mockIsMem0Enabled.mockReturnValue(true);
    const mod = loadClient('http://memory-indexer:8080');

    expect(mod.isMemoryIndexerEnabled()).toBe(true);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// =============================================================================
// getMemoryIndexerUrl()
// =============================================================================

describe('getMemoryIndexerUrl()', () => {
  it('returns the configured URL', () => {
    const mod = loadClient('http://memory-indexer:9090');
    expect(mod.getMemoryIndexerUrl()).toBe('http://memory-indexer:9090');
  });

  it('returns empty string when unconfigured', () => {
    const mod = loadClient(undefined);
    expect(mod.getMemoryIndexerUrl()).toBe('');
  });
});

// =============================================================================
// writeToMemoryIndexer()
// =============================================================================

describe('writeToMemoryIndexer()', () => {
  it('skips the HTTP call and returns skipped_no_url when URL is not configured', async () => {
    const mod = loadClient(undefined);
    const result = await mod.writeToMemoryIndexer({ user_id: 'u1', content: 'hi', role: 'user' });

    expect(result).toMatchObject({
      user_id: 'u1',
      role: 'user',
      decision: 'skipped_no_url',
      stored: false,
      memory_ids: [],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs to /memory/write and returns the parsed response on success', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockReturnValueOnce(
      fetchOk({
        user_id: 'u1',
        role: 'user',
        decision: 'ADD',
        stored: true,
        memory_ids: ['m-1'],
        timestamp: 123,
      })
    );

    const result = await mod.writeToMemoryIndexer({ user_id: 'u1', content: 'hello', role: 'user' });

    expect(result.stored).toBe(true);
    expect(result.memory_ids).toEqual(['m-1']);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://memory-indexer:8080/memory/write',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u1', content: 'hello', role: 'user' }),
      })
    );
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'orb.memory_indexer.write', status: 'success' })
    );
  });

  it('emits status=info (not success) when the write was not actually stored', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockReturnValueOnce(
      fetchOk({ user_id: 'u1', role: 'user', decision: 'NOOP', stored: false, memory_ids: [], timestamp: 1 })
    );

    await mod.writeToMemoryIndexer({ user_id: 'u1', content: 'hello', role: 'user' });

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'orb.memory_indexer.write', status: 'info' })
    );
  });

  it('catches network failures, returns an error result, and emits memory.write.failed', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await mod.writeToMemoryIndexer({ user_id: 'u1', content: 'hello', role: 'user' });

    expect(result.decision).toBe('error');
    expect(result.stored).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'memory.write.failed',
        status: 'error',
        payload: expect.objectContaining({ user_id: 'u1', error: 'ECONNREFUSED' }),
      })
    );
  });
});

// =============================================================================
// searchMemoryIndexer()
// =============================================================================

describe('searchMemoryIndexer()', () => {
  it('skips the HTTP call and returns empty hits when URL is not configured', async () => {
    const mod = loadClient(undefined);
    const result = await mod.searchMemoryIndexer({ user_id: 'u1', query: 'name' });

    expect(result).toMatchObject({ user_id: 'u1', query: 'name', hits: [], decision: 'skipped_no_url' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('defaults top_k to 5 when not provided', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockReturnValueOnce(fetchOk({ user_id: 'u1', query: 'name', hits: [], decision: 'ok', timestamp: 1 }));

    await mod.searchMemoryIndexer({ user_id: 'u1', query: 'name' });

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe('http://memory-indexer:8080/memory/search');
    expect(JSON.parse(call[1].body)).toEqual({ user_id: 'u1', query: 'name', top_k: 5 });
  });

  it('forwards an explicit top_k', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockReturnValueOnce(fetchOk({ user_id: 'u1', query: 'name', hits: [], decision: 'ok', timestamp: 1 }));

    await mod.searchMemoryIndexer({ user_id: 'u1', query: 'name', top_k: 2 });

    const call = mockFetch.mock.calls[0];
    expect(JSON.parse(call[1].body).top_k).toBe(2);
  });

  it('returns parsed hits and emits orb.memory_indexer.search on success', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    const hits = [
      { id: 'h1', memory: 'user likes coffee', score: 0.9, metadata: null },
      { id: 'h2', memory: 'user lives in Vienna', score: 0.7, metadata: null },
    ];
    mockFetch.mockReturnValueOnce(
      fetchOk({ user_id: 'u1', query: 'coffee', hits, decision: 'ok', timestamp: 1 })
    );

    const result = await mod.searchMemoryIndexer({ user_id: 'u1', query: 'coffee' });

    expect(result.hits).toEqual(hits);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orb.memory_indexer.search',
        payload: expect.objectContaining({ hits_count: 2 }),
      })
    );
  });

  it('catches network failures and returns empty hits without throwing or emitting OASIS', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    const result = await mod.searchMemoryIndexer({ user_id: 'u1', query: 'coffee' });

    expect(result.hits).toEqual([]);
    expect(result.decision).toBe('error');
    expect(result.error).toBe('timeout');
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// =============================================================================
// getMemoryContext()
// =============================================================================

describe('getMemoryContext()', () => {
  it('returns an explicit config error when URL is not configured', async () => {
    const mod = loadClient(undefined);
    const result = await mod.getMemoryContext({ user_id: 'u1', query: 'q' });

    expect(result).toEqual({ context: '', user_id: 'u1', error: 'MEMORY_INDEXER_URL not configured' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns the formatted context and emits orb.memory_indexer.context on success', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockReturnValueOnce(fetchOk({ context: 'User likes hiking.', user_id: 'u1' }));

    const result = await mod.getMemoryContext({ user_id: 'u1', query: 'hobbies' });

    expect(result.context).toBe('User likes hiking.');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orb.memory_indexer.context',
        payload: expect.objectContaining({ memory_context_chars: 'User likes hiking.'.length }),
      })
    );
  });

  it('catches network failures, returns empty context + error, and emits memory.read.failed', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await mod.getMemoryContext({ user_id: 'u1', query: 'hobbies' });

    expect(result.context).toBe('');
    expect(result.error).toBe('ECONNRESET');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'memory.read.failed', status: 'error' })
    );
  });
});

// =============================================================================
// buildMemoryIndexerEnhancedInstruction()
// =============================================================================

describe('buildMemoryIndexerEnhancedInstruction()', () => {
  it('returns the base instruction unchanged when context retrieval errors', async () => {
    const mod = loadClient(undefined); // no URL -> getMemoryContext errors immediately
    const result = await mod.buildMemoryIndexerEnhancedInstruction('BASE', 'u1', 'q');

    expect(result.instruction).toBe('BASE');
    expect(result.contextChars).toBe(0);
    expect(result.error).toBeDefined();
  });

  it('returns the base instruction unchanged when context is empty (no error)', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockReturnValueOnce(fetchOk({ context: '', user_id: 'u1' }));

    const result = await mod.buildMemoryIndexerEnhancedInstruction('BASE', 'u1', 'q');

    expect(result.instruction).toBe('BASE');
    expect(result.contextChars).toBe(0);
  });

  it('appends the memory context block when context is available', async () => {
    const mod = loadClient('http://memory-indexer:8080');
    mockFetch.mockReturnValueOnce(fetchOk({ context: 'User is named Alice.', user_id: 'u1' }));

    const result = await mod.buildMemoryIndexerEnhancedInstruction('BASE', 'u1', 'q');

    expect(result.instruction).toContain('BASE');
    expect(result.instruction).toContain('User is named Alice.');
    expect(result.instruction).toContain('User Memory Context');
    expect(result.contextChars).toBe('User is named Alice.'.length);
    expect(result.error).toBeUndefined();
  });
});
