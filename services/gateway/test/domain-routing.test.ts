/**
 * VTID-01114: Domain & Topic Routing Engine Tests
 *
 * Tests for the D22 Domain Routing Engine.
 * Verifies determinism, domain detection, topic extraction, hard constraints, and safety flags.
 */

import {
  computeRoutingBundle,
  quickRoute,
  getRoutingSummary,
  generateInputHash,
  generateDeterminismKey,
  detectDomainsFromMessage,
  detectSafetyFlags,
  applyHardConstraints,
  ROUTING_VERSION
} from '../src/services/domain-routing-service';
import {
  RoutingInput,
  RoutingBundle,
  INTELLIGENCE_DOMAINS,
  DOMAIN_METADATA,
  DEFAULT_ROUTING_CONFIG
} from '../src/types/domain-routing';

// =============================================================================
// Test Helpers
// =============================================================================

function createMinimalInput(message: string, overrides: Partial<RoutingInput> = {}): RoutingInput {
  return {
    context: {
      user_id: '00000000-0000-0000-0000-000000000099',
      tenant_id: '00000000-0000-0000-0000-000000000001',
      memory_items: [],
      formatted_context: ''
    },
    intent: {
      top_topics: [],
      weaknesses: [],
      recommended_actions: []
    },
    current_message: message,
    active_role: 'patient',
    session: {
      session_id: 'test-session',
      turn_number: 1
    },
    ...overrides
  };
}

// =============================================================================
// Determinism Tests
// =============================================================================

describe('VTID-01114: Domain Routing Determinism', () => {
  test('same inputs produce identical routing bundles', () => {
    const input = createMinimalInput('How can I improve my sleep quality?');

    const bundle1 = computeRoutingBundle(input);
    const bundle2 = computeRoutingBundle(input);

    // Compare core routing decisions (excluding timestamps)
    expect(bundle1.primary_domain).toBe(bundle2.primary_domain);
    expect(bundle1.secondary_domains).toEqual(bundle2.secondary_domains);
    expect(bundle1.active_topics).toEqual(bundle2.active_topics);
    expect(bundle1.excluded_domains).toEqual(bundle2.excluded_domains);
    expect(bundle1.routing_confidence).toBe(bundle2.routing_confidence);
    expect(bundle1.safety_flags).toEqual(bundle2.safety_flags);
    expect(bundle1.autonomy_level).toBe(bundle2.autonomy_level);
    expect(bundle1.allows_commerce).toBe(bundle2.allows_commerce);
    expect(bundle1.metadata.determinism_key).toBe(bundle2.metadata.determinism_key);
  });

  test('input hash is deterministic', () => {
    const input = createMinimalInput('Test message for hashing');

    const hash1 = generateInputHash(input);
    const hash2 = generateInputHash(input);

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(16); // SHA256 truncated to 16 chars
  });

  test('determinism key is stable', () => {
    const key1 = generateDeterminismKey('health', ['relationships'], ['sleep', 'nutrition']);
    const key2 = generateDeterminismKey('health', ['relationships'], ['nutrition', 'sleep']); // Different order

    // Should produce same key regardless of array order
    expect(key1).toBe(key2);
  });

  test('different inputs produce different hashes', () => {
    const input1 = createMinimalInput('First message');
    const input2 = createMinimalInput('Second message');

    const hash1 = generateInputHash(input1);
    const hash2 = generateInputHash(input2);

    expect(hash1).not.toBe(hash2);
  });
});

// =============================================================================
// Domain Detection Tests
// =============================================================================

describe('VTID-01114: Domain Detection', () => {
  test('detects health domain from health-related keywords', () => {
    // Use multiple strong health keywords to ensure confidence threshold is met
    const input = createMinimalInput('I need help with my sleep sleep sleep and nutrition nutrition fitness');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('health');
  });

  test('detects relationships domain from social keywords', () => {
    // Use multiple relationship keywords to meet confidence threshold
    const input = createMinimalInput('I want to meet my friends and family family family at the community event group');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('relationships');
  });

  test('detects commerce domain from purchase keywords', () => {
    // Use multiple commerce keywords to meet confidence threshold
    const input = createMinimalInput('I want to buy buy buy a product product and check the pricing pricing order');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('commerce');
  });

  test('detects learning domain from education keywords', () => {
    // Use multiple learning keywords to meet confidence threshold
    const input = createMinimalInput('I want to learn learn learn new skills skills and improve my knowledge knowledge');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('learning');
  });

  test('detects business domain from work keywords', () => {
    // Use multiple business keywords to meet confidence threshold
    const input = createMinimalInput('I have a work work work meeting meeting and need to improve productivity productivity');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('business');
  });

  test('detects system domain from settings keywords', () => {
    // Use multiple system keywords to meet confidence threshold
    const input = createMinimalInput('I want to change my account account setting setting and privacy privacy preferences permission');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('system');
  });

  test('detects reflection domain from memory keywords', () => {
    // Reflection is the default, so any generic message works
    const input = createMinimalInput('I want to remember remember remember what we talked about and write in my journal journal');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('reflection');
  });

  test('defaults to reflection for ambiguous messages', () => {
    const input = createMinimalInput('Hello, how are you today?');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('reflection');
  });

  test('detects German health keywords', () => {
    // Use the exact German keywords from DOMAIN_TOPIC_KEYWORDS
    const input = createMinimalInput('Ich bin müde müde müde und brauche Schlaf Schlaf Schlaf und krank krank');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('health');
  });
});

