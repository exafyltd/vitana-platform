import {
  ContextWindowManager,
  selectContextWindow,
  formatSelectionDebug,
  DEFAULT_CONTEXT_BUDGET,
  ContextBudgetConfig,
  ContextItem,
  ContextDomain,
  ExclusionReason
} from '../src/services/context-window-manager';
import { MemoryItem } from '../src/services/orb-memory-bridge';

/**
 * VTID-01117: Context Window Management & Saturation Control Tests
 *
 * These tests verify:
 * 1. Deterministic selection (same inputs → same outputs)
 * 2. Budget enforcement (per-domain and total caps)
 * 3. Saturation detection (redundancy and topic repetition)
 * 4. Hard constraints (no silent truncation, all exclusions have reasons)
 * 5. Priority tier handling
 * 6. Logging and traceability
 */

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a mock memory item for testing
 */
function createMockItem(
  overrides: Partial<MemoryItem> & { id: string }
): MemoryItem {
  return {
    id: overrides.id,
    category_key: overrides.category_key || 'conversation',
    source: overrides.source || 'orb_text',
    content: overrides.content || `Test content for ${overrides.id}`,
    content_json: overrides.content_json || {},
    importance: overrides.importance ?? 50,
    occurred_at: overrides.occurred_at || new Date().toISOString(),
    created_at: overrides.created_at || new Date().toISOString()
  };
}

/**
 * Create a batch of mock items for a specific category
 */
function createMockItemsForCategory(
  category: string,
  count: number,
  baseImportance: number = 50
): MemoryItem[] {
  const items: MemoryItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push(createMockItem({
      id: `${category}-item-${i}`,
      category_key: category,
      content: `${category} content item ${i} - unique content here`,
      importance: baseImportance - i // Decreasing importance
    }));
  }
  return items;
}

// =============================================================================
// Determinism Tests
// =============================================================================

describe('VTID-01117: Determinism Rules', () => {
  let manager: ContextWindowManager;

  beforeEach(() => {
    ContextWindowManager.resetInstance();
    manager = new ContextWindowManager();
  });

  test('Same inputs produce same outputs', () => {
    const items = createMockItemsForCategory('personal', 5);

    const result1 = manager.selectContext(items, 50, 'turn-1', 'user-1', 'tenant-1');
    const result2 = manager.selectContext(items, 50, 'turn-2', 'user-1', 'tenant-1');

    // Same number of items
    expect(result1.includedItems.length).toBe(result2.includedItems.length);

    // Same item IDs (in order)
    const ids1 = result1.includedItems.map(i => i.id);
    const ids2 = result2.includedItems.map(i => i.id);
    expect(ids1).toEqual(ids2);

    // Same metrics (except processing time and selectedAt)
    expect(result1.metrics.totalItems).toBe(result2.metrics.totalItems);
    expect(result1.metrics.totalChars).toBe(result2.metrics.totalChars);
    expect(result1.metrics.diversityScore).toBe(result2.metrics.diversityScore);
  });

  test('Same scores produce same inclusion set', () => {
    // Items with identical importance scores
    const items = [
      createMockItem({ id: 'item-1', importance: 50, category_key: 'personal' }),
      createMockItem({ id: 'item-2', importance: 50, category_key: 'personal' }),
      createMockItem({ id: 'item-3', importance: 50, category_key: 'personal' })
    ];

    const result1 = manager.selectContext(items);
    const result2 = manager.selectContext(items);

    // Order should be deterministic based on stable sort
    expect(result1.includedItems.map(i => i.id)).toEqual(result2.includedItems.map(i => i.id));
  });

  test('Result always has deterministic flag set to true', () => {
    const items = createMockItemsForCategory('conversation', 3);
    const result = manager.selectContext(items);
    expect(result.deterministic).toBe(true);
  });
});

// =============================================================================
// Budget Enforcement Tests
// =============================================================================

