/**
 * VTID-01230: Extraction Dedup Manager
 *
 * Prevents redundant fact extraction calls. Currently, extractAndPersistFacts()
 * is called from 13+ locations in orb-live.ts — every session start, stop,
 * WebSocket close, turn complete, etc. This leads to:
 * - Same transcript being extracted multiple times
 * - Wasted Gemini API calls (~$0.01/extraction × 13 = ~$0.13/session)
 * - write_fact() auto-supersedes duplicates, but the extraction cost remains
 *
 * Solution: Content-hash-based deduplication with TTL.
 *
 * Usage:
 *   import { deduplicatedExtract } from './extraction-dedup-manager';
 *
 *   // Instead of:
 *   extractAndPersistFacts({ conversationText, tenant_id, user_id, session_id });
 *
 *   // Use:
 *   deduplicatedExtract({ conversationText, tenant_id, user_id, session_id });
 */

import { createHash } from 'crypto';
import { extractAndPersistFacts, isInlineExtractionAvailable } from './inline-fact-extractor';
import { addSessionFact } from './session-memory-buffer';

// =============================================================================
// Configuration
// =============================================================================

const DEDUP_CONFIG = {
  /** Minimum interval between extractions for the same session (ms) */
  MIN_INTERVAL_MS: 60_000,
  /** Minimum new content length to trigger extraction */
  MIN_NEW_CONTENT_LENGTH: 50,
  /** Hash TTL — forget about old extractions after this period */
  HASH_TTL_MS: 30 * 60 * 1000, // 30 minutes
  /** Cleanup interval */
  CLEANUP_INTERVAL_MS: 10 * 60 * 1000, // 10 minutes
  /** Minimum number of new user turns since last extraction */
  MIN_NEW_TURNS: 3,
};

// =============================================================================
// Types
// =============================================================================

interface ExtractionRecord {
  /** Hash of the extracted content */
  content_hash: string;
  /** Timestamp of extraction */
  extracted_at: number;
  /** Number of characters extracted */
  char_count: number;
}

interface SessionExtractionState {
  session_id: string;
  /** All content hashes that have been extracted */
  extracted_hashes: Set<string>;
  /** Last extraction timestamp */
  last_extraction_at: number;
  /** Total characters extracted so far */
  total_chars_extracted: number;
  /** Turn count at last extraction */
  turn_count_at_last_extraction: number;
  /** Created at */
  created_at: number;
}

// =============================================================================
// State
// =============================================================================

const sessionStates = new Map<string, SessionExtractionState>();

// Periodic cleanup
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, state] of sessionStates) {
    if (now - state.last_extraction_at > DEDUP_CONFIG.HASH_TTL_MS &&
        now - state.created_at > DEDUP_CONFIG.HASH_TTL_MS) {
      sessionStates.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[VTID-01230-dedup] Cleaned ${cleaned} extraction states (${sessionStates.size} active)`);
  }
}, DEDUP_CONFIG.CLEANUP_INTERVAL_MS);

if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

// =============================================================================
// Helpers
// =============================================================================

function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex').substring(0, 16);
}

function getSessionState(session_id: string): SessionExtractionState {
  let state = sessionStates.get(session_id);
  if (!state) {
    state = {
      session_id,
      extracted_hashes: new Set(),
      last_extraction_at: 0,
      total_chars_extracted: 0,
      turn_count_at_last_extraction: 0,
      created_at: Date.now(),
    };
    sessionStates.set(session_id, state);
  }
  return state;
}

// =============================================================================
// Public API
// =============================================================================

export interface DeduplicatedExtractInput {
  conversationText: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  /** Current turn count (optional, for turn-based throttling) */
  turn_count?: number;
  /** Force extraction even if dedup would skip it (e.g., session end) */
  force?: boolean;
}

export interface DeduplicatedExtractResult {
  /** Whether extraction was actually triggered */
  extracted: boolean;
  /** Reason for skipping, if skipped */
  skip_reason?: string;
}

/**
 * Extract facts from conversation text with deduplication.
 *
 * Skips extraction if:
 * 1. Content hash was already extracted
 * 2. Less than MIN_INTERVAL_MS since last extraction
 * 3. Content is too short
 * 4. Inline extraction is not available
 *
 * Use `force: true` for session-end extraction (ensures final transcript is processed).
 */
export function deduplicatedExtract(
  input: DeduplicatedExtractInput,
): DeduplicatedExtractResult {
  // Check availability first
  if (!isInlineExtractionAvailable()) {
    return { extracted: false, skip_reason: 'inline_extraction_unavailable' };
  }

  // Check minimum content length
  if (input.conversationText.length < DEDUP_CONFIG.MIN_NEW_CONTENT_LENGTH) {
    return { extracted: false, skip_reason: 'content_too_short' };
  }

  const state = getSessionState(input.session_id);
  const now = Date.now();
  const contentHash = hashContent(input.conversationText);

  // Check if this exact content was already extracted
  if (!input.force && state.extracted_hashes.has(contentHash)) {
    return { extracted: false, skip_reason: 'duplicate_content' };
  }

  // Check time throttle
  if (!input.force && state.last_extraction_at > 0) {
    const elapsed = now - state.last_extraction_at;
    if (elapsed < DEDUP_CONFIG.MIN_INTERVAL_MS) {
      return { extracted: false, skip_reason: `throttled (${Math.round(elapsed / 1000)}s < ${DEDUP_CONFIG.MIN_INTERVAL_MS / 1000}s)` };
    }
  }

  // Check turn-based throttle
  if (!input.force && input.turn_count !== undefined) {
    const turnsSinceLastExtraction = input.turn_count - state.turn_count_at_last_extraction;
    if (turnsSinceLastExtraction < DEDUP_CONFIG.MIN_NEW_TURNS) {
      return { extracted: false, skip_reason: `insufficient_turns (${turnsSinceLastExtraction} < ${DEDUP_CONFIG.MIN_NEW_TURNS})` };
    }
  }

  // All checks passed — trigger extraction (fire-and-forget)
  state.extracted_hashes.add(contentHash);
  state.last_extraction_at = now;
  state.total_chars_extracted += input.conversationText.length;
  if (input.turn_count !== undefined) {
    state.turn_count_at_last_extraction = input.turn_count;
  }

  extractAndPersistFacts({
    conversationText: input.conversationText,
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    session_id: input.session_id,
  }).catch(err => {
    console.warn(`[VTID-01230-dedup] Extraction failed (non-blocking): ${err.message}`);
  });

  console.log(
    `[VTID-01230-dedup] Extraction triggered for session ${input.session_id.substring(0, 8)}... ` +
    `(${input.conversationText.length} chars, hash=${contentHash}, force=${!!input.force})`
  );

  return { extracted: true };
}

/**
 * Clear extraction state for a session (call on session destroy).
 */
export function clearExtractionState(session_id: string): void {
  sessionStates.delete(session_id);
}

/**
 * Get dedup stats for diagnostics.
 */
export function getDeduplicationStats(): {
  active_sessions: number;
  total_extractions_prevented: number;
  total_hashes_tracked: number;
} {
  let total_hashes = 0;
  for (const state of sessionStates.values()) {
    total_hashes += state.extracted_hashes.size;
  }
  return {
    active_sessions: sessionStates.size,
    total_extractions_prevented: 0, // Would need counter to track this
    total_hashes_tracked: total_hashes,
  };
}

export default {
  deduplicatedExtract,
  clearExtractionState,
  getDeduplicationStats,
};