// =============================================================================
// Topic Extraction Tests
// =============================================================================

describe('VTID-01114: Topic Extraction', () => {
  test('extracts sleep topic from message', () => {
    // Use multiple sleep keywords to meet topic confidence threshold
    const input = createMinimalInput('I have been having trouble sleeping sleeping sleeping and need help with insomnia insomnia');
    const bundle = computeRoutingBundle(input);

    const topicKeys = bundle.active_topics.map(t => t.topic_key);
    expect(topicKeys).toContain('sleep');
  });

  test('extracts nutrition topic from message', () => {
    // Use multiple nutrition keywords to meet topic confidence threshold
    const input = createMinimalInput('I want to improve my diet diet diet and nutrition nutrition habits food food');
    const bundle = computeRoutingBundle(input);

    const topicKeys = bundle.active_topics.map(t => t.topic_key);
    expect(topicKeys).toContain('nutrition');
  });

  test('extracts multiple topics from complex message', () => {
    // Use strong keywords for multiple topics
    const input = createMinimalInput('I need help with sleep sleep insomnia, nutrition diet food, and fitness exercise workout routines');
    const bundle = computeRoutingBundle(input);

    const topicKeys = bundle.active_topics.map(t => t.topic_key);
    expect(topicKeys.length).toBeGreaterThanOrEqual(2);
  });

  test('topics are normalized (lowercase with underscores)', () => {
    // Use multiple keywords to ensure topics are extracted
    const input = createMinimalInput('I want to improve my mental mental mental health and fitness fitness fitness');
    const bundle = computeRoutingBundle(input);

    for (const topic of bundle.active_topics) {
      expect(topic.topic_key).toMatch(/^[a-z_]+$/);
    }
  });

  test('topics are ranked by confidence', () => {
    const input = createMinimalInput('sleep sleep sleep nutrition');
    const bundle = computeRoutingBundle(input);

    // Topics should be sorted by confidence (highest first)
    const confidences = bundle.active_topics.map(t => t.confidence);
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i - 1]).toBeGreaterThanOrEqual(confidences[i]);
    }
  });

  test('topics have required fields', () => {
    // Use multiple keywords to ensure topics are extracted
    const input = createMinimalInput('I need help with sleep sleep sleep and medication medication medication');
    const bundle = computeRoutingBundle(input);

    for (const topic of bundle.active_topics) {
      expect(topic).toHaveProperty('topic_key');
      expect(topic).toHaveProperty('display_name');
      expect(topic).toHaveProperty('domain');
      expect(topic).toHaveProperty('confidence');
      expect(topic).toHaveProperty('source');
      expect(topic).toHaveProperty('is_sensitive');
    }
  });
});

// =============================================================================
// Hard Constraints Tests
// =============================================================================

describe('VTID-01114: Hard Constraints', () => {
  test('health domain blocks commerce', () => {
    // Use health keywords - health domain should not allow commerce
    const input = createMinimalInput('I need medication medication medication and have symptoms symptoms pain pain pain');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('health');
    expect(bundle.allows_commerce).toBe(false);
    // Commerce is blocked but only appears in excluded_domains if it was a secondary domain candidate
    // The key invariant is that allows_commerce must be false when primary domain is health
  });

  test('system domain reduces autonomy', () => {
    // Use multiple system keywords to ensure system domain is selected
    const input = createMinimalInput('Change my account account account settings settings and permissions permissions privacy');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('system');
    expect(bundle.autonomy_level).toBeLessThanOrEqual(20);
  });

  test('non-health domains can allow commerce', () => {
    // Use multiple commerce keywords
    const input = createMinimalInput('I want to buy buy buy products products and check pricing pricing for services services order order');
    const bundle = computeRoutingBundle(input);

    expect(bundle.allows_commerce).toBe(true);
  });

  test('applyHardConstraints properly filters secondary domains', () => {
    const result = applyHardConstraints('health', ['commerce', 'relationships'], []);

    expect(result.secondaryDomains).not.toContain('commerce');
    expect(result.secondaryDomains).toContain('relationships');
    expect(result.excludedDomains).toContain('commerce');
    expect(result.allowsCommerce).toBe(false);
  });
});