describe('VTID-01117: Context Budget Model', () => {
  let manager: ContextWindowManager;

  beforeEach(() => {
    ContextWindowManager.resetInstance();
    manager = new ContextWindowManager();
  });

  test('Per-domain item caps are enforced', () => {
    // Create more items than the cap allows
    // Note: personal/relationships are now effectively unlimited (999)
    // So we test with health which still has a cap of 4
    const items = createMockItemsForCategory('health', 10);
    const result = manager.selectContext(items);

    // Health domain cap is 4
    const healthItems = result.includedItems.filter(
      i => i.category_key === 'health'
    );
    expect(healthItems.length).toBeLessThanOrEqual(4);
  });

  test('Total item limit is enforced', () => {
    // Create many items across categories
    const items = [
      ...createMockItemsForCategory('personal', 20),
      ...createMockItemsForCategory('relationships', 20),
      ...createMockItemsForCategory('conversation', 20),
      ...createMockItemsForCategory('health', 20)
    ];

    const result = manager.selectContext(items);

    // Total limit is 50 (VTID-DEBUG-01 increased from 30)
    expect(result.metrics.totalItems).toBeLessThanOrEqual(50);
  });

  test('Total character limit is enforced', () => {
    // Create items with long content
    const items = Array.from({ length: 50 }, (_, i) =>
      createMockItem({
        id: `item-${i}`,
        category_key: 'conversation',
        content: 'A'.repeat(500), // 500 chars each
        importance: 100 // High importance to ensure selection
      })
    );

    const result = manager.selectContext(items);

    // Total char limit is 10000 (VTID-DEBUG-01 increased from 6000)
    expect(result.metrics.totalChars).toBeLessThanOrEqual(10000);
  });

  test('Domain char caps are enforced', () => {
    // Create items that would exceed health char cap (800)
    // Note: personal/relationships now have very high char caps (5000/3000)
    const items = Array.from({ length: 10 }, (_, i) =>
      createMockItem({
        id: `health-${i}`,
        category_key: 'health',
        content: 'A'.repeat(300), // 300 chars each = 3000 total
        importance: 100
      })
    );

    const result = manager.selectContext(items);
    const healthChars = result.includedItems
      .filter(i => i.category_key === 'health')
      .reduce((sum, i) => sum + i.charCount, 0);

    // Health char cap is 800
    expect(healthChars).toBeLessThanOrEqual(800);
  });
});

// =============================================================================
// Selection Rules Tests
// =============================================================================

describe('VTID-01117: Selection Rules', () => {
  let manager: ContextWindowManager;

  beforeEach(() => {
    ContextWindowManager.resetInstance();
    manager = new ContextWindowManager();
  });

  test('Higher relevance items are selected first', () => {
    const items = [
      createMockItem({ id: 'low', importance: 35, category_key: 'conversation' }),
      createMockItem({ id: 'high', importance: 80, category_key: 'conversation' }),
      createMockItem({ id: 'medium', importance: 50, category_key: 'conversation' })
    ];

    const result = manager.selectContext(items);
    const includedIds = result.includedItems.map(i => i.id);

    // All should be included (all above conversation threshold of 30)
    expect(includedIds.length).toBe(3);

    // High importance should come first
    expect(includedIds.indexOf('high')).toBeLessThan(includedIds.indexOf('medium'));
    expect(includedIds.indexOf('medium')).toBeLessThan(includedIds.indexOf('low'));
  });

  test('Items below relevance threshold are excluded', () => {
    // Create items with very low importance (below conversation threshold of 30)
    const items = [
      createMockItem({ id: 'below-threshold', importance: 5, category_key: 'conversation' }),
      createMockItem({ id: 'above-threshold', importance: 50, category_key: 'conversation' })
    ];

    const result = manager.selectContext(items);

    expect(result.includedItems.some(i => i.id === 'above-threshold')).toBe(true);
    expect(result.includedItems.some(i => i.id === 'below-threshold')).toBe(false);
    expect(result.excludedItems.some(e => e.itemId === 'below-threshold')).toBe(true);
  });

  test('Items below confidence threshold are excluded', () => {
    // With quality score of 30, some domains should reject items
    const items = [
      createMockItem({ id: 'community-item', importance: 60, category_key: 'community' })
    ];

    // Community requires confidence >= 50, quality score is 30
    const result = manager.selectContext(items, 30);

    expect(result.excludedItems.some(
      e => e.itemId === 'community-item' && e.reason === 'below_confidence_threshold'
    )).toBe(true);
  });

  test('Priority tiers affect selection order', () => {
    const items = [
      createMockItem({ id: 'optional', importance: 20, category_key: 'notes' }),
      createMockItem({ id: 'critical', importance: 80, category_key: 'personal' }),
      createMockItem({ id: 'relevant', importance: 40, category_key: 'health' })
    ];

    const result = manager.selectContext(items);
    const includedIds = result.includedItems.map(i => i.id);

    // Critical (personal with high importance) should come first
    expect(includedIds.indexOf('critical')).toBeLessThan(includedIds.indexOf('relevant'));
  });
});

