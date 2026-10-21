/**
 * VTID-01145: D51 Predictive Fatigue, Burnout & Overload Detection Engine - Tests
 *
 * Comprehensive tests for the Overload Detection Engine covering:
 * - Type validations
 * - Detection criteria logic
 * - Explainability text generation
 * - Safety constraints (no diagnostic terms)
 * - Baseline deviation calculations
 * - Pattern analysis
 */

import {
  OverloadDimension,
  OverloadSignalSource,
  PatternType,
  PotentialImpact,
  TimeWindow,
  ObservedPattern,
  UserBaseline,
  BaselineDeviation,
  OverloadDetection,
  DETECTION_THRESHOLDS,
  IMPACT_THRESHOLDS,
  DIMENSION_METADATA,
  EXPLAINABILITY_TEMPLATES,
  buildExplainabilityText,
  containsForbiddenTerms,
  sanitizeExplainabilityText,
  OVERLOAD_DISCLAIMER,
  FORBIDDEN_DIAGNOSTIC_TERMS,
  ComputeDetectionRequestSchema,
  DismissDetectionRequestSchema,
  GetDetectionsRequestSchema
} from '../src/types/overload-detection';

import {
  calculateBaselineDeviation,
  determineImpact,
  calculateConfidence,
  meetsDetectionCriteria,
  getPatternDimension
} from '../src/services/d51-overload-detection-engine';

// =============================================================================
// Type Validation Tests
// =============================================================================