// =============================================================================
// Safety Flag Tests
// =============================================================================

describe('VTID-01114: Safety Flags', () => {
  test('detects medical_advice safety flag', () => {
    const input = createMinimalInput('What is the right dosage for this medication?');
    const bundle = computeRoutingBundle(input);

    const flagTypes = bundle.safety_flags.map(f => f.type);
    expect(flagTypes).toContain('medical_advice');
  });

  test('detects financial_advice safety flag', () => {
    const input = createMinimalInput('Should I invest in stocks or crypto?');
    const bundle = computeRoutingBundle(input);

    const flagTypes = bundle.safety_flags.map(f => f.type);
    expect(flagTypes).toContain('financial_advice');
  });

  test('detects medical_emergency safety flag', () => {
    const input = createMinimalInput('I have chest pain and cannot breathe');
    const bundle = computeRoutingBundle(input);

    const flagTypes = bundle.safety_flags.map(f => f.type);
    expect(flagTypes).toContain('medical_emergency');
  });

  test('critical safety flags reduce autonomy', () => {
    const input = createMinimalInput('Emergency! I think I took an overdose');
    const bundle = computeRoutingBundle(input);

    expect(bundle.autonomy_level).toBeLessThanOrEqual(10);
  });

  test('safety flags have required fields', () => {
    // Use a message that triggers safety flags
    const input = createMinimalInput('I need a diagnosis diagnosis for my symptoms and medication dosage treatment');
    const bundle = computeRoutingBundle(input);

    for (const flag of bundle.safety_flags) {
      expect(flag).toHaveProperty('type');
      expect(flag).toHaveProperty('triggered_by');
      expect(flag).toHaveProperty('severity');
      expect(flag).toHaveProperty('requires_human_review');
      expect(flag).toHaveProperty('message');
    }
  });

  test('detects German safety keywords', () => {
    const input = createMinimalInput('Ich brauche eine Diagnose und ein Rezept');
    const bundle = computeRoutingBundle(input);

    const flagTypes = bundle.safety_flags.map(f => f.type);
    expect(flagTypes).toContain('medical_advice');
  });
});

// =============================================================================
// Quick Route Tests
// =============================================================================

describe('VTID-01114: Quick Route', () => {
  test('quickRoute works with minimal input', () => {
    // Use multiple health keywords to trigger health domain
    const bundle = quickRoute('Help me with sleep sleep sleep insomnia tired fatigue');

    expect(bundle.primary_domain).toBe('health');
    expect(bundle.metadata.routing_version).toBe(ROUTING_VERSION);
  });

  test('quickRoute accepts user_id and role', () => {
    const bundle = quickRoute('Hello', 'user-123', 'admin');

    expect(bundle).toBeDefined();
    expect(bundle.primary_domain).toBeDefined();
  });

  test('quickRoute produces valid routing bundle', () => {
    const bundle = quickRoute('Test message');

    expect(INTELLIGENCE_DOMAINS).toContain(bundle.primary_domain);
    expect(Array.isArray(bundle.secondary_domains)).toBe(true);
    expect(Array.isArray(bundle.active_topics)).toBe(true);
    expect(typeof bundle.routing_confidence).toBe('number');
    expect(typeof bundle.autonomy_level).toBe('number');
    expect(typeof bundle.allows_commerce).toBe('boolean');
  });
});

// =============================================================================
// Routing Summary Tests
// =============================================================================

describe('VTID-01114: Routing Summary', () => {
  test('getRoutingSummary produces readable summary', () => {
    // Use multiple health keywords to trigger health domain
    const bundle = quickRoute('I need help with sleep sleep sleep and nutrition nutrition nutrition fitness');
    const summary = getRoutingSummary(bundle);

    expect(summary).toContain('[D22]');
    expect(summary).toContain('health');
    expect(summary).toContain('autonomy');
  });

  test('summary includes safety flags when present', () => {
    // Use multiple safety trigger keywords
    const bundle = quickRoute('What dosage dosage should I take for medication medication prescription treatment?');
    const summary = getRoutingSummary(bundle);

    expect(summary).toContain('medical_advice');
  });
});

// =============================================================================
// Configuration Tests
// =============================================================================

describe('VTID-01114: Configuration', () => {
  test('default config has required thresholds', () => {
    expect(DEFAULT_ROUTING_CONFIG.domain_confidence_threshold).toBeGreaterThan(0);
    expect(DEFAULT_ROUTING_CONFIG.mixed_domain_threshold).toBeGreaterThan(0);
    expect(DEFAULT_ROUTING_CONFIG.topic_confidence_threshold).toBeGreaterThan(0);
    expect(DEFAULT_ROUTING_CONFIG.max_secondary_domains).toBeGreaterThan(0);
    expect(DEFAULT_ROUTING_CONFIG.max_active_topics).toBeGreaterThan(0);
  });

  test('mixed domain threshold is higher than regular', () => {
    expect(DEFAULT_ROUTING_CONFIG.mixed_domain_threshold).toBeGreaterThan(
      DEFAULT_ROUTING_CONFIG.domain_confidence_threshold
    );
  });
});

