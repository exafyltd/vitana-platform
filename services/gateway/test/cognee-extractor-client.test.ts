/**
 * VTID-01225: Cognee Extractor Client Unit Tests
 *
 * Tests for:
 * - extract() - HTTP extraction with retry and timeout
 * - extractAsync() - Fire-and-forget wrapper
 * - persistExtractionResults() - 5-layer persistence (nodes, edges, signals, facts, memory_items)
 * - mapEntityToCategory() - Category mapping
 * - entityToFact() - Fact key/value generation
 * - Partial failure metrics tracking
 *
 * Platform invariant: Cognee extraction enriches Memory Garden via ORB Live,
 * Conversation, and Diary entry points.
 */

// Set test environment before imports
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key';
process.env.COGNEE_EXTRACTOR_URL = 'http://cognee-extractor:8080';

// Mock OASIS event service
const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: mockEmitOasisEvent,
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Import after mocks
import {
  cogneeExtractorClient,
  type CogneeExtractionRequest,
  type CogneeExtractionResponse,
  type CogneeEntity,
  type CogneeRelationship,
  type CogneeSignal,
} from '../src/services/cognee-extractor-client';

// =============================================================================
// Test Fixtures
// =============================================================================

function makeExtractionRequest(overrides?: Partial<CogneeExtractionRequest>): CogneeExtractionRequest {
  return {
    transcript: 'My name is John and I live in Vienna with my fiancée Maria. I work at Exafy.',
    tenant_id: '00000000-0000-0000-0000-000000000001',
    user_id: '00000000-0000-0000-0000-000000000099',
    session_id: 'test-session-123',
    active_role: 'community',
    ...overrides,
  };
}

function makeExtractionResponse(overrides?: Partial<CogneeExtractionResponse>): CogneeExtractionResponse {
  return {
    ok: true,
    entities: [
      {
        name: 'John',
        entity_type: 'PERSON',
        vitana_node_type: 'person',
        domain: 'personal',
        metadata: { value: 'John' },
      },
      {
        name: 'Maria',
        entity_type: 'PERSON',
        vitana_node_type: 'person',
        domain: 'relationship',
        metadata: { value: 'Maria', role: 'fiancée' },
      },
      {
        name: 'Exafy',
        entity_type: 'ORGANIZATION',
        vitana_node_type: 'organization',
        domain: 'business',
        metadata: { value: 'Exafy' },
      },
    ],
    relationships: [
      {
        from_entity: 'John',
        to_entity: 'Maria',
        cognee_type: 'ENGAGED_TO',
        vitana_type: 'partner',
        context: { source: 'test' },
      },
      {
        from_entity: 'John',
        to_entity: 'Exafy',
        cognee_type: 'WORKS_AT',
        vitana_type: 'employer',
        context: { source: 'test' },
      },
    ],
    signals: [
      {
        signal_key: 'relationship_stability',
        confidence: 85,
        evidence: { mentions: 'fiancée', sentiment: 'positive' },
      },
    ],
    session_id: 'test-session-123',
    tenant_id: '00000000-0000-0000-0000-000000000001',
    user_id: '00000000-0000-0000-0000-000000000099',
    transcript_hash: 'abc123',
    processing_ms: 150,
    ...overrides,
  };
}

/**
 * Helper: create a mock fetch response
 */
function mockFetchResponse(body: any, status = 200, ok = true) {
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
    blob: async () => new Blob(),
    arrayBuffer: async () => new ArrayBuffer(0),
    formData: async () => new FormData(),
  } as any);
}

// =============================================================================
// Tests
// =============================================================================

