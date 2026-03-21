/**
 * VTID-01230: Session Memory Buffer Unit Tests
 *
 * Tests the in-process sliding window that provides zero-latency
 * turn-to-turn context for the LLM.
 */

import {
  getOrCreateSessionBuffer,
  addTurn,
  addSessionFact,
  getSessionContext,
  formatSessionBufferForLLM,
  destroySessionBuffer,
  getBufferStats,
} from '../src/services/session-memory-buffer';

// =============================================================================
// Helpers
// =============================================================================

const T = 'tenant-001';
const U = 'user-001';
let sessionCounter = 0;

/** Unique session ID per test to avoid cross-test contamination. */
function freshSession(): string {
  return `session-buffer-test-${++sessionCounter}-${Date.now()}`;
}

// =============================================================================
// Tests
// =============================================================================

describe('VTID-01230: Session Memory Buffer', () => {
  afterEach(() => {
    // Cleanup any sessions created during the test
    // (destroySessionBuffer is idempotent)
  });

  // =========================================================================
  // 1. getOrCreateSessionBuffer
  // =========================================================================

  describe('getOrCreateSessionBuffer', () => {
    it('should create a new buffer when none exists', () => {
      const sid = freshSession();
      const buffer = getOrCreateSessionBuffer(sid, T, U);

      expect(buffer.session_id).toBe(sid);
      expect(buffer.tenant_id).toBe(T);
      expect(buffer.user_id).toBe(U);
      expect(buffer.turns).toHaveLength(0);
      expect(buffer.session_facts.size).toBe(0);

      destroySessionBuffer(sid);
    });

    it('should return the same buffer on repeated calls', () => {
      const sid = freshSession();
      const b1 = getOrCreateSessionBuffer(sid, T, U);
      const b2 = getOrCreateSessionBuffer(sid, T, U);

      expect(b1).toBe(b2); // Same reference
      destroySessionBuffer(sid);
    });

    it('should update last_activity on access', () => {
      const sid = freshSession();
      const b1 = getOrCreateSessionBuffer(sid, T, U);
      const t1 = b1.last_activity;

      // Small delay to ensure timestamp difference
      const b2 = getOrCreateSessionBuffer(sid, T, U);
      expect(b2.last_activity).toBeGreaterThanOrEqual(t1);

      destroySessionBuffer(sid);
    });
  });

  // =========================================================================
  // 2. addTurn
  // =========================================================================

  describe('addTurn', () => {
    it('should add a user turn to the buffer', () => {
      const sid = freshSession();
      addTurn(sid, T, U, 'user', 'Hello, my name is Dragan');

      const ctx = getSessionContext(sid);
      expect(ctx).not.toBeNull();
      expect(ctx!.turn_count).toBe(1);
      expect(ctx!.recent_turns[0].role).toBe('user');
      expect(ctx!.recent_turns[0].content).toBe('Hello, my name is Dragan');

      destroySessionBuffer(sid);
    });

    it('should add an assistant turn to the buffer', () => {
      const sid = freshSession();
      addTurn(sid, T, U, 'user', 'Hi');
      addTurn(sid, T, U, 'assistant', 'Hello! How can I help?');

      const ctx = getSessionContext(sid);
      expect(ctx!.turn_count).toBe(2);
      expect(ctx!.recent_turns[1].role).toBe('assistant');

      destroySessionBuffer(sid);
    });

    it('should truncate long content', () => {
      const sid = freshSession();
      const longContent = 'A'.repeat(2000);
      addTurn(sid, T, U, 'user', longContent);

      const ctx = getSessionContext(sid);
      // MAX_TURN_CHARS is 1000, so it should be truncated
      expect(ctx!.recent_turns[0].content.length).toBeLessThanOrEqual(1003); // 1000 + '...'
      expect(ctx!.recent_turns[0].content.endsWith('...')).toBe(true);

      destroySessionBuffer(sid);
    });

    it('should enforce sliding window (max 10 turns)', () => {
      const sid = freshSession();

      // Add 15 turns
      for (let i = 0; i < 15; i++) {
        addTurn(sid, T, U, i % 2 === 0 ? 'user' : 'assistant', `Turn ${i}`);
      }

      const ctx = getSessionContext(sid);
      expect(ctx!.turn_count).toBe(10); // MAX_TURNS = 10
      // Oldest turn should be Turn 5 (0-4 evicted)
      expect(ctx!.recent_turns[0].content).toBe('Turn 5');
      expect(ctx!.recent_turns[9].content).toBe('Turn 14');

      destroySessionBuffer(sid);
    });

    it('should cache extracted facts from a turn', () => {
      const sid = freshSession();
      addTurn(sid, T, U, 'user', 'My name is Dragan', [
        { key: 'user_name', value: 'Dragan' },
        { key: 'user_residence', value: 'Aachen' },
      ]);

      const ctx = getSessionContext(sid);
      expect(ctx!.session_facts).toEqual({
        user_name: 'Dragan',
        user_residence: 'Aachen',
      });

      destroySessionBuffer(sid);
    });

    it('should set timestamp on each turn', () => {
      const sid = freshSession();
      addTurn(sid, T, U, 'user', 'Hello');

      const ctx = getSessionContext(sid);
      const ts = ctx!.recent_turns[0].timestamp;
      expect(ts).toBeDefined();
      // Should be a valid ISO date
      expect(new Date(ts).getTime()).not.toBeNaN();

      destroySessionBuffer(sid);
    });
  });

  // =========================================================================
  // 3. addSessionFact
  // =========================================================================

  describe('addSessionFact', () => {
    it('should store a session fact for immediate reuse', () => {
      const sid = freshSession();
      addSessionFact(sid, T, U, 'user_name', 'Dragan');
      addSessionFact(sid, T, U, 'user_residence', 'Aachen');

      const ctx = getSessionContext(sid);
      expect(ctx!.session_facts).toEqual({
        user_name: 'Dragan',
        user_residence: 'Aachen',
      });

      destroySessionBuffer(sid);
    });

    it('should overwrite existing fact with same key', () => {
      const sid = freshSession();
      addSessionFact(sid, T, U, 'user_name', 'Dragan');
      addSessionFact(sid, T, U, 'user_name', 'Dragan Alexander');

      const ctx = getSessionContext(sid);
      expect(ctx!.session_facts['user_name']).toBe('Dragan Alexander');

      destroySessionBuffer(sid);
    });
  });

  // =========================================================================
  // 4. getSessionContext
  // =========================================================================

  describe('getSessionContext', () => {
    it('should return null for unknown session', () => {
      const ctx = getSessionContext('nonexistent-session-id');
      expect(ctx).toBeNull();
    });

    it('should return is_continuation=true when turns exist', () => {
      const sid = freshSession();
      addTurn(sid, T, U, 'user', 'Hello');

      const ctx = getSessionContext(sid);
      expect(ctx!.is_continuation).toBe(true);

      destroySessionBuffer(sid);
    });

    it('should return is_continuation=false for empty buffer', () => {
      const sid = freshSession();
      getOrCreateSessionBuffer(sid, T, U); // create but don't add turns

      const ctx = getSessionContext(sid);
      expect(ctx!.is_continuation).toBe(false);
      expect(ctx!.turn_count).toBe(0);

      destroySessionBuffer(sid);
    });

    it('should return plain object for session_facts (not Map)', () => {
      const sid = freshSession();
      addSessionFact(sid, T, U, 'user_name', 'Dragan');

      const ctx = getSessionContext(sid);
      // Should be a plain object, not a Map
      expect(ctx!.session_facts).toBeInstanceOf(Object);
      expect(ctx!.session_facts).not.toBeInstanceOf(Map);
      expect(ctx!.session_facts['user_name']).toBe('Dragan');

      destroySessionBuffer(sid);
    });
  });

  // =========================================================================
  // 5. formatSessionBufferForLLM
  // =========================================================================

  describe('formatSessionBufferForLLM', () => {
    it('should return empty string for unknown session', () => {
      const output = formatSessionBufferForLLM('nonexistent-session');
      expect(output).toBe('');
    });

    it('should return empty string for empty buffer', () => {
      const sid = freshSession();
      getOrCreateSessionBuffer(sid, T, U);

      const output = formatSessionBufferForLLM(sid);
      expect(output).toBe('');

      destroySessionBuffer(sid);
    });

    it('should include session facts in XML tags', () => {
      const sid = freshSession();
      addSessionFact(sid, T, U, 'user_name', 'Dragan');
      addTurn(sid, T, U, 'user', 'My name is Dragan');

      const output = formatSessionBufferForLLM(sid);
      expect(output).toContain('<session_facts>');
      expect(output).toContain('</session_facts>');
      expect(output).toContain('user_name: Dragan');

      destroySessionBuffer(sid);
    });

    it('should include recent conversation turns in XML tags', () => {
      const sid = freshSession();
      addTurn(sid, T, U, 'user', 'Hello!');
      addTurn(sid, T, U, 'assistant', 'Hi there!');

      const output = formatSessionBufferForLLM(sid);
      expect(output).toContain('<recent_conversation>');
      expect(output).toContain('</recent_conversation>');
      expect(output).toContain('User: Hello!');
      expect(output).toContain('Assistant: Hi there!');

      destroySessionBuffer(sid);
    });

    it('should label roles correctly (User, Assistant, System)', () => {
      const sid = freshSession();
      addTurn(sid, T, U, 'user', 'user message');
      addTurn(sid, T, U, 'assistant', 'assistant message');
      addTurn(sid, T, U, 'system', 'system message');

      const output = formatSessionBufferForLLM(sid);
      expect(output).toContain('User: user message');
      expect(output).toContain('Assistant: assistant message');
      expect(output).toContain('System: system message');

      destroySessionBuffer(sid);
    });

    it('should respect MAX_BUFFER_CHARS budget', () => {
      const sid = freshSession();
      // Add 10 turns of 900 chars each = 9000 chars (over 8000 budget)
      for (let i = 0; i < 10; i++) {
        addTurn(sid, T, U, 'user', `Turn${i}_${'X'.repeat(890)}`);
      }

      const output = formatSessionBufferForLLM(sid);
      // Count how many "User:" labels appear — this tells us how many turns included
      const turnLabels = (output.match(/User:/g) || []).length;
      // At ~920 chars/turn + overhead, 8000 budget fits ~8 turns, not all 10
      expect(turnLabels).toBeGreaterThan(0);
      expect(turnLabels).toBeLessThan(10);

      destroySessionBuffer(sid);
    });
  });

  // =========================================================================
  // 6. destroySessionBuffer
  // =========================================================================

  describe('destroySessionBuffer', () => {
    it('should remove the session buffer', () => {
      const sid = freshSession();
      addTurn(sid, T, U, 'user', 'Hello');
      expect(getSessionContext(sid)).not.toBeNull();

      destroySessionBuffer(sid);
      expect(getSessionContext(sid)).toBeNull();
    });

    it('should be idempotent (no error on double destroy)', () => {
      const sid = freshSession();
      destroySessionBuffer(sid);
      destroySessionBuffer(sid); // Should not throw
    });
  });

  // =========================================================================
  // 7. getBufferStats
  // =========================================================================

  describe('getBufferStats', () => {
    it('should return correct stats', () => {
      const sid1 = freshSession();
      const sid2 = freshSession();

      addTurn(sid1, T, U, 'user', 'Turn 1');
      addTurn(sid1, T, U, 'assistant', 'Turn 2');
      addSessionFact(sid1, T, U, 'user_name', 'Dragan');

      addTurn(sid2, T, U, 'user', 'Turn 1');

      const stats = getBufferStats();
      expect(stats.active_sessions).toBeGreaterThanOrEqual(2);
      expect(stats.total_turns).toBeGreaterThanOrEqual(3);
      expect(stats.total_facts).toBeGreaterThanOrEqual(1);

      destroySessionBuffer(sid1);
      destroySessionBuffer(sid2);
    });
  });
});