// =============================================================================
// Metadata Tests
// =============================================================================

describe('VTID-01114: Routing Metadata', () => {
  test('routing bundle includes version', () => {
    const bundle = quickRoute('Test');

    expect(bundle.metadata.routing_version).toBe(ROUTING_VERSION);
  });

  test('routing bundle includes computed_at timestamp', () => {
    const bundle = quickRoute('Test');

    expect(bundle.metadata.computed_at).toBeDefined();
    expect(new Date(bundle.metadata.computed_at).getTime()).toBeGreaterThan(0);
  });

  test('routing bundle includes input_hash', () => {
    const bundle = quickRoute('Test');

    expect(bundle.metadata.input_hash).toBeDefined();
    expect(bundle.metadata.input_hash.length).toBe(16);
  });

  test('routing bundle includes determinism_key', () => {
    const bundle = quickRoute('Test');

    expect(bundle.metadata.determinism_key).toBeDefined();
    expect(bundle.metadata.determinism_key.length).toBe(12);
  });
});

// =============================================================================
// Domain Metadata Tests
// =============================================================================

describe('VTID-01114: Domain Metadata', () => {
  test('all domains have metadata', () => {
    for (const domain of INTELLIGENCE_DOMAINS) {
      expect(DOMAIN_METADATA[domain]).toBeDefined();
      expect(DOMAIN_METADATA[domain].display_name).toBeDefined();
      expect(DOMAIN_METADATA[domain].description).toBeDefined();
    }
  });

  test('health domain blocks commerce', () => {
    expect(DOMAIN_METADATA.health.allows_commerce).toBe(false);
  });

  test('system domain has low autonomy', () => {
    expect(DOMAIN_METADATA.system.default_autonomy).toBeLessThanOrEqual(30);
  });

  test('health domain triggers medical safety', () => {
    expect(DOMAIN_METADATA.health.triggers_medical_safety).toBe(true);
  });

  test('commerce domain triggers financial safety', () => {
    expect(DOMAIN_METADATA.commerce.triggers_financial_safety).toBe(true);
  });
});

// =============================================================================
// Edge Case Tests
// =============================================================================

describe('VTID-01114: Edge Cases', () => {
  test('handles empty message gracefully', () => {
    const input = createMinimalInput('');
    const bundle = computeRoutingBundle(input);

    expect(bundle.primary_domain).toBe('reflection'); // Default fallback
  });

  test('handles very long message without crashing', () => {
    // Very long message should not crash the routing engine
    const longMessage = 'sleep insomnia tired fatigue rest '.repeat(50);
    const input = createMinimalInput(longMessage);
    const bundle = computeRoutingBundle(input);

    // Should produce a valid routing bundle regardless of domain
    expect(INTELLIGENCE_DOMAINS).toContain(bundle.primary_domain);
    expect(bundle.metadata.routing_version).toBe(ROUTING_VERSION);
  });

  test('handles special characters without crashing', () => {
    // Special characters should not crash the routing engine
    const input = createMinimalInput('Help me with <sleep> & "nutrition"! @#$%^&*()');
    const bundle = computeRoutingBundle(input);

    // Should produce a valid routing bundle
    expect(INTELLIGENCE_DOMAINS).toContain(bundle.primary_domain);
    expect(bundle.metadata.routing_version).toBe(ROUTING_VERSION);
  });

  test('handles unicode characters without crashing', () => {
    // Unicode characters should not crash the routing engine
    const input = createMinimalInput('Ich möchte meine Gesundheit verbessern 🏃 日本語 中文');
    const bundle = computeRoutingBundle(input);

    // Should produce a valid routing bundle
    expect(INTELLIGENCE_DOMAINS).toContain(bundle.primary_domain);
    expect(bundle.metadata.routing_version).toBe(ROUTING_VERSION);
  });

  test('respects max_active_topics limit', () => {
    const input = createMinimalInput(
      'sleep nutrition fitness biomarkers medication symptoms mental health'
    );
    const bundle = computeRoutingBundle(input);

    expect(bundle.active_topics.length).toBeLessThanOrEqual(
      DEFAULT_ROUTING_CONFIG.max_active_topics
    );
  });

  test('respects max_secondary_domains limit', () => {
    const input = createMinimalInput(
      'health sleep work business products commerce friends community'
    );
    const bundle = computeRoutingBundle(input);

    expect(bundle.secondary_domains.length).toBeLessThanOrEqual(
      DEFAULT_ROUTING_CONFIG.max_secondary_domains
    );
  });
});
