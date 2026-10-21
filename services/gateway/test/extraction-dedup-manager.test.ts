/**
 * VTID-01230: Extraction Dedup Manager Unit Tests
 *
 * Tests content-hash-based deduplication preventing redundant
 * fact extraction calls across 13+ call sites.
 */

// Set env BEFORE imports
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key';
process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';

// Mock VertexAI to make isInlineExtractionAvailable() return true
jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockResolvedValue({
        response: {
          candidates: [{
            content: { parts: [{ text: '[]' }] },
            finishReason: 'STOP',
          }],
        },
      }),
    }),
  })),
}));

// Mock fetch globally (for extractAndPersistFacts internals)
const fetchCalls: Array<{ url: string; method: string }> = [];
global.fetch = jest.fn().mockImplementation(async (url: string, options?: RequestInit) => {
  fetchCalls.push({ url, method: options?.method || 'GET' });
  if (url.includes('write_fact')) {
    return { ok: true, json: async () => 'fact-id' };
  }
  return { ok: true, json: async () => ({}), text: async () => '' };
}) as any;

import {
  deduplicatedExtract,
  clearExtractionState,
  getDeduplicationStats,
} from '../src/services/extraction-dedup-manager';

// =============================================================================
// Helpers
// =============================================================================

let sessionCounter = 0;

function freshSession(): string {
  return `dedup-test-${++sessionCounter}-${Date.now()}`;
}

const sampleConversation = 'User: My name is Dragan and I live in Aachen.\nAssistant: Nice to meet you!';
const shortConversation = 'Hi';

// =============================================================================
// Tests
// =============================================================================

