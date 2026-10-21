/**
 * VTID-01230: Session Memory Buffer (Tier 0)
 *
 * In-process sliding window of recent conversation turns that is ALWAYS
 * injected into the LLM context — no database round-trip needed.
 *
 * Solves the critical gap: between async fact extraction (fire-and-forget)
 * and the next turn, the LLM had no guaranteed access to what was just said.
 * This buffer ensures turn-to-turn coherence.
 *
 * Design:
 * - Keyed by session_id (thread_id or orb session ID)
 * - Stores last N turns (configurable, default 10)
 * - Auto-evicts sessions after TTL (default 30 min)
 * - Extracts "hot facts" — facts mentioned in the current session that
 *   should override or supplement long-term memory
 * - Thread-safe: single-writer per session (Express is single-threaded)
 *
 * Integration:
 * - conversation.ts: calls addTurn() after each user/assistant message
 * - orb-live.ts: calls addTurn() on transcriptTurns push
 * - context-pack-builder.ts: calls getSessionContext() to inject buffer
 */

// =============================================================================
// Configuration
// =============================================================================

const SESSION_BUFFER_CONFIG = {
  /** Maximum turns to keep per session */
  MAX_TURNS: 10,
  /** Session TTL in milliseconds (30 minutes) */
  SESSION_TTL_MS: 30 * 60 * 1000,
  /** Cleanup interval (every 5 minutes) */
  CLEANUP_INTERVAL_MS: 5 * 60 * 1000,
  /** Max characters per turn content (truncate long messages) */
  MAX_TURN_CHARS: 1000,
  /** Max total buffer size in characters (for token budget estimation) */
  MAX_BUFFER_CHARS: 8000,
};

// =============================================================================
// Types
// =============================================================================

export interface SessionTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  /** Optional: facts extracted from this turn (cached for immediate reuse) */
  extracted_facts?: Array<{ key: string; value: string }>;
}

export interface SessionBuffer {
  session_id: string;
  tenant_id: string;
  user_id: string;
  turns: SessionTurn[];
  /** Facts extracted during this session — immediately available without DB lookup */
  session_facts: Map<string, string>;
  created_at: number;
  last_activity: number;
}

export interface SessionContext {
  /** Recent conversation turns formatted for LLM injection */
  recent_turns: SessionTurn[];
  /** Facts extracted during this session (key→value) */
  session_facts: Record<string, string>;
  /** Number of turns in buffer */
  turn_count: number;
  /** Whether this is a continuation (has prior turns) */
  is_continuation: boolean;
}

// =============================================================================
// Session Store
// =============================================================================

const sessions = new Map<string, SessionBuffer>();