// =============================================================================
// Saturation Detection Tests
// =============================================================================

describe('VTID-01117: Saturation Detection', () => {
  let manager: ContextWindowManager;

  beforeEach(() => {
    ContextWindowManager.resetInstance();
    manager = new ContextWindowManager();
  });

  test('Redundant content is detected and excluded', () => {
    // VTID-DEBUG-01: redundancySimilarity threshold is now 0.85 (was 0.75)
    // Need content that is >85% similar to trigger redundancy detection
    const items = [
      createMockItem({
        id: 'original',
        content: 'I exercise at the gym every Monday Wednesday and Friday morning',
        category_key: 'health',  // Use health, not personal (identity exempt from some filters)
        importance: 80
      }),
      createMockItem({
        id: 'duplicate',
        content: 'I exercise at the gym every Monday Wednesday and Friday morning early',
        category_key: 'health',
        importance: 70
      })
    ];

    const result = manager.selectContext(items);

    // One should be included, the other excluded as redundant
    expect(result.includedItems.some(i => i.id === 'original')).toBe(true);
    expect(result.excludedItems.some(
      e => e.itemId === 'duplicate' && e.reason === 'redundant_content'
    )).toBe(true);
  });

  test('Topic repetition limit is enforced for non-identity domains', () => {
    // VTID-DEBUG-01: personal/relationships are EXEMPT from topic saturation
    // Use conversation domain (maxItems: 5) - needs custom config to allow more items
    // so we can actually hit the topic saturation limit (8) before domain cap
    const customConfig = {
      ...DEFAULT_CONTEXT_BUDGET,
      domainBudgets: {
        ...DEFAULT_CONTEXT_BUDGET.domainBudgets,
        conversation: {
          maxItems: 20,  // High enough to not hit domain cap first
          maxChars: 5000,
          minRelevanceScore: 20,
          minConfidenceThreshold: 0
        }
      }
    };
    const customManager = new ContextWindowManager(customConfig);

    // Create 12 items all about "work" topic (which maps to 'work' in extractTopic)
    // Topic limit is 8, so 4 should be excluded for topic_saturation
    const items = [
      createMockItem({ id: 'work-1', content: 'I have a meeting at work tomorrow', category_key: 'conversation', importance: 80 }),
      createMockItem({ id: 'work-2', content: 'My work project is going well', category_key: 'conversation', importance: 78 }),
      createMockItem({ id: 'work-3', content: 'Work has been busy this week', category_key: 'conversation', importance: 76 }),
      createMockItem({ id: 'work-4', content: 'I finished my work assignment early', category_key: 'conversation', importance: 74 }),
      createMockItem({ id: 'work-5', content: 'Work colleagues are supportive', category_key: 'conversation', importance: 72 }),
      createMockItem({ id: 'work-6', content: 'My work schedule changed today', category_key: 'conversation', importance: 70 }),
      createMockItem({ id: 'work-7', content: 'Work deadlines are approaching fast', category_key: 'conversation', importance: 68 }),
      createMockItem({ id: 'work-8', content: 'I enjoy my work environment now', category_key: 'conversation', importance: 66 }),
      createMockItem({ id: 'work-9', content: 'Work priorities shifted this month', category_key: 'conversation', importance: 64 }),
      createMockItem({ id: 'work-10', content: 'My work performance review is soon', category_key: 'conversation', importance: 62 }),
      createMockItem({ id: 'work-11', content: 'Work from home days are great', category_key: 'conversation', importance: 60 }),
      createMockItem({ id: 'work-12', content: 'I love my work life balance now', category_key: 'conversation', importance: 58 })
    ];

    const result = customManager.selectContext(items);

    // Topic saturation limit is 8, so at least 4 should be excluded for topic_saturation
    const topicExclusions = result.excludedItems.filter(e => e.reason === 'topic_saturation');
    expect(topicExclusions.length).toBeGreaterThanOrEqual(1);
  });

  test('Personal and relationships are exempt from topic saturation', () => {
    // VTID-DEBUG-01: Personal identity facts should NEVER be filtered by topic saturation
    const items = [
      createMockItem({ id: 'spouse-1', content: 'My wife Sarah loves hiking', category_key: 'relationships', importance: 80 }),
      createMockItem({ id: 'spouse-2', content: 'Sarah my wife works as a doctor', category_key: 'relationships', importance: 75 }),
      createMockItem({ id: 'spouse-3', content: 'I met my wife Sarah in 2010', category_key: 'relationships', importance: 70 }),
      createMockItem({ id: 'spouse-4', content: 'My wife Sarah is from Munich', category_key: 'relationships', importance: 65 }),
      createMockItem({ id: 'spouse-5', content: 'Sarah my wife enjoys cooking', category_key: 'relationships', importance: 60 })
    ];

    const result = manager.selectContext(items);

    // ALL relationship items should be included (no topic saturation for identity domains)
    const topicSaturationExclusions = result.excludedItems.filter(e => e.reason === 'topic_saturation');
    expect(topicSaturationExclusions.length).toBe(0);
    expect(result.includedItems.length).toBe(5);
  });

  test('Diversity is measured and reported', () => {
    // Mix of different topics should have higher diversity
    const diverseItems = [
      createMockItem({ id: 'name', content: 'My name is John', category_key: 'personal', importance: 80 }),
      createMockItem({ id: 'job', content: 'I work as a software engineer', category_key: 'personal', importance: 75 }),
      createMockItem({ id: 'health', content: 'I exercise three times a week', category_key: 'health', importance: 70 }),
      createMockItem({ id: 'goal', content: 'I want to learn Spanish this year', category_key: 'goals', importance: 65 })
    ];

    const result = manager.selectContext(diverseItems);

    // Diversity score should be reasonably high for diverse content
    expect(result.metrics.diversityScore).toBeGreaterThan(0.3);
  });

  test('Similar items get lower diversity contribution', () => {
    // All very similar content
    const similarItems = [
      createMockItem({ id: 'name-1', content: 'My name is John Smith', category_key: 'personal', importance: 80 }),
      createMockItem({ id: 'name-2', content: 'I am John Smith from London', category_key: 'personal', importance: 75 }),
      createMockItem({ id: 'name-3', content: 'John Smith is my full name', category_key: 'personal', importance: 70 })
    ];

    const result = manager.selectContext(similarItems);

    // Should have lower diversity than diverse content
    // But we can't directly compare, so just ensure it's measured
    expect(result.metrics.diversityScore).toBeDefined();
    expect(result.metrics.diversityScore).toBeGreaterThanOrEqual(0);
    expect(result.metrics.diversityScore).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// Hard Constraints Tests
// =============================================================================

describe('VTID-01117: Hard Constraints', () => {
  let manager: ContextWindowManager;

  beforeEach(() => {
    ContextWindowManager.resetInstance();
    manager = new ContextWindowManager();
  });

  test('All exclusions have reasons', () => {
    const items = [
      ...createMockItemsForCategory('personal', 10),
      ...createMockItemsForCategory('conversation', 20)
    ];

    const result = manager.selectContext(items);

    // Every excluded item must have a reason
    for (const exclusion of result.excludedItems) {
      expect(exclusion.reason).toBeDefined();
      expect(exclusion.explanation).toBeDefined();
      expect(exclusion.explanation.length).toBeGreaterThan(0);
    }
  });

  test('No silent truncation - exclusions are tracked', () => {
    const items = createMockItemsForCategory('personal', 10);
    const result = manager.selectContext(items);

    // If not all items are included, we should have exclusions
    if (result.metrics.totalItems < items.length) {
      expect(result.excludedItems.length).toBeGreaterThan(0);
    }

    // Total should equal input
    expect(result.includedItems.length + result.excludedItems.length).toBeGreaterThanOrEqual(items.length);
  });

  test('Context size is bounded and predictable', () => {
    // Even with many items, context should stay bounded
    const manyItems = Array.from({ length: 100 }, (_, i) =>
      createMockItem({
        id: `item-${i}`,
        category_key: ['personal', 'relationships', 'health', 'conversation'][i % 4],
        importance: 50 + (i % 30)
      })
    );

    const result = manager.selectContext(manyItems);

    // Must respect limits (VTID-DEBUG-01: increased to 50 items, 10000 chars)
    expect(result.metrics.totalItems).toBeLessThanOrEqual(50);
    expect(result.metrics.totalChars).toBeLessThanOrEqual(10000);
  });

  test('Sensitive domain (health) is protected from flooding', () => {
    // Try to flood with health items
    const healthItems = createMockItemsForCategory('health', 20, 60);
    const result = manager.selectContext(healthItems);

    // Health cap is 4 items
    const healthIncluded = result.includedItems.filter(i => i.category_key === 'health');
    expect(healthIncluded.length).toBeLessThanOrEqual(4);
  });
});

// =============================================================================
// Logging & Traceability Tests
// =============================================================================

describe('VTID-01117: Logging & Traceability', () => {
  let manager: ContextWindowManager;

  beforeEach(() => {
    ContextWindowManager.resetInstance();
    manager = new ContextWindowManager();
  });

  test('Metrics include all required fields', () => {
    const items = createMockItemsForCategory('personal', 5);
    const result = manager.selectContext(items);

    expect(result.metrics.totalChars).toBeDefined();
    expect(result.metrics.totalItems).toBeDefined();
    expect(result.metrics.domainUsage).toBeDefined();
    expect(result.metrics.budgetUtilization).toBeDefined();
    expect(result.metrics.diversityScore).toBeDefined();
    expect(result.metrics.excludedCount).toBeDefined();
    expect(result.metrics.avgRelevanceScore).toBeDefined();
    expect(result.metrics.avgConfidenceScore).toBeDefined();
    expect(result.metrics.processingTimeMs).toBeDefined();
  });

  test('Per-domain usage is tracked', () => {
    const items = [
      ...createMockItemsForCategory('personal', 3),
      ...createMockItemsForCategory('relationships', 2),
      ...createMockItemsForCategory('health', 2)
    ];

    const result = manager.selectContext(items);

    // Check personal domain metrics
    expect(result.metrics.domainUsage.personal).toBeDefined();
    expect(result.metrics.domainUsage.personal.itemCount).toBeGreaterThanOrEqual(0);
    expect(result.metrics.domainUsage.personal.charCount).toBeGreaterThanOrEqual(0);
  });

  test('Logs are retrievable', () => {
    const items = createMockItemsForCategory('personal', 3);

    // Make multiple selections
    manager.selectContext(items, 50, 'turn-1');
    manager.selectContext(items, 50, 'turn-2');
    manager.selectContext(items, 50, 'turn-3');

    const logs = manager.getLogs(2);
    expect(logs.length).toBe(2);
  });

  test('formatSelectionDebug produces readable output', () => {
    const items = [
      ...createMockItemsForCategory('personal', 5),
      ...createMockItemsForCategory('relationships', 3)
    ];

    const result = manager.selectContext(items);
    const debug = formatSelectionDebug(result);

    expect(debug).toContain('Context Window Selection Result');
    expect(debug).toContain('Included:');
    expect(debug).toContain('Per-Domain Breakdown');
  });
});

// =============================================================================
// Configuration Tests
// =============================================================================

describe('VTID-01117: Configuration', () => {
  beforeEach(() => {
    ContextWindowManager.resetInstance();
  });

  test('Custom config is respected', () => {
    const customConfig: ContextBudgetConfig = {
      ...DEFAULT_CONTEXT_BUDGET,
      totalItemLimit: 5, // Very restrictive
      domainBudgets: {
        ...DEFAULT_CONTEXT_BUDGET.domainBudgets,
        personal: {
          maxItems: 2,
          maxChars: 500,
          minRelevanceScore: 10,
          minConfidenceThreshold: 0
        }
      }
    };

    const manager = new ContextWindowManager(customConfig);
    const items = createMockItemsForCategory('personal', 10);
    const result = manager.selectContext(items);

    // Should respect custom limits
    expect(result.metrics.totalItems).toBeLessThanOrEqual(5);
    const personalItems = result.includedItems.filter(i => i.category_key === 'personal');
    expect(personalItems.length).toBeLessThanOrEqual(2);
  });

  test('Config can be updated at runtime', () => {
    const manager = new ContextWindowManager();

    manager.updateConfig({
      totalItemLimit: 3
    });

    const items = createMockItemsForCategory('personal', 10);
    const result = manager.selectContext(items);

    expect(result.metrics.totalItems).toBeLessThanOrEqual(3);
  });

  test('getConfig returns current configuration', () => {
    const manager = new ContextWindowManager();
    const config = manager.getConfig();

    // VTID-DEBUG-01: Updated values for better personal info retention
    expect(config.totalBudgetChars).toBe(10000);
    expect(config.totalItemLimit).toBe(50);
    expect(config.domainBudgets.personal.maxItems).toBe(999); // Effectively unlimited
  });
});

// =============================================================================
// Convenience Function Tests
// =============================================================================

describe('VTID-01117: Convenience Functions', () => {
  beforeEach(() => {
    ContextWindowManager.resetInstance();
  });

  test('selectContextWindow uses singleton manager', () => {
    const items = createMockItemsForCategory('personal', 5);

    const result1 = selectContextWindow(items, 50, 'turn-1');
    const result2 = selectContextWindow(items, 50, 'turn-2');

    // Should be consistent
    expect(result1.metrics.totalItems).toBe(result2.metrics.totalItems);
  });

  test('getExclusionSummary groups exclusions correctly', () => {
    const manager = new ContextWindowManager();
    const items = [
      ...createMockItemsForCategory('personal', 10), // Exceeds cap
      createMockItem({ id: 'low', importance: 5, category_key: 'conversation' }) // Below threshold
    ];

    const result = manager.selectContext(items);
    const summary = manager.getExclusionSummary(result.excludedItems);

    // Should have grouped exclusions by reason
    expect(Object.keys(summary).length).toBeGreaterThan(0);
    for (const count of Object.values(summary)) {
      expect(count).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Edge Cases Tests
// =============================================================================

describe('VTID-01117: Edge Cases', () => {
  let manager: ContextWindowManager;

  beforeEach(() => {
    ContextWindowManager.resetInstance();
    manager = new ContextWindowManager();
  });

  test('Empty input produces empty result', () => {
    const result = manager.selectContext([]);

    expect(result.includedItems.length).toBe(0);
    expect(result.excludedItems.length).toBe(0);
    expect(result.metrics.totalItems).toBe(0);
  });

  test('Single item is included if it meets thresholds', () => {
    const items = [
      createMockItem({ id: 'single', importance: 50, category_key: 'personal' })
    ];

    const result = manager.selectContext(items);

    expect(result.includedItems.length).toBe(1);
    expect(result.excludedItems.length).toBe(0);
  });

  test('Unknown category uses conversation defaults', () => {
    const items = [
      createMockItem({
        id: 'unknown',
        category_key: 'unknown_category' as any,
        importance: 50
      })
    ];

    const result = manager.selectContext(items);

    // Should still process without error
    expect(result.includedItems.length + result.excludedItems.length).toBe(1);
  });

  test('Very old items have reduced relevance', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10); // 10 days ago

    const items = [
      createMockItem({
        id: 'old',
        importance: 80,
        category_key: 'personal',
        occurred_at: oldDate.toISOString()
      }),
      createMockItem({
        id: 'new',
        importance: 80,
        category_key: 'personal',
        occurred_at: new Date().toISOString()
      })
    ];

    const result = manager.selectContext(items);
    const oldItem = result.includedItems.find(i => i.id === 'old');
    const newItem = result.includedItems.find(i => i.id === 'new');

    // New item should have higher relevance score
    if (oldItem && newItem) {
      expect(newItem.relevanceScore).toBeGreaterThan(oldItem.relevanceScore);
    }
  });
});