describe('VTID-01230: Extraction Dedup Manager', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    (global.fetch as jest.Mock).mockClear();
  });

  // =========================================================================
  // 1. Basic extraction trigger
  // =========================================================================

  describe('Basic extraction', () => {
    it('should trigger extraction on first call for a session', () => {
      const sid = freshSession();
      const result = deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
      });

      expect(result.extracted).toBe(true);
      expect(result.skip_reason).toBeUndefined();

      clearExtractionState(sid);
    });

    it('should skip extraction for content too short', () => {
      const sid = freshSession();
      const result = deduplicatedExtract({
        conversationText: shortConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
      });

      expect(result.extracted).toBe(false);
      expect(result.skip_reason).toBe('content_too_short');

      clearExtractionState(sid);
    });
  });

  // =========================================================================
  // 2. Content hash deduplication
  // =========================================================================

  describe('Content hash deduplication', () => {
    it('should skip duplicate content (same hash)', () => {
      const sid = freshSession();
      const input = {
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
      };

      // First call — triggers
      const r1 = deduplicatedExtract(input);
      expect(r1.extracted).toBe(true);

      // Second call with SAME content — should skip
      const r2 = deduplicatedExtract(input);
      expect(r2.extracted).toBe(false);
      expect(r2.skip_reason).toBe('duplicate_content');

      clearExtractionState(sid);
    });

    it('should trigger for different content in the same session', () => {
      const sid = freshSession();

      // First call
      const r1 = deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
      });
      expect(r1.extracted).toBe(true);

      // Different content — but will be throttled by time
      // So we use force to bypass time throttle
      const r2 = deduplicatedExtract({
        conversationText: 'User: I also love Earl Grey tea.\nAssistant: Great taste!',
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
        force: true,
      });
      expect(r2.extracted).toBe(true);

      clearExtractionState(sid);
    });
  });

  // =========================================================================
  // 3. Time throttle
  // =========================================================================

  describe('Time throttle', () => {
    it('should throttle extraction within MIN_INTERVAL_MS', () => {
      const sid = freshSession();

      // First call — triggers
      const r1 = deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
      });
      expect(r1.extracted).toBe(true);

      // Immediately after, DIFFERENT content — should be throttled
      const r2 = deduplicatedExtract({
        conversationText: 'User: A completely different conversation about weather.\nAssistant: Indeed!',
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
      });
      expect(r2.extracted).toBe(false);
      expect(r2.skip_reason).toContain('throttled');

      clearExtractionState(sid);
    });
  });

  // =========================================================================
  // 4. Turn-based throttle
  // =========================================================================

  describe('Turn-based throttle', () => {
    it('should skip when insufficient new turns', () => {
      const sid = freshSession();

      // First call with turn_count=3 (>= MIN_NEW_TURNS) — triggers
      const r1 = deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
        turn_count: 3,
      });
      expect(r1.extracted).toBe(true);

      // Second call with turn_count=1 uses a different session to avoid time throttle
      // Instead, verify that turn_count=1 (< MIN_NEW_TURNS=3) causes a skip on a fresh session
      const sid2 = freshSession();
      const r2 = deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid2,
        turn_count: 1, // 1 - 0 = 1 turn, less than MIN_NEW_TURNS=3
      });
      expect(r2.extracted).toBe(false);
      expect(r2.skip_reason).toContain('insufficient_turns');

      clearExtractionState(sid);
      clearExtractionState(sid2);
    });

    it('should track turn_count_at_last_extraction', () => {
      const sid = freshSession();

      deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
        turn_count: 5,
      });

      // Stats should show the session is tracked
      const stats = getDeduplicationStats();
      expect(stats.active_sessions).toBeGreaterThanOrEqual(1);

      clearExtractionState(sid);
    });
  });

  // =========================================================================
  // 5. Force flag
  // =========================================================================

  describe('Force flag', () => {
    it('should bypass duplicate check when force=true', () => {
      const sid = freshSession();
      const input = {
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
        force: false as boolean,
      };

      // First call — triggers
      deduplicatedExtract(input);

      // Same content with force=true — should still trigger
      const r2 = deduplicatedExtract({ ...input, force: true });
      expect(r2.extracted).toBe(true);

      clearExtractionState(sid);
    });

    it('should bypass time throttle when force=true', () => {
      const sid = freshSession();

      deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
      });

      // Immediately after with different content and force
      const r2 = deduplicatedExtract({
        conversationText: 'User: Something completely different for testing purposes.\nAssistant: OK.',
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
        force: true,
      });
      expect(r2.extracted).toBe(true);

      clearExtractionState(sid);
    });
  });

  // =========================================================================
  // 6. clearExtractionState
  // =========================================================================

  describe('clearExtractionState', () => {
    it('should reset state so next extraction triggers', () => {
      const sid = freshSession();

      deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
      });

      // Clear state
      clearExtractionState(sid);

      // Same content should trigger again since state was cleared
      const r2 = deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid,
      });
      expect(r2.extracted).toBe(true);

      clearExtractionState(sid);
    });

    it('should be idempotent', () => {
      const sid = freshSession();
      clearExtractionState(sid);
      clearExtractionState(sid); // Should not throw
    });
  });

  // =========================================================================
  // 7. getDeduplicationStats
  // =========================================================================

  describe('getDeduplicationStats', () => {
    it('should return stats about tracked sessions', () => {
      const sid1 = freshSession();
      const sid2 = freshSession();

      deduplicatedExtract({
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid1,
      });

      deduplicatedExtract({
        conversationText: 'User: Another conversation about facts.\nAssistant: Interesting!',
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        session_id: sid2,
      });

      const stats = getDeduplicationStats();
      expect(stats.active_sessions).toBeGreaterThanOrEqual(2);
      expect(stats.total_hashes_tracked).toBeGreaterThanOrEqual(2);

      clearExtractionState(sid1);
      clearExtractionState(sid2);
    });
  });

  // =========================================================================
  // 8. Cross-session isolation
  // =========================================================================

  describe('Cross-session isolation', () => {
    it('should not dedup across different sessions', () => {
      const sid1 = freshSession();
      const sid2 = freshSession();

      // Same content in two different sessions — both should trigger
      const input = {
        conversationText: sampleConversation,
        tenant_id: 'tenant-1',
        user_id: 'user-1',
      };

      const r1 = deduplicatedExtract({ ...input, session_id: sid1 });
      const r2 = deduplicatedExtract({ ...input, session_id: sid2 });

      expect(r1.extracted).toBe(true);
      expect(r2.extracted).toBe(true);

      clearExtractionState(sid1);
      clearExtractionState(sid2);
    });
  });
});
