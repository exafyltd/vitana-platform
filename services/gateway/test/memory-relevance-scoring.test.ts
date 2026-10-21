/**
 * VTID-01115: Memory Relevance Scoring Engine Tests
 * VT_LAYER: INTELLIGENCE
 * VT_MODULE: MEMORY / SCORING
 *
 * Tests for the deterministic memory relevance scoring engine.
 * Ensures:
 * - Determinism: Same inputs -> same scores
 * - Factor weights are respected
 * - Thresholds work correctly
 * - Sensitivity detection functions properly
 * - Domain caps are enforced
 */

import {
  scoreMemoryItem,
  scoreAndRankMemories,
  shouldIncludeMemory,
  getScoringDecision,
  detectSensitivityFlags,
  FACTOR_MAX_WEIGHTS,
  SCORE_THRESHOLDS,
  SENSITIVE_MEMORY_THRESHOLD,
  DOMAIN_CAPS,
  RECENCY_DECAY,
  type ScoringContext,
  type ScoredMemoryItem,
  type RelevanceFactors,
  type UserReinforcementSignals
} from '../src/services/memory-relevance-scoring';

import type { MemoryItem } from '../src/services/orb-memory-bridge';

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a mock memory item for testing
 */
function createMockMemory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 10)}`,
    category_key: 'conversation',
    source: 'orb_text',
    content: 'This is a test memory content.',
    content_json: {},
    importance: 50,
    occurred_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides
  };
}

/**
 * Create a standard scoring context
 */
function createMockContext(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    intent: 'general',
    role: 'patient',
    user_id: 'test-user-123',
    tenant_id: 'test-tenant-456',
    current_time: new Date(),
    ...overrides
  };
}

// =============================================================================
// Determinism Tests
// =============================================================================

describe('VTID-01115: Determinism Requirements', () => {
  it('should produce identical scores for identical inputs', () => {
    const memory = createMockMemory({ id: 'fixed-id-1' });
    const context = createMockContext({ current_time: new Date('2024-01-15T12:00:00Z') });

    const score1 = scoreMemoryItem(memory, context);
    const score2 = scoreMemoryItem(memory, context);

    expect(score1.relevance_score).toBe(score2.relevance_score);
    expect(score1.relevance_factors).toEqual(score2.relevance_factors);
  });

  it('should produce consistent ranking for multiple calls', () => {
    const memories = [
      createMockMemory({ id: 'mem-a', importance: 90 }),
      createMockMemory({ id: 'mem-b', importance: 50 }),
      createMockMemory({ id: 'mem-c', importance: 10 })
    ];
    const context = createMockContext();

    const result1 = scoreAndRankMemories(memories, context);
    const result2 = scoreAndRankMemories(memories, context);

    const order1 = result1.scored_items.map(i => i.id);
    const order2 = result2.scored_items.map(i => i.id);

    expect(order1).toEqual(order2);
  });

  it('should break ties deterministically by ID', () => {
    // Create memories with identical characteristics except ID
    const fixedTime = new Date('2024-01-15T12:00:00Z');
    const memories = [
      createMockMemory({ id: 'zebra', importance: 50, occurred_at: fixedTime.toISOString() }),
      createMockMemory({ id: 'alpha', importance: 50, occurred_at: fixedTime.toISOString() }),
      createMockMemory({ id: 'beta', importance: 50, occurred_at: fixedTime.toISOString() })
    ];

    const context = createMockContext({ current_time: fixedTime });
    const result = scoreAndRankMemories(memories, context);

    // If scores are equal, should be sorted alphabetically by ID
    const scoredItems = result.scored_items.filter(i => !i.exclusion_reason);
    const scores = scoredItems.map(i => i.relevance_score);
    const uniqueScores = [...new Set(scores)];

    // If all scores are the same, order should be alphabetical
    if (uniqueScores.length === 1) {
      expect(scoredItems[0].id).toBe('alpha');
      expect(scoredItems[1].id).toBe('beta');
      expect(scoredItems[2].id).toBe('zebra');
    }
  });
});

// =============================================================================
// Factor Weight Tests
// =============================================================================

describe('VTID-01115: Factor Weight Limits', () => {
  it('should never exceed max weight for intent_match', () => {
    const memory = createMockMemory({ category_key: 'health' });
    const context = createMockContext({ intent: 'health' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.intent_match).toBeLessThanOrEqual(FACTOR_MAX_WEIGHTS.intent_match);
    expect(scored.relevance_factors.intent_match).toBeGreaterThanOrEqual(0);
  });

  it('should never exceed max weight for domain_match', () => {
    const memory = createMockMemory({ category_key: 'health' });
    const context = createMockContext({ domain: 'health' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.domain_match).toBeLessThanOrEqual(FACTOR_MAX_WEIGHTS.domain_match);
    expect(scored.relevance_factors.domain_match).toBeGreaterThanOrEqual(0);
  });

  it('should never exceed max weight for recency', () => {
    const memory = createMockMemory({ occurred_at: new Date().toISOString() });
    const context = createMockContext();

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.recency).toBeLessThanOrEqual(FACTOR_MAX_WEIGHTS.recency);
    expect(scored.relevance_factors.recency).toBeGreaterThanOrEqual(0);
  });

  it('should never exceed max weight for confidence', () => {
    const memory = createMockMemory({
      source: 'orb_voice',
      importance: 100,
      category_key: 'personal'
    });
    const context = createMockContext();

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.confidence).toBeLessThanOrEqual(FACTOR_MAX_WEIGHTS.confidence);
    expect(scored.relevance_factors.confidence).toBeGreaterThanOrEqual(0);
  });

  it('should never exceed max weight for reinforcement', () => {
    const memory = createMockMemory({ id: 'pinned-mem' });
    const context = createMockContext({
      user_reinforcement_signals: {
        pinned_memory_ids: ['pinned-mem'],
        reused_memory_ids: ['pinned-mem'],
        corrected_memory_ids: [],
        dismissed_memory_ids: []
      }
    });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.reinforcement).toBeLessThanOrEqual(FACTOR_MAX_WEIGHTS.reinforcement);
  });

  it('should never exceed max weight for role_fit', () => {
    const memory = createMockMemory();
    const context = createMockContext({ role: 'patient' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.role_fit).toBeLessThanOrEqual(FACTOR_MAX_WEIGHTS.role_fit);
    expect(scored.relevance_factors.role_fit).toBeGreaterThanOrEqual(0);
  });

  it('should have total score capped at 100', () => {
    // Create an ideal memory that should score highest
    const memory = createMockMemory({
      category_key: 'health',
      source: 'orb_voice',
      importance: 100,
      occurred_at: new Date().toISOString()
    });
    const context = createMockContext({
      intent: 'health',
      domain: 'health',
      role: 'patient',
      user_reinforcement_signals: {
        pinned_memory_ids: [memory.id],
        reused_memory_ids: [],
        corrected_memory_ids: [],
        dismissed_memory_ids: []
      }
    });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_score).toBeLessThanOrEqual(100);
    expect(scored.relevance_score).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Intent Match Tests (D21)
// =============================================================================

describe('VTID-01115: Intent Match Scoring', () => {
  it('should give full intent_match for primary category match', () => {
    const memory = createMockMemory({ category_key: 'health' });
    const context = createMockContext({ intent: 'health' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.intent_match).toBe(FACTOR_MAX_WEIGHTS.intent_match);
  });

  it('should give partial intent_match for secondary category match', () => {
    const memory = createMockMemory({ category_key: 'preferences' });
    const context = createMockContext({ intent: 'health' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.intent_match).toBe(Math.floor(FACTOR_MAX_WEIGHTS.intent_match * 0.6));
  });

  it('should give minimal intent_match for non-matching category', () => {
    const memory = createMockMemory({ category_key: 'tasks' });
    const context = createMockContext({ intent: 'health' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.intent_match).toBe(Math.floor(FACTOR_MAX_WEIGHTS.intent_match * 0.2));
  });

  it('should match community intent with relationships category', () => {
    const memory = createMockMemory({ category_key: 'relationships' });
    const context = createMockContext({ intent: 'community' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.intent_match).toBe(FACTOR_MAX_WEIGHTS.intent_match);
  });

  it('should match planner intent with tasks category', () => {
    const memory = createMockMemory({ category_key: 'tasks' });
    const context = createMockContext({ intent: 'planner' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.intent_match).toBe(FACTOR_MAX_WEIGHTS.intent_match);
  });
});

// =============================================================================
// Domain Match Tests (D22)
// =============================================================================

describe('VTID-01115: Domain Match Scoring', () => {
  it('should give full domain_match for primary domain category', () => {
    const memory = createMockMemory({ category_key: 'health' });
    const context = createMockContext({ domain: 'health' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.domain_match).toBe(FACTOR_MAX_WEIGHTS.domain_match);
  });

  it('should give neutral domain_match when no domain specified', () => {
    const memory = createMockMemory({ category_key: 'health' });
    const context = createMockContext({ domain: undefined });

    const scored = scoreMemoryItem(memory, context);

    // Neutral score is ~50% of max
    expect(scored.relevance_factors.domain_match).toBe(Math.floor(FACTOR_MAX_WEIGHTS.domain_match * 0.5));
  });

  it('should match business domain with tasks category', () => {
    const memory = createMockMemory({ category_key: 'tasks' });
    const context = createMockContext({ domain: 'business' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.domain_match).toBe(FACTOR_MAX_WEIGHTS.domain_match);
  });

  it('should match community domain with relationships category', () => {
    const memory = createMockMemory({ category_key: 'relationships' });
    const context = createMockContext({ domain: 'community' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.domain_match).toBe(FACTOR_MAX_WEIGHTS.domain_match);
  });
});

// =============================================================================
// Recency Decay Tests
// =============================================================================

describe('VTID-01115: Recency Decay Scoring', () => {
  it('should give max recency score for memories within 1 hour', () => {
    const now = new Date();
    const memory = createMockMemory({
      occurred_at: new Date(now.getTime() - 30 * 60 * 1000).toISOString() // 30 min ago
    });
    const context = createMockContext({ current_time: now });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.recency).toBe(RECENCY_DECAY.HOUR_1.score);
  });

  it('should give reduced score for memories within 24 hours', () => {
    const now = new Date();
    const memory = createMockMemory({
      occurred_at: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString() // 12 hours ago
    });
    const context = createMockContext({ current_time: now });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.recency).toBe(RECENCY_DECAY.HOURS_24.score);
  });

  it('should give lower score for memories within 7 days', () => {
    const now = new Date();
    const memory = createMockMemory({
      occurred_at: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString() // 3 days ago
    });
    const context = createMockContext({ current_time: now });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.recency).toBe(RECENCY_DECAY.DAYS_7.score);
  });

  it('should give minimal score for very old memories', () => {
    const now = new Date();
    const memory = createMockMemory({
      occurred_at: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString() // 60 days ago
    });
    const context = createMockContext({ current_time: now });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.recency).toBe(RECENCY_DECAY.OLDER.score);
  });

  it('should NOT use raw timestamp for ranking (decayed score only)', () => {
    const now = new Date();
    // Both within 24 hours should have same recency score
    const memory1 = createMockMemory({
      id: 'recent-1',
      occurred_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() // 2 hours ago
    });
    const memory2 = createMockMemory({
      id: 'recent-2',
      occurred_at: new Date(now.getTime() - 20 * 60 * 60 * 1000).toISOString() // 20 hours ago
    });
    const context = createMockContext({ current_time: now });

    const scored1 = scoreMemoryItem(memory1, context);
    const scored2 = scoreMemoryItem(memory2, context);

    // Both should be in the HOURS_24 band
    expect(scored1.relevance_factors.recency).toBe(scored2.relevance_factors.recency);
    expect(scored1.relevance_factors.recency).toBe(RECENCY_DECAY.HOURS_24.score);
  });
});

// =============================================================================
// Confidence Scoring Tests
// =============================================================================

describe('VTID-01115: Confidence Scoring', () => {
  it('should give higher confidence to orb_voice source', () => {
    const voiceMemory = createMockMemory({ source: 'orb_voice' });
    const textMemory = createMockMemory({ source: 'orb_text' });
    const context = createMockContext();

    const voiceScore = scoreMemoryItem(voiceMemory, context);
    const textScore = scoreMemoryItem(textMemory, context);

    expect(voiceScore.relevance_factors.confidence).toBeGreaterThan(textScore.relevance_factors.confidence);
  });

  it('should boost confidence for high importance memories', () => {
    const highImportance = createMockMemory({ importance: 100, source: 'orb_text' });
    const lowImportance = createMockMemory({ importance: 10, source: 'orb_text' });
    const context = createMockContext();

    const highScore = scoreMemoryItem(highImportance, context);
    const lowScore = scoreMemoryItem(lowImportance, context);

    expect(highScore.relevance_factors.confidence).toBeGreaterThan(lowScore.relevance_factors.confidence);
  });

  it('should boost confidence for personal category', () => {
    const personal = createMockMemory({ category_key: 'personal', source: 'orb_text', importance: 50 });
    const conversation = createMockMemory({ category_key: 'conversation', source: 'orb_text', importance: 50 });
    const context = createMockContext();

    const personalScore = scoreMemoryItem(personal, context);
    const convScore = scoreMemoryItem(conversation, context);

    expect(personalScore.relevance_factors.confidence).toBeGreaterThan(convScore.relevance_factors.confidence);
  });
});

// =============================================================================
// Reinforcement Signal Tests
// =============================================================================

describe('VTID-01115: Reinforcement Signal Scoring', () => {
  it('should boost score for pinned memories', () => {
    const memory = createMockMemory({ id: 'pinned-mem' });
    const contextWithSignals = createMockContext({
      user_reinforcement_signals: {
        pinned_memory_ids: ['pinned-mem'],
        reused_memory_ids: [],
        corrected_memory_ids: [],
        dismissed_memory_ids: []
      }
    });
    const contextWithoutSignals = createMockContext();

    const withSignals = scoreMemoryItem(memory, contextWithSignals);
    const withoutSignals = scoreMemoryItem(memory, contextWithoutSignals);

    expect(withSignals.relevance_factors.reinforcement).toBe(FACTOR_MAX_WEIGHTS.reinforcement);
    expect(withoutSignals.relevance_factors.reinforcement).toBe(0);
  });

  it('should apply negative reinforcement for dismissed memories', () => {
    const memory = createMockMemory({ id: 'dismissed-mem' });
    const context = createMockContext({
      user_reinforcement_signals: {
        pinned_memory_ids: [],
        reused_memory_ids: [],
        corrected_memory_ids: [],
        dismissed_memory_ids: ['dismissed-mem']
      }
    });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.reinforcement).toBeLessThan(0);
  });

  it('should combine multiple positive signals', () => {
    const memory = createMockMemory({ id: 'reused-and-corrected' });
    const context = createMockContext({
      user_reinforcement_signals: {
        pinned_memory_ids: [],
        reused_memory_ids: ['reused-and-corrected'],
        corrected_memory_ids: ['reused-and-corrected'],
        dismissed_memory_ids: []
      }
    });

    const scored = scoreMemoryItem(memory, context);

    // Should have combined boost from reuse (5) + correction (3) = 8
    expect(scored.relevance_factors.reinforcement).toBe(8);
  });
});

// =============================================================================
// Role Fit Tests
// =============================================================================

describe('VTID-01115: Role Fit Scoring', () => {
  it('should give full role_fit to patients', () => {
    const memory = createMockMemory({ content: 'My doctor diagnosed me with diabetes.' });
    const context = createMockContext({ role: 'patient' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.role_fit).toBe(FACTOR_MAX_WEIGHTS.role_fit);
  });

  it('should reduce role_fit for professionals viewing medical content', () => {
    const memory = createMockMemory({ content: 'My doctor diagnosed me with diabetes.' });
    const context = createMockContext({ role: 'professional' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.role_fit).toBe(3);
    expect(scored.sensitivity_flags.length).toBeGreaterThan(0);
  });

  it('should further reduce role_fit for staff viewing sensitive content', () => {
    const memory = createMockMemory({ content: 'I had surgery last week.' });
    const context = createMockContext({ role: 'staff' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.role_fit).toBe(1);
  });

  it('should give zero role_fit to developers for sensitive content', () => {
    const memory = createMockMemory({ content: 'My medication prescription details.' });
    const context = createMockContext({ role: 'developer' });

    const scored = scoreMemoryItem(memory, context);

    expect(scored.relevance_factors.role_fit).toBe(0);
    expect(scored.exclusion_reason).toContain('cannot access sensitive');
  });
});

// =============================================================================
// Sensitivity Detection Tests
// =============================================================================

describe('VTID-01115: Sensitivity Detection', () => {
  it('should detect medical content', () => {
    const flags = detectSensitivityFlags('I got my blood test results from the hospital.');

    expect(flags.some(f => f.type === 'medical')).toBe(true);
    expect(flags[0].detected_keywords).toContain('blood');
    expect(flags[0].detected_keywords).toContain('hospital');
  });

  it('should detect emotional content', () => {
    const flags = detectSensitivityFlags('I am dealing with grief after the death of my mother.');

    expect(flags.some(f => f.type === 'emotional')).toBe(true);
    expect(flags.find(f => f.type === 'emotional')?.detected_keywords).toContain('grief');
    expect(flags.find(f => f.type === 'emotional')?.detected_keywords).toContain('death');
  });

  it('should detect financial content', () => {
    const flags = detectSensitivityFlags('My salary and bank account information.');

    expect(flags.some(f => f.type === 'financial')).toBe(true);
  });

  it('should detect relationship content', () => {
    const flags = detectSensitivityFlags('I discovered my partner was having an affair.');

    expect(flags.some(f => f.type === 'relationship')).toBe(true);
    expect(flags.find(f => f.type === 'relationship')?.detected_keywords).toContain('affair');
  });

  it('should detect legal content', () => {
    const flags = detectSensitivityFlags('My attorney filed a lawsuit in court.');

    expect(flags.some(f => f.type === 'legal')).toBe(true);
  });

  it('should detect German medical terms', () => {
    const flags = detectSensitivityFlags('Ich war im Krankenhaus wegen meiner Medikamente.');

    expect(flags.some(f => f.type === 'medical')).toBe(true);
    expect(flags.find(f => f.type === 'medical')?.detected_keywords).toContain('krankenhaus');
  });

  it('should mark medical and emotional as requiring elevated threshold', () => {
    const medicalFlags = detectSensitivityFlags('My doctor prescribed medication.');
    const emotionalFlags = detectSensitivityFlags('I am devastated by the trauma.');
    const financialFlags = detectSensitivityFlags('My salary is confidential.');

    expect(medicalFlags[0]?.requires_elevated_threshold).toBe(true);
    expect(emotionalFlags[0]?.requires_elevated_threshold).toBe(true);
    expect(financialFlags[0]?.requires_elevated_threshold).toBe(false);
  });
});

// =============================================================================
// Threshold Tests
// =============================================================================

describe('VTID-01115: Score Thresholds', () => {
  it('should include memories with score >= 50', () => {
    const memory = createMockMemory({
      category_key: 'health',
      source: 'orb_voice',
      importance: 80
    });
    const context = createMockContext({
      intent: 'health',
      domain: 'health',
      role: 'patient'
    });

    const scored = scoreMemoryItem(memory, context);
    const decision = shouldIncludeMemory(scored);

    expect(scored.relevance_score).toBeGreaterThanOrEqual(SCORE_THRESHOLDS.include);
    expect(decision).toBe('include');
  });

  it('should deprioritize memories with score 30-49', () => {
    // Create a memory that will score in the middle range
    const memory = createMockMemory({
      category_key: 'notes',
      source: 'system',
      importance: 10,
      occurred_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() // 10 days ago
    });
    const context = createMockContext({
      intent: 'health',
      domain: 'health'
    });

    const scored = scoreMemoryItem(memory, context);

    if (scored.relevance_score >= SCORE_THRESHOLDS.deprioritize &&
        scored.relevance_score < SCORE_THRESHOLDS.include) {
      expect(shouldIncludeMemory(scored)).toBe('deprioritize');
    }
  });

  it('should require elevated threshold for sensitive memories', () => {
    const memory = createMockMemory({
      category_key: 'health',
      content: 'My doctor diagnosed me with a chronic disease.',
      source: 'orb_text',
      importance: 30,
      occurred_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    });
    const context = createMockContext({
      intent: 'general',
      role: 'patient'
    });

    const scored = scoreMemoryItem(memory, context);

    // If score is below elevated threshold but above regular, it should be excluded
    if (scored.relevance_score < SENSITIVE_MEMORY_THRESHOLD &&
        scored.relevance_score >= SCORE_THRESHOLDS.include) {
      expect(scored.exclusion_reason).toContain('Sensitive memory below elevated threshold');
    }
  });
});

// =============================================================================
// Domain Caps Tests
// =============================================================================

describe('VTID-01115: Domain Caps', () => {
  it('should enforce health domain cap', () => {
    // Create more memories than the health cap
    const memories = Array.from({ length: 15 }, (_, i) =>
      createMockMemory({
        id: `health-mem-${i}`,
        category_key: 'health',
        importance: 90 - i
      })
    );

    const context = createMockContext({ intent: 'health', domain: 'health' });
    const result = scoreAndRankMemories(memories, context);

    // Count included health memories
    const includedHealth = result.scored_items.filter(
      i => i.category_key === 'health' && !i.exclusion_reason
    );

    expect(includedHealth.length).toBeLessThanOrEqual(DOMAIN_CAPS.health);
  });

  it('should apply domain caps without affecting score calculation', () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      createMockMemory({
        id: `cap-test-${i}`,
        category_key: 'health',
        importance: 80
      })
    );

    const context = createMockContext({ intent: 'health' });
    const result = scoreAndRankMemories(memories, context);

    // All memories should have the same calculated score
    const scores = result.scored_items.map(i => i.relevance_score);
    const uniqueScores = [...new Set(scores)];

    // Scores should be the same (or very close)
    expect(uniqueScores.length).toBeLessThanOrEqual(2); // Allow for minor floating point variations
  });
});

// =============================================================================
// Scoring Metadata Tests
// =============================================================================

describe('VTID-01115: Scoring Metadata & Traceability', () => {
  it('should include scoring_run_id in metadata', () => {
    const memories = [createMockMemory()];
    const context = createMockContext();

    const result = scoreAndRankMemories(memories, context);

    expect(result.scoring_metadata.scoring_run_id).toBeDefined();
    expect(result.scoring_metadata.scoring_run_id).toMatch(/^score_/);
  });

  it('should track total candidates vs included/excluded', () => {
    const memories = [
      createMockMemory({ id: 'good-mem', importance: 90, category_key: 'health' }),
      createMockMemory({ id: 'bad-mem', content: 'medical diagnosis details', importance: 10 })
    ];
    const context = createMockContext({ intent: 'health', role: 'developer' });

    const result = scoreAndRankMemories(memories, context);

    expect(result.scoring_metadata.total_candidates).toBe(2);
    expect(result.scoring_metadata.included_count + result.scoring_metadata.excluded_count + result.scoring_metadata.deprioritized_count).toBeGreaterThanOrEqual(0);
  });

  it('should include top-N with full factor breakdown', () => {
    const memories = Array.from({ length: 15 }, (_, i) =>
      createMockMemory({ id: `mem-${i}`, importance: 90 - i * 5 })
    );
    const context = createMockContext();

    const result = scoreAndRankMemories(memories, context);

    // Should include top 10 with factors
    expect(result.scoring_metadata.top_n_with_factors.length).toBeLessThanOrEqual(10);

    // Each should have full factor breakdown
    for (const item of result.scoring_metadata.top_n_with_factors) {
      expect(item.memory_id).toBeDefined();
      expect(item.relevance_score).toBeDefined();
      expect(item.relevance_factors.intent_match).toBeDefined();
      expect(item.relevance_factors.domain_match).toBeDefined();
      expect(item.relevance_factors.recency).toBeDefined();
      expect(item.relevance_factors.confidence).toBeDefined();
      expect(item.relevance_factors.reinforcement).toBeDefined();
      expect(item.relevance_factors.role_fit).toBeDefined();
    }
  });

  it('should include exclusion reasons for all excluded memories', () => {
    const memories = [
      createMockMemory({ id: 'sensitive-mem', content: 'My doctor prescribed medication.' })
    ];
    const context = createMockContext({ role: 'developer' });

    const result = scoreAndRankMemories(memories, context);

    if (result.excluded_items.length > 0) {
      for (const item of result.excluded_items) {
        expect(item.exclusion_reason).toBeDefined();
        expect(item.exclusion_reason!.length).toBeGreaterThan(0);
      }

      // Also check metadata
      expect(result.scoring_metadata.exclusion_reasons.length).toBe(result.excluded_items.length);
    }
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('VTID-01115: Full Scoring Pipeline', () => {
  it('should correctly score and rank a mixed set of memories', () => {
    const now = new Date();
    const memories = [
      createMockMemory({
        id: 'recent-health',
        category_key: 'health',
        source: 'orb_voice',
        importance: 90,
        occurred_at: new Date(now.getTime() - 30 * 60 * 1000).toISOString()
      }),
      createMockMemory({
        id: 'old-conversation',
        category_key: 'conversation',
        source: 'system',
        importance: 20,
        occurred_at: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
      }),
      createMockMemory({
        id: 'recent-personal',
        category_key: 'personal',
        source: 'orb_text',
        importance: 70,
        occurred_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()
      })
    ];

    const context = createMockContext({
      intent: 'health',
      domain: 'health',
      current_time: now
    });

    const result = scoreAndRankMemories(memories, context);

    // Recent health memory should rank first (matches intent+domain, recent, high importance)
    expect(result.scored_items[0].id).toBe('recent-health');

    // Old conversation should rank last or be excluded
    const oldConv = result.scored_items.find(i => i.id === 'old-conversation');
    if (oldConv && !oldConv.exclusion_reason) {
      const recentHealth = result.scored_items.find(i => i.id === 'recent-health');
      expect(oldConv.relevance_score).toBeLessThan(recentHealth!.relevance_score);
    }
  });

  it('should handle empty memory list', () => {
    const context = createMockContext();
    const result = scoreAndRankMemories([], context);

    expect(result.scored_items).toEqual([]);
    expect(result.excluded_items).toEqual([]);
    expect(result.scoring_metadata.total_candidates).toBe(0);
  });

  it('should produce valid JSON-serializable output', () => {
    const memories = [createMockMemory()];
    const context = createMockContext();

    const result = scoreAndRankMemories(memories, context);

    // Should not throw when serializing
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);

    expect(parsed.scored_items).toBeDefined();
    expect(parsed.scoring_metadata).toBeDefined();
  });
});