describe('VTID-01225: CogneeExtractorClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  // ===========================================================================
  // isEnabled()
  // ===========================================================================

  describe('isEnabled()', () => {
    it('returns true when COGNEE_EXTRACTOR_URL is set', () => {
      expect(cogneeExtractorClient.isEnabled()).toBe(true);
    });
  });

  // ===========================================================================
  // extract()
  // ===========================================================================

  describe('extract()', () => {
    it('sends POST to /extract and returns parsed response', async () => {
      const request = makeExtractionRequest();
      const response = makeExtractionResponse();

      mockFetch.mockReturnValueOnce(mockFetchResponse(response));

      const result = await cogneeExtractorClient.extract(request);

      expect(result.ok).toBe(true);
      expect(result.entities).toHaveLength(3);
      expect(result.relationships).toHaveLength(2);
      expect(result.signals).toHaveLength(1);

      // Verify fetch was called with correct URL and body
      expect(mockFetch).toHaveBeenCalledWith(
        'http://cognee-extractor:8080/extract',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-VTID': 'VTID-01225',
          }),
        })
      );

      // Verify OASIS events emitted: started + completed
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cognee.extraction.started' })
      );
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cognee.extraction.completed' })
      );
    });

    it('retries on network failure and succeeds on second attempt', async () => {
      const request = makeExtractionRequest();
      const response = makeExtractionResponse();

      // First attempt: network error
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      // Second attempt: success
      mockFetch.mockReturnValueOnce(mockFetchResponse(response));

      const result = await cogneeExtractorClient.extract(request);

      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws after all retries exhausted', async () => {
      const request = makeExtractionRequest();

      // All 3 attempts fail
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(cogneeExtractorClient.extract(request)).rejects.toThrow('ECONNREFUSED');

      // 1 initial + 2 retries = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Should emit error event
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cognee.extraction.error' })
      );
    });

    it('throws on non-200 HTTP response', async () => {
      const request = makeExtractionRequest();

      mockFetch.mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
          headers: new Headers(),
        } as any)
      );

      await expect(cogneeExtractorClient.extract(request)).rejects.toThrow('500');
    });
  });

  // ===========================================================================
  // extractAsync() + persistExtractionResults()
  // ===========================================================================

  describe('extractAsync() → persistExtractionResults()', () => {
    it('persists nodes, edges, signals, facts, and memory_items', async () => {
      const request = makeExtractionRequest();
      const response = makeExtractionResponse();

      // Mock the extraction call
      mockFetch.mockReturnValueOnce(mockFetchResponse(response));

      // Mock all subsequent persistence calls (nodes check + insert, edges, signals, facts, items)
      // We need many fetch calls: started event, extraction, completed event,
      // then for each entity: check existing + insert, for each rel: edge insert, etc.
      const defaultOk = mockFetchResponse([{ id: 'new-node-id-1' }], 200);
      const emptyArray = mockFetchResponse([], 200);

      // Set up a mock that handles different URLs
      mockFetch.mockImplementation((url: string, options?: any) => {
        const urlStr = typeof url === 'string' ? url : '';

        // Cognee extraction
        if (urlStr.includes('/extract')) {
          return mockFetchResponse(response);
        }

        // OASIS events
        if (urlStr.includes('/oasis_events')) {
          return mockFetchResponse([{ id: 'evt-1' }]);
        }

        // Node existence check (return empty = not found)
        if (urlStr.includes('/relationship_nodes?') && urlStr.includes('select=id')) {
          return mockFetchResponse([]);
        }

        // Node insert
        if (urlStr.includes('/relationship_nodes') && options?.method === 'POST') {
          const body = JSON.parse(options.body);
          return mockFetchResponse([{ id: `node-${body.title}` }]);
        }

        // Edge insert
        if (urlStr.includes('/relationship_edges')) {
          return mockFetchResponse(null, 201, true);
        }

        // Signal insert
        if (urlStr.includes('/relationship_signals')) {
          return mockFetchResponse(null, 201, true);
        }

        // write_fact RPC
        if (urlStr.includes('/rpc/write_fact')) {
          return mockFetchResponse('fact-id-123');
        }

        // memory_items insert
        if (urlStr.includes('/memory_items')) {
          return mockFetchResponse(null, 201, true);
        }

        return mockFetchResponse({ ok: true });
      });

      // Call extractAsync (fire-and-forget)
      cogneeExtractorClient.extractAsync(request);

      // Wait for async operations to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify nodes were checked and inserted (3 entities × 2 calls each = 6 node calls)
      const nodeCalls = mockFetch.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('relationship_nodes')
      );
      expect(nodeCalls.length).toBeGreaterThanOrEqual(3); // At least 3 checks

      // Verify edges were inserted (2 relationships)
      const edgeCalls = mockFetch.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('relationship_edges')
      );
      expect(edgeCalls.length).toBe(2);

      // Verify signals were inserted (1 signal)
      const signalCalls = mockFetch.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('relationship_signals')
      );
      expect(signalCalls.length).toBe(1);

      // Verify facts were written (3 entities via write_fact)
      const factCalls = mockFetch.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('/rpc/write_fact')
      );
      expect(factCalls.length).toBe(3);

      // Verify memory_items were written (3 entities)
      const memoryCalls = mockFetch.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('/memory_items')
      );
      expect(memoryCalls.length).toBe(3);

      // Verify OASIS persisted event was emitted
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cognee.extraction.persisted',
          payload: expect.objectContaining({
            nodes_created: expect.any(Number),
            edges_created: expect.any(Number),
            signals_persisted: expect.any(Number),
          }),
        })
      );
    });

    it('emits partial_failure event when some operations fail', async () => {
      const request = makeExtractionRequest();
      const response = makeExtractionResponse({
        entities: [
          { name: 'FailEntity', entity_type: 'PERSON', vitana_node_type: 'person', domain: 'personal', metadata: {} },
        ],
        relationships: [],
        signals: [],
      });

      mockFetch.mockImplementation((url: string, options?: any) => {
        const urlStr = typeof url === 'string' ? url : '';

        if (urlStr.includes('/extract')) {
          return mockFetchResponse(response);
        }
        if (urlStr.includes('/oasis_events')) {
          return mockFetchResponse([{ id: 'evt-1' }]);
        }

        // Node check returns empty
        if (urlStr.includes('/relationship_nodes?') && urlStr.includes('select=id')) {
          return mockFetchResponse([]);
        }

        // Node insert FAILS
        if (urlStr.includes('/relationship_nodes') && options?.method === 'POST') {
          return mockFetchResponse({ error: 'permission denied' }, 403, false);
        }

        // write_fact FAILS
        if (urlStr.includes('/rpc/write_fact')) {
          return mockFetchResponse({ error: 'rpc error' }, 500, false);
        }

        // memory_items FAILS
        if (urlStr.includes('/memory_items')) {
          return mockFetchResponse({ error: 'insert failed' }, 500, false);
        }

        return mockFetchResponse({ ok: true });
      });

      cogneeExtractorClient.extractAsync(request);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should emit partial_failure event
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cognee.persistence.partial_failure',
          status: 'warning',
          payload: expect.objectContaining({
            total_failures: expect.any(Number),
          }),
        })
      );
    });

    it('skips edges when entity nodes are missing from map', async () => {
      const request = makeExtractionRequest();
      const response = makeExtractionResponse({
        entities: [], // No entities extracted
        relationships: [
          {
            from_entity: 'Unknown1',
            to_entity: 'Unknown2',
            cognee_type: 'KNOWS',
            vitana_type: 'knows',
            context: {},
          },
        ],
        signals: [],
      });

      mockFetch.mockImplementation((url: string) => {
        const urlStr = typeof url === 'string' ? url : '';
        if (urlStr.includes('/extract')) return mockFetchResponse(response);
        if (urlStr.includes('/oasis_events')) return mockFetchResponse([{ id: 'evt-1' }]);
        return mockFetchResponse({ ok: true });
      });

      cogneeExtractorClient.extractAsync(request);
      await new Promise(resolve => setTimeout(resolve, 500));

      // No edge calls should be made (entities not found)
      const edgeCalls = mockFetch.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('relationship_edges')
      );
      expect(edgeCalls.length).toBe(0);
    });

    it('does not persist when extraction returns no results', async () => {
      const request = makeExtractionRequest();
      const response = makeExtractionResponse({
        entities: [],
        relationships: [],
        signals: [],
      });

      mockFetch.mockReturnValueOnce(mockFetchResponse(response));

      cogneeExtractorClient.extractAsync(request);
      await new Promise(resolve => setTimeout(resolve, 300));

      // No persistence calls should be made (only extraction + OASIS events)
      const persistCalls = mockFetch.mock.calls.filter(
        (call: any[]) => {
          const urlStr = typeof call[0] === 'string' ? call[0] : '';
          return urlStr.includes('relationship_nodes') ||
            urlStr.includes('relationship_edges') ||
            urlStr.includes('relationship_signals') ||
            urlStr.includes('write_fact') ||
            urlStr.includes('memory_items');
        }
      );
      expect(persistCalls.length).toBe(0);
    });
  });

  // ===========================================================================
  // healthCheck()
  // ===========================================================================

  describe('healthCheck()', () => {
    it('returns healthy when service responds with status=healthy', async () => {
      mockFetch.mockReturnValueOnce(
        mockFetchResponse({ status: 'healthy', service: 'cognee-extractor', vtid: 'VTID-01225', version: '1.0.0' })
      );

      const result = await cogneeExtractorClient.healthCheck();
      expect(result.healthy).toBe(true);
      expect(result.details?.service).toBe('cognee-extractor');
    });

    it('returns unhealthy on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await cogneeExtractorClient.healthCheck();
      expect(result.healthy).toBe(false);
    });

    it('returns unhealthy on non-200 response', async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({ ok: false, status: 503, headers: new Headers() } as any)
      );

      const result = await cogneeExtractorClient.healthCheck();
      expect(result.healthy).toBe(false);
    });
  });
});