// Periodic cleanup of expired sessions
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions) {
    if (now - session.last_activity > SESSION_BUFFER_CONFIG.SESSION_TTL_MS) {
      sessions.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[VTID-01230] Cleaned ${cleaned} expired session buffers (${sessions.size} active)`);
  }
}, SESSION_BUFFER_CONFIG.CLEANUP_INTERVAL_MS);

// Prevent cleanup interval from keeping Node alive
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get or create a session buffer.
 */
export function getOrCreateSessionBuffer(
  session_id: string,
  tenant_id: string,
  user_id: string,
): SessionBuffer {
  const existing = sessions.get(session_id);
  if (existing) {
    existing.last_activity = Date.now();
    return existing;
  }

  const buffer: SessionBuffer = {
    session_id,
    tenant_id,
    user_id,
    turns: [],
    session_facts: new Map(),
    created_at: Date.now(),
    last_activity: Date.now(),
  };

  sessions.set(session_id, buffer);
  return buffer;
}

/**
 * Add a turn to the session buffer.
 * Automatically trims to MAX_TURNS using sliding window.
 */
export function addTurn(
  session_id: string,
  tenant_id: string,
  user_id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  extracted_facts?: Array<{ key: string; value: string }>,
): void {
  const buffer = getOrCreateSessionBuffer(session_id, tenant_id, user_id);

  // Truncate content if too long
  const truncatedContent = content.length > SESSION_BUFFER_CONFIG.MAX_TURN_CHARS
    ? content.substring(0, SESSION_BUFFER_CONFIG.MAX_TURN_CHARS) + '...'
    : content;

  const turn: SessionTurn = {
    role,
    content: truncatedContent,
    timestamp: new Date().toISOString(),
    extracted_facts,
  };

  buffer.turns.push(turn);

  // Sliding window: keep only last MAX_TURNS
  if (buffer.turns.length > SESSION_BUFFER_CONFIG.MAX_TURNS) {
    buffer.turns = buffer.turns.slice(-SESSION_BUFFER_CONFIG.MAX_TURNS);
  }

  // Cache any extracted facts for immediate reuse
  if (extracted_facts) {
    for (const fact of extracted_facts) {
      buffer.session_facts.set(fact.key, fact.value);
    }
  }

  buffer.last_activity = Date.now();
}

/**
 * Register a fact discovered during this session.
 * These facts are immediately available without waiting for async DB writes.
 */
export function addSessionFact(
  session_id: string,
  tenant_id: string,
  user_id: string,
  fact_key: string,
  fact_value: string,
): void {
  const buffer = getOrCreateSessionBuffer(session_id, tenant_id, user_id);
  buffer.session_facts.set(fact_key, fact_value);
  buffer.last_activity = Date.now();
}

/**
 * Get session context for injection into LLM.
 * Returns recent turns and session-scoped facts.
 */
export function getSessionContext(session_id: string): SessionContext | null {
  const buffer = sessions.get(session_id);
  if (!buffer) {
    return null;
  }

  buffer.last_activity = Date.now();

  // Convert session_facts Map to plain object
  const factsObj: Record<string, string> = {};
  for (const [k, v] of buffer.session_facts) {
    factsObj[k] = v;
  }

  return {
    recent_turns: buffer.turns,
    session_facts: factsObj,
    turn_count: buffer.turns.length,
    is_continuation: buffer.turns.length > 0,
  };
}

/**
 * Format session buffer for LLM system instruction injection.
 * Returns a compact string to prepend to the context pack.
 */
export function formatSessionBufferForLLM(session_id: string): string {
  const ctx = getSessionContext(session_id);
  if (!ctx || ctx.turn_count === 0) {
    return '';
  }

  let output = '';

  // Session facts (highest priority — things learned THIS session)
  const factEntries = Object.entries(ctx.session_facts);
  if (factEntries.length > 0) {
    output += '<session_facts>\n';
    output += 'Facts learned in this conversation (highest confidence):\n';
    for (const [key, value] of factEntries) {
      output += `- ${key}: ${value}\n`;
    }
    output += '</session_facts>\n\n';
  }

  // Recent conversation turns (sliding window)
  output += '<recent_conversation>\n';
  output += `Recent conversation (last ${ctx.turn_count} turns):\n\n`;

  // Enforce character budget
  let charCount = 0;
  const turnsToInclude: SessionTurn[] = [];

  // Walk backwards from most recent, include as many turns as fit
  for (let i = ctx.recent_turns.length - 1; i >= 0; i--) {
    const turn = ctx.recent_turns[i];
    const turnChars = turn.content.length + 20; // role prefix overhead
    if (charCount + turnChars > SESSION_BUFFER_CONFIG.MAX_BUFFER_CHARS) break;
    turnsToInclude.unshift(turn);
    charCount += turnChars;
  }

  for (const turn of turnsToInclude) {
    const label = turn.role === 'user' ? 'User' : turn.role === 'assistant' ? 'Assistant' : 'System';
    output += `${label}: ${turn.content}\n`;
  }

  output += '</recent_conversation>\n\n';

  return output;
}

/**
 * Destroy a session buffer (call on session end).
 */
export function destroySessionBuffer(session_id: string): void {
  sessions.delete(session_id);
}

/**
 * Get buffer stats for diagnostics.
 */
export function getBufferStats(): {
  active_sessions: number;
  total_turns: number;
  total_facts: number;
} {
  let total_turns = 0;
  let total_facts = 0;
  for (const session of sessions.values()) {
    total_turns += session.turns.length;
    total_facts += session.session_facts.size;
  }
  return {
    active_sessions: sessions.size,
    total_turns,
    total_facts,
  };
}

// =============================================================================
// Exports
// =============================================================================

export default {
  getOrCreateSessionBuffer,
  addTurn,
  addSessionFact,
  getSessionContext,
  formatSessionBufferForLLM,
  destroySessionBuffer,
  getBufferStats,
};