describe('D51 Overload Detection - Type Validations', () => {
  test('OverloadDimension enum contains all required dimensions', () => {
    const dimensions: OverloadDimension[] = [
      'physical', 'cognitive', 'emotional', 'routine', 'social', 'context'
    ];

    dimensions.forEach(dim => {
      const result = OverloadDimension.safeParse(dim);
      expect(result.success).toBe(true);
    });
  });

  test('OverloadDimension rejects invalid dimensions', () => {
    const result = OverloadDimension.safeParse('invalid');
    expect(result.success).toBe(false);
  });

  test('TimeWindow enum contains valid time windows', () => {
    const windows: TimeWindow[] = ['last_7_days', 'last_14_days', 'last_21_days'];

    windows.forEach(window => {
      const result = TimeWindow.safeParse(window);
      expect(result.success).toBe(true);
    });
  });

  test('PatternType enum contains all pattern types', () => {
    const patterns: PatternType[] = [
      'sustained_low_energy', 'cognitive_decline', 'emotional_volatility',
      'routine_rigidity', 'social_withdrawal', 'context_thrashing',
      'recovery_deficit', 'capacity_erosion', 'engagement_drop', 'stress_accumulation'
    ];

    patterns.forEach(pattern => {
      const result = PatternType.safeParse(pattern);
      expect(result.success).toBe(true);
    });
  });

  test('ComputeDetectionRequestSchema validates correctly', () => {
    const validRequest = {
      dimensions: ['physical', 'cognitive'],
      time_window_days: 14,
      include_dismissed: false
    };

    const result = ComputeDetectionRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  test('ComputeDetectionRequestSchema uses defaults', () => {
    const result = ComputeDetectionRequestSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.time_window_days).toBe(14);
      expect(result.data.include_dismissed).toBe(false);
    }
  });

  test('DismissDetectionRequestSchema requires valid UUID', () => {
    const validRequest = {
      overload_id: '123e4567-e89b-12d3-a456-426614174000',
      reason: 'Not relevant to me'
    };

    const result = DismissDetectionRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  test('DismissDetectionRequestSchema rejects invalid UUID', () => {
    const invalidRequest = {
      overload_id: 'not-a-uuid'
    };

    const result = DismissDetectionRequestSchema.safeParse(invalidRequest);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Detection Criteria Tests
// =============================================================================

describe('D51 Overload Detection - Detection Criteria', () => {
  const mockBaseline: UserBaseline = {
    dimension: 'cognitive',
    baseline_score: 70,
    baseline_computed_at: new Date().toISOString(),
    data_points_count: 20,
    standard_deviation: 10,
    is_stable: true
  };

  const mockPatterns: ObservedPattern[] = [
    {
      pattern_type: 'cognitive_decline',
      signal_sources: ['longitudinal_trends', 'behavioral_signals'],
      first_observed_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      observation_count: 5,
      intensity: 65,
      trend_direction: 'worsening',
      supporting_evidence: 'Declining focus patterns observed'
    },
    {
      pattern_type: 'engagement_drop',
      signal_sources: ['behavioral_signals'],
      first_observed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      observation_count: 3,
      intensity: 55,
      trend_direction: 'stable',
      supporting_evidence: 'Lower engagement signals'
    }
  ];

  test('meetsDetectionCriteria returns true when all criteria met', () => {
    const signalSources: OverloadSignalSource[] = ['longitudinal_trends', 'behavioral_signals'];
    const deviation: BaselineDeviation = {
      dimension: 'cognitive',
      baseline_score: 70,
      current_score: 45,
      deviation_magnitude: 25,
      deviation_percentage: 35.7,
      is_significant: true,
      significance_threshold: 20
    };

    const result = meetsDetectionCriteria(mockPatterns, signalSources, 80, deviation);
    expect(result.meets).toBe(true);
    expect(result.reason).toBe('All detection criteria met');
  });

  test('meetsDetectionCriteria fails when insufficient patterns', () => {
    const singlePattern = [mockPatterns[0]];
    const signalSources: OverloadSignalSource[] = ['longitudinal_trends', 'behavioral_signals'];
    const deviation: BaselineDeviation = {
      dimension: 'cognitive',
      baseline_score: 70,
      current_score: 45,
      deviation_magnitude: 25,
      deviation_percentage: 35.7,
      is_significant: true,
      significance_threshold: 20
    };

    const result = meetsDetectionCriteria(singlePattern, signalSources, 80, deviation);
    expect(result.meets).toBe(false);
    expect(result.reason).toContain('Insufficient patterns');
  });

  test('meetsDetectionCriteria fails when insufficient signal sources', () => {
    const signalSources: OverloadSignalSource[] = ['behavioral_signals']; // Only 1 source
    const deviation: BaselineDeviation = {
      dimension: 'cognitive',
      baseline_score: 70,
      current_score: 45,
      deviation_magnitude: 25,
      deviation_percentage: 35.7,
      is_significant: true,
      significance_threshold: 20
    };

    const result = meetsDetectionCriteria(mockPatterns, signalSources, 80, deviation);
    expect(result.meets).toBe(false);
    expect(result.reason).toContain('Insufficient signal sources');
  });

  test('meetsDetectionCriteria fails when confidence too low', () => {
    const signalSources: OverloadSignalSource[] = ['longitudinal_trends', 'behavioral_signals'];
    const deviation: BaselineDeviation = {
      dimension: 'cognitive',
      baseline_score: 70,
      current_score: 45,
      deviation_magnitude: 25,
      deviation_percentage: 35.7,
      is_significant: true,
      significance_threshold: 20
    };

    const result = meetsDetectionCriteria(mockPatterns, signalSources, 60, deviation); // Below 75%
    expect(result.meets).toBe(false);
    expect(result.reason).toContain('Confidence too low');
  });

  test('meetsDetectionCriteria fails when deviation not significant', () => {
    const signalSources: OverloadSignalSource[] = ['longitudinal_trends', 'behavioral_signals'];
    const deviation: BaselineDeviation = {
      dimension: 'cognitive',
      baseline_score: 70,
      current_score: 65,
      deviation_magnitude: 5,
      deviation_percentage: 7.1,
      is_significant: false,
      significance_threshold: 20
    };

    const result = meetsDetectionCriteria(mockPatterns, signalSources, 80, deviation);
    expect(result.meets).toBe(false);
    expect(result.reason).toContain('Deviation from baseline not significant');
  });
});

// =============================================================================
// Baseline Deviation Tests
// =============================================================================

describe('D51 Overload Detection - Baseline Deviation', () => {
  test('calculateBaselineDeviation computes correct deviation', () => {
    const baseline: UserBaseline = {
      dimension: 'physical',
      baseline_score: 80,
      baseline_computed_at: new Date().toISOString(),
      data_points_count: 25,
      standard_deviation: 8,
      is_stable: true
    };

    const currentScore = 55;
    const result = calculateBaselineDeviation(baseline, currentScore);

    expect(result.dimension).toBe('physical');
    expect(result.baseline_score).toBe(80);
    expect(result.current_score).toBe(55);
    expect(result.deviation_magnitude).toBe(25);
    expect(result.deviation_percentage).toBeCloseTo(31.25, 1);
    expect(result.is_significant).toBe(true);
  });

  test('calculateBaselineDeviation marks small deviations as not significant', () => {
    const baseline: UserBaseline = {
      dimension: 'cognitive',
      baseline_score: 70,
      baseline_computed_at: new Date().toISOString(),
      data_points_count: 20,
      standard_deviation: 5,
      is_stable: true
    };

    const currentScore = 65;
    const result = calculateBaselineDeviation(baseline, currentScore);

    expect(result.deviation_percentage).toBeCloseTo(7.14, 1);
    expect(result.is_significant).toBe(false);
  });

  test('calculateBaselineDeviation handles zero baseline', () => {
    const baseline: UserBaseline = {
      dimension: 'emotional',
      baseline_score: 0,
      baseline_computed_at: new Date().toISOString(),
      data_points_count: 10,
      standard_deviation: 0,
      is_stable: false
    };

    const currentScore = 50;
    const result = calculateBaselineDeviation(baseline, currentScore);

    expect(result.deviation_percentage).toBe(0);
  });
});

// =============================================================================
// Impact Determination Tests
// =============================================================================

describe('D51 Overload Detection - Impact Determination', () => {
  test('determineImpact returns low for small deviations', () => {
    expect(determineImpact(25)).toBe('low');
    expect(determineImpact(35)).toBe('low');
  });

  test('determineImpact returns medium for moderate deviations', () => {
    expect(determineImpact(45)).toBe('medium');
    expect(determineImpact(55)).toBe('medium');
  });

  test('determineImpact returns high for large deviations', () => {
    expect(determineImpact(65)).toBe('high');
    expect(determineImpact(80)).toBe('high');
  });

  test('determineImpact handles negative deviations (improvement)', () => {
    expect(determineImpact(-30)).toBe('low');
    expect(determineImpact(-50)).toBe('medium');
    expect(determineImpact(-70)).toBe('high');
  });
});

// =============================================================================
// Confidence Calculation Tests
// =============================================================================

describe('D51 Overload Detection - Confidence Calculation', () => {
  test('calculateConfidence adds confidence for stable baseline', () => {
    const stableBaseline: UserBaseline = {
      dimension: 'physical',
      baseline_score: 70,
      baseline_computed_at: new Date().toISOString(),
      data_points_count: 20,
      standard_deviation: 8,
      is_stable: true
    };

    const unstableBaseline: UserBaseline = {
      ...stableBaseline,
      is_stable: false
    };

    const signalSources: OverloadSignalSource[] = ['longitudinal_trends', 'behavioral_signals'];

    const stableConfidence = calculateConfidence(stableBaseline, signalSources, 2, 30);
    const unstableConfidence = calculateConfidence(unstableBaseline, signalSources, 2, 30);

    expect(stableConfidence).toBeGreaterThan(unstableConfidence);
    expect(stableConfidence - unstableConfidence).toBe(20);
  });

  test('calculateConfidence adds confidence for more signal sources', () => {
    const baseline: UserBaseline = {
      dimension: 'cognitive',
      baseline_score: 60,
      baseline_computed_at: new Date().toISOString(),
      data_points_count: 15,
      standard_deviation: 10,
      is_stable: true
    };

    const twoSources: OverloadSignalSource[] = ['longitudinal_trends', 'behavioral_signals'];
    const threeSources: OverloadSignalSource[] = ['longitudinal_trends', 'behavioral_signals', 'calendar_density'];

    const twoSourceConfidence = calculateConfidence(baseline, twoSources, 2, 30);
    const threeSourceConfidence = calculateConfidence(baseline, threeSources, 2, 30);

    expect(threeSourceConfidence).toBeGreaterThan(twoSourceConfidence);
  });

  test('calculateConfidence caps at 100', () => {
    const baseline: UserBaseline = {
      dimension: 'emotional',
      baseline_score: 75,
      baseline_computed_at: new Date().toISOString(),
      data_points_count: 50,
      standard_deviation: 5,
      is_stable: true
    };

    const manySources: OverloadSignalSource[] = [
      'longitudinal_trends', 'behavioral_signals', 'calendar_density',
      'sleep_recovery', 'social_load'
    ];

    const confidence = calculateConfidence(baseline, manySources, 10, 80);
    expect(confidence).toBeLessThanOrEqual(100);
  });
});

// =============================================================================
// Pattern to Dimension Mapping Tests
// =============================================================================

describe('D51 Overload Detection - Pattern Dimension Mapping', () => {
  test('getPatternDimension maps physical patterns correctly', () => {
    expect(getPatternDimension('sustained_low_energy')).toBe('physical');
    expect(getPatternDimension('recovery_deficit')).toBe('physical');
  });

  test('getPatternDimension maps cognitive patterns correctly', () => {
    expect(getPatternDimension('cognitive_decline')).toBe('cognitive');
    expect(getPatternDimension('capacity_erosion')).toBe('cognitive');
    expect(getPatternDimension('engagement_drop')).toBe('cognitive');
  });

  test('getPatternDimension maps emotional patterns correctly', () => {
    expect(getPatternDimension('emotional_volatility')).toBe('emotional');
    expect(getPatternDimension('stress_accumulation')).toBe('emotional');
  });

  test('getPatternDimension maps routine patterns correctly', () => {
    expect(getPatternDimension('routine_rigidity')).toBe('routine');
  });

  test('getPatternDimension maps social patterns correctly', () => {
    expect(getPatternDimension('social_withdrawal')).toBe('social');
  });

  test('getPatternDimension maps context patterns correctly', () => {
    expect(getPatternDimension('context_thrashing')).toBe('context');
  });
});

// =============================================================================
// Explainability Text Tests
// =============================================================================

describe('D51 Overload Detection - Explainability', () => {
  test('buildExplainabilityText generates observational language', () => {
    const patterns: ObservedPattern[] = [
      {
        pattern_type: 'cognitive_decline',
        signal_sources: ['longitudinal_trends', 'behavioral_signals'],
        first_observed_at: new Date().toISOString(),
        observation_count: 3,
        intensity: 60,
        trend_direction: 'stable',
        supporting_evidence: 'Test evidence'
      }
    ];

    const text = buildExplainabilityText('cognitive', patterns);

    // Should use observational language
    expect(text).toContain('The system notices');
    expect(text).not.toContain('You are');
    expect(text).not.toContain('diagnos');
    expect(text).not.toContain('burnout');
  });

  test('buildExplainabilityText includes reassurance', () => {
    const patterns: ObservedPattern[] = [];
    const text = buildExplainabilityText('physical', patterns);

    // Should include reassurance
    expect(text.toLowerCase()).toContain('normal');
    // Or contains other reassuring language
    expect(
      text.includes('rest') ||
      text.includes('common') ||
      text.includes('temporary') ||
      text.includes('normal')
    ).toBe(true);
  });

  test('buildExplainabilityText includes signal source count', () => {
    const patterns: ObservedPattern[] = [
      {
        pattern_type: 'emotional_volatility',
        signal_sources: ['behavioral_signals', 'diary_sentiment', 'conversation_cadence'],
        first_observed_at: new Date().toISOString(),
        observation_count: 4,
        intensity: 55,
        trend_direction: 'worsening',
        supporting_evidence: 'Multiple signals detected'
      }
    ];

    const text = buildExplainabilityText('emotional', patterns);
    expect(text).toContain('3 signal source');
  });

  test('EXPLAINABILITY_TEMPLATES exist for all dimensions', () => {
    const dimensions: OverloadDimension[] = [
      'physical', 'cognitive', 'emotional', 'routine', 'social', 'context'
    ];

    dimensions.forEach(dim => {
      expect(EXPLAINABILITY_TEMPLATES[dim]).toBeDefined();
      expect(EXPLAINABILITY_TEMPLATES[dim].observation).toBeDefined();
      expect(EXPLAINABILITY_TEMPLATES[dim].context).toBeDefined();
      expect(EXPLAINABILITY_TEMPLATES[dim].reassurance).toBeDefined();
    });
  });
});

// =============================================================================
// Safety Constraint Tests
// =============================================================================

describe('D51 Overload Detection - Safety Constraints', () => {
  test('containsForbiddenTerms detects diagnostic terms', () => {
    expect(containsForbiddenTerms('You have burnout')).toBe(true);
    expect(containsForbiddenTerms('This is a depression indicator')).toBe(true);
    expect(containsForbiddenTerms('Clinical assessment needed')).toBe(true);
    expect(containsForbiddenTerms('Psychological disorder detected')).toBe(true);
  });

  test('containsForbiddenTerms allows safe terms', () => {
    expect(containsForbiddenTerms('The system notices patterns')).toBe(false);
    expect(containsForbiddenTerms('Fatigue patterns observed')).toBe(false);
    expect(containsForbiddenTerms('Energy levels appear lower')).toBe(false);
  });

  test('sanitizeExplainabilityText removes forbidden terms', () => {
    const unsafeText = 'This indicates burnout and possible depression';
    const sanitized = sanitizeExplainabilityText(unsafeText);

    expect(sanitized).not.toContain('burnout');
    expect(sanitized).not.toContain('depression');
    expect(sanitized).toContain('pattern');
  });

  test('FORBIDDEN_DIAGNOSTIC_TERMS includes critical terms', () => {
    expect(FORBIDDEN_DIAGNOSTIC_TERMS).toContain('burnout');
    expect(FORBIDDEN_DIAGNOSTIC_TERMS).toContain('depression');
    expect(FORBIDDEN_DIAGNOSTIC_TERMS).toContain('anxiety disorder');
    expect(FORBIDDEN_DIAGNOSTIC_TERMS).toContain('clinical');
    expect(FORBIDDEN_DIAGNOSTIC_TERMS).toContain('diagnosis');
  });

  test('OVERLOAD_DISCLAIMER contains required elements', () => {
    expect(OVERLOAD_DISCLAIMER).toContain('pattern-based');
    expect(OVERLOAD_DISCLAIMER).toContain('not medical');
    expect(OVERLOAD_DISCLAIMER).toContain('not psychological');
    expect(OVERLOAD_DISCLAIMER).toContain('dismissed');
  });

  test('EXPLAINABILITY_TEMPLATES do not contain forbidden terms', () => {
    const dimensions: OverloadDimension[] = [
      'physical', 'cognitive', 'emotional', 'routine', 'social', 'context'
    ];

    dimensions.forEach(dim => {
      const template = EXPLAINABILITY_TEMPLATES[dim];
      expect(containsForbiddenTerms(template.observation)).toBe(false);
      expect(containsForbiddenTerms(template.context)).toBe(false);
      expect(containsForbiddenTerms(template.reassurance)).toBe(false);
    });
  });
});

// =============================================================================
// Threshold Configuration Tests
// =============================================================================

describe('D51 Overload Detection - Threshold Configuration', () => {
  test('DETECTION_THRESHOLDS match spec requirements', () => {
    expect(DETECTION_THRESHOLDS.MIN_PERSISTENCE_DAYS).toBe(7);
    expect(DETECTION_THRESHOLDS.MIN_SPIKE_COUNT).toBe(3);
    expect(DETECTION_THRESHOLDS.MIN_SIGNAL_SOURCES).toBe(2);
    expect(DETECTION_THRESHOLDS.MIN_CONFIDENCE).toBe(75);
    expect(DETECTION_THRESHOLDS.MIN_BASELINE_DEVIATION).toBe(20);
  });

  test('DETECTION_THRESHOLDS time window defaults are valid', () => {
    expect(DETECTION_THRESHOLDS.DEFAULT_TIME_WINDOW_DAYS).toBe(14);
    expect(DETECTION_THRESHOLDS.MIN_TIME_WINDOW_DAYS).toBe(7);
    expect(DETECTION_THRESHOLDS.MAX_TIME_WINDOW_DAYS).toBe(21);
    expect(DETECTION_THRESHOLDS.DEFAULT_TIME_WINDOW_DAYS)
      .toBeGreaterThanOrEqual(DETECTION_THRESHOLDS.MIN_TIME_WINDOW_DAYS);
    expect(DETECTION_THRESHOLDS.DEFAULT_TIME_WINDOW_DAYS)
      .toBeLessThanOrEqual(DETECTION_THRESHOLDS.MAX_TIME_WINDOW_DAYS);
  });

  test('IMPACT_THRESHOLDS define valid ranges', () => {
    expect(IMPACT_THRESHOLDS.LOW_DEVIATION_MIN).toBe(20);
    expect(IMPACT_THRESHOLDS.LOW_DEVIATION_MAX).toBe(40);
    expect(IMPACT_THRESHOLDS.MEDIUM_DEVIATION_MIN).toBe(40);
    expect(IMPACT_THRESHOLDS.MEDIUM_DEVIATION_MAX).toBe(60);
    expect(IMPACT_THRESHOLDS.HIGH_DEVIATION_MIN).toBe(60);

    // Ranges should be contiguous
    expect(IMPACT_THRESHOLDS.LOW_DEVIATION_MAX).toBe(IMPACT_THRESHOLDS.MEDIUM_DEVIATION_MIN);
    expect(IMPACT_THRESHOLDS.MEDIUM_DEVIATION_MAX).toBe(IMPACT_THRESHOLDS.HIGH_DEVIATION_MIN);
  });
});

// =============================================================================
// Dimension Metadata Tests
// =============================================================================

describe('D51 Overload Detection - Dimension Metadata', () => {
  test('DIMENSION_METADATA exists for all dimensions', () => {
    const dimensions: OverloadDimension[] = [
      'physical', 'cognitive', 'emotional', 'routine', 'social', 'context'
    ];

    dimensions.forEach(dim => {
      expect(DIMENSION_METADATA[dim]).toBeDefined();
      expect(DIMENSION_METADATA[dim].label).toBeDefined();
      expect(DIMENSION_METADATA[dim].description).toBeDefined();
      expect(DIMENSION_METADATA[dim].icon).toBeDefined();
      expect(DIMENSION_METADATA[dim].related_signals).toBeDefined();
      expect(DIMENSION_METADATA[dim].pattern_types).toBeDefined();
    });
  });

  test('DIMENSION_METADATA pattern_types are valid', () => {
    const allPatternTypes: PatternType[] = [
      'sustained_low_energy', 'cognitive_decline', 'emotional_volatility',
      'routine_rigidity', 'social_withdrawal', 'context_thrashing',
      'recovery_deficit', 'capacity_erosion', 'engagement_drop', 'stress_accumulation'
    ];

    Object.values(DIMENSION_METADATA).forEach(meta => {
      meta.pattern_types.forEach((pattern: string) => {
        expect(allPatternTypes).toContain(pattern);
      });
    });
  });

  test('DIMENSION_METADATA related_signals are valid', () => {
    const allSignalSources: OverloadSignalSource[] = [
      'longitudinal_trends', 'risk_windows', 'behavioral_signals',
      'sleep_recovery', 'calendar_density', 'conversation_cadence',
      'social_load', 'diary_sentiment'
    ];

    Object.values(DIMENSION_METADATA).forEach(meta => {
      meta.related_signals.forEach((signal: string) => {
        expect(allSignalSources).toContain(signal);
      });
    });
  });
});

// =============================================================================
// Service Safe Initialization Tests
// =============================================================================

describe('D51 Overload Detection - Safe Initialization', () => {
  beforeAll(() => {
    // Clear env vars to simulate missing config
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  test('Engine exports are defined', async () => {
    const engine = await import('../src/services/d51-overload-detection-engine');

    expect(engine.VTID).toBe('VTID-01145');
    expect(typeof engine.computeBaselines).toBe('function');
    expect(typeof engine.getBaselines).toBe('function');
    expect(typeof engine.recordPattern).toBe('function');
    expect(typeof engine.computeDetections).toBe('function');
    expect(typeof engine.getDetections).toBe('function');
    expect(typeof engine.dismissDetection).toBe('function');
    expect(typeof engine.explainDetection).toBe('function');
    expect(typeof engine.getOverloadContextForOrb).toBe('function');
  });

  test('Helper functions do not crash without Supabase', async () => {
    const engine = await import('../src/services/d51-overload-detection-engine');

    // These should return gracefully, not throw
    expect(() => engine.calculateBaselineDeviation(
      {
        dimension: 'cognitive',
        baseline_score: 70,
        baseline_computed_at: new Date().toISOString(),
        data_points_count: 20,
        standard_deviation: 10,
        is_stable: true
      },
      50
    )).not.toThrow();

    expect(() => engine.determineImpact(40)).not.toThrow();
    expect(() => engine.calculateConfidence(
      {
        dimension: 'physical',
        baseline_score: 60,
        baseline_computed_at: new Date().toISOString(),
        data_points_count: 15,
        standard_deviation: 8,
        is_stable: true
      },
      ['longitudinal_trends', 'behavioral_signals'],
      2,
      30
    )).not.toThrow();
  });
});
